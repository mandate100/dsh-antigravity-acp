/**
 * AntigravityAdapter —— 实现 DSH 的 LlmAdapter 契约，底层通过官方 `agy acp` 通信。
 *
 * 一端是 DSH 的 GenerateOptions / StreamChunk，另一端是 ACP 的 session/prompt 与
 * session/update。工具调用不在此层：DSH 的 tools 不会下发（ACP print 模式下没有
 * 审批者），Antigravity 自己的工具也在会话创建时被关掉。
 */
import { AcpConnection, AcpError } from './connection.js'
import {
  decideReuse, fingerprintMessage, fingerprintSystem,
  mapStopReason, renderPrompt, renderContent,
} from './session.js'
import {
  askApproval, buildPermissionReply, describePermissionRequest,
} from './approval.js'
import { buildSystemForAntigravity } from './system-prompt.js'
import { createDeltaExtractor } from './stream-delta.js'

const DEFAULT_CLIENT = { name: 'dsh-antigravity-acp', version: '0.1.0' }

/**
 * 模型准入白名单。
 *
 * Google 官方对此有明确表述：ACP 客户端「in ACP clients is limited to the
 * Gemini models included in your plan」。`agy acp` 实测会下发 9 个模型
 * （含 Claude 与 GPT-OSS），但那超出了官方描述的范围。
 *
 * 为把风险降到零，这里默认只放行 Gemini 家族的模型；其它模型即使
 * 后端下发了，也不出现在 DSH 的选择器里、更不会被派发。
 *
 * 想放开时显式设置 `allowNonGeminiModels: true`，并自行承担合规判断。
 */
const GEMINI_MODEL_PATTERN = /^gemini-/i

/** 判断某个模型 id 是否在允许范围内。 */
function isModelAllowed(modelId, allowNonGemini) {
  if (allowNonGemini) return true
  return GEMINI_MODEL_PATTERN.test(String(modelId ?? ''))
}


/** 把 ACP 错误归类成 DSH 可识别的失败码。 */
function classifyError(err) {
  const msg = String(err?.message ?? err)
  if (err?.code === -32000 || /auth_required|not logged in|sign in|unauthorized|401|403/i.test(msg)) {
    return 'AUTH'
  }
  if (/quota|rate limit|429|resource_exhausted|exhausted/i.test(msg)) return 'QUOTA'
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return 'TIMEOUT'
  if (/ECONNREFUSED|ENOENT|spawn|exited|EPIPE/i.test(msg)) return 'TRANSPORT'
  return 'SERVER'
}

export class AntigravityAdapter {
  #conn = null
  #connecting = null
  #resolvedCommand = null
  #sessions = new Map()   // sessionId -> { sentFingerprints, systemFingerprint, model, thoughtLevel }
  #catalog = null
  #catalogAt = 0
  // ACP 的权限请求不带 sessionId 时，用当前正在跑的会话兜底
  #currentSessionId = null
  #currentSignal = null

  /** 设置页展示用：最近一次发现的模型目录（只读）。 */
  get catalogModels() {
    return this.#catalog?.models ?? []
  }

  constructor({ options, logger, ctx }) {
    this.options = options
    this.logger = logger
    this.ctx = ctx
  }

  /**
   * 权限模式。
   *  - supervised（默认）：逐次转发给 DSH 审批界面
   *  - auto：自动批准（对应 T3 的 Auto-accept / Auto）
   *  - full-access：完全放行
   */
  get permissionMode() {
    const m = String(this.options.permissionMode ?? 'supervised').toLowerCase()
    if (m === 'auto' || m === 'full-access' || m === 'supervised') return m
    return 'supervised'
  }

  /**
   * 处理一次 ACP 权限请求。
   * @returns {Promise<object>} 要回给 agy 的 reply 负载
   */
  async #decidePermission(params, sessionId, signal) {
    const mode = this.permissionMode
    if (mode === 'auto' || mode === 'full-access') {
      return buildPermissionReply(params, 'allow')
    }

