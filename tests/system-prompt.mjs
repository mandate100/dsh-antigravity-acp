/**
 * 系统提示清洗的单元测试。纯文本处理，不需要网络。
 */
import {
  stripHostToolSections, buildSystemForAntigravity, isToolSectionHeading,
  isToolDescriptionLine, ROLE_PREAMBLE,
} from '../lib/system-prompt.js'

let fail = 0
const eq = (label, actual, expected) => {
  const ok = actual === expected
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (!ok) {
    fail++
    console.log('     期望:', JSON.stringify(expected))
    console.log('     实际:', JSON.stringify(actual))
  }
}
const truthy = (label, v) => {
  console.log(`  ${v ? '✅' : '❌'} ${label}`)
  if (!v) fail++
}
const falsy = (label, v) => {
  console.log(`  ${!v ? '✅' : '❌'} ${label}`)
  if (v) fail++
}

console.log('\n=== 1. 标题识别 ===')
truthy('## Tools', isToolSectionHeading('## Tools'))
truthy('## Available Tools', isToolSectionHeading('## Available Tools'))
truthy('## 工具', isToolSectionHeading('## 工具'))
truthy('### Tool Reference', isToolSectionHeading('### Tool Reference'))
falsy('## Workspace 不是工具节', isToolSectionHeading('## Workspace'))
falsy('## Conventions 不是工具节', isToolSectionHeading('## Conventions'))

console.log('\n=== 2. 工具行识别 ===')
truthy('### pwsh', isToolDescriptionLine('### pwsh'))
truthy('- read: 读取文件', isToolDescriptionLine('- read: 读取文件'))
truthy('Parameters: { command: string }', isToolDescriptionLine('Parameters: { command: string }'))
truthy('You have access to tools', isToolDescriptionLine('You have access to the following tools'))
falsy('普通句子', isToolDescriptionLine('这段代码写得不错。'))
falsy('中文正常行', isToolDescriptionLine('请帮我看看这个函数。'))

console.log('\n=== 3. 整段剥离 ===')
const caseA = `你是助手。

## Tools
You have access to these tools:
### pwsh
Run PowerShell commands.
Parameters: { command: string }

### read
Read a file.

## Workspace
Current directory: /tmp

## Conventions
Always reply in Chinese.`

const outA = stripHostToolSections(caseA)
truthy('保留了开头', outA.includes('你是助手'))
truthy('保留了 Workspace', outA.includes('## Workspace'))
truthy('保留了 Conventions', outA.includes('Always reply in Chinese'))
falsy('剥掉了 pwsh', outA.includes('pwsh'))
falsy('剥掉了 read', outA.includes('### read'))
falsy('剥掉了 Parameters', outA.includes('Parameters'))

console.log('\n=== 4. 子标题处理（### 属于 ## 之下）===')
const caseB = `## Tools
intro line
### sub-tool-a
details a
### sub-tool-b
details b

## Next Section
keep me`
const outB = stripHostToolSections(caseB)
falsy('子标题也被剥', outB.includes('sub-tool-a'))
falsy('子标题内容也被剥', outB.includes('details a'))
truthy('后续同级标题保留', outB.includes('## Next Section'))
truthy('后续内容保留', outB.includes('keep me'))

console.log('\n=== 5. 没有工具描述时原样保留 ===')
const caseC = `你是一个写作助手。
请帮我润色这段文字。`
const outC = stripHostToolSections(caseC)
eq('内容不变', outC, caseC)

console.log('\n=== 6. buildSystemForAntigravity ===')
const r1 = buildSystemForAntigravity(caseA)
truthy('插入角色说明', r1.text.startsWith(ROLE_PREAMBLE))
truthy('有剥离发生', r1.removed > 0)
console.log('     剥离了', r1.removed, '字符 /', r1.originalLength)

const r2 = buildSystemForAntigravity(caseA, { enabled: false })
eq('关闭清洗时原样返回', r2.text, caseA.trim())
eq('关闭时 removed=0', r2.removed, 0)

const r3 = buildSystemForAntigravity('')
truthy('空 system 也给角色说明', r3.text === ROLE_PREAMBLE)

const r4 = buildSystemForAntigravity(null)
truthy('null 不崩', typeof r4.text === 'string')

console.log('\n=== 7. 幂等性（清洗两次结果相同）===')
const once = stripHostToolSections(caseA)
const twice = stripHostToolSections(once)
eq('幂等', twice, once)

console.log(`\n===== ${fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'} =====`)
process.exit(fail === 0 ? 0 : 1)
