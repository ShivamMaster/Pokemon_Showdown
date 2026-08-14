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
   hover tooltips you inspect on screen (and can capture the tab for real);
   the engine is tera-aware and reasons over every move the opponent's
   Pokémon could still have.
7. **Stat estimation** (done) — the engine back-calculates each side's EV
   investment from observed damage and uses the learned stats in every calc.
8. **Usage-weighted movepools** (done) — “could have” moves are ranked by real
   Smogon usage stats instead of raw base power.
9. **Speed-order awareness** (done) — the engine compares effective Speed
   (EV ranges, boosts, paralysis, Choice Scarf, weather abilities, Tailwind,
   Trick Room) and factors who moves first into move and switch advice.

## Stage 8: pixel OCR fallback

- **Real OCR of the captured frames** — when the client renders a tooltip
  that never appears as a DOM element (canvas-rendered tooltip, a client
  change, or a slow render), the extension now reads the pixels instead:
  the capture video (full tab resolution) is cropped to the region where
  the tooltip appears (above-left of the hovered icon), the pixels are sent
  to an **offscreen document** (`src/offscreen/offscreen.js`), and tesseract
  (`tesseract.js`, assets bundled locally in `extension/dist/ocr/` — worker,
  core wasm variants, and the English traineddata — so it works offline)
  recognizes the text. The result parses through the same tooltip parser and
  feeds the same observation pipeline, so a recovered tooltip contributes
  moves, PP, items, abilities, and tera exactly like a DOM-read one.
- **Why an offscreen document** — the main content script runs in the page's
  MAIN world where `chrome.runtime` is unavailable, and content-script
  workers can't fetch extension resources; a hidden offscreen page is a full
  extension context where tesseract's worker + wasm + data all load
  normally. The bridge (isolated world) relays the pixel array between the
  page and the worker (converting to a plain array because chrome.runtime
  messaging JSON-serializes — typed arrays arrive mangled otherwise).
- **Trigger** — the tooltip observer already tracks hovers on Pokémon icons;
  if a hover fires but no `.tooltip.tooltip-pokemon` element materializes
  within a short window, and the tab capture is live, the fallback runs.
  OCR is serialized (overlapping hovers are dropped), the watch row shows
  `N via OCR` when pixel reads succeed, and the E2E proves it end-to-end:
  with the DOM tooltip suppressed and the text drawn as plain pixels,
  hovering surfaces `Dragon Pulse (15/16)` in the panel.
- **Costs** — the OCR assets add ~28MB to the extension folder (downloaded
  once at build time by `scripts/build-ocr-assets.js`), the first OCR needs
  a few seconds to load the engine, and tesseract is best-effort: clean,
  high-contrast tooltips read well, but it stays a fallback — the fast,
  exact DOM reading is still the primary path.

## Stage 7: real screen capture & the 6-slot grid

- **Real tab capture** (`src/content/capture.js`) — the popup's *Start
  watching screen* button grabs the tab's MediaStream via
  `chrome.tabCapture.getMediaStreamId` (a user-gesture-only API — it's why
  the stream is started from the popup, with `consumerTabId` set so the
  content script can consume it). The content script renders frames to a
  small canvas and tracks live stats; while the stream is active, **Chrome
  shows its own screen-sharing indicator** (the visible proof you asked for)
  and the panel reports `● capturing screen · N frames · M changes seen`.
  The pixels feed change detection (hover tooltips, HP movement) **and the
  OCR fallback** (Stage 8); the fast, exact tooltip reading stays DOM-based
  on top of it.
- **Six-slot grid** — under *You* and *Opponent* each side renders six boxes
  (team-preview order for the opponent, request order for you). Empty slots
  are dashed placeholders (`not revealed yet`) that fill in as Pokémon are
  revealed, so you can see the whole picture at a glance.
- **Potential moves on the grid** — each opponent card with unrevealed
  moves shows `could have: …` (top candidates from the Gen 9 learnsets),
  so as they reveal their team you see both what they've shown and what
  they might still be holding.

## Stage 6: screen reading, tera & movepools

Three additions that give the engine more of what you know at the table:

