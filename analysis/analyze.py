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
import calendar
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from langchain_core.callbacks import BaseCallbackHandler

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
    # DeepSeek repriced on 2026-08-16 and now bills peak/off-peak (peak is
    # 01:00-04:00 and 06:00-10:00 UTC, roughly double these). Off-peak is quoted
    # here because that is when this project's runs land; a peak run costs about
    # twice what gets reported.
    # The old (0.435, 0.87) sat here long after that repricing and understated
    # every report by ~60%, so the balance ran out well before the numbers said
    # it would. Re-check against the vendor page whenever a run looks cheap.
    "deepseek-v4-pro": (0.66, 1.98),
    "deepseek-v4-flash": (0.22, 0.66),
    "qwen3.7-flash": (0.03, 0.13),
    # The dated snapshot carries its own free-quota allocation, separate from the
    # rolling alias — the alias ran dry while this one sat untouched at 1M tokens.
    # Same rate card; pin it and the reports keep costing flash money.
    "qwen3.7-flash-2026-07-15": (0.03, 0.13),
    # Model Studio list price; OpenRouter resells the same model at 0.32/1.28.
    # The higher figure is quoted so a run is never reported cheaper than it was.
    "qwen3.7-plus": (0.40, 1.60),
    "qwen3.7-max": (1.25, 3.75),
}


_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _clamp_date(value):
    """Snap an impossible calendar date onto the last real day of its month.

    The market analyst picks its own lookback window, and on the 29th-31st it
    asks for a date that does not exist: 2026-08-29 minus six months is
    "2026-02-29", and 2026 is not a leap year. The vendor's strptime then raises
    "day is out of range for month" and the whole report dies over one bad
    string — TD failed exactly this way on 2026-08-29. Clamping loses at most a
    couple of days off the far end of a six-month window, which no indicator
    cares about; failing loses the report.
    """
    m = _DATE_RE.match(value) if isinstance(value, str) else None
    if not m:
        return value
    year, month, day = (int(g) for g in m.groups())
    if not 1 <= month <= 12:
        return value
    last = calendar.monthrange(year, month)[1]
    if 1 <= day <= last:
        return value
    fixed = f"{year:04d}-{month:02d}-{min(max(day, 1), last):02d}"
    print(f"[日期修正] 模型要了不存在的 {value}，改用 {fixed}")
    return fixed


def patch_invalid_tool_dates() -> None:
    """Clamp bad dates in every data tool call, at the one point they share.

    Each tool module does `from ...interface import route_to_vendor` at import
    time, so patching the interface module alone would miss them; rebind the
    name wherever it already points at the original.
    """
    import tradingagents.dataflows.interface as interface

    original = interface.route_to_vendor
    if getattr(original, "_date_clamped", False):
        return

    def routed(method, *args, **kwargs):
        return original(method,
                        *(_clamp_date(a) for a in args),
                        **{k: _clamp_date(v) for k, v in kwargs.items()})

    routed._date_clamped = True
    for module in list(sys.modules.values()):
        if getattr(module, "route_to_vendor", None) is original:
            module.route_to_vendor = routed


# Ratings that express a short / underweight tilt, lowercased for matching.
BEARISH_RATINGS = {"underweight", "sell", "strong sell", "reduce"}


