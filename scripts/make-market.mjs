/**
 * 生成插件市场 feed（P9）：把插件目录打成 zip、算 sha256、用 Ed25519 签名。
 *
 * 用法：
 *   node scripts/make-market.mjs [插件目录] [基础URL]
 *
 * 默认：samples/plugins/hello-world，基础 URL http://127.0.0.1:18083
 * 产物：dist/market.json + dist/market/<id>-<version>.zip + dist/market/dev-{public,private}.pem
 *
 * 生产环境：把私钥换成你自己的（QDOQMC_MARKET_PRIVKEY 指向 PEM 文件），
 * 只公开公钥（填到启动器设置里），私钥绝不进仓库/客户端。
 */
import AdmZip from 'adm-zip'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = path.resolve(process.argv[2] ?? path.join(root, 'samples', 'plugins', 'hello-world'))
const baseUrl = (process.argv[3] ?? 'http://127.0.0.1:18083').replace(/\/+$/, '')

if (!existsSync(path.join(pluginDir, 'plugin.json'))) {
  console.error(`[market] 找不到插件清单：${path.join(pluginDir, 'plugin.json')}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'))
const outDir = path.join(root, 'dist', 'market')
mkdirSync(outDir, { recursive: true })

// 1) 打包（内容放在根目录，不带外层文件夹）
const zip = new AdmZip()
zip.addLocalFolder(pluginDir)
const zipBuffer = zip.toBuffer()
const zipName = `${manifest.id}-${manifest.version}.zip`
const zipPath = path.join(outDir, zipName)
writeFileSync(zipPath, zipBuffer)

const sha256 = createHash('sha256').update(zipBuffer).digest('hex')
const size = zipBuffer.length

// 2) 密钥：优先环境变量里的私钥，否则生成开发用密钥对
const privEnv = process.env.QDOQMC_MARKET_PRIVKEY
let privateKey
let publicKeyPem
if (privEnv && existsSync(privEnv)) {
  privateKey = readFileSync(privEnv, 'utf8')
  publicKeyPem = process.env.QDOQMC_MARKET_PUBKEY_PEM ?? readFileSync(privEnv.replace('.pem', '.pub.pem'), 'utf8')
} else {
  const pair = generateKeyPairSync('ed25519')
  privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' })
  writeFileSync(path.join(outDir, 'dev-private.pem'), privateKey, 'utf8')
  writeFileSync(path.join(outDir, 'dev-public.pem'), publicKeyPem, 'utf8')
}

// 3) 签名 payload
const payload = {
  generatedAt: new Date().toISOString(),
  plugins: [
    {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      permissions: manifest.permissions ?? [],
      download: {
        url: `${baseUrl}/market/${zipName}`,
        sha256,
        size,
      },
    },
  ],
}
const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
const signature = sign(null, payloadBytes, privateKey)

const feed = {
  format: 'qdoqmc-market/1',
  payload: payloadBytes.toString('base64'),
  signature: signature.toString('base64'),
}
const feedPath = path.join(root, 'dist', 'market.json')
writeFileSync(feedPath, `${JSON.stringify(feed, null, 2)}\n`, 'utf8')

console.log(`[market] feed: ${feedPath}`)
console.log(`[market] zip : ${zipPath} (${(size / 1024).toFixed(1)}KB, sha256=${sha256.slice(0, 16)}…)`)
console.log(`[market] 公钥已写入 dist/market/dev-public.pem，把它填到启动器设置「市场公钥」即可验签。`)
