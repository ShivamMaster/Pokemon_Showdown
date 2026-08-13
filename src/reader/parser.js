// src/reader/parser.js
// Turns a single Pokémon Showdown protocol line into a normalized event:
//   { type, rawType, args, line }
// Lines that carry no battle information (chat, timestamps, broadcasts) are
// returned with type 'ignored'. Blank lines and bare '|' separators return null.

// Event types that begin with '-'. The dash is stripped so '-damage' -> 'damage'.
const DASH_EVENTS = new Set([
  'damage', 'heal', 'status', 'curestatus', 'boost', 'unboost', 'setboost',
  'clearboost', 'invertboost', 'item', 'enditem', 'ability', 'activate',
  'start', 'end', 'weather', 'fieldstart', 'fieldend', 'sidestart', 'sideend',
  'fieldactivate', 'terastallize', 'mega', 'primal', 'zpower', 'dynamax',
  'candynamax', 'supereffective', 'resisted', 'immune', 'crit', 'miss',
  'hitcount', 'anim', 'singleturn', 'formechange', 'endability', 'sethp',
  'clearpositiveboost', 'clearnegativeboost', 'copyboost', 'inversemod',
  'stealboost', 'swapboost', 'transform', 'typechange', 'swap', 'center',
]);

// Event types that do not start with a dash.
const PLAIN_EVENTS = new Set([
  'player', 'teamsize', 'gen', 'tier', 'gametype', 'rule', 'rated', 'poke',
  'clearpoke', 'teampreview', 'start', 'turn', 'win', 'tie', 'request',
  'switch', 'drag', 'replace', 'detailschange', 'move', 'faint', 'cant',
  'anim', 'upkeep', 'message', 'raw', 'inactive', 'activate', 'singleturn',
]);

export function parseLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed === '|') return null;
  const parts = trimmed.split('|');
  const rawType = parts[1] ?? '';
  if (!rawType) return null;
  let type = rawType;
  if (type.startsWith('-')) type = type.slice(1);
  if (!DASH_EVENTS.has(type) && !PLAIN_EVENTS.has(type)) {
    return { type: 'ignored', rawType, args: parts.slice(2), line: trimmed };
  }
  return { type, rawType, args: parts.slice(2), line: trimmed };
}
