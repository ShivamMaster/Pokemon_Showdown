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
  };
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
    volatiles: new Set(),     // active volatile effects (lowercased), e.g. 'encore'
    active: false,
    fainted: false,
    switchCount: 0,           // times this mon has switched in
    forcedSwitchIns: 0,       // times it was forced in (drag / pivoting user)
    evEstimate: null,         // back-calculated EV ranges: { atk:[lo,hi], spa:[lo,hi], def:[lo,hi], spd:[lo,hi], hp:[lo,hi] } in EV points, or null
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
