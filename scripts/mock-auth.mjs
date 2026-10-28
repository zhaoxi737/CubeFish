/**
 * 本地 mock 微软授权服务器（P17 测试用），不联网、不接触真实账号。
 *
 * 覆盖设备码 → token → Xbox Live → XSTS → Minecraft Services → profile 全链路：
 *   node scripts/mock-auth.mjs
 *   $env:QDOQMC_MS_BASE='http://127.0.0.1:18081'
 *   $env:QDOQMC_XBL_BASE='http://127.0.0.1:18081'
 *   $env:QDOQMC_XSTS_BASE='http://127.0.0.1:18081'
 *   $env:QDOQMC_MC_BASE='http://127.0.0.1:18081'
 *   $env:QDOQMC_MS_CLIENT_ID='test-client'
 *   electron . --login-ms
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

const PORT = Number(process.env.MOCK_AUTH_PORT || 18081)
const NAME = process.env.MOCK_AUTH_NAME || 'MockPlayer'
const PROFILE = { id: createHash('md5').update(NAME).digest('hex'), name: NAME }
let tokenCalls = 0

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8')
    console.log(`[mock-auth] ${req.method} ${url} ${bodyText.slice(0, 120)}`)

    if (url === '/consumers/oauth2/v2.0/devicecode') {
      json(res, 200, {
        device_code: 'mock-device-code',
        user_code: 'MOCK-1234',
        verification_uri: `http://127.0.0.1:${PORT}/device`,
        expires_in: 600,
        interval: 1,
        message: '请在浏览器打开链接并输入代码',
      })
      return
    }

    if (url === '/consumers/oauth2/v2.0/token') {
      tokenCalls += 1
      if (tokenCalls === 1) {
        json(res, 400, { error: 'authorization_pending', error_description: '用户还没有完成授权' })
        return
      }
      json(res, 200, { access_token: 'mock-msa-token', refresh_token: 'mock-refresh', expires_in: 3600, token_type: 'Bearer' })
      return
    }

    if (url === '/user/authenticate') {
      json(res, 200, { Token: 'mock-xbl-token', DisplayClaims: { xui: [{ uhs: 'mock-uhs' }] } })
      return
    }

    if (url === '/xsts/authorize') {
      json(res, 200, { Token: 'mock-xsts-token', DisplayClaims: { xui: [{ uhs: 'mock-uhs' }] } })
      return
    }

    if (url === '/authentication/login_with_xbox') {
      json(res, 200, { username: PROFILE.id, access_token: 'mock-mc-token', expires_in: 86400, token_type: 'Bearer' })
      return
    }

    if (url === '/minecraft/profile') {
      const auth = String(req.headers.authorization ?? '')
      if (!auth.startsWith('Bearer ')) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      json(res, 200, PROFILE)
      return
    }

    json(res, 404, { error: 'not found', path: url })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-auth] listening on http://127.0.0.1:${PORT}`)
})
