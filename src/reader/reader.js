// src/reader/reader.js
// Applies Showdown protocol events to a BattleState.
//
// The same applyEvent path will later be fed live events from the browser
// extension's content script, so it is written as a per-event state machine
// rather than a one-shot regex over the whole log.

import {
  BOOST_STATS,
  STATUS_CODES,
  createBattleState,
  createPokemon,
  getPokemon,
  getSide,
  addMove,
  updateHp,
} from './state.js';
import { parseLine } from './parser.js';
import { displayMoveName, displayAbilityName, displayItemName } from './movenames.js';

// Moves that force the user to switch after use (Volt Switch etc.). A switch
// immediately after one of these is treated as forced, not a free choice.
const PIVOT_MOVES = new Set(['Volt Switch', 'U-turn', 'Flip Turn', 'Teleport', 'Parting Shot']);

// These abilities appear as `-end|ident|Ability` lines when they wear off,
// which is the only way their name shows up in the log.
const PARADOX_ABILITIES = new Set(['Protosynthesis', 'Quark Drive']);

export function sideOf(ident) {
  const m = /^(p[12])\S*:/.exec(ident ?? '');
  return m ? m[1] : null;
}

export function parseDetails(details) {
  // 'Dragonite, M' | 'Deoxys-Speed' | 'Rillaboom, F, tera:Grass' | 'Pikachu, L50, M, shiny'
  const parts = String(details ?? '').split(',').map((s) => s.trim());
  const species = parts.shift() || null;
  const out = { species, level: null, gender: null, teraType: null, shiny: false };
  for (const p of parts) {
    if (/^L\d+$/.test(p)) out.level = parseInt(p.slice(1), 10);
    else if (p === 'M' || p === 'F' || p === 'N') out.gender = p;
    else if (/^tera:/i.test(p)) out.teraType = p.slice(5);
    else if (p.toLowerCase() === 'shiny') out.shiny = true;
  }
  return out;
}

export function parseHp(arg) {
  // '100/100' | '7/100' | '0 fnt' | '88/100 psn' | '120/281'
  const parts = String(arg ?? '').split(/\s+/);
  const num = parts[0];
  if (!num) return null;
  const frac = /^(\d+)\/(\d+)$/.exec(num);
  if (frac) {
    return {
      cur: parseInt(frac[1], 10),
      max: parseInt(frac[2], 10),
      fainted: parts.includes('fnt'),
      status: parts.find((p) => STATUS_CODES.includes(p)) ?? null,
    };
  }
  const single = /^(\d+)$/.exec(num);
  if (single) {
    const cur = parseInt(single[1], 10);
    return { cur, max: null, fainted: parts.includes('fnt'), status: null };
  }
  return null;
}

export class BattleReader {
  constructor() {
    this.state = createBattleState();
    this._lastMoveBySide = { p1: null, p2: null };
    this._lastSwitchWasPivot = { p1: false, p2: false };
  }

  applyLine(line) {
    const event = parseLine(line);
    if (!event) return null;
    this.applyEvent(event);
    return event;
  }

  // Live-only: the client intercepts `|request|` and never puts it in the
  // log, so callers hand us the parsed request object directly (usually from
  // `app.curRoom.request`). Same handler as the log path.
  applyRequest(request) {
    if (!request) return;
    try {
      this._applyRequest(typeof request === 'string' ? request : JSON.stringify(request));
    } catch {
      // malformed request data — ignore, the log pipeline keeps working
    }
  }

  // Drop all parsed state (e.g. when a new battle starts).
  reset() {
    this.state = createBattleState();
    this._lastMoveBySide = { p1: null, p2: null };
    this._lastSwitchWasPivot = { p1: false, p2: false };
  }

  read(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    for (const line of lines) this.applyLine(line);
    return this.state;
  }

