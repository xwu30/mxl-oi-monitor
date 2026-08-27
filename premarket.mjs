// Pre-market digest: what the option chains did last session, read against what
// the AI reports say, pushed before the open.
//
//   node premarket.mjs             build and push
//   node premarket.mjs --dry-run   print it instead
//
// Three things this had to get right, each learned by getting it wrong first:
//
// 1. Same-day expiries dominate raw volume and are worthless by the next open.
//    An unfiltered scan put META (41% turnover) and TSLA (28%) at the top purely
//    on 0DTE gamma flow that had already expired. MIN_DTE drops them.
// 2. CBOE delayed quotes carry open interest and volume but no trade direction
//    and no premium. 20k calls trading is equally consistent with someone buying
//    upside and someone selling it. Every line says 换手, never 买入.
// 3. The freshest complete chain before the open is the prior close — the daily
//    snapshot deliberately waits until 11:30am ET for CBOE to purge expired
//    contracts (fetching at 7am inflated total OI by up to 4%). The digest names
//    the session it describes instead of implying it is live.
import { readFileSync, existsSync } from 'node:fs';
import { send, hasChannel } from './notify.mjs';

const DRY = process.argv.includes('--dry-run');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Tuned against the 29-symbol book to surface a handful of lines a day rather
// than a wall of text. Raise them if the push gets noisy — that is the knob.
const MIN_DTE = 1;           // skip contracts expiring today or already expired
const MIN_VOL = 1500;        // absolute contracts at one strike
const MIN_VOL_OI = 1.2;      // volume must exceed standing OI by this much
const SPREAD_TOL = 0.08;     // two legs within 8% volume of each other = a spread
const NEAR_LEVEL_PCT = 0.02; // spot within 2% of a report level is worth saying
const MAX_SYMBOLS = 5;       // symbols per section

// Share-of-book has to scale with tenor. A large-cap book runs into the
// millions of contracts, so MSFT's 14,908-lot Nov spread — a seven-figure
// notional position, and the single most informative thing in that session —
// came to 0.40% of its 3.77M book and fell just outside a flat 0.4% bar, while
// next-day gamma flow cleared it easily. Near-dated volume is plentiful and
// mostly noise; a position three months out is rare and deliberate, so it earns
// a place on a much smaller footprint.
const NEAR_DTE_MAX = 13;     // 1-13 days = this week's / next week's gamma
const SHARE_NEAR = 0.004;
const SHARE_FAR = 0.001;
const shareBar = dte => (dte <= NEAR_DTE_MAX ? SHARE_NEAR : SHARE_FAR);

const num = n => (n >= 1000 ? n.toLocaleString() : String(n));
const money = n => (n >= 100 ? n.toFixed(1) : n.toFixed(2));
const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

const dteOf = expiry =>
  Math.round((new Date(`${expiry}T00:00:00-04:00`) - new Date(`${today}T00:00:00-04:00`)) / 86400_000);

function loadSymbol(sym) {
  const idx = `data/${sym}/index.json`;
  if (!existsSync(idx)) return null;
  const dates = JSON.parse(readFileSync(idx, 'utf8')).dates || [];
  const date = dates[dates.length - 1];
  if (!date) return null;
  const file = `data/${sym}/${date}.json`;
  if (!existsSync(file)) return null;
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof snap.spot !== 'number' || !Array.isArray(snap.options)) return null;

  const lf = `data/${sym}/levels.json`;
  const levels = existsSync(lf) ? JSON.parse(readFileSync(lf, 'utf8')) : null;
  return { sym, date, snap, levels };
}

