// Pull the price levels out of each symbol's latest AI report into a machine
// readable data/<SYM>/levels.json, so watch-levels.mjs can compare them to the
// live quote.
//
//   node extract-levels.mjs              every symbol whose report is newer than its levels.json
//   node extract-levels.mjs CRCL MU      just these
//   node extract-levels.mjs --force      redo even when levels.json is current
//
// Why an LLM call and not a regex: the reports state levels in running Chinese
// prose — "利用$88–92阻力区分批减仓", "$85为硬止损而非买入点", "有效跌破$85则下看
// $78.6（10EMA）、$70.5（布林中轨）". Only "**Price Target**" is a fixed field,
// and 7 of 25 reports omit even that. A regex over free text would quietly
// mis-assign a support as a resistance, which is worse than not alerting.
//
// Runs locally (right after an analysis), not in CI: it needs the LLM key, and
// reports are generated locally anyway. CI only ever reads the JSON it writes.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;

// Minimal .env reader — this repo deliberately has no npm dependencies.
function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v && !process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv(`${HERE}analysis/.env`);

const API_KEY = process.env.OPENAI_API_KEY;
const BASE = (process.env.TRADINGAGENTS_LLM_BACKEND_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL = process.env.TRADINGAGENTS_QUICK_THINK_LLM || 'deepseek-chat';
if (!API_KEY) {
  console.error('缺少 OPENAI_API_KEY（analysis/.env），无法提取价位');
  process.exit(1);
}

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const only = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());

const nowET = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16);
const isReport = f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f);

const latestReport = sym => {
  const dir = `data/${sym}/analysis`;
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(isReport).sort();
  if (!files.length) return null;
  const file = files[files.length - 1];
  return { date: file.replace('.json', ''), report: JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) };
};

// The price the report was written against, not today's. They are the same when
// extraction follows the run (which is how run-missing.sh drives it), but a
// --force back-fill days later would otherwise measure the levels against a
// price that has since moved — and the direction check below would then flip
// correctly-labelled levels. Falls back to the newest snapshot when the report
// date has none (a weekend run, or a symbol added after the report).
const spotOf = (sym, onDate) => {
  const idx = `data/${sym}/index.json`;
  if (!existsSync(idx)) return null;
  const dates = (JSON.parse(readFileSync(idx, 'utf8')).dates || []).slice().sort();
  const upTo = onDate ? dates.filter(d => d <= onDate) : dates;
  for (const list of [upTo, dates]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const f = `data/${sym}/${list[i]}.json`;
      if (existsSync(f)) {
        const v = JSON.parse(readFileSync(f, 'utf8')).spot;
        if (typeof v === 'number') return v;
      }
    }
  }
  return null;
};

// The decision and trader sections carry the levels; the analyst sections are
// long and mostly restate indicators, so sending all of them would cost several
// times as much for no extra levels.
const decisionText = report => {
  const wanted = /最终决策|风控|交易员|研究团队结论/;
  return Object.values(report.sections || {})
    .filter(s => wanted.test(s.title || ''))
    .map(s => `## ${s.title}\n${s.text || ''}`)
    .join('\n\n');
};

const PROMPT = `你是金融文本结构化助手。从下面这份股票分析报告中提取交易价位，只输出 JSON，不要任何解释或 markdown 代码块。

输出格式：
{"support":[数字],"resistance":[数字],"stop_loss":数字或null,"target":数字或null}

规则：
- support = 支撑位 / 买入区间下沿 / 「回落至X企稳」的 X
- resistance = 阻力位 / 压力位 / 减仓区间上沿 / 「冲高回落」的价位
- stop_loss = 明确写作止损、硬止损的价位
- target = 目标价（Price Target）
- 只提取报告中明确写出的数字，不要自己推算或臆测
- 区间如「$88–92阻力区」拆成两个数字都放进 resistance
- 报告没提到的字段填 null，数组没有就填 []
- 所有数字用报告里的原始货币单位，不要换算

报告：
`;

