/**
 * 消息渲染与 ACP 会话复用判定。
 *
 * 设计说明：
 *   ACP 的 session 在 agent 侧保有对话历史，而 DSH 的 adapter 接口每轮给的是
 *   「完整历史」。为了不重复发送，这里为每条消息算一个稳定指纹，记录哪一段
 *   已经发过；只要已发送前缀与本次历史逐条一致，就只发增量，否则重建会话。
 */
import { createHash } from 'node:crypto'

const SEP = '\u0000\u0001\u0000'

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

/** 把消息内容渲染成纯文本（工具调用也折成文本标签）。 */
export function renderContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => renderContent(b)).filter(Boolean).join('\n')
  }
  if (typeof content === 'object') {
    // 单个内容块：ACP 的 agent_message_chunk 常是 {type:'text', text:'...'}
    switch (content.type) {
      case 'text':
        return content.text ?? ''
      case 'image':
        // 有真实字节数据时交给 ACP 直传（renderPrompt 的 parts 路径）；
        // 纯文本渲染路径里保留可读占位
        return '[image]'
      case 'audio':
        return '[audio]'
      case 'resource':
        return renderContent(content.resource?.text ?? content.resource ?? '')
      case 'resource_link':
        return `[resource ${content.name ?? content.uri ?? ''}]`
      case 'tool-call':
        return `<tool_call name="${content.name ?? ''}">${stableStringify(content.arguments ?? content.input ?? {})}</tool_call>`
      case 'tool-result':
        return `<tool_result>${renderContent(content.content ?? content.result ?? '')}</tool_result>`
      default: {
        // 没有 type 但有 text，按文本处理
        if (typeof content.text === 'string') return content.text
        if (typeof content.content === 'string') return content.content
        return stableStringify(content)
      }
    }
  }
  return String(content)
}

/**
 * 把一条 DSH 消息拆成有序的「文本/图片」部件（图片直传 ACP 用）。
 * @returns {Array<{type:'text',text:string}|{type:'image',attachment:object}>}
 */
export function messageParts(message) {
  const content = message?.content
  if (content == null) return []
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  const parts = []
  const blocks = Array.isArray(content) ? content : [content]
  for (const b of blocks) {
    if (b == null) continue
    if (typeof b === 'string') { parts.push({ type: 'text', text: b }); continue }
    if (b.type === 'text') {
      if (b.text) parts.push({ type: 'text', text: b.text })
      continue
    }
    if (b.type === 'image' && b.attachment) {
      parts.push({ type: 'image', attachment: b.attachment })
      continue
    }
    // 其余块折成文本占位（file/tool-call 等在历史里通常已折叠）
    const rendered = renderContent(b)
    if (rendered) parts.push({ type: 'text', text: rendered })
  }
  return parts
}

/** 单条消息的稳定指纹。 */
export function fingerprintMessage(message) {
  const role = message?.role ?? 'user'
  return createHash('sha256')
    .update(String(role)).update(SEP)
    .update(renderContent(message?.content))
    .digest('hex')
    .slice(0, 32)
}

/**
 * 决定能否复用当前 ACP 会话。
 *
 * @param {object} sessionState 上一次的记录：{ sentFingerprints: string[], systemFingerprint }
 * @param {string[]} nextFingerprints 本次完整历史的逐条指纹
 * @param {string} systemFingerprint 系统提示指纹
 * @returns {{ reuse: boolean, reason: string, newCount: number }}
 */
export function decideReuse(sessionState, nextFingerprints, systemFingerprint) {
  if (!sessionState) return { reuse: false, reason: 'no-session', newCount: nextFingerprints.length }
  if (sessionState.systemFingerprint !== systemFingerprint) {
    return { reuse: false, reason: 'system-changed', newCount: nextFingerprints.length }
  }
  const sent = sessionState.sentFingerprints ?? []
  if (nextFingerprints.length < sent.length) {
    return { reuse: false, reason: 'history-shrank', newCount: nextFingerprints.length }
  }
  for (let i = 0; i < sent.length; i++) {
    if (sent[i] !== nextFingerprints[i]) {
      return { reuse: false, reason: `diverged-at-${i}`, newCount: nextFingerprints.length }
    }
  }
  return { reuse: true, reason: 'prefix-match', newCount: nextFingerprints.length - sent.length }
}

/**
 * 渲染本轮要发送的提示词。
 *
 * 返回 { text, images }：
 *  - text：发给 ACP 的文本（首/rebuild 轮带完整历史与系统提示；增量轮只发新增尾部）
 *  - images：本轮消息里的图片附件引用（由 adapter 读取字节后组装 ACP image block）
 *
 * @param {{ messages, system, isFirstTurn, startIndex? }} args
 *   startIndex：messages 里从第几条开始算「本轮新增」（默认 0）
 */
export function renderPrompt({ messages, system, isFirstTurn, startIndex = 0 }) {
  const parts = []
  const images = []

  if (isFirstTurn) {
    if (system && system.trim()) {
      parts.push(`<system>\n${system.trim()}\n</system>`)
    }
  }
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i]
    const role = m?.role ?? 'user'
    if (role === 'system') continue // 已并入 <system>
    for (const p of messageParts(m)) {
      if (p.type === 'image') { images.push(p.attachment); continue }
      parts.push(`<${role}>\n${p.text}\n</${role}>`)
    }
  }

  if (parts.length === 0 && images.length === 0) parts.push('(继续)')
  return { text: parts.join('\n\n'), images }
}

/** ACP stopReason → DSH FinishReason */
export function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn': return 'stop'
    case 'max_tokens': return 'length'
    case 'max_turn_requests': return 'length'
    case 'refusal': return 'content_filter'
    case 'cancelled': return 'aborted'
    default: return 'stop'
  }
}

/** 系统提示指纹 */
export function fingerprintSystem(system) {
  return createHash('sha256').update(system ?? '').digest('hex').slice(0, 32)
}
