/**
 * 与官方的 `agy acp` 保持一条 JSON-RPC stdio 连接。
 *
 * 设计约束（对应官方 ToS 立场）：
 *  - 只启动官方未修改的 agy 二进制
 *  - 凭据由 agy 自己管理，本模块从不读写 token / keyring
 *  - 使用真实客户端标识，不做 User-Agent 伪装
 *  - 单连接，不跑多账号池
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'

/** JSON-RPC 错误包装，便于上层分类成 AUTH / QUOTA / TRANSPORT。 */
export class AcpError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    this.data = data
    this.method = method
  }
}

/**
 * 一条 ACP 连接的生命周期。
 * 事件：
 *  - notification (method, params)：session/update 等
 *  - request (id, method, params)：agent 反向发起的请求（权限等）
 *  - exit (code, signal)
 */
export class AcpConnection extends EventEmitter {
  #proc
  #pending = new Map()
  #nextId = 1
  #closed = false
  #stderrTail = ''

  constructor({ command, args, cwd, env, logger }) {
    super()
    this.logger = logger
    this.#proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.#proc.on('error', (err) => {
      this.#failAll(err)
      this.emit('exit', null, null, err)
    })
    this.#proc.on('exit', (code, signal) => {
      this.#closed = true
      this.#failAll(new AcpError(`agy acp exited (code=${code}, signal=${signal})`))
      this.emit('exit', code, signal)
    })

    const rl = readline.createInterface({ input: this.#proc.stdout })
    rl.on('line', (line) => this.#onLine(line))

    this.#proc.stderr.setEncoding('utf8')
    this.#proc.stderr.on('data', (chunk) => {
      // 只留尾部若干字节用于错误诊断，不写进 stdout（stdout 是协议通道）
      this.#stderrTail = (this.#stderrTail + chunk).slice(-4096)
      this.logger?.debug?.('agy stderr: ' + chunk.trimEnd())
    })
  }

  get closed() {
    return this.#closed
  }

  get stderrTail() {
    return this.#stderrTail
  }

  #onLine(line) {
    const text = line.trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      // 非协议输出（少数日志泄漏），丢弃但留下痕迹
      this.logger?.debug?.('agy acp 非 JSON 输出: ' + text.slice(0, 200))
      return
    }

    const isResponse = msg.id != null && (msg.result !== undefined || msg.error !== undefined)
    if (isResponse) {
      const entry = this.#pending.get(msg.id)
      if (!entry) return
      this.#pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) {
        entry.reject(new AcpError(msg.error.message || 'ACP error', {
          code: msg.error.code,
          data: msg.error.data,
          method: entry.method,
        }))
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    if (msg.method && msg.id != null) {
      this.emit('request', msg.id, msg.method, msg.params ?? {})
      return
    }
    if (msg.method) {
      this.emit('notification', msg.method, msg.params ?? {})
    }
  }

  #failAll(err) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.#pending.clear()
  }

  request(method, params, { timeoutMs = 300_000, signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new AcpError('ACP 连接已关闭', { method }))
    }
    const id = this.#nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        // 取消也要告知 agent，否则它会继续生成
        try {
          this.notify('session/cancel', { sessionId: params?.sessionId })
        } catch { /* 连接可能已断 */ }
        reject(new AcpError('已取消', { method }))
      }
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.#pending.delete(id)
            signal?.removeEventListener('abort', onAbort)
            reject(new AcpError(`请求超时: ${method}`, { method }))
          }, timeoutMs)
        : null

      this.#pending.set(id, { resolve, reject, timer, method })
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        this.#proc.stdin.write(payload + '\n')
      } catch (err) {
        this.#pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(new AcpError('写入 ACP 失败: ' + err.message, { method }))
      }
    })
  }

  notify(method, params) {
    if (this.#closed) return
    try {
      this.#proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      /* 连接已断，忽略 */
    }
  }

  reply(id, result) {
    if (this.#closed) return
    try {
      this.#proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
    } catch { /* ignore */ }
  }

  replyError(id, code, message) {
    if (this.#closed) return
    try {
      this.#proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
    } catch { /* ignore */ }
  }

  async close() {
    this.#closed = true
    this.#failAll(new AcpError('连接被关闭'))
    try { this.#proc.stdin.end() } catch { /* ignore */ }
    // 给进程一点体面退出的时间，再强杀
    await new Promise((resolve) => {
      const done = () => resolve()
      const timer = setTimeout(() => { try { this.#proc.kill() } catch {} ; resolve() }, 2000)
      this.#proc.once('exit', () => { clearTimeout(timer); done() })
      try { this.#proc.kill() } catch { clearTimeout(timer); done() }
    })
  }
}
