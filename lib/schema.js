/**
 * 配置 schema 适配层。
 *
 * 宿主通过 `Config['~standard'].validate(config)` 校验配置，所以 Config 必须是
 * Standard Schema 实例。优先使用宿主的 `@deepseek-ai/schemastery`；它在某些
 * 安装形态下可能不可解析，因此这里提供一个等价的最小实现作为回退，
 * 保证插件在任何 profile 下都能激活。
 */

/** 最小 Standard Schema 实现：支持 default / 基本类型收敛。 */
function makeStandardSchema({ validate }) {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-antigravity-acp',
      validate,
    },
  }
}

const FALLBACK = makeStandardSchema({
  validate(input) {
    const raw = input && typeof input === 'object' ? input : {}
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
    const str = (v, d) => (typeof v === 'string' ? v : d)
    const arr = (v, d) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : d)
    return {
      value: {
        provider: str(raw.provider, 'antigravity') || 'antigravity',
        displayName: str(raw.displayName, 'Antigravity (ACP)') || 'Antigravity (ACP)',
        command: str(raw.command, ''),
        extraArgs: arr(raw.extraArgs, []),
        cwd: str(raw.cwd, ''),
        proxy: str(raw.proxy, ''),
        noProxy: str(raw.noProxy, 'localhost,127.0.0.1,::1') || 'localhost,127.0.0.1,::1',
        contextWindow: num(raw.contextWindow, 1_048_576),
        timeoutMs: num(raw.timeoutMs, 600_000),
        catalogTtlMs: num(raw.catalogTtlMs, 21_600_000),
        models: arr(raw.models, []),
        allowNonGeminiModels: raw.allowNonGeminiModels === true,
        permissionMode: ['supervised', 'auto', 'full-access'].includes(raw.permissionMode)
          ? raw.permissionMode
          : 'supervised',
        showToolActivity: raw.showToolActivity !== false,
        sanitizeSystemPrompt: raw.sanitizeSystemPrompt !== false,
      },
    }
  },
})

/**
 * 构造 Config。
 * 先尝试真实的 schemastery（能得到更完整的错误信息），失败则回退。
 */
export async function buildConfig() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const Schema = mod.default ?? mod
    if (typeof Schema?.object === 'function') {
      const cfg = Schema.object({
        provider: Schema.string().default('antigravity'),
        displayName: Schema.string().default('Antigravity (ACP)'),
        command: Schema.string().default(''),
        extraArgs: Schema.array(Schema.string()).default([]),
        cwd: Schema.string().default(''),
        proxy: Schema.string().default(''),
        noProxy: Schema.string().default('localhost,127.0.0.1,::1'),
        contextWindow: Schema.number().default(1_048_576),
        timeoutMs: Schema.number().default(600_000),
        catalogTtlMs: Schema.number().default(21_600_000),
        models: Schema.array(Schema.string()).default([]),
        allowNonGeminiModels: Schema.boolean().default(false),
        permissionMode: Schema.union(['supervised', 'auto', 'full-access']).default('supervised'),
        showToolActivity: Schema.boolean().default(true),
        sanitizeSystemPrompt: Schema.boolean().default(true),
      })
      // 确认它真的满足宿主契约，否则退回内置实现
      if (cfg['~standard']?.validate) return { Config: cfg, source: 'schemastery' }
    }
  } catch {
    /* 解析失败，走回退 */
  }
  return { Config: FALLBACK, source: 'builtin' }
}

export { FALLBACK }
