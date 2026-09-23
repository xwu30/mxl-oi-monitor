// Validate a ticker against CBOE and add it to symbols.json.
// Usage: node add-symbol.mjs NVDA
//        node add-symbol.mjs NVDA --register-only   append only, skip the CBOE check
//
// --register-only serves the retry loop in .github/workflows/add-symbol.yml:
// when two Add symbol runs race, the loser rebuilds symbols.json from whatever
// the winner pushed and re-appends its own ticker. The CBOE check already
// passed on the first pass, so repeating it per retry is a wasted round trip.
//
// The company name is filled in here too. The page shows it under the ticker,
// but nothing used to write it: GOOGL, INTU, NIO and WBD were all registered
// through this script and all four needed full_names patched in by hand
// afterwards. CBOE's payload carries price, IV and volume but no name, so it
// comes from Yahoo's public search endpoint — the same source the original 39
// names came from, no key and no auth.
//
// The lookup runs under --register-only as well, even though that mode exists
// to skip work. It has to: the retry loop does `git checkout FETCH_HEAD --
// symbols.json` before re-appending, which throws away the name the first pass
// just wrote. Re-fetching costs one request on a path that runs at most five
// times and usually zero.
import { readFileSync, writeFileSync } from 'node:fs';

// A-shares carry a Chinese name in `names` instead, which is why 45 symbols
// map to 43 full_names.
const isAShare = s => /\.(SS|SZ)$/.test(s);

async function companyName(sym) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=5&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    if (!res.ok) return null;
    // Match the ticker exactly: a search for NIO also returns NIOBF and similar.
    const hit = ((await res.json()).quotes || [])
      .find(q => String(q.symbol || '').toUpperCase() === sym);
    // shortname comes back truncated on some names ("… Discovery, Inc. -  ").
    return (hit?.longname || hit?.shortname || '').trim() || null;
  } catch {
    // A missing name is cosmetic; never fail a registration over it.
    return null;
  }
}

const args = process.argv.slice(2);
const registerOnly = args.includes('--register-only');
const sym = (args.find(a => !a.startsWith('--')) || '').trim().toUpperCase();
// Digits are allowed because A-share codes are numeric (600703.SS). The old
// pattern required a leading letter, so the two A-shares already monitored
// could never have come through this script — they were hand-written into
// symbols.json, and the next one would have been too.
if (!/^[A-Z0-9][A-Z0-9.]{0,9}$/.test(sym)) {
  console.error(`invalid ticker: "${args[0] ?? ''}"`);
  process.exit(1);
}

let contracts = null;
// A-shares have no listed options, so CBOE 404s on them by definition. Letting
// them past the check is not a loosening: AkShare is their data source, and
// fetch.mjs skips them for the same reason.
if (!registerOnly && !isAShare(sym)) {
  const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) {
    console.error(`${sym}: CBOE returned ${res.status} — 代码不存在或没有期权`);
    process.exit(1);
  }
  const json = await res.json();
  if (!json.data || !Array.isArray(json.data.options) || json.data.options.length === 0) {
    console.error(`${sym}: 该标的没有期权链数据`);
    process.exit(1);
  }
  contracts = json.data.options.length;
}

const cfg = JSON.parse(readFileSync('symbols.json', 'utf8'));
const known = cfg.symbols.includes(sym);

// Backfill the name whether or not the ticker is new, so the symbols already
// registered without one get repaired the next time they come through here.
let named = null;
cfg.full_names ??= {};
if (!isAShare(sym) && !cfg.full_names[sym]) {
  named = await companyName(sym);
  if (named) cfg.full_names[sym] = named;
}

if (known && !named) {
  console.log(`${sym} 已在监控列表中`);
} else {
  if (!known) cfg.symbols.push(sym);
  writeFileSync('symbols.json', JSON.stringify(cfg) + '\n');
  const what = known ? `${sym} 已在列表中，补上公司名` : `added ${sym}`;
  console.log(`${what}${contracts ? ` (${contracts} contracts)` : ''}`
    + `${named ? ` — ${named}` : ''}`
    + `${known ? '' : `; 现监控: ${cfg.symbols.join(', ')}`}`);
  if (!isAShare(sym) && !named && !cfg.full_names[sym]) {
    console.warn(`${sym}: 没查到公司名（雅虎接口），网页上会只显示代码`);
  }
}
