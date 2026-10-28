/**
 * 本地 mock CurseForge API（P20 测试用）：解析 fileID → 文件名/下载地址。
 *
 *   node scripts/mock-cf.mjs
 *   $env:QDOQMC_CF_API_BASE='http://127.0.0.1:18082'
 *   $env:QDOQMC_CF_API_KEY='mock-cf-key'
 *   electron . --curse-pack="D:\packs\cf-test.zip"
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

const PORT = Number(process.env.MOCK_CF_PORT || 18082)
const MOD_NAME = 'cf-test-mod.jar'
const MOD_BYTES = createHash('sha1').update(`mock-cf-${MOD_NAME}`).digest().toString('hex')

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  console.log(`[mock-cf] ${req.method} ${url}`)

  const fileMatch = /^\/v1\/mods\/(\d+)\/files\/(\d+)$/.exec(url)
  if (fileMatch) {
    if (!req.headers['x-api-key']) {
      json(res, 403, { error: 'missing api key' })
      return
    }
    json(res, 200, {
      data: {
        id: Number(fileMatch[2]),
        modId: Number(fileMatch[1]),
        displayName: MOD_NAME,
        fileName: MOD_NAME,
        downloadUrl: `http://127.0.0.1:${PORT}/cdn/${MOD_NAME}`,
        fileLength: 4096,
      },
    })
    return
  }

  if (url === `/cdn/${MOD_NAME}`) {
    const payload = Buffer.from(`MOCK-CF-MOD:${MOD_BYTES}`, 'utf8')
    res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': payload.length })
    res.end(payload)
    return
  }

  json(res, 404, { error: 'not found', path: url })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-cf] listening on http://127.0.0.1:${PORT}`)
})
