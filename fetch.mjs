// Fetch MXL option chain from CBOE delayed quotes and save a daily snapshot.
// Usage: node fetch.mjs   (SYMBOL env var overrides, default MXL)
import { writeFileSync, readdirSync } from 'node:fs';

const SYMBOL = (process.env.SYMBOL || 'MXL').toUpperCase();
const URL = `https://cdn.cboe.com/api/global/delayed_quotes/options/${SYMBOL}.json`;

const res = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
if (!res.ok) throw new Error(`CBOE fetch failed: ${res.status}`);
const json = await res.json();
const d = json.data;
if (!d || !Array.isArray(d.options) || d.options.length === 0) {
  throw new Error('CBOE response has no options data');
}

// Snapshot is dated by the US-market calendar day at fetch time.
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Option code like MXL260821C00040000 -> expiry 2026-08-21, C, strike 40
const re = new RegExp(`^${SYMBOL}(\\d{2})(\\d{2})(\\d{2})([CP])(\\d{8})$`);
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
  // columns: [expiry, strike, call_oi, put_oi, call_vol, put_vol]
  options,
};

const file = `data/${date}.json`;
writeFileSync(file, JSON.stringify(snapshot));
console.log(`wrote ${file}: ${options.length} strikes, spot ${snapshot.spot}`);

// Rebuild the date index from files on disk so it self-heals.
const dates = readdirSync('data')
  .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map(f => f.slice(0, 10))
  .sort();
writeFileSync('data/index.json', JSON.stringify({ symbol: SYMBOL, dates }));
console.log(`index: ${dates.length} snapshot(s)`);
