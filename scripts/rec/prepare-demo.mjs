#!/usr/bin/env node
/**
 * 生成脱敏演示数据 out/demo-data/
 * ---------------------------------------------------------------------------
 * 从 %APPDATA%\QDOQMC 只读复制，排除缓存/会话/日志/事件等运行时目录，
 * 保留 instances / versions / libraries / runtimes / assets / plugins / plugin-data / settings.json，
 * 然后把 settings.json 里的个人信息与 Key 换成演示值，并把 llmBaseUrl 指向本地 mock LLM。
 *
 *   node scripts/rec/prepare-demo.mjs           # 已存在则只重新脱敏 settings.json
 *   node scripts/rec/prepare-demo.mjs --force   # 删掉 out/demo-data 重新完整复制
 *
 * 注意：只写 out/demo-data/，绝不修改 %APPDATA%\QDOQMC 源目录。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SRC = path.join(process.env.APPDATA ?? '', 'QDOQMC')
const DEST = path.join(ROOT, 'out', 'demo-data')

const KEEP_DIRS = ['instances', 'versions', 'libraries', 'runtimes', 'assets', 'plugins', 'plugin-data']
const KEEP_FILES = ['settings.json']

// 明确排除（即使未来出现在保留目录之外也不复制）；保留目录内的这些子目录不会被单独复制
const EXCLUDE_NAMES = new Set([
  'cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Session Storage',
  'Local Storage',
  'Network',
  'blob_storage',
  'Dictionaries',
  'Shared Dictionary',
  'logs',
  'events',
  'meta',
  'tmp',
])

const MOCK_LLM_BASE_URL = 'http://127.0.0.1:18080/v1'
const DEMO_KEYS = {
  playerName: '方块鱼玩家',
  apiKey: 'sk-demo-not-a-real-key',
  curseforgeApiKey: '',
  llmBaseUrl: MOCK_LLM_BASE_URL,
  // 品牌：方块鱼绿 + 不用用户壁纸（App 默认会回退到自带的 bg-user.jpg，是张暗色二次元壁纸；
  // 这里改用 App 自带、更贴合 Minecraft 主题的 bg-hero.png 副本，避免宣传片出现无关二次元大图）
  themeAccent: '#4ade80',
  customBackground: path.join(DEST, 'assets', 'brand-bg.png').replace(/\\/g, '/'),
}

// 实例显示名（只改 instance.json 的 name / playerName，不动 mods、存档、版本目录）
const INSTANCE_NAME_BY_ID = {
  'inst-mw72xe8y': '1.20.1 生存服',
  'inst-mvtojtxn': '1.21.1 模组服',
  default: '创造服',
}
// 演示数据里不用的插件（宣传片顶栏不要出现「余额」这类按钮）；只删 out/demo-data 副本
const DROP_PLUGINS = ['model-balance']

const DEMO_PLAYER_NAME = '方块鱼玩家'

const FORCE = process.argv.includes('--force')

function guardDest() {
  const outDir = path.join(ROOT, 'out') + path.sep
  if (!DEST.startsWith(outDir)) throw new Error(`拒绝操作：DEST 不在 ${outDir} 下：${DEST}`)
  if (DEST === outDir.slice(0, -1)) throw new Error('拒绝操作：DEST 等于 out/')
}

function copyDirRobocopy(name) {
  const from = path.join(SRC, name)
  const to = path.join(DEST, name)
  if (!existsSync(from)) return { name, skipped: true }
  mkdirSync(to, { recursive: true })
  const result = spawnSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.error && result.error.code === 'ENOENT') return null // 没有 robocopy → 调用方回退
  // robocopy 0–7 都是成功
  if (typeof result.status === 'number' && result.status > 7) {
    throw new Error(`robocopy ${name} 失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  return { name, skipped: false }
}

function copyDirFallback(name) {
  const from = path.join(SRC, name)
  const to = path.join(DEST, name)
  if (!existsSync(from)) return
  mkdirSync(to, { recursive: true })
  cpSync(from, to, {
    recursive: true,
    force: true,
    filter: (source) => !EXCLUDE_NAMES.has(path.basename(source)),
  })
}

function dirSize(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        files += 1
        try {
          bytes += statSync(p).size
        } catch {
          /* 忽略占用/消失的文件 */
        }
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { bytes, files }
}