async function extractOne(sym) {
  const latest = latestReport(sym);
  if (!latest) return { sym, skip: '无报告' };

  const out = `data/${sym}/levels.json`;
  if (!FORCE && existsSync(out)) {
    const prev = JSON.parse(readFileSync(out, 'utf8'));
    if (prev.from_report === latest.date) return { sym, skip: `已是最新（${latest.date}）` };
  }

  const text = decisionText(latest.report);
  if (!text.trim()) return { sym, skip: '报告无决策段落' };

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PROMPT + text.slice(0, 8000) }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) return { sym, error: `LLM ${res.status} ${(await res.text()).slice(0, 120)}` };

  const raw = (await res.json())?.choices?.[0]?.message?.content ?? '';
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
  } catch {
    return { sym, error: `LLM 未返回合法 JSON: ${raw.slice(0, 120)}` };
  }

  // Guard against a hallucinated or mis-scaled number quietly becoming an alert
  // that fires on every tick. Anything outside 0.2x-5x of spot is not a level
  // for this stock — it is a percentage, a share count, or another ticker.
  const spot = spotOf(sym, latest.date);
  const sane = n => {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return false;
    return spot ? v >= spot * 0.2 && v <= spot * 5 : true;
  };
  // Reports state the same level twice at slightly different precision
  // ("513 和 513.73", "234 和 234.19") and stack a dozen within a few percent.
  // Each one would be its own alert: AAPL came back with 10 levels inside ±5%
  // of spot, 7 pairs less than 1% apart. Merge a cluster down to the boundary
  // crossed first — lowest resistance on the way up, highest support on the way
  // down — so one price move produces one message.
  const MERGE_PCT = 0.01;
  const cluster = (values, pick) => {
    const sorted = [...new Set((Array.isArray(values) ? values : []).map(Number).filter(sane))]
      .sort((x, y) => x - y);
    const out = [];
    let group = [];
    for (const v of sorted) {
      if (group.length && (v - group[group.length - 1]) / group[group.length - 1] > MERGE_PCT) {
        out.push(pick(group));
        group = [];
      }
      group.push(v);
    }
    if (group.length) out.push(pick(group));
    return out;
  };
  const cleanResistance = a => cluster(a, g => g[0]);
  const cleanSupport = a => cluster(a, g => g[g.length - 1]);

  // Direction came entirely from the model, and it gets it wrong: MDB's report
  // called the 50-day SMA at 367 "当前价格的直接下方支撑" and said to cut on a
  // break of it, yet the extraction filed 367 under resistance while the stock
  // traded at 388. watch-levels.mjs reads these positionally — up through a
  // resistance, down through a support — so a swapped label pushes the opposite
  // signal of what the report meant.
  //
  // Below spot is support and above spot is resistance; that is what the word
  // means and what the alert does with it. Only reclassify past a tolerance,
  // because a report legitimately calls a band straddling the price "阻力区"
  // (AAPL: 310 named as resistance with the stock at 311.31), and rewriting
  // those adds noise without fixing anything.
  const FLIP_PCT = 0.02;
  const fixDirection = (support, resistance) => {
    if (!spot) return { support, resistance, flipped: [] };
    const flipped = [];
    const sup = [], res = [];
    for (const v of resistance) {
      if (v < spot * (1 - FLIP_PCT)) { sup.push(v); flipped.push(`阻力 ${v} → 支撑（低于现价 ${((spot - v) / spot * 100).toFixed(1)}%）`); }
      else res.push(v);
    }
    for (const v of support) {
      if (v > spot * (1 + FLIP_PCT)) { res.push(v); flipped.push(`支撑 ${v} → 阻力（高于现价 ${((v - spot) / spot * 100).toFixed(1)}%）`); }
      else sup.push(v);
    }
    return {
      support: [...new Set(sup)].sort((x, y) => x - y),
      resistance: [...new Set(res)].sort((x, y) => x - y),
      flipped,
    };
  };

  const dropped = [];
  // The model sometimes answers with a list where the schema asks for one number
  // ("target": [131.54, 114.99]). Number([a,b]) is NaN, so the old code threw the
  // whole field away and ORCL silently lost the Price Target its report stated.
  const keep = (label, v) => {
    if (v == null) return null;
    const candidates = (Array.isArray(v) ? v : [v]).map(Number).filter(sane);
    if (!candidates.length) { dropped.push(`${label}=${v}`); return null; }
    if (candidates.length > 1) dropped.push(`${label} 取首个于 [${candidates.join(', ')}]`);
    return candidates[0];
  };
  const proposed = [...(parsed.support || []), ...(parsed.resistance || [])].length;
  const directed = fixDirection(cleanSupport(parsed.support), cleanResistance(parsed.resistance));
  const levels = {
    symbol: sym,
    from_report: latest.date,
    rating: latest.report.decision ?? null,
    spot_at_extract: spot,
    support: directed.support,
    resistance: directed.resistance,
    stop_loss: keep('stop_loss', parsed.stop_loss),
    target: keep('target', parsed.target),
    extracted_at: nowET,
  };
  const kept = levels.support.length + levels.resistance.length;
  if (proposed > kept) dropped.push(`${proposed - kept} 个越界/重复价位`);

  writeFileSync(out, JSON.stringify(levels, null, 2) + '\n');
  return { sym, levels, dropped, flipped: directed.flipped };
}

const symbols = only.length
  ? only
  : JSON.parse(readFileSync('symbols.json', 'utf8')).symbols;

let ok = 0, skipped = 0, failed = 0;
for (const sym of symbols) {
  const r = await extractOne(sym);
  if (r.skip) { console.log(`${sym}: 跳过（${r.skip}）`); skipped++; continue; }
  if (r.error) { console.error(`${sym}: 失败 — ${r.error}`); failed++; continue; }
  const L = r.levels;
  console.log(`${sym}: 支撑 [${L.support.join(', ') || '—'}] 阻力 [${L.resistance.join(', ') || '—'}] `
    + `止损 ${L.stop_loss ?? '—'} 目标 ${L.target ?? '—'}`
    + (r.dropped.length ? `  ⚠ 丢弃 ${r.dropped.join('、')}` : '')
    + (r.flipped.length ? `  ↔ 方向修正 ${r.flipped.join('、')}` : ''));
  ok++;
}
console.log(`\n完成：${ok} 提取，${skipped} 跳过，${failed} 失败`);
if (failed && !ok) process.exit(1);
