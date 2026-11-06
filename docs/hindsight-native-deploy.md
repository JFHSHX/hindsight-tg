# Hindsight Windows 本地部署实录（路线 B）——只有真部署才知道的事

> 整理日期：2026-11-06。来源：生产部署机实测（Windows 11 + PostgreSQL + Hindsight API，**写作时服务正在运行**）+ 部署期排障记录。
> 机制层的参数级侦察见同目录 [hindsight-intel.md](hindsight-intel.md)；本篇只写**官方文档不会告诉你的部分**：实测数字、静默失败、平台特有的坑。
> 所有数字均为部署机（`C:\ds\hindsight-native`）实测，非转述。

## 0. 一句话成果

Windows 原生跑起 Hindsight API + PostgreSQL，embedding 换本地 ONNX 中文模型，worker 常驻内存 **~1.6 GB → 200–350 MB**，中文检索质量升级，记忆数据完全不出本机。健康检查 `/health` 返回 `healthy`，database connected。

## 1. 只有本地部署才能知道的好处

这些是部署前从文档读不到、部署后回不去的：

1. **数据主权是字面意义的**。PostgreSQL 就在你机器上：`pg_dump` 随时备份、`psql` 直查 `memory_units` / `chunks` 表、能手写 SQL 修数据、看向量维度（`vector(512)`）。云托管不给你库权限——本地部署后「记忆库」从黑盒变成一张张可观测的表（实测库量：memory_units 4812 + chunks 689）。
2. **断网可用（LLM 除外）**。embedding 本地 ONNX + PG 本地 + `HF_HUB_OFFLINE=1` → retain / search 全链路离线可跑，只有 reflect / consolidation 需要外部 LLM。断网时记忆「写入与检索」照常，只丢「归纳」。
3. **回环延迟**。embedding 和检索都走 `127.0.0.1`，没有外网往返——search 是毫秒级。云方案每一跳都在付网络延迟。
4. **内存的真实数字**。不部署你不知道 worker 常驻 ~1.6 GB，其中 torch ~1.4 GB 是绝对大头；换本地 ONNX（无 torch）后降到 200–350 MB。任务管理器里的数字比任何 benchmark 都直观。
5. **中文模型的红利**。官方默认英文交叉编码器（ms-marco-MiniLM）对中文记忆基本失效；换 `BAAI/bge-small-zh-v1.5` + `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` 后中文召回是质的提升。**中文记忆库不换模型 ≈ 白部署**。
6. **本地 API 是 agent 生态的插座**。API / dashboard / MCP 全在本机回环（8888 / 9999 / `/mcp`），DSH 插件、脚本、其他 agent 都能直连——记忆库变成「本机服务」而不是「第三方 SaaS」。
7. **隐私的彻底解**。记忆原文不出机器（HF 镜像只下载模型文件），没有第三方服务器留存，合规审查零解释成本。

## 2. 部署踩坑实录（每条都付过学费）

格式：现象 → 根因 → 解法。

### ① torch 的「粘性」
- 现象：只把 reranker 移到 API 服务，worker 内存纹丝不动。
- 根因：**只要还有一个模型走本地 torch，torch 就整个留在 worker**（~1.4 GB）。
- 解法：要省就整体去 torch——embedding 换本地 ONNX（路线 B 核心），torch 彻底退出 worker。

### ② BGE 不是 E5
- 现象：换 `BAAI/bge-small-zh-v1.5` 后检索质量悄悄劣化，**无任何报错**。
- 根因：`ONNX_QUERY_PREFIX` / `ONNX_PASSAGE_PREFIX` 默认值是 E5 系列的前缀（`query:` / `passage:`）。
- 解法：BGE 必须显式置空这两个变量。

### ③ 离线缓存的路径陷阱
- 现象：设了 `HF_HUB_OFFLINE=1` 后启动即找不到模型。
- 根因：模型已缓存在默认位置 `%USERPROFILE%\.cache\huggingface`（~562 MB）；此时把 `HF_HOME` 指到别的空目录 = 离线模式下无处可读。
- 解法：模型已缓存就**别动 `HF_HOME`**；ONNX 图需预下载并用 `ONNX_MODEL_PATH` 显式指定。

