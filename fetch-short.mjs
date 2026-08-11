// Fetch short-interest data for every symbol in symbols.json and save it to
// data/<SYM>/short.json (SYMBOL env var restricts to one ticker).
//
//   node fetch-short.mjs
//
// Sources (all free, no API key):
//   - FINRA   api.finra.org   -> bi-monthly consolidated short interest, the
//                               authoritative publisher; covers every US listing
//   - Nasdaq  api.nasdaq.com  -> same numbers, used only if FINRA is unreachable.
//                               Nasdaq-listed symbols only ("Short interest is only
//                               supported for Nasdaq Listed stocks" for NYSE names)
//   - Yahoo   query1.finance.yahoo.com -> float / shares outstanding, so the
//                               share counts above can be turned into percentages
//
// Utilization (借券利用率) and borrow rate (借券利率) come from securities-lending
// desks (EquiLend / FIS Astec) and have no free public feed — every provider that
// carries them (Ortex, Fintel, S3) is paid. They are written as null with a
// `sources` note so the page can show those tiles as "暂无数据源"; wire a paid feed
// into fetchLending() below and everything downstream starts working.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0';
const now = new Date();
const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const nowET = now.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16);

const num = s => {
  const v = Number(String(s ?? '').replace(/[,%$\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- FINRA: bi-monthly consolidated short interest ----------
// The API rejects sortFields unless the partition key is pinned, so ask for a
// date window and sort locally. ~15 months keeps roughly two dozen periods.
async function fetchFinra(symbol) {
  const start = new Date(now.getTime() - 460 * 86400_000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 30 * 86400_000).toISOString().slice(0, 10);
  let rows;
  try {
    const res = await fetch('https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        limit: 80,
        compareFilters: [{ fieldName: 'symbolCode', fieldValue: symbol, compareType: 'EQUAL' }],
        dateRangeFilters: [{ fieldName: 'settlementDate', startDate: start, endDate: end }],
      }),
    });
    if (!res.ok) return [];
    rows = await res.json();
  } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows
    .map(r => ({
      date: r.settlementDate,
      shares_short: num(r.currentShortPositionQuantity),
      avg_daily_vol: num(r.averageDailyVolumeQuantity),
      days_to_cover: num(r.daysToCoverQuantity),
    }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') && r.shares_short != null)
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest -> newest
}

// ---------- Nasdaq: same history, fallback only ----------
// Rows come back newest-first as {settlementDate: "07/15/2026", interest: "324,052,767", ...}
async function fetchNasdaq(symbol) {
  for (const assetclass of ['stocks', 'etf']) {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/short-interest?assetclass=${assetclass}`;
    let json;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) continue;
      json = await res.json();
    } catch { continue; }
    const rows = json?.data?.shortInterestTable?.rows;
    if (!Array.isArray(rows) || !rows.length) continue;
    const hist = rows
      .map(r => {
        const [mm, dd, yyyy] = String(r.settlementDate || '').split('/');
        if (!yyyy) return null;
        const dtc = num(r.daysToCover);
        return {
          date: `${yyyy}-${mm}-${dd}`,
          shares_short: num(r.interest),
          avg_daily_vol: num(r.avgDailyShareVolume),
          days_to_cover: dtc == null ? null : Number(dtc.toFixed(2)),
        };
      })
      .filter(r => r && r.shares_short != null)
      .sort((a, b) => a.date.localeCompare(b.date)); // oldest -> newest
    if (hist.length) return hist;
  }
  return [];
}

// ---------- Yahoo: float / shares outstanding ----------
// quoteSummary needs a cookie + crumb pair since 2023; fetch it once per run.
let yahooAuth = null;
async function getYahooAuth() {
  if (yahooAuth !== null) return yahooAuth;
  try {
    const res = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    const cookie = raw.filter(Boolean).map(s => s.split(';')[0]).join('; ');
    const crumb = (await (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, cookie },
    })).text()).trim();
    // A crumb is a short opaque token; an HTML error page is not one.
    yahooAuth = cookie && crumb && crumb.length < 32 && !crumb.includes('<') ? { cookie, crumb } : false;
  } catch { yahooAuth = false; }
  if (!yahooAuth) console.error('yahoo: could not obtain crumb — percentages will be missing');
  return yahooAuth;
}

async function fetchYahooStats(symbol) {
  const auth = await getYahooAuth();
  if (!auth) return null;
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + `?modules=defaultKeyStatistics&crumb=${encodeURIComponent(auth.crumb)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, cookie: auth.cookie } });
    if (!res.ok) return null;
    const k = (await res.json())?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!k) return null;
    return {
      float_shares: k.floatShares?.raw ?? null,
      shares_outstanding: k.sharesOutstanding?.raw ?? null,
    };
  } catch { return null; }
}

