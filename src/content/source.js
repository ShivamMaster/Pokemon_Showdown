// src/content/source.js
// Adapter that pulls the raw battle protocol out of the Showdown client.
//
// Verified against a real battle page: the client keeps every protocol line it
// receives in `app.curRoom.battle.stepQueue` (an array of raw strings like
// `|switch|p2a: Dragonite|Dragonite, M|100/100`), and marks our side via
// `battle.mySide`. Both live battles and replay views run through the same
// client code path, so this works for both. We poll for new lines and feed
// them to the BattleReader, which already understands this exact format.

export function getBattle() {
  const app = window.app;
  if (!app) return null;
  return app.curRoom?.battle ?? null;
}

// The live client intercepts `|request|` before it ever reaches the battle
// log (`receiveRequest`), so the reader would never see our own team's
// moves/items/PP. The client keeps the parsed request on the room object —
// read it from there instead.
export function getLiveRequest() {
  const app = typeof window !== 'undefined' ? window.app : null;
  if (!app) return null;
  return app.curRoom?.request ?? null;
}

// The client tracks our side id ('p1'/'p2') on the room (`updateSideLocation`
// sets it from the request's side.id) — more reliable than inferring it from
// names in the log.
export function ourSideIdFromRoom() {
  const app = typeof window !== 'undefined' ? window.app : null;
  const side = app?.curRoom?.side;
  return side === 'p1' || side === 'p2' ? side : null;
}

export function getBattleId(battle) {
  return battle?.id ?? battle?.roomid ?? null;
}

// Which side is ours ('p1' | 'p2'). The client marks it via battle.mySide
// (our Side object); falls back to 'p1' when unknown (e.g. watching replays).
export function ourSideIdFromBattle(battle) {
  const sides = battle?.sides;
  const my = battle?.mySide;
  if (sides && my) {
    const myId = my.id ?? my.sideid ?? my.name;
    for (const side of sides) {
      if (side.id === myId || side.sideid === myId || side.name === myId) {
        if (side.sideid === 'p1' || side.sideid === 'p2') return side.sideid;
      }
    }
  }
  return 'p1';
}

export function createBattleSource({ getBattleFn = getBattle, getRequestFn = getLiveRequest } = {}) {
  let seen = 0;
  let lastBattleId = null;
  let lastRequestJson = null;

  return {
    // Returns new protocol lines since the last poll, the current battle id,
    // and whether a different battle started (callers should reset the reader).
    poll() {
      const battle = getBattleFn();
      const battleId = getBattleId(battle);
      const reset = lastBattleId !== null && battleId !== null && battleId !== lastBattleId;
      if (reset) {
        seen = 0;
        lastRequestJson = null;
      }
      lastBattleId = battleId;

      if (!battle || !Array.isArray(battle.stepQueue)) {
        return { lines: [], battleId, reset, request: null, requestChanged: false };
      }
      const q = battle.stepQueue;
      if (q.length < seen) seen = 0; // queue was cleared/replaced
      const lines = q.slice(seen);
      seen = q.length;

      // The live request never appears in the log — surface it separately.
      const request = getRequestFn();
      const requestJson = request ? JSON.stringify(request) : null;
      const requestChanged = requestJson !== null && requestJson !== lastRequestJson;
      if (requestChanged) lastRequestJson = requestJson;
      return { lines, battleId, reset, request, requestChanged };
    },

    ourSideId() {
      return ourSideIdFromRoom() ?? ourSideIdFromBattle(getBattleFn());
    },
  };
}
