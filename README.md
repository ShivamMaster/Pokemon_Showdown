# Pokémon Showdown battle assistant

A Chrome extension that reads a Pokémon Showdown battle and recommends the
best move, built in stages:

1. **Battle reader** (done) — parses Showdown protocol into structured battle
   state.
2. **UI** (done) — the panel that displays the battle state and the engine's
   advice.
3. **Engine** (done) — damage calc + move/switch recommendation.
4. **Extension** (done) — the Chrome extension that feeds live battles into
   the reader and shows the panel.
5. **Profiles** (done) — per-opponent learning: battle histories, switching
   tendencies, common leads, and move usage, fed back into the engine.
6. **Screen reading, tera & movepools** (done) — the extension watches the
   hover tooltips you inspect on screen; the engine is tera-aware and reasons
   over every move the opponent's Pokémon could still have.

## Stage 6: screen reading, tera & movepools

Three additions that give the engine more of what you know at the table:

- **Screen reading** (`src/content/tooltips.js`) — when you hover a Pokémon
  (your own sets at team preview, or either side mid-battle), the Showdown
  client renders a tooltip on screen; the extension observes it and merges
  what it says into the battle state: extra moves, **PP counts** (the log
  never shows PP), items, abilities, and tera types. The panel shows PP next
  to moves (`Dragon Pulse (15/16)`). Verified against the real client's
  tooltip markup and end-to-end in the E2E (hover a team icon → the panel
  picks up the PP).
- **Tera** — the reader ingests tera data from the live `|request|`
  (`teraType`/`terastallized` per Pokémon, `canTerastallize` for the active),
  the damage calc passes tera through (and a previously-buggy effectiveness
  display for terastallized defenders is fixed), and the engine notes when
  their active has terastallized, suggests terastallizing **your** active
  when it meaningfully improves your best move or cuts incoming damage, and
  accounts for tera in hidden-move threats.
- **Movepools** (`src/engine/movepool.js`) — the engine considers *every* Gen
  9-legal move the opponent's Pokémon could know, not just what's revealed.
  `scripts/build-learnsets.js` extracts a compact per-species move list from
  the official Showdown learnsets data into `src/engine/data/learnsets-lite.js`
  (regenerate with `npm run learnsets`; the output is committed so builds and
  tests work offline). The recommendation then warns about specific hidden
  threats (`⚠ their Dragonite could have Hurricane — it hits your Rillaboom
  for ~79.8%`), and switching is penalized when a hidden move would maul the
  candidate you're switching into.

## Stage 5: per-opponent profiles, settings & options

`src/profiles/` learns about each opponent so predictions get sharper over
time, keyed by (lowercased) username and stored in `chrome.storage.local`
(with an in-memory fallback so everything stays Node-testable):

- `learn.js` — `summarizeBattle(state, ourSideId)` extracts one battle's
  facts from the reader's action journal: both leads, voluntary switch-ins
  (forced switches — `|drag|`, pivot, or right after a faint — are excluded),
  low-HP switch/faint counts, move usage per species, and revealed sets.
  `updateProfile` merges a battle into the running profile (record, common
  leads, switch-in and move-usage counts, set unions, last 20 battles).
- `store.js` — `loadProfiles`/`saveProfiles` over the unified storage driver.
- Projections: `profileForEngine` produces the exact shape the engine's
  switch prediction consumes (`switchTendency.atLowHp` ratio and
  `commonSwitchIns` weights); `profileForDisplay` produces the panel strip
  (record, common lead %, low-HP switch rate).

The content script loads the opponent's profile at battle start (so the
engine's switch prediction is sharpened immediately) and records the finished
battle at the end. The panel shows a compact `vs <opponent>` strip with the
record and learned tendencies.

### Settings, options & the storage bridge

Profiles and settings persist through **`chrome.storage.local`** via a unified
storage driver (`src/storage.js`) with three modes: direct `chrome.storage`
(extension pages), a `window.postMessage` bridge, and an in-memory map
(Node/tests). The bridge exists because the main content script runs in the
page's **MAIN world** (the only world that sees the Showdown client's
globals), where `chrome.*` is undefined — the tiny isolated-world script
`src/bridge/bridge.js` answers storage requests and forwards
`chrome.storage.onChanged` events back, so settings changed in the options
page apply to open battles immediately.

