/**
 * 离线验证：直接驱动 AntigravityAdapter，走真实 `agy acp`。
 * 目的是在装进 DSH 之前确认 stream() 的 chunk 序列正确。
 */
import { AntigravityAdapter } from '../lib/adapter.js'

const silentLogger = {
  info: (m) => console.log('  [info]', m),
  warn: (m) => console.log('  [warn]', m),
  debug: () => {},
}

const adapter = new AntigravityAdapter({
  options: {
    provider: 'antigravity',
    displayName: 'Antigravity (ACP)',
    command: process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe',
    extraArgs: [],
    cwd: process.cwd(),
    proxy: 'http://127.0.0.1:17890',
    noProxy: 'localhost,127.0.0.1,::1',
    contextWindow: 1048576,
    timeoutMs: 180000,
    catalogTtlMs: 600000,
    models: [],
  },
  logger: silentLogger,
})

function collect(iter) {
  return (async () => {
    const out = []
    for await (const c of iter) out.push(c)
    return out
  })()
}

function summarize(chunks) {
  const kinds = {}
  let text = ''
  let reasoning = ''
  for (const c of chunks) {
    kinds[c.type] = (kinds[c.type] ?? 0) + 1
    if (c.type === 'text-delta') text += c.text
    if (c.type === 'reasoning-delta') reasoning += c.text
  }
  return { kinds, text, reasoning }
}

(async () => {
  let failures = 0
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
    if (!ok) failures++
  }

  try {
    console.log('\n=== 测试 1: listModels ===')
    const models = await adapter.listModels()
    check('返回非空模型列表', models.length > 0, `${models.length} 个`)
    console.log('  模型:', models.map((m) => m.id).join(', '))

    console.log('\n=== 测试 2: resolveModel ===')
    const resolved = await adapter.resolveModel('antigravity', models[0].id)
    check('返回 model id', resolved.id === models[0].id)
    check('声明上下文窗口（context.contextWindow）', resolved.context?.contextWindow > 0, String(resolved.context?.contextWindow))
    check('声明 reasoning 档位（reasoning.efforts）', (resolved.reasoning?.efforts ?? []).length > 0,
      (resolved.reasoning?.efforts ?? []).map((e) => e.id).join(','))

    console.log('\n=== 测试 3: 首轮 stream ===')
    const msgs1 = [
      { role: 'system', content: '你是一个测试助手。' },
      { role: 'user', content: 'Reply with exactly: FIRST_OK' },
    ]
    const chunks1 = await collect(adapter.stream({
      provider: 'antigravity',
      model: models[0].id,
      messages: msgs1,
      system: '你是一个测试助手。',
    }))
    const s1 = summarize(chunks1)
    check('有 text-delta', (s1.kinds['text-delta'] ?? 0) > 0, s1.text.trim().slice(0, 60))
    check('有 block-start', (s1.kinds['block-start'] ?? 0) > 0)
    check('有 block-end', (s1.kinds['block-end'] ?? 0) > 0)
    check('有 finish', (s1.kinds['finish'] ?? 0) === 1)
    check('无异常 chunk 类型', Object.keys(s1.kinds).every((k) =>
      ['block-start', 'text-delta', 'reasoning-delta', 'block-end', 'usage', 'finish'].includes(k)),
      Object.keys(s1.kinds).join(','))

    console.log('\n=== 测试 4: 次轮复用（增量发送）===')
    const msgs2 = [
      ...msgs1,
      { role: 'assistant', content: s1.text },
      { role: 'user', content: '现在把刚才那个词再说一遍，前面加 SECOND_' },
    ]
    const chunks2 = await collect(adapter.stream({
      provider: 'antigravity',
      model: models[0].id,
      messages: msgs2,
      system: '你是一个测试助手。',
    }))
    const s2 = summarize(chunks2)
    check('次轮仍有输出', (s2.kinds['text-delta'] ?? 0) > 0, s2.text.trim().slice(0, 80))
    check('次轮有 finish', (s2.kinds['finish'] ?? 0) === 1)

    console.log('\n=== 测试 5: 历史分叉时重建会话 ===')
    const msgs3 = [
      { role: 'system', content: '你是一个测试助手。' },  // 换了系统提示
      { role: 'user', content: 'Reply with exactly: THIRD_OK' },
    ]
    const chunks3 = await collect(adapter.stream({
      provider: 'antigravity',
      model: models[0].id,
      messages: msgs3,
      system: '你是一个测试助手。（已修改）',
    }))
    const s3 = summarize(chunks3)
    check('分叉后仍能回答', (s3.kinds['text-delta'] ?? 0) > 0, s3.text.trim().slice(0, 60))

    console.log('\n=== 测试 6: 取消 ===')
    const ac = new AbortController()
    const p = collect(adapter.stream({
      provider: 'antigravity',
      model: models[0].id,
      messages: [{ role: 'user', content: '数到一百，一个数字一行' }],
      system: '你是一个测试助手。',
      signal: ac.signal,
    }))
    setTimeout(() => ac.abort(), 800)
    let cancelled = false
    try {
      await p
    } catch (err) {
      cancelled = /取消|abort|aborted/i.test(err.message)
      if (!cancelled) console.log('  取消时的错误:', err.message)
    }
    check('取消不挂死', true, cancelled ? '按预期中断' : '已结束（可能已生成完）')
  } catch (err) {
    console.error('\n❌ 未捕获异常:', err)
    failures++
  } finally {
    await adapter.dispose()
    console.log(`\n===== 结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'} =====`)
    process.exit(failures === 0 ? 0 : 1)
  }
})()
