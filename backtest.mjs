// Ask whether the signals this repo collects predict the next day's move.
//
//   node backtest.mjs
//
// Read the caveat before acting on anything printed here: the sample is a few
// hundred symbol-days over a single few-week window, every symbol shares the
// same market regime, and several hypotheses are tested at once — so a lone
// "significant" row is what you would expect from noise. Treat this as a check
// on whether the pipeline is worth continuing, not as evidence a signal works.
// Re-run as months accumulate; that is when the numbers start to mean something.
import { readFileSync } from 'node:fs';

const load = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

function totals(snap) {
  let call = 0, put = 0;
  for (const [, , c, p] of snap.options) { call += c; put += p; }
  return { call, put };
}

// One row per symbol-day where both the prior snapshot (for the change) and the
// next one (for the outcome) exist.
const rows = [];
for (const symbol of JSON.parse(readFileSync('symbols.json', 'utf8')).symbols) {
  const dates = load(`data/${symbol}/index.json`)?.dates || [];
  const shortPct = load(`data/${symbol}/short.json`)?.short_interest?.pct_float ?? null;
  for (let i = 1; i < dates.length - 1; i++) {
    const prev = load(`data/${symbol}/${dates[i - 1]}.json`);
    const cur = load(`data/${symbol}/${dates[i]}.json`);
    const next = load(`data/${symbol}/${dates[i + 1]}.json`);
    if (!prev || !cur || !next || !cur.spot || !next.spot) continue;
    const a = totals(cur), b = totals(prev);
    if (!b.call || !b.put) continue;
    rows.push({
      symbol,
      date: dates[i],
      callChg: ((a.call - b.call) / b.call) * 100,
      putChg: ((a.put - b.put) / b.put) * 100,
      pc: a.put / a.call,
      pcChg: a.put / a.call - b.put / b.call,
      shortPct,
      // Snapshots are taken mid-session, so this is snapshot-to-snapshot,
      // roughly one trading day apart — not a close-to-close return.
      fwd: ((next.spot - cur.spot) / cur.spot) * 100,
    });
  }
}

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

// The window is a one-directional market: the raw average next-day move is
// strongly positive, so testing a group's raw return against zero mostly
// measures the market, not the signal. Subtract each day's cross-sectional
// mean so a group is judged against the other symbols on the same day.
const dayMean = new Map();
for (const r of rows) (dayMean.get(r.date) ?? dayMean.set(r.date, []).get(r.date)).push(r.fwd);
for (const [d, xs] of dayMean) dayMean.set(d, mean(xs));
for (const r of rows) r.excess = r.fwd - dayMean.get(r.date);
// t against zero. With n in the hundreds this is indicative at best; it is here
// to stop a 0.3% mean over 20 observations from looking meaningful.
function stats(xs) {
  const n = xs.length;
  if (n < 2) return { n, mean: 0, t: 0 };
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { n, mean: m, t: sd ? m / (sd / Math.sqrt(n)) : 0 };
}

function report(title, groups) {
  console.log(`\n${title}`);
  console.log('  分组                        n    次日均涨跌   超额收益   跑赢率       t');
  for (const [label, subset] of groups) {
    if (!subset.length) continue;
    const raw = mean(subset.map(r => r.fwd));
    const s = stats(subset.map(r => r.excess)); // t is on excess, not raw
    const beat = (subset.filter(r => r.excess > 0).length / subset.length) * 100;
    console.log('  ' + label.padEnd(24) + String(s.n).padStart(4)
      + `${raw >= 0 ? '+' : ''}${raw.toFixed(2)}%`.padStart(11)
      + `${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(2)}%`.padStart(11)
      + `${beat.toFixed(0)}%`.padStart(9)
      + s.t.toFixed(2).padStart(8));
  }
}

const days = new Set(rows.map(r => r.date)).size;
console.log(`样本：${rows.length} 个「标的-交易日」观测，`
  + `${new Set(rows.map(r => r.symbol)).size} 支标的，${days} 个交易日`);
console.log(`基准：全样本次日均涨跌 ${mean(rows.map(r => r.fwd)).toFixed(2)}%`
  + `（胜率 ${((rows.filter(r => r.fwd > 0).length / rows.length) * 100).toFixed(0)}%）`);

const q = (arr, key, lo, hi) => arr.filter(r => r[key] >= lo && r[key] < hi);

report('信号 1：Call 总 OI 日变化', [
  ['Call OI 跌 >3%', rows.filter(r => r.callChg < -3)],
  ['-3% ~ +3%', q(rows, 'callChg', -3, 3)],
  ['Call OI 涨 3~8%', q(rows, 'callChg', 3, 8)],
  ['Call OI 涨 >8%', rows.filter(r => r.callChg >= 8)],
]);

report('信号 2：Put/Call 水平', [
  ['P/C < 0.7（偏多）', rows.filter(r => r.pc < 0.7)],
  ['0.7 ~ 1.0', q(rows, 'pc', 0.7, 1.0)],
  ['P/C >= 1.0（偏空）', rows.filter(r => r.pc >= 1.0)],
]);

report('信号 3：Put/Call 日变化', [
  ['P/C 下降 <-0.03', rows.filter(r => r.pcChg < -0.03)],
  ['基本持平', q(rows, 'pcChg', -0.03, 0.03)],
  ['P/C 上升 >+0.03', rows.filter(r => r.pcChg >= 0.03)],
]);

const withShort = rows.filter(r => r.shortPct != null);
report(`信号 4：空头占流通股（${withShort.length} 条有数据）`, [
  ['< 3%', withShort.filter(r => r.shortPct < 3)],
  ['3% ~ 10%', q(withShort, 'shortPct', 3, 10)],
  ['10% ~ 25%', q(withShort, 'shortPct', 10, 25)],
  ['>= 25%（拥挤）', withShort.filter(r => r.shortPct >= 25)],
]);

console.log(`\n读法：「超额收益」= 该组次日涨跌减去当日全体标的均值，t 值针对超额收益计算——`
  + `这段窗口整体单边上涨，直接看原始涨跌会把大盘涨幅误当成信号。`
  + `\n|t| < 2 基本等于噪声。样本只覆盖 ${days} 个交易日、同一段行情，`
  + `且一次比较了多个信号，所以即便出现 |t| > 2 也不足以下结论。`
  + `\n每月重跑一次，等样本累积到几百个交易日再谈显著性。`);