- **Options page** (`src/options/`) — toggle the panel, choose the damage
  engine's stat assumption (typical 252-EV builds vs base stats), and manage
  the learned profiles (view, delete one, clear all).
- **Popup** (`src/popup/`) — quick panel on/off and a link to options.
- **Icons** — generated at build time by `scripts/make-icons.js`, a
  dependency-free PNG encoder (Node's built-in `zlib`).
- **Settings** (`src/settings.js`) — `panelEnabled` and `statAssumption`,
  threaded into the engine through `recommend(state, { statAssumption })`.

## Stage 4: the Chrome extension

`extension/` is a Manifest V3 extension that runs on `play.pokemonshowdown.com`.
The content script (`src/content/`) pulls the raw battle protocol out of the
client's own state (`app.curRoom.battle.stepQueue` — verified against a real
battle page), feeds each line into the `BattleReader`, runs the engine, and
renders the panel as a fixed overlay with collapse/hide controls. It runs in
the **main world** (`"world": "MAIN"`) because Chrome's isolated world cannot
see the client's page globals.

### Load it in Chrome

```bash
npm run build   # bundles src/ + @smogon/calc into extension/dist/
```

Then open `chrome://extensions`, enable **Developer mode**, and **Load
unpacked** the `extension/` folder. Open any battle on
play.pokemonshowdown.com and the panel appears top-right. Use the toolbar
icon (⚡) for the quick panel toggle and the options link; the options page
manages profiles and settings.

### Verify it (E2E)

```bash
npm run build
npm run e2e    # loads the extension into headless Chrome for Testing and
               # checks the panel renders a real battle
```

The E2E uses Chrome for Testing because managed/system Chrome blocks
`--load-extension` in headless:

```bash
npx @puppeteer/browsers install chrome@stable --path /tmp/cft-chrome
```

Tests (101): the reader (real battle + edge cases, the live `|request|`
fixture with moves/PP/tera/canTera, and hover observations), the UI
renderer, the engine (type advantage, KO detection, switch advice, utility
moves, calc consistency, switch prediction, tera effectiveness + tera
suggestions, hidden-move warnings, the real fixture), the movepool
(learnsets, worst-case hidden threats, terastallized attackers), the tooltip
parser (real captured tooltip text, mon resolution), the profiles, the
storage driver, the settings module, and the options-page rendering. The
live client protocol fixture (`test/fixtures/live-stepqueue.json`) was
captured from a real battle page and parses identically.

## Stage 3: engine

`src/engine/` turns battle state into a recommendation:

- `calc.js` — wraps **@smogon/calc** (the official Smogon damage calculator,
  `npm install @smogon/calc`). Only *known* info is passed (species, level,
  revealed item/ability, status, boosts, tera). The gaps are filled with
  documented assumptions: level 100, 31 IVs, neutral nature, and 252 EVs in
  the stats relevant to each calculation (attacker's attacking stat, defender's
  HP + defending stat) — you can switch to raw base stats with
  `opts.statAssumption: 'base'`. Type effectiveness comes from the calc
  package's per-generation type chart. Tera is simulated with
  `opts.attackerTera` / `opts.defenderTera` (the calc treats a set tera type
  as the terastallized state), and effectiveness is reported for the tera
  type when a defender is terastallized.
