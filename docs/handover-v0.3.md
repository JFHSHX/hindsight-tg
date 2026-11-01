# v0.3 实施交接文档（borrow 1-4+7）

> 面向即将动手的工程师。机制依据见 [hindsight-intel.md](./hindsight-intel.md)；现状代码为 `lib/index.js`（v0.2.1，7 工具 + 生命周期钩子）。
> 每项一个 commit，全部落地后版本升 0.3.0。

---

## ① 乘法组合打分（Recall 排序）

**差距**：现在 `scoreEntry` 是"词条加分 + 新近度加法奖励"——新近度可独立抬分，低相关凭"最近"反超高相关。

**新公式**（照抄 Hindsight 的乘法结构，参数原样）：

```
base     = 0.5 + 0.5 × (matched / terms.length)     // 命中即 0.5 起步，全词命中 1.0
recency  = clamp(1 − days/365, 0.1, 1.0)            // days = (now − ts)/86400000
proof    = clamp(0.5 + ln(proof_count)/10, 0, 1)    // proof_count 缺省 1 → 信号=0.5（中性）
final    = base × (1 + 0.2×(recency − 0.5)) × (1 + 0.1×(proof − 0.5))
```

**改动点**：`scoreEntry(entry, terms, tagFilters, now)`。
- tag 过滤逻辑不变（硬过滤，不在乘法里）。
- 未命中任何 term 返回 −1 的路径保持。
- `noCriteria`（无 query 无 tag）路径不变：按 ts 倒序返回最近（不进乘法打分）。
- `entry.proof_count` 缺省视为 1；`entry.evidence_quotes` 缺省 []。

**离线测试**：
- 两条同词条命中、ts 相差 200 天 → 新者 final 更高但差距被限制（boostR 摆幅 ±20%）。
- proof_count=5 vs 1 → 信号 0.71 vs 0.5，同 base 下前者 ~4% 领先（乘法克制）。
- 全词命中 × base=1.0 × recency=1.0 × proof 中性 = 1.0×1.1×1.0=1.1 上界检查。

**回归风险**：低。现有断言只查 count 与顺序，需新增 2-3 个排序断言。

---

## ② Memory Defense 7→25 类 + redact 三态

**新 `SECRET_PATTERNS`**（顺序即命名优先级；形状对齐 intel §四）：

```js
const SECRET_PATTERNS = [
  { name: 'anthropic_key',      re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai_key',         re: /\bsk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'google_api_key',     re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'google_oauth',       re: /\bya29\.[0-9A-Za-z_-]{20,}\b/ },
  { name: 'xai_key',            re: /\bxai-[A-Za-z0-9]{20,}\b/ },
  { name: 'groq_key',           re: /\bgsk_[A-Za-z0-9]{20,}\b/ },
  { name: 'huggingface_token',  re: /\bhf_[A-Za-z0-9]{20,}\b/ },
  { name: 'replicate_token',    re: /\br8_[A-Za-z0-9]{20,}\b/ },
  { name: 'perplexity_key',     re: /\bpplx-[A-Za-z0-9]{20,}\b/ },
  { name: 'databricks_token',   re: /\bdapi[0-9a-f]{32}\b/ },
  { name: 'aws_access_key',     re: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/ },
  { name: 'digitalocean_token', re: /\bdop_v1_[0-9a-f]{64}\b/ },
  { name: 'github_pat',         re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'github_token',       re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { name: 'gitlab_pat',         re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'npm_token',          re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'stripe_key',         re: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{24,}\b/ },
  { name: 'slack_token',        re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'slack_webhook',      re: /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}\b/ },
  { name: 'twilio_key',         re: /\bS[KA][0-9a-f]{32}\b/ },
  { name: 'sendgrid_key',       re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { name: 'telegram_bot_token', re: /\b\d{8,10}:AA[\w-]{30,}\b/ },
  { name: 'shopify_token',      re: /\bshpat_[0-9a-f]{32}\b/ },
  { name: 'db_connection_url',  re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/ },
  { name: 'private_key_block',  re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'jwt',                re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];
```

