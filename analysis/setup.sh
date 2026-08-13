#!/usr/bin/env bash
# Install (or reinstall / upgrade) TradingAgents into analysis/.venv.
# Safe to re-run; uv resolves and installs into the same project-local venv.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if ! command -v uv >/dev/null; then
  echo "需要 uv：curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

# TradingAgents needs Python >= 3.10; the system python3 here is 3.8, so let uv
# fetch its own interpreter rather than depending on whatever is installed.
uv venv --python 3.12
uv pip install --python .venv \
  "tradingagents @ git+https://github.com/TauricResearch/TradingAgents.git"

[ -f .env ] || { cp .env.example .env; echo "已生成 analysis/.env —— 填入 API key 后即可运行"; }
echo "完成。用法：./analysis/run.sh NVDA"