// columns: [expiry, strike, call_oi, put_oi, call_vol, put_vol]
function analyse({ sym, date, snap, levels }) {
  let callOI = 0, putOI = 0, callVol = 0, putVol = 0, book = 0;
  const candidates = [];
  for (const [expiry, strike, cOI, pOI, cV, pV] of snap.options) {
    callOI += cOI; putOI += pOI; callVol += cV; putVol += pV; book += cOI + pOI;
    if (dteOf(expiry) < MIN_DTE) continue;
    for (const [side, oi, vol] of [['Call', cOI, cV], ['Put', pOI, pV]]) {
      if (vol < MIN_VOL || vol / Math.max(oi, 1) < MIN_VOL_OI) continue;
      candidates.push({ expiry, dte: dteOf(expiry), strike, side, oi, vol,
        away: (strike / snap.spot - 1) * 100 });
    }
  }
  const notable = candidates.filter(s => s.vol / Math.max(book, 1) >= shareBar(s.dte));
  if (!notable.length) return null;

  // Two legs of the same side and expiry trading near-identical size is a
  // vertical spread — a capped directional view, which reads very differently
  // from an outright. MSFT showed 14,908 at $545 against 14,875 at $625;
  // reporting those as two separate bets would have been wrong.
  const spreads = [];
  const used = new Set();
  for (let i = 0; i < notable.length; i++) {
    for (let j = i + 1; j < notable.length; j++) {
      const a = notable[i], b = notable[j];
      if (a.expiry !== b.expiry || a.side !== b.side) continue;
      if (Math.abs(a.vol - b.vol) / Math.max(a.vol, b.vol) > SPREAD_TOL) continue;
      spreads.push({ ...a, low: Math.min(a.strike, b.strike), high: Math.max(a.strike, b.strike) });
      used.add(a); used.add(b);
    }
  }
  const singles = notable.filter(s => !used.has(s)).sort((x, y) => y.vol - x.vol);

  return {
    sym, date, spot: snap.spot,
    chg: snap.prev_close ? (snap.spot / snap.prev_close - 1) * 100 : null,
    pcOI: putOI / Math.max(callOI, 1),
    pcVol: putVol / Math.max(callVol, 1),
    spreads, singles, levels,
    score: notable.reduce((a, s) => a + s.vol / Math.max(book, 1), 0),
  };
}

// A report saying Underweight while the flow piles into upside strikes (or the
// reverse) is the one thing neither source shows on its own.
function divergence(r) {
  if (!r.levels?.rating) return null;
  const all = [...r.spreads, ...r.singles];
  const up = all.filter(s => s.side === 'Call' && s.away > 0).reduce((a, s) => a + s.vol, 0);
  const down = all.filter(s => s.side === 'Put' && s.away < 0).reduce((a, s) => a + s.vol, 0);
  const rating = String(r.levels.rating).toLowerCase();
  if (up > down * 2 && rating.includes('under')) return '换手集中在上方行权价，报告看空';
  if (down > up * 2 && rating.includes('over')) return '换手集中在下方行权价，报告看多';
  return null;
}

function nearLevel(r) {
  if (!r.levels) return null;
  const hits = [];
  for (const lv of r.levels.resistance || []) {
    if (Math.abs(lv - r.spot) / r.spot <= NEAR_LEVEL_PCT) hits.push(`阻力 $${money(lv)}`);
  }
  for (const lv of r.levels.support || []) {
    if (Math.abs(lv - r.spot) / r.spot <= NEAR_LEVEL_PCT) hits.push(`支撑 $${money(lv)}`);
  }
  return hits.length ? hits.join('、') : null;
}

const symbols = JSON.parse(readFileSync('symbols.json', 'utf8')).symbols;
const results = [];
for (const sym of symbols) {
  const loaded = loadSymbol(sym);
  if (!loaded) continue;
  const r = analyse(loaded);
  if (r) results.push(r);
}
results.sort((a, b) => b.score - a.score);

if (!results.length) {
  console.log('期权链无显著异动，不推送');
  process.exit(0);
}

const session = results[0].date;

// Near-dated and longer-dated flow answer different questions — "who is
// positioning for this week" versus "who is positioning for this quarter" — so
// they get their own sections instead of competing on one list, where raw
// weekly volume would always win.
function section(title, keep, note) {
  const rows = results
    .map(r => ({
      ...r,
      spreads: r.spreads.filter(s => keep(s.dte)),
      singles: r.singles.filter(s => keep(s.dte)),
    }))
    .filter(r => r.spreads.length || r.singles.length)
    .map(r => ({ ...r, sub: [...r.spreads, ...r.singles].reduce((a, s) => a + s.vol, 0) }))
    .sort((a, b) => b.sub - a.sub)
    .slice(0, MAX_SYMBOLS);
  if (!rows.length) return '';

  const blocks = rows.map(r => {
    const lines = [];
    for (const s of r.spreads.slice(0, 2)) {
      lines.push(`- ${s.side}价差 $${money(s.low)}/$${money(s.high)} ${s.expiry}（${s.dte}天）`
        + ` 两腿各约 ${num(s.vol)} 张，原持仓 ${num(s.oi)}`);
    }
    for (const s of r.singles.slice(0, 3)) {
      lines.push(`- ${s.side} $${money(s.strike)}（${pct(s.away)}）${s.expiry}（${s.dte}天）`
        + ` 换手 ${num(s.vol)} / 持仓 ${num(s.oi)}`);
    }
    if (r.levels?.rating) {
      lines.push(`- 报告 ${r.levels.rating}`
        + (r.levels.target != null ? ` 目标 $${money(r.levels.target)}` : '')
        + `（${r.levels.from_report}）`);
    }
    const near = nearLevel(r);
    if (near) lines.push(`- 现价贴近${near}`);
    const div = divergence(r);
    if (div) lines.push(`- ⚠️ ${div}`);
    return `**${r.sym}** $${money(r.spot)}`
      + (r.chg != null ? ` ${pct(r.chg)}` : '')
      + ` ｜ P/C 持仓 ${r.pcOI.toFixed(2)} 成交 ${r.pcVol.toFixed(2)}\n`
      + lines.join('\n');
  });
  return `\n\n━━ ${title} ━━\n${note}\n\n` + blocks.join('\n\n');
}