function sanitizeSettings() {
  const srcFile = path.join(SRC, 'settings.json')
  const destFile = path.join(DEST, 'settings.json')
  let base
  if (existsSync(srcFile)) {
    base = JSON.parse(readFileSync(srcFile, 'utf8'))
  } else if (existsSync(destFile)) {
    base = JSON.parse(readFileSync(destFile, 'utf8'))
  } else {
    throw new Error(`找不到 settings.json：${srcFile}`)
  }

  const settings = { ...base }
  for (const [key, value] of Object.entries(DEMO_KEYS)) settings[key] = value

  // activeInstance 必须是 demo-data 里真实存在的实例；否则退回第一个实例目录
  const instancesDir = path.join(DEST, 'instances')
  const ids = existsSync(instancesDir)
    ? readdirSync(instancesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : []
  if (ids.length === 0) throw new Error(`演示数据里没有实例目录：${instancesDir}`)
  if (!ids.includes(settings.activeInstance)) settings.activeInstance = ids.includes('default') ? 'default' : ids[0]

  mkdirSync(DEST, { recursive: true })
  writeFileSync(destFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return { settings, ids }
}

/** 品牌背景：用 App 自带的 Minecraft 风背景提亮 + 绿色调，作为演示用自定义背景（不挂用户壁纸） */
function installBrandBackground() {
  const src = path.join(ROOT, 'out', 'renderer', 'assets', 'bg-hero.png')
  if (!existsSync(src)) {
    console.log(`  ⚠️ 没找到 ${src}，customBackground 会指向无效路径`)
    return null
  }
  mkdirSync(path.join(DEST, 'assets'), { recursive: true })
  const dest = path.join(DEST, 'assets', 'brand-bg.png')
  const ffmpeg = path.join(ROOT, 'video', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  if (existsSync(ffmpeg)) {
    const result = spawnSync(
      ffmpeg,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', src,
        // 提亮 + 加绿：App 自带一层 70–93% 的暗角遮罩，背景图必须足够亮才能在画面里看出方块地形
        '-vf', 'scale=1920:1200,eq=brightness=0.34:contrast=1.25:saturation=1.6:gamma=1.45,colorbalance=gm=0.18:gs=0.12',
        dest,
      ],
      { windowsHide: true, encoding: 'utf8' },
    )
    if (result.status === 0) return dest
    console.log(`  ⚠️ ffmpeg 处理品牌背景失败，回退为原图：${result.stderr || ''}`)
  }
  copyFileSync(src, dest)
  return dest
}

/** 只改 instances/<id>/instance.json 里的显示名与账号名，不碰 mods/存档/版本目录 */
function patchInstances() {
  const dir = path.join(DEST, 'instances')
  const rows = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(dir, entry.name, 'instance.json')
    if (!existsSync(file)) continue
    const data = JSON.parse(readFileSync(file, 'utf8'))
    data.name = INSTANCE_NAME_BY_ID[entry.name] ?? data.name
    data.playerName = DEMO_PLAYER_NAME
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    rows.push({ id: entry.name, name: data.name, playerName: data.playerName })
  }
  return rows
}

/** 删除演示数据里不需要的插件副本，并清理 permissions.json 里的对应条目 */
function dropPlugins() {
  const pluginsDir = path.join(DEST, 'plugins')
  if (!existsSync(pluginsDir)) return []
  const removed = []
  for (const name of DROP_PLUGINS) {
    const target = path.join(pluginsDir, name)
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
      removed.push(name)
    }
  }
  const permissionsFile = path.join(pluginsDir, 'permissions.json')
  if (removed.length > 0 && existsSync(permissionsFile)) {
    try {
      const permissions = JSON.parse(readFileSync(permissionsFile, 'utf8'))
      for (const name of removed) delete permissions[name]
      writeFileSync(permissionsFile, `${JSON.stringify(permissions, null, 2)}\n`, 'utf8')
    } catch {
      /* permissions.json 损坏不影响演示 */
    }
  }
  return removed
}

function main() {
  guardDest()
  if (!existsSync(SRC)) throw new Error(`找不到源数据目录：${SRC}`)
  if (!existsSync(path.join(SRC, 'settings.json'))) throw new Error(`源目录里没有 settings.json：${SRC}`)
  console.log(`源目录 : ${SRC}`)
  console.log(`目标   : ${DEST}`)

  const needCopy = FORCE || !existsSync(path.join(DEST, 'settings.json'))
  if (FORCE) {
    guardDest()
    console.log('--force：删除并重建 out/demo-data …')
    rmSync(DEST, { recursive: true, force: true })
  }

  if (needCopy) {
    mkdirSync(DEST, { recursive: true })
    for (const name of KEEP_DIRS) {
      const from = path.join(SRC, name)
      if (!existsSync(from)) {
        console.log(`  skip ${name}（源不存在）`)
        continue
      }
      const t0 = Date.now()
      const result = copyDirRobocopy(name)
      if (result === null) {
        console.log('  robocopy 不可用，回退到 Node fs.cpSync')
        copyDirFallback(name)
      }
      const size = dirSize(path.join(DEST, name))
      console.log(
        `  copy ${name.padEnd(12)} ${(size.bytes / 1024 / 1024).toFixed(1).padStart(8)} MB  ${String(size.files).padStart(6)} files  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      )
    }
    for (const name of KEEP_FILES) {
      const from = path.join(SRC, name)
      if (existsSync(from)) {
        // settings.json 会在 sanitizeSettings 里重写
        if (name === 'settings.json') continue
        cpSync(from, path.join(DEST, name), { force: true })
      }
    }
  } else {
    console.log('目标已存在：跳过复制（要完整重建请加 --force）')
  }

  const { settings, ids } = sanitizeSettings()
  const brandBg = installBrandBackground()
  const instances = patchInstances()
  const droppedPlugins = dropPlugins()
  const total = dirSize(DEST)
  console.log('')
  console.log(`脱敏完成：${(total.bytes / 1024 / 1024 / 1024).toFixed(2)} GB / ${total.files} 个文件`)
  console.log(`实例目录（${ids.length}）：`)
  for (const item of instances) console.log(`  ${item.id.padEnd(16)} name=${JSON.stringify(item.name)}  playerName=${JSON.stringify(item.playerName)}`)
  console.log(`已移除演示插件：${droppedPlugins.length > 0 ? droppedPlugins.join(', ') : '（无）'}`)
  console.log('settings.json 演示值：')
  console.log(`  playerName       = ${JSON.stringify(settings.playerName)}`)
  console.log(`  apiKey           = ${JSON.stringify(settings.apiKey)}`)
  console.log(`  curseforgeApiKey = ${JSON.stringify(settings.curseforgeApiKey)}`)
  console.log(`  llmBaseUrl       = ${JSON.stringify(settings.llmBaseUrl)}`)
  console.log(`  activeInstance   = ${JSON.stringify(settings.activeInstance)}`)
  console.log(`  themeAccent      = ${JSON.stringify(settings.themeAccent)}`)
  console.log(`  customBackground = ${JSON.stringify(settings.customBackground)}${brandBg ? '' : '  ⚠️ 品牌背景缺失'}`)
}

main()
