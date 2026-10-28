/**
 * 便携版打包（不依赖 electron-builder / 联网下载）：
 *
 *   dist/QDOQMC-win32-x64/
 *     QDOQMC.exe                 ← electron 重命名
 *     resources/app/             ← 我们的应用（out/ + package.json）
 *
 * 原理：主进程已经被 esbuild 打成一个 ESM 文件，运行时依赖全部打包进去了，
 * 所以只需要「Electron 运行时 + 应用目录」即可运行，不需要 node_modules。
 *
 * 用法：npm run package
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const outDir = path.join(distDir, 'QDOQMC-win32-x64')
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')

async function main() {
  console.log('[package] 构建应用…')
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { stdio: 'inherit' })

  console.log('[package] 清理 dist…')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })

  console.log('[package] 复制 Electron 运行时…')
  await cp(electronDist, outDir, { recursive: true })

  console.log('[package] 写入应用目录 resources/app…')
  const appRoot = path.join(outDir, 'resources', 'app')
  await mkdir(appRoot, { recursive: true })
  await cp(path.join(root, 'out'), path.join(appRoot, 'out'), { recursive: true })

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const appPkg = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    description: pkg.description,
    private: true,
    type: 'module',
    main: 'out/main/index.mjs',
  }
  await writeFile(path.join(appRoot, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`, 'utf8')

  console.log('[package] 重命名可执行文件…')
  const exeFrom = path.join(outDir, 'electron.exe')
  const exeTo = path.join(outDir, 'QDOQMC.exe')
  await rm(exeTo, { force: true })
  await rename(exeFrom, exeTo)

  console.log(`[package] 完成：${outDir}`)
  console.log(`[package] 运行：${exeTo}`)
}

main().catch((err) => {
  console.error('[package] 失败:', err)
  process.exit(1)
})
