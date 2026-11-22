/**
 * 合规白名单测试：确认非 Gemini 模型在三道防线上都被挡住。
 */
import { AntigravityAdapter } from '../lib/adapter.js'

const silent = { info() {}, warn() {}, debug() {} }
const callInfo = []
const loud = {
  info: (m) => { callInfo.push(m); console.log('  [info]', m) },
  warn: (m) => console.log('  [warn]', m),
  debug() {},
}

const baseOptions = {
  provider: 'antigravity',
  displayName: 'Antigravity (ACP)',
  command: process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe',
  extraArgs: [],
  cwd: process.cwd(),
  proxy: 'http://127.0.0.1:17890',
  noProxy: 'localhost,127.0.0.1,::1',
  contextWindow: 1048576,
  timeoutMs: 120000,
  catalogTtlMs: 600000,
  models: [],
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

;(async () => {
  // ---------- 默认配置：只放行 Gemini ----------
  console.log('\n=== 测试 1: 默认配置 —— listModels 只返回 Gemini ===')
  const a = new AntigravityAdapter({ options: { ...baseOptions, allowNonGeminiModels: false }, logger: loud })
  const models = await a.listModels()
  console.log('  返回:', models.map((m) => m.id).join(', '))

  check('列表非空', models.length > 0, `${models.length} 个`)
  check('全部是 gemini-*', models.every((m) => /^gemini-/i.test(m.id)),
    models.filter((m) => !/^gemini-/i.test(m.id)).map((m) => m.id).join(',') || '无例外')
  check('无 claude', !models.some((m) => /claude/i.test(m.id)))
  check('无 gpt-oss', !models.some((m) => /gpt/i.test(m.id)))
  check('过滤有日志', callInfo.some((m) => m.includes('过滤掉')), callInfo.find((m) => m.includes('过滤')) ?? '')

  // ---------- 第二道防线：直接派发非 Gemini ----------
  console.log('\n=== 测试 2: 绕过选择器直接派发 claude ===')
  let blocked = false
  let msg = ''
  try {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of a.stream({
      provider: 'antigravity',
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hi' }],
    })) { /* 不应产出任何 chunk */ }
  } catch (e) {
    blocked = true
    msg = e.message
  }
  check('派发被拒绝', blocked)
  check('错误带 AUTH 码', msg.includes('[AUTH]'), msg.slice(0, 80))
  check('提示可显式放开', /allowNonGeminiModels/.test(msg))

  // ---------- 第三道防线：resolveModel 面对非白名单模型 ----------
  console.log('\n=== 测试 3: resolveModel 处理非白名单模型 ===')
  const r = await a.resolveModel('antigravity', 'claude-opus-5-5')
  check('仍能返回元数据（不崩）', !!r.id, r.id)
  check('名字退化为原始 id', r.name === 'claude-opus-5-5', r.name)

  // ---------- 正常 Gemini 仍可用 ----------
  console.log('\n=== 测试 4: Gemini 正常对话 ===')
  const geminiModel = models.find((m) => m.id === 'gemini-4-argon') ?? models[0]
  let text = ''
  let finished = false
  for await (const c of a.stream({
    provider: 'antigravity',
    model: geminiModel.id,
    messages: [{ role: 'user', content: 'Reply with exactly: GEMINI_OK' }],
    system: '你是测试助手。',
  })) {
    if (c.type === 'text-delta') text += c.text
    if (c.type === 'finish') finished = true
  }
  check('能正常出字', text.length > 0, text.trim().slice(0, 60))
  check('正常结束', finished)

  // ---------- 显式放开后 ----------
  console.log('\n=== 测试 5: allowNonGeminiModels=true 时放开 ===')
  const b = new AntigravityAdapter({ options: { ...baseOptions, allowNonGeminiModels: true }, logger: silent })
  const allModels = await b.listModels()
  check('返回全部 9 个', allModels.length >= 9, `${allModels.length} 个`)
  check('含 claude', allModels.some((m) => /claude/i.test(m.id)))

  await a.dispose()
  await b.dispose()

  console.log(`\n===== ${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} =====`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('未捕获:', e); process.exit(1) })