### ④ 同维度换 embedding 也要全量重嵌
- 根因：512 维 → 512 维也必须全量重嵌——不同模型的向量空间不互通。
- 量级（实测）：~6K 文本、分钟级、走 API 批量打分约 1 元。换模型前想清楚，成本不高但别频繁换。

### ⑤ API 不热加载模型改动
- 现象：改了 `env.ps1` 里的模型配置，运行中的进程毫无反应。
- 根因：API 启动时读定模型配置，进程存活期内保持旧值。
- 解法：改配置必须走重启链（`启动Hindsight.bat` 或 `start-all-hindsight.ps1`）。「为什么改了没反应」排查第一名。

### ⑥ 慢中转下 reflect 静默超时
- 现象：reflect / consolidation / mental-model 刷新全部没有产出，界面无报错。
- 根因：LLM 默认超时 30 s；走中转网关（慢）时全部超时，且这些是**后台任务，静默失败**，只有 `api.log` 有痕迹。
- 解法：四个 LLM 超时全部调到 300 s，wall-clock 1800 s：
  `HINDSIGHT_API_LLM_TIMEOUT` / `HINDSIGHT_API_REFLECT_LLM_TIMEOUT` / `HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_TIMEOUT` / `HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT` = 300；`HINDSIGHT_API_REFLECT_WALL_TIMEOUT` = 1800。

### ⑦ 云端模型会下线
- 现象：reflect/consolidation 全挂，日志刷 `upstream_404`。
- 根因：NVIDIA NCF 上的 `nemotron-3-super-120b-a12b` 函数直接下线（404）；中转网关还叠加间歇 503（CF 1102）。
- 解法：LLM 供应商按「会消失」设计，预留回退链（实测可用：本地 npg 网关 `http://127.0.0.1:8787/v1` + `moonshotai/kimi-k3`，当日实测 200 / 5.8 s）。换供应商后同样要重启（坑⑤）。

### ⑧ PowerShell 脚本签名是自动化的隐形杀手
- 现象：AllSigned 环境里改一行 `env.ps1` → 脚本拒绝运行（「未对文件进行数字签名」）。
- 根因：任何编辑都会使 Authenticode 签名失效；且签名块对**换行符与编码极其挑剔**——LF 或无 BOM 都会让签名块解析失败（`NotSigned`）。实测某编辑器把 `env.ps1` 重存为 LF 后签名失效。
- 解法（重签全流程）：读文件 → 剥掉 `# SIG #` 签名块 → 编辑 → 归一化为 **CRLF + UTF-8 BOM**（`[System.IO.File]::WriteAllText` + `UTF8Encoding($true)`）→ `Set-AuthenticodeSignature`（自签证书 CN=HindsightLocal，有效期 5 年，导入 `LocalMachine\Root` + `TrustedPublisher`）→ `Get-AuthenticodeSignature` 必须回 `Valid` → 用 `powershell.exe -ExecutionPolicy AllSigned` 点源测试。
- ⚠️ 给自动化工具的警告：DSH 的 edit 工具写 **LF 无 BOM**，被它碰过的已签名 `.ps1` 必须重签。

### ⑨ Windows 上的数据库
- 根因：安装文档假定的 pg0 二进制在 Windows 不适用。
- 解法：直接 `postgres` + `pg_ctl` 手动起库，API 直连 `postgresql://<user>:<pass>@127.0.0.1:5432/hindsight`。

### ⑩ 「全原生」的边界
- 根因：Hindsight 依赖链里的 `v8go` 没有 Windows 支持（cgo 编译不过）。
- 结论：**API + PostgreSQL 可以原生，嵌入 Hindsight 的 agent 运行时仍需 WSL2 / Docker**。部署前想清楚这个边界——「原生部署」是服务原生，不是全家原生。

## 3. 复现步骤（可行动）

### 3.1 关键配置（`env.ps1`，已脱敏）