  applyEvent(event) {
    const { type, args } = event;
    switch (type) {
      case 'player': {
        const side = getSide(this.state, args[0]);
        if (side) side.playerName = args[1] ?? null;
        break;
      }
      case 'teamsize': {
        const side = getSide(this.state, args[0]);
        if (side) side.teamSize = parseInt(args[1], 10) || null;
        break;
      }
      case 'gen':
        this.state.gen = parseInt(args[0], 10) || null;
        break;
      case 'tier':
        this.state.format = args[0] ?? null;
        break;
      case 'gametype':
        this.state.gametype = args[0] ?? null;
        break;
      case 'clearpoke': {
        for (const side of [this.state.sides.p1, this.state.sides.p2]) {
          side.roster = [];
          side.pokemon = [];
          side.effects = {};
        }
        break;
      }
      case 'poke': {
        const side = getSide(this.state, args[0]);
        if (!side) break;
        const d = parseDetails(args[1]);
        side.roster.push({ species: d.species, gender: d.gender, level: d.level, ident: null });
        break;
      }
      case 'start': {
        // `|start` alone = battle begins. `-start|ident|ability:X` reveals an
        // ability; `-start|ident|effect` starts a volatile effect.
        if (args.length === 0) {
          this.state.started = true;
          break;
        }
        const ident = args[0];
        if (!ident || !ident.includes(': ')) break;
        const mon = getPokemon(this.state, ident);
        if (!mon) break;
        const effect = args[1] ?? '';
        if (effect.startsWith('ability:')) mon.ability = effect.slice('ability:'.length).trim();
        else if (effect) mon.volatiles.add(effect.toLowerCase());
        break;
      }
      case 'turn':
        this.state.turn = parseInt(args[0], 10) || 0;
        break;
      case 'win':
        this.state.winner = args[0] ?? null;
        break;
      case 'tie':
        this.state.winner = 'tie';
        break;
      case 'request':
        this._applyRequest(args[0]);
        break;
      case 'switch':
      case 'drag':
        this._applySwitch(event);
        break;
      case 'replace':
      case 'detailschange':
      case 'formechange':
        this._applyDetailsChange(event);
        break;
      case 'move':
        this._applyMove(event);
        break;
      case 'damage':
      case 'heal':
        this._applyHpChange(event);
        break;
      case 'faint':
        this._applyFaint(event);
        break;
      case 'status':
      case 'curestatus':
        this._applyStatus(event);
        break;
      case 'boost':
      case 'unboost':
      case 'setboost':
      case 'clearboost':
        this._applyBoost(event);
        break;
      case 'item':
      case 'enditem':
        this._applyItem(event);
        break;
      case 'ability':
        this._applyAbility(event);
        break;
      case 'activate':
        this._applyActivate(event);
        break;
      case 'end':
        this._applyEnd(event);
        break;
      case 'weather':
        this.state.field.weather = args[0] === 'none' ? null : (args[0] ?? null);
        break;
      case 'fieldstart':
      case 'fieldend':
        this._applyFieldStartEnd(event);
        break;
      case 'fieldactivate':
        this._applyFieldActivate(event);
        break;
      case 'sidestart':
      case 'sideend':
        this._applySideEffect(event);
        break;
      case 'terastallize': {
        const mon = getPokemon(this.state, args[0]);
        if (mon) {
          mon.teraType = args[1] ?? null;
          mon.terastallized = true;
        }
        break;
      }
      case 'mega':
      case 'primal': {
        const mon = getPokemon(this.state, args[0]);
        if (mon && args[1]) mon.species = args[1];
        break;
      }
      default:
        break; // 'rule', 'rated', 'teampreview', 'upkeep', 'inactive', cosmetic lines, ...
    }
  }

  _applySwitch(event) {
    const { type, args } = event;
    const ident = args[0];
    const sideId = sideOf(ident);
    const side = getSide(this.state, sideId);
    if (!side || !ident) return;

    const details = parseDetails(args[1]);
    const hp = parseHp(args[2]);

    let mon = getPokemon(this.state, ident);
    if (!mon) {
      // Link to a team-preview roster slot if we can (species match, unassigned).
      const slot = side.roster.find(
        (r) => r.ident === null && (!details.species || r.species === details.species)
      );
      if (slot) slot.ident = ident;
      // A request-created record may exist under a plain ident (`p1: X`);
      // adopt the active-slot ident (`p1a: X`) so later events find it.
      if (details.species) {
        mon = side.pokemon.find((m) => m.species === details.species) ?? null;
        if (mon) mon.ident = ident;
      }
    }
    if (!mon) {
      mon = createPokemon({ ident, side: sideId, species: details.species });
      side.pokemon.push(mon);
    } else if (details.species) {
      mon.species = details.species;
    }
    if (details.level) mon.level = details.level;
    if (details.gender) mon.gender = details.gender;
    if (details.teraType) mon.teraType = details.teraType;

    // Coming onto the field resets boosts and volatiles (game rule).
    for (const s of BOOST_STATS) mon.boosts[s] = 0;
    mon.volatiles.clear();

    updateHp(mon, hp);
    mon.fainted = false;

    const forced = type === 'drag' || this._lastSwitchWasPivot[sideId];
    if (type === 'drag') mon.forcedSwitchIns += 1;

    for (const prev of side.active) {
      const pm = getPokemon(this.state, prev);
      if (pm) pm.active = false;
    }
    side.active = [ident];
    mon.active = true;
    mon.switchCount += 1;
    this._lastSwitchWasPivot[sideId] = false;

    this._recordAction('switch', sideId, ident, {
      forced,
      species: mon.species,
      hpPercent: mon.hpPercent,
    });
  }

