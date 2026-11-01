# hindsight-tg（tg-memory-bridge）

把一个 Telegram 私有群变成 DeepSeek Harness 的外置记忆库。设计思想借鉴
[vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) 的四层记忆模型，
但把存储、检索与可视化全部架在 Telegram 的免费基础设施上：**群消息 = 记忆，置顶消息 = 心智模型**。

> 纯 Node 实现（零第三方依赖），以 DSH cordis 插件形态安装。

## 它解决什么

大多数 agent 记忆方案要求你再养一个数据库/服务。hindsight-tg 把记忆放进你每天在用的聊天软件：

- **人机共读**：模型写入的记忆你在手机上直接可见、可按 hashtag 浏览
- **双入口检索**：模型走本地索引（Bot API 没有搜索接口，实测 8 个候选方法全 404），你走 TG 客户端的聊天内搜索
- **置顶画像卡 = 心智模型**：一条持续原地改写的置顶消息，承载"这个用户是谁/偏好/进行中话题"，每个会话开卷即读

## 六个工具

| 工具 | 作用 |
|---|---|
| `tg_status` | 连通性检查 + 自动发现群 chat_id |
| `tg_retain` | 写入带标签记忆（`#fact`/`#exp` + 项目标签），同时落本地索引 |
| `tg_recall` | 本地索引检索：关键词 + 标签 + 新近度 → 返回 t.me 永久链接 |
| `tg_forget` | 删除记忆：TG 消息撤回 + 本地索引移除（双侧） |
| `tg_edit` | 修改已发送的消息：TG 消息与本地索引同步更新；若目标为置顶卡则同步 cardText |
| `tg_digest` | 整理：把上次整理以来的记忆经 LLM 归纳成 `#digest`（带证据引用）+ 自动重写置顶卡 |
| `tg_pin` | 置顶画像卡整卡重写（心智模型层） |

## 生命周期自动化（借鉴官方 hindsight-coding-agents 的 DSH 集成）

| DSH 事件 | 行为 |
|---|---|
| `agent/session-start` | 就绪会话跟踪 |
| `agent/pre-step` | 把置顶卡 + 最近 `#digest` 注入会话（消息形状照抄官方 `injectionMessage`；**内容变化才注入**） |
| `agent/turn-stopping` | 自动沉淀：LLM 门卫从本轮用户输入提取值得记住的事实 → 自动 `tg_retain`（无 LLM key 时静默降级） |
| `agent/disposed` | 清理会话状态 |

另注入一段"主动记忆守则"系统提示词（何时 retain / recall / 整理 / 先忘再记）。

## 安装

### 前置
1. BotFather 建一个 bot，拿 token
2. 建一个**私有群**，把 bot 拉进去并**设为管理员**（勾选"置顶消息"与"删除消息"权限）
3. BotFather 里把 Group Privacy 关掉（否则 bot 只能收到 @它的消息）

### 安装插件
```bash
git clone https://github.com/JFHSHX/hindsight-tg.git ~/.dsh/plugins/hindsight-tg
cd ~/.dsh/profiles/desktop
pnpm add link:~/.dsh/plugins/hindsight-tg
# 再在 package.json 的 dsh.profile.bundles 数组里加入 "hindsight-tg"
```

### 配置
优先级：`~/.dsh/tg-memory/config.json` > 环境变量 > 补丁 config。

`config.json` 示例（永不入库，已被 .gitignore 覆盖）：
```json
{
  "token": "123456789:AA...",
  "proxy": "socks5://127.0.0.1:10808",
  "chatId": "",
  "llmBaseURL": "https://your-openai-compatible-relay/v1",
  "llmModel": "your-model",
  "llmApiKeyEnv": "NS_API_KEY"
}
```

- `proxy` 支持 `socks5://` 与 `http://`；中国大陆网络访问 api.telegram.org 必须配代理（注意：部分机场节点会在出口侧屏蔽整个 Telegram 域名族，需逐节点实测）
- `chatId` 留空即可——首次运行 `tg_status` 会自动发现群

重启 DSH，新会话里即有 6 个 `tg_*` 工具。

## 四层映射（对 hindsight 思想的复刻）

| Hindsight | 这里 |
|---|---|
| World facts | `#fact` 消息 + 本地索引 |
| Experiences | `#exp` 消息（agent 自己的动作日志） |
| Observations | `#digest` 消息（LLM 归纳 + 证据短引；"脑子"可以是内置中转 LLM、会话子代理或模型自算） |
| Mental models | 置顶画像卡（持续原地改写，开卷即读） |
| Retain / Recall / Reflect | `tg_retain` + 自动沉淀 / `tg_recall` / `tg_digest` 与子代理归纳 |

## 隐私与安全

- **Memory Defense**：所有写入（含自动沉淀）经过密钥/凭据正则扫描（`sk-`/`ghp_`/`AKIA`/`xox`/私钥块/bot token 等 7 类），命中即拒绝写入；配置 `defense: false` 可关闭
- 记忆明文存在 Telegram 服务器上——把它当"个人可见的笔记本"，不要依赖它存敏感内容
- 本仓库不含任何真实 token/chat_id；你的配置在 `~/.dsh/tg-memory/`（已被 .gitignore 覆盖）

## 已知边界（实测）

- Bot API 没有消息搜索/读历史接口，也没有消息删除事件——模型召回只能走本地索引，删除记忆只能走 `tg_forget`
- 索引自 bot 上线起累积，不能回填历史
- 置顶位只有一个（多心智模型卡受 TG 限制）

## License

[MIT](./LICENSE)
