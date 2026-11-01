# Telegram 群记忆桥（DSH MCP 工具）— 设计笔记

## 核心思路
把一个 Telegram 私有群当作 DSH 的外置记忆库：
- **写**：`tg_retain` 通过 Bot API 发带标签消息（`#fact` / `#exp` / `#digest`），人可在 TG 客户端按 hashtag 浏览搜索
- **读**：Bot API 没有 search 接口（bot 也不能读历史），所以**写入的同时**落一份到本地 SQLite FTS5 索引，`tg_recall` 查本地索引返回文本 + `t.me` 永久链接
- **心智模型**：群置顶消息 = "用户画像卡"，用 `editMessageText` 持续改写（数据库直读，零 LLM 零检索）
- **观察整合**（二期）：定时把本周 `#fact`/`#exp` 总结成一条 `#digest` 消息，带证据引用

## 四层映射（源自 Hindsight 的设计）
| Hindsight 层 | TG 原语 |
|---|---|
| World facts | `#fact` 消息 |
| Experiences | `#exp` 消息（bot 自己的动作日志） |
| Observations | `#digest` 汇总消息（带证据链引用） |
| Mental models | 置顶消息（持续改写的画像卡） |
| Bank | 一个群 = 一个 bank（隔离天然严格） |

## 工具面（MCP server，stdio）
- `tg_retain(text, tags?)` → sendMessage + 入索引；返回 msg_id + permalink
- `tg_recall(query, tag?, limit?)` → FTS5 检索（RRF 不需要，先 BM25/FTS + 时间排序）；返回命中 + permalink
- `tg_pin(card_md)` → 发送/改写置顶卡（记录 pinned message_id 于 meta 表）
- `tg_digest_status()`（二期）→ 未整合事实统计

## 约定
- 标签即记忆类型：`#fact` `#exp` `#digest` + 项目标签如 `#hindsight-tg`
- 单条 ≤4096 字符；同群限速 ~20 条/分钟（写入场景无感）
- 隐私：密钥类内容禁止写入（不校验 PII，靠约定，二期可加 45 模式扫描的简化版）
- 中文 FTS5：默认 unicode61 对 CJK 不按词切分 → 用 trigram tokenizer 或入库时按 2-gram 切
- 历史边界：索引从 bot 上线起有内容；Bot API 不能回填历史（Telethon/MTProto 是另一量级，不做）

## Bot 设置要求（<your-bot>）
- Allow Groups: 开
- Group Privacy: **关**（开=只收提及/回复/命令，收不到群里其他消息）
- 建议设为群管理员（管理员天然收全部消息，且置顶需要管理员权限）

## 待定
- getUpdates 轮询器（用户手机打字 → 进索引）放一期还是二期

## digest 的三条"脑子"路线（2026-11-01 定）
1. **内置 tg_digest 工具**：插件内直连 OpenAI 兼容中转（llmBaseURL + NS_API_KEY）——免思考，但依赖 DSH 主进程环境有 key
2. **会话子代理**：模型派 subagent 读 memory.jsonl 自行归纳 → tg_retain #digest + tg_pin——无 key 依赖，质量最高（子代理自带完整会话上下文）✅ 本次开发过程记忆即用此路线
3. **模型自算**：当前会话的模型直接归纳写入——最轻
主动记忆守则（PROACTIVE_PROMPT）已写明三条路线，模型按场景自选。

## 已实测的技术事实（已写入记忆群事实层）
- Bot API 无 search/读历史方法（8 个候选方法全 404）；Secretary Mode 只做账号托管，同样无检索 API
- 机场节点会在出口侧屏蔽 Telegram 域名族（google 通、TG TLS 被拒 exit 35）
- profile cordis.patch.yml 会被应用重写——插件配置必须放包内补丁
- 插件注册工具的正解：ctx.inject(['tools'], cb)；系统提示词：ctx.inject(['systemPrompt'], cb) + section({name, order, text})
- **JSON 解析坑（两次踩到）**：工具参数里传纯 JSON 文本会被反序列化成对象参数（write 工具写 package.json 失败）；子代理回传纯 JSON 同样被误判。可靠解法：外面包代码围栏，或改用 bash heredoc
