// Scan the latest snapshots for things worth a human glance and push them.
//
//   node alert.mjs              send to whichever channel is configured
//   node alert.mjs --dry-run    print the message instead of sending
//
// These are *factual anomalies*, not trade signals: an OI build at one strike,
// a short-interest settlement, a changed AI verdict. Nothing here has been
// shown to predict returns (see backtest.mjs), so the wording stays
// descriptive — "worth a look", never "buy".
//
// Channel is picked from whichever secret exists, so switching providers is a
// secret change rather than a code change:
//   WECOM_WEBHOOK        企业微信群机器人
//   SERVERCHAN_KEY       Server酱（推送到微信）
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   WEBHOOK_URL          其它任意接收端，收到 {"text": "..."}
import { readFileSync, existsSync, readdirSync } from 'node:fs';

// Tuned to fire on a handful of symbols a day, not on every symbol every day.
// Raise these if the push gets noisy — that is the whole maintenance knob.
const PRICE_MOVE_PCT = 5;      // |spot vs prior snapshot|
const TOTAL_OI_PCT = 12;       // total call or put OI, day over day
const STRIKE_MIN_DELTA = 3000; // contracts at one strike…
const STRIKE_MIN_PCT = 40;     // …and this much of what was already there…
const STRIKE_MIN_SHARE = 2;    // …and this much of the symbol's own total OI.
// That last one is what keeps the push readable: 20k contracts is a real event
// on a small name and rounding error against NVDA's 3.9M, so an absolute floor
// alone fires on nearly every large-cap every day.
const SHORT_MOVE_PP = 2;       // percentage points between settlements

const DRY = process.argv.includes('--dry-run');
const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : 0);
const fmt = n => n.toLocaleString('en-US');
const sign = n => (n > 0 ? '+' : '');

