/**
 * 审批桥：把 ACP 的 `session/request_permission` 接到 DSH 的审批服务上。
 *
 * 参考 T3 Code 的语义：agent 自己跑工具，但每一次需要许可的操作都回到
 * 宿主界面由用户裁决。
 *
 * 关键约束（来自 dsh-user-approval 的源码注释）：
 *   `approval.request()` 必须在**打开的 turn 内**调用，否则抛错
 *   （approval/asked 与 approval/decided 必须成对且被 turn 包裹）。
 * 因此拿不到 agent 或不在 turn 内时，一律降级为「拒绝」，绝不静默放行。
 */

/** 从 ACP 的 permission 选项里挑出「允许」与「拒绝」两类。 */
export function classifyPermissionOptions(options = []) {
  const allow = []
  const deny = []
  for (const o of options) {
    const id = String(o?.optionId ?? o?.kind ?? '')
    if (/reject|deny|refuse|disallow|never/i.test(id)) deny.push(o)
    else if (/allow|approve|accept|yes|always|once/i.test(id)) allow.push(o)
    else deny.push(o) // 认不出的选项一律归为不允许，fail closed
  }
  return { allow, deny }
}

/** 把 ACP 的权限请求渲染成可读的一行，供审批界面显示。 */
export function describePermissionRequest(params = {}) {
  const toolCall = params.toolCall ?? {}
  const title = toolCall.title ?? toolCall.kind ?? toolCall.toolCallId ?? '工具操作'
  const command = toolCall.rawInput?.command
  const reason = params.reason ?? toolCall.rawInput?.description

  const parts = [String(title)]
  if (command) parts.push(`命令: ${String(command).slice(0, 200)}`)
  if (reason) parts.push(String(reason).slice(0, 200))
  return parts.join(' | ')
}

/** ACP 的「允许」→ DSH outcome 映射所用的选项 id。 */
export function pickAllowOption(options = []) {
  const { allow } = classifyPermissionOptions(options)
  // 优先选「只此一次」而不是「永远允许」，缩小授权面
  const once = allow.find((o) => /once/i.test(String(o?.optionId ?? o?.kind ?? '')))
  return once ?? allow[0] ?? null
}

export function pickDenyOption(options = []) {
  const { deny } = classifyPermissionOptions(options)
  return deny[0] ?? null
}

/**
 * 构造 ACP 的答复负载。
 * @param {object} params ACP 请求参数
 * @param {'allow'|'deny'} verdict
 */
export function buildPermissionReply(params, verdict) {
  const options = params?.options ?? []
  if (verdict === 'allow') {
    const opt = pickAllowOption(options)
    if (opt) {
      return { outcome: { outcome: 'selected', optionId: opt.optionId ?? opt.kind } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }
  const opt = pickDenyOption(options)
  if (opt) {
    return { outcome: { outcome: 'selected', optionId: opt.optionId ?? opt.kind } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

/**
 * 询问 DSH 审批服务。
 *
 * @param {object} args
 * @param {object} args.ctx       插件上下文（需含 approval 与 agents 服务）
 * @param {string} args.sessionId DSH 会话 id
 * @param {string} args.toolName  展示给用户的操作名
 * @param {string} [args.reason]  补充说明
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<'allow'|'deny'|'unavailable'>}
 */
export async function askApproval({ ctx, sessionId, toolName, reason, signal }) {
  const approval = ctx?.approval
  const agents = ctx?.agents

  if (!approval || typeof approval.request !== 'function') {
    return 'unavailable'
  }
  if (!agents || typeof agents.get !== 'function') {
    return 'unavailable'
  }

  let agent
  try {
    agent = agents.get(sessionId)
  } catch {
    return 'unavailable'
  }
  if (!agent) return 'unavailable'

  try {
    const outcome = await approval.request({
      agent,
      toolName,
      ...(reason ? { reason } : {}),
      ...(signal ? { signal } : {}),
    })
    return outcome === 'allowed-once' ? 'allow' : 'deny'
  } catch (err) {
    // turn 未打开、审计写入失败等，一律按拒绝处理（fail closed）
    return 'unavailable'
  }
}
