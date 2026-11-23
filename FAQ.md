# FAQ / 常见问题

Security and compliance questions about this plugin, answered against the actual code. / 本插件的安全与合规问题，逐条对着代码回答。

## 「你们的 clientInfo 会被 Google 一秒识别，然后封号」

> "If the code honestly reports `name: "dsh-antigravity-acp"`, Google's backend can identify it immediately as an unauthorized third-party agent harness."

**We report our real identity deliberately — that is the approved pattern, not a trap.**

The claim assumes only two options exist: report honestly (detected → banned) or spoof `t3-code` (fraud → banned). The third option is the one T3 Code itself used and was approved for: **report who you really are, and use the API the way the approval covers**. T3 Code's `clientInfo` is not an official IDE either.

Whether Google's backend logs third-party client names at all is **not verifiable from the outside** — `agy` is the party talking to Google's backend, not us. Assertions like "identified in one second" describe a monitoring system nobody outside Google has seen. We do not claim to know what it logs; we claim only that nothing in this plugin gives it a reason to treat the session as abuse *if* the ACP + native-OAuth + single-account pattern is what the T3 Code approval covered.

The spoofing branch does not exist in this codebase and will not be added. Searching for it yourself: `grep -rn "clientInfo" lib/` shows one constant, `DEFAULT_CLIENT = { name: 'dsh-antigravity-acp', version: '0.1.0' }`, used in exactly one place (the `initialize` handshake).

## 「审批桥可以被用户开自动化击穿」

> "Once the user enables auto-approval, thousands of tokens stream back in bursts and the server's anomaly detection lights up."

**True that it can. Wrong that it is a defect of this plugin.**

Two corrections:

1. **Auto-approval is a feature of this ecosystem, not a hole in our bridge.** T3 Code itself ships auto-accept. `agy` itself exposes a `mode` config option — observed in the handshake's `configOptions` — with values `default` / `accept-edits` / `auto` / `plan`, where `auto` is described by the agent itself as "Approve edits and safe commands". Our `permissionMode` setting mirrors that surface; it does not invent it.
2. **What the user authorizes is the user's call, at the user's machine.** The plugin cannot — and should not — second-guess an explicit user configuration. If Google someday signals that auto-approved ACP sessions are treated differently, that changes how we document the modes; it would not be something code could "prevent" anyway.

What the plugin *does* guarantee: in `supervised` mode (the default), every `session/request_permission` is bridged to a real human decision in DSH, and when no approval service is reachable it fails **closed** (deny), never open. See `lib/approval.js`.

## 「你们把 DSH 工具通过 MCP 暴露给 Antigravity，构成智能体指纹」

> "The plugin's core feature is exposing DSH's tools (file tree, terminal) to Antigravity via an MCP bridge."

**This is factually wrong about this codebase — the opposite is true.**

- `session/new` is called with `mcpServers: []` — **no MCP server is registered with Antigravity** (`lib/adapter.js`, `#openSession`).
- When `agy` asks the client to perform file operations (`fs/read_text_file`, `fs/write_text_file`), the plugin **refuses** with JSON-RPC error `-32601` ("file access is DSH's responsibility") — `lib/connection.js` client-request handler.
- The whole point of `lib/system-prompt.js` is to **strip** DSH's tool descriptions out of the system prompt before sending (measured: 1211 → 333 characters), precisely so the agent never reads tool names it cannot call.

No DSH tool schema ever reaches Antigravity. There is no MCP bridge to fingerprint.

### The part of this concern that IS valid

The residue worth admitting is **prompt style**, not tool schemas. What Antigravity sees does carry the texture of a host harness: the injected role preamble ("you are running inside a host program"), `<system>`/`<user>`-tagged incremental messages, compaction summaries fed back as text. A server-side prompt classifier could notice this. We cannot prevent that, and neither can any other ACP bridging implementation — this is exactly the residual risk the "honest risk boundary" note in the README acknowledges. If Google draws the line at prompt-level detection, *every* third-party ACP client crosses it the same way, including the ones that got approved.

## 「这个分析漏掉了真正的安全问题」

Security review of this plugin should look at the **host-machine boundary**, which the above concerns entirely miss:

- `agy acp` runs as a **separate OS process, outside DSH's sandbox**. In `auto` / `full-access` modes it can execute arbitrary commands on your machine. That is true of T3 Code and every ACP coding agent too — but it is the thing to actually evaluate here.
- The plugin reads attachment bytes (`ctx.attachments.readImage`) and writes nothing to disk outside the session cwd; it talks to exactly one child process over stdio and makes no network requests of its own.