- **Screen reading** (`src/content/tooltips.js`) — when you hover a Pokémon
  (your own sets at team preview, or either side mid-battle), the Showdown
  client renders a tooltip on screen; the extension observes it and merges
  what it says into the battle state: extra moves, **PP counts** (the log
  never shows PP), items, abilities, and tera types. The panel shows PP next
  to moves (`Dragon Pulse (15/16)`), and a `👁 watching your screen` status
  row plus a panel flash give instant feedback on **every** hover (the E2E
  hovers the same Pokémon twice and the read counter increments both times).  Verified against the real client's
  tooltip markup and end-to-end in the E2E. While a battle is being watched,
  the toolbar ⚡ icon carries a green **LIVE** badge (set by the service
  worker from the content script's battle reports) — the Chrome-level
  indicator that it's active. For the Chrome screen-sharing indicator, use
  the popup's *Start watching screen* (Stage 7).
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
  tests work offline). The candidates are **weighted by real Smogon usage
  stats**: `scripts/build-usage.js` downloads the monthly `gen9ou` moveset
  stats into `src/engine/data/usage-lite.js` (regenerate with `npm run usage`),
  so the panel's `could have:` list and the hidden-threat warnings reflect
  what people actually run (`Great Tusk could have: Rapid Spin · Headlong
  Rush · Ice Spinner`), not raw base power. The recommendation then warns
  about specific hidden threats (`⚠ their Dragonite could have Hurricane —
  it hits your Rillaboom for ~79.8%`), and switching is penalized when a
  hidden move would maul the candidate you're switching into.

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

### Friend names & alternate usernames

Profiles are resolved by *any* of the usernames mapped to them, so a friend
who plays under different accounts still gets one profile:

- Each profile has a **display name** (the friend's real name if you want)
  and an **aliases** list of usernames that map to it.
- Battles under any alias record into that profile — the panel shows the
  friend's name (`vs John · record …`) instead of the raw username.
- In the **options page**, click a profile's name to rename it (the old name
  is kept as an alias automatically), add usernames with the *Also plays
  as:* input, and remove them with the × button.
- `findProfileKey` resolves usernames through aliases (case-insensitive);
  `loadProfiles` normalizes aliases and re-keys old-format stored data.

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
- **Popup** (`src/popup/`) — quick panel on/off, **Start / Stop watching
  screen** (real tab capture via `chrome.tabCapture` — requires the
  `tabCapture` permission, which the manifest declares), and a link to
  options.
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

Tests (128): the reader (real battle + edge cases, the live `|request|`
fixture with moves/PP/tera/canTera, and hover observations), the UI
renderer (including the six-slot grid, opponent potential-moves line, and
capture status row), the engine (type advantage, KO detection, switch
advice, utility moves, calc consistency, switch prediction, tera
effectiveness + tera suggestions, hidden-move warnings, the real fixture),
the movepool (learnsets, worst-case hidden threats, terastallized
attackers), the tooltip parser (real captured tooltip text, mon resolution,
and noisy OCR text with stray scene lines), the OCR client (message
protocol, error + timeout handling) and offscreen module (pixel
reconstruction, async handler contract), the capture module (frame
hashing, start/stop lifecycle, failure handling, region grabbing), the
profiles (including friend aliases: key resolution, rename-keeps-alias,
add/remove alias, normalization on load), the storage driver, the settings
module, and the options-page rendering (rename inputs + alias controls).
The live client protocol fixture (`test/fixtures/live-stepqueue.json`) was
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
  package's per-generation type chart.
- `statestimate.js` — **back-calculates the opponent's EV investment from
  observed damage**. Every move hit is recorded by the reader as an
  observation (attacker, move, defender, damage %), and the estimator
  binary-searches the EV axis of the stat that matters (attacker atk/spa,
  defender def/spd) to find the range whose predicted damage brackets what
  was actually dealt. Ranges intersect across observations, so they narrow as
  the battle goes on (and across battles, since mon records persist per
  session). The learned midpoint feeds back into `buildPokemon`, replacing
  the blanket 252-EV assumption for stats that have narrowed enough, and the
  panel shows it as a `learned ev:` tag (e.g. `def ~8` for a mon that eats
  hits badly). HP EVs are solved exactly whenever absolute max HP is revealed
  (the live request's `condition`, absolute HP in the log, or a hover
  tooltip). Single hits only pin wide ranges (damage rolls span 85-100%), so
  it's honest about uncertainty — it reports a range, not a guess. Tera is simulated with
  `opts.attackerTera` / `opts.defenderTera` (the calc treats a set tera type
  as the terastallized state), and effectiveness is reported for the tera
  type when a defender is terastallized.