**三态 `config.defense`**：`'redact'`（默认，官方同款）| `'block'`（现行为）| `false`（关闭）。

**新扫描函数**（替换现 `scanSecrets` 的调用方式，函数保留返回命中名）：

```js
function defenseApply(cfg, text) {
  if (cfg?.defense === false) return { text, hits: [] };
  const mode = cfg?.defense === 'block' ? 'block' : 'redact';
  let out = text, hits = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(out)) {
      hits.push(p.name);
      if (mode === 'redact') out = out.replace(p.re, `[REDACTED:${p.name}]`);
    }
  }
  if (hits.length && mode === 'block') {
    throw new Error(`tg-memory-bridge: 疑似密钥/凭据（${hits.join(', ')}），已拦截；设 defense:'redact' 可脱敏入库，或 false 关闭`);
  }
  return { text: out, hits };
}
```

**改动点**：`retainOne` 与 `tg_edit.execute` 里现 scan 块替换为 `defenseApply`；redact 后入库的是脱敏文本。离线测试：redact 模式下入库文本含 `[REDACTED:openai_key]`、原值不出现。

**回归风险**：误报（信用卡 16 位 vs 日期串）——JWT/信用卡类误报率最高，故默认 redact 而非 block，用户可三态调整。

---

## ③ digest reconcile 化（观察层快照 → 信念系统）

**数据结构升级**（memory.jsonl 的 digest 条目）：

```js
{ ts, message_id, chat_id, text, tags: ['#digest', ...],
  proof_count: 3,                    // 该 digest 被证据强化的次数（新字段，缺省 1）
  evidence_quotes: [                 // 每次强化的证据短引（新字段）
    { quote: '用户正在验证…', ts: 1793… }
  ] }
```

**tg_digest v2 流程**（替换现 execute 的 LLM 段）：

1. 取旧 digest（最近一条 tags 含 '#digest'）+ pending（ts > lastDigestTs 且非 #digest）。
2. 无旧 digest → 现行为（全量生成新 digest 消息）。
3. 有旧 digest → **reconcile prompt**（全文）：

```
你是记忆对账器。输入：一份已有的观察 digest 全文 + 它之后新增的记忆。
任务：逐条比对新记忆与旧观察，输出一个 JSON 对象（不要 markdown 围栏）：
{
  "action": "reinforce" | "refine" | "new",
  "text": "…",                       // action=refine 时必填：更新后的 digest 全文
  "append_note": "…",                // action=reinforce 时必填：一句佐证短引（≤80字）
  "evidence_quotes": ["…", "…"],     // 本次新增证据的原文短引（≤3 条）
  "insights": ["…", "…"]             // 2-4 条要点
}
判定规则：
- reinforce：新记忆只是佐证旧观察（无新信息）→ text 不变，给 append_note
- refine：新记忆补充/修正/扩展了旧观察 → 给出更新后全文；未受影响的句子逐字保留；
  被修正的旧表述改用"此前以为…现在…"句式保留历史
- new：新记忆开启了旧 digest 完全没有的主题 → text 给出包含新观察的新 digest 全文
语言：与旧 digest 一致（中文）。
```

4. **应用**：
   - `reinforce`：`append_note` 追加到旧 digest 消息尾部（tg_edit），索引条目 `proof_count += 1`、`evidence_quotes.push(...)`；不发新消息。
   - `refine`：`text` 经 tg_edit 原位更新旧 digest 消息；索引同步 text、`proof_count += evidence_quotes.length`、push evidence_quotes。
   - `new`：现行为（sendMessage 新 digest + 入索引）。
5. `lastDigestTs = max(pending ts)` 三种情况都更新。

