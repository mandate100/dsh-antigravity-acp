/**
 * 系统提示清洗。
 *
 * 背景：DSH 的 system prompt 里详细描述了它自己的工具（pwsh / read / write /
 * edit / glob / grep / subagent ...）。但这些工具**不会**下发给 Antigravity——
 * 我们只把文本发过去，`tools` 数组是丢弃的。
 *
 * 如果原样转发，antigravity 会读到「你有 pwsh」，而它实际调不到；实测中它
 * 能靠自身容错绕过去，但这属于「模型碰巧没上当」，不是设计保证。更糟的情况
 * 是它尝试输出伪工具调用被 DSH 当成正文，或反复纠结于「我该怎么调用 pwsh」。
 *
 * 因此这里做两件事：
 *   1. 剥掉描述宿主工具用法的整段（标题 + 参数 + 示例）
 *   2. 在最前面插入一句明确的角色说明，告诉它用自己内置的工具
 *
 * 该模块是纯函数，便于单元测试，不依赖网络或进程。
 */

/** 插入到 system 开头的角色说明。 */
export const ROLE_PREAMBLE = [
  '你正作为模型后端运行在 DeepSeek Harness（宿主程序）内。',
  '宿主有它自己的工具（文件读写、终端、搜索等），那些工具由宿主自己调用，你无法直接使用，也不需要尝试调用。',
  '需要操作文件或执行命令时，请直接使用你自己内置的工具。',
  '不要输出伪造的工具调用格式，直接用自然语言回答或直接动手。',
].join('\n')

/**
 * 会被整体剥除的工具类小节标题（大小写不敏感）。
 * 命中时，从该标题起、到下个同级或更高级标题为止的整段都被丢弃。
 */
const TOOL_SECTION_PATTERNS = [
  /^#{1,6}\s*.*\b(tools?|tool\s*use|tool\s*calls?|available\s+tools?|tool\s+reference)\b/i,
  /^#{1,6}\s*.*(工具|可用工具|工具列表|工具说明)/,
]

/** 行内出现这些特征时，视为「在描述某个宿主工具」，行本身可丢。 */
const TOOL_LINE_PATTERNS = [
  // 形如 "### pwsh" / "#### bash" 的小标题 —— 纯工具名当标题
  /^#{1,6}\s*`?(pwsh|powershell|bash|read|write|edit|glob|grep|subagent|apply_patch|todo_write|ask_user_question|web_search|web_fetch)`?\s*$/i,
  // 常见工具名 + 冒号或说明文字
  /^\s*[-*]?\s*`?(pwsh|powershell|bash|read|write|edit|glob|grep|subagent|apply_patch|todo_write|ask_user_question|web_search|web_fetch)`?\b[:\s]/i,
  // 参数块
  /^\s*[-*]?\s*`?(parameters?|参数|args?)\s*[:：]/i,
  // 形如 Parameters: { a: string }
  /^\s*Parameters?\s*:\s*\{/i,
  // 直接点名「你可以调用 pwsh」/「你有以下工具」
  /\byou (have access to|can (use|call|invoke))\b.*\b(tools?|pwsh|bash|read|write|edit|glob|grep)\b/i,
  /^\s*you have access to\b.*\btools?\b/i,
  /\b(pwsh|bash)\b.*\b(command|workdir|timeoutMs)\b/i,
  // 中文的「你可以使用以下工具」
  /(你|您).{0,6}(可以|能).{0,6}(使用|调用).{0,6}(工具|pwsh|bash)/,
]

/** 判断一行是否属于「工具描述」。 */
export function isToolDescriptionLine(line) {
  return TOOL_LINE_PATTERNS.some((re) => re.test(line))
}

/** 判断一个标题是否开启了「工具小节」。 */
export function isToolSectionHeading(line) {
  return TOOL_SECTION_PATTERNS.some((re) => re.test(line.trim()))
}

/**
 * 从 markdown 风格的 system prompt 中剥掉工具小节与工具行。
 *
 * 策略：
 *  - 遇到工具类标题 → 进入「跳过模式」，直到遇到同级或更高级的非工具标题
 *  - 非跳过模式下，逐行丢弃工具描述行
 *  - 空行连续超过 2 个时压成 1 个，避免留下大段空白
 *
 * @param {string} system 原始 system prompt
 * @returns {string} 清洗后的文本
 */
export function stripHostToolSections(system) {
  if (!system || typeof system !== 'string') return ''

  const lines = system.split(/\r?\n/)
  const out = []
  let skipLevel = 0 // 0 = 不跳过；>0 = 正在跳过的标题层级

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+/.exec(line)
    const level = headingMatch ? headingMatch[1].length : 0

    if (skipLevel > 0) {
      // 跳过中：遇到同级或更高级标题就退出
      if (level > 0 && level <= skipLevel) {
        skipLevel = 0
        // 落到下面的正常处理
      } else {
        continue
      }
    }

    if (level > 0 && isToolSectionHeading(line)) {
      skipLevel = level
      continue
    }

    if (isToolDescriptionLine(line)) continue

    out.push(line)
  }

  // 压缩多余空行
  const collapsed = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return collapsed
}

/**
 * 构造最终发给 antigravity 的 system 段。
 *
 * @param {string} system DSH 的原始 system prompt
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true] 是否启用清洗（便于对照测试）
 * @returns {{ text: string, removed: number, originalLength: number }}
 */
export function buildSystemForAntigravity(system, opts = {}) {
  const enabled = opts.enabled !== false
  const original = typeof system === 'string' ? system : ''
  if (!original.trim()) {
    return { text: enabled ? ROLE_PREAMBLE : '', removed: 0, originalLength: 0 }
  }

  if (!enabled) {
    return { text: original.trim(), removed: 0, originalLength: original.length }
  }

  const cleaned = stripHostToolSections(original)
  const removed = Math.max(0, original.length - cleaned.length)

  const text = cleaned.trim()
    ? `${ROLE_PREAMBLE}\n\n---\n\n${cleaned}`
    : ROLE_PREAMBLE

  return { text, removed, originalLength: original.length }
}
