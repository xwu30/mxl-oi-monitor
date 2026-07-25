// Validate a ticker against CBOE and add it to symbols.json.
// Usage: node add-symbol.mjs NVDA
import { readFileSync, writeFileSync } from 'node:fs';

const sym = (process.argv[2] || '').trim().toUpperCase();
if (!/^[A-Z][A-Z.]{0,5}$/.test(sym)) {
  console.error(`invalid ticker: "${process.argv[2]}"`);
  process.exit(1);
}

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

const cfg = JSON.parse(readFileSync('symbols.json', 'utf8'));
if (cfg.symbols.includes(sym)) {
  console.log(`${sym} 已在监控列表中`);
} else {
  cfg.symbols.push(sym);
  writeFileSync('symbols.json', JSON.stringify(cfg) + '\n');
  console.log(`added ${sym} (${json.data.options.length} contracts); 现监控: ${cfg.symbols.join(', ')}`);
}
