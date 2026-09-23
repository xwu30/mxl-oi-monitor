#!/usr/bin/env bash
# Everything one AI report needs, in the right order, for a single symbol.
#   ./run-report.sh NIO
#   ./run-report.sh 603986.SS --depth deep      extra args go to analysis/run.sh
#
# Why this exists: the monitor page has an "add symbol" button that dispatches
# .github/workflows/add-symbol.yml (index.html), so a ticker can be registered
# on origin and have its data fetched there while this checkout knows nothing
# about it. Registering it again locally then collides — INTU, NIO and WBD each
# cost a rebase conflict in symbols.json (one line, edited on both sides) plus
# an add/add on data/<SYM>/short.json. Syncing before deciding makes the
# duplicate impossible instead of merging it away afterwards.
#
# Not the same job as analysis/run-missing.sh, which batches every symbol that
# has no report yet and publishes each as it lands. This one takes a single
# symbol, sets it up from nothing if need be, and stops short of publishing.
#
# It deliberately does NOT commit or push. Levels have to be read back against
# the report text first: fabricated midpoints (GOOGL's 333.66 was the average
# of two unrelated levels), stop losses the report explicitly rejected (AMZN's
# 249), ratings recorded as the stance the report threw out, and missing
# trigger lines (NIO 4.42, META 652.03) have all come out of runs that looked
# clean from the console. Publish after reading, not in the same breath.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

SYM=$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]')
[ -n "$SYM" ] || { echo "用法: ./run-report.sh <代码> [analysis/run.sh 的参数…]" >&2; exit 1; }
shift

is_ashare() { [[ "$SYM" =~ \.(SS|SZ)$ ]]; }
listed() {
  node -e "process.exit(JSON.parse(require('fs').readFileSync('symbols.json','utf8')).symbols.includes('$SYM')?0:1)"
}

echo "── 1/5 同步远端 ──"
git fetch -q origin master
remote_has=no
if [ -n "$(git status --porcelain)" ]; then
  # Rebasing over uncommitted edits is how you lose them. Read origin's list
  # instead so step 2 still knows whether the page already registered this one.
  echo "工作区有未提交改动，跳过 pull（仍按远端列表判断是否需要注册）"
  remote_has=$(git show origin/master:symbols.json | node -e "
    let s=''; process.stdin.on('data', d => s += d)
      .on('end', () => console.log(JSON.parse(s).symbols.includes('$SYM') ? 'yes' : 'no'));")
elif [ -n "$(git log --oneline HEAD..origin/master)" ]; then
  git pull --rebase -q origin master
  echo "已同步到 $(git rev-parse --short HEAD)"
else
  echo "已是最新"
fi

echo "── 2/5 确认标的已登记 ──"
if listed; then
  # A no-op for a complete entry, but it backfills a missing company name —
  # which is exactly what the page-added tickers arrive without.
  node add-symbol.mjs "$SYM" --register-only
elif [ "$remote_has" = yes ]; then
  echo "$SYM 已登记在远端，但本地没同步到（工作区不干净）。" >&2
  echo "先提交或暂存本地改动再跑，别在这里重复注册——那正是冲突的来源。" >&2
  exit 1
else
  node add-symbol.mjs "$SYM"
fi

echo "── 3/5 抓取行情数据 ──"
if is_ashare; then
  # fetch.mjs and fetch-short.mjs skip these themselves; say why rather than
  # printing two lines of "跳过" with no context.
  echo "$SYM: A 股，无 CBOE 期权链、无 FINRA 空头数据，行情由 AkShare 在分析时直接取"
else
  SYMBOL="$SYM" node fetch.mjs
  # A symbol with no short-interest record still analyses fine; the page shows
  # 等待抓取 until the next daily run picks it up.
  SYMBOL="$SYM" node fetch-short.mjs || echo "$SYM: 空头数据抓取失败，不影响报告"
fi

echo "── 4/5 生成报告 ──"
# Unbuffered: a SIGTRAP in the A-share V8 path once took the whole buffered log
# with it, leaving no clue where it died.
PYTHONUNBUFFERED=1 ./analysis/run.sh "$SYM" "$@"

echo "── 5/5 提取价位 ──"
node extract-levels.mjs "$SYM"

cat <<EOF

下一步（脚本不做，要人看）：
  1. data/$SYM/levels.json 里每个价位，回报告原文查一遍出处
  2. JSON 的 decision 与决策段写的评级是否一致
  3. 都对了再 git add / commit / push
EOF
