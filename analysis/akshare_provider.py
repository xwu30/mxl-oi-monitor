"""AkShare-backed vendor for Chinese A-shares.

TradingAgents ships yfinance and Alpha Vantage, and neither serves an A-share
well: yfinance has prices but thin fundamentals, and Alpha Vantage rejects the
ticker outright ("Invalid ticker format: 603986.SS"). This module fills that in
for `.SS` / `.SZ` symbols.

Registration mutates the framework's VENDOR_METHODS dict at runtime rather than
editing site-packages, so setup.sh can reinstall TradingAgents without losing
any of this.

    import akshare_provider
    akshare_provider.register()          # adds the "akshare" vendor
    config["data_vendors"] = akshare_provider.VENDORS

Margin-trading balances (融资融券) are deliberately *not* a vendor method — they
have no US analogue to slot into. They ride the same local-context channel this
repo already uses to inject option OI and short interest, via margin_summary().
"""
from __future__ import annotations

import warnings
from datetime import datetime, timedelta

import akshare as ak
import pandas as pd

warnings.filterwarnings("ignore")

# Every A-share method resolves through this one vendor name.
VENDORS = {
    "core_stock_apis": "akshare",
    "technical_indicators": "akshare",
    "fundamental_data": "akshare",
    "news_data": "akshare",
    "macro_data": "fred",
    "prediction_markets": "polymarket",
}


def is_ashare(symbol: str) -> bool:
    return symbol.upper().endswith((".SS", ".SZ"))


def _code(symbol: str) -> str:
    """603986.SS -> 603986 — AkShare takes the bare number."""
    return symbol.split(".")[0]


def _compact(date: str) -> str:
    """2026-08-14 -> 20260814"""
    return date.replace("-", "")


def _prefixed(symbol: str) -> str:
    """603986.SS -> sh603986 — Sina and Tencent want the exchange prefix."""
    return ("sh" if symbol.upper().endswith(".SS") else "sz") + _code(symbol)


# Chinese market endpoints are individually unreliable — Eastmoney's history
# feed rate-limited us mid-session after a handful of calls while its news feed
# kept working. Any one source failing must not sink a run, so try three.
# Columns are normalised to the Eastmoney Chinese names the rest of this module
# reads.
def _hist(symbol: str, start: str, end: str) -> tuple[pd.DataFrame, str]:
    """Returns (candles, source) — the source is reported so a report never
    credits Eastmoney for numbers that actually came from the fallback."""
    attempts = (
        ("eastmoney", lambda: ak.stock_zh_a_hist(
            symbol=_code(symbol), period="daily",
            start_date=_compact(start), end_date=_compact(end), adjust="qfq")),
        ("sina", lambda: ak.stock_zh_a_daily(
            symbol=_prefixed(symbol), start_date=_compact(start),
            end_date=_compact(end), adjust="qfq")),
        ("tencent", lambda: ak.stock_zh_a_hist_tx(
            symbol=_prefixed(symbol), start_date=_compact(start),
            end_date=_compact(end), adjust="qfq")),
    )
    for name, fetch in attempts:
        try:
            df = fetch()
        except Exception:
            continue
        if df is None or df.empty:
            continue
        rename = {"date": "日期", "open": "开盘", "close": "收盘", "high": "最高",
                  "low": "最低", "volume": "成交量", "amount": "成交额"}
        df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})
        return df, {"eastmoney": "东方财富", "sina": "新浪财经", "tencent": "腾讯财经"}[name]
    return pd.DataFrame(), ""


# ---------- vendor methods (signatures mirror the yfinance ones) ----------
def get_stock_data(symbol: str, start_date: str, end_date: str) -> str:
    df, source = _hist(symbol, start_date, end_date)
    if df.empty:
        return f"# 无行情数据：{symbol} {start_date}~{end_date}"
    head = (f"# {symbol} 日线行情（前复权）{start_date} ~ {end_date}\n"
            f"# 共 {len(df)} 个交易日 | 数据源 AkShare/{source}\n\n")
    return head + df.to_csv(index=False)


