// src/profiles/learn.js
// Per-opponent profile learning, built from the reader's action journal:
//
//   summarizeBattle(state, ourSideId) -> one battle's facts
//   updateProfile(profile, summary)   -> merge a battle into the running profile
//   profileForEngine(profile)         -> the shape the engine consumes
//   profileForDisplay(profile)        -> the shape the panel renders
//
// What we learn about the opponent:
//   - common leads (first send-in each battle)
//   - voluntary switch-ins (which species they bring in by choice, and whether
//     they switch out when their active is below 40% HP)
//   - move usage per species and revealed sets (moves/item/ability)
//   - win/loss record, plus the last 20 battle summaries

const LOW_HP = 40;

// Storage key for a profile: the display name, lowercased, stripped to
// alphanumerics ('John' -> 'john', 'BaddyGames' -> 'baddygames').
export function toProfileKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'unknown';
}

// Does this username map to this profile? A profile matches its own display
// name and every username in its `aliases` list.
export function profileMatchesUsername(profile, username) {
  const u = String(username ?? '').toLowerCase();
  if (!u) return false;
  if (toProfileKey(profile?.opponent) === u) return true;
  return (profile?.aliases ?? []).includes(u);
}

// Find the storage key of the profile this username maps to (friend aliases
// included), or null when the username has no profile yet.
export function findProfileKey(profiles, username) {
  const u = String(username ?? '').toLowerCase();
  if (!u) return null;
  for (const [key, p] of Object.entries(profiles ?? {})) {
    if (profileMatchesUsername(p, u)) return key;
  }
  return null;
}

// Rename a profile (e.g. from a raw username to the friend's name). The old
// name is kept as an alias so battles under it still map here.
export function renameProfile(profile, newName) {
  const clean = String(newName ?? '').trim();
  if (!clean) return profile;
  const oldKey = toProfileKey(profile?.opponent);
  const alias = oldKey;
  const aliases = [...(profile?.aliases ?? [])];
  if (alias && !aliases.includes(alias)) aliases.push(alias);
  return { ...profile, opponent: clean, aliases };
}

// Add a username (alternate account) to a profile. Stored lowercased.
export function addProfileAlias(profile, username) {
  const alias = String(username ?? '').trim().toLowerCase();
  if (!alias || toProfileKey(profile?.opponent) === alias) return profile;
  const aliases = [...(profile?.aliases ?? [])];
  if (!aliases.includes(alias)) aliases.push(alias);
  return { ...profile, aliases };
}

export function removeProfileAlias(profile, username) {
  const alias = String(username ?? '').trim().toLowerCase();
  return { ...profile, aliases: (profile?.aliases ?? []).filter((a) => a !== alias) };
}

function speciesOf(state, ident) {
  for (const side of [state.sides.p1, state.sides.p2]) {
    const mon = side.pokemon.find((m) => m.ident === ident);
    if (mon) return mon.species;
  }
  return null;
}

// One battle's learnable facts.
export function summarizeBattle(state, ourSideId) {
  const theirSideId = ourSideId === 'p1' ? 'p2' : 'p1';
  const theirSide = state.sides[theirSideId];
  const ourSide = state.sides[ourSideId];
  const actions = state.actions ?? [];

  const leadOf = (sideId) => actions.find((a) => a.type === 'switch' && a.side === sideId)?.species ?? null;

  // Walk the journal once, tracking HP so we can tell what the outgoing mon
  // was at when a switch was made, and how hurt a mon was before it fainted.
  const lastHp = {}; // ident -> hpPercent (pre-hit value for faints)
  let lastTheirActive = null;
  let lowHpSwitches = 0; // voluntary switch made with the outgoing mon < 40%
  let lowHpFaints = 0;   // faint of a mon that was below 40% before the hit
  const voluntarySwitchIns = {};
  const movesUsed = {};

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.side !== theirSideId) continue;

    if (a.type === 'move' && a.move) {
      const sp = speciesOf(state, a.ident);
      if (sp) (movesUsed[sp] ??= new Set()).add(a.move);
    } else if (a.type === 'switch') {
      // A switch right after one of their faints is forced, not a choice.
      const forced = !!a.forced || (i > 0 && actions[i - 1].type === 'faint');
      if (!forced) {
        voluntarySwitchIns[a.species] = (voluntarySwitchIns[a.species] ?? 0) + 1;
        const outHp = lastHp[lastTheirActive] ?? null;
        if (outHp != null && outHp < LOW_HP) lowHpSwitches += 1;
      }
      lastTheirActive = a.ident;
      if (a.hpPercent != null) lastHp[a.ident] = a.hpPercent;
    } else if (a.type === 'faint') {
      const preHp = lastHp[a.ident] ?? null;
      if (preHp != null && preHp < LOW_HP) lowHpFaints += 1;
    } else if ((a.type === 'damage' || a.type === 'heal') && a.hpPercent != null && a.hpPercent > 0) {
      lastHp[a.ident] = a.hpPercent; // ignore the fatal 0 hit — keep pre-hit HP
    }
  }

  // Revealed sets per species (from the reader's final knowledge).
  const sets = {};
  for (const mon of theirSide.pokemon ?? []) {
    sets[mon.species] = { moves: [...(mon.moves ?? [])], item: mon.item ?? null, ability: mon.ability ?? null };
  }

  const winner = state.winner;
  const result =
    !winner ? 'incomplete' : winner === 'tie' ? 'tie' : theirSide.playerName === winner ? 'loss' : 'win';

  return {
    opponent: theirSide.playerName,
    format: state.format,
    turns: state.turn,
    date: Date.now(),
    result,
    ourLead: leadOf(ourSideId),
    theirLead: leadOf(theirSideId),
    lowHpSwitches,
    lowHpFaints,
    switchIns: voluntarySwitchIns,
    movesUsed: Object.fromEntries(Object.entries(movesUsed).map(([sp, set]) => [sp, [...set]])),
    sets,
  };
}

