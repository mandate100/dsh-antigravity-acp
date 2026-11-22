/**
 * T3 式改造验证：确认 Antigravity 能用自己的工具真的干活。
 *
 * 用 auto 模式（自动批准）跑一个需要写文件的真实任务，
 * 检查工具事件是否出现、文件是否真的被写出来。
 */
import { AntigravityAdapter } from '../lib/adapter.js'
import fs from 'node:fs'
import path from 'node:path'

const silent = { info() {}, warn() {}, debug() {} }
const logs = []
const loud = {
  info: (m) => { logs.push(m); console.log('  [info]', m) },
  warn: (m) => { logs.push(m); console.log('  [warn]', m) },
  debug() {},
}

const workDir = path.join(process.cwd(), 'tmp-t3test')
fs.rmSync(workDir, { recursive: true, force: true })
fs.mkdirSync(workDir, { recursive: true })

const base = {
  provider: 'antigravity',
  displayName: 'Antigravity (ACP)',
  command: process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe',
  extraArgs: [],
  cwd: workDir,
  proxy: 'http://127.0.0.1:17890',
  noProxy: 'localhost,127.0.0.1,::1',
  contextWindow: 1048576,
  timeoutMs: 300000,
  catalogTtlMs: 600000,
  models: [],
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

async function run(adapter, prompt, model) {
  let text = ''
  let reasoning = ''
  let finished = false
  for await (const c of adapter.stream({
    provider: 'antigravity',
    model,
    messages: [{ role: 'user', content: prompt }],
    system: '你是一个能读写文件的助手。',
  })) {
    if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
    if (c.type === 'reasoning-delta' && typeof c.text === 'string') reasoning += c.text
    if (c.type === 'finish') finished = true
  }
  return { text, reasoning, finished }
}

;(async () => {
  const a = new AntigravityAdapter({ options: { ...base, permissionMode: 'auto' }, logger: loud })
  const models = await a.listModels()
  const model = models[0].id

  console.log('\n=== 测试 1: 让它真的创建文件（auto 模式）===')
  const r1 = await run(a,
    '创建文件 proof.txt，内容写 T3_STYLE_OK，然后告诉我完成了。',
    model)
  console.log('  回复:', r1.text.trim().slice(0, 200).replace(/\n/g, ' '))

  const target = path.join(workDir, 'proof.txt')
  const exists = fs.existsSync(target)
  const content = exists ? fs.readFileSync(target, 'utf8').trim() : ''

  check('文件被创建', exists, target)
  check('内容正确', content.includes('T3_STYLE_OK'), JSON.stringify(content.slice(0, 60)))
  check('有完成信号', r1.finished)

  console.log('\n=== 测试 2: 工具活动以 [agy] 文本行展示（不可用原生 tool-call 块，见 adapter 注释）===')
  const hadToolText = /\[agy\]/.test(r1.text)
  check('回复里可见 [agy] 工具标记', hadToolText,
    hadToolText ? r1.text.match(/\[agy\][^\n]*/g)?.slice(0, 3).join(' / ') ?? '' : '未出现')
  check('无原生 tool-call 块混入正文（防 unknown tool 回归）',
    !r1.text.includes('blockType') && !/unknown tool/i.test(r1.text), '')

  console.log('\n=== 测试 3: 读取刚才创建的文件 ===')
  const r2 = await run(a,
    '读取当前目录的 proof.txt，把内容原样告诉我。',
    model)
  check('能读到内容', /T3_STYLE_OK/.test(r2.text), r2.text.trim().slice(0, 120).replace(/\n/g, ' '))

  console.log('\n=== 测试 4: showToolActivity=false 时不显示 ===')
  const b = new AntigravityAdapter({
    options: { ...base, cwd: workDir, permissionMode: 'auto', showToolActivity: false },
    logger: silent,
  })
  const r3 = await run(b, 'Reply with exactly: QUIET_OK', model)
  check('关闭后无 [agy] 标记', !/\[agy\]/.test(r3.text), r3.text.trim().slice(0, 60).replace(/\n/g, ' '))
  check('正常出字', /QUIET_OK/.test(r3.text))

  console.log('\n=== 测试 5: supervised 在无审批服务时降级为拒绝 ===')
  const c = new AntigravityAdapter({
    options: { ...base, cwd: workDir, permissionMode: 'supervised' },
    logger: silent,
    ctx: {},  // 故意不给 approval / agents
  })
  const r4 = await run(c, '创建文件 should-not-exist.txt', model)
  const blockedFile = path.join(workDir, 'should-not-exist.txt')
  check('无审批服务时文件未被创建', !fs.existsSync(blockedFile),
    fs.existsSync(blockedFile) ? '⚠️ 被创建了' : '按 fail-closed 处理')
  check('对话仍正常结束', r4.finished, r4.text.trim().slice(0, 80).replace(/\n/g, ' '))

  await a.dispose()
  await b.dispose()
  await c.dispose()

  console.log(`\n===== ${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} =====`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('未捕获:', e); process.exit(1) })