- `movepool.js` — hidden-move reasoning: `potentialMoves(species)` from the
  bundled Gen 9 learnsets, `usageWeight(species, move)` / usage-ranked
  `topPotentialMoves(species, n)` from the bundled Smogon usage stats,
  `worstThreat(theirMon, target)` (the strongest move they haven't revealed
  yet, pre-scored by power × effectiveness × STAB blended with usage %, then
  damage-calc'd on the top candidates, memoized per state signature), and
  `teamThreats(...)` across your whole team.
- `recommend.js` — the decision logic:
  - Each move is scored as expected damage vs their active Pokémon weighted by
    P(they stay), plus damage vs each benched mon weighted by P(switch-in),
    with damage capped at remaining HP and a KO bonus.
  - Status/setup/recovery/hazard moves get utility scores; recovery value
    scales with how much HP is actually missing (never recommended at full
    HP), and moves that are out of PP are skipped.
  - Switching is scored by how much less damage the candidate takes from their
    active's best move than the current mon would, plus a small offensive
    bonus; it's recommended when clearly better and our options are weak, we're
    in danger, or the switch is decisively better than any move we have.
  - Switch prediction uses `opts.profile` when available:
    `{ switchTendency: { atLowHp }, commonSwitchIns: { species: weight } }`.
  - Right after the opponent switches in a Pokémon, the engine treats it as a
    commitment (stay probability is boosted to 0.9 regardless of its HP), so
    the move suggestion targets the new active instead of hedging toward the
    bench — and the reasoning says "They just brought in X".
  - A switch is recommended when it clearly saves HP and our options are weak,
    we're in danger, the switch is clearly better than any move (net > 20), or
    their active threatens us for a large chunk of HP every turn.
  - Switch evaluation includes the opponent's **hidden moves**: early in a
    battle (or against any mon with unrevealed slots), the worst move they
    could hit your current mon with counts toward the threat — discounted,
    since potential moves aren't certainties — so the engine suggests
    switching away from a lead that a possible move would wreck. Once all 4
    moves are revealed, hidden-move speculation stops.
  - **Status-setup pivots**: a status wall (Chansey's Thunder Wave, Toxic,
    …) gets the "status now, switch next turn" play — inflict the status,
    then pivot to the damage dealer. A status move that would do nothing
    (the target is already statused) is never recommended.
  - Every recommendation carries a **confidence %**: the best move's share vs
    the runner-up move, and the switch's share vs using the best move
    (100% when it's the only option). Shown as badges in the panel.

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

128 tests cover the reader (real 22-turn Gen 9 OU battle + edge cases),
the UI (model, HTML output, escaping, mid-battle and empty states, the
six-slot grid, potential moves, capture status), the engine (type
advantage, KO detection, switch advice, utility moves, calc consistency,
switch prediction, tera, movepool threats, the real fixture), the tooltip
parser (including noisy OCR text), the movepool, the OCR client + offscreen
module, the capture module, the profiles, the storage driver, the settings
module, and the options-page rendering. The demo page is also verified
end-to-end by rendering it in headless Chrome, and the extension itself is
verified end-to-end: a real battle page is loaded with the actual built
extension, and the E2E checks the live panel, profile recording, a
hover-tooltip observation (PP appears in the panel), persistence across a
page reload, the options page, the popup, **real tab capture** (start →
frames increment → stop), **the OCR fallback** (DOM tooltip suppressed,
pixel tooltip read, PP appears in the panel), and the live panel toggle.

Tests cover a real 22-turn Gen 9 OU battle (`test/fixtures/real-battle.log`,
fetched from Showdown replays) plus hand-crafted edge cases.

### Speed-order awareness

Before recommending a move, the engine compares each side's effective Speed
and factors the outcome into the advice:

- Speed is computed as a **range** (0 → 252 EVs, neutral → speed-boosting
  nature) because the opponent's investment isn't visible. When the ranges
  don't overlap, the engine says who moves first with certainty; overlapping
  ranges are reported honestly as “could go either way.”
- The reader's known modifiers are applied: **boost stages**, **paralysis**
  (halved), **Choice Scarf** (while held), weather-based abilities (Swift
  Swim in rain, Chlorophyll in sun, …), **Tailwind** per side, and **Trick
  Room** (which flips the comparison).
- In move evaluation: going for a KO while outspeeding gets a bonus; a move
  that risks being KO'd before it lands (they outspeed and can KO) is
  penalized and called out.
- In switch evaluation: a switch-in that outspeeds their active is rewarded;
  one that is outsped while eating heavy damage is penalized.
- The panel's reasoning list always opens with the current speed situation.

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