  _applyDetailsChange(event) {
    const ident = event.args[0];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    const details = parseDetails(event.args[1]);
    if (details.species) mon.species = details.species;
    if (details.level) mon.level = details.level;
    if (details.gender) mon.gender = details.gender;
    const hp = parseHp(event.args[2]);
    if (hp && hp.cur != null) updateHp(mon, hp);
  }

  _applyMove(event) {
    const ident = event.args[0];
    const moveName = event.args[1];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    addMove(mon, moveName);
    const target = event.args[2] && !event.args[2].startsWith('[') ? event.args[2] : null;
    if (target) mon.lastTarget = target;
    const sideId = sideOf(ident);
    this._lastMoveBySide[sideId] = { move: moveName, ident };
    if (PIVOT_MOVES.has(moveName)) this._lastSwitchWasPivot[sideId] = true;
    this._recordAction('move', sideId, ident, { move: moveName, target });
  }

  _applyHpChange(event) {
    const ident = event.args[0];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    const hp = parseHp(event.args[1]);
    updateHp(mon, hp);
    this._revealFromExtras(mon, event.args.slice(2));
    this._recordAction(event.type, sideOf(ident), ident, {
      hpPercent: mon.hpPercent,
      status: hp?.status ?? null,
    });
  }

  _applyFaint(event) {
    const ident = event.args[0];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    mon.fainted = true;
    if (mon.hp) mon.hp.cur = 0;
    mon.hpPercent = 0;
    this._recordAction('faint', sideOf(ident), ident, {});
  }

  _applyStatus(event) {
    const ident = event.args[0];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    if (event.type === 'status') {
      if (event.args[1]) mon.status = event.args[1];
    } else if (!event.args[1] || mon.status === event.args[1]) {
      mon.status = null;
    }
    this._recordAction(event.type, sideOf(ident), ident, { status: mon.status });
  }

  _applyBoost(event) {
    const ident = event.args[0];
    const stat = event.args[1];
    const mon = getPokemon(this.state, ident);
    if (!mon || !BOOST_STATS.includes(stat)) return;
    const amount = parseInt(event.args[2], 10) || 0;
    const clamp = (n) => Math.max(-6, Math.min(6, n));
    switch (event.type) {
      case 'boost':
        mon.boosts[stat] = clamp(mon.boosts[stat] + amount);
        break;
      case 'unboost':
        mon.boosts[stat] = clamp(mon.boosts[stat] - amount);
        break;
      case 'setboost':
        mon.boosts[stat] = clamp(amount);
        break;
      case 'clearboost':
        for (const s of BOOST_STATS) mon.boosts[s] = 0;
        break;
    }
  }

  _applyItem(event) {
    const ident = event.args[0];
    const item = event.args[1];
    const mon = getPokemon(this.state, ident);
    if (!mon || !item) return;
    mon.item = item;
    mon.itemRevealed = true;
    mon.itemConsumed = event.type === 'enditem';
  }

  _applyAbility(event) {
    const ident = event.args[0];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    let ability = event.args[1];
    if (ability?.startsWith('ability:')) ability = ability.slice('ability:'.length).trim();
    if (ability) mon.ability = ability;
  }

  _applyActivate(event) {
    // `-activate|ident|ability: X` / `move: X` / `item: X` — reveal what fired.
    const ident = event.args[0];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    const effect = event.args[1] ?? '';
    if (effect.startsWith('ability:')) mon.ability = effect.slice('ability:'.length).trim();
    else if (effect.startsWith('move:')) addMove(mon, effect.slice('move:'.length).trim());
    else if (effect.startsWith('item:')) {
      mon.item = effect.slice('item:'.length).trim();
      mon.itemRevealed = true;
    }
  }