def get_indicators(symbol: str, indicator: str, curr_date: str, look_back_days: int) -> str:
    """Compute the requested indicator from AkShare candles via stockstats.

    Pulls extra history beyond look_back_days because the long-window
    indicators (200 SMA and friends) need a warm-up before their first value.
    """
    from stockstats import wrap

    start = (datetime.strptime(curr_date, "%Y-%m-%d")
             - timedelta(days=look_back_days + 400)).strftime("%Y-%m-%d")
    df, _ = _hist(symbol, start, curr_date)
    if df.empty:
        return f"# 无行情数据，无法计算 {indicator}"

    df = df.rename(columns={"日期": "date", "开盘": "open", "收盘": "close",
                            "最高": "high", "最低": "low", "成交量": "volume"})
    stock = wrap(df[["date", "open", "close", "high", "low", "volume"]].copy())
    try:
        stock[indicator]  # stockstats computes on first access
    except (KeyError, ValueError) as exc:
        return f"# 指标 {indicator} 无法计算：{exc}"

    # wrap() promotes `date` to the index, so it is no longer selectable as a
    # column — read the dates off the index instead.
    out = stock[indicator].dropna().tail(look_back_days)
    lines = [f"## {indicator} 最近 {len(out)} 个交易日（{symbol}）", ""]
    lines += [f"{str(idx)[:10]}: {val}" for idx, val in out.items()]
    return "\n".join(lines)


def _financial_abstract(symbol: str) -> pd.DataFrame | None:
    try:
        return ak.stock_financial_abstract(symbol=_code(symbol))
    except Exception:
        return None


def get_fundamentals(symbol: str, curr_date: str | None = None) -> str:
    df = _financial_abstract(symbol)
    if df is None or df.empty:
        return f"# 无基本面数据：{symbol}"
    # The sheet is one row per metric with a column per reporting period; the
    # four most recent periods are plenty of context and keep the prompt small.
    periods = [c for c in df.columns if str(c).isdigit()][:4]
    lines = [f"# {symbol} 财务摘要（AkShare/同花顺）",
             f"# 取数日 {curr_date}，展示最近 {len(periods)} 个报告期", ""]
    lines.append("指标 | " + " | ".join(periods))
    lines.append("---")
    for _, row in df.iterrows():
        vals = [str(row.get(p, "")) for p in periods]
        if any(v and v != "nan" for v in vals):
            lines.append(f"{row['指标']} | " + " | ".join(vals))
    return "\n".join(lines)


# A-share filings don't split into the three US statements the framework asks
# for; the abstract already carries balance-sheet, cash-flow and income lines,
# so all three route to it rather than returning nothing. Signatures must match
# the yfinance ones exactly — the framework passes `freq` positionally, and a
# mismatch aborts the run partway through with a TypeError.
def get_balance_sheet(ticker: str, freq: str = "quarterly", curr_date: str | None = None) -> str:
    return get_fundamentals(ticker, curr_date)


get_cashflow = get_income_statement = get_balance_sheet


def get_news(ticker: str, start_date: str, end_date: str) -> str:
    try:
        df = ak.stock_news_em(symbol=_code(ticker))
    except Exception as exc:
        return f"# 新闻获取失败：{exc}"
    if df is None or df.empty:
        return f"# 无新闻：{ticker}"
    df = df[(df["发布时间"] >= start_date) & (df["发布时间"] <= end_date + " 23:59:59")]
    if df.empty:
        return f"# {ticker} 在 {start_date}~{end_date} 无新闻"
    lines = [f"# {ticker} 个股新闻 {start_date} ~ {end_date}（AkShare/东方财富）", ""]
    for _, row in df.iterrows():
        body = str(row["新闻内容"]).strip().replace("\n", " ")[:500]
        lines += [f"## {row['新闻标题']}", f"{row['发布时间']} · {row['文章来源']}", body, ""]
    return "\n".join(lines)


def get_global_news(curr_date: str, look_back_days: int = 7, limit: int = 20) -> str:
    """Macro headlines. The news_data category covers this too, so leaving it
    unregistered aborts the whole run with 'vendor not available'."""
    try:
        df = ak.stock_info_global_em()
    except Exception as exc:
        return f"# 全球财经快讯获取失败：{exc}"
    if df is None or df.empty:
        return "# 无全球财经快讯"
    lines = [f"# 全球财经快讯（截至 {curr_date}，AkShare/东方财富）", ""]
    for _, row in df.head(limit).iterrows():
        summary = str(row.get("摘要", "")).strip().replace("\n", " ")[:300]
        lines += [f"## {row['标题']}", f"{row['发布时间']}", summary, ""]
    return "\n".join(lines)


def get_insider_transactions(symbol: str) -> str:
    """A-share equivalent of insider filings: 高管及股东持股变动.

    Returns a plain message rather than raising when unavailable — the news
    category routes here, and an exception would abort the entire analysis over
    a secondary data point.
    """
    code = _code(symbol)
    try:
        df = ak.stock_share_hold_change_sse() if symbol.upper().endswith(".SS") \
            else ak.stock_share_hold_change_szse()
        hit = df[df.astype(str).apply(lambda r: code in r.values, axis=1)]
        if hit.empty:
            return f"# {symbol} 近期无高管/股东持股变动记录"
        return f"# {symbol} 高管及股东持股变动（AkShare/交易所）\n\n" + hit.head(20).to_csv(index=False)
    except Exception as exc:
        return f"# 持股变动数据不可用：{type(exc).__name__}（该项非决策必需）"