**离线测试**（mock LLM 三种输出各一）：
- reinforce → tg 未发新消息（mock tgCall 计数：仅 editMessageText）、proof_count+1、append_note 在文本尾部。
- refine → 旧 message_id 的 editMessageText 被调用、索引 text 更新、evidence_quotes 入库。
- new → sendMessage 被调用、新条目入索引。
- 无 pending → 现有路径不回归。

**回归风险**：LLM 输出 JSON 解析失败 → 回退现"全量新 digest"路径（已有 extractJson 容错）；4096 上限 → refine 的 text 超限时截断最旧观察并注明。

---

## ④ 时间前缀增强（~5 行）

**改动点**：`retainOne` 在扫描/发送/入库前：

```js
function stampDate(text, ts = Date.now()) {
  const d = new Date(ts).toISOString().slice(0, 10);
  return /^\[\d{4}-\d{2}-\d{2}\]/.test(text) ? text : `[${d}] ${text}`;
}
```

- 入库与 TG 消息都用带戳文本（保持一致，recall 命中的 text 即 TG 可见文本）。
- `tg_edit` 修改时**不重复加戳**（新 text 若无戳则不加——编辑是用户意志，尊重原文）。仅 retainOne/自动沉淀加。

**离线测试**：retainOne 产物 text 以 `[YYYY-MM-DD] ` 开头；已有戳的输入不双戳。

---

## ⑤ 叙事抽取原则进 auto-capture gate

**新 `autoCaptureTurn` system prompt 全文**（替换现"记忆门卫"prompt）：

```
你是长期记忆抽取器。输入是一段用户消息（可能含此前上下文）。抽取规则（源自
Hindsight 论文的叙事抽取原则）：
1. 粒度：整段对话产出 2-5 条粗粒度"叙事事实"——保留完整的交换、参与者与推理链，
   把碎片化的闲聊合并成一条；宁粗勿碎。
2. 共指消解：代词/昵称解析为同一实体后再写事实（"它/他/那个项目"要落到具体名字）。
3. 时间归一化："上周/明天/刚才是"转写为绝对日期或区间后再入事实。
4. 参与者归属：事实要写清是谁的事实（用户说的 vs agent 做的）。
5. 只留 durable 内容：偏好、决定、项目进展、环境事实；寒暄/过程性碎语丢弃。
只输出一个 JSON 对象：{"facts":[{"text":"…","tags":["#fact"]|["#exp"]}]}；
没有值得记的就输出 {"facts":[]}。事实用原文语言。不要输出任何其他内容。
```

**离线测试**：mock LLM 返回多 facts → 逐条 retain；返回空 facts → 无写入、无异常。

---

## 实施顺序与提交切分

| 顺序 | 内容 | commit message |
|---|---|---|
| 1 | ①+④（都是 scoreEntry/retainOne 小改） | `feat(recall): multiplicative scoring + date stamping (borrowed from TEMPR)` |
| 2 | ② Defense 25 类 + redact 三态 | `feat(defense): 25 secret patterns + redact mode (per Hindsight Memory Defense)` |
| 3 | ⑤ 叙事抽取 gate prompt | `feat(capture): narrative extraction principles in auto-capture gate` |
| 4 | ③ digest reconcile 化（最大件） | `feat(digest): reconcile mode — reinforce/refine/new with in-place edits` |
| 5 | 版本 0.3.0 + README 更新 + 离线测试全绿 | `chore: v0.3.0` |

每步：离线测试先绿再提交；仓库同步 `cp lib/index.js test/offline.mjs`；推送走已配置的 SSH 通路。

## 全局回归风险

- recall 排序变化会影响现有断言的"最新优先"用例——noCriteria 路径不走乘法，保持不变即可。
- digest reconcile 改变 tg_digest 的 LLM 输出契约——旧 mock（digest-e2e.mjs 的 CANNED）需按新契约更新。
- redact 默认化会改变现有文本写入结果——迁移期保持 `'redact'` 为默认但文档注明可 `'block'`。
