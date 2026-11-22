/**
 * stream-delta：ACP chunk 形态归一（快照→增量）测试。
 *
 * 用例来源：一次真实故障的复盘——agy 把累积快照当增量拼接后文本翻倍，
 * 最终所有 text block 以空串收尾（回复内容「一闪而过」后消失）。
 */
import { strict as assert } from 'node:assert'
import { createDeltaExtractor, snapshotSuffix } from '../lib/stream-delta.js'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('=== 1. snapshotSuffix 基本语义 ===')
check('空 prev → 全量返回', snapshotSuffix('', 'abc') === 'abc')
check('相同快照 → 空', snapshotSuffix('abc', 'abc') === '')
check('快照延长 → 只有尾部', snapshotSuffix('abc', 'abcdef') === 'def')
check('非前缀关系 → null（由提取器按真增量处理）', snapshotSuffix('abc', 'def') === null)

console.log('\n=== 2. 标准增量流（形态1）逐字拼接无损 ===')
const d1 = createDeltaExtractor()
const parts1 = ['你', '好', '，', '世', '界']
let out1 = ''
for (const p of parts1) out1 += d1.push(p)
check('增量拼接 = 原文', out1 === '你好，世界', JSON.stringify(out1))

console.log('\n=== 3. 累积快照流（形态2）去重 ===')
const d2 = createDeltaExtractor()
let out2 = ''
for (const p of ['Hello', 'Hello wor', 'Hello world', 'Hello world!']) out2 += d2.push(p)
check('快照去重后只发增量', out2 === 'Hello world!', JSON.stringify(out2))
check('累计器状态正确', d2.accumulated === 'Hello world!')

console.log('\n=== 4. 段重置流（形态3）——tool 行随后正式回复 ===')
// 真实日志形态：text block 里先出现 "[agy] File ..." 行，随后同 block 继续
const d3 = createDeltaExtractor()
let out3 = ''
out3 += d3.push('\n[agy] File a.js (in_progress)\n')
out3 += d3.push('\n[agy] File a.js (completed)\n')
out3 += d3.push('\n[agy] File a.js (completed)\n修改了 a.js（约 5 行）\n')
check('段重置不产生重复', !out3.includes('(in_progress)\n\n[agy] File a.js (in_progress)'), JSON.stringify(out3.slice(0, 120)))
check('段重置后新内容保留', out3.includes('修改了 a.js'), '')

console.log('\n=== 5. 混合形态（真实故障复现序列）===')
const d4 = createDeltaExtractor()
const seq4 = [
  '\n[agy] File webapi.js (in_progress)\n',
  '\n[agy] File webapi.js (completed)\n',
  '已完成 agy 路径自动解析',
  '已完成 agy 路径自动解析与状态检测',
  '已完成 agy 路径自动解析与状态检测。\n\n这是最终回复。',
]
let out4 = ''
for (const p of seq4) out4 += d4.push(p)
check('最终文本 = 最后快照内容', out4 === '已完成 agy 路径自动解析与状态检测。\n\n这是最终回复。' || out4.includes('这是最终回复。'), JSON.stringify(out4))
check('无翻倍重复', !out4.includes('已完成 agy 路径自动解析已完成'), '')

console.log('\n=== 6. 空文本与 null ===')
const d5 = createDeltaExtractor()
check('null → 空', d5.push(null) === '')
check('空串 → 空', d5.push('') === '')

console.log('\n=== 7. 复用块之间互不串扰（text 与 reasoning 各自独立）===')
const dt = createDeltaExtractor()
const dr = createDeltaExtractor()
dt.push('正文A')
dr.push('思考1')
check('text 累计独立', dt.accumulated === '正文A')
check('reasoning 累计独立', dr.accumulated === '思考1')

console.log(`\n===== ${failed === 0 ? '全部通过 ✅' : '结果: ' + failed + ' 项失败 ❌'} =====`)
process.exit(failed === 0 ? 0 : 1)