function load(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Totals plus a per-strike map, so a build-up at one strike is visible even
// when the totals barely move.
function digest(snap) {
  let call = 0, put = 0;
  const strikes = new Map();
  for (const [exp, strike, c, p] of snap.options) {
    call += c; put += p;
    const key = `${exp}|${strike}`;
    const row = strikes.get(key) || { c: 0, p: 0 };
    row.c += c; row.p += p;
    strikes.set(key, row);
  }
  return { call, put, strikes };
}

function checkSymbol(symbol) {
  const root = `data/${symbol}`;
  const dates = load(`${root}/index.json`)?.dates || [];
  const notes = [];

  if (dates.length >= 2) {
    const cur = load(`${root}/${dates[dates.length - 1]}.json`);
    const prev = load(`${root}/${dates[dates.length - 2]}.json`);
    if (cur && prev) {
      const a = digest(cur), b = digest(prev);

      const move = pct(cur.spot, prev.spot);
      if (Math.abs(move) >= PRICE_MOVE_PCT) {
        notes.push(`价格 ${sign(move)}${move.toFixed(1)}% → $${cur.spot}`);
      }

      for (const [label, now, was] of [['Call', a.call, b.call], ['Put', a.put, b.put]]) {
        const d = pct(now, was);
        if (Math.abs(d) >= TOTAL_OI_PCT) {
          notes.push(`${label} 总 OI ${sign(d)}${d.toFixed(0)}%（${fmt(was)} → ${fmt(now)}）`);
        }
      }

      // Put/Call crossing 1.0 flips the book between defensive and directional.
      const nowPC = a.put / (a.call || 1), wasPC = b.put / (b.call || 1);
      if ((nowPC - 1) * (wasPC - 1) < 0) {
        notes.push(`Put/Call 穿越 1.0（${wasPC.toFixed(2)} → ${nowPC.toFixed(2)}）`);
      }

      const builds = [];
      for (const [key, now2] of a.strikes) {
        const old = b.strikes.get(key) || { c: 0, p: 0 };
        for (const [side, k] of [['Call', 'c'], ['Put', 'p']]) {
          const delta = now2[k] - old[k];
          const base = old[k] || 1;
          const total = (k === 'c' ? a.call : a.put) || 1;
          if (Math.abs(delta) >= STRIKE_MIN_DELTA
            && Math.abs(delta / base) * 100 >= STRIKE_MIN_PCT
            && Math.abs(delta / total) * 100 >= STRIKE_MIN_SHARE) {
            const [exp, strike] = key.split('|');
            builds.push({ delta, text: `${side} $${strike}（${exp}）${sign(delta)}${fmt(delta)}` });
          }
        }
      }
      builds.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
      for (const item of builds.slice(0, 3)) notes.push(`行权价异动：${item.text}`);
    }
  }

  // Short interest lands twice a month; report the settlement, not every run.
  const short = load(`${root}/short.json`);
  const hist = short?.history || [];
  if (hist.length >= 2) {
    const [prev, cur] = hist.slice(-2);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const move = (cur.pct_float ?? 0) - (prev.pct_float ?? 0);
    if (short.date === today && Math.abs(move) >= SHORT_MOVE_PP) {
      notes.push(`空头占流通股 ${prev.pct_float}% → ${cur.pct_float}%（结算日 ${cur.date}）`);
    }
  }

  // A flipped verdict matters more than the verdict itself.
  const adir = `${root}/analysis`;
  if (existsSync(adir)) {
    const reports = readdirSync(adir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    if (reports.length >= 2) {
      const cur = load(`${adir}/${reports[reports.length - 1]}`);
      const prev = load(`${adir}/${reports[reports.length - 2]}`);
      if (cur?.decision && prev?.decision && cur.decision !== prev.decision) {
        notes.push(`AI 决策变化：${prev.decision} → ${cur.decision}`);
      }
    }
  }

  return notes;
}

// ---------- delivery ----------
async function send(text) {
  const post = (url, body, headers = {}) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  if (process.env.WECOM_WEBHOOK) {
    return post(process.env.WECOM_WEBHOOK, { msgtype: 'markdown', markdown: { content: text } });
  }
  if (process.env.SERVERCHAN_KEY) {
    return fetch(`https://sctapi.ftqq.com/${process.env.SERVERCHAN_KEY}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: '持仓异动提醒', desp: text }),
    });
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    // Telegram's legacy Markdown marks bold with a single asterisk; sending the
    // standard **bold** the other channels use fails to parse outright.
    return post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: text.replace(/\*\*(.+?)\*\*/g, '*$1*'),
      parse_mode: 'Markdown',
    });
  }
  if (process.env.WEBHOOK_URL) return post(process.env.WEBHOOK_URL, { text });
  return null; // no channel picked yet — not an error, see below
}

const symbols = JSON.parse(readFileSync('symbols.json', 'utf8')).symbols;
const blocks = [];
for (const s of symbols) {
  const notes = checkSymbol(s);
  if (notes.length) blocks.push(`**${s}**\n` + notes.map(n => `- ${n}`).join('\n'));
}

if (!blocks.length) {
  console.log('无异动，不推送');
  process.exit(0);
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const text = `📊 持仓异动 ${today}\n\n${blocks.join('\n\n')}\n\n`
  + `以上为客观数据异动，非买卖建议。\nhttps://stock.bananaexpress.ca`;

if (DRY) {
  console.log(text);
} else {
  const res = await send(text);
  if (!res) {
    // Nothing configured is a legitimate state — the daily job shouldn't go red
    // just because no channel has been chosen yet.
    console.log(`未配置推送渠道，跳过（本可推送 ${blocks.length} 支标的的异动）`);
    console.log(text);
    process.exit(0);
  }
  console.log(`已推送 ${blocks.length} 支标的的异动 (HTTP ${res.status})`);
  // A configured channel that fails must fail the step — a silent 4xx would
  // leave the notification quietly dead while the workflow reports success.
  if (!res.ok) {
    console.error(await res.text().catch(() => ''));
    process.exit(1);
  }
}