# ---------- A-share-only extra: margin trading (融资融券) ----------
def margin_summary(symbol: str, days: int = 5) -> str:
    """Latest margin-financing and securities-lending balances, plus a trend.

    This is the closest A-share analogue to the short interest this repo tracks
    for US names: 融资余额 is leveraged long exposure, 融券余量 is borrowed
    shares sold short. Exchange endpoints publish one file per trading day, so
    walk back over a fortnight of calendar days to gather a few sessions —
    weekends and holidays simply return nothing.
    """
    code = _code(symbol)
    sse = symbol.upper().endswith(".SS")
    rows = []
    day = datetime.now()
    for _ in range(15):
        if len(rows) >= days:
            break
        stamp = day.strftime("%Y%m%d")
        day -= timedelta(days=1)
        try:
            df = (ak.stock_margin_detail_sse(date=stamp) if sse
                  else ak.stock_margin_detail_szse(date=stamp))
        except Exception:
            continue
        if df is None or df.empty:
            continue
        hit = df[df.astype(str).apply(lambda r: code in r.values, axis=1)]
        if not hit.empty:
            rows.append((stamp, hit.iloc[0]))

    if not rows:
        return ""

    def pick(row, *names):
        for n in names:
            if n in row.index:
                return row[n]
        return None

    stamp, latest = rows[0]
    fin = pick(latest, "融资余额", "融资余额(元)")
    lend = pick(latest, "融券余量", "融券余量(股)")
    buy = pick(latest, "融资买入额", "融资买入额(元)")

    lines = ["### 融资融券（交易所每日披露）"]
    if fin is not None:
        lines.append(f"- 融资余额 {float(fin) / 1e8:.2f} 亿元（{stamp}）")
    if buy is not None:
        lines.append(f"- 当日融资买入额 {float(buy) / 1e8:.2f} 亿元")
    if lend is not None:
        lines.append(f"- 融券余量 {int(float(lend)):,} 股")
    if len(rows) > 1:
        old_stamp, old = rows[-1]
        old_fin = pick(old, "融资余额", "融资余额(元)")
        if fin is not None and old_fin:
            change = (float(fin) - float(old_fin)) / float(old_fin) * 100
            lines.append(f"- 融资余额较 {old_stamp} {'+' if change >= 0 else ''}{change:.2f}%"
                         f"（{float(old_fin) / 1e8:.2f} 亿 → {float(fin) / 1e8:.2f} 亿）")
    return "\n".join(lines)


def register() -> None:
    """Add the akshare vendor to the framework's routing table."""
    from tradingagents.dataflows import interface

    for method, impl in (
        ("get_stock_data", get_stock_data),
        ("get_indicators", get_indicators),
        ("get_fundamentals", get_fundamentals),
        ("get_balance_sheet", get_balance_sheet),
        ("get_cashflow", get_cashflow),
        ("get_income_statement", get_income_statement),
        ("get_news", get_news),
        ("get_global_news", get_global_news),
        ("get_insider_transactions", get_insider_transactions),
    ):
        if method in interface.VENDOR_METHODS:
            interface.VENDOR_METHODS[method]["akshare"] = impl
    if "akshare" not in interface.VENDOR_LIST:
        interface.VENDOR_LIST.append("akshare")

    # Every method in a category we claim must have an implementation: routing
    # is per-method, so one gap aborts the run with "vendor not available".
    # get_global_news being missing is exactly how the first A-share run died.
    missing = [
        m for cat, vendor in VENDORS.items() if vendor == "akshare"
        for m in interface.TOOLS_CATEGORIES[cat]["tools"]
        if "akshare" not in interface.VENDOR_METHODS.get(m, {})
    ]
    if missing:
        raise RuntimeError(f"akshare vendor 缺少方法实现：{missing}")

    # Arity must match the vendor the framework calls positionally. Guessing the
    # signature cost two failed runs (get_fundamentals and the statement trio),
    # so compare against a shipped implementation and fail at startup instead.
    import inspect
    for method, impls in interface.VENDOR_METHODS.items():
        ours = impls.get("akshare")
        theirs = impls.get("yfinance") or impls.get("alpha_vantage")
        if not ours or not theirs:
            continue
        theirs = theirs[0] if isinstance(theirs, list) else theirs
        want = len(inspect.signature(theirs).parameters)
        have = len(inspect.signature(ours).parameters)
        if have < want:
            raise RuntimeError(
                f"akshare.{method} 参数不足：框架会传 {want} 个，实现只接受 {have} 个")
