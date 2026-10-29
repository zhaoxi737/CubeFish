import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'out')

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
  define: { 'process.env.NODE_ENV': '"production"' },
}

async function main() {
  await rm(out, { recursive: true, force: true })
  await mkdir(path.join(out, 'main'), { recursive: true })
  await mkdir(path.join(out, 'preload'), { recursive: true })
  await mkdir(path.join(out, 'renderer'), { recursive: true })

  // Main process: ESM bundle (Electron >= 28 supports ESM main).
  // banner：把 CJS 依赖（如 adm-zip）里的 require("fs") 映射到 createRequire，
  // 否则 esbuild 生成的动态 require 在 ESM 下会抛 "Dynamic require ... not supported"。
  await build({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'out/main/index.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    banner: {
      js: "import { createRequire as __qdoCreateRequire } from 'node:module';\nconst require = __qdoCreateRequire(import.meta.url);",
    },
  })

  // 插件沙箱 worker：跑在 utilityProcess 里，ESM + node 平台。
  await build({
    ...common,
    entryPoints: ['src/main/plugin-worker.ts'],
    outfile: 'out/plugin-worker.mjs',
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })

  // Preload: CJS bundle (sandboxed preload cannot be ESM).
  await build({
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'out/preload/index.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  })

  // Renderer: IIFE bundle loaded by file://, so no module/CORS issues.
  await build({
    ...common,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: 'out/renderer/app.js',
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    jsx: 'automatic',
  })

  await cp(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer/index.html'))
  await cp(path.join(root, 'src/renderer/styles.css'), path.join(out, 'renderer/styles.css'))

  // 美术资源（ComfyUI 生成，见 art/README.md）：存在才拷贝，缺了也不让构建失败
  const artFiles = ['mascot-fish.png', 'tile-grass.png', 'bg-hero.png', 'icon-pack.png']
  const artOut = path.join(out, 'renderer', 'assets')
  for (const name of artFiles) {
    const file = path.join(root, 'art', name)
    if (!existsSync(file)) continue
    await mkdir(artOut, { recursive: true })
    await cp(file, path.join(artOut, name))
  }

  console.log('[build] ok -> out/')
}

main().catch((err) => {
  console.error('[build] failed:', err)
  process.exit(1)
})
