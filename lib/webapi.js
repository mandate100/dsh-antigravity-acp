/**
 * 给设置页用的宿主侧 API。
 *
 * 通过 ctx.webServer.register() 挂在 /antigravity/api 前缀下，浏览器端
 * 直接 fetch。所有路由都只读或只改本插件自己的配置，无危险操作。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** POST JSON 路由表 */
export function buildAntigravityApi({ options, logger, state }) {
  const proxy = options.proxy || ''

  function run(cmd, args, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
      const env = { ...process.env }
      if (proxy) {
        env.HTTP_PROXY = proxy
        env.HTTPS_PROXY = proxy
        env.http_proxy = proxy
        env.https_proxy = proxy
        env.NO_PROXY = options.noProxy || 'localhost,127.0.0.1,::1'
      }
      execFile(cmd, args, { timeout, env, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
  }

  return {
    /** 综合状态：二进制、版本、配置快照 */
    async status() {
      const { resolveAgyCommand } = await import('./resolve-agy.js')
      const command = await resolveAgyCommand(options.command, { env: process.env })
      const isPath = /[\\/]/.test(command)
      const binaryPath = isPath ? command : null
      let exists = binaryPath ? existsSync(binaryPath) : null

      let version = null
      if (exists || !isPath) {
        const r = await run(command, ['--version'], { timeout: 15000 })
        if (!r.err && r.stdout.trim()) version = r.stdout.trim().split(/\s+/)[0]
      }
      if (exists === null) exists = Boolean(version)

      // 登录检测：agy models 需要登录；未登录时输出 Please sign in
      let loggedIn = null
      if (version) {
        const r = await run(command, ['models'], { timeout: 45000 })
        const out = (r.stdout + r.stderr)
        if (/please sign in|not logged in|authentication/i.test(out)) loggedIn = false
        else if (/gemini|claude|gpt/i.test(out)) loggedIn = true
      }

      return {
        command: binaryPath ?? command,
        binaryExists: exists,
        version,
        loggedIn,
        models: state.models ?? [],
        proxy: options.proxy || '',
        config: {
          permissionMode: options.permissionMode ?? 'supervised',
          showToolActivity: options.showToolActivity !== false,
          sanitizeSystemPrompt: options.sanitizeSystemPrompt !== false,
          proxy: options.proxy || '',
        },
      }
    },

    /** 额度查询：走官方 `agy -p /usage`（不耗模型额度） */
    async usage() {
      const { resolveAgyCommand } = await import('./resolve-agy.js')
      const command = await resolveAgyCommand(options.command, { env: process.env })
      const r = await run(command, ['-p', '/usage'], { timeout: 90000 })
      const out = (r.stdout || '') + (r.stderr || '')
      if (/please sign in|not logged in/i.test(out)) {
        return { groups: [], error: 'agy 未登录，请先在终端运行一次 agy 完成登录' }
      }
      if (r.err && !out.trim()) {
        return { groups: [], error: 'agy 执行失败: ' + String(r.err.message ?? '').slice(0, 160) }
      }
      // 解析：agy 的输出是给终端看的文本，尽力提取行
      const groups = parseUsageText(out)
      return { groups }
    },

    /** 诊断命令 */
    async diag({ kind } = {}) {
      if (kind === 'proxy') {
        const p = options.proxy || 'http://127.0.0.1:17890'
        // curl 是 Windows 10+ 自带的；用 -w 输出状态码
        const r = await run('curl.exe', [
          '-x', p, '-s', '-o', 'NUL', '-w', '%{http_code}',
          '-X', 'POST', 'https://oauth2.googleapis.com/token', '--max-time', '15',
        ], { timeout: 30000 })
        const code = (r.stdout || '').trim()
        if (code === '000') {
          return { output: `❌ 无法连接（000）。代理 ${p} 不可达或客户端未运行。` }
        }
        if (code === '400' || code === '411' || code === '403') {
          return { output: `✅ 代理隧道正常（Google 回复 ${code}，这是对空请求的正常回应）。` }
        }
        return { output: `代理返回 HTTP ${code || '(空)'}。非 000 通常表示链路可达。` }
      }
      if (kind === 'login') {
        const { resolveAgyCommand } = await import('./resolve-agy.js')
        const command = await resolveAgyCommand(options.command, { env: process.env })
        const r = await run(command, ['models'], { timeout: 60000 })
        const out = ((r.stdout || '') + (r.stderr || '')).trim()
        if (/please sign in|not logged in/i.test(out)) {
          return { output: '❌ 未登录。请在终端运行一次 agy 完成浏览器登录。\n\n原始输出:\n' + out.slice(0, 500) }
        }
        if (/gemini|claude|gpt/i.test(out)) {
          const lines = out.split(/\r?\n/).filter((l) => /^(gemini|claude|gpt)/i.test(l))
          return { output: `✅ 已登录。可用模型:\n${lines.slice(0, 10).join('\n')}` }
        }
        return { output: '无法确定登录状态。\n原始输出:\n' + out.slice(0, 500) }
      }
      return { output: '未知诊断类型: ' + String(kind) }
    },
  }
}

/**
 * 解析 `agy -p /usage` 的输出。
 *
 * 实测格式是制表符分隔的四列表格：
 *   Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-29T06:32:53Z
 *   Gemini Models\tFive Hour Limit Remaining\t93%\t2026-11-22T11:32:53Z
 *   Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t99%\t2026-11-29T06:54:40Z
 *
 * 列：模型组 / 窗口名 / 剩余百分比 / 重置时间（ISO8601）。
 * 解析失败时返回空数组，前端会显示「上游未返回额度明细」。
 */
function parseUsageText(text) {
  const groups = []
  if (!text) return groups

  // 剩余百分比 + ISO 重置时间
  const rowRe = /^\s*(.+?)\s*\t\s*(.+?)\s*\t\s*(\d{1,3})\s*%\s*\t\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*$/
  const seen = new Map()

  for (const raw of text.split(/\r?\n/)) {
    const m = rowRe.exec(raw)
    if (!m) continue
    const [, name, window, pctStr, iso] = m
    const percent = parseInt(pctStr, 10)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue

    // 窗口名归一：Weekly / Five Hour → 中文标签
    const isWeekly = /weekly/i.test(window)
    const windowLabel = isWeekly ? '每周' : /five\s*hour|5\s*hour/i.test(window) ? '5 小时' : window.trim()
    const resetText = (() => {
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return iso
        const diffH = (d.getTime() - Date.now()) / 3600000
        if (diffH > 0) {
          return diffH < 48 ? `${Math.round(diffH)} 小时后重置` : `${Math.round(diffH / 24)} 天后重置`
        }
        return '已重置'
      } catch { return iso }
    })()

    const key = name.trim()
    if (!seen.has(key)) {
      seen.set(key, { label: key, windows: [] })
      groups.push(seen.get(key))
    }
    seen.get(key).windows.push({ windowLabel, percent, resetText })
    if (groups.length >= 8) break
  }

  // 摊平成前端期望的形状：每组取窗口里"剩余最少"的作为主百分比
  for (const g of groups) {
    g.windows.sort((a, b) => a.percent - b.percent)
    const min = g.windows[0]
    g.percent = min?.percent ?? null
    g.detail = (g.windows ?? []).map((w) => `${w.windowLabel} ${w.percent}%`).join(' / ')
    g.resetText = min?.resetText ?? ''
    delete g.windows
  }
  return groups
}