// One desk putting the same trade on across a basket shows up as several
// symbols sharing an expiry, a side, and a strike distance — and a per-symbol
// scan cannot see it. On 2026-08-26 four mega-caps (AMZN $130, MSFT $250,
// META $280, ORCL $75) all traded 2028-01-21 puts inside a 2.3-point band around
// -50%, META's against standing OI of 73. Each line alone reads as an oddity;
// the four together read as a program.
const CLUSTER_MIN_SYMBOLS = 3;
const CLUSTER_MONEYNESS_TOL = 5; // percentage points

function crossSymbol() {
  const groups = new Map();
  for (const r of results) {
    // Near-dated only ever clusters on the obvious: every mega-cap trades
    // at-the-money weeklies, so META/AAPL/TSLA/SNDK all showing up on the same
    // Friday call strike band is the market's default state, not a program.
    // Reporting it would dress up the baseline as a finding.
    for (const s of [...r.spreads, ...r.singles].filter(s => s.dte > NEAR_DTE_MAX)) {
      const key = `${s.expiry}|${s.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...s, sym: r.sym });
    }
  }
  const found = [];
  for (const items of groups.values()) {
    const sorted = [...items].sort((a, b) => a.away - b.away);
    let group = [];
    const flush = () => {
      if (new Set(group.map(g => g.sym)).size >= CLUSTER_MIN_SYMBOLS) found.push(group.slice());
      group = [];
    };
    for (const it of sorted) {
      if (group.length && it.away - group[0].away > CLUSTER_MONEYNESS_TOL) flush();
      group.push(it);
    }
    flush();
  }
  if (!found.length) return '';
  const size = g => g.reduce((x, i) => x + i.vol, 0);
  found.sort((a, b) => size(b) - size(a));

  const blocks = found.slice(0, 2).map(g => {
    const { expiry, side, dte } = g[0];
    const rows = [...g].sort((a, b) => b.vol - a.vol)
      .map(i => `- ${i.sym} $${money(i.strike)}（${pct(i.away)}） 换手 ${num(i.vol)} / 持仓 ${num(i.oi)}`);
    return `**${expiry}（${dte}天）${side} · ${new Set(g.map(i => i.sym)).size} 支标的**\n` + rows.join('\n');
  });
  return '\n\n━━ 跨标的共同形态 ━━\n多支标的在同一到期日、相近价位同时换手\n\n'
    + blocks.join('\n\n');
}

const body =
  crossSymbol()
  + section('中长期布局（14天以上）', d => d > NEAR_DTE_MAX, '罕见、刻意，信息量最高')
  + section('近月异动（1–13天）', d => d <= NEAR_DTE_MAX, '多为周度博弈，隔夜即可能作废');

if (!body.trim()) { console.log('期权链无显著异动，不推送'); process.exit(0); }

const text = `🌅 盘前速览 ${today}\n依据 ${session} 收盘期权链`
  + body
  + `\n\n换手＝成交量/未平仓量。数据只有持仓与成交，**无法区分买卖方向**，`
  + `同一笔换手既可能是买入也可能是卖出。以上为客观异动，非买卖建议。`
  + `\nhttps://stock.bananaexpress.ca`;

if (DRY) { console.log(text); process.exit(0); }
if (!hasChannel()) { console.log('未配置推送渠道，仅打印：\n\n' + text); process.exit(0); }
const res = await send(text, { title: '盘前速览' });
console.log(res && res.ok ? '已推送' : `推送失败 ${res ? res.status : '无渠道'}`);