- `movepool.js` — hidden-move reasoning: `potentialMoves(species)` from the
  bundled Gen 9 learnsets, `worstThreat(theirMon, target)` (the strongest
  move they haven't revealed yet, pre-scored by power × effectiveness × STAB
  then damage-calc'd on the top candidates, memoized per state signature),
  and `teamThreats(...)` across your whole team.
- `recommend.js` — the decision logic:
  - Each move is scored as expected damage vs their active Pokémon weighted by
    P(they stay), plus damage vs each benched mon weighted by P(switch-in),
    with damage capped at remaining HP and a KO bonus.
  - Status/setup/recovery/hazard moves get fixed utility scores.
  - Switching is scored by how much less damage the candidate takes from their
    active's best move than the current mon would, plus a small offensive
    bonus; it's recommended when clearly better and our options are weak or
    we're in danger.
  - Switch prediction uses `opts.profile` when available:
    `{ switchTendency: { atLowHp }, commonSwitchIns: { species: weight } }`.

### CLI

```bash
npm run advise -- test/fixtures/real-battle.log p1
# or just:
npm run advise
```

## Stage 2: UI

`src/ui/panel.js` is a pure, DOM-free layer:

- `buildPanelModel(state, { ourSideId, recommendation })` — display model with
  both teams (active mon highlighted, HP bars, status badges, revealed moves
  with hidden counts, items/abilities with `?` for unknowns, boosts, fainted
  tags), field conditions, side effects, and a recent-actions journal.
- `renderPanel(model)` — the model to an HTML string (all battle data
  HTML-escaped).
- The **recommendation slot** is the engine's future contract:
  `{ bestMove: { move }, switchTo: { species }, reasoning: [strings] }`.

`src/ui/styles.css` styles the panel; `demo/` is a page where you paste any
battle log and see the panel render:

```bash
python3 -m http.server 8137
# open http://localhost:8137/demo/
```

## Stage 1: battle reader

`src/reader/` turns a Showdown battle log — a real replay log or, later, the
live event stream from the extension's content script — into a `BattleState`:

- both teams (roster from `|poke|`, linked to field idents)
- revealed moves per Pokémon, in reveal order
- items (revealed via `-item`, `-enditem`, or `[from] item:` on damage/heal),
  marked consumed or not
- HP (`hp` in log units + normalized `hpPercent`), status, faints
- stat boosts (clamped to ±6, reset on switch-in like the real game)
- abilities, tera types, volatiles
- field conditions (weather, terrain) and side effects (hazards, screens)
- switch tracking: `switchCount`, forced switches (`|drag|` or right after a
  pivot move), and a chronological `actions` journal — the raw material for
  per-opponent profiling later
- a `|request|` handler that fills in our own full team in live mode

### Usage

```js
import { parseLog } from './src/reader/index.js';
const state = parseLog(logText);
```

Or incrementally, as the live extension will:

```js
import { BattleReader } from './src/reader/index.js';
const reader = new BattleReader();
reader.applyLine(line); // one protocol line at a time
```

### Run tests

```bash
npm test
```

101 tests cover the reader (real 22-turn Gen 9 OU battle + edge cases),
the UI (model, HTML output, escaping, mid-battle and empty states), the
engine (type advantage, KO detection, switch advice, utility moves, calc
consistency, switch prediction, tera, movepool threats, the real fixture),
the tooltip parser, the movepool, the profiles, the storage driver, the
settings module, and the options-page rendering. The demo page is also
verified end-to-end by rendering it in headless Chrome, and the extension
itself is verified end-to-end: a real battle page is loaded with the actual
built extension, and the E2E checks the live panel, profile recording, a
hover-tooltip observation (PP appears in the panel), persistence across a
page reload, the options page, the popup, and the live panel toggle.

Tests cover a real 22-turn Gen 9 OU battle (`test/fixtures/real-battle.log`,
fetched from Showdown replays) plus hand-crafted edge cases.

### Known limitations

- Info never revealed — by the log **or** a hover tooltip — stays unknown by
  design. The movepool covers "what could they have" (full Gen 9 learnset)
  but not "what do they have": hidden-move threats are worst-case warnings,
  and the switch penalty is a heuristic, not certainty.
- `canTera` is only known for **your** side (it comes from the live
  `|request|`); the opponent's ability to terastallize is unknown until they
  actually do (or never).
- Ability reveal via `-end|ident|Ability` only covers the paradox abilities
  that use that pattern.
- Roster→field linking is by species; duplicate-species teams would need
  per-slot tracking.