// ---------- Securities lending: no free feed (see header) ----------
async function fetchLending(_symbol) {
  return { utilization: null, borrow_rate: null, as_of: null, source: null };
}

async function snapshotShort(symbol) {
  let source = 'finra (consolidated, bi-monthly)';
  let history = await fetchFinra(symbol);
  if (!history.length) {
    history = await fetchNasdaq(symbol);
    source = history.length ? 'nasdaq (FINRA bi-monthly)' : null;
  }
  const stats = await fetchYahooStats(symbol);
  const lending = await fetchLending(symbol);
  if (!history.length && !stats) throw new Error('no short-interest data from any source');

  // Percentages are derived from the *current* float, so older rows are an
  // approximation — share counts drift over the year the history covers.
  const float = stats?.float_shares || null;
  const out = stats?.shares_outstanding || null;
  const pct = (n, d) => (n != null && d ? Number((n / d * 100).toFixed(2)) : null);
  for (const h of history) {
    h.pct_float = pct(h.shares_short, float);
    h.pct_out = pct(h.shares_short, out);
  }

  const latest = history[history.length - 1] || null;
  const prev = history[history.length - 2] || null;
  const snapshot = {
    symbol,
    updated_at: nowET,
    date: today,
    float_shares: float,
    shares_outstanding: out,
    short_interest: latest && {
      date: latest.date,
      shares_short: latest.shares_short,
      pct_float: latest.pct_float,
      pct_out: latest.pct_out,
      days_to_cover: latest.days_to_cover,
      avg_daily_vol: latest.avg_daily_vol,
      prev_date: prev?.date ?? null,
      prev_shares_short: prev?.shares_short ?? null,
      prev_pct_float: prev?.pct_float ?? null,
    },
    utilization: lending.utilization,
    borrow_rate: lending.borrow_rate,
    lending_as_of: lending.as_of,
    sources: {
      short_interest: source,
      float: stats ? 'yahoo' : null,
      utilization: lending.source,
      borrow_rate: lending.source,
    },
    history, // oldest -> newest
  };

  const dir = `data/${symbol}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/short.json`, JSON.stringify(snapshot));
  const si = snapshot.short_interest;
  console.log(`${symbol}: wrote ${dir}/short.json (${history.length} periods` +
    (si ? `, latest ${si.date} ${si.pct_float ?? '?'}% of float` : '') + ')');
}

const symbols = process.env.SYMBOL
  ? [process.env.SYMBOL.toUpperCase()]
  : JSON.parse(readFileSync('symbols.json', 'utf8')).symbols;

let failed = 0;
for (const s of symbols) {
  try {
    await snapshotShort(s);
  } catch (e) {
    console.error(`${s}: FAILED - ${e.message}`);
    failed++;
  }
  await sleep(400); // be gentle with the free endpoints
}
// A failing symbol keeps its previous short.json rather than being wiped; only a
// total wipeout is worth failing the workflow over.
if (failed && failed === symbols.length) process.exit(1);
