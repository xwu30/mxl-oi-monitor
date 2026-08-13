# TradingAgents 分析模块

把 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)
（多智能体 LLM 金融分析框架）部署在本仓库下，对监控中的股票产出研究报告，
结果直接显示在监控网页顶部的「AI 多智能体分析」卡片里。

## 它是怎么跑的

一次分析会依次跑完这条流水线，每个环节是一个独立的 LLM 智能体：

1. **分析师团队** — 市场技术面 / 社交情绪 / 新闻宏观 / 基本面，各自调用数据工具写报告
2. **研究团队辩论** — 多头研究员与空头研究员就同一批材料互相反驳（轮次可调）
3. **交易员** — 综合辩论结果给出具体交易方案
4. **风控委员会** — 激进 / 保守 / 中立三方再辩论，产出最终 **BUY / HOLD / SELL**

**本仓库的加料**：`analyze.py` 会把本地采集的期权 OI 变化（含变化最大的行权价）
和 FINRA 空头持仓摘要注入到运行上下文里 —— 这些数据 TradingAgents 自己抓不到，
是本项目独有的信息优势。网页上「注入给智能体的本地数据」一节可以看到原文。

## 安装

```bash
./analysis/setup.sh          # 建 venv（uv 自带 Python 3.12）+ 安装 TradingAgents
```

然后编辑 `analysis/.env`，**至少填一个 LLM key**：

```
ANTHROPIC_API_KEY=sk-ant-...        # 或 OPENAI_API_KEY / GOOGLE_API_KEY
ALPHA_VANTAGE_API_KEY=...           # 强烈建议，见下文「数据源现状」
```

## 用法

```bash
./analysis/run.sh NVDA                       # 分析单只，用今天日期
./analysis/run.sh NVDA MXL --depth deep      # 多只 + 深度模式（更贵）
./analysis/run.sh --all                      # symbols.json 里全部标的
./analysis/run.sh MXL --date 2026-08-11      # 指定交易日（复盘用）
./analysis/run.sh NVDA --no-local-context    # 不注入本地 OI / 空头数据
```

| 深度 | 分析师 | 辩论轮次 | 用途 |
|---|---|---|---|
| `quick` | 市场 + 基本面 | 1 | 快速扫一眼，最省钱 |
| `standard`（默认） | 全部四位 | 1 | 日常使用 |
| `deep` | 全部四位 | 3 轮多空 + 2 轮风控 | 重仓决策前，token 消耗数倍 |

输出：

- `data/<SYM>/analysis/<交易日>.json` — 网页读取的版本，**要 commit 才能在线上看到**
- `analysis/reports/<SYM>_<日期>_<时间戳>/` — TradingAgents 原生 markdown 报告树（不提交）

跑完提交即可：`git add data && git commit -m "analysis NVDA" && git push`

## 数据源现状（实测 2026-08）

| 数据 | 供应商 | 状态 |
|---|---|---|
| 行情 / 技术指标 | yfinance | ✅ 免费可用 |
| 基本面 | yfinance | ✅ 免费可用 |
| 期权 OI / 空头持仓 | 本仓库自采 | ✅ 注入上下文 |
| **新闻 / 情绪** | yfinance | ❌ **接口已失效，返回空** |
| 新闻（替代） | Alpha Vantage | ⚠️ 需免费 key（25 次/天） |
| 宏观 | FRED | ⚠️ 需免费 key |

**没有 `ALPHA_VANTAGE_API_KEY` 时，新闻分析师和情绪分析师基本拿不到料**，
报告会明显偏向技术面和基本面。这个 key 免费、邮箱注册即得，建议补上。

## 成本与注意事项

- 每次分析都是真金白银的 token 消耗，`deep` 模式一只股票可能要几十万 token，
  所以**不接入每日 GitHub Actions 定时任务**，只手动按需跑。
- 输出是**研究材料，不是投资建议**。LLM 会犯错、会用过时数据、也会自信地胡说。
- 报告语言默认中文（`TRADINGAGENTS_OUTPUT_LANGUAGE`），
  但智能体内部辩论仍用英文——官方称这样推理质量更好。
- 升级框架：重跑 `./analysis/setup.sh` 即可（从 GitHub main 分支重装）。