// A fresh, empty profile for a username.
export function emptyProfile(username) {
  return {
    opponent: username,
    aliases: [],
    battles: [],
    totalBattles: 0,
    record: { win: 0, loss: 0, tie: 0 },
    commonLeads: {},
    switchIns: {},
    moveUsage: {},
    sets: {},
    lowHpSwitches: 0,
    lowHpFaints: 0,
  };
}

// Merge one battle summary into the running profile.
export function updateProfile(profile, summary) {
  const base = profile ?? emptyProfile(summary.opponent);

  base.battles = [...(base.battles ?? []), summary].slice(-20);
  base.totalBattles += 1;

  if (summary.result === 'win') base.record.win += 1;
  else if (summary.result === 'loss') base.record.loss += 1;
  else if (summary.result === 'tie') base.record.tie += 1;

  if (summary.theirLead) base.commonLeads[summary.theirLead] = (base.commonLeads[summary.theirLead] ?? 0) + 1;

  for (const [sp, count] of Object.entries(summary.switchIns ?? {})) {
    base.switchIns[sp] = (base.switchIns[sp] ?? 0) + count;
  }
  for (const [sp, moves] of Object.entries(summary.movesUsed ?? {})) {
    const usage = (base.moveUsage[sp] ??= {});
    for (const mv of moves) usage[mv] = (usage[mv] ?? 0) + 1;
  }
  for (const [sp, set] of Object.entries(summary.sets ?? {})) {
    const cur = (base.sets[sp] ??= { moves: [], item: null, ability: null, timesSeen: 0 });
    cur.timesSeen += 1;
    for (const mv of set.moves ?? []) if (!cur.moves.includes(mv)) cur.moves.push(mv);
    if (set.item) cur.item = set.item;
    if (set.ability) cur.ability = set.ability;
  }

  base.lowHpSwitches += summary.lowHpSwitches ?? 0;
  base.lowHpFaints += summary.lowHpFaints ?? 0;
  return base;
}

// Turn a stored profile object into a normalized one (aliases as a lowercase
// string array), so old data and hand-built test data keep working.
export function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    ...profile,
    aliases: Array.isArray(profile.aliases)
      ? profile.aliases.map((a) => String(a).toLowerCase())
      : [],
  };
}

const topEntries = (obj, n) => Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);

// The shape the engine consumes: switchTendency.atLowHp and commonSwitchIns.
export function profileForEngine(profile) {
  if (!profile) return null;
  const situations = (profile.lowHpSwitches ?? 0) + (profile.lowHpFaints ?? 0);
  const engineProfile = {};
  if (situations > 0) {
    engineProfile.switchTendency = {
      atLowHp: Math.round(((profile.lowHpSwitches ?? 0) / situations) * 100) / 100,
    };
  }
  if (Object.keys(profile.switchIns ?? {}).length) {
    engineProfile.commonSwitchIns = { ...profile.switchIns };
  }
  return Object.keys(engineProfile).length ? engineProfile : null;
}

// The shape the panel renders: record, common lead, low-HP switch rate.
export function profileForDisplay(profile) {
  if (!profile) return null;
  const situations = (profile.lowHpSwitches ?? 0) + (profile.lowHpFaints ?? 0);
  const rec = profile.record ?? { win: 0, loss: 0, tie: 0 };
  const total = rec.win + rec.loss + rec.tie;
  const lead = topEntries(profile.commonLeads, 1)[0] ?? null;
  const totalBattles = Math.max(1, profile.totalBattles ?? 1);
  return {
    opponent: profile.opponent,
    battles: profile.totalBattles ?? 0,
    recordText: total ? `${rec.win}-${rec.loss}${rec.tie ? `-${rec.tie}` : ''}` : null,
    commonLead: lead ? { species: lead[0], pct: Math.round((lead[1] / totalBattles) * 100) } : null,
    lowHpSwitchRate: situations ? Math.round(((profile.lowHpSwitches ?? 0) / situations) * 100) : null,
  };
}
