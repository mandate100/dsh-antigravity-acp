/**
 * 端到端验证 system 清洗：给一个满是 DSH 工具描述的 system，
 * 确认 agy 收到的版本已被清洗、且它正常用自己的工具干活。
 */
import { AntigravityAdapter } from '../lib/adapter.js'
import { buildSystemForAntigravity } from '../lib/system-prompt.js'
import fs from 'node:fs'
import path from 'node:path'

const workDir = path.join(process.cwd(), 'tmp-sanitize')
fs.rmSync(workDir, { recursive: true, force: true })
fs.mkdirSync(workDir, { recursive: true })

const silent = { info() {}, warn() {}, debug: (m) => logs.push(m) }
const logs = []

// 一个「形似 DSH 真实 system」的提示：工具描述占大头
const DSH_LIKE_SYSTEM = `You are an AI agent powered by DeepSeek Harness.

## Tools

You have access to the following tools:

### pwsh
Execute a PowerShell command (\`pwsh -Command\`) and return its stdout/stderr.
Each call runs in a fresh pwsh process; pass \`workdir\` instead of using \`cd\`.
Parameters: { command: string, workdir?: string, timeoutMs?: number }

### read
Read a UTF-8 text file and return line-numbered content.
Parameters: { file_path: string, offset?: number, limit?: number }

### write
Create or fully replace a UTF-8 text file.
Parameters: { file_path: string, content: string }

### edit
Edit an existing UTF-8 text file by replacing literal text.
Parameters: { file_path: string, old_string: string, new_string: string }

### glob
Find files, not directories, whose paths match a glob pattern.
Parameters: { pattern: string, path?: string }

### grep
Search file contents with a ripgrep regular expression.
Parameters: { pattern: string, include?: string, path?: string }

### subagent
Delegate a self-contained task to a subagent.
Parameters: { description: string, prompt: string }

## Workspace

Current working directory: ${workDir}

## 回复语言

始终用简体中文回复。

## 表达方式

先给结论，再给依据。`

let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) fail++
}

;(async () => {
  console.log('=== 1. 清洗后的 system 长什么样 ===')
  const { text: clean, removed } = buildSystemForAntigravity(DSH_LIKE_SYSTEM)
  console.log('  原始:', DSH_LIKE_SYSTEM.length, '字符')
  console.log('  清洗后:', clean.length, '字符   剥离:', removed, '字符')
  check('剥离了大量工具描述', removed > 400, `${removed} 字符`)
  check('不含 pwsh 描述', !clean.includes('Execute a PowerShell'))
  check('不含 read 描述', !clean.includes('line-numbered content'))
  check('不含 write 描述', !clean.includes('fully replace a UTF-8'))
  check('不含 subagent 描述', !clean.includes('Delegate a self-contained'))
  check('保留了 Workspace 节', clean.includes('## Workspace'))
  check('保留了回复语言节', clean.includes('始终用简体中文'))
  check('开头是角色说明', clean.startsWith('你正作为模型后端运行在 DeepSeek Harness'))
  console.log('  --- 清洗后全文 ---')
  console.log(clean.split('\n').map((l) => '  | ' + l).join('\n'))

  console.log('\n=== 2. 端到端：agy 拿清洗后的 system 还能正常干活 ===')
  const a = new AntigravityAdapter({
    options: {
      provider: 'antigravity',
      command: process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe',
      cwd: workDir,
      proxy: 'http://127.0.0.1:17890',
      noProxy: 'localhost,127.0.0.1,::1',
      timeoutMs: 240000,
      catalogTtlMs: 600000,
      models: [],
      permissionMode: 'auto',
    },
    logger: silent,
  })
  const models = await a.listModels()
  let text = ''
  let finished = false
  for await (const c of a.stream({
    provider: 'antigravity',
    model: models[0].id,
    messages: [{ role: 'user', content: '创建 sanitized.txt，内容写 CLEAN_OK，然后确认。' }],
    system: DSH_LIKE_SYSTEM,
  })) {
    if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
    if (c.type === 'finish') finished = true
  }
  const target = path.join(workDir, 'sanitized.txt')
  check('文件被创建', fs.existsSync(target))
  check('内容正确', fs.existsSync(target) && fs.readFileSync(target, 'utf8').includes('CLEAN_OK'))
  check('正常结束', finished)
  check('回复是纯文本（无 JSON 污染）', !/\{"text":/.test(text))
  console.log('  回复摘要:', text.replace(/\[agy\][^\n]*/g, '').trim().slice(0, 150).replace(/\n/g, ' '))

  console.log('\n=== 3. 关闭清洗时的对照 ===')
  const b = new AntigravityAdapter({
    options: {
      provider: 'antigravity',
      command: process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe',
      cwd: workDir,
      proxy: 'http://127.0.0.1:17890',
      noProxy: 'localhost,127.0.0.1,::1',
      timeoutMs: 240000,
      catalogTtlMs: 600000,
      models: [],
      permissionMode: 'auto',
      sanitizeSystemPrompt: false,
    },
    logger: silent,
  })
  // 只验证 prompt 构造，不再真跑一轮（省额度）
  const { text: raw, removed: r0 } = buildSystemForAntigravity(DSH_LIKE_SYSTEM, { enabled: false })
  check('关闭时 removed=0', r0 === 0)
  check('关闭时保留 pwsh 描述', raw.includes('Execute a PowerShell'))

  await a.dispose()
  await b.dispose()

  fs.rmSync(workDir, { recursive: true, force: true })
  console.log(`\n===== ${fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'} =====`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error('未捕获:', e); process.exit(1) })
