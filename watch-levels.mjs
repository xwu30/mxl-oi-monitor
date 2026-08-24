// Compare the live quote against the price levels each AI report called out and
// push a message when one is crossed.
//
//   node watch-levels.mjs             check and push
//   node watch-levels.mjs --dry-run   print what would be sent, touch nothing
//
// Levels come from data/<SYM>/levels.json, written by extract-levels.mjs.
// Quotes come from the intraday snapshots this repo already takes every 15
// minutes, so nothing extra is fetched here.
//
// Fires on a *crossing*, not on "price is above the level". Position alone would
// re-send the same alert every 15 minutes for the rest of the day once a level
// is passed; the moment it happens is what is worth a message.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { send, hasChannel } from './notify.mjs';

const DRY = process.argv.includes('--dry-run');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Two most recent quotes: [previous, latest]. Intraday files are HHMM.json under
// a per-day folder, so a plain sort is chronological. With fewer than two
// snapshots today, the prior daily close stands in as previous — that is what a
// level crossed overnight should be measured against.
function recentQuotes(sym) {
  const dir = `data/${sym}/intraday/${today}`;
  const quotes = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)).sort()) {
      const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      if (typeof j.spot === 'number') quotes.push({ spot: j.spot, at: j.time || f.replace('.json', '') });
    }
  }
  if (quotes.length >= 2) return quotes.slice(-2);

  const idx = `data/${sym}/index.json`;
  if (!existsSync(idx)) return null;
  const dates = (JSON.parse(readFileSync(idx, 'utf8')).dates || []).filter(d => d < today);
  for (let i = dates.length - 1; i >= 0; i--) {
    const f = `data/${sym}/${dates[i]}.json`;
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (typeof j.spot !== 'number') continue;
    const prev = { spot: j.spot, at: dates[i] };
    return quotes.length ? [prev, quotes[0]] : null; // no quote today yet: nothing to compare
  }
  return null;
}

const money = n => (n >= 100 ? n.toFixed(1) : n.toFixed(2));

// One entry per level crossed between prev and now.
function crossings(levels, prev, now) {
  const hits = [];
  const up = lv => prev < lv && now >= lv;     // rose through it
  const down = lv => prev > lv && now <= lv;   // fell through it

  for (const lv of levels.resistance || []) {
    if (up(lv)) hits.push({ key: `resistance@${lv}`, icon: '🔺', text: `涨破阻力位 $${money(lv)}` });
  }
  for (const lv of levels.support || []) {
    if (down(lv)) hits.push({ key: `support@${lv}`, icon: '🔻', text: `跌破支撑位 $${money(lv)}` });
  }
  if (levels.stop_loss != null && down(levels.stop_loss)) {
    hits.push({ key: `stop@${levels.stop_loss}`, icon: '🛑', text: `跌破报告止损位 $${money(levels.stop_loss)}` });
  }
  if (levels.target != null) {
    // A target is directional: above the price it was set at, it is reached by
    // rising; below, by falling.
    const base = levels.spot_at_extract ?? prev;
    const reached = levels.target >= base ? up(levels.target) : down(levels.target);
    if (reached) hits.push({ key: `target@${levels.target}`, icon: '🎯', text: `触及目标价 $${money(levels.target)}` });
  }
  return hits;
}

const symbols = JSON.parse(readFileSync('symbols.json', 'utf8')).symbols;
const blocks = [];

for (const sym of symbols) {
  const lf = `data/${sym}/levels.json`;
  if (!existsSync(lf)) continue;
  const levels = JSON.parse(readFileSync(lf, 'utf8'));

  const q = recentQuotes(sym);
  if (!q) continue;
  const [prev, now] = q;

  const hits = crossings(levels, prev.spot, now.spot);
  if (!hits.length) continue;

  // Dedupe state travels with the data, since CI keeps no memory between runs.
  // A new report re-arms every level: those are different levels now.
  const sf = `data/${sym}/level-alerts.json`;
  let state = { symbol: sym, from_report: levels.from_report, fired: {} };
  if (existsSync(sf)) {
    const saved = JSON.parse(readFileSync(sf, 'utf8'));
    if (saved.from_report === levels.from_report) state = saved;
  }

  const fresh = hits.filter(h => state.fired[h.key] !== today);
  if (!fresh.length) continue;

  for (const h of fresh) state.fired[h.key] = today;
  if (!DRY) writeFileSync(sf, JSON.stringify(state, null, 2) + '\n');

  blocks.push(
    `**${sym}** $${money(prev.spot)} → $${money(now.spot)}\n`
    + fresh.map(h => `- ${h.icon} ${h.text}`).join('\n')
    + `\n- 报告评级 ${levels.rating ?? '—'}（${levels.from_report}）`
  );
}

if (!blocks.length) {
  console.log('无价位穿越，不推送');
  process.exit(0);
}

const text = `📈 价位提醒 ${today}\n\n${blocks.join('\n\n')}\n\n`
  + `价位取自 AI 报告，报告本身未经回测验证，非买卖建议。\nhttps://stock.bananaexpress.ca`;

if (DRY) {
  console.log(text);
  process.exit(0);
}
if (!hasChannel()) {
  console.log('未配置推送渠道，仅打印：\n\n' + text);
  process.exit(0);
}
const res = await send(text, { title: '价位提醒' });
console.log(res && res.ok ? '已推送' : `推送失败 ${res ? res.status : '无渠道'}`);
