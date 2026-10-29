/**
 * P40：开发目录定位工具（改源码 / 回滚用）。
 *
 * 打包版从 dist/QDOQMC-win32-x64/QDOQMC.exe 启动，源码在它上面两层；
 * 开发版从仓库根启动。这里统一找「package.json 里 name 是 qdoqmc 的目录」。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function findRepoRoot(extraHints: string[] = []): string | undefined {
  const candidates: string[] = []
  if (process.env.QDOQMC_REPO) candidates.push(process.env.QDOQMC_REPO)
  const push = (start: string): void => {
    let dir = start
    for (let level = 0; level < 6; level += 1) {
      candidates.push(dir)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  candidates.push(process.cwd())
  for (const hint of extraHints) if (hint) push(hint)
  for (const dir of candidates) {
    if (!dir) continue
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (pkg.name === 'qdoqmc') return dir
    } catch {
      /* 继续找 */
    }
  }
  return undefined
}

export async function runCommand(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, stdout: String(stdout), stderr: String(stderr) }
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? '') }
  }
}

/** Windows 上 npm 是 .cmd，必须经 cmd.exe 启动 */
export async function runNpm(args: string[], cwd: string, timeoutMs = 300_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (process.platform === 'win32') {
    return runCommand('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], cwd, timeoutMs)
  }
  return runCommand('npm', args, cwd, timeoutMs)
}
