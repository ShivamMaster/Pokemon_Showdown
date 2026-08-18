// src/engine/sets.js
// Real competitive set data (EV spreads + natures + top item) per species,
// from Smogon's monthly usage stats (sets-lite.js). The damage engine uses
// this to replace its flat "252 EVs in the stat the move uses, neutral
// nature" assumption with the spreads people actually run:
//   - a physical Garchomp is 252 Atk / 0 SpA, so its hidden Fire Blast is
//     priced as a coverage tick, not a 252-SpA nuke (the species data does
//     what inferOffensiveStat used to do, from real sets instead of a rule);
//   - a physically-built Great Tusk (252 HP / 252 Def / 0 SpD) takes special
//     hits much harder than the old "252 SpD" assumption admitted;
//   - natures shift damage 5-10% (Jolly/Adamant/Timid/Modest are the norm).
//
// Only gen-9 pre-made battles use this data: Random Battles randomize EVs
// per template (the level handling stays), and the data is gen9 OU.

import setsData from './data/sets-lite.js';
import { isRandomBattle } from './randoms.js';

const toID = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// EV order in the data: HP/Atk/Def/SpA/SpD/Spe.
const STAT_INDEX = { hp: 0, atk: 1, def: 2, spa: 3, spd: 4, spe: 5 };

const tableMemo = new Map();

// Parse a species' compact row into { item, spreads: [{nature, evs:{...}, pct}] }.
function table(species) {
  if (!species) return null;
  const key = toID(species);
  if (tableMemo.has(key)) return tableMemo.get(key);
  const raw = setsData[key];
  let out = null;
  if (raw) {
    const [item, spreadStr] = raw.split('|');
    const spreads = spreadStr.split(';').map((entry) => {
      const [nature, evStr, pct] = entry.split(':');
      const evArr = evStr.split(',').map(Number);
      const evs = {};
      for (const [stat, idx] of Object.entries(STAT_INDEX)) evs[stat] = evArr[idx] ?? 0;
      return { nature, evs, pct: parseFloat(pct) };
    });
    out = { item: item || null, spreads };
  }
  tableMemo.set(key, out);
  return out;
}

// The top item this species runs (from the stats), or null. Used as a prior
// when the reader hasn't revealed the mon's item yet.
export function topItem(species, gen = 9) {
  if (gen !== 9 || isRandomBattle()) return null;
  return table(species)?.item ?? null;
}

// Role -> the EV stat that role is about. The roles pick the spread that
// invests most in the stat that matters for the calc: a mon attacking with a
// physical move wants the max-Atk spread (its special coverage then prices
// at the ~0 SpA that spread runs), a defender hit by a physical move wants
// the max-Def spread, and so on. Tie-breaks on usage so two equally-
// invested spreads pick the popular one.
const ROLE_STAT = { 'atk-phys': 'atk', 'atk-spec': 'spa', 'def-phys': 'def', 'def-spec': 'spd' };

// The best-matching spread for a role, or null when the species has no data
// (or the battle isn't a gen-9 pre-made). Roles:
//   'atk-phys' — the mon attacks with a physical move: prefer max Atk EV.
//   'atk-spec' — the mon attacks with a special move: prefer max SpA EV.
//   'def-phys' — the mon is hit by a physical move: prefer max Def EV.
//   'def-spec' — the mon is hit by a special move: prefer max SpD EV.
//   null       — the top spread by usage (used for the species' dominant set).
export function spreadFor(species, gen = 9, role = null) {
  if (gen !== 9 || isRandomBattle()) return null;
  const t = table(species);
  if (!t?.spreads?.length) return null;
  if (!role) return t.spreads[0];
  const stat = ROLE_STAT[role];
  if (!stat) return t.spreads[0];
  let best = null;
  let bestKey = -1;
  for (const s of t.spreads) {
    const key = (s.evs[stat] ?? 0) * 1000 + s.pct;
    if (key > bestKey) {
      bestKey = key;
      best = s;
    }
  }
  return best;
}

// Full list of spreads for diagnostics/display.
export function spreadsOf(species, gen = 9) {
  if (gen !== 9 || isRandomBattle()) return null;
  return table(species)?.spreads ?? null;
}
