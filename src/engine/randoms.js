// src/engine/randoms.js
// Random Battle awareness.
//
// The user mostly plays Random Battles, where every match is a fresh randomly
// generated team: the opponent's species, moves, levels (79-88, not 100),
// abilities, and tera options all come from a bounded template pool. The
// engine's assumptions for pre-made (OU) teams are wrong there:
//   - hidden moves should come from the random template movepool, not the
//     species' full Gen 9 learnset;
//   - Smogon usage % weights are for OU sets, meaningless for randoms;
//   - unrevealed mons default to level 100, but randoms use per-species levels.
//
// The current battle's format is set once per battle by the content script
// (from the log's |tier| line and the battle room id) via setBattleFormat.
// Everything else in the engine reads isRandomBattle() lazily, so tests and
// non-random battles (format unset) behave exactly as before.

import randoms from './data/randoms-lite.js';

const toID = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

let format = null;
let battleId = null;

// The content script calls this when a battle's identity is known (|tier| line
// and/or the room id). Passing null resets to non-random behavior.
export function setBattleFormat(nextFormat, nextBattleId = null) {
  format = nextFormat ?? null;
  battleId = nextBattleId ?? null;
}

// Is the current battle a Random Battle (singles, doubles, or any variant)?
export function isRandomBattle() {
  if (format && /random/i.test(format)) return true;
  if (battleId && /randombattle|randomdoublesbattle/i.test(battleId)) return true;
  return false;
}

// The random-battle template for a species (id -> "level|moves|abilities|teras")
// or null when the species isn't in the gen-9 random pool.
export function randomsEntry(species) {
  const raw = randoms[toID(species)];
  if (!raw) return null;
  const [level, moves, abilities, teras] = raw.split('|');
  return {
    level: parseInt(level, 10) || 100,
    moves: moves ? moves.split(',') : [],
    abilities: abilities ? abilities.split(',') : [],
    teraTypes: teras ? teras.split(',') : [],
  };
}

// The moves a random team can roll for this species (union across template
// roles). Empty when the species isn't in the random pool.
export function randomsMoves(species) {
  return randomsEntry(species)?.moves ?? [];
}

// The species' level in Random Battles (79-88 typically), or null when it
// isn't in the pool. Used as the damage-calc default for unrevealed mons.
export function randomsLevel(species) {
  return randomsEntry(species)?.level ?? null;
}

// The abilities a random set can have for this species.
export function randomsAbilities(species) {
  return randomsEntry(species)?.abilities ?? [];
}

// The tera types a random set can roll for this species.
export function randomsTeraTypes(species) {
  return randomsEntry(species)?.teraTypes ?? [];
}
