#!/usr/bin/env python
"""Run TradingAgents on the symbols this repo already monitors.

    ./analysis/run.sh NVDA               # one symbol, today
    ./analysis/run.sh --all              # every symbol in symbols.json
    ./analysis/run.sh MXL --date 2026-08-11 --depth deep

Two outputs per run:
  - data/<SYM>/analysis/<trade-date>.json  compact, committed, rendered by index.html
  - analysis/reports/<SYM>_<stamp>/        TradingAgents' own markdown tree (gitignored)

The OI and short-interest series this repo collects are not something
TradingAgents can fetch, so they are summarised and injected into the run as
past-context — the portfolio manager sees them alongside its own research.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
load_dotenv(HERE / ".env")

# Provider defaults, picked from whichever key is present so a fresh .env with a
# single key just works. Explicit TRADINGAGENTS_* env vars still win (they are
# applied by DEFAULT_CONFIG itself).
PROVIDER_BY_KEY = [
    ("ANTHROPIC_API_KEY", "anthropic", "claude-opus-5", "claude-sonnet-5"),
    ("OPENAI_API_KEY", "openai", "gpt-5.5", "gpt-5.4-mini"),
    ("GOOGLE_API_KEY", "google", "gemini-3-pro", "gemini-3-flash"),
    ("GEMINI_API_KEY", "google", "gemini-3-pro", "gemini-3-flash"),
]

# depth -> (analysts, debate rounds, risk rounds). More rounds = deeper
# argument between the bull/bear and risk agents, and a bigger bill.
DEPTHS = {
    "quick": (["market", "fundamentals"], 1, 1),
    "standard": (["market", "social", "news", "fundamentals"], 1, 1),
    "deep": (["market", "social", "news", "fundamentals"], 3, 2),
}

# USD per 1M tokens (input, output), from each vendor's public rate card as of
# 2026-08. Used only to price a finished run — update here when rates move.
# The graph runs 12 of its 14 nodes on quick_think_llm and only 2 (research
# manager, portfolio manager) on deep_think_llm, so the quick model dominates
# the bill while the deep model is nearly free to upgrade.
PRICES = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "gpt-5.5": (5.0, 30.0),
    "gpt-5.4-mini": (0.375, 2.25),
    "gpt-5.4": (2.5, 15.0),
    "gemini-3-pro": (2.0, 12.0),
    "gemini-3-flash": (1.5, 7.5),
    "deepseek-v4-pro": (0.435, 0.87),
    "deepseek-v4-flash": (0.14, 0.28),
}


def price_of(model: str):
    """Longest-prefix match so dated or suffixed model ids still price."""
    hit = [k for k in PRICES if model.startswith(k)]
    return PRICES[max(hit, key=len)] if hit else None


class UsageTracker:
    """Count tokens per model across a run, so cost is measured, not guessed.

    Duck-typed rather than subclassing BaseCallbackHandler: LangChain only calls
    the hooks it finds, and this keeps the import out of module scope.
    """

    raise_error = False
    ignore_llm = ignore_chain = ignore_agent = ignore_retriever = ignore_chat_model = False

    def __init__(self):
        self.by_model: dict[str, dict[str, int]] = {}
        self.calls = 0

    def __getattr__(self, name):  # ignore every hook we don't implement
        if name.startswith("on_"):
            return lambda *a, **k: None
        raise AttributeError(name)

    def on_llm_end(self, response, **_):
        self.calls += 1
        for generations in getattr(response, "generations", []):
            for gen in generations:
                message = getattr(gen, "message", None)
                usage = getattr(message, "usage_metadata", None) or {}
                meta = getattr(message, "response_metadata", None) or {}
                model = meta.get("model_name") or meta.get("model") or "unknown"
                if not usage:
                    # Providers that only fill llm_output (older OpenAI shapes).
                    out = getattr(response, "llm_output", None) or {}
                    raw = out.get("token_usage") or {}
                    usage = {
                        "input_tokens": raw.get("prompt_tokens", 0),
                        "output_tokens": raw.get("completion_tokens", 0),
                    }
                    model = out.get("model_name", model)
                bucket = self.by_model.setdefault(model, {"input_tokens": 0, "output_tokens": 0})
                bucket["input_tokens"] += usage.get("input_tokens", 0) or 0
                bucket["output_tokens"] += usage.get("output_tokens", 0) or 0

    def summary(self) -> dict:
        cost, priced = 0.0, bool(self.by_model)
        for model, b in self.by_model.items():
            rate = price_of(model)
            if rate is None:
                priced = False  # don't report a number that omits a model
                continue
            cost += b["input_tokens"] / 1e6 * rate[0] + b["output_tokens"] / 1e6 * rate[1]
        return {
            "llm_calls": self.calls,
            "input_tokens": sum(b["input_tokens"] for b in self.by_model.values()),
            "output_tokens": sum(b["output_tokens"] for b in self.by_model.values()),
            "cost_usd": round(cost, 4) if priced else None,
            "by_model": self.by_model,
        }


SECTION_TITLES = [
    ("market_report", "market", "市场与技术面分析"),
    ("sentiment_report", "sentiment", "社交情绪分析"),
    ("news_report", "news", "新闻与宏观分析"),
    ("fundamentals_report", "fundamentals", "基本面分析"),
    ("investment_plan", "research", "研究团队结论（多空辩论后）"),
    ("trader_investment_plan", "trader", "交易员方案"),
    ("final_trade_decision", "decision", "风控委员会最终决策"),
]


def resolve_provider() -> tuple[str, str, str]:
    """Return (provider, deep_model, quick_model) from env, or exit with guidance."""
    provider = os.getenv("TRADINGAGENTS_LLM_PROVIDER")
    if provider:
        return provider, os.getenv("TRADINGAGENTS_DEEP_THINK_LLM", ""), os.getenv("TRADINGAGENTS_QUICK_THINK_LLM", "")
    for env_key, prov, deep, quick in PROVIDER_BY_KEY:
        if os.getenv(env_key):
            return prov, deep, quick
    sys.exit(
        "找不到任何 LLM API key。请在 analysis/.env 里填一个（照抄 .env.example）：\n"
        "  ANTHROPIC_API_KEY=sk-ant-...   # 或 OPENAI_API_KEY / GOOGLE_API_KEY\n"
    )


# ---------- local context: this repo's own data ----------
def _load(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def build_local_context(symbol: str) -> str:
    """Summarise this repo's OI + short-interest series as a markdown block.

    Returns "" when the symbol has no local data yet, so the run degrades to
    plain TradingAgents rather than injecting an empty section.
    """
    root = REPO / "data" / symbol
    lines: list[str] = []

    index = _load(root / "index.json")
    dates = (index or {}).get("dates") or []
    cur = _load(root / f"{dates[-1]}.json") if dates else None
    prev = _load(root / f"{dates[-2]}.json") if len(dates) > 1 else None

    def totals(snap):
        return sum(o[2] for o in snap["options"]), sum(o[3] for o in snap["options"])

    if cur:
        c, p = totals(cur)
        lines.append(f"### 期权未平仓量（OI），来源 CBOE，快照日 {dates[-1]}")
        lines.append(f"- 正股价 ${cur.get('spot')}，前收 ${cur.get('prev_close')}")
        if c:
            lines.append(f"- Call OI 合计 {c:,}；Put OI 合计 {p:,}；Put/Call = {p / c:.2f}")
        if prev:
            pc, pp = totals(prev)
            if pc:
                lines.append(
                    f"- 相对 {dates[-2]}：Call OI {c - pc:+,}，Put OI {p - pp:+,}"
                    f"（前一快照 Put/Call = {pp / pc:.2f}）"
                )
            # Strikes with the largest OI build-up carry the most information
            # about where dealers and speculators are positioned.
            before = {(o[0], o[1]): (o[2], o[3]) for o in prev["options"]}
            moves = []
            for exp, strike, call_oi, put_oi, *_ in cur["options"]:
                b_c, b_p = before.get((exp, strike), (0, 0))
                moves.append((call_oi - b_c, "Call", exp, strike))
                moves.append((put_oi - b_p, "Put", exp, strike))
            moves.sort(key=lambda m: abs(m[0]), reverse=True)
            top = [m for m in moves if m[0]][:6]
            if top:
                lines.append("- 变化最大的行权价：" + "；".join(
                    f"{side} ${strike} 到期 {exp} {delta:+,}" for delta, side, exp, strike in top
                ))

    short = _load(root / "short.json")
    si = (short or {}).get("short_interest")
    if si:
        lines.append(f"### 空头持仓（FINRA，结算日 {si['date']}）")
        lines.append(
            f"- 占流通股 {si.get('pct_float')}%（上期 {si.get('prev_pct_float')}%，结算日 {si.get('prev_date')}）"
        )
        shares = si.get("shares_short")
        lines.append(
            f"- 空头股数 {shares:,}；回补天数 {si.get('days_to_cover')}" if shares
            else f"- 回补天数 {si.get('days_to_cover')}"
        )

    if not lines:
        return ""
    return (
        "\n\n## 本地监控数据（由 mxl-oi-monitor 提供，非 TradingAgents 抓取）\n"
        "以下期权持仓与空头数据由本地系统每日采集，请在判断资金定位与逼空风险时一并考虑。\n"
        + "\n".join(lines)
        + "\n"
    )


# ---------- run ----------
def run_symbol(symbol: str, trade_date: str, depth: str, use_local: bool) -> dict:
    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    provider, deep_model, quick_model = resolve_provider()
    analysts, debate_rounds, risk_rounds = DEPTHS[depth]

    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = provider
    if deep_model:
        config["deep_think_llm"] = deep_model
    if quick_model:
        config["quick_think_llm"] = quick_model
    config["max_debate_rounds"] = debate_rounds
    config["max_risk_discuss_rounds"] = risk_rounds
    config["output_language"] = os.getenv("TRADINGAGENTS_OUTPUT_LANGUAGE", "Chinese")
    config["results_dir"] = str(HERE / "reports")
    # yfinance's news endpoint returns nothing as of 2026-08; Alpha Vantage's
    # free tier fills that gap when a key is present, otherwise the news and
    # sentiment analysts run thin.
    if os.getenv("ALPHA_VANTAGE_API_KEY"):
        config["data_vendors"] = {**config["data_vendors"], "news_data": "alpha_vantage"}

    tracker = UsageTracker()
    ta = TradingAgentsGraph(selected_analysts=analysts, debug=False, config=config,
                            callbacks=[tracker])

    local = build_local_context(symbol) if use_local else ""
    if local:
        # Supported seam: past_context is injected into the manager prompts at
        # run start. Append rather than replace so the framework's own memory
        # log (lessons from previous runs) survives.
        original = ta.memory_log.get_past_context

        def with_local(ticker, *args, **kwargs):
            return (original(ticker, *args, **kwargs) or "") + local

        ta.memory_log.get_past_context = with_local

    print(f"[{symbol}] 分析中… provider={provider} deep={config['deep_think_llm']} "
          f"analysts={','.join(analysts)} 辩论轮次={debate_rounds}")
    final_state, decision = ta.propagate(symbol, trade_date)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_dir = HERE / "reports" / f"{symbol}_{trade_date}_{stamp}"
    ta.save_reports(final_state, symbol, save_path=report_dir)

    sections = [
        {"key": key, "title": title, "text": final_state[state_key]}
        for state_key, key, title in SECTION_TITLES
        if final_state.get(state_key)
    ]
    debate = final_state.get("investment_debate_state") or {}
    extra = [
        {"key": key, "title": title, "text": debate[hist_key]}
        for hist_key, key, title in (("bull_history", "bull", "多头研究员"),
                                     ("bear_history", "bear", "空头研究员"))
        if debate.get(hist_key)
    ]
    if extra:
        # Slot the debate transcripts in front of the research conclusion so the
        # report reads in the order the agents actually argued.
        at = next((i for i, s in enumerate(sections) if s["key"] == "research"), len(sections))
        sections[at:at] = extra

    return {
        "symbol": symbol,
        "trade_date": trade_date,
        "generated_at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
        "decision": decision,
        "depth": depth,
        "analysts": analysts,
        "models": {"provider": provider, "deep": config["deep_think_llm"], "quick": config["quick_think_llm"]},
        "local_context": local,
        "usage": tracker.summary(),
        "report_dir": str(report_dir.relative_to(REPO)),
        "sections": sections,
    }


def write_web_report(result: dict) -> Path:
    out_dir = REPO / "data" / result["symbol"] / "analysis"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{result['trade_date']}.json"
    path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

    # Rebuild the index from disk so it self-heals, matching fetch.mjs.
    dates = sorted(p.stem for p in out_dir.glob("*.json") if p.stem != "index")
    (out_dir / "index.json").write_text(
        json.dumps({"symbol": result["symbol"], "dates": dates}, ensure_ascii=False), encoding="utf-8"
    )
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description="用 TradingAgents 分析本仓库监控的股票")
    ap.add_argument("symbols", nargs="*", help="股票代码；留空配合 --all 分析全部")
    ap.add_argument("--all", action="store_true", help="分析 symbols.json 里的全部标的")
    ap.add_argument("--date", default=datetime.now().strftime("%Y-%m-%d"), help="交易日 YYYY-MM-DD")
    ap.add_argument("--depth", choices=list(DEPTHS), default="standard", help="分析深度（deep 更贵）")
    ap.add_argument("--no-local-context", action="store_true", help="不注入本地 OI / 空头数据")
    args = ap.parse_args()

    symbols = [s.upper() for s in args.symbols]
    if args.all:
        symbols = json.loads((REPO / "symbols.json").read_text())["symbols"]
    if not symbols:
        ap.error("请给出股票代码，或用 --all")

    failures = []
    for symbol in symbols:
        try:
            result = run_symbol(symbol, args.date, args.depth, not args.no_local_context)
        except Exception as exc:  # one bad symbol must not sink the batch
            print(f"[{symbol}] 失败：{exc}", file=sys.stderr)
            failures.append(symbol)
            continue
        path = write_web_report(result)
        u = result["usage"]
        cost = f"，约 ${u['cost_usd']}" if u["cost_usd"] is not None else "（该模型未在 PRICES 表中，无法计价）"
        print(f"[{symbol}] 决策 {result['decision']} → {path.relative_to(REPO)}")
        print(f"[{symbol}] 实测用量：{u['llm_calls']} 次调用，"
              f"输入 {u['input_tokens']:,} / 输出 {u['output_tokens']:,} tokens{cost}")
        print(f"[{symbol}] 完整报告 → {result['report_dir']}")

    if failures:
        print(f"失败：{', '.join(failures)}", file=sys.stderr)
    return 1 if len(failures) == len(symbols) else 0


if __name__ == "__main__":
    raise SystemExit(main())
