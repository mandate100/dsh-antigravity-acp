/**
 * dsh-antigravity-acp
 *
 * 把官方 Antigravity CLI 的 ACP 服务接入为 DSH 的一级模型供应商。
 *
 * 合规边界（刻意保持，与 Google 官方 FAQ 的立场一致）：
 *  - 只启动官方未修改的 `agy acp`，并使用真实的客户端标识
 *  - 从不读写 token、keyring 或凭据文件
 *  - 不自动切换账号、不做多账号轮换
 *  - 工具放权给 Antigravity 自身，权限请求按模式转发到 DSH 审批
 *
 * @module dsh-antigravity-acp
 */
import { AntigravityAdapter } from './lib/adapter.js'
import { buildAntigravityApi } from './lib/webapi.js'
import { buildConfig } from './lib/schema.js'

export const name = 'dsh-antigravity-acp'

/**
 * llm 注册路由；approval 与 agents 用于把权限请求转成 DSH 审批（可选）；
 * webServer 暴露设置页 API（可选，缺失时设置页只读不可写）。
 */
export const inject = ['llm']

/**
 * 行配置。宿主通过 `Config['~standard'].validate()` 校验并填充默认值，
 * 因此必须是 Standard Schema 实例。优先用宿主的 schemastery，缺失时回退到
 * 本包内置的等价实现，保证在任何 profile 下都能激活。
 */
const { Config: ResolvedConfig, source: configSource } = await buildConfig()
export const Config = ResolvedConfig

/** 设置页 API 的前缀。 */
const API_PREFIX = '/antigravity/api'

/** 读取并解析 query 参数（webServer 只支持 GET/HEAD，因此全部用 GET）。 */
function readQuery(req) {
  const u = new URL(req.url ?? '/', 'http://x')
  const out = {}
  for (const [k, v] of u.searchParams) out[k] = v
  return out
}

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx, config) {
  const logger = ctx.logger
  logger?.debug?.(`antigravity-acp: 配置校验器来源 = ${configSource}`)

  const adapter = new AntigravityAdapter({ options: config, logger, ctx: null })
  // 适配器维护的模型目录（状态卡展示用）
  const state = {
    get models() { return adapter.catalogModels ?? [] },
  }

  // ---------- 可选服务（attachments / approval / agents） ----------
  // cordis 上下文按鸭子类型解析服务：不声明 inject 就直接读 ctx.attachments
  // 会抛 "cannot get property without inject"。但**不能**把这些放进对象级
  // inject（`export const inject = [...]`）——桌面端的注入表是宿主启动时
  // 一次性收集的，对象级 inject 会推迟插件激活、错过收集窗口（whale-widget
  // issue #152/#154 的教训）。正确做法：apply 立即执行，可选服务用局部
  // ctx.inject([...], cb) 等齐后再赋给 adapter。
  ctx.inject(['attachments', 'approval', 'agents'], (svcCtx) => {
    adapter.ctx = svcCtx
    logger?.debug?.('antigravity-acp: attachments/approval/agents 服务已接入')
  })

  // ---------- 模型路由 ----------
  ctx.effect(() => {
    logger?.info?.(
      `antigravity-acp: 注册路由 "${config.provider}"（命令: ${config.command || 'agy'} acp，` +
      `权限模式: ${config.permissionMode ?? 'supervised'}）`,
    )

    const handle = ctx.llm.registerAdapter([config.provider], adapter)

    return async () => {
      try { handle?.() } catch { /* 已释放 */ }
      try {
        await adapter.dispose()
      } catch (err) {
        logger?.warn?.('antigravity-acp: 释放适配器失败: ' + (err?.message ?? err))
      }
    }
  }, 'antigravity-acp.register')

  // ---------- 设置页 API（GET only，DSH webServer 的硬约束） ----------
  // 关键：webServer 必须通过 ctx.inject(['webServer'], cb) 显式注入后才能拿到
  // （参照 dsh-whale-widget 的成熟做法）。放在 effect 回调参数上拿不到服务，
  // 路由会静默不注册，浏览器侧表现为 404。
  const apiDisposers = []
  ctx.effect(() => () => {
    for (const d of apiDisposers) { try { d() } catch { /* 已释放 */ } }
  }, 'antigravity-acp.webapi.cleanup')

  ctx.inject(['webServer'], (wsCtx) => {
    const webServer = wsCtx?.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      logger?.warn?.('antigravity-acp: webServer 服务不可用，设置页 API 未挂载')
      return
    }

    const api = buildAntigravityApi({ options: config, logger, state })

    const route = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          // /antigravity/api/<endpoint>?key=value&...
          const u = new URL(req.url ?? '/', 'http://x')
          const sub = u.pathname.slice(API_PREFIX.length).replace(/^\/+/, '').split('?')[0]
          const query = readQuery(req)

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            // 理论上 webserver 已拦，这里兜底
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }

          if (sub === 'status') {
            writeJson(res, 200, await api.status())
            return
          }
          if (sub === 'usage') {
            writeJson(res, 200, await api.usage())
            return
          }
          if (sub === 'diag') {
            writeJson(res, 200, await api.diag(query))
            return
          }
          if (sub === 'config') {
            // 写配置：GET 带参数。白名单字段、显式布尔解析。
            const editor = ctx.get('configEditor')
            const entry = ctx.fiber?.entry
            if (!editor || entry === undefined) {
              writeJson(res, 500, { error: '此 profile 不支持运行时配置修改' })
              return
            }
            const patch = {}
            if (query.permissionMode !== undefined) {
              if (!['supervised', 'auto', 'full-access'].includes(query.permissionMode)) {
                writeJson(res, 400, { error: 'permissionMode 取值非法: ' + query.permissionMode })
                return
              }
              patch.permissionMode = query.permissionMode
            }
            if (query.showToolActivity !== undefined) {
              patch.showToolActivity = query.showToolActivity === 'true' || query.showToolActivity === '1'
            }
            if (query.sanitizeSystemPrompt !== undefined) {
              patch.sanitizeSystemPrompt = query.sanitizeSystemPrompt === 'true' || query.sanitizeSystemPrompt === '1'
            }
            if (query.proxy !== undefined) {
              const p = query.proxy.trim()
              if (p && !/^https?:\/\//.test(p)) {
                writeJson(res, 400, { error: 'proxy 必须以 http:// 或 https:// 开头' })
                return
              }
              patch.proxy = p
            }
            if (Object.keys(patch).length === 0) {
              writeJson(res, 400, { error: '没有可识别的配置字段' })
              return
            }
            await editor.edit(entry, (current) => ({ ...current, ...patch }))
            logger?.info?.(`antigravity-acp: 设置页更新配置 ${JSON.stringify(patch)}`)
            writeJson(res, 200, { ok: true, patch })
            return
          }
          writeJson(res, 404, { error: 'unknown endpoint: ' + sub })
        } catch (err) {
          logger?.warn?.('antigravity-acp: API 异常: ' + (err?.message ?? err))
          writeJson(res, 500, { error: String(err?.message ?? err) })
        }
      },
    })

    logger?.debug?.(`antigravity-acp: 设置页 API 挂载于 ${API_PREFIX}（GET）`)
    apiDisposers.push(() => {
      try { route?.() } catch { /* 已释放 */ }
    })
  })
}
