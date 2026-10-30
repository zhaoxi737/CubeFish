/**
 * 生成自动更新清单 latest.json（配合 updater 插件使用）。
 *
 * 用法：node scripts/make-feed.mjs [zip路径]
 * 输出：dist/latest.json
 *
 * 上传到任意静态托管（OSS/COS/R2/GitHub Releases）后，把 URL 填进设置里的「更新清单地址」即可。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

const defaultZip = path.join(root, 'dist', `${pkg.productName || pkg.name}-${pkg.version}-win32-x64.zip`)
const zipPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultZip
if (!existsSync(zipPath)) {
  console.error(`[feed] 找不到安装包：${zipPath}`)
  process.exit(1)
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

const size = statSync(zipPath).size
const digest = await sha256(zipPath)

const feed = {
  version: process.env.QDOQMC_FEED_VERSION ?? pkg.version,
  url: `https://cdn.example.com/qdoqmc/${pkg.productName || pkg.name}-${pkg.version}-win32-x64.zip`,
  sha256: digest,
  size,
  notes: process.env.QDOQMC_NOTES ?? '便携版更新',
  minSupported: '0.1.0',
  rollout: 100,
  releasedAt: new Date().toISOString(),
}

const out = path.join(root, 'dist', 'latest.json')
writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`, 'utf8')

console.log(`[feed] ${out}`)
console.log(`[feed] version=${feed.version} size=${(size / 1048576).toFixed(1)}MB sha256=${digest.slice(0, 16)}…`)
console.log('[feed] 把 url 换成你实际上传地址即可用于自动更新。')