def patch_outcome_sign() -> None:
    """Log a realized return from the position's side, not the stock's.

    ``TradingAgentsGraph._fetch_returns`` computes ``(close_n - close_0)/close_0``
    and ``alpha = raw - benchmark`` with no regard for whether the call was long
    or short, and the memory log writes both numbers next to the rating. So a
    bearish call that got run over is written down as a *gain*: TSLA's
    2026-08-14 Underweight became ``[... | Underweight | +6.0% | +7.4% | 5d]``
    while the stock actually rose 7.6% — and the 2026-08-31 run then cited it as
    "与上一周期决策（Underweight，+7.4% alpha）保持一致", building a fresh
    Underweight on top of a defeat it had been told was a victory.

    The distortion only runs one way: a bullish call that loses is already
    logged negative and reads as a failure, so only bearish ratings flip. What
    you gain by underweighting a name is what the benchmark made instead of it
    (``-alpha`` = ``bench_ret - raw``), and the position's own return is
    ``-raw``. Hold carries no tilt, so its raw stock move is left alone.
    """
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    original = TradingAgentsGraph._fetch_returns
    if getattr(original, "_sign_corrected", False):
        return

    def fetch_returns(self, ticker, trade_date, *args, **kwargs):
        raw, alpha, days = original(self, ticker, trade_date, *args, **kwargs)
        if raw is None or alpha is None:
            return raw, alpha, days
        rating = ""
        try:
            for entry in self.memory_log.get_pending_entries():
                if entry.get("ticker") == ticker and entry.get("date") == trade_date:
                    rating = (entry.get("rating") or "").strip().lower()
                    break
        except Exception:
            # An unreadable log must not cost the whole run; an uncorrected
            # number is bad, a crashed analysis is worse.
            return raw, alpha, days
        if rating in BEARISH_RATINGS:
            print(f"[方向修正] {ticker} {trade_date} 是 {rating}，"
                  f"股价 {raw:+.1%}/alpha {alpha:+.1%} → 按持仓方向记为 "
                  f"{-raw:+.1%}/{-alpha:+.1%}")
            return -raw, -alpha, days
        return raw, alpha, days

    fetch_returns._sign_corrected = True
    TradingAgentsGraph._fetch_returns = fetch_returns


def patch_reflection_verdict() -> None:
    """Tell the reflector in words whether the call won or lost.

    The reflection prompt asks "Was the directional call correct? (cite the
    alpha figure)" and hands over a bare signed percentage — and the model does
    not read the sign. Given a corrected -7.4% it still wrote "The directional
    underweight call was correct, confirmed by the -7.4% alpha versus SPY", the
    same false verdict as before, only with a minus in front of it. Fixing the
    number alone therefore fixes nothing: the prose is what the next run reads.

    Once patch_outcome_sign() has made the sign mean "how the position did", the
    verdict is a pure function of it, so state it rather than hoping the model
    infers it.
    """
    from tradingagents.graph.reflection import Reflector

    original = Reflector.reflect_on_final_decision
    if getattr(original, "_verdict_stated", False):
        return

    def reflect(self, final_decision, raw_return, alpha_return,
                benchmark_name="SPY", *args, **kwargs):
        verdict = "LOST money" if alpha_return < 0 else "MADE money"
        vs = "underperformed" if alpha_return < 0 else "outperformed"
        header = (
            f"OUTCOME (already settled — do not re-derive it from the numbers): "
            f"this call {verdict}. The position returned {raw_return:+.1%} and "
            f"{vs} {benchmark_name} by {abs(alpha_return):.1%}. Returns below are "
            f"stated from the position's side, so a negative number means the "
            f"call was wrong regardless of whether it was long or short. Judge "
            f"the decision against that fact.\n\n"
            f"Decision as originally written:"
        )
        return original(self, f"{header}\n{final_decision}", raw_return,
                        alpha_return, benchmark_name, *args, **kwargs)

    reflect._verdict_stated = True
    Reflector.reflect_on_final_decision = reflect


def price_of(model: str):
    """Longest-prefix match so dated or suffixed model ids still price."""
    hit = [k for k in PRICES if model.startswith(k)]
    return PRICES[max(hit, key=len)] if hit else None


class UsageTracker(BaseCallbackHandler):
    """Count tokens per model across a run, so cost is measured, not guessed.

    Must genuinely subclass BaseCallbackHandler — the chat model validates its
    `callbacks` field with pydantic, so a duck-typed handler is rejected before
    a single request goes out.
    """

    def __init__(self):
        self.by_model: dict[str, dict[str, int]] = {}
        self.calls = 0

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


# Below this many observations a percentile is noise, not a reading.
IV_MIN_HISTORY = 20
# A real IV Rank is measured over a trading year; anything shorter is a window
# statistic and must say so.
IV_FULL_HISTORY = 252


