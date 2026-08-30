// Remove a ticker from symbols.json and delete its data directory.
// Usage: node remove-symbol.mjs NVDA
//
// The mirror of add-symbol.mjs, and deliberately re-runnable: the retry loop in
// .github/workflows/remove-symbol.yml rebuilds symbols.json from origin and
// calls this again, so removing something already gone must succeed quietly.
//
// This throws away every snapshot and AI report the symbol ever had. That is
// recoverable only from git history, which is why the workflow prints what it
// deleted before committing.
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';

const sym = (process.argv[2] || '').trim().toUpperCase();
if (!/^[A-Z0-9][A-Z0-9.]{0,9}$/.test(sym)) {
  console.error(`invalid ticker: "${process.argv[2] ?? ''}"`);
  process.exit(1);
}

const cfg = JSON.parse(readFileSync('symbols.json', 'utf8'));
// Refuse to empty the list: the page picks SYMBOLS[0] on load and has nothing
// to render without it.
if (cfg.symbols.length <= 1 && cfg.symbols.includes(sym)) {
  console.error(`${sym} 是最后一个标的，不能删除`);
  process.exit(1);
}

const dir = `data/${sym}`;
if (existsSync(dir)) {
  const days = readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).length;
  const reports = existsSync(`${dir}/analysis`)
    ? readdirSync(`${dir}/analysis`).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).length : 0;
  console.log(`删除 ${dir}/（${days} 天快照，${reports} 份 AI 报告）`);
  rmSync(dir, { recursive: true, force: true });
}

if (!cfg.symbols.includes(sym)) {
  console.log(`${sym} 不在监控列表中`);
} else {
  cfg.symbols = cfg.symbols.filter(s => s !== sym);
  if (cfg.names) delete cfg.names[sym];
  writeFileSync('symbols.json', JSON.stringify(cfg) + '\n');
  console.log(`removed ${sym}; 现监控: ${cfg.symbols.join(', ')}`);
}
