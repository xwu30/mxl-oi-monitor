#!/usr/bin/env bash
# Run an analysis for every symbol that has none yet, publishing each as it lands.
#
#   ./analysis/run-missing.sh              every symbol with no report at all
#   ./analysis/run-missing.sh --dry-run    just list what would run
#   ./analysis/run-missing.sh ORCL MRVL    just these, report or not (re-runs update)
#
# Commits and pushes after each symbol rather than at the end: a run takes ~20
# minutes, so a batch of a dozen is hours long, and a failure partway through
# should not cost the reports that already succeeded.
set -uo pipefail  # deliberately not -e: one bad symbol must not stop the batch

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
cd "$REPO"

DRY=""
args=()
for a in "$@"; do
  if [ "$a" = "--dry-run" ]; then DRY=1; else args+=("$a"); fi
done

if [ ${#args[@]} -gt 0 ]; then
  # Named symbols run even if they already have a report — asking for one by
  # name means you want it refreshed, not skipped.
  missing="${args[*]}"
else
  missing=$(node -e '
const fs = require("fs");
const symbols = JSON.parse(fs.readFileSync("symbols.json", "utf8")).symbols;
const has = s => {
  const dir = `data/${s}/analysis`;
  return fs.existsSync(dir) && fs.readdirSync(dir).some(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
};
console.log(symbols.filter(s => !has(s)).join(" "));
')
fi

if [ -z "$missing" ]; then
  echo "所有标的都已有分析报告"
  exit 0
fi

count=$(echo "$missing" | wc -w | tr -d ' ')
echo "待分析 $count 支：$missing"

if [ -n "$DRY" ]; then exit 0; fi

done_count=0; failed=""
for symbol in $missing; do
  echo "=== [$((done_count + 1))/$count] $symbol $(date '+%H:%M') ==="
  if ! "$HERE/run.sh" "$symbol"; then
    echo "!! $symbol 分析失败，继续下一支"
    failed="$failed $symbol"
    continue
  fi

  # The homepage ladder and the intraday level alerts both read levels.json, so
  # a fresh report without a fresh extraction leaves the site quoting the old
  # report's prices. NBIS sat exactly like that — report moved to 08-28, levels
  # still said 08-14, and nothing surfaced the mismatch. Non-fatal: the report is
  # the valuable artifact and must still be committed if this step fails.
  if ! node "$REPO/extract-levels.mjs" "$symbol"; then
    echo "!! $symbol 价位提取失败，报告照常提交（稍后可单独跑 node extract-levels.mjs $symbol）"
  fi

  git add data
  if git diff --cached --quiet; then
    echo "!! $symbol 没有产出新文件，跳过提交"
    continue
  fi
  git commit -q -m "analysis $symbol $(date +%F)"
  # Rebase first: the daily snapshot job commits to the same branch, and a
  # multi-hour batch will collide with it sooner or later.
  if git pull --rebase -q && git push -q; then
    echo "已推送 $symbol"
  else
    echo "!! $symbol 推送失败，下一支会连同它一起重试"
  fi
  done_count=$((done_count + 1))
done

echo "=== 完成：$done_count/$count 成功${failed:+，失败:$failed} ==="
