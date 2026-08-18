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
10. **Pro-level engine depth** (done) — the engine plays for win conditions:
    entry hazards and screens are charged into every damage and switch roll,
    residual chip (burn/poison/weather/Leftovers) counts toward KOs, switch
    prediction is threat-based (the move you click draws the mon that walls
    it), setup moves are scored by the sweep they unlock, and the endgame is
    enumerated into locked 1v1s. All fed into the reasoning the panel shows.
11. **Risk modes** (done) — the engine reads who's ahead (a board-advantage
    score from remaining HP + bodies, refined by a game-level positional
    win-probability read — see 15) and adapts how it plays: ahead →
    **safe** (reward the guaranteed KO, discount risky rolls, switch eagerly
    to protect the lead); behind → **aggressive** (prize the non-guaranteed
    KO swing, accept risky setups as the comeback, avoid burning tempo on
    marginal switches); balanced → current behavior. `riskMode` defaults to
    `auto` (derived from the board each turn) and can be forced in options;
    the panel shows which line it's playing and by how much.
12. **Weather & terrain planning** (done) — weather/terrain actually affect
    damage now (the reader's Showdown names like `RainDance`/`Grassy Terrain`
    are normalized to the calc's `Rain`/`Grassy`, so Rain boosts Water moves
    and Grassy halves Earthquake instead of being silently ignored). The
    engine values weather/terrain moves by what they unlock (`fieldDamageDelta`
    simulates the field-after and sums the damage gain), skips re-setting the
    active condition, credits counter-weather (replacing their Sun stops
    their boosts) and chip/heal, warns when the new field would help their
    speed abuser, and anticipates their field-flippers (a revealed Rain Dance
    or a Drizzle/Drought ability on their active or bench). The stat
    estimator snapshots the field per hit so learned EVs stay accurate under
    changing weather.
