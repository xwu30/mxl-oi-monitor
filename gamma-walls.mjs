// Computes each day's "gamma wall" from the daily OI snapshot: the strike
// with the largest aggregate open interest, summed across every expiry, on
// each side. Read as a positioning proxy, not a true dealer-gamma number —
// the free CBOE delayed feed carries no per-contract gamma/greeks, so this is
// "where the most contracts are parked", the same heuristic traders mean when
// they say "call wall" / "put wall": a large short-call book tends to get
// hedged by selling the underlying as price approaches it (resistance), a
// large short-put book by buying it (support). Also tracks each day's
// highest-*volume* strike (today's hot money, as distinct from standing OI).
//
//   node gamma-walls.mjs            all symbols in symbols.json
//   SYMBOL=QQQ node gamma-walls.mjs one symbol
//
// Idempotent and incremental: past dates are cached in data/<SYM>/gamma_walls.json
// and never recomputed; only the latest date is always redone (its snapshot
// may have been refetched since the last run) and any date missing from the
// cache (e.g. first run, or a newly backfilled date) is added.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function load(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function wallsForSnapshot(snap) {
  const callOI = new Map(), putOI = new Map(), callVol = new Map(), putVol = new Map();
  for (const [, strike, c, p, cv, pv] of snap.options) {
    callOI.set(strike, (callOI.get(strike) || 0) + c);
    putOI.set(strike, (putOI.get(strike) || 0) + p);
    callVol.set(strike, (callVol.get(strike) || 0) + (cv || 0));
    putVol.set(strike, (putVol.get(strike) || 0) + (pv || 0));
  }
  const top = (map, n) => [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([strike, v]) => ({ strike, v }));
  const [callWall] = top(callOI, 1);
  const [putWall] = top(putOI, 1);
  const [callHot] = top(callVol, 1);
  const [putHot] = top(putVol, 1);
  return {
    date: snap.date,
    spot: snap.spot,
    call_wall: callWall?.strike ?? null,
    call_wall_oi: callWall?.v ?? null,
    put_wall: putWall?.strike ?? null,
    put_wall_oi: putWall?.v ?? null,
    call_hot_strike: callHot?.strike ?? null,
    call_hot_vol: callHot?.v ?? null,
    put_hot_strike: putHot?.strike ?? null,
    put_hot_vol: putHot?.v ?? null,
    top_call_oi: top(callOI, 5),
    top_put_oi: top(putOI, 5),
  };
}

function run(symbol) {
  const root = `data/${symbol}`;
  const idx = load(`${root}/index.json`);
  const dates = idx?.dates || [];
  if (!dates.length) return;

  const outPath = `${root}/gamma_walls.json`;
  const existing = load(outPath) || { symbol, history: [] };
  const have = new Map((existing.history || []).map(h => [h.date, h]));

  const latest = dates[dates.length - 1];
  for (const d of dates) {
    if (have.has(d) && d !== latest) continue;
    const snap = load(`${root}/${d}.json`);
    if (!snap?.options?.length) continue;
    have.set(d, wallsForSnapshot(snap));
  }

  const history = dates.filter(d => have.has(d)).map(d => have.get(d));
  writeFileSync(outPath, JSON.stringify({ symbol, history }) + '\n');
  console.log(`${symbol}: ${history.length} 天 gamma 墙 → ${outPath}`);
}

const only = process.env.SYMBOL;
const symbols = only ? [only.toUpperCase()] : JSON.parse(readFileSync('symbols.json', 'utf8')).symbols;
for (const s of symbols) {
  if (!existsSync(`data/${s}/index.json`)) continue;
  run(s);
}
