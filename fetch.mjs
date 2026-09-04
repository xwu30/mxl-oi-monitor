// Fetch option chains from CBOE delayed quotes and save snapshots for every
// symbol in symbols.json (SYMBOL env var restricts to one ticker).
//   node fetch.mjs               daily -> data/<SYM>/YYYY-MM-DD.json
//   INTRADAY=1 node fetch.mjs    intraday -> data/<SYM>/intraday/YYYY-MM-DD/HHMM.json
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const INTRADAY = !!process.env.INTRADAY;
const now = new Date();
const date = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const time = now
  .toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
  .replace(':', '');

async function snapshotSymbol(SYMBOL) {
  const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${SYMBOL}.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`CBOE fetch failed: ${res.status}`);
  const json = await res.json();
  const d = json.data;
  if (!d || !Array.isArray(d.options) || d.options.length === 0) {
    throw new Error('CBOE response has no options data');
  }

  // Option code like MXL260821C00040000 -> expiry 2026-08-21, C, strike 40
  const re = new RegExp(`^${SYMBOL.replace('.', '\\.')}(\\d{2})(\\d{2})(\\d{2})([CP])(\\d{8})$`);
  const map = new Map(); // "expiry|strike" -> {c, p, cv, pv}
  for (const o of d.options) {
    const m = re.exec(o.option);
    if (!m) continue;
    const expiry = `20${m[1]}-${m[2]}-${m[3]}`;
    const strike = parseInt(m[5], 10) / 1000;
    const key = `${expiry}|${strike}`;
    if (!map.has(key)) map.set(key, { c: 0, p: 0, cv: 0, pv: 0 });
    const row = map.get(key);
    const oi = Math.round(o.open_interest || 0);
    const vol = Math.round(o.volume || 0);
    if (m[4] === 'C') { row.c = oi; row.cv = vol; } else { row.p = oi; row.pv = vol; }
  }
  if (!map.size) throw new Error('no option rows parsed');

  const options = [...map.entries()]
    .map(([key, v]) => {
      const [expiry, strike] = key.split('|');
      return [expiry, Number(strike), v.c, v.p, v.cv, v.pv];
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);

  const snapshot = {
    symbol: SYMBOL,
    date,
    fetched_at: json.timestamp,
    spot: d.current_price ?? d.close,
    prev_close: d.prev_day_close,
    // 30-day implied volatility, i.e. the price of insurance on this name.
    // CBOE only ever serves today's value, so a day not written down is gone
    // for good — and IV Rank, the one thing you actually trade off (where does
    // today's IV sit in this stock's own 252-day range), needs a year of them.
    // Two floats per symbol per day; the per-contract greeks in the same
    // response are deliberately still dropped, they would multiply file size by
    // thousands and can be re-fetched at any time.
    // iv30_change is absolute, against the prior close; the percent CBOE also
    // reports is exactly derivable from these two, so it is not stored.
    iv30: typeof d.iv30 === 'number' ? d.iv30 : null,
    iv30_change: typeof d.iv30_change === 'number' ? d.iv30_change : null,
    // columns: [expiry, strike, call_oi, put_oi, call_vol, put_vol]
    options,
  };

  const root = `data/${SYMBOL}`;
  if (INTRADAY) {
    const dir = `${root}/intraday/${date}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${time}.json`, JSON.stringify({ ...snapshot, time }));
    console.log(`${SYMBOL}: wrote ${dir}/${time}.json (${options.length} strikes, spot ${snapshot.spot}, iv30 ${snapshot.iv30 ?? 'n/a'})`);

    // Keep only the last 14 calendar days of intraday data.
    const cutoff = new Date(now.getTime() - 14 * 86400_000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    for (const day of readdirSync(`${root}/intraday`)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) {
        rmSync(`${root}/intraday/${day}`, { recursive: true, force: true });
        console.log(`${SYMBOL}: pruned intraday/${day}`);
      }
    }

    // Rebuild intraday index: {days: {"YYYY-MM-DD": ["HHMM", ...]}}
    const days = {};
    for (const day of readdirSync(`${root}/intraday`).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      days[day] = readdirSync(`${root}/intraday/${day}`)
        .filter(f => /^\d{4}\.json$/.test(f))
        .map(f => f.slice(0, 4))
        .sort();
    }
    writeFileSync(`${root}/intraday/index.json`, JSON.stringify({ symbol: SYMBOL, days }));
  } else {
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/${date}.json`, JSON.stringify(snapshot));
    console.log(`${SYMBOL}: wrote ${root}/${date}.json (${options.length} strikes, spot ${snapshot.spot}, iv30 ${snapshot.iv30 ?? 'n/a'})`);

    // Rebuild the date index from files on disk so it self-heals.
    const dates = readdirSync(root)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 10))
      .sort();
    writeFileSync(`${root}/index.json`, JSON.stringify({ symbol: SYMBOL, dates }));
  }
}

const symbols = process.env.SYMBOL
  ? [process.env.SYMBOL.toUpperCase()]
  : JSON.parse(readFileSync('symbols.json', 'utf8')).symbols;

// A-shares (.SS/.SZ) carry an AI analysis but no options chain — CBOE answers
// 403 for them. Skipping keeps the daily log clean instead of failing loudly
// every run for something that will never work.
const isAShare = s => /\.(SS|SZ)$/i.test(s);

let failed = 0;
for (const s of symbols) {
  if (isAShare(s)) { console.log(`${s}: 跳过（A 股无 CBOE 期权链）`); continue; }
  // Intraday runs only make sense for symbols already registered.
  if (INTRADAY && !existsSync(`data/${s}`)) mkdirSync(`data/${s}`, { recursive: true });
  try {
    await snapshotSymbol(s);
  } catch (e) {
    console.error(`${s}: FAILED - ${e.message}`);
    failed++;
  }
}
if (failed && failed === symbols.length) process.exit(1);
