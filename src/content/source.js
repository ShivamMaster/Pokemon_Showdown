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

export function createBattleSource({ getBattleFn = getBattle } = {}) {
  let seen = 0;
  let lastBattleId = null;

  return {
    // Returns new protocol lines since the last poll, the current battle id,
    // and whether a different battle started (callers should reset the reader).
    poll() {
      const battle = getBattleFn();
      const battleId = getBattleId(battle);
      const reset = lastBattleId !== null && battleId !== null && battleId !== lastBattleId;
      if (reset) seen = 0;
      lastBattleId = battleId;

      if (!battle || !Array.isArray(battle.stepQueue)) {
        return { lines: [], battleId, reset };
      }
      const q = battle.stepQueue;
      if (q.length < seen) seen = 0; // queue was cleared/replaced
      const lines = q.slice(seen);
      seen = q.length;
      return { lines, battleId, reset };
    },

    ourSideId() {
      return ourSideIdFromBattle(getBattleFn());
    },
  };
}
