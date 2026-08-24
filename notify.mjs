// Push a message to whichever channel is configured. Shared by alert.mjs and
// watch-levels.mjs so a channel change is one edit, not two — this repo has
// been bitten before by the same logic living in two files and drifting.
//
// Channel is picked from whichever secret exists:
//   WECOM_WEBHOOK        企业微信群机器人
//   SERVERCHAN_KEY       Server酱（推送到微信）
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   WEBHOOK_URL          其它任意接收端，收到 {"text": "..."}
//
// Returns null when nothing is configured. That is not an error: a repo without
// secrets should still run its workflow to completion.

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

export async function send(text, { title = '提醒' } = {}) {
  if (process.env.WECOM_WEBHOOK) {
    return post(process.env.WECOM_WEBHOOK, { msgtype: 'markdown', markdown: { content: text } });
  }
  if (process.env.SERVERCHAN_KEY) {
    return fetch(`https://sctapi.ftqq.com/${process.env.SERVERCHAN_KEY}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title, desp: text }),
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
  return null;
}

export const hasChannel = () =>
  Boolean(process.env.WECOM_WEBHOOK || process.env.SERVERCHAN_KEY || process.env.WEBHOOK_URL
    || (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID));
