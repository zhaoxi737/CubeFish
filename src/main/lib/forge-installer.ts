/**
 * Forge / NeoForge 安装器（P11）：执行 install_profile 的 processors 链。
 *
 * 流程（spec 1）：
 *   install_profile.data 的变量（{KEY}）→ 客户端值；
 *   processor.args 里的 4 种占位符 → 具体值：
 *     [group:artifact:version:classifier@ext]  Maven 坐标（不存在则从对应仓库下载）
 *     {KEY}                                     data[KEY][SIDE]
 *     /data/xxx                                 安装器 jar 内文件（解压到缓存）
 *     'literal'                                 去引号的字面量
 *   逐个执行 java -cp <classpath> <Main-Class> <args>，退出码非 0 立即失败。
 *
 * 能力边界：只处理 client 侧（SIDE=client），server-only 的 processor 跳过。
 */
import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseMaven } from './maven'

export interface ForgeInstallOptions {
  installerPath: string
  /** 全局 libraries 根 */
  librariesDir: string
  /** 数据根（processor 里的 {ROOT}） */
  dataRoot: string
  /** 原版客户端 jar（{MINECRAFT_JAR}） */
  minecraftJar: string
  mcVersion: string
  /** 用来跑 processor 的 java.exe */
  javaPath: string
  /** 临时目录（安装器内文件解压、日志） */
  tmpDir: string
  log: (message: string, data?: unknown) => void
}

export interface ForgeInstalledProfile {
  profileVersionId: string
  versionJson: Record<string, unknown>
  patchedJarPath?: string
  libraries: number
  processorsRun: number
}

interface InstallProfile {
  spec?: number
  profile?: string
  version?: string
  minecraft?: string
  json?: string
  data?: Record<string, Record<string, string>>
  processors?: { sides?: string[]; jar: string; classpath?: string[]; args: string[]; outputs?: Record<string, string> }[]
  libraries?: { name: string; downloads?: { artifact?: { path: string; sha1?: string; size?: number; url: string } } }[]
}

function repoFor(group: string): string {
  if (group.startsWith('net.neoforged')) return 'https://maven.neoforged.net/releases/'
  if (group.startsWith('net.minecraftforge')) return 'https://maven.minecraftforge.net/'
  return 'https://libraries.minecraft.net/'
}

function sha1File(file: string): string {
  return createHash('sha1').update(readFileSync(file)).digest('hex')
}