  _applyEnd(event) {
    const ident = event.args[0];
    const mon = getPokemon(this.state, ident);
    if (!mon) return;
    const effect = event.args[1] ?? '';
    if (PARADOX_ABILITIES.has(effect)) mon.ability = effect;
    mon.volatiles.delete(effect.toLowerCase());
  }

  _applyFieldStartEnd(event) {
    const effect = (event.args[0] ?? '').replace(/^move:\s*/, '');
    if (event.type === 'fieldstart') {
      if (effect.endsWith('Terrain')) this.state.field.terrain = effect;
      else this.state.field.effects[effect] = (this.state.field.effects[effect] ?? 0) + 1;
    } else {
      if (effect.endsWith('Terrain')) this.state.field.terrain = null;
      else delete this.state.field.effects[effect];
    }
    this._revealAbilityFromExtras(event.args.slice(1));
  }

  _applyFieldActivate(event) {
    const effect = (event.args[0] ?? '').replace(/^move:\s*/, '');
    this.state.field.effects[effect] = (this.state.field.effects[effect] ?? 0) + 1;
    this._revealAbilityFromExtras(event.args.slice(1));
  }

  _applySideEffect(event) {
    const sideId = (event.args[0] ?? '').split(':')[0];
    const side = getSide(this.state, sideId);
    if (!side) return;
    const effect = (event.args[1] ?? '').replace(/^move:\s*/, '');
    const count = parseInt(event.args[2], 10);
    if (event.type === 'sidestart') {
      side.effects[effect] = Number.isFinite(count) ? count : (side.effects[effect] ?? 0) + 1;
    } else {
      delete side.effects[effect];
    }
  }

  _applyRequest(jsonStr) {
    // Live-only: `|request|` carries our own full team — moves (with PP),
    // items, HP, tera types — and which actives can still terastallize.
    let req;
    try {
      req = JSON.parse(jsonStr);
    } catch {
      return;
    }
    const side = getSide(this.state, req?.side?.id);
    if (!side) return;
    for (const p of req.side.pokemon ?? []) {
      if (!p?.ident) continue;
      const d = parseDetails(p.details);
      let mon = getPokemon(this.state, p.ident);
      if (!mon) {
        // The request uses plain idents (`p1: X`) while switch lines use
        // active-slot idents (`p1a: X`). Reuse by species so we don't create
        // a duplicate record the switch handler will never find.
        mon = side.pokemon.find((m) => m.species === d.species) ?? null;
      }
      if (!mon) {
        mon = createPokemon({ ident: p.ident, side: side.id, species: d.species, gender: d.gender, level: d.level });
        side.pokemon.push(mon);
      }
      if (Array.isArray(p.moves)) {
        for (const m of p.moves) {
          if (typeof m === 'string') addMove(mon, displayMoveName(this.state.gen ?? 9, m));
          else if (m?.move) {
            const name = displayMoveName(this.state.gen ?? 9, m.move);
            addMove(mon, name);
            if (m.pp != null) mon.movePp[name] = { cur: m.pp, max: m.maxpp ?? m.pp };
          }
        }
      }
      if (p.item && p.item !== 'unknown') {
        mon.item = displayItemName(this.state.gen ?? 9, p.item);
        mon.itemRevealed = true;
      }
      if (p.baseAbility) mon.ability = displayAbilityName(this.state.gen ?? 9, p.baseAbility);
      else if (p.ability) mon.ability = displayAbilityName(this.state.gen ?? 9, p.ability);
      if (p.condition) {
        const hp = parseHp(p.condition);
        if (hp && hp.cur != null) updateHp(mon, hp);
      }
      if (p.active) {
        mon.active = true;
        // Don't touch side.active here: switch lines own the active-slot
        // bookkeeping (and use slot idents like `p1a:` that this request
        // record may not have yet). The `mon.active` flag is enough.
      } else if (mon.active && !this.state.started) {
        // Team preview: nothing is on the field yet.
        mon.active = false;
      }
      // Gen 9 request data: teraType (always present), terastallized (current
      // tera type), and canTera/canTerastallize on the active entries below.
      if (p.teraType) mon.teraType = p.teraType;
      if (p.terastallized) {
        mon.teraType = p.terastallized;
        mon.terastallized = true;
      }
      if (p.canTera != null) mon.canTera = !!p.canTera;
    }
    // Active slots: whether our active Pokémon can still terastallize.
    const actives = req.active ?? [];
    const activeIdents = side.active.length
      ? side.active
      : side.pokemon.filter((m) => m.active).map((m) => m.ident);
    actives.forEach((a, i) => {
      const mon = activeIdents[i] ? getPokemon(this.state, activeIdents[i]) : null;
      if (!mon) return;
      if (a.canTerastallize != null) mon.canTera = !!a.canTerastallize;
      else if (a.canTera != null) mon.canTera = !!a.canTera;
      if (a.teraType) mon.teraType = a.teraType;
      if (a.activeTera) mon.terastallized = true;
      // Active moves carry PP — ingest them for the panel and PP tracking.
      for (const m of a.moves ?? []) {
        if (!m?.move) continue;
        const name = displayMoveName(this.state.gen ?? 9, m.move);
        addMove(mon, name);
        if (m.pp != null) mon.movePp[name] = { cur: m.pp, max: m.maxpp ?? m.pp };
      }
    });
  }

