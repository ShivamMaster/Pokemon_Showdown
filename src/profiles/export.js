// src/profiles/export.js
// Renders the whole profile store as a readable .txt backup — every opponent,
// their learned tendencies, and the per-battle summaries (including the move
// log). The file ends with the raw JSON payload so a future restore flow can
// read it back verbatim.
//
// The options page downloads this; users keep it as a backup (e.g. in the
// repo's exports/ folder, which is gitignored).

const fmtDate = (ts) =>
  ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : '?';

const line = (s = '') => `${s}\n`;

const topEntries = (obj, n) =>
  Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);

function renderProfile(profile) {
  const out = [];
  const rec = profile.record ?? { win: 0, loss: 0, tie: 0 };
  const total = rec.win + rec.loss + rec.tie;
  const battles = profile.battles ?? [];
  const leads = topEntries(profile.commonLeads, 3);
  const usage = Object.entries(profile.moveUsage ?? {})
    .map(([sp, moves]) => `${sp}: ${topEntries(moves, 4).map(([m, n]) => `${m} (${n}×)`).join(', ')}`)
    .slice(0, 6);
  const sets = Object.entries(profile.sets ?? {}).slice(0, 6).map(([sp, s]) => {
    const parts = [...(s.moves ?? [])];
    if (s.item) parts.push(`@ ${s.item}`);
    if (s.ability) parts.push(`[${s.ability}]`);
    return `${sp}: ${parts.join(' / ')}`;
  });
  const situations = (profile.lowHpSwitches ?? 0) + (profile.lowHpFaints ?? 0);

  out.push(line(`Profile: ${profile.opponent}`));
  if (profile.aliases?.length) out.push(line(`  Aliases: ${profile.aliases.join(', ')}`));
  out.push(line(`  Record: ${total ? `${rec.win}-${rec.loss}${rec.tie ? `-${rec.tie}` : ''}` : 'no finished battles'} · Battles: ${profile.totalBattles ?? 0}`));
  if (leads.length) out.push(line(`  Common leads: ${leads.map(([sp, n]) => `${sp} (${n}×)`).join(', ')}`));
  if (situations) {
    out.push(line(`  Low-HP behavior: ${profile.lowHpSwitches ?? 0} voluntary switch-outs, ${profile.lowHpFaints ?? 0} low-HP faints (${Math.round(((profile.lowHpSwitches ?? 0) / situations) * 100)}% pull at low HP)`));
  }
  if (usage.length) out.push(line(`  Move usage: ${usage.join('; ')}`));
  if (sets.length) out.push(line(`  Revealed sets: ${sets.join('; ')}`));
  const last = battles[battles.length - 1];
  if (last) {
    out.push(line(`  Last battle: ${fmtDate(last.date)} · ${last.format ?? '?'}${last.random ? ' (random)' : ''} · ${last.result} · ${last.turns} turns`));
  }

  out.push(line());
  battles
    .slice()
    .reverse()
    .forEach((b, i) => {
      const idx = battles.length - i;
      out.push(line(`  ── Battle ${idx} — ${fmtDate(b.date)} — ${b.format ?? '?'}${b.random ? ' (random)' : ''} — ${b.result?.toUpperCase()} — ${b.turns ?? '?'} turns`));
      if (b.theirLead || b.ourLead) {
        out.push(line(`     Leads: theirs ${b.theirLead ?? '?'} · yours ${b.ourLead ?? '?'}`));
      }
      if (b.lowHpSwitches || b.lowHpFaints) {
        out.push(line(`     Low-HP: ${b.lowHpSwitches ?? 0} switch-outs, ${b.lowHpFaints ?? 0} faints`));
      }
      for (const l of b.log ?? []) out.push(line(`     ${l}`));
      out.push(line());
    });
  return out.join('');
}

// Full backup text: readable profiles + a JSON payload for restore.
export function exportProfilesText(profiles) {
  const out = [];
  out.push(line('════════════════════════════════════════════════════════════'));
  out.push(line('SHOWDOWN BATTLE ASSISTANT — PROFILE BACKUP'));
  out.push(line(`Exported: ${fmtDate(Date.now())}`));
  out.push(line(`Profiles: ${Object.keys(profiles ?? {}).length}`));
  out.push(line('════════════════════════════════════════════════════════════'));
  out.push(line());

  const entries = Object.values(profiles ?? {}).sort(
    (a, b) => (b?.totalBattles ?? 0) - (a?.totalBattles ?? 0)
  );
  if (!entries.length) out.push(line('No profiles yet — play a few battles and they will appear.'));
  for (const p of entries) {
    out.push(line('════════════════════════════════════════════════════════════'));
    out.push(renderProfile(p));
  }

  out.push(line('════════════════════════════════════════════════════════════'));
  out.push(line('RAW JSON (keep this section for restoring the backup):'));
  out.push(line(''));
  out.push(JSON.stringify(profiles ?? {}, null, 2));
  return out.join('');
}
