# FAQ / 常见问题

## 安装与登录

### Q: 装好后模型选择器里没有 Antigravity 分组

1. 确认 `agy` 已安装且版本 ≥ 1.5.0：终端运行 `agy --version`。
2. 确认已完成过一次登录：终端运行 `agy models`，能列出模型即已登录；提示 Please sign in 就先在终端跑一次 `agy` 完成浏览器登录。
3. 插件装完后**重启过 DSH** 了吗？bundle 变更必须重启宿主才生效。
4. 都正常还看不到 → 看宿主日志里有没有 `antigravity-acp:` 开头的行，把日志贴到 issue。

### Q: 需要配代理吗？怎么配

`agy` 是 Go 程序，不读 Windows 系统代理。如果你的网络无法直连 Google，必须显式配置：

```yaml
- id: llm-antigravity
  config:
    proxy: http://127.0.0.1:<你本机代理端口>
```

写入 profile 的 `cordis.patch.yml`，然后重启 DSH。设置页的「测代理连通性」按钮可以验证链路。

### Q: 登录状态怎么切换账号

插件**不管理**凭据——账号完全由 `agy` 自己管。切换账号：

- 在终端 `agy` TUI 里执行 `/logout` 再重新登录；
- 或删除凭据：`cmdkey /delete:LegacyGeneric:target=gemini:antigravity`，然后重新登录。

App 与 CLI 共享同一份凭据，登录一次两边都生效。

## 模型

### Q: 为什么模型列表里没有 Claude / GPT

设计如此，不是 bug。Google 官方对 ACP 客户端的表述是模型限于套餐内的 Gemini（见 README「合规性」一节）。本插件默认三层过滤非 Gemini 模型。自行放开（自担合规风险）：

```yaml
- id: llm-antigravity
  config:
    allowNonGeminiModels: true
```

### Q: 模型列表和我 App 里看到的不一样

模型目录是从你账号的套餐动态拉取的（缓存 6 小时）。不同套餐可见模型不同。强制刷新：重启 DSH，或等缓存过期。

### Q: 思考档位怎么调

输入框的模型选择器里，模型名旁边就是思考档位（Low / Medium / High / Extra），与 DeepSeek 模型的强度选择同级。切换档位后下一轮生效。

### Q: Orchestrator 模型是什么，该选吗

Orchestrator (Neon/Argon) 是多模型编排器：调度多个底层模型协作，**token 消耗数倍于单模型**。适合复杂的多步任务；日常问答选普通 Gemini 即可。

## 使用

### Q: 每次工具操作都弹审批窗，太烦了

设置页 → 权限模式 → `auto`（自动批准工具操作）。想完全放行用 `full-access`（注意：agy 是独立进程，运行在 DSH 沙箱之外，full-access 下它执行的命令不受沙箱约束）。

### Q: 对话流里的 `[agy] File ...` 行是什么

Antigravity 用它自己的工具干活时的活动记录（读了/写了哪个文件、跑了什么命令）。嫌吵可在设置页关掉「显示工具活动」。

### Q: 图片怎么发给 Gemini

直接把图片拖进输入框或粘贴即可，和用 DeepSeek 模型一样。图片经附件库直传给 Antigravity。

### Q: 上下文很长了，会全量发给 agy 吗

不会。插件对每条消息做指纹，每轮只发**新增部分**；会话状态由 agy 侧维护。DSH 状态栏显示的百分比是 DSH 侧的完整历史体积，不是发给 agy 的量。

### Q: 额度在哪看

设置页 →「查询额度」。走官方接口，不消耗模型额度。显示三组窗口（5 小时/每周）的剩余百分比。

### Q: 缓存命中为什么显示 0%

ACP 的 `usage_update` 只有总量字段，不回报缓存数据——显示 0% 的意思是「该供应商未回报」，不是「没命中」。

## 故障排查

### Q: 发消息报 ENOENT / agy 启动失败

插件的 agy 路径解析顺序：配置 `command` → `%LOCALAPPDATA%\agy\bin\agy.exe` → `where agy`。全失败才会报错。确认 agy 确实装好了，或在配置里显式写 `command` 绝对路径。

### Q: 回复内容一闪就没了 / 内容重复

升级到 ≥ v0.2.0。这两个现象分别由「block-end 空文本覆盖」和「ACP 快照当增量拼接」两个 bug 造成，v0.2.0 已修复（见 Release 说明）。

### Q: 切模型时报 MODEL_SWITCH_COMPACTION_FAILED

升级到 ≥ v0.2.0。旧版本的模型元数据形状不符合宿主契约（context 未嵌套）导致压缩失败，已修复。

### Q: 跑命令时报 unknown tool

升级到 ≥ v0.2.0。旧版曾把 agy 远端已执行完的工具活动错误产出为 DSH 原生 tool-call 块（宿主会误去查找执行）。已回滚为文本展示。

## 安全与合规

### Q: 这个插件会被封号吗

README「合规性」一节有完整论述，简版：本插件只启动官方未修改的 `agy acp`、以真实客户端身份握手、凭据完全由 agy 自管（插件不碰 token/keyring）、单账号、模型白名单只放行套餐内 Gemini——即 T3 Code 获官方认可时的同一架构。官方明确反对的三件事（提取 token、包装 print 模式进第三方 agent 循环、多账号轮换）一件都没做。

残余风险同样写在 README：架构方向受认可 ≠ 永久书面承诺，官方政策可能变化。用主力账号前自行权衡。

### Q: supervised 模式下工具执行受 DSH 沙箱管吗

**不受。** Antigravity 是独立 OS 进程，工具在沙箱外执行。审批发生在命令**启动之前**——你拦得住每一次调用，但批准之后的执行过程不受 DSH 约束。这与 T3 Code 及所有 ACP coding agent 的行为一致，评估风险时应以此为准。

### Q: 插件自己会联网或读写我的文件吗

不会。插件只与一个子进程（`agy acp`）经 stdio 通信；自身不发起任何网络请求（代理环境变量只传给子进程）；除会话工作目录外不写任何磁盘文件。凭据读写为零。
