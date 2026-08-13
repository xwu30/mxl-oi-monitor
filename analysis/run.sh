#!/usr/bin/env bash
# Entry point for the TradingAgents analysis: ./analysis/run.sh NVDA --depth deep
# Uses the project-local venv so nothing depends on the system Python (3.8, too old).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -x "$HERE/.venv/bin/python" ]; then
  echo "缺少虚拟环境，请先运行：$HERE/setup.sh" >&2
  exit 1
fi
exec "$HERE/.venv/bin/python" "$HERE/analyze.py" "$@"