13. **Random-battle awareness + profile backups** (done) — Random Battles
    (the format you mostly play) are detected from the battle's tier/room,
    and the engine switches modes: hidden moves come from each species'
    official random template pool (5-10 moves, not the full learnset), Smogon
    OU usage weights are neutralized, and unrevealed mons are calc'd at their
    template level (79-88, not 100). Every finished battle records a readable
    move log + a random-battle flag into the opponent's profile, and the
    options page can export all profiles as a downloadable .txt backup
    (save it in the repo's gitignored `exports/` folder).
14. **Engine depth round 2** (done) — six new engines on top of the pro-level
    core: **Foul Play** is calculated and learned correctly (the move runs off
    the TARGET's Attack, so the calc assumes their Atk is the invested stat and
    observed Foul Play hits narrow the defender's EVs — never the attacker's);
    **priority-move awareness** (a revealed Aqua Jet / Sucker Punch / Extreme
    Speed / Bullet Punch beats the Speed read: KO calls stop claiming "safe"
    when their priority move can pick you off, your own priority move lands
    the KO when outsped, switch speed-rewards yield to priority threats, and
    endgame 1v1s are decided by priority KOs regardless of who is faster);
    **their-setup prediction** (a healthy mon with a revealed setup move is
    staying to boost — the engine says "KO it NOW before it sets up" or
    "switch before it sweeps", and switching into a setup threat is nudged
    down); **tera timing** (recommend terastallizing when it flips a losing
    matchup — the survive-the-KO read — and warn when their revealed tera
    type would flip yours); **item-condition plays** (a full-HP Focus Sash
    eats the KO call and the chip-the-sash-first note replaces it, and
    clicking a super-effective move into a revealed Weakness Policy prices in
    the +2 counter-attack); and a **2-turn race projection** ("their X
    finishes you in ~2 turns at ~53%/turn — win now or switch").
15. **Positional win-probability eval** (done) — a game-level "who wins this
    game" read (`position.js`) from six components: material (remaining HP
    + per-body bonus), firepower (each side's total offensive rate),
    fastest-Speed control, the hazard differential, recovery potential, and
    the active 1v1 trade. Auto risk mode now consults the read first (an
    even-HP board where their team sweeps yours plays aggressive, and vice
    versa), extreme positions temper the switch bar continuously (deep ahead
    → lower bar to protect the lead, deep behind → higher bar to save
    tempo), and the panel shows the read as a per-turn win gauge (a
    zone-colored bar with the percentage, visible every turn) plus the risk
    badge (`🛡 playing safe (+230)`) when the board is decided.
16. **2-ply opponent response** (done) — a fifth committee engine (`response`)
    scores each candidate move one ply deeper: if it doesn't KO, their
    active's best reply decides (KOs us back → bad trade, sets up → the
    sweep is coming, can't punish → free hit); if it does KO, the likely
    replacement is the read (brings in a counter → discounted, one we beat
    → rewarded). Catches "this move lets them set up" and "this KO hands
    them momentum" that a one-ply scorer can't see; the tuning re-run
    confirms the shipped blend still holds its plateau with it in the
    committee.
17. **Endgame checkmate search** (done) — when the battle is down to ≤2 of
    their mons (≤4 alive total), `endgameCheckmate` looks for a FORCING win
    line instead of leaving it to per-move evaluation: **ko-now** (our
    active finishes their last mon), **duel** (a bench piece wins the 1v1
    even after the entry hit), **ko-then** (KO their current, then beat the
    replacement 1v1), and **sac** (our active chips their current into a
    bench mate's range). If *their* line is the forcing one, it warns:
    "their Garchomp KOs your Weavile, then Dragonite beats everything 1v1 —
    you're on a clock". The search is honest about hidden moves: every race
    prices their hidden worst case, so an unrevealed coverage nuke refuses
    the "forced win" claim the fully-revealed board would make.
18. **Per-opponent behavioral model** (done) — the profile stops being just
    a switch-prediction hint and starts shaping how the engine prices
    uncertainty: their **personal move usage** re-weights hidden-move
    pricing (a move they've been seen running on a species in past battles
    beats Smogon theorymon for the EV read), their **tera habits** are
    learned from the battle journal (how often, on what species, how early
    — "they've tera'd this one in 2 past battles; they tera early as soon
    as turn 4"), and their **lead tendencies** fill in switch prediction
    when there's no switch-in history yet. Hidden-move cache keys now
    include the personal table so two opponents never share a cached read.
19. **Switch-pattern awareness** (done) — the engine no longer evaluates
    every turn in isolation: `switchPattern` reads the battle journal and
    spots when a side is *choosing* to switch repeatedly. An opponent who
    has been pivoting is likely to pivot again — the stay probability is
    lowered (so the move committee prices in the read) and the panel names
    the likely switch-in plus the move that punishes it ("they've switched
    3 of the last 4 turns — expect a switch, likely to Corviknight; your
    Thunderbolt hits it for ~104%"). And when WE are the ones chain-
    switching, it says so and raises the switch bar so marginal pivots stop
    being recommended ("you've switched 3 turns in a row — every switch
    gives them a free turn; commit or make it a read"). Forced switches
    (drags, faint replacements) never feed the pattern.

## Stage 14: the six new engines

- **Foul Play** — `@smogon/calc` already swaps the attack source for Foul
  Play internally (`attackSource = defender`), but this engine's wrapper made
  two wrong assumptions around it: it gave the *attacker* the 252-EV
  investment (irrelevant — the calc ignores it) and the *defender* none in
  Atk (the stat that actually powers the move). `damagePercent` now puts the
  standard 252-EV attacker assumption on the **defender's Atk** for Foul
  Play, so the move finally prices a physical attacker's investment (~+20%
  vs an invested Garchomp), and the stat estimator no longer "learns" the
  attacker's Atk from a Foul Play hit — the observation narrows the
  defender's Atk (the attack source) and Def instead. The move note says
  "uses their Attack" so the read is explicit: it's a physical-attacker
  answer, weak against special walls.
- **Priority-move awareness** (`movePriority` in speed.js, `bestPriorityMove`
  in recommend.js) — priority beats Speed, and the engine now honors it
  everywhere Speed was the only judge:
  - **KO calls**: "you outspeed — safe to go for the KO" is cancelled when
    their active holds a revealed priority move that can KO you first (the
    bonus becomes a penalty: "their Extreme Speed can KO you first
    (priority)"); a priority move of yours strikes first even when outsped
    ("they outspeed you, but Ice Shard has priority — you strike first").
    Grassy Glide counts as priority only while Grassy Terrain is up.
  - **Switches**: a candidate their priority move can KO loses the
    outspeed reward ("their Scizor's Bullet Punch can KO Rillaboom before
    it acts (priority)"), and a candidate with a priority KO of its own is
    rewarded despite being outsped.
  - **Endgame 1v1s**: a priority KO on either side decides the duel
    outright ("their Dragonite beats your Rillaboom 1v1 (priority KO) —
    avoid that pairing").
- **Their setup prediction** — `predictStayProb` bumps a healthy mon's
  stay-probability when it holds a revealed setup move it hasn't used yet
  (pros set up on the switch-in), and the reasoning warns: "their Dragonite
  has Dragon Dance — it's about to set up. KO it now or switch before it
  sweeps" (or "KO it NOW before it sets up" when your best move already
  finishes it). Switching into a setup threat that the candidate can't even
  wall is nudged down: "switching gives it a free turn to set up".
- **Tera timing** — the tera suggestion now includes the **flip-a-losing-
  matchup** read: when their hit KOs you and terastallizing into your tera
  type makes you survive it, the line says "tera-Water turns their ~139%
  hit into ~35% — you survive it" (that's the moment to press the button,
  not a marginal damage trade). And a revealed-but-unused **their** tera
  type that would flip YOUR matchup is warned: "their Great Tusk can
  terastallize into Grass: your Wood Hammer drops ~63% → ~16% — plan around
  it". The tera block moved earlier in the reasoning so it survives the
  9-line budget in busy turns.
- **Item-condition plays** — a revealed, unconsumed **Focus Sash** on a
  full-HP target eats the KO: the "guaranteed KO" claim is dropped and the
  note becomes "their Focus Sash survives it (1 HP) — chip it first". A
  revealed **Weakness Policy** that your super-effective click would trigger
  is priced into the move ("⚠ Ice Beam triggers their Weakness Policy —
  their Dragonite gets +2 and hits for ~101%") — unless the move KOs, since
  a faint can't boost. The same reads show inline in the matchup **Damage
  row** ("⚠ their Focus Sash survives it" / "⚠ triggers their Weakness
  Policy (+2)"), so they're visible at a glance without opening the
  reasoning.
- **2-turn race projection** (`raceProjection`) — hazard + chip + speed
  formalized into a simple race: when they finish you in ≤2 turns and you
  can't finish them first, the reasoning calls it: "Race check: their
  Garchomp finishes you in ~1 turn at ~46%/turn — you can't outlast it; win
  this turn or switch". The race runs on their **full worst-case hidden
  move** (not the discounted 0.6× used elsewhere — a survival projection
  plans for the strongest move they COULD have), and names it when it's the
  driver: "Race check: their Garchomp finishes you in ~1 turn at
  ~107.6%/turn (includes likely Brick Break ~107.6%) — …"  - **Smogon set-based EV priors** (`sets.js`, `data/sets-lite.js`,
    `scripts/build-sets.js`) — every damage number now starts from each
    species' **real top Smogon spreads** instead of a flat 252/252 guess:
    the monthly usage stats' Spreads section is parsed into per-species
    EV/nature candidates (built with `npm run sets`, committed for offline
    tests), and the calc picks the spread that matches what's known about
    the mon — the offensive stat role (physical vs special, from the
    revealed-move inference) decides which spread to use, HP/Def/SpD
    investment is honored, and the stat estimator's observations still
    narrow from there. The result is that a 0-SpD Garchomp's hidden Fire
    Blast is a ~10% coverage tick, not the ~40% the flat model claimed, and
    Weavile's Icicle Crash reliably OHKOs — real spreads change the math
    everywhere (tests pin the flat model with `sets: false` where the
    controlled-EV intent matters, and the real-spread numbers otherwise).
  - **Expected-value hidden-move pricing** — hidden-move threats are now
    priced **two ways, deliberately**: the worst case (strongest move they
    could hit you with, discounted 0.6×) remains the risk floor for the
    defense-first gates and the warnings, while the switch **nets** price
    each likely hidden move by its real Smogon usage weight
    (`expectedIncoming` / `expectedThreat`), so a candidate threatened only
    by a 2%-usage theorymon coverage nuke isn't over-penalized when the
    species' real sets are known. The KO-trade exception is honored in both
    switch paths: a candidate that threatens a KO back doesn't pay the
    revealed-certainty penalty on top of the gate's KO allowance ("only the
    KO justifies the trade").
  - **2-ply opponent response** (the `response` committee engine) — each
    candidate move is scored one ply deeper: what does their BEST reply do
    to the resulting position? If the move doesn't KO, their active's reply
    is the read — it **KOs us back** (a losing trade even when we move
    first: "it survives and KOs you back (~73%)"), it **sets up** ("it
    survives and sets up (Dragon Dance revealed)" — the "KO it NOW" warning
    priced into the move), or it **can't punish us** (a free hit: "they
    can't punish it (~0% back)"). If the move does KO, the read is their
    most likely replacement: a KO that **brings in a counter** is discounted
    ("brings in Tornadus which threatens you ~163%"), a KO whose likely
    switch-in **we beat** is rewarded ("and Fire Blast beats the likely
    Scizor (~240%)"). Scale is context-sized (±9), so it nudges close calls
    without overpowering the damage anchor — and the tuning re-run confirms
    the shipped all-1s blend still holds 43.9% / 97.6% with it in the
    committee.
  - **Physical/special EV inference** (`inferOffensiveStat`) — a mon that has
  revealed mostly physical damaging moves (≥2, at least 3× the special
  count) is almost certainly Atk-invested; mostly special moves →
  SpA-invested. The bias fills the gap before damage observations narrow the
  EVs: a known physical attacker's unrevealed special coverage is priced at
  ~0 SpA instead of 252 (a physical Garchomp's hidden Fire Blast is a
  coverage tick, not a nuke), and Foul Play against a known special
  attacker runs off its near-zero Atk. Mixed (2-2), single-move, or
  unknown sets stay un-inferred — and the reasoning calls out the read:
  "their Garchomp reads as a physical attacker … and Foul Play would punish
  it". The matchup stat rows surface it visually too: the invested stat
  (Atk for physical, SpA for special) gets a subtle ✦ tint and a tooltip
  ("Revealed moves read physical — Atk is likely invested (252 EV)"), so
  the read is visible at a glance without opening the reasoning.
  - **Positional win-probability eval** (`position.js` / `positionalWinProb`)
    — the risk mode's board read is now a game-level eval, not just HP:
    six components (material = HP + 40/body normalized; firepower = each
    side's total offensive RATE against the other team, deliberately
    uncapped so a nearly-dead target doesn't make the short side look
    strong, and only counted once both sides have revealed moves; fastest
    effective Speed, revealed stats → sets prior → max-plausible; hazard
    differential ~10% of a body per layer; recovery potential = recovery
    moves × missing HP; active 1v1 trade, with their active down counting
    as a tempo swing) weighted into a 0-1 win probability. Auto mode
    consults the read first (≥0.66 safe / ≤0.34 aggressive, HP advantage
    as fallback), so an even-HP board where their team sweeps yours plays
    aggressive — and extreme positions temper the switch bar continuously
    (×0.75 deep ahead, ×1.5 deep behind; auto mode only). The reasoning
    line and the per-turn win gauge (a zone-colored bar with `~N%` —
    green ≥66, amber in between, red ≤34) carry the read, with the risk
    badge (`🛡 playing safe (+230)`) when the board is decided, and the
    returned risk object gains `winProb` + `switchBar`.

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
  Change detection is **block-based**: the frame is hashed in 32px blocks
  and a change only counts when several blocks differ at once, so idle
  sprite bobbing/animations no longer register as "the screen changed" —
  real events (tooltips, HP bars, log text) do.
  Starting the watch is now a **handshake, not a fire-and-forget**: the
  content script acks back through the bridge, the popup waits for the ack
  (and retries with a fresh stream id if the page wasn't ready), and a
  failure shows a real error message instead of silently doing nothing.
- **Panel stays put** — re-renders (every poll tick and capture frame)
  preserve your scroll position and the collapsed state, so the panel no
  longer snaps back to the top or pops open on its own.
- **Six-slot grid** — under *You* and *Opponent* each side renders six boxes
  (team-preview order for the opponent, request order for you). Empty slots
  are dashed placeholders (`not revealed yet`) that fill in as Pokémon are
  revealed, so you can see the whole picture at a glance.
- **Stats on every card** — each box shows a compact stat row
  (`A 172 · D 111 · SA 81 · SD 101 · S 141`): **exact values for your team**
  (the live `|request|` carries your true stats, so they appear the moment
  the battle loads) and **estimated ranges for the opponent** (0→252 EV
  bounds, which tighten as you hover their Pokémon for the exact Spe range
  and as the stat estimator back-calculates their EVs from damage). Your
  exact numbers render in green so the two are distinguishable at a glance.
- **Potential moves on the grid** — each opponent card with unrevealed
  moves shows `could have: …` (top candidates from the Gen 9 learnsets),
  so as they reveal their team you see both what they've shown and what
  they might still be holding.

## Stage 10: speed memory, honest capture, resizable panel

- **Speed memory survives switch-outs.** Same-turn move trades are now
  recorded with **species**, and the engine keeps a species-keyed **speed
  memory** of rough base-Speed bounds: when a clean trade happens with no
  speed modifiers in play anywhere (all “speed versions” zero) and one side's
  Speed is exactly known (your `|request|` stats or a point Spe range from a
  hover), the observed order pins a bound on the other mon's base Speed —
  “their Garchomp moved after my 295-Speed Rillaboom, so its base Speed is
  at most 295.” Because it's species-keyed, **a Pokémon that leaves and  comes back keeps its remembered speed** instead of returning to the full 0→252
  guess, and the speed line labels it: “(speed remembered from earlier
trades).” Equal-Speed ties break randomly, so the bound is ≤/≥ (never
  strict), and a bound that contradicts the species' possible Speed is
  discarded rather than producing an inverted range. The narrowed range also
  shows **on the opponent's card**: their Spe stat (and the matchup table's
  Spe row) tightens to the remembered bounds and is marked amber with a
  dashed underline (hover: “Speed narrowed from observed move order —
  remembered from earlier trades”), so the card and the speed line always
  agree.
- **A re-entered Pokémon keeps its observed move order.** Evidence recorded
  against `p2a: Garchomp` still applies when the same mon returns as `p2b` —
  the reader reuses the record (same species, same speed versions), so the
  engine matches the observation by species and keeps saying “it moved first
  when you last traded moves” instead of falling back to overlapping ranges.
- **The panel is masked out of screen capture.** The assistant panel lives
  inside the captured tab, so scrolling or resizing it used to register as a
  constant “the screen changed” (and could retrigger OCR). The block diff
  now masks the overlay's on-screen rectangle on both frames, so the capture
  only reacts to the battle behind it.
- **The panel is resizable.** A corner handle (⤡) drags the panel to any
  size (240–800px wide, up to 90% of the window tall); the body then fills
  the set height and scrolls internally. The size survives re-renders and
  page loads (overlay dataset + localStorage), and double-clicking the
  handle resets to the default size.
- **The panel is movable.** Drag it by its header to park it anywhere on the
  page (clamped so a corner always stays reachable). The position survives
  re-renders and page loads like the size does, the ⚡ bring-back button
  appears where the panel was hidden, and double-clicking the header snaps
  it back to the default top-right spot. Header buttons never start a drag.
- **Compact mode.** The ▤ header button collapses the reasoning list to its
  first line and the matchup table to its Damage row (one line each, with
  the expanded full-calc panel tucked away), so the panel fits in a corner
  while you play. The preference persists across re-renders and page loads,
  and the button stays highlighted while compact is on.

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
  hidden move would maul the candidate you're switching into — except when
  the candidate threatens a KO back, the one trade the defense-first rules
  explicitly allow ("only the KO justifies the trade").

## Stage 5: per-opponent profiles, settings & options

`src/profiles/` learns about each opponent so predictions get sharper over
time, keyed by (lowercased) username and stored in `chrome.storage.local`
(with an in-memory fallback so everything stays Node-testable):

- `learn.js` — `summarizeBattle(state, ourSideId)` extracts one battle's
  facts from the reader's action journal: both leads, voluntary switch-ins
  (forced switches — `|drag|`, pivot, or right after a faint — are excluded),
  low-HP switch/faint counts, move usage per species, revealed sets, tera
  timing (turn + species, from the journal's tera actions), a `random` flag
  (Random Battle or not), and a **per-turn move log** (`T1 you Raging Bolt
  used Dragon Pulse` / `T4 them Garchomp fainted`) — the "small summary of
  what happened" saved after every match. `updateProfile` merges a battle
  into the running profile (record, common leads, switch-in and move-usage
  counts, set unions, tera habits, last 20 battles).
- `export.js` — `exportProfilesText(profiles)` renders the whole store as a
  readable .txt backup: every opponent, their tendencies, each battle's log,
  and a RAW JSON payload at the bottom for restoring later.
- `store.js` — `loadProfiles`/`saveProfiles` over the unified storage driver.
- Projections: `profileForEngine` produces the exact shape the engine
  consumes — `switchTendency.atLowHp` + `commonSwitchIns` (switch
  prediction), `moveUsage` (personal hidden-move priors, exposed only once
  a species has ≥2 seen moves), `commonLeads` (lead-tendency fallback for
  switch prediction with no switch-in history), and `teraHabits` (count,
  per-species, earliest turn). `profileForDisplay` produces the panel strip
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
  engine's stat assumption (typical 252-EV builds vs base stats), pick the
  risk mode (auto / safe / balanced / aggressive), manage the learned
  profiles (view, delete one, clear all), and **Export profiles (.txt)** —
  downloads a timestamped backup of every profile and battle log; save it
  into the repo's `exports/` folder (gitignored) as a local backup.
- **Random battles** — the format is detected automatically (tier line /
  room id), so the panel adds a note that species patterns are noise and
  only playstyle counts; see the engine section for how analysis changes.
- **Popup** (`src/popup/`) — quick panel on/off, **Start / Stop watching
  screen** (real tab capture via `chrome.tabCapture` — requires the
  `tabCapture` permission, which the manifest declares), and a link to
  options.
- **Icons** — generated at build time by `scripts/make-icons.js`, a
  dependency-free PNG encoder (Node's built-in `zlib`).
- **Settings** (`src/settings.js`) — `panelEnabled`, `statAssumption`, and
  `riskMode` (auto / safe / balanced / aggressive), threaded into the engine
  through `recommend(state, { statAssumption, riskMode })`.

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

**After every code change:** hit the ↻ reload button in `chrome://extensions`
**and then refresh your open battle tab.** The old tab keeps running the
pre-reload scripts until refreshed — if you see `Extension context invalidated`
in the console after reloading, that's exactly this (the stale script is now
handled silently), and refreshing the tab clears it.

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

Tests (395): the reader (real battle + edge cases, the live `|request|`
fixture with moves/PP/tera/canTera, hover observations, tera journal
actions, and the activate-move hazard guard that stops a mon from
"learning" Sticky Web / Future Sight from being affected by them), the UI
renderer (including the six-slot grid, opponent potential-moves line, and
capture status row), the engine (type advantage, KO detection, switch
advice, utility moves, calc consistency, switch prediction, switch-pattern
reads, tera
effectiveness + tera suggestions, hidden-move warnings, endgame checkmate
lines, personal-usage hidden-move priors + tera-habit reasoning, the real
fixture),
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
  - **No pivot ping-pong**: right after we bring in a Pokémon the engine
    won't suggest switching again that turn ("you just brought in X —
    switching again immediately would give them a free turn"), and a mon
    that left the field in the last turn or two is never recommended as a
    switch-in — so "switch to B" is never followed by "switch back to A".
  - Switch evaluation includes the opponent's **hidden moves** — priced two
    ways, deliberately: the **worst case** (the strongest move they could
    hit you with, discounted since potential moves aren't certainties) drives
    the defense-first gates and the warnings, while the **expected value**
    (each likely hidden move weighted by real Smogon usage) drives the
    switch nets — so a candidate threatened only by a 2%-usage theorymon
    coverage nuke isn't over-penalized when the species' real sets are known.
    Once all 4 moves are revealed, hidden-move speculation stops.
  - When your active is down, the forced send-in (`bestSwitchIn`) weighs
    incoming damage (revealed **and** discounted hidden) one-for-one against
    the candidate's own offense, so it won't send in a Pokémon that's weak to
    what their active has shown — or could have.
  - **Status-setup pivots**: a status wall (Chansey's Thunder Wave, Toxic,
    …) gets the "status now, switch next turn" play — inflict the status,
    then pivot to the damage dealer. A status move that would do nothing
    (the target is already statused) is never recommended.
  - **Choice-lock aware**: a mon holding a Choice Band/Specs/Scarf is stuck
    on its first move after entering the field. The reader records the lock
    (and resets it on switch-in), so the engine never suggests a move you
    literally can't select — it says "locked into X — switch to reset" — and
    it notes when the *opponent* is choice-locked, since they must repeat
    that move.
  - Every recommendation carries a **confidence %**: the best move's share vs
    the runner-up move, and the switch's share vs using the best move
    (100% when it's the only option). Shown as badges in the panel.
  - **Risk modes** (`boardAdvantage` / `resolveRiskMode` / `RISK_MODES`): a
    board-advantage score (remaining HP + a per-body bonus, both sides)
    decides who's ahead each turn, and `riskMode` (auto by default) tilts
    the scoring — ahead → **safe** (the guaranteed KO is worth 14 vs a
    gamble's 6, being KO'd back hurts more, risky setups are near-useless,
    and the switch bar drops so the lead stays protected); behind →
    **aggressive** (the non-guaranteed KO swing is worth 13 — the 60%
    gamble that wins if it lands — being outsped hurts less, risky setups
    become the comeback, and the switch bar rises so marginal switches
    don't bleed tempo). The panel shows the game-level read as a per-turn
    win gauge (`Win ~68%` bar, visible even on balanced boards) and the
    line as a badge when decided: `🛡 playing safe (+230)` or `⚔ playing
    aggressive (−210)`, and the reasoning explains it. Options can force a
    mode; auto reads the board via the game-level positional
    win-probability eval (Stage 14) — the win read is consulted before
    the raw HP advantage, and extreme positions temper the switch bar
    continuously.
  - **Entry hazards are charged into switches** (`hazardDamageOnEntry`):
    Stealth Rock/Steelsurge hit by type effectiveness, Spikes by layer count
    (1/8, 1/6, 1/4) — so the engine stops recommending a switch that eats
    25%+ just entering, and the reasoning says "plus ~X% to hazards on
    entry". Non-damaging entry effects are called out too (Sticky Web
    slowdown, Toxic Spikes poison, or a Poison type absorbing them). Screens
    (Reflect/Light Screen/Aurora Veil) flow into every damage roll through
    the calc's per-side field, and hazard removal (Defog/Rapid Spin/Tidy Up)
    is valued by how many layers are actually up — near zero on a clean field.
  - **Residual damage is counted** (`chipPerTurn`): burn/poison/weather chip,
    Grassy Terrain healing (grounded mons only), and Leftovers regeneration
    feed the KO logic — a hit that brings a burned target into chip range
    counts as a KO ("can KO (chip finishes it)") — and recovery is valued
    against the chip you're bleeding each turn.
  - **Weather & terrain are played, not just read** (`WEATHER_MOVES` /
    `TERRAIN_MOVES` / `fieldDamageDelta`): `buildField` normalizes the
    reader's Showdown field names to the calc's canonical ones (RainDance →
    Rain, Grassy Terrain → Grassy) so weather/terrain genuinely change every
    damage roll. Weather/terrain moves are scored by the damage the new
    field unlocks (Rain Dance's note: "Hydro Pump on Gliscor: 64.6% →
    96.7%"), never re-set an active condition, get credit for counter-weather
    ("replaces their Sun"), Sandstorm/Hail chip, and Grassy healing — and
    are devalued when the field would turn on their speed abuser (setting
    Rain with their Swift Swim Kingdra on the bench). The engine also
    anticipates their flips: a revealed Rain Dance on their active or a
    Drizzle/Drought/Sand Stream ability on their active or bench gets a
    warning line. The stat estimator snapshots weather/terrain per hit, so
    learned EVs stay correct under a changing field.
  - **Threat-based switch prediction** (`moveConditionalSwitchProbs`): the
    bench split of the switch probability is conditioned on the move you're
    about to use — a mon that walls or absorbs it becomes the likely reactive
    switch-in (the "double" read: clicking Earthquake weights the incoming
    Landorus), a mon it would wreck sheds probability. P(stay) is unchanged;
    only the split among bench mons moves.
  - **Win-condition tracking** (`teamWincon` / `offensiveValue`): the engine
    identifies each side's biggest threat — the mon that threatens the most
    of the opposing team — and says so: "Their X is their win condition —
    play around it" (or "this move can KO it, take the shot") and "Your Y is
    your win condition — keep it out of danger".
  - **Setup & sweep lines** (`sweepPotential`): a setup move (Swords Dance,
    Dragon Dance, Calm Mind, Shell Smash, …) is scored by the sweep it
    unlocks — how many of their remaining mons a boosted best move 1HKOs /
    2HKOs — and only recommended when you can take their active's hit
    (setting up into something that KOs you is deflated hard and flagged
    "risky"). Two low-HP guards stop the "keep boosting" loop: if your best
    damage move already finishes their active and you're below ~45% HP, the
    engine says "just take the KO"; and if they 2HKO you at low HP (no free
    turn for the boost), setup is flagged risky too.
  - **Switch-ins play offense, not just defense** (`evaluateSwitch`): a
    switch-in's damage is capped at their active's remaining HP (overkill
    gets no credit), weighted 4× heavier than before, and a candidate that
    can KO their active gets a mode-aware reward (safe only trusts a
    *guaranteed* roll; aggressive swings for the risky one) — so a
    fragile-but-deadly 4×-SE pick is suggested when it should be, instead of
    always losing to a pure wall. And a candidate weak to a move they've
    already **shown** pays an extra certainty penalty (revealed beats
    speculation), so the engine never sends in a mon their known coverage
    wrecks just because its hypothetical moves are scarier.
  - **Random-battle mode** (`randoms.js` + `randoms-lite.js`): when the
    battle is a Random Battle (detected from the tier/room), the engine
    stops assuming a pre-made OU team — "could have" moves come from the
    species' official random template pool (`randomsMoves`, 5-10 moves per
    species instead of the full learnset), Smogon usage weights are
    neutralized (random teams don't follow OU sets), and unrevealed mons are
    calc'd at their template level (`randomsLevel`, e.g. Weavile 79, not
    100). The panel notes that in randoms the profile's species patterns are
    noise and only the playstyle numbers (switching habits) carry over.
  - **Endgame lock-in logic** (`endgameLocks`): once the battle is down to
    ≤4 mons, the engine enumerates the remaining 1v1s (best moves, remaining
    HP, speed order) and calls out the decided ones: "your Rillaboom beats
    their Garchomp 1v1 (1HKO vs their 4HKO) — locked in" and "their Dragapult
    beats your X 1v1 — avoid that pairing". Priority KOs decide a duel
    outright — a revealed Extreme Speed that finishes the faster mon flips
    the verdict and is labeled "(priority KO)".
  - **Priority-move awareness** (`movePriority` in speed.js — Grassy Glide
    counts only on Grassy Terrain — and `bestPriorityMove` in recommend.js):
    priority beats Speed, so the engine stops trusting an outspeed read when
    it doesn't hold. A revealed priority move on their active that can KO you
    cancels the "safe KO" bonus ("their Extreme Speed can KO you first
    (priority)"); your own priority move lands the KO even when outsped
    ("they outspeed you, but Ice Shard has priority — you strike first"); a
    switch-in their priority move can KO loses its speed reward; a candidate
    with a priority KO of its own is rewarded; and a ⚠ reasoning line says
    plainly when their priority move beats your Speed.
  - **Their setup prediction**: a healthy active with a revealed setup move
    (Dragon Dance, Calm Mind, Shell Smash, …) it hasn't used is staying to
    boost — `predictStayProb` bumps P(stay), and the reasoning warns "their
    Dragonite has Dragon Dance — it's about to set up. KO it now or switch
    before it sweeps" (or "KO it NOW" when your best move already finishes
    it). Switching into a setup threat the candidate can't wall is nudged
    down with the note "switching gives it a free turn to set up".
  - **Tera timing**: the tera suggestion adds the flip-a-losing-matchup read
    — their hit KOs you, tera makes you survive it ("tera-Grass turns their
    ~107% hit into ~13% — you survive it") — and a revealed-but-unused
    THEIR tera type that would flip your matchup is warned ("their Great
    Tusk can terastallize into Grass: your Wood Hammer drops ~63% → ~16% —
    plan around it"). The tera block moved earlier in the reasoning so it
    survives the 9-line budget.
  - **Item-condition plays**: a revealed Focus Sash on a full-HP target
    eats the KO — the "guaranteed KO" claim is dropped and the note says
    "their Focus Sash survives it (1 HP) — chip it first"; a super-effective
    click into a revealed Weakness Policy prices in the +2 counter ("⚠ Ice
    Beam triggers their Weakness Policy — their Dragonite gets +2 and hits
    for ~101%") unless the move KOs (a faint can't boost). Both reads also
    show inline in the matchup Damage row.
  - **2-turn race projection** (`raceProjection`): hazard + chip + speed
    formalized into a race — when they finish you in ≤2 turns and you can't
    finish them first, the reasoning calls it ("Race check: their Garchomp
    finishes you in ~1 turn at ~46%/turn — you can't outlast it; win this
    turn or switch"). The race uses their full worst-case hidden move and
    names it when it drives the number.
  - **Foul Play** (see Stage 14): `damagePercent` puts the 252-EV attacker
    assumption on the DEFENDER's Atk for Foul Play (that's the stat the move
    runs off), the stat estimator attributes observed Foul Play hits to the
    defender's Atk/Def instead of the attacker's, and the move note says
    "uses their Attack".
  - **Physical/special EV inference** (`inferOffensiveStat`): revealed move
    categories bias the default EV assumption before damage observations
    narrow it — a mostly-physical moveset prices hidden special moves at ~0
    SpA and makes Foul Play hit harder, a mostly-special one prices hidden
    physical moves at ~0 Atk and makes Foul Play hit soft. Mixed or
    single-move sets stay un-inferred.
- **Engine committee** — the move score is an explicit blend of independent
  engines that vote on each move, and the confidence percentage comes from
  how much they AGREE (not raw score share). The weights are real knobs —
  `ENGINE_WEIGHTS` scales each engine's vote into the score (`blend`, calc
  is the anchor) and into the confidence read (`agree`) — and they were
  **tuned against real battles**: `scripts/tune-weights.js` replays a batch
  of real Gen 9 OU logs (`test/fixtures/tune/`) turn-by-turn and compares
  each candidate's top pick against the move the player actually made.
  Across 12 battles the engine matches the player's move 39-49% of the time
  on decisions where the move was already known, and puts the actual move
  in its top-3 74-98% of the time — and no tested configuration beats the
  shipped all-1s blend, so that's what stays. The five engines:
  - **calc** — the damage engine (`@smogon/calc`, Foul Play aware): expected
    damage vs the active + predicted switch-ins, capped at remaining HP. The
    established engine, weighted 3× in the agreement read.
  - **ko** — the KO engine: the risk-mode-aware reward for finishing the
    target (safe prefers the guaranteed roll, aggressive the swing).
  - **speed** — the speed/priority engine: KO-first safety, outspeed risk,
    priority override.
  - **context** — the situational engine: item plays (Weakness Policy / Focus
    Sash), chip-finish, and other per-move context.
  - **response** — the 2-ply engine: their best reply to the move and what
    the resulting position does to us (see the next bullet).
  Each move carries its votes (`bestMove.votes`), and the breakdown is
  visible in BOTH places: the panel's confidence tooltip and a reasoning
  line ("Committee on Fire Blast: calc 62 · KO +10 · speed +8 · context −4
  · response −3 → score 84") so where the score comes from is never a black
  box. A close
  call between two similar moves reads ~55-60% with a "Close call between X
  and Y — either is defensible" note instead of a misleading
  near-coin-flip percentage. `recommend(state, { rankedMoves: true })` also
  exposes the top-3 ranking, which the tuning harness uses to measure
  whether the actual move lands in the engine's top options.
- **Defense-first switch gate** — a switch whose candidate's total exposure
  (revealed best + hidden worst) is meaningfully worse than our current
  mon's AND genuinely threatening (≥40%) no longer gets recommended just
  because it hits back hard: the offense bonus is zeroed unless the switch
  threatens a KO (the KO reward still carries the swing). This is what
  stops the engine from sending in a mon their shown coverage wrecks — the
  bug where a candidate 2×-weak to a revealed move still netted positive
  because its offense masked the weakness. The **forced send-in path** (our
  active faints and we must send someone) applies the same rule absolutely:
  with no current mon to compare against, a candidate whose total exposure
  is genuinely threatening (≥40%) loses its offense credit unless it
  threatens a KO — so the safest send-in wins, and a KO-trade is flagged as
  the deliberate call it is ("only the KO justifies the ~65% it takes").
- **Active-matchup view** — the panel shows your lead vs their lead side by
  side: HP, all five stats (exact for you, estimated ranges for them that
  narrow with learned EVs / hovered Spe), item, and ability, with the
  highlighted **Spe row** and a ⚡ banner stating who acts first (observed
  move order, exact stats, or the honest range overlap).
  **Stat cells are color-coded by who wins them**: green background = the
  side that *definitely* has the higher stat (the ranges don't overlap), and
  the loser is dimmed. When a stat could go either way (our value falls
  inside their range), the cell stays neutral — the coloring only claims
  what's actually certain.
  A **Type row** summarizes who hits whom super effectively: our revealed
  moves that are 2×+ against their current types (tera-aware), and their
  revealed moves that hit us 2×+ — with likely-but-unrevealed options from
  their learnset listed as *"could:"* so you see the threat before they show
  it.
  A **Damage row** shows the predicted hit of each side's best move against
  the other's active (same calc as the recommendations — mean of the roll
  range, with the range in the tooltip). Green tints the side that deals
  more; **red flags a likely OHKO on you** (≥100%). Their strongest
  likely-hidden move appears as *"could: ~80% Headlong Rush"* — the early-
  battle warning before they reveal anything. Every damage figure carries a
  **mini HP-chunk bar**: the fill is the share of HP the hit takes out,
  colored green (small) → amber (mid) → red (large), so you see the size of
  the hit at a glance. The bench cards' takes/deals lines get the same bars.
  **The team cards' HP bars are the same chunk bar**, scaled to current HP:
  fill = remaining HP, colored green (healthy) → amber (mid) → red (sliver)
  on the same 35/70 scale, with a "Current HP: N%" tooltip — one bar
  language across the whole panel.
  **A likely hidden move shows as a dashed segment** on the bar: their known
  hit fills to 66%, and a dashed amber overlay extends to 80% — the range
  the hit could actually land in (tooltip: "could reach ~80% with a hidden
  move"). On the bench cards too (takes 35% → could be 75%), and in the
  expanded full calc as its own row with a fully-dashed bar (dashed =
  unconfirmed until revealed). When the hidden hit's **max roll crosses the
  target's remaining HP**, a tiny red **"would KO"** badge sits over the
  end of the dashed segment (e.g. Headlong Rush maxing at ~86% vs your 7%
  HP) — on the Damage row, the bench takes bars, and the calc's hidden row.
  **The dashed segment is clickable** — it reveals which hidden move it
  represents, as a badge over the segment ("⚠ Headlong Rush ~80%"). The
  reveal stays put across re-renders until you click again.
  **The Damage-row bars are clickable** — they expand a **full damage calc**
  right in the panel: every revealed damaging move on both sides with its
  roll range, effectiveness, and KO chance (plus the likely hidden threat),
  computed by the same calc as everything else. The view stays open across
  re-renders until you click a bar again.
  The reasoning list quotes the **same figures** ("Their Great Tusk hits your
  Raging Bolt for ~66.2% (Earthquake)"): the panel's Damage row and the
  engine's text both come from one shared `matchupDamage` function, so they
  can never disagree. (Against a *predicted* switch-in — their active is
  down — the reasoning skips damage claims, since the target is a guess.)
  **Every switch candidate in the You box** carries the same comparison on
  its card: "vs Great Tusk: takes ~35% (Earthquake) · deals ~32% (Outrage) ·
  could take ~75% (Ice Spinner)" — amber when the incoming hit is 50%+,
  red at a potential OHKO, green when your return hit is 50%+, and immune
  walls show "takes ~0%" instead of "unknown". The active mon and fainted
  mons get no line (the active is covered by the matchup itself).

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

369 tests cover the reader (real 22-turn Gen 9 OU battle + edge cases),
the UI (model, HTML output, escaping, mid-battle and empty states, the
six-slot grid, potential moves, capture status), the engine (type
advantage, KO detection, switch advice, utility moves, calc consistency,
switch prediction, tera, movepool threats, the real fixture, the
positional win-probability eval, the 2-ply response engine), the tooltip
parser (including noisy OCR text), the movepool, the OCR client + offscreen
module, the capture module, the profiles, the storage driver, the settings
module, and the options-page rendering. The demo page is also verified
end-to-end by rendering it in headless Chrome, and the extension itself is
verified end-to-end: a real battle page is loaded with the actual built
extension, and the E2E checks the live panel, profile recording, a
hover-tooltip observation (PP appears in the panel), persistence across a
page reload, the options page, the popup, **real tab capture** (start →
frames increment → stop), **the OCR fallback** (DOM tooltip suppressed,
pixel tooltip read, PP appears in the panel), the live panel toggle,
compact mode, the **item-condition notes in the Damage row** (a fed
matchup with a revealed Focus Sash / Weakness Policy must show the "survives
it" / "triggers +2" warnings inline), and the **engine-votes tooltip**
(the confidence badge's title must carry the calc / KO / speed / context
committee breakdown for the recommended move).

Tests cover a real 22-turn Gen 9 OU battle (`test/fixtures/real-battle.log`,
fetched from Showdown replays) plus hand-crafted edge cases.

### Speed-order awareness

Before recommending a move, the engine compares each side's effective Speed
and factors the outcome into the advice:

- Speed is computed as a **range** (0 → 252 EVs, neutral → speed-boosting
  nature) because the opponent's investment isn't visible. When the ranges
  don't overlap, the engine says who moves first with certainty; overlapping
  ranges are reported honestly as “could go either way.”
- **Your own Speed is exact, not a range** — the live `|request|` carries
  your team's true stats (EVs + nature), and hovering your active Pokémon
  shows them too (raw + an “(After stat modifiers:)” line with boosts,
  paralysis, items, weather, and Tailwind baked in). The engine uses the
  exact value, and the panel renders it as a point (`165`) instead of
  `165-165`.
- **Observed move order beats the guess.** When both sides use a move in the
  same turn, the log's resolution order reveals who is faster. If the moves
  share a priority tier (a priority move like Sucker Punch doesn't count —
  priority, not Speed, decided the order), the engine records it and, until
  anything speed-affecting changes (Speed boosts, paralysis, Choice
  Scarf/Iron Ball, weather, Tailwind, Trick Room, a switch), reports the
  order as observed: “it moved first when you last traded moves.”
- The opponent's hover tooltip shows their **exact Spe range**
  (`Spe 139–186–249–273`), which replaces the engine's generic estimate.
- The reader's known modifiers are applied: **boost stages**, **paralysis**
  (halved), speed items while held — **Choice Scarf** (×1.5), **Iron Ball** /
  **Macho Brace** / **Power items** (×0.5), **Quick Powder** (×2 on an
  untransformed Ditto) — weather-based abilities (Swift Swim in rain,
  Chlorophyll in sun, …), **Tailwind** per side, and **Trick Room** (which
  flips the comparison). **Room Service** needs no special code: its Speed
  drop arrives as a normal −1 Spe boost in the log and flows through the
  boost tracking.
- **Lagging Tail is an ordering rule, not a stat**: the holder moves last
  within its priority bracket no matter how fast it is (and even under Trick
  Room). If exactly one side holds it, the engine says so outright — “Their
  Deoxys-Speed holds Lagging Tail — you move first regardless of Speed.”
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
