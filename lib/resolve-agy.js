/**
 * agy 命令解析。
 *
 * DSH 宿主进程的 PATH 不一定包含 `%LOCALAPPDATA%\agy\bin`（agy 官方安装器的
 * 用户级 PATH 只有新开的终端才继承），所以裸命令 `agy` 在插件里不可靠：
 *  - 状态页会误报「未找到」
 *  - adapter spawn 会直接 ENOENT
 *
 * 解析顺序：
 *  1. 配置里写的是路径（含 \ 或 /）→ 原样使用
 *  2. 已知安装位置：%LOCALAPPDATA%\agy\bin\agy.exe 等
 *  3. where.exe agy（走当前进程 PATH）
 *  4. 都失败 → 返回原命令，让底层报出真实错误
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 相对 `%LOCALAPPDATA%` 的候选子路径。 */
const CANDIDATE_SUBPATHS = [
  ['agy', 'bin', 'agy.exe'],
  ['agy', 'agy.exe'],
  ['Programs', 'agy', 'agy.exe'],
]

function whereAgy(env) {
  return new Promise((resolve) => {
    execFile('where.exe', ['agy'], { timeout: 5000, env, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const first = String(stdout)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0]
      resolve(first && existsSync(first) ? first : null)
    })
  })
}

/**
 * 把配置里的 command 解析成可执行的绝对路径。
 * @returns {Promise<string>} 绝对路径，或解析失败时的原命令。
 */
export async function resolveAgyCommand(command, { env = process.env } = {}) {
  const cmd = String(command || 'agy').trim() || 'agy'
  // 已经是路径 → 信任用户配置
  if (/[\\/]/.test(cmd)) return cmd
  // 只处理裸的 agy / agy.exe；其他自定义命令名原样返回
  if (!/^agy(\.exe)?$/i.test(cmd)) return cmd

  const localAppData = env.LOCALAPPDATA
    || (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : '')
    || (homedir() ? join(homedir(), 'AppData', 'Local') : '')
  if (localAppData) {
    for (const parts of CANDIDATE_SUBPATHS) {
      const p = join(localAppData, ...parts)
      if (existsSync(p)) return p
    }
  }
  const found = await whereAgy(env)
  if (found) return found
  return cmd
}