    // supervised：交给 DSH 审批
    const description = describePermissionRequest(params)
    const verdict = await askApproval({
      ctx: this.ctx,
      sessionId,
      toolName: description,
      reason: `Antigravity 请求执行：${description}`,
      signal,
    })

    if (verdict === 'allow') {
      this.logger?.debug?.('antigravity-acp: 审批通过 - ' + description)
      return buildPermissionReply(params, 'allow')
    }

    if (verdict === 'unavailable') {
      this.logger?.warn?.(
        'antigravity-acp: 审批服务不可用或不在 turn 内，按拒绝处理 - ' + description,
      )
    } else {
      this.logger?.debug?.('antigravity-acp: 用户拒绝 - ' + description)
    }
    return buildPermissionReply(params, 'deny')
  }

  // ---------------------------------------------------------------- provider
  providerInfo(provider) {
    return { id: provider, name: this.options.displayName || 'Antigravity (ACP)' }
  }

  /**
   * 返回该路由的重试策略。
   *
   * ACP 的错误语义与 HTTP provider 不同：认证失败、额度耗尽都不该自动重试，
   * 而瞬时网络问题值得重试。宿主会读取这个方法的返回值。
   */
  providerRetryPolicy() {
    return {
      maxAttempts: 3,
      // 只有传输层与超时值得重试；AUTH / QUOTA / SERVER 语义错误不重试
      retryableCodes: ['TRANSPORT', 'TIMEOUT'],
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      jitter: true,
    }
  }

  /**
   * 图片请求的计费信息。ACP 目前不下发图片，也不区分计价，
   * 因此显式声明「无」，让宿主使用自己的中性估算。
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * 图片请求的目标尺寸。本适配器不发送图片，返回原样即可。
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  #env() {
    const env = { ...process.env }
    // agy 是 Go 程序，只认环境变量，不读注册表代理
    if (this.options.proxy) {
      env.HTTP_PROXY = this.options.proxy
      env.HTTPS_PROXY = this.options.proxy
      env.http_proxy = this.options.proxy
      env.https_proxy = this.options.proxy
      env.NO_PROXY = this.options.noProxy || 'localhost,127.0.0.1,::1'
    }
    return env
  }

  /** 解析 agy 的绝对路径（宿主 PATH 不一定包含 agy 的安装目录）。 */
  async #resolveCommand() {
    if (!this.#resolvedCommand) {
      const { resolveAgyCommand } = await import('./resolve-agy.js')
      this.#resolvedCommand = await resolveAgyCommand(this.options.command, { env: this.#env() })
      if (this.#resolvedCommand !== (this.options.command || 'agy')) {
        this.logger?.info?.(`antigravity-acp: agy 命令解析为 ${this.#resolvedCommand}`)
      }
    }
    return this.#resolvedCommand
  }

  #args() {
    const args = ['acp']
    if (this.options.extraArgs?.length) args.push(...this.options.extraArgs)
    return args
  }

  // ---------------------------------------------------------------- connection
  async #ensureConnection() {
    if (this.#conn && !this.#conn.closed) return this.#conn
    if (this.#connecting) return this.#connecting

    this.#connecting = (async () => {
      const command = await this.#resolveCommand()
      const conn = new AcpConnection({
        command,
        args: this.#args(),
        cwd: this.options.cwd || undefined,
        env: this.#env(),
        logger: this.logger,
      })

      // agent 反向请求
      conn.on('request', async (id, method, params) => {
        if (method === 'session/request_permission') {
          // 需要知道是哪个会话，才能反查 Agent 去问审批
          const sid = params?.sessionId ?? this.#currentSessionId
          try {
            const reply = await this.#decidePermission(params, sid, this.#currentSignal)
            conn.reply(id, reply)
          } catch (err) {
            this.logger?.warn?.('antigravity-acp: 审批处理异常: ' + (err?.message ?? err))
            conn.reply(id, buildPermissionReply(params, 'deny'))
          }
          return
        }
        if (method === 'fs/read_text_file' || method === 'fs/write_text_file') {
          conn.replyError(id, -32601, '文件访问由 DSH 负责，ACP 客户端不代理文件系统')
          return
        }
        conn.replyError(id, -32601, `不支持的客户端方法: ${method}`)
      })

      const init = await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: this.options.clientInfo || DEFAULT_CLIENT,
      }, { timeoutMs: 60_000 })

      this.logger?.info?.(`antigravity-acp: 已连接 ${init.agentInfo?.name ?? 'agy'} ${init.agentInfo?.version ?? ''}`)
      this.#conn = conn
      this.#connecting = null

      conn.on('exit', () => {
        this.#conn = null
        this.#sessions.clear()
      })

      return conn
    })()

    return this.#connecting
  }

  // ---------------------------------------------------------------- catalog
  async #loadCatalog(force = false) {
    const ttl = this.options.catalogTtlMs ?? 6 * 60 * 60 * 1000
    if (!force && this.#catalog && Date.now() - this.#catalogAt < ttl) return this.#catalog

    const conn = await this.#ensureConnection()
    // 用一次性会话读 configOptions（这也是唯一能拿到模型列表的稳定途径）
    const tmp = await conn.request('session/new', {
      cwd: this.options.cwd || process.cwd(),
      mcpServers: [],
    }, { timeoutMs: 60_000 })

    const models = []
    const blocked = []
    let thoughtLevels = []
    for (const opt of tmp.configOptions ?? []) {
      if (opt.id === 'model') {
        for (const choice of opt.options ?? []) {
          const id = choice.value ?? choice.id
          if (!isModelAllowed(id, this.options.allowNonGeminiModels)) {
            blocked.push(id)
            continue
          }
          models.push({
            id,
            name: choice.name ?? choice.label ?? id,
            provider: this.options.provider,
          })
        }
      }
      if (opt.id === 'thought_level') {
        thoughtLevels = (opt.options ?? []).map((c) => c.value ?? c.id)
      }
    }

    if (blocked.length > 0) {
      this.logger?.info?.(
        `antigravity-acp: 已按合规白名单过滤掉 ${blocked.length} 个非 Gemini 模型: ${blocked.join(', ')}`,
      )
    }

    try { await conn.request('session/close', { sessionId: tmp.sessionId }, { timeoutMs: 15_000 }) } catch { /* 忽略 */ }

    this.#catalog = { models, thoughtLevels }
    this.#catalogAt = Date.now()
    return this.#catalog
  }

  async listModels() {
    try {
      const cat = await this.#loadCatalog()
      return cat.models
    } catch (err) {
      this.logger?.warn?.('antigravity-acp: 拉取模型目录失败: ' + err.message)
      return this.options.models ?? []
    }
  }

  /** agy thought_level → DSH 档位名的展示名。 */
  static #effortName(id) {
    return {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra',
      max: 'Max',
      minimal: 'Minimal',
      off: 'Off',
    }[id] ?? id
  }

  async resolveModel(provider, model) {
    const cat = await this.#loadCatalog().catch(() => null)
    const hit = cat?.models.find((m) => m.id === model)
    const efforts = (cat?.thoughtLevels ?? ['low', 'medium', 'high'])
      .map((l) => ({ id: l, name: AntigravityAdapter.#effortName(l) }))
    // agy 的默认档位是 high（session/new 的 currentValue 实测），标注 defaultEffort
    const defaultEffort = cat?.thoughtLevels?.includes('high') ? 'high' : efforts[0]?.id
    return {
      provider,
      id: model,
      name: hit?.name ?? model,
      // 宿主契约：容量必须嵌套在 context 里（normalizeModelInfo 只认 resolved.context.contextWindow）
      context: { contextWindow: this.options.contextWindow ?? 1_048_576 },
      // 宿主契约：reasoning.efforts 渲染模型选择器的思考强度下拉
      reasoning: {
        efforts,
        ...(defaultEffort ? { defaultEffort } : {}),
      },
      // Gemini 系列支持图片输入；宿主据此放行图片附件
      inputModalities: ['text', 'image'],
    }
  }

  /**
   * 把「模型元数据」与「实际派发」绑定到同一代配置，避免设置变更后
   * 把一代的能力和另一代的端点混用。
   */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    }
  }

  // ---------------------------------------------------------------- sessions
  async #openSession(model, thoughtLevel, cwd) {
    const conn = await this.#ensureConnection()
    const res = await conn.request('session/new', {
      cwd: cwd || this.options.cwd || process.cwd(),
      mcpServers: [],
    }, { timeoutMs: 90_000 })

    const sessionId = res.sessionId
    const sets = []
    if (model) sets.push({ id: 'model', value: model })
    if (thoughtLevel) sets.push({ id: 'thought_level', value: thoughtLevel })
    for (const s of sets) {
      try {
        await conn.request('session/set_config_option', {
          sessionId, configId: s.id, value: s.value,
        }, { timeoutMs: 30_000 })
      } catch (err) {
        this.logger?.debug?.(`antigravity-acp: 设置 ${s.id}=${s.value} 失败: ${err.message}`)
      }
    }
    return { conn, sessionId }
  }

  async #closeSession(sessionId) {
    const conn = this.#conn
    if (!conn || conn.closed) return
    try {
      await conn.request('session/close', { sessionId }, { timeoutMs: 15_000 })
    } catch { /* 已失效，忽略 */ }
    this.#sessions.delete(sessionId)
  }

  /**
   * 唯一的必需方法：把一次 DSH 调用流式转换。
   */
  async *stream(options) {
    const { model, messages = [], system, signal } = options
    const reasoningEffort = options.reasoningEffort
    const cwd = this.options.cwd || process.cwd()

    // 第二道防线：即使调用方绕过模型选择器直接指定，也不派发非白名单模型
    if (!isModelAllowed(model, this.options.allowNonGeminiModels)) {
      const err = new Error(
        `[AUTH] 模型 "${model}" 不在合规白名单内。` +
        `本插件默认只允许 Gemini 系列（官方对此有明确表述）。` +
        `如确需使用，请显式设置 allowNonGeminiModels: true。`,
      )
      err.code = 'AUTH'
      throw err
    }

    const fingerprints = messages.map(fingerprintMessage)
    // 清洗：剥掉 DSH 工具描述、注入「用你自己的工具」的角色说明。
    // 指纹必须基于清洗后的文本，否则 DSH 端工具列表的无关变化
    // （比如新增一个工具）会误判为 system 变化而重建会话。
    const { text: cleanSystem, removed: sysRemoved } =
      buildSystemForAntigravity(system, { enabled: this.options.sanitizeSystemPrompt !== false })
    if (sysRemoved > 0) {
      this.logger?.debug?.(`antigravity-acp: system 清洗剥离了 ${sysRemoved} 字符的宿主工具描述`)
    }
    const sysFp = fingerprintSystem(cleanSystem)

    // 找一个可复用的会话：model 与 reasoningEffort 都必须一致，
    // 否则旧会话的 thought_level 会让新档位静默失效
    let sessionId = null
    let isFirstTurn = true
    let sentFingerprints = []
    for (const [sid, st] of this.#sessions) {
      if (st.model !== model) continue
      if ((st.reasoningEffort ?? '') !== (reasoningEffort ?? '')) continue
      const decision = decideReuse(st, fingerprints, sysFp)
      if (decision.reuse) {
        sessionId = sid
        isFirstTurn = false
        sentFingerprints = st.sentFingerprints
        this.logger?.debug?.(`antigravity-acp: 复用会话 ${sid}，新增 ${decision.newCount} 条`)
        break
      }
    }

    let conn
    if (!sessionId) {
      const opened = await this.#openSession(model, reasoningEffort, cwd)
      conn = opened.conn
      sessionId = opened.sessionId
      isFirstTurn = true
      sentFingerprints = []
    } else {
      conn = this.#conn
    }

    const incremental = isFirstTurn ? messages : messages.slice(sentFingerprints.length)
    const { text: promptText, images: promptImages } = renderPrompt({
      messages: incremental,
      system: cleanSystem,
      isFirstTurn,
      startIndex: isFirstTurn ? 0 : sentFingerprints.length,
    })
    // 有图片时经 attachments 读取字节，组装 ACP image block；
    // 读不到就降级为占位文本，绝不静默丢图。
    const promptBlocks = [{ type: 'text', text: promptText }]
    if (promptImages.length > 0) {
      const attachments = this.ctx?.attachments
      if (attachments && typeof attachments.readImage === 'function') {
        for (const ref of promptImages) {
          try {
            const stored = await attachments.readImage(ref)
            promptBlocks.push({
              type: 'image',
              data: Buffer.from(stored.data).toString('base64'),
              mimeType: stored.ref?.mediaType ?? ref.mediaType ?? 'image/png',
            })
          } catch (err) {
            this.logger?.warn?.(`antigravity-acp: 读取图片附件失败（${ref.attachmentId ?? '?'}），已降级为占位: ` + (err?.message ?? err))
            promptBlocks.push({ type: 'text', text: '[图片附件读取失败]' })
          }
        }
      } else {
        this.logger?.warn?.('antigravity-acp: attachments 服务不可用，图片降级为占位文本')
        promptBlocks.push({ type: 'text', text: '[图片附件：本环境无法直传]' })
      }
    }

    // 记录本轮已发送内容，供下一次前缀比对
    this.#sessions.set(sessionId, {
      model,
      reasoningEffort: reasoningEffort ?? '',
      systemFingerprint: sysFp,
      sentFingerprints: fingerprints.slice(),
    })
    // 清理同模型的旧会话，避免连接上堆积
    for (const [sid, st] of [...this.#sessions]) {
      if (sid !== sessionId && st.model === model && (st.reasoningEffort ?? '') === (reasoningEffort ?? '')) {
        this.#closeSession(sid).catch(() => {})
      }
    }

    // ---- 流式事件桥接 ----
    const queue = []
    let done = false
    let resolveWaiter = null
    const push = (item) => { queue.push(item); resolveWaiter?.(); resolveWaiter = null }

    // 让权限请求能回溯到「当前正在跑哪个会话」
    this.#currentSessionId = sessionId
    this.#currentSignal = signal

    // 工具调用的可见性：同一 toolCallId 只播报开始与结束，避免刷屏
    const seenToolCalls = new Map()
    const showTools = this.options.showToolActivity !== false

    // ACP chunk 可能是增量、累积快照或段重置的混合形态；
    // 用前缀探测归一为真增量，避免文本翻倍/重复/最终被清空
    const textDelta = createDeltaExtractor()
    const thoughtDelta = createDeltaExtractor()

    /**
     * 把一个 tool_call 事件描述成一行展示文本。
     *
     * ⚠️ 仅用于「agy 远端已执行完的工具活动」的展示层折叠——不是模型
     * 请求宿主执行的工具（后者才走原生 tool-call 块）。
     *
     * ACP 里的字段并不统一：title 是给人看的，rawInput 是入参，
     * rawOutput 常是空对象（结果在 content 数组）。
     */
    const describeToolCall = (u) => {
      const title = u.title || u.name || u.kind || '工具操作'
      const parts = [String(title)]

      // 关键入参摘要。若 title 里已经包含该信息就不重复显示。
      const input = u.rawInput ?? u.args ?? {}
      const hint =
        input.command ??
        input.Path ??
        input.path ??
        input.file_path ??
        input.Query ??
        input.query
      if (hint) {
        const s = String(hint)
        const baseName = s.split(/[\\/]/).pop() ?? s
        const alreadyShown = title.includes(s) || (baseName.length > 3 && title.includes(baseName))
        if (!alreadyShown) {
          parts.push(s.length > 120 ? s.slice(0, 117) + '…' : s)
        }
      }

      const status = String(u.status ?? '')
      if (status) parts.push(`(${status})`)
      return parts.join(' ')
    }

    /** 从 content 数组里提取可展示的结果摘要。 */
    const renderToolResult = (u) => {
      const out = []
      const content = Array.isArray(u.content) ? u.content : []
      for (const c of content) {
        if (typeof c === 'string') { out.push(c); continue }
        if (c?.type === 'text' && c.text) { out.push(c.text); continue }
        if (c?.type === 'diff') {
          const adds = String(c.newText ?? '').split('\n').length
          out.push(`修改了 ${c.path ?? '文件'}（约 ${adds} 行）`)
          continue
        }
        if (c?.type === 'content' && c.content?.text) { out.push(c.content.text); continue }
      }
      // 少数工具把结果放在 rawOutput 里，但只在它是非空对象时采用
      const ro = u.rawOutput
      if (ro && typeof ro === 'object' && Object.keys(ro).length > 0) {
        const roText = ro.stdout ?? ro.output ?? ro.text
        if (typeof roText === 'string' && roText.trim()) out.push(roText.trim())
      }
      return out.join('\n').trim().slice(0, 400)
    }

    const onNotification = (method, params) => {
      if (method !== 'session/update') return
      if (params?.sessionId && params.sessionId !== sessionId) return
      const u = params.update ?? params
      const kind = u.sessionUpdate ?? u.type
      switch (kind) {
        case 'agent_message_chunk':
          push({ kind: 'text', text: textDelta.push(renderContent(u.content)) })
          break
        case 'agent_thought_chunk':
          push({ kind: 'reasoning', text: thoughtDelta.push(renderContent(u.content)) })
          break
        case 'compaction_summary_chunk': {
          // 会话压缩完成后的摘要文本——按正文发出（agy 在长会话里用它替代全量重述）
          push({ kind: 'text', text: textDelta.push(renderContent(u.content)) })
          break
        }
        case 'usage_update':
          push({ kind: 'usage', used: u.used, size: u.size })
          break
        case 'current_mode_update':
          // agy 侧权限模式变更（例如用户在 IDE 里切了 auto）——记入日志便于诊断，
          // 不打断输出流。DSH 侧的模式以插件配置为准。
          this.logger?.info?.(`antigravity-acp: agy 报告模式切换 → ${u.currentModeId ?? '?'}`)
          break
        case 'tool_call':
        case 'tool_call_update': {
          if (!showTools) break
          const id = u.toolCallId ?? u.id ?? ''
          const prev = seenToolCalls.get(id)
          const status = String(u.status ?? '')
          const finished = /completed|failed|cancelled/i.test(status)
          // ⚠️ 这些是 agy 在远端已经自己执行完的工具，绝不能产出原生
          // tool-call 块——DSH 会把块里的 name 当作「模型请求宿主执行
          // 的工具」去查找执行，查不到 → unknown tool 报错 → 报错塞回
          // 历史 → 强制多跑一轮（2026-11-22 实测 8 连报错）。这里只做
          // 展示层折叠：首次出现与终态各播报一行文本。
          if (prev === undefined) {
            seenToolCalls.set(id, status)
            push({ kind: 'text', text: `\n[agy] ${describeToolCall(u)}\n` })
          } else if (finished && prev !== status) {
            seenToolCalls.set(id, status)
            const brief = renderToolResult(u)
            push({
              kind: 'text',
              text: `\n[agy] ${describeToolCall(u)}${brief ? '\n' + brief : ''}\n`,
            })
          }
          break
        }
        default:
          break
      }
    }

    const onRequest = async (id, method, params) => {
      if (method === 'session/request_permission') {
        try {
          const reply = await this.#decidePermission(
            { ...params, sessionId: params?.sessionId ?? sessionId },
            sessionId,
            signal,
          )
          conn.reply(id, reply)
        } catch (err) {
          this.logger?.warn?.('antigravity-acp: 审批异常: ' + (err?.message ?? err))
          conn.reply(id, buildPermissionReply(params, 'deny'))
        }
        return
      }
      conn.replyError(id, -32601, '不支持的客户端方法')
    }

    conn.on('notification', onNotification)
    conn.on('request', onRequest)

    const promptPromise = conn.request('session/prompt', {
      sessionId,
      prompt: promptBlocks,
    }, { timeoutMs: this.options.timeoutMs ?? 600_000, signal })

    promptPromise
      .then((res) => { done = true; push({ kind: 'done', res }) })
      .catch((err) => { done = true; push({ kind: 'error', err }) })

    const onAbort = () => {
      try { conn.notify('session/cancel', { sessionId }) } catch { /* ignore */ }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // ---- 对外产出 DSH chunk ----
    let blockIndex = 0
    let textOpen = false
    let reasoningOpen = false
    // block-end 必须携带该 block 的完整文本——DSH 以它为准作为最终内容，
    // 空串会把增量攒出的正文覆盖掉（「回复一闪就没」的第二个根因）
    let textText = ''
    let reasoningText = ''

    try {
      while (true) {
        if (queue.length === 0) {
          if (done) break
          await new Promise((resolve) => { resolveWaiter = resolve })
          continue
        }
        const item = queue.shift()

        if (item.kind === 'text') {
          if (!item.text) continue
          if (reasoningOpen) {
            yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningText } }
            reasoningOpen = false
            reasoningText = ''
            blockIndex++
          }
          if (!textOpen) {
            yield { type: 'block-start', index: blockIndex, blockType: 'text' }
            textOpen = true
          }
          textText += item.text
          yield { type: 'text-delta', index: blockIndex, text: item.text }
        } else if (item.kind === 'reasoning') {
          if (!item.text) continue
          if (textOpen) {
            yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: textText } }
            textOpen = false
            textText = ''
            blockIndex++
          }
          if (!reasoningOpen) {
            yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
            reasoningOpen = true
          }
          reasoningText += item.text
          yield { type: 'reasoning-delta', index: blockIndex, text: item.text }
        } else if (item.kind === 'usage') {
          if (item.used > 0) {
            yield {
              type: 'usage',
              usage: { inputTokens: item.used, outputTokens: 0, totalTokens: item.used },
            }
          }
        } else if (item.kind === 'done') {
          if (reasoningOpen) {
            yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningText } }
            reasoningOpen = false
            reasoningText = ''
          }
          if (textOpen) {
            yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: textText } }
            textOpen = false
            textText = ''
          }
          yield { type: 'finish', reason: mapStopReason(item.res?.stopReason) }
        } else if (item.kind === 'error') {
          const code = classifyError(item.err)
          const err = new Error(`[${code}] ${item.err.message}`)
          err.code = code
          throw err
        }
      }
    } finally {
      conn.off('notification', onNotification)
      conn.off('request', onRequest)
      signal?.removeEventListener('abort', onAbort)
      // 清除会话级兜底，避免迟到的权限请求落到错误的会话上
      if (this.#currentSessionId === sessionId) {
        this.#currentSessionId = null
        this.#currentSignal = null
      }
    }
  }

  // ---------------------------------------------------------------- teardown
  async dispose() {
    for (const sid of [...this.#sessions.keys()]) {
      await this.#closeSession(sid)
    }
    if (this.#conn) {
      await this.#conn.close()
      this.#conn = null
    }
  }
}

export { AcpConnection, AcpError, classifyError }
