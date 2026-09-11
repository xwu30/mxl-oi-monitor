// US macro releases that actually move equities, from Nasdaq's public economic
// calendar (no key, same endpoint family as fetch-earnings.mjs).
//   node fetch-events.mjs            -> data/events.json
//   DAYS=90 node fetch-events.mjs
//
// The raw feed is ~71 events a day across every country: German HICP, OPEC
// production per member state, 4-week bill auctions, mortgage refinance
// indices. Unfiltered it is noise, so this keeps United States only and only
// the releases on WATCH below.
//
// The API's field is called "gmt" but carries Eastern time: FOMC lands at 14:00
// (2pm ET, when the Fed announces) and PPI at 08:30 (8:30am ET, when BLS
// releases). Treat it as ET and label it that way.
import { writeFileSync } from 'node:fs';

const DAYS = Number(process.env.DAYS || 60);
const ET = 'America/New_York';

// [pattern, tier]. "high" is the set that reprices the whole market on release;
// "mid" moves it on a surprise. Anchored where a loose word would drag in the
// noise — \bPPI\b also catches "PPI ex. Food/Energy/Transport", which is wanted,
// while "Employment" alone would pull in ADP's weekly series.
const WATCH = [
  [/\bcore cpi\b/i, 'high'],
  [/\bcpi\b/i, 'high'],
  [/\bcore ppi\b/i, 'high'],
  [/\bppi\b/i, 'high'],
  [/\bcore pce\b/i, 'high'],
  [/\bpce\b/i, 'high'],
  [/nonfarm payroll/i, 'high'],
  [/\bunemployment rate\b/i, 'high'],
  [/average hourly earnings/i, 'high'],
  [/fed interest rate decision/i, 'high'],
  [/^fomc/i, 'high'],
  [/fed chair|powell/i, 'high'],
  [/\bgdp\b/i, 'high'],
  [/retail sales/i, 'high'],
  [/ism .*(pmi|new orders)/i, 'high'],
  [/adp nonfarm/i, 'mid'],
  [/initial jobless claims/i, 'mid'],
  [/continuing jobless claims/i, 'mid'],
  [/consumer confidence|michigan/i, 'mid'],
  [/durable goods/i, 'mid'],
  [/(existing|new) home sales/i, 'mid'],
  [/building permits|housing starts/i, 'mid'],
];

const tierOf = name => {
  for (const [re, tier] of WATCH) if (re.test(name)) return tier;
  return null;
};

const day = d => d.toLocaleDateString('en-CA', { timeZone: ET });
const clean = s => String(s ?? '').replace(/&nbsp;/gi, '').replace(/<[^>]+>/g, '').trim();

const rows = [];
let days = 0, failed = 0;
const start = new Date();
for (let i = 0; i < DAYS; i++) {
  const d = new Date(start.getTime() + i * 86400_000);
  const date = day(d);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) continue;

  let got;
  try {
    const res = await fetch(`https://api.nasdaq.com/api/calendar/economicevents?date=${date}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    got = (await res.json())?.data?.rows || [];
  } catch (e) {
    console.error(`${date}: 抓取失败 ${e.message}`);
    failed++;
    continue;
  }
  days++;
  for (const r of got) {
    if (r.country !== 'United States') continue;
    const name = clean(r.eventName);
    const tier = tierOf(name);
    if (!tier) continue;
    rows.push([date, clean(r.gmt), name, tier, clean(r.consensus), clean(r.previous)]);
  }
  await new Promise(res => setTimeout(res, 250));
}

// One release, one row. The feed emits a separate record per reading — Core PPI
// arrives twice (month-over-month 0.3% and year-over-year 4.6%), PCE four times
// — without saying which is which, so side by side they look like a duplication
// bug rather than two views of one print. Collapse identical date+time+name and
// keep every figure.
const merged = new Map();
for (const [date, time, name, tier, cons, prev] of rows) {
  const key = `${date}|${time}|${name}`;
  if (!merged.has(key)) merged.set(key, [date, time, name, tier, [], []]);
  const m = merged.get(key);
  if (cons && !m[4].includes(cons)) m[4].push(cons);
  if (prev && !m[5].includes(prev)) m[5].push(prev);
}
const flat = [...merged.values()].map(([d, t, n, tier, c, p]) => [d, t, n, tier, c.join(' / '), p.join(' / ')]);
flat.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
rows.length = 0;
rows.push(...flat);

const out = {
  fetched_at: new Date().toLocaleString('sv-SE', { timeZone: ET }).slice(0, 16),
  from: day(start),
  to: day(new Date(start.getTime() + (DAYS - 1) * 86400_000)),
  trading_days: days,
  timezone: 'America/New_York',
  // columns: [date, time_et, name, tier, consensus, previous]
  cols: ['date', 'time_et', 'name', 'tier', 'consensus', 'previous'],
  rows,
};
writeFileSync('data/events.json', JSON.stringify(out));

const high = rows.filter(r => r[3] === 'high');
console.log(`${days} 个交易日（${out.from} → ${out.to}），${rows.length} 条事件，其中高影响 ${high.length} 条`
  + (failed ? `，${failed} 天抓取失败` : ''));
for (const r of high.slice(0, 20)) {
  console.log(`  ${r[0]} ${r[1].padStart(5)} ET  ${r[2]}${r[4] ? `  预期 ${r[4]}` : ''}`);
}
