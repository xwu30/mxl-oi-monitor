// Validate a ticker against CBOE and add it to symbols.json.
// Usage: node add-symbol.mjs NVDA
//        node add-symbol.mjs NVDA --register-only   append only, skip the CBOE check
//
// --register-only serves the retry loop in .github/workflows/add-symbol.yml:
// when two Add symbol runs race, the loser rebuilds symbols.json from whatever
// the winner pushed and re-appends its own ticker. The CBOE check already
// passed on the first pass, so repeating it per retry is a wasted round trip.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const registerOnly = args.includes('--register-only');
const sym = (args.find(a => !a.startsWith('--')) || '').trim().toUpperCase();
if (!/^[A-Z][A-Z.]{0,5}$/.test(sym)) {
  console.error(`invalid ticker: "${args[0] ?? ''}"`);
  process.exit(1);
}

let contracts = null;
if (!registerOnly) {
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
if (cfg.symbols.includes(sym)) {
  console.log(`${sym} 已在监控列表中`);
} else {
  cfg.symbols.push(sym);
  writeFileSync('symbols.json', JSON.stringify(cfg) + '\n');
  console.log(`added ${sym}${contracts ? ` (${contracts} contracts)` : ''}; 现监控: ${cfg.symbols.join(', ')}`);
}
