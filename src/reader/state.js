// src/reader/state.js
// Data model for a parsed Pokémon Showdown battle.

export const BOOST_STATS = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];

export const STATUS_CODES = ['brn', 'par', 'slp', 'frz', 'psn', 'tox'];

export function createBattleState() {
  return {
    format: null,      // e.g. '[Gen 9] OU'
    gen: null,         // e.g. 9
    gametype: null,    // 'singles' | 'doubles' | ...
    turn: 0,
    winner: null,      // winning player name, or 'tie'
    started: false,
    sides: { p1: createSide('p1'), p2: createSide('p2') },
    field: {
      weather: null,   // 'RainDance' | 'SunnyDay' | ... | null
      terrain: null,   // 'Grassy Terrain' | ... | null
      effects: {},     // generic field-wide effects (Trick Room, ...) name -> count
      speVersion: 0,   // bumped on speed-relevant field changes (weather, terrain, Trick Room)
    },
    // Chronological record of meaningful actions (moves, switches, faints, ...)
    // with the turn they happened in — the raw material for opponent profiling.
    actions: [],
    // Damage observations (move -> damage dealt, as % of the defender's max HP)
    // — the raw material for back-calculating the opponent's EV investment.
    // Bounded; each entry is { attacker, defender, move, damagePct, turn }.
    observations: [],
    // Index into `observations` already consumed by the stat estimator.
    obsProcessed: 0,
    // Speed evidence: when both sides use a move in the same turn, the log's
    // resolution order reveals who is faster. Each entry records who acted
    // first plus the "speed versions" of everything involved, so the engine
    // can tell whether the observation is still valid (nothing speed-affecting
    // changed since). Bounded; side-agnostic (p1/p2 keys, no "our" concept).
    speedEvidence: [],
    // Speed memory: sideId -> species -> { min, max, turn } — rough bounds on
    // a mon's BASE Speed learned from observed move order against a mon whose
    // speed was exactly known (e.g. "their Garchomp moved after my 141-speed
    // Rillaboom, so its base Speed is at most 141"). Species-keyed, so it
    // survives switch-outs: a mon that leaves and comes back keeps its bounds.
    speedMemory: { p1: {}, p2: {} },
  };
}

export function rememberSpeed(state, sideId, species, bounds, turn) {
  if (!species) return;
  const mem = state.speedMemory[sideId];
  const cur = mem[species] ?? { min: null, max: null, turn: 0 };
  if (bounds.min != null) cur.min = cur.min == null ? bounds.min : Math.max(cur.min, bounds.min);
  if (bounds.max != null) cur.max = cur.max == null ? bounds.max : Math.min(cur.max, bounds.max);
  if (turn != null) cur.turn = Math.max(cur.turn, turn);
  mem[species] = cur;
}

export function createSide(sideId) {
  return {
    id: sideId,
    playerName: null,
    teamSize: null,
    roster: [],   // team preview order from |poke|: [{ species, gender, level, ident }]
    pokemon: [],  // battle records, one per ident that appeared
    active: [],   // idents currently on the field (usually one in singles)
    effects: {},  // side effects (Stealth Rock, Spikes, Reflect, ...) name -> count
    speVersion: 0, // bumped on speed-relevant side-effect changes (Tailwind)
  };
}

export function createPokemon({ ident, side, species, gender, level }) {
  const boosts = {};
  for (const s of BOOST_STATS) boosts[s] = 0;
  return {
    ident,                    // 'p1a: Nickname'
    side,
    species,
    nickname: ident.includes(': ') ? ident.split(': ')[1] : ident,
    gender: gender ?? null,
    level: level ?? 100,
    item: null,               // revealed item, or null while unknown
    itemRevealed: false,
    itemConsumed: false,
    ability: null,
    teraType: null,            // revealed tera type (from details, |terastallize|, request, or hover tooltips)
    terastallized: false,
    canTera: null,             // null = unknown, true/false (ours, from the live |request|)
    movePp: {},                // moveName -> { cur, max } PP, from hover tooltips / request
    observed: false,           // any info came from hovering the Pokémon on screen
    hp: null,                 // { cur, max } in log units (often percentages) or null if unknown
    hpPercent: null,          // normalized 0-100
    status: null,             // one of STATUS_CODES or null
    boosts,                   // { atk, def, spa, spd, spe, acc, eva } in [-6, 6]
    moves: [],                // revealed move names, unique, in reveal order
    lastMove: null,
    lastTarget: null,
    lockedMove: null,         // move it's locked into by a Choice item (reset on switch-in)
    volatiles: new Set(),     // active volatile effects (lowercased), e.g. 'encore'
    active: false,
    fainted: false,
    switchCount: 0,           // times this mon has switched in
    forcedSwitchIns: 0,       // times it was forced in (drag / pivoting user)
    justSwitchedIn: false,    // switched in this turn — cleared on the next |turn|
    switchedOutTurn: null,    // the turn this mon last LEFT the field (null if never) — the engine uses it to avoid recommending an immediate switch-back
    evEstimate: null,         // back-calculated EV ranges: { atk:[lo,hi], spa:[lo,hi], def:[lo,hi], spd:[lo,hi], hp:[lo,hi] } in EV points, or null
    speVersion: 0,            // bumped on speed-affecting changes (spe boosts, paralysis, scarf, abilities)
    stats: null,              // exact current stats from the live request / our hover tooltip: { atk, def, spa, spd, spe } (no boosts/status/items)
    statsEffective: null,     // same, after stat modifiers (hover tooltip "(After stat modifiers:)" line): all modifiers baked in
    speedRange: null,         // opponent's shown Spe range from their hover tooltip: { min, max } (EV/nature only)
  };
}

export function getSide(state, sideId) {
  return state.sides[sideId] ?? null;
}

export function getPokemon(state, ident) {
  if (!ident) return null;
  for (const side of [state.sides.p1, state.sides.p2]) {
    for (const mon of side.pokemon) {
      if (mon.ident === ident) return mon;
    }
  }
  return null;
}

export function addMove(mon, moveName) {
  if (!moveName) return;
  if (!mon.moves.includes(moveName)) mon.moves.push(moveName);
  mon.lastMove = moveName;
}

export function updateHp(mon, hp) {
  if (!hp) return;
  const prev = mon.hp ?? {};
  const cur = hp.cur ?? prev.cur ?? null;
  const max = hp.max ?? prev.max ?? cur;
  mon.hp = { cur, max };
  if (cur != null && max != null && max > 0) {
    mon.hpPercent = Math.round((cur / max) * 1000) / 10;
  }
  if (hp.fainted) {
    mon.fainted = true;
    mon.hp.cur = 0;
    mon.hpPercent = 0;
  }
  if (hp.status) mon.status = hp.status;
}
