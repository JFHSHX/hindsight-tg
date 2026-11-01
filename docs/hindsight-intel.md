# Hindsight 深度侦察报告（供 hindsight-tg 借鉴）

> 侦察日期：2026-11-01。来源：官方文档站 7 页（observations/retrieval/memory-defense/mental-models/knowledge-pages/retain/reflect）、论文 arXiv:2512.12818（摘要 + HTML 正文 §1–§4.2.5）。
> 未能获取（如实注明）：论文 §5 之后全文（CARA 观点形成细节/消融表/附录 A 完整 prompt 模板——抓取截断）、45 模式的源码级正则原文、benchmarks 站内数据。其余全部有据可查。

## 一、Observations 整合算法（docs：/developer/observations）

### 机制
- **触发**：retain 完成后自动后台整合（`HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false` 可关；或显式调 consolidate endpoint，支持按 observation_scopes 定向整合）。
- **流程**：新 facts 逐条与现有 observations 比对 → 相似分组合成 → 创建新 observation 或精化现有 → 全程证据跟踪。
- **近重复对账**：observation 创建/更新时与最相似现有观察比对，cosine ≥ 阈值（`HINDSIGHT_API_CONSOLIDATION_DEDUP_THRESHOLD`，默认 **0.97**，1.0 关闭，仅 PostgreSQL）时由 LLM 读两份全文判定合并（双方证据并集）或保留——有意义的差异（数字、否定、命名实体、语言）会正确分开。
- **矛盾处理三步**（这是灵魂）：① 检测冲突；② **保留历史**——新 observation 吸收旧理解（"User was previously a React enthusiast… but has now switched to Vue"）；③ 合成更丰富的观察 + 更新新鲜度。原始 facts 永远保留可回溯。
- **freshness**：每个 observation 记录最近更新时间；reflect 时 stale 的观察不直接采信，须对照 raw facts 验证。
- **scopes**：observations 默认按记忆全部 tags 的组合分 scope 独立整合；`observation_scopes:"shared"` 归入全局单 scope；scope 是"证据并集"的边界。
- **observations_mission**：银行级指令定义"该合成什么"（默认：durable、specific、长期为真的事实；过滤 ephemeral）。
- **consolidation strategies**：按 scope 模式（fnmatch 通配 + tags_match all/exact）覆盖 mission / `max_observations_per_scope` / source-facts token 上限；首个匹配策略整条生效不混合；untagged scope 不可被策略认领。
- **演化实例**（docs 原例）：Redis 观察"强化(2→3 证据) → 修正(许可证变更) → 派生新观察(Valkey)"。

### 对 hindsight-tg 的差距
我们：digest = 全量快照 + 整卡重写，无增量强化、无矛盾历史保留、无近重复合并、无 scope 化整合。

### 实现草案
1. digest prompt 改为 **reconcile 模式**：输入【旧 digest 全文 + 新增记忆】，要求输出 JSON `{updates:[{action:"reinforce"|"refine"|"new", statement, evidence_quotes[]}]}`——reinforce 则证明计数+1，refine 则改写并保留"previously…"句式，new 则追加观察。
2. 用我们已有的 **tg_edit 原位更新旧 #digest 消息**（不发新消息），索引条目扩展 `evidence_quotes[]` 与 `proof_count` 字段。
3. 近重复合并：无向量，用 digest prompt 内"与旧观察逐条比对"实现（LLM 判定）。
4. scope 化：`#hindsight-tg` 等项目标签天然是 scope——digest 按标签分组归纳。
工作量：半天~一天。这是观察层从"快照"升级为"信念系统"的关键一跃。

## 二、TEMPR 检索（docs：/developer/retrieval + 论文 §4.2）