def iv_lines(root, dates, cur) -> list[str]:
    """State today's implied volatility, and rank it only once that is honest.

    iv30 is the market's annualised guess at how far this name moves over the
    next 30 days — the price of insurance on it. Today's number alone is worth
    stating (it converts to an expected move the agents would otherwise have to
    guess at), but it is NOT worth judging: 74 is cheap for MRNA and absurd for
    SPY, and the only way to tell is against the stock's own history.

    We started recording iv30 on 2026-09-03, so for the first months there is no
    such history. Say that plainly — an agent handed a bare "IV 47.3" will
    happily assert volatility is elevated, and that assertion is unfounded.
    """
    iv = (cur or {}).get("iv30")
    if not isinstance(iv, (int, float)) or iv <= 0:
        return []

    out = [f"### 隐含波动率（CBOE iv30，30 天期）"]
    move = iv / 100 / (12 ** 0.5)
    spot = cur.get("spot")
    dollars = f"，约 ±${spot * move:,.2f}" if isinstance(spot, (int, float)) else ""
    chg = cur.get("iv30_change")
    chg_txt = f"（较前收 {chg:+.2f}）" if isinstance(chg, (int, float)) else ""
    out.append(
        f"- iv30 = {iv:.2f}{chg_txt}，即市场为未来 30 天定价约 ±{move * 100:.1f}% 的波动"
        f"（1 个标准差{dollars}）"
    )

    history = []
    for d in dates:
        snap = _load(root / f"{d}.json")
        v = (snap or {}).get("iv30")
        if isinstance(v, (int, float)) and v > 0:
            history.append(v)
    n = len(history)
    if n < IV_MIN_HISTORY:
        out.append(
            f"- ⚠️ 本地 iv30 历史仅 {n} 个交易日（自 2026-09-03 起记录，历史快照无此字段且无法回填），"
            f"不足以判断当前 IV 偏高还是偏低。**请勿据此断言波动率高/低**，"
            f"满 {IV_FULL_HISTORY} 个交易日后才会给出 IV Rank。"
        )
        return out

    lo, hi = min(history), max(history)
    rank = 0.0 if hi == lo else (iv - lo) / (hi - lo) * 100
    pct = sum(1 for v in history if v < iv) / n * 100
    if n >= IV_FULL_HISTORY:
        out.append(f"- IV Rank {rank:.0f}（{n} 日区间 {lo:.2f}–{hi:.2f}），IV 百分位 {pct:.0f}")
    else:
        out.append(
            f"- 近 {n} 日区间 {lo:.2f}–{hi:.2f}，当前处于该窗口的 {rank:.0f}%（百分位 {pct:.0f}）。"
            f"⚠️ 这**不是** IV Rank——窗口只有 {n} 天、不足 {IV_FULL_HISTORY} 天，"
            f"只反映最近这段时间，不能代表一年的高低位。"
        )
    return out


def build_local_context(symbol: str) -> str:
    """Summarise this repo's OI + short-interest series as a markdown block.

    Returns "" when the symbol has no local data yet, so the run degrades to
    plain TradingAgents rather than injecting an empty section.
    """
    # A-shares have neither CBOE options nor FINRA short interest — CBOE answers
    # 403 and FINRA returns nothing. Margin-trading balances are the local
    # equivalent: 融资余额 is leveraged long exposure, 融券余量 borrowed shares.
    import akshare_provider
    if akshare_provider.is_ashare(symbol):
        margin = akshare_provider.margin_summary(symbol)
        if not margin:
            return ""
        return ("\n\n## 本地补充数据（由 mxl-oi-monitor 提供，非 TradingAgents 抓取）\n"
                "以下融资融券数据反映杠杆多头与融券做空的资金定位，请在判断时一并考虑。\n"
                + margin + "\n")

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

        iv_block = iv_lines(root, dates, cur)
        if iv_block:
            lines.extend(iv_block)

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

    patch_invalid_tool_dates()
    patch_outcome_sign()
    patch_reflection_verdict()

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

    # A-shares route everything through AkShare instead: yfinance carries prices
    # but little else for them, and Alpha Vantage rejects the ticker outright.
    import akshare_provider
    if akshare_provider.is_ashare(symbol):
        akshare_provider.register()
        config["data_vendors"] = akshare_provider.VENDORS
        print(f"[{symbol}] A 股标的 → 数据源切换为 AkShare（行情/财务/新闻/融资融券）")

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
