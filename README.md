# MXL 期权未平仓量（OI）每日变化监控

自动追踪 MXL 期权链上每个行权价 Call / Put 未平仓量的每日增减。

- **数据源**：CBOE 免费延迟行情接口（`cdn.cboe.com/api/global/delayed_quotes/options/MXL.json`）
- **抓取**：GitHub Actions 每个交易日 11:00 UTC（7:00am ET）运行 `fetch.mjs`，
  把快照写入 `data/YYYY-MM-DD.json` 并提交回仓库
- **展示**：`index.html`（GitHub Pages 静态页），前端加载任意两天快照做对比，
  显示每个行权价的 ΔOI、当前 OI 分布和明细表

## 手动操作

```bash
node fetch.mjs            # 手动抓一次快照（SYMBOL=XXX 可换标的）
python3 -m http.server    # 本地预览
```

Actions 页面可用 "Run workflow" 手动触发一次抓取。

## 数据格式

`data/YYYY-MM-DD.json`：

```json
{ "symbol": "MXL", "date": "…", "fetched_at": "…", "spot": 0, "prev_close": 0,
  "options": [["到期日", 行权价, call_oi, put_oi, call_vol, put_vol]] }
```

注：OI 由 OCC 每个交易日早间更新，反映上一交易日收盘后的持仓。
