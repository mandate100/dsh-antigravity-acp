/**
 * 核心争议验证：当 system prompt 里写了「你有 pwsh/read/write 工具」，
 * 但 agy 实际拿不到这些工具时，会发生什么？
 *
 * 三种情况对比：
 *   A. system 里宣称有 DSH 工具（但没给）  → 这是当前实现
 *   B. system 里不宣称任何工具             → 对照
 *   C. system 里明确说「用你自己的工具」     → 建议方案
 */
import { AntigravityAdapter } from '../lib/adapter.js'
import fs from 'node:fs'
import path from 'node:path'

const workDir = path.join(process.cwd(), 'tmp-conflict')
fs.rmSync(workDir, { recursive: true, force: true })
fs.mkdirSync(workDir, { recursive: true })

const silent = { info() {}, warn() {}, debug() {} }

const base = {
  provider: 'antigravity',
  displayName: 'A',
  command: process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe',
  extraArgs: [],
  cwd: workDir,
  proxy: 'http://127.0.0.1:17890',
  noProxy: 'localhost,127.0.0.1,::1',
  contextWindow: 1048576,
  timeoutMs: 240000,
  catalogTtlMs: 600000,
  models: [],
  permissionMode: 'auto',
}

const DSH_SYSTEM = `You are an AI agent powered by DeepSeek Harness.

## Tools
You have access to these tools:
### pwsh
Run PowerShell commands.
### read
Read a file.
### write
Write a file.

## Conventions
Always reply in Simplified Chinese.`

const NEUTRAL_SYSTEM = `You are a helpful assistant.
Always reply in Simplified Chinese.`

const OWN_TOOLS_SYSTEM = `You are Antigravity, running inside DeepSeek Harness as a model backend.

## 重要：你使用自己的工具
你可以用自己内置的工具读写文件、执行命令。
上面提到的 pwsh/read/write 属于宿主程序，你无法调用，也不需要调用。
需要操作文件时，直接用你自己的工具。

Always reply in Simplified Chinese.`

async function probe(label, system, prompt) {
  const a = new AntigravityAdapter({ options: base, logger: silent })
  const models = await a.listModels()
  let text = ''
  const toolLines = []
  let err = null
  try {
    for await (const c of a.stream({
      provider: 'antigravity',
      model: models[0].id,
      messages: [{ role: 'user', content: prompt }],
      system,
    })) {
      if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text
    }
  } catch (e) {
    err = e.message
  }
  await a.dispose()

  for (const m of text.matchAll(/\[agy\][^\n]*/g)) toolLines.push(m[0])

  console.log(`\n===== ${label} =====`)
  console.log('  工具调用次数:', toolLines.length)
  if (toolLines.length) console.log('  ' + toolLines.slice(0, 4).join('\n  '))
  console.log('  是否报错:', err ? '是 — ' + err.slice(0, 100) : '否')
  console.log('  回答摘要:', text.replace(/\[agy\][^\n]*/g, '').trim().slice(0, 200).replace(/\n/g, ' '))
  return { toolLines, text, err }
}

;(async () => {
  const prompt = '在当前目录创建 conflict-test.txt，内容写 CONFLICT_OK。'

  // A: 宣称有 DSH 工具（当前实现）
  const a = await probe('A. system 宣称有 pwsh/read/write（但没给）', DSH_SYSTEM, prompt)
  const fileA = path.join(workDir, 'conflict-test.txt')
  console.log('  → 文件是否创建:', fs.existsSync(fileA))
  if (fs.existsSync(fileA)) fs.rmSync(fileA, { force: true })

  // B: 中性 system
  const b = await probe('B. system 不宣称任何工具', NEUTRAL_SYSTEM, prompt)
  const fileB = path.join(workDir, 'conflict-test.txt')
  console.log('  → 文件是否创建:', fs.existsSync(fileB))
  if (fs.existsSync(fileB)) fs.rmSync(fileB, { force: true })

  // C: 明确说用自己的工具
  const c = await probe('C. system 明确「用你自己的工具」', OWN_TOOLS_SYSTEM, prompt)
  const fileC = path.join(workDir, 'conflict-test.txt')
  console.log('  → 文件是否创建:', fs.existsSync(fileC))
  if (fs.existsSync(fileC)) {
    console.log('  → 内容:', fs.readFileSync(fileC, 'utf8').trim().slice(0, 50))
  }

  console.log('\n===== 汇总 =====')
  console.log('A 宣称DSH工具: 工具调用', a.toolLines.length, '次，报错:', !!a.err)
  console.log('B 中性system : 工具调用', b.toolLines.length, '次，报错:', !!b.err)
  console.log('C 用自己的   : 工具调用', c.toolLines.length, '次，报错:', !!c.err)

  fs.rmSync(workDir, { recursive: true, force: true })
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
