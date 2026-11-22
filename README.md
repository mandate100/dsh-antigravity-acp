# dsh-antigravity-acp

把本机 **Google Antigravity CLI** 接入 DeepSeek Harness，作为一级模型供应商。

模型出现在输入框右下角的模型选择器里，与 DeepSeek 等直连 provider 同级。

## 合规性：为什么这样写不会被封号

本插件是 [T3 Code](https://github.com/pingdotgg/t3code) 已获官方认可架构的复刻：
**官方 ACP 协议 + 原生 OAuth + 单账号交互使用**。Google 官方在论坛明确答复过，
T3 Code 获准的原因正是这套架构（见下方链接）。

本插件对 T3 模式的复刻是逐条对应的：

| T3 Code 的做法 | 本插件 |
|---|---|
| 走官方 `acp` 模式，不包装 print 模式 | ✅ 只启动官方未修改的 `agy acp` |
| 客户端以真实身份握手，不伪装 | ✅ 真实 `clientInfo`，不伪造 User-Agent |
| 用户自己的 OAuth 登录态 | ✅ 凭据由 `agy` 自己管理，插件**从不读写** token/keyring |
| 单用户交互式使用 | ✅ 单账号、无账号池、无自动化轮换 |
| agent 用自己的工具，宿主只管审批 | ✅ 工具放权给 Antigravity，许可请求转发 DSH 弹窗 |
| 模型限于套餐内 | ✅ 硬性 Gemini 白名单，超出的模型不可见也不可调 |

**官方明确反对的三件事，一件都没做**：

1. ❌ 提取或代理 OAuth token（插件连凭据文件都不碰）
2. ❌ 把 `agy -p` 包进第三方 agent 循环（走的是 `acp` 模式，且审批流完整保留）
3. ❌ 自动化多账号轮换（单账号，这是设计选择）

### 关于模型白名单（重要）

Google 官方对 ACP 客户端的表述是：

> model selection in ACP clients is **limited to the Gemini models** included in your plan

但实测 `agy acp` 会下发 **9 个模型**，其中包含 `claude-opus-5-5`、
`claude-sonnet-5-5`、`gpt-oss-120b-medium`——三者都真实可用，不是摆设。

这些超出了官方描述的范围。为保持与官方表述一致，本插件在**三个位置**做了拦截：

1. `listModels()` —— 过滤，不进入 DSH 模型选择器
2. `stream()` —— 直接派发也拒绝，抛 `[AUTH]`
3. 日志会记录被过滤掉了哪些

默认行为就是只放行 Gemini。想放开必须显式设置：

```yaml
- id: llm-antigravity
  config:
    allowNonGeminiModels: true   # 自行承担合规判断
```

### 官方依据与风险边界

- [T3 Code 获准，因为是「官方 ACP + 原生 OAuth」架构](https://discuss.ai.google.dev/t/tos-clarification-is-t3-code-official-antigravity-acp-agent-permitted-under-the-antigravity-terms-of-service/192027)
- [官方 FAQ：包装 `agy` 进第三方 agent 循环、自动化账号轮换不被支持](https://antigravity.google/docs/faq)

> **诚实的风险边界**：ACP 路线被单独认可（T3 Code 案例）说明这个架构方向是被接受的，
> 但「受认可」不等于**永久书面承诺**——官方政策随时可能更新。本插件已按最保守方式实现
> （官方二进制、真实身份、单账号、模型白名单），把所有已知的封号触发条件都排除在外了，
> 但用主力 Google 账号前请自行权衡，并关注官方 FAQ 的更新。

## 工作方式

```
DSH agent loop
    │  GenerateOptions
    ▼
AntigravityAdapter
    │  JSON-RPC over stdio（ACP v1）
    ▼
agy acp  ← 官方未修改的二进制
    │
    ├─ 用自己的工具读写文件、跑命令（已放权）
    │
    └─ 需要许可时 → session/request_permission → 适配器 → DSH 审批
    │
    ▼
Antigravity 后端（你的 Google 账号）
```

### 工具与审批（T3 Code 式）

本插件的做法与 [T3 Code](https://github.com/pingdotgg/t3code) 一致：
**agent 用它自己的工具干活，宿主只在需要许可时介入。**

| 权限模式 | 行为 | 对应 T3 的 |
|---|---|---|
| `supervised`（默认） | 每次权限请求都转发到 DSH 审批弹窗，你点了才执行 | Supervised |
| `auto` | 自动批准 | Auto-accept / Auto |
| `full-access` | 完全放行 | Full access |

**注意**：Antigravity 的工具在 DSH 沙箱**之外**运行（它是独立进程）。
supervised 模式让你能拦住每一次调用，但拦不住的是「它已经在跑的命令」——
审批发生在命令启动之前，一旦批准，执行过程不受 DSH 约束。

工具活动会以 `[agy] ...` 的形式写进对话流，例如：

```
[agy] File proof.txt (in_progress)
[agy] File /path/to/proof.txt (completed) 修改了 /path/to/proof.txt（约 1 行）
```

设置 `showToolActivity: false` 可关闭。

**DSH 自己的工具不下发**给 Antigravity。它用自己的那套，两边不混。

### System Prompt 清洗

DSH 的 system prompt 会详细描述它自己的工具（pwsh / read / write / edit ...），
但这些工具**不会**下发给 Antigravity。原样转发会让它读到「你有 pwsh」却调不到——
实测中它靠自身容错能绕过去，但这是「模型碰巧没上当」，不是设计保证。

本插件因此在发送前做两件事（`lib/system-prompt.js`，纯函数可单测）：

1. **剥掉宿主工具小节**：`## Tools` 整段、`### pwsh` 这类小标题、
   `Parameters: {...}` 参数块、「你可以调用 pwsh」之类的行
2. **注入角色说明**：告知它运行在宿主程序内、宿主工具不可用、
   需要操作文件时用自己内置的工具

实测效果：1211 字符的 DSH 风格 system 清洗后剩 333 字符（剥离 1032），
Workspace、回复语言等业务约定完整保留，Antigravity 行为无退化。

关闭方式：`sanitizeSystemPrompt: false`。指纹基于清洗后的文本计算，
因此 DSH 端工具列表的无关变化不会误触发会话重建。


## 安装

前提：已安装官方 `agy`（>= 1.5.0）并在终端跑过一次完成登录。

```powershell
# clone 到任意目录
git clone https://github.com/<你>/dsh-antigravity-acp.git
cd dsh-antigravity-acp

# 以 link 方式装进 desktop profile
dsh plugin --profile desktop add <clone 目录>
```

重启后，模型选择器出现 **Antigravity (ACP)** 分组。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `antigravity` | 路由 id |
| `displayName` | `Antigravity (ACP)` | 模型菜单分组名 |
| `command` | 空 | `agy` 绝对路径；留空用 PATH |
| `extraArgs` | `[]` | 追加给 `agy acp` 的参数 |
| `cwd` | 空 | 会话工作目录；留空用进程 cwd |
| `proxy` | 空 | 给子进程的 `HTTP_PROXY`/`HTTPS_PROXY` |
| `noProxy` | `localhost,...` | 不走代理的主机 |
| `contextWindow` | `1048576` | 声明的上下文窗口 |
| `timeoutMs` | `600000` | 单次提示词超时 |
| `catalogTtlMs` | `21600000` | 模型目录缓存（6 小时） |
| `models` | `[]` | 目录拉取失败时的兜底 id |
| `allowNonGeminiModels` | `false` | 是否放开非 Gemini 模型（合规白名单，见下） |
| `permissionMode` | `supervised` | `supervised` / `auto` / `full-access`，权限处理方式 |
| `showToolActivity` | `true` | 是否把工具调用写进对话流 |
| `sanitizeSystemPrompt` | `true` | 剥掉 system 里的宿主工具描述，避免 Antigravity 误认领它调不到的工具 |

**国内网络必须配代理** —— `agy` 是 Go 程序，不读 Windows 系统代理：

```yaml
- id: llm-antigravity
  config:
    proxy: http://127.0.0.1:17890
```

## 能力

| 项目 | 状态 |
|---|---|
| 流式文本 | ✅ |
| 思考流（reasoning） | ✅ 映射 `agent_thought_chunk` |
| 思考档位 | ✅ low / medium / high / xhigh |
| 模型目录 | ✅ 从 ACP `configOptions` 动态读取 |
| 上下文窗口 | ✅ 声明 1M |
| token 用量 | ⚠️ 用 ACP 的 `usage_update`（累计值，非单步） |
| 会话复用 | ✅ 前缀比对，只发增量 |
| 取消 | ✅ 转 `session/cancel` |
| **工具调用** | ✅ **Antigravity 用自己的工具，能读写文件/跑命令** |
| **权限审批** | ✅ supervised 模式转发到 DSH 弹窗 |
| 工具活动展示 | ✅ `[agy] ...` 写入对话流，可关 |
| 图片输入 | ✅ 经 `attachments` 读附件字节，组装 ACP image block 直传；读取失败降级为占位 |

## 已知限制

- **模型列表来自你这个账号**：不同套餐可见模型不同，插件不硬编码。
- **ACP 不提供采样参数**：`temperature`、`stop`、`maxTokens` 不生效。
- **每次进程重启是新连接**：会话在连接内复用；连接断开即重建。
- **无 reasoning delta 之外的思考内容**：ACP 只给文本增量。
- **单账号**：这是设计选择，不是缺陷。

## 验证

```powershell
# 离线验证（直接驱动 adapter，不装进 DSH）
node tests/offline.mjs
```

覆盖：模型发现、流式 chunk 序列、增量复用、历史分叉重建、取消。

## 许可

MIT。Google Antigravity 是 Google 的独立产品，不随本包分发。
