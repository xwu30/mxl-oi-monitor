// Upcoming earnings dates for the whole US market, from Nasdaq's public
// calendar (no key, no auth).
//   node fetch-earnings.mjs            -> data/earnings.json
//   DAYS=90 node fetch-earnings.mjs    look further ahead
//
// One request per trading day, because that is the only shape the endpoint has.
// Peak season returns 300+ companies a day, which is unreadable on a page, so
// everything under MIN_CAP is dropped — except the symbols this repo already
// monitors, which are kept whatever their size. That is the whole point of the
// list: your own names in the context of the market's.
import { readFileSync, writeFileSync } from 'node:fs';

const DAYS = Number(process.env.DAYS || 60);
const MIN_CAP = 10e9;
const ET = 'America/New_York';

const watched = new Set(
  JSON.parse(readFileSync('symbols.json', 'utf8')).symbols.map(s => s.toUpperCase()),
);

const day = d => d.toLocaleDateString('en-CA', { timeZone: ET });
const money = s => {
  const n = Number(String(s ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
// "time-pre-market" / "time-after-hours" / "time-not-supplied"
const slot = t => (t === 'time-pre-market' ? 'pre'
  : t === 'time-after-hours' ? 'post' : '');

async function fetchDay(date) {
  const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json?.data?.rows || [];
}

const rows = [];
let days = 0, failed = 0;
const start = new Date();
for (let i = 0; i < DAYS; i++) {
  const d = new Date(start.getTime() + i * 86400_000);
  const date = day(d);
  // Nasdaq returns nothing on weekends; skipping halves the request count.
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) continue;

  let got;
  try {
    got = await fetchDay(date);
  } catch (e) {
    console.error(`${date}: 抓取失败 ${e.message}`);
    failed++;
    continue;
  }
  days++;
  for (const r of got) {
    const sym = String(r.symbol || '').toUpperCase().trim();
    if (!sym) continue;
    const cap = money(r.marketCap);
    const mine = watched.has(sym);
    // Keep every watched name regardless of size; otherwise require MIN_CAP.
    // A missing cap is not a reason to drop a name we follow.
    if (!mine && !(cap !== null && cap >= MIN_CAP)) continue;
    rows.push([
      date, sym, String(r.name || '').trim(), slot(r.time), cap,
      String(r.epsForecast || '').trim(), String(r.fiscalQuarterEnding || '').trim(),
      mine ? 1 : 0,
    ]);
  }
  // Be a polite guest on a free public endpoint.
  await new Promise(res => setTimeout(res, 250));
}

rows.sort((a, b) => a[0].localeCompare(b[0]) || (b[4] || 0) - (a[4] || 0));

const out = {
  fetched_at: new Date().toLocaleString('sv-SE', { timeZone: ET }).slice(0, 16),
  from: day(start),
  to: day(new Date(start.getTime() + (DAYS - 1) * 86400_000)),
  trading_days: days,
  min_market_cap: MIN_CAP,
  // columns: [date, symbol, name, slot, market_cap, eps_forecast, fiscal_quarter, watched]
  cols: ['date', 'symbol', 'name', 'slot', 'market_cap', 'eps_forecast', 'fiscal_quarter', 'watched'],
  rows,
};
writeFileSync('data/earnings.json', JSON.stringify(out));

const mine = rows.filter(r => r[7] === 1);
console.log(`${days} 个交易日（${out.from} → ${out.to}），${rows.length} 场财报，其中关注的 ${mine.length} 场`
  + (failed ? `，${failed} 天抓取失败` : ''));
for (const r of mine) console.log(`  ${r[0]}  ${r[1]}${r[3] ? ' · ' + (r[3] === 'pre' ? '盘前' : '盘后') : ''}`);