If you review this plugin, review that boundary. Prompt-fingerprint speculation is not where the real attack surface is.

---

## 中文

### 「你们的 clientInfo 会被 Google 一秒识别，然后封号」

**上报真实身份是刻意选择，不是陷阱。**

这个说法预设了只有两条路：老实上报（被识别→封号）或伪造 `t3-code`（欺诈→封号）。第三条路是 T3 Code 自己走通并获准的：**如实上报自己是谁，并按获准的方式使用 API**。T3 Code 的 clientInfo 同样不是官方 IDE。

至于 Google 后端是否会记录第三方 client 名字——**从外部完全不可验证**。与 Google 后端通信的是 `agy`，不是本插件。「一秒识别」描述的是一个除 Google 外没人见过的监控系统。我们不声称知道它记录什么；我们只声称：如果 ACP + 原生 OAuth + 单账号正是 T3 Code 获准所覆盖的模式，那么本插件没有任何行为会让会话被当作滥用处理。

伪造分支在这份代码里不存在，也不会加。自行验证：`grep -rn "clientInfo" lib/`——只有一个常量 `DEFAULT_CLIENT`，只在一处（initialize 握手）使用。

### 「审批桥可以被用户开自动化击穿」

**能击穿是真的；说它是本插件的缺陷是错的。**

两点修正：

1. **自动审批是生态的固有形态，不是桥的漏洞。** T3 Code 本身就有 auto-accept。`agy` 本体就暴露 `mode` 配置项（握手 `configOptions` 实测可见）：`default` / `accept-edits` / `auto` / `plan`，其中 `auto` 的官方描述就是「自动批准编辑与安全命令」。本插件的 `permissionMode` 映射的是这个既有面，不是发明的。
2. **用户授权什么，由用户在自己机器上决定。** 插件无法、也不应该二次猜疑用户的显式配置。

插件真正保证的是：`supervised` 模式（默认）下，每次 `session/request_permission` 都桥接到 DSH 里真实的人工决定；审批服务不可达时一律 **fail-closed**（拒绝），绝不放行。见 `lib/approval.js`。

### 「你们把 DSH 工具通过 MCP 暴露给 Antigravity，构成智能体指纹」

**这一条与本代码库的事实相反。**

- `session/new` 传的是 `mcpServers: []`——**不向 Antigravity 注册任何 MCP 服务器**（`lib/adapter.js` 的 `#openSession`）；
- `agy` 反向请求文件操作（`fs/read_text_file`、`fs/write_text_file`）时，插件以 JSON-RPC 错误 `-32601` **拒绝**——`lib/connection.js` 的客户端请求处理；
- `lib/system-prompt.js` 存在的全部意义就是在发送前**剥掉** DSH 工具描述（实测 1211 → 333 字符），让 agent 根本读不到它调不到的工具名。

没有任何 DSH 工具 Schema 到达 Antigravity。不存在可供指纹识别的 MCP 桥。

#### 这个担忧里有效的部分

值得承认的残余是**提示词风格**，不是工具 Schema。Antigravity 看到的内容确实带宿主 harness 的质感：注入的角色说明（「你运行在宿主程序内」）、`<system>`/`<user>` 标签包裹的增量消息、作为文本回灌的压缩摘要。服务端若做提示词分类，是可以察觉的。我们无法阻止这一点，**其他任何 ACP 桥接实现同样无法**——这正是 README 里「诚实的风险边界」承认的残余风险。如果 Google 把线画在提示词层面检测，那么**所有**第三方 ACP 客户端都以同样方式越线，包括那些已获准的。

### 「这份分析漏掉了真正的安全问题」

对本插件做安全审查，应该看的是**宿主机边界**——上面的担忧完全没碰它：

- `agy acp` 以**独立 OS 进程运行在 DSH 沙箱之外**。`auto` / `full-access` 模式下它可以在你的机器上执行任意命令。T3 Code 和所有 ACP coding agent 亦然——但这才是这里真正该评估的东西。
- 本插件读取附件字节（`ctx.attachments.readImage`），除会话 cwd 外不写任何磁盘文件；只与一个子进程经 stdio 通信，自身不发起任何网络请求。

审这个插件，审那条边界。提示词指纹的猜想不是真正的攻击面所在。
