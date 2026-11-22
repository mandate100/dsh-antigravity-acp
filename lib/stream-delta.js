/**
 * ACP 流式事件的「快照 → 增量」转换。
 *
 * 背景：agy（Antigravity ACP）的 `agent_message_chunk` / `agent_thought_chunk`
 * 实测多种发法混用：
 *   1. 标准增量：每条 chunk 只带新增文本（Zed 等官方 client 的假设）；
 *   2. 累积快照：每条 chunk 带自会话以来的全部文本，后一条包含前一条；
 *   3. 段快照：agent 每"开口"一次（同一逻辑小节），chunk 带该小节的
 *      全部文本——小节内互为前缀延长，小节之间互不重叠。
 *
 * 若把 2/3 当增量拼接，文本会翻倍。这里用两级前缀探测区分：
 *   - raw 延长全量累计（acc）→ 会话级快照，只发尾部；
 *   - raw 延长当前 burst（最近一段连续延长链）→ 段快照，只发尾部；
 *   - 否则 → 真增量/新段开始，原样发出并开启新 burst。
 */

/**
 * 从累积快照中提取新增后缀。
 * @param {string} prev 基准文本
 * @param {string} next 本条 chunk 文本
 * @returns {string | null} 应追加的文本；null 表示 next 不是 prev 的延长
 */
export function snapshotSuffix(prev, next) {
  if (!next) return ''
  if (!prev) return next
  if (next === prev) return ''
  if (next.startsWith(prev)) return next.slice(prev.length)
  return null
}

/**
 * 创建一个增量提取器：把混合形态的 chunk 流归一为真增量。
 */
export function createDeltaExtractor() {
  let acc = ''        // 已发送的累计文本（诊断与全量快照探测）
  let burst = ''      // 当前段（最近一条与其前驱互为延长的链）

  return {
    /** 输入一条原始 chunk 文本，返回应发出的增量。 */
    push(raw) {
      if (raw == null || raw === '') return ''

      // ① 会话级快照：raw 延长全部已发文本
      const whole = snapshotSuffix(acc, raw)
      if (whole !== null) {
        acc += whole
        burst = raw
        return whole
      }

      // ② 段快照：raw 延长当前段（agent 重开小节后的重发）
      const seg = snapshotSuffix(burst, raw)
      if (seg !== null) {
        acc += seg
        burst = raw
        return seg
      }

      // ③ 真增量 / 新段开始：原样发出
      acc += raw
      burst = raw
      return raw
    },
    /** 已发送的累计文本（诊断用）。 */
    get accumulated() { return acc },
    reset() { acc = ''; burst = '' },
  }
}