### 机制（参数级细节）
- **四路并行**：
  - 语义：pgvector HNSW（ef_search ≤ 1000）。
  - 关键词：5 种可插拔 BM25 后端——native(tsvector，TF-IDF)/vchord/pg_textsearch/pgroonga(TokenBigram)/**pg_search（ParadeDB，可配 jieba 等中文分词器）**。
  - 图检索 = **扩散激活**（论文）：`A(f,t+1)=max[A(f_i,t)·w·δ·μ(ℓ)]`，δ 为衰减、μ(ℓ) 为边型乘数（causal/entity >1）。
  - 时间：规则解析（两个多语言日期库）→ 兜底 **google/flan-t5-small** seq2seq；窗口重叠匹配 + **时间桶分散选优**（每桶最强者先取，防止在某段密集刷屏）+ 窗口中心邻近加成。
- **RRF 融合**：`score = Σ 1/(60 + rank_i)`，k=60，四路**等权**（rank 位置而非来源）；boost 不进 RRF（作用于 rerank 前后的独立阶段）。
- **交叉编码器**：**cross-encoder/ms-marco-MiniLM-L-6-v2**（论文实锤）；候选预裁 **top-300**（`HINDSIGHT_API_RERANKER_MAX_CANDIDATES`）；logits→sigmoid 归一化；本地 batch 32 / TEI 128；无 CE 时按 RRF 派生分数（0.1–1.0 线性铺开）回退。
- **组合打分**：`final = CE × recency × temporal × proof`；每个乘子 `boost = 1 + α×(signal − 0.5)`：recency α=0.2（`clamp(1−days/365, 0.1, 1.0)`）、temporal α=0.2、proof α=0.1（`clamp(0.5+ln(proof)/10, 0, 1)`）。**乘法而非加法**——防低相关凭新近度反超；总摆幅 +27%/−23%。
- **token 预算**：默认 4096；装填按 final 分数序，超长条目跳过继续装下一条，全放不下保底返回第一条；budget low/mid/high = 100/300/1000（或 adaptive = max_tokens×2.5%/7.5%/…）。
- **输入增强**：embedding 前给 fact 拼人类可读时间描述；reranker 输入同样带格式化时间。

### 借鉴点与草案
- 直接抄三件（性价比极高）：
  1. **乘法组合打分**：现有 `base × recency × proof`（proof=证据计数，recency 已有）——约 10 行，解决"新近度独大"。
  2. **embedding/索引前拼接时间前缀**：retain 时给文本加 `[2026-11-01]`——零成本提升时序感知。
  3. **时间桶分散**：按天分桶，每桶取最优再混排——防止同一天的记忆刷满 top-k。
- 语义召回（二期）：sqlite-vec/中转 embedding + **RRF(k=60) 两路融合**——公式直接抄，1–2 天。
- 中文分词警示：官方专门为中文提供 jieba 分词后端——我们 FTS5 需 trigram 或自切词（已知边界）。

## 三、Mental Models / Knowledge Pages（docs 两页）

### 机制
- Mental model = 预定义问题的**预写答案**：后台生成，读取 = 数据库直读（零检索零 LLM 零等待）。
- **刷新触发是 scoped 的**：只有"该模型自己 scope 内"来了新记忆才重建；无关 bank 变动零成本。
- **增量刷新**（点睛设计）：不重新生成全文，只应用新知识蕴含的变更、其余**物理不动**——文档原话："told to preserve the unchanged parts, it will still drift"（LLM 重写必然漂移，所以只做增量编辑）。
- freshness signal 随模型交给 reflect：stale 的不再短路检索。
- **provenance**：记录基于哪些 facts/observations + **保留历史版本**。
- Knowledge pages = mental model 的简化包装：从 **observations**（非 raw facts）构建、增量编辑刷新、**永不读其他页面**（防引用循环）、更大内容预算；wiki 文件夹树；`hindsight fs mount` 投影成真实 markdown（YAML frontmatter + 后台刷新循环）；文档级搜索（全文+语义融合、无 rerank）；核心哲学："**页是渲染不是存储**——删页不丢内容，可从记忆重投影"。
- reflect 检索阶梯：mental models（最高优先）→ observations（带新鲜度）→ raw facts（验证用）。

### 借鉴点与草案
- 我们置顶卡 = 单卡全量重写；官方增量编辑思想我们已用 tg_edit 兑现"原位"，但内容生成仍全量——**digest/card prompt 改为要求"未变部分逐字保留"**（低成本护栏），长期可做行级增量。
- 预置问题制度化：画像卡之外加"项目卡/偏好卡"——TG 置顶位只有一个，可用**话题（forum topics）**或固定标签消息承载多卡。
- "页是渲染不是存储"：我们的 memory.jsonl 就是源真值，digest/置顶卡都是投影——把这个哲学写进 README 的设计声明。

## 四、Memory Defense（docs：/developer/memory-defense）

### 机制
- 每 bank opt-in；规则 `{on:"sensitive_data", action:"redact"|"block"}`；**redact = 替换为 `[REDACTED:type]` 后入库**（推荐默认），block = 丢弃（全 block 返回 422）；不回溯已有记忆；webhook + 审计日志；另有 `prompt_injection` 检测器与 `receipt_uri` 外部凭证。

### 45 模式全清单（docs 原文，正则按形状复刻即可）
| 类别 | 模式 |
|---|---|
| AI/LLM | `sk-ant-…`(anthropic)、`sk-…/sk-proj-…/sk-admin-…`(openai 三种)、`AIza…`(39位)、`ya29.`、`xai-`、`gsk_`、`hf_`、`r8_`、`pplx-`、`dapi<hex32>`(databricks) |
| 云 | `AKIA<16>`、`ASIA<16>`、`dop_v1_<hex64>` |
| 源码/CI | `github_pat_…`、`ghp_<36>`、`ghs_<36>`、`ghu_<36>`、`ghr_<36>`、`gho_<36>`、`glpat-…`、`npm_…`、`pypi-AgEIcHlwaS5vcmc…` |
| 支付 | `sk_live_…/sk_test_…`、`rk_live_…/rk_test_…`、`sq0…`、`access_token$production$…`(braintree) |
| 通信 | `xoxb-/xoxp-/xoxa-/xoxr-`(slack)、`hooks.slack.com/services/…`、`SK<hex32>`、`AC<hex32>`(twilio)、`SG.<22>.<43>`(sendgrid)、`key-<32>`(mailgun)、discord `<MNO><23>.<6>.<27>`、**telegram `<8-10位>:<35>`**（与我们已有的一致） |
| 商务 | `shpat_<hex32>` |
| DB 连接串 | `postgres(ql)://user:pass@`、`mysql://…`、`mongodb(+srv)://…` |
| 私钥/JWT/PII | PEM 私钥块、`eyJ….eyJ….<签名>`(JWT)、信用卡 13–19 位、SSN `123-45-6789` |

### 借鉴点与草案
- 我们 7 类 → 扩到 ~25 类（上表挑高价值：LLM keys 全家、GitHub 六兄弟、DB URL、JWT、PEM、slack/discord/telegram、信用卡）。
- **action 建议改为 redact**（官方默认）：保留记忆形状、隐藏值，比一刀切 block 更可用；`defense:"redact"|"block"|"off"`。
- 工作量：1–2 小时。

## 五、论文（arXiv:2512.12818，"Hindsight is 20/20"）

### 架构
- 两大组件：**TEMPR**（Temporal Entity Memory Priming Retrieval，= retain+recall）+ **CARA**（Coherent Adaptive Reasoning Agents，= reflect）。
- 四网络（论文版）：world / experience / **opinion（置信度 c∈[0,1] 的主观信念，reflect 时形成、强化机制更新）** / **observation（偏好中立的实体摘要，后台再生）**——注意与 docs 演变：如今 docs 的 observations = 带证据信念（两者融合了）。
- **内存单元**：`f=(u, b, t, v, τs, τe, τm, ℓ, c, x)`——双时间轴（发生区间 τs/τe + 提及时间 τm）。
- **叙事抽取**：每段对话 **2–5 条粗粒度叙事事实**（反碎片化：保留完整交换、参与者、推理链）；6 步内解：共指消解 → 时间归一化（"last week"→绝对区间）→ 参与者归属 → 保留推理 → 类型分类 → 实体抽取（PERSON/ORG/LOCATION/PRODUCT/CONCEPT/OTHER）。
- **图结构**：4 类边——temporal `exp(−Δt/σt)`、semantic（cos≥θs）、entity（w=1.0）、causal（w=1.0，四种关系 causes/caused_by/enables/prevents）。
- **实体消解**：`ρ(m)=argmax[α·sim_str + β·sim_co + γ·sim_temp]`（字符串相似+共现+时间邻近）。
- CARA：disposition 三参数（skepticism/literalism/empathy，1–5）+ bias-strength（0–1）；observation 与 opinion 五维对比（profile 影响/客观 vs 主观/置信度/生成时机：后台合成 vs reflect 时形成+强化）。

### 数字
- LongMemEval：全上下文基线 39% → **83.6%**（开源 20B backbone，同 backbone 对比）→ **91.4%**（更大 backbone）；超过全上下文 GPT-4o。
- LoCoMo：75.78%（最强前作开源系统）→ 85.67% → **89.61%**。

### 未能获取
§5 之后全文（opinion formation 公式/强化细节/background merging、§7 消融数据、附录 A 完整 prompt 模板——A.1 事实抽取/A.3 observation 生成/A.5 结构化 schema 的目录已确认存在）——HTML 抓取在 §4.2.5 截断。

### 其他收获（docs retain/reflect 页）
- retain 使命三段式：`retain_mission`（抽取什么）/ `observations_mission`（合成什么）/ `reflect_mission`（人格身份）+ extraction modes（concise/verbose/custom/verbatim/chunks）。
- reflect agentic loop 工具：search_mental_models → read_mental_models → search_observations → recall → expand → done；≤10 迭代；**引用验证**（只能引用实际检索到的 id）；structured_output 二次抽取。
- directives = 硬规则（标签作用域）vs disposition = 软影响——"Use disposition for personality, use directives for compliance"。
- 图片附件位置感知抽取；图表**逐行转写**（一行一事实，刻意多记忆）。

## 六、按性价比排序的 borrow 清单

| # | 项目 | 工作量 | 对应短板 |
|---|---|---|---|
| 1 | **乘法组合打分**：base × recency × proof（公式+参数照抄） | ~10 行 | Recall 排序质量 |
| 2 | **Memory Defense 扩容**：7→25 类 + redact 模式（清单已拿全） | 1–2 小时 | 隐私护栏 |
| 3 | **digest reconcile 化**：强化/修正/新增三态 + tg_edit 原位更新 + evidence_quotes/proof_count 字段 | 半天~一天 | 观察层从快照→信念系统 |
| 4 | **时间前缀增强**：retain 文本自动加 `[YYYY-MM-DD]` | ~5 行 | 时序感知 |
| 5 | **语义召回**：sqlite-vec/中转 embedding + RRF(k=60) 两路融合 | 1–2 天 | Recall 无语义（最大短板） |
| 6 | **disposition traits**：守则加三参数进 digest/reflect prompt | 半天 | Reflect 人格一致性 |
| 7 | **叙事抽取原则**：auto-capture gate 改"2–5 条叙事事实/段，反碎片化" | prompt 改动 | Retain 质量 |
| 8 | **多卡心智模型**：话题/固定标签消息承载多张卡（置顶位限制的绕法） | 半天 | Mental models 单卡限制 |
| 9 | opinion 网络（置信度+强化+衰减） | 大件 | 长期 |
| 10 | fs mount（memory.jsonl → markdown 树投影） | 可选 | 可与现有 docs 合并 |

执行 1–4 + 7 约一天，机制复刻度可从 ~40% 推到 ~60%；加 5 则 Recall 短板基本补齐。

— 侦察完毕。来源：docs.hindsight.vectorize.io（7 页，URL 见各节）、arxiv.org/abs/2512.12818 + /html/2512.12818v1。抓取失败项已如实标注。
