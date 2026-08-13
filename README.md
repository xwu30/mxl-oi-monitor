# MXL 期权未平仓量（OI）每日变化监控

自动追踪 MXL 期权链上每个行权价 Call / Put 未平仓量的每日增减。

- **数据源**：CBOE 免费延迟行情接口（`cdn.cboe.com/api/global/delayed_quotes/options/MXL.json`）
- **抓取**：GitHub Actions 每个交易日 11:00 UTC（7:00am ET）运行 `fetch.mjs`，
  把快照写入 `data/YYYY-MM-DD.json` 并提交回仓库
- **盘中**：开市时段每小时运行 `INTRADAY=1 node fetch.mjs`，
  写入 `data/intraday/YYYY-MM-DD/HHMM.json`（保留最近 14 天）。
  注意 OI 盘中不更新（OCC 每日清晨结算一次），盘中视图对比的是各行权价的**新增成交量**
- **做空数据**：每日快照后跑 `fetch-short.mjs`，写入 `data/<SYM>/short.json`——
  空头仓位比例（Short Interest，占流通股）、空头回补天数（Days to Cover）及近一年历史趋势。
  数据源 [FINRA 合并空头持仓 API](https://api.finra.org)（每月两次结算，滞后约 8 个交易日，
  覆盖全部美股上市；Nasdaq 接口作降级备份）＋ Yahoo 取流通股数换算比例
- **AI 分析**：`analysis/` 下部署了 [TradingAgents](https://github.com/TauricResearch/TradingAgents)
  多智能体框架，手动按需对任一标的产出研究报告（分析师团队 → 多空辩论 → 交易员 → 风控委员会 →
  BUY/HOLD/SELL），并把本地 OI 与空头数据注入其上下文。用法见 [`analysis/README.md`](analysis/README.md)
- **展示**：`index.html`（GitHub Pages 静态页），前端加载任意两天快照做对比，
  显示每个行权价的 ΔOI、当前 OI 分布和明细表，以及该股票的做空数据与 AI 分析卡片

## 手动操作

```bash
node fetch.mjs            # 手动抓一次快照（SYMBOL=XXX 可换标的）
node fetch-short.mjs      # 手动抓一次做空数据（同样支持 SYMBOL=XXX）
python3 -m http.server    # 本地预览
```

Actions 页面可用 "Run workflow" 手动触发一次抓取。

## 数据格式

`data/YYYY-MM-DD.json`：

```json
{ "symbol": "MXL", "date": "…", "fetched_at": "…", "spot": 0, "prev_close": 0,
  "options": [["到期日", 行权价, call_oi, put_oi, call_vol, put_vol]] }
```

`data/<SYM>/short.json`：

```json
{ "symbol": "XXXX", "updated_at": "2026-01-02 09:30", "date": "2026-01-02",
  "float_shares": 100000000, "shares_outstanding": 120000000,
  "short_interest": { "date": "2026-01-15", "shares_short": 9000000,
    "pct_float": 9.0, "pct_out": 7.5, "days_to_cover": 3.1, "avg_daily_vol": 2900000,
    "prev_date": "2025-12-31", "prev_shares_short": 9500000, "prev_pct_float": 9.5 },
  "utilization": null, "borrow_rate": null, "lending_as_of": null,
  "sources": { "short_interest": "finra (consolidated, bi-monthly)", "float": "yahoo",
    "utilization": null, "borrow_rate": null },
  "history": [{ "date": "2025-12-31", "shares_short": 9500000, "avg_daily_vol": 2800000,
    "days_to_cover": 3.39, "pct_float": 9.5, "pct_out": 7.92 }] }
```

注：OI 由 OCC 每个交易日早间更新，反映上一交易日收盘后的持仓。

### Utilization / Borrow Rate 为什么是 null

借券利用率和借券利率来自证券借贷市场（EquiLend / FIS Astec），**没有免费公开接口**：
iBorrowDesk 与 Stocksera 已下线，ChartExchange 走 WebSocket 且不含利用率，Fintel 403、
Ortex 需登录，IBKR 的公开借券文件只走 FTP 且不含利用率。页面上这两张卡片显示「—」并注明原因。
日后若接入付费源（Ortex、Fintel 等），只需在 `fetch-short.mjs` 的 `fetchLending()` 里返回
`{utilization, borrow_rate, as_of, source}`，前端卡片会自动开始显示数值。

比例说明：`pct_float` / `pct_out` 由当期空头股数除以**当前**流通股 / 总股本得出，
历史期数因股本变动属近似值。
