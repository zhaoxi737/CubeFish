/** 文件 / 路径 / JSON 小工具（无第三方依赖）。 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size
  } catch {
    return undefined
  }
}

export async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(stripBom(await readFile(file, 'utf8'))) as T
  } catch {
    return fallback
  }
}

/** 用户手改/第三方工具写出的文件可能带 UTF-8 BOM，JSON.parse 会直接失败。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** Windows 文件名安全化（用于实例名/玩家名等落盘场景）。 */
export function safeName(input: string, fallback = 'instance'): string {
  const cleaned = input
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 64)
  return cleaned || fallback
}

export function shortHash(value: string, len = 8): string {
  return value.slice(0, len)
}