| 变量 | 值 | 说明 |
|---|---|---|
| `HINDSIGHT_API_LLM_PROVIDER` | `openai` | OpenAI 兼容协议 |
| `HINDSIGHT_API_LLM_API_KEY` | `<redacted>` | 切勿入库/入文档 |
| `HINDSIGHT_API_LLM_BASE_URL` | `<中转网关>/v1` | 建议同时验证一条回退链（坑⑦） |
| `HINDSIGHT_API_LLM_MODEL` | `nvidia/nemotron-3.5-super-vl-120b-a12b` | 随上游存活情况更换 |
| `HINDSIGHT_API_EMBEDDINGS_PROVIDER` | `local` | 路线 B 核心 |
| `HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL` | `BAAI/bge-small-zh-v1.5` | 中文 512 维 |
| `HINDSIGHT_API_RERANKER_PROVIDER` | `local` | 重排外移到 API failover 链是下一步规划 |
| `HINDSIGHT_API_RERANKER_LOCAL_MODEL` | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | 中文重排 |
| `PYTHONUTF8` / `PYTHONIOENCODING` / `PYTHONUNBUFFERED` | `1` / `utf-8` / `1` | Windows 中文环境必需 |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 大陆网络下载模型 |
| `HF_HUB_OFFLINE` | `1` | 模型已缓存后开启（坑③） |
| `HINDSIGHT_API_DATABASE_URL` | `postgresql://<user>:<pass>@127.0.0.1:5432/hindsight` | 本机 PG |
| `HINDSIGHT_API_HOST` / `PORT` | `127.0.0.1` / `8888` | 只听回环 |
| `HINDSIGHT_API_WORKER_MAX_SLOTS` | `10` | 显式固定便于调参 |
| 四个 LLM 超时 / WALL | `300` / `1800` | 见坑⑥ |

### 3.2 启动链（`start-all-hindsight.ps1` 流程）

1. 探活 PostgreSQL（`pg_isready -h 127.0.0.1 -p 5432`），没起先起库（坑⑨）。
2. venv 内 `python -X utf8 -c "from hindsight_api.main import main; main()"` 启动 API。
3. 轮询 `http://127.0.0.1:8888/health` 直到 200。
4. 启动面板（`PORT=9999`），验证 `/dashboard`。
5. API PID 写入 `run\api.pid`（供 stop 脚本按树杀进程）。

一键入口：`启动Hindsight.bat`（管理员运行）；重启链：`stop-hindsight.ps1` → `start-all-hindsight.ps1`。

### 3.3 验证四连（每次改配置后必做）

1. `GET /health` → 200 且 `database: connected`；
2. 打开 `http://127.0.0.1:9999/dashboard`；
3. `POST /mcp` 可达；
4. **金丝雀**：retain 一条 → search 命中 → reflect 跑通（超时参数生效的证明）。

### 3.4 部署节奏

小步验证优先：ONNX 兼容探针（模型能加载、维度对）→ 批量打分小样本（batch 10）→ 改 `env.ps1` → **重签**（坑⑧）→ 重启 → 金丝雀四连。任何一步红了不要进下一步。

## 4. 运维速查

| 项 | 值 |
|---|---|
| API | `http://127.0.0.1:8888`（`/health` 探活） |
| 面板 | `http://127.0.0.1:9999/dashboard` |
| MCP | `http://127.0.0.1:8888/mcp` |
| PID 文件 | `C:\ds\hindsight-native\run\api.pid` |
| 模型缓存 | `%USERPROFILE%\.cache\huggingface`（~562 MB，首次下载 ~500 MB，之后走缓存秒起） |
| 脚本签名 | CN=HindsightLocal 自签证书，重签流程见坑⑧ |
| 库量参考 | memory_units 4812 + chunks 689，`vector(512)` |

## 5. 与本仓库的关系

- [hindsight-intel.md](hindsight-intel.md)：机制层侦察（TEMPR 四路检索、observations 整合、Memory Defense 45 类、论文数字）——**borrow 的依据**。
- 本篇：部署层实录——**borrow 落地（v0.3.0/v0.4.x）过程中反向验证过部署机的真实行为**，也是给「想在 Windows 上自己跑一套 Hindsight」的人的路书。

---

*本文档不含任何密钥；`env.ps1` 中的 key/密码一律 `<redacted>`。部署机细节（路径/证书指纹）保留是为了可复现，请按自己环境替换。*
