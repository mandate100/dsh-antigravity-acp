/**
 * webapi 离线验证：直接调 buildAntigravityApi 的三个方法。
 * status / diag 是纯本地操作；usage 需要 agy（可真跑）。
 */
import { buildAntigravityApi } from '../lib/webapi.js'

const logger = { info() {}, warn(m) { console.log('  [warn]', m) }, debug() {} }

const options = {
  provider: 'antigravity',
  command: process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe',
  proxy: 'http://127.0.0.1:17890',
  noProxy: 'localhost,127.0.0.1,::1',
  permissionMode: 'supervised',
  showToolActivity: true,
  sanitizeSystemPrompt: true,
  models: [
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  ],
}

const state = { models: options.models }
const api = buildAntigravityApi({ options, logger, state })

let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) fail++
}

;(async () => {
  console.log('=== 1. status ===')
  const st = await api.status()
  console.log(JSON.stringify(st, null, 2))
  check('二进制存在', st.binaryExists === true, st.command)
  check('拿到版本号', !!st.version, st.version)
  check('模型目录透传', Array.isArray(st.models) && st.models.length === 3)
  check('config 快照完整', st.config && st.config.permissionMode === 'supervised'
    && st.config.sanitizeSystemPrompt === true)
  check(' loggedIn 是三态之一', [true, false, null].includes(st.loggedIn), String(st.loggedIn))

  console.log('\n=== 1b. status（未配置 command 时自动解析 agy）===')
  const apiDefault = buildAntigravityApi({
    options: { ...options, command: '' },
    logger,
    state,
  })
  const stDefault = await apiDefault.status()
  check('未配置 command 时二进制存在', stDefault.binaryExists === true, stDefault.command)
  check('未配置 command 时拿到版本号', !!stDefault.version, stDefault.version)

  console.log('\n=== 2. diag:proxy ===')
  const d1 = await api.diag({ kind: 'proxy' })
  console.log('  ' + d1.output)
  check('代理诊断有结论', /✅|❌/.test(d1.output))

  console.log('\n=== 3. diag:login（真跑 agy models）===')
  const d2 = await api.diag({ kind: 'login' })
  console.log('  ' + d2.output.split('\n').slice(0, 6).join('\n  '))
  check('登录诊断有结论', /✅|❌|无法确定/.test(d2.output))

  console.log('\n=== 4. usage（真跑 agy -p /usage）===')
  const u = await api.usage()
  console.log('  groups:', JSON.stringify(u.groups).slice(0, 300))
  console.log('  error:', u.error ?? '(无)')
  check('usage 不抛异常', true, `groups=${(u.groups ?? []).length}, error=${u.error ?? '无'}`)

  console.log(`\n===== ${fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'} =====`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('未捕获:', e); process.exit(1) })