  // Merge info read from the on-screen hover tooltip into a Pokémon's record.
  // Returns the changes applied, or null when nothing new was learned.
  applyObservation(identOrMon, obs = {}) {
    const mon = typeof identOrMon === 'string' ? getPokemon(this.state, identOrMon) : identOrMon;
    if (!mon) return null;
    const changes = { moves: [], pp: [], item: false, ability: false, tera: false };
    for (const m of obs.moves ?? []) {
      if (!m?.name) continue;
      if (!mon.moves.includes(m.name)) {
        mon.moves.push(m.name);
        changes.moves.push(m.name);
      }
      if (m.pp != null) {
        const max = m.maxpp ?? m.pp;
        if (mon.movePp[m.name]?.cur !== m.pp) changes.pp.push(m.name);
        mon.movePp[m.name] = { cur: m.pp, max };
      }
    }
    if (obs.item && obs.item !== 'None' && !mon.itemRevealed) {
      mon.item = obs.item;
      mon.itemRevealed = true;
      changes.item = true;
    }
    if (obs.itemConsumed) mon.itemConsumed = true;
    if (obs.ability && !mon.ability) {
      mon.ability = obs.ability;
      changes.ability = true;
    }
    if (obs.teraType && !mon.teraType) {
      mon.teraType = obs.teraType;
      changes.tera = true;
    }
    if (obs.hpText) {
      const m = /^(\d+(?:\.\d+)?)%$/.exec(String(obs.hpText).trim());
      if (m && mon.hpPercent == null) {
        mon.hpPercent = parseFloat(m[1]);
        mon.hp = { cur: mon.hpPercent, max: 100 };
      } else if (String(obs.hpText).trim().toLowerCase().includes('fainted')) {
        mon.fainted = true;
      }
    }
    const changed =
      changes.moves.length > 0 || changes.pp.length > 0 ||
      changes.item || changes.ability || changes.tera;
    if (changed) {
      mon.observed = true;
      this._recordAction('observed', mon.side, mon.ident, { species: mon.species, ...changes });
      return changes;
    }
    return null;
  }

  // `[from] item: X` / `[from] ability: X` appear as extra args on damage,
  // heal, and activation lines — the main way items/abilities get revealed.
  _revealFromExtras(mon, extras) {
    for (const extra of extras) {
      const m = /^\[from\] (item|ability): (.+)$/.exec(extra ?? '');
      if (!m) continue;
      if (m[1] === 'item') {
        mon.item = m[2].trim();
        mon.itemRevealed = true;
      } else {
        mon.ability = m[2].trim();
      }
    }
  }

  // `-fieldstart|move: X|[from] ability: Grassy Surge|[of] p1a: Rillaboom`
  // reveals the source Pokémon's ability.
  _revealAbilityFromExtras(extras) {
    const fromAbility = extras.find((e) => e?.startsWith('[from] ability: '));
    const of = extras.find((e) => e?.startsWith('[of] '));
    if (fromAbility && of) {
      const mon = getPokemon(this.state, of.slice('[of] '.length));
      if (mon) mon.ability = fromAbility.slice('[from] ability: '.length).trim();
    }
  }

  _recordAction(type, sideId, ident, detail) {
    this.state.actions.push({ turn: this.state.turn, side: sideId, type, ident, ...detail });
  }
}

export function parseLog(text) {
  return new BattleReader().read(text);
}