function readMainClass(jarPath: string): string {
  const zip = new AdmZip(jarPath)
  const entry = zip.getEntry('META-INF/MANIFEST.MF')
  if (!entry) throw new Error(`安装器处理器缺少 MANIFEST.MF：${path.basename(jarPath)}`)
  const text = entry.getData().toString('utf8').replace(/\r/g, '')
  // MANIFEST 的续行以空格开头
  const unfolded = text.replace(/\n /g, '')
  const match = /^Main-Class:\s*(.+)$/im.exec(unfolded)
  if (!match) throw new Error(`处理器缺少 Main-Class：${path.basename(jarPath)}`)
  return match[1].trim()
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

export async function installForgeProfile(options: ForgeInstallOptions): Promise<ForgeInstalledProfile> {
  const zip = new AdmZip(options.installerPath)
  const profileEntry = zip.getEntry('install_profile.json')
  if (!profileEntry) throw new Error('安装器缺少 install_profile.json')
  const profile = JSON.parse(profileEntry.getData().toString('utf8')) as InstallProfile
  if (profile.spec !== 1) throw new Error(`暂不支持的 install_profile spec：${profile.spec ?? '（无）'}`)

  const versionEntry = zip.getEntry(String(profile.json ?? 'version.json').replace(/^\/+/, ''))
  if (!versionEntry) throw new Error('安装器缺少 version.json')
  const versionJson = JSON.parse(versionEntry.getData().toString('utf8')) as Record<string, unknown> & {
    id?: string
    libraries?: InstallProfile['libraries']
  }
  const profileVersionId = (versionJson.id as string) ?? profile.version ?? 'forge'
  const librariesDir = options.librariesDir
  mkdirSync(librariesDir, { recursive: true })
  mkdirSync(options.tmpDir, { recursive: true })

  // 1) 变量：data[key].client，先做字面量/坐标替换
  const vars: Record<string, string> = {
    SIDE: 'client',
    MINECRAFT_JAR: options.minecraftJar,
    MINECRAFT_VERSION: options.mcVersion,
    ROOT: options.dataRoot,
    INSTALLER: options.installerPath,
    LIBRARY_DIR: librariesDir,
  }

  const resolveArtifact = async (coords: string): Promise<string> => {
    const coord = parseMaven(coords)
    if (!coord) throw new Error(`无法解析 Maven 坐标：${coords}`)
    const dest = path.join(librariesDir, coord.path)
    if (existsSync(dest)) return dest
    const url = `${repoFor(coord.group)}${coord.path}`
    options.log('下载安装器依赖', { artifact: coords, url })
    await downloadFile(url, dest)
    return dest
  }

  /** 只算路径（用于 data 变量：它们可能是 processor 的输出目标，不能提前下载） */
  const artifactPath = (coords: string): string => {
    const coord = parseMaven(coords)
    if (!coord) throw new Error(`无法解析 Maven 坐标：${coords}`)
    return path.join(librariesDir, coord.path)
  }

  const extractEntry = (entryName: string): string => {
    const clean = entryName.replace(/^\/+/, '')
    const entry = zip.getEntry(clean)
    if (!entry) throw new Error(`安装器内缺少文件：${entryName}`)
    const dest = path.join(options.tmpDir, ...clean.split('/'))
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, entry.getData())
    return dest
  }

  const substitute = async (token: string): Promise<string> => {
    const trimmed = token.trim()
    if (/^\[.+\]$/.test(trimmed)) return resolveArtifact(trimmed.slice(1, -1))
    if (/^\{[A-Z0-9_]+\}$/.test(trimmed)) {
      const key = trimmed.slice(1, -1)
      const value = vars[key]
      if (value === undefined) throw new Error(`安装变量未定义：${key}`)
      return value
    }
    if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1)
    if (trimmed.startsWith('/')) return extractEntry(trimmed)
    return token
  }

  // data 变量先展开：坐标只取路径（它们可能是 processor 的输出目标），字面量去引号，/data 解压
  for (const [key, sides] of Object.entries(profile.data ?? {})) {
    const raw = sides.client
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (/^\[.+\]$/.test(trimmed)) {
      vars[key] = artifactPath(trimmed.slice(1, -1))
    } else if (/^'.*'$/.test(trimmed)) {
      vars[key] = trimmed.slice(1, -1)
    } else if (trimmed.startsWith('/')) {
      vars[key] = extractEntry(trimmed)
    } else {
      vars[key] = raw
    }
  }

  // 预下载 install_profile.libraries 里带下载地址的依赖（neoform 映射、installertools 等）
  for (const lib of profile.libraries ?? []) {
    const artifact = lib.downloads?.artifact
    if (!artifact?.url || !artifact.path) continue
    const dest = path.join(librariesDir, artifact.path)
    if (existsSync(dest)) continue
    options.log('下载安装器依赖', { artifact: lib.name })
    await downloadFile(artifact.url, dest)
  }

  // 2) 执行 processors
  let processorsRun = 0
  for (const processor of profile.processors ?? []) {
    if (processor.sides && !processor.sides.includes('client')) {
      options.log('跳过 server 侧 processor', { jar: processor.jar })
      continue
    }
    const jarPath = await resolveArtifact(processor.jar)
    const classpathEntries: string[] = []
    for (const entry of processor.classpath ?? []) classpathEntries.push(await resolveArtifact(entry))
    classpathEntries.push(jarPath)
    const mainClass = readMainClass(jarPath)
    const args: string[] = []
    for (const arg of processor.args ?? []) args.push(await substitute(arg))

    options.log('执行安装器 processor', { mainClass, args: args.length })
    await runJava(options.javaPath, ['-cp', classpathEntries.join(path.delimiter), mainClass, ...args], options)
    processorsRun += 1
  }

  // 3) 合并 libraries：version.json 的 + install_profile 的（去重）
  const merged = new Map<string, NonNullable<InstallProfile['libraries']>[number]>()
  for (const lib of [...(versionJson.libraries ?? []), ...(profile.libraries ?? [])]) {
    if (!lib?.name) continue
    const coord = parseMaven(lib.name)
    const key = coord ? `${coord.group}:${coord.artifact}:${coord.classifier ?? ''}` : lib.name
    merged.set(key, lib)
  }

  // 4) 找到 patched client jar（processor 输出到 libraries）
  let patchedJarPath: string | undefined
  for (const [key, value] of Object.entries(vars)) {
    if (!/PATCHED/.test(key)) continue
    if (existsSync(value)) patchedJarPath = value
  }

  return {
    profileVersionId,
    versionJson: { ...versionJson, libraries: [...merged.values()] },
    patchedJarPath,
    libraries: merged.size,
    processorsRun,
  }
}

function runJava(javaPath: string, args: string[], options: ForgeInstallOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, {
      cwd: options.dataRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    const append = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('安装器 processor 超时（10 分钟）'))
    }, 10 * 60 * 1000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        options.log('processor 失败输出', { code, tail })
        reject(new Error(`安装器 processor 退出码 ${code}：${tail.slice(-800)}`))
      }
    })
  })
}

/** 供上层判断 patched jar 是否存在（调试用） */
export function fileExists(file: string | undefined): boolean {
  return Boolean(file && existsSync(file))
}

/**
 * 调用官方安装器的 --installClient（NeoForge/Forge 通用）。
 * 官方安装器除了跑 processors，还会做 FML 生产模式所需的 profile 注入与 manifest 处理，
 * 比手工执行 processors 更稳。
 */
export async function runOfficialInstaller(options: {
  installerPath: string
  dataRoot: string
  javaPath: string
  log: (message: string) => void
}): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(options.javaPath, ['-jar', options.installerPath, '--installClient', options.dataRoot], {
      cwd: options.dataRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    const onData = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const timer = setTimeout(() => {
      child.kill()
      options.log('官方安装器超时（15 分钟）')
      resolve(false)
    }, 15 * 60 * 1000)
    child.on('error', (err) => {
      clearTimeout(timer)
      options.log(`官方安装器启动失败：${err.message}`)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const lines = tail.split(/\r?\n/).filter(Boolean)
      for (const line of lines.slice(-6)) options.log(`[installer] ${line}`)
      if (code !== 0) {
        options.log(`官方安装器退出码 ${code}`)
        resolve(false)
        return
      }
      resolve(tail.includes('Successfully installed'))
    })
  })
}

export { sha1File }
