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

## 选哪个模型（成本对比）

**先看这条结构事实**：流水线 14 个节点里，只有 **2 个**（研究经理、风控主管）用 `deep_think_llm`，
其余 12 个（4 位分析师 + 多空辩论 + 交易员 + 3 位风控）全部用 `quick_think_llm`。
所以 **quick 模型决定你的账单，deep 模型换成最好的那个几乎不花钱**——
一次 `standard` 深度分析约 **10.3 万输入 + 1.2 万输出 token**，其中 quick 占 ~82%。

按各家 2026-08 官网价，单次分析的成本：

| 配置 | 单价（输入/输出，$/M） | 单次成本 | 说明 |
|---|---|---|---|
| DeepSeek V4 Flash 全套 | 0.14 / 0.28 | **$0.02** | 最便宜；OpenAI 兼容，改个 backend_url 即可 |
| DeepSeek V4 Pro 全套 | 0.435 / 0.87 | $0.06 | |
| Kimi K2.6 | 0.95 / 4.00 | $0.14 | |
| Claude Haiku 4.5 全套 | 1.00 / 5.00 | $0.16 | |
| GLM-5.2 | 1.40 / 4.40 | $0.19 | |
| Gemini 3.6 Flash | 1.50 / 7.50 | $0.24 | |
| **Haiku 4.5（quick）+ Opus 5（deep）** | 混合 | **$0.27** | **推荐**：省钱但最终决策仍由 Opus 出 |
| GPT-5.4 全套 | 2.50 / 15.00 | $0.43 | |
| Claude Sonnet 5 全套 | 3.00 / 15.00 | $0.49 | 引入期价 2/10 时为 $0.33 |
| Claude Opus 5 全套 | 5.00 / 25.00 | $0.82 | 质量上限 |
| GPT-5.5 全套 | 5.00 / 30.00 | $0.86 | |

**结论取决于你跑多勤**：

- **偶尔跑（每周几次）**——最贵和最便宜差 $0.8，一年也花不到 100 块。
  别为省这点钱牺牲分析质量，直接用推荐方案或全 Opus。
- **每天 `--all` 跑 11 支**——差距才真正拉开：全 Opus 约 $9/天（$270/月），
  推荐方案约 $3/天，DeepSeek Flash 约 $0.2/天（$6/月）。

**选便宜模型的两个风险**（不是价格问题）：分析师环节工具调用密集，小模型容易把工具调用
写成普通文本导致空转；最终决策要能稳定输出 BUY/HOLD/SELL 供 `parse_rating` 提取。
所以即使走省钱路线，也建议 deep 用该家最强的那个（DeepSeek 就配 V4 Pro）。

**⚠️ deep 和 quick 必须同一家**——框架只有一个 `llm_provider`，两者共用它和 `backend_url`。
想跨家混搭（例如 quick 用 DeepSeek、deep 用 Opus）只能挂一个 OpenAI 兼容的聚合网关。

**不用猜——每次跑完会打印实测用量**：

```
[NVDA] 实测用量：14 次调用，输入 103,000 / 输出 11,560 tokens，约 $0.2688
```

同样的数字写进 `data/<SYM>/analysis/<日期>.json` 的 `usage` 字段（含 `by_model` 分模型明细）。
价格表是 `analyze.py` 里的 `PRICES` 常量，各家调价改那一处即可；
表里没有的模型只统计 token、不瞎报价钱（`cost_usd` 为 `null`）。

## 成本与注意事项

- 每次分析都是真金白银的 token 消耗，`deep` 模式一只股票可能要几十万 token，
  所以**不接入每日 GitHub Actions 定时任务**，只手动按需跑。
- 输出是**研究材料，不是投资建议**。LLM 会犯错、会用过时数据、也会自信地胡说。
- 报告语言默认中文（`TRADINGAGENTS_OUTPUT_LANGUAGE`），
  但智能体内部辩论仍用英文——官方称这样推理质量更好。
- 升级框架：重跑 `./analysis/setup.sh` 即可（从 GitHub main 分支重装）。
