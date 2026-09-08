#!/usr/bin/env bash
# Exercise the retry loop in .github/workflows/intraday.yml against a real push
# race, in a throwaway sandbox. Nothing outside $(mktemp -d) is touched.
#
#   ./test/intraday-race.sh
#
# The race it reproduces: EventBridge and GitHub cron fire the same minute, both
# runs write data/<SYM>/intraday/<date>/HHMM.json and rewrite every index.json,
# and the loser's push is rejected. What must NOT happen is the loser staging
# the winner's newly-pushed files as deletions — that is how the first version
# of add-symbol.yml wiped data/AAPL/.
set -euo pipefail

SANDBOX=$(mktemp -d)
echo "沙盒: $SANDBOX"
cd "$SANDBOX"

# Stand in for `INTRADAY=1 node fetch.mjs`: write this minute's snapshot for each
# symbol and rebuild the index from what is on disk, exactly as fetch.mjs does.
cat > fetch.sh <<'FETCH'
#!/usr/bin/env bash
set -eu
who=$1
for sym in AAA BBB; do
  dir="data/$sym/intraday/2026-09-08"
  mkdir -p "$dir"
  printf '{"by":"%s"}\n' "$who" > "$dir/1320.json"
  times=$(ls "$dir" | sed 's/\.json$//' | sort | sed 's/^/"/;s/$/"/' | paste -sd, -)
  printf '{"days":{"2026-09-08":[%s]},"by":"%s"}\n' "$times" "$who" > "data/$sym/intraday/index.json"
done
FETCH
chmod +x fetch.sh

git init -q --bare origin.git

git clone -q origin.git seed
(
  cd seed
  git config user.email seed@test && git config user.name seed
  for sym in AAA BBB; do
    mkdir -p "data/$sym/intraday/2026-09-08"
    echo '{"t":0}' > "data/$sym/intraday/2026-09-08/1305.json"
    echo '{"days":{"2026-09-08":["1305"]}}' > "data/$sym/intraday/index.json"
  done
  git add -A && git commit -qm base && git push -q origin HEAD:master
)

# The loser checks out BEFORE the winner pushes — that is the whole race.
git clone -q origin.git loser
(cd loser && git config user.email loser@test && git config user.name loser)

git clone -q origin.git winner
(
  cd winner
  git config user.email winner@test && git config user.name winner
  ../fetch.sh WINNER
  git add -A && git commit -qm "intraday winner" && git push -q
  # And a concurrent Add symbol lands too: the file that must survive.
  mkdir -p data/CCC/intraday/2026-09-08
  echo '{"new":1}' > data/CCC/intraday/2026-09-08/1320.json
  git add -A && git commit -qm "add symbol CCC" && git push -q
)

echo "=== 输家跑 intraday.yml 的提交循环 ==="
cd loser
../fetch.sh LOSER
pushes=0
for attempt in 1 2 3; do
  git add data
  if git diff --cached --quiet; then
    echo "没有新内容需要提交"
    break
  fi
  git commit -q -m "intraday $attempt"
  if git push -q 2>/dev/null; then
    echo "已推送（第 $attempt 次尝试）"
    pushes=$attempt
    break
  fi
  echo "推送被并发写入抢先（第 $attempt 次），同步到最新后重抓"
  git fetch -q origin master
  git reset -q --hard FETCH_HEAD
  ../fetch.sh LOSER
done

echo
echo "=== 结果 ==="
cd "$SANDBOX"
git clone -q origin.git verify
cd verify
fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1（期望 $3，实际 $2）"; fail=1; fi
}
check "输家最终推送成功（第 2 次尝试）" "$pushes" "2"
check "赢家的 CCC 文件仍在（老坑：不能被当成删除提交）" \
  "$([ -f data/CCC/intraday/2026-09-08/1320.json ] && echo yes || echo no)" "yes"
check "AAA 的 1320 快照存在" \
  "$([ -f data/AAA/intraday/2026-09-08/1320.json ] && echo yes || echo no)" "yes"
check "index.json 同时列出 1305 与 1320" \
  "$(grep -c '"1305","1320"' data/AAA/intraday/index.json)" "1"
check "历史上没有任何文件被删除" \
  "$(git log --diff-filter=D --name-only --pretty=format: | grep -c . || true)" "0"
echo
echo "沙盒保留在 ${SANDBOX}（可自行删除）"
exit $fail
