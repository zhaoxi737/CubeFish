/**
 * 本地 mock CurseForge API（P20 测试用，P30 扩展搜索/详情/文件接口）：
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
const FAKE_MOD_NAME = 'cf-fake-mod.jar'
const FAKE_MOD_PAYLOAD = Buffer.from(`MOCK-CF-FAKE-MOD:${FAKE_MOD_NAME}`, 'utf8')
const FAKE_MOD_SHA1 = createHash('sha1').update(FAKE_MOD_PAYLOAD).digest().toString('hex')

/** 假 mod：id 111（fabric mod）、238222（JEI，用来验证 Key 的详情接口） */
const MOD_PROJECT = {
  id: 111,
  name: 'Mock JEI-like Mod',
  slug: 'mock-jei',
  summary: 'Mock mod used by smoke tests (CurseForge)',
  classId: 6,
  downloadCount: 123456,
  logo: { thumbnailUrl: 'http://127.0.0.1:19000/logo.png', url: 'http://127.0.0.1:19000/logo.png' },
  latestFilesIndexes: [
    { gameVersion: '1.20.1', fileId: 9001, filename: FAKE_MOD_NAME, releaseType: 1, modLoader: 4 },
    { gameVersion: '1.21.11', fileId: 9002, filename: FAKE_MOD_NAME, releaseType: 1, modLoader: 4 },
  ],
}
const FAKE_FILE = {
  id: 9001,
  modId: 111,
  displayName: 'Mock Mod 1.0.0 for 1.20.1',
  fileName: FAKE_MOD_NAME,
  downloadUrl: `http://127.0.0.1:${PORT}/cdn/${FAKE_MOD_NAME}`,
  fileLength: FAKE_MOD_PAYLOAD.length,
  releaseType: 1,
  fileDate: '2026-01-02T03:04:05Z',
  hashes: [{ value: FAKE_MOD_SHA1, algo: 1 }],
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sha1Hex(text) {
  return createHash('sha1').update(text).digest('hex')
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  const url = parsedUrl.pathname
  console.log(`[mock-cf] ${req.method} ${url}`)

  // 文件本体（模拟 CDN，不需要 x-api-key）
  if (url === `/cdn/${MOD_NAME}`) {
    const payload = Buffer.from(`MOCK-CF-MOD:${MOD_BYTES}`, 'utf8')
    res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': payload.length })
    res.end(payload)
    return
  }
  if (url === `/cdn/${FAKE_MOD_NAME}`) {
    res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': FAKE_MOD_PAYLOAD.length })
    res.end(FAKE_MOD_PAYLOAD)
    return
  }

  if (!req.headers['x-api-key']) {
    json(res, 403, { error: 'Forbidden: API Key missing or invalid' })
    return
  }

  // 旧 P20 接口：按 fileID 解析文件
  const legacyFile = /^\/v1\/mods\/(\d+)\/files\/(\d+)$/.exec(url)
  if (legacyFile) {
    json(res, 200, {
      data: {
        id: Number(legacyFile[2]),
        modId: Number(legacyFile[1]),
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

  // P30：游戏列表（Key 基础连通性）
  if (url === '/v1/games') {
    json(res, 200, { data: [{ id: 432, name: 'Minecraft', slug: 'minecraft' }], pagination: { totalCount: 1 } })
    return
  }

  // P30：搜索（Key 的搜索权限）
  if (url === '/v1/mods/search') {
    const classId = Number(parsedUrl.searchParams.get('classId') || '6')
    const kindMap = { 6: 6, 12: 12, 6552: 6552, 4471: 4471 }
    const cls = kindMap[classId] ?? 6
    json(res, 200, {
      data: [
        { ...MOD_PROJECT, classId: cls, id: 111 },
        {
          ...MOD_PROJECT,
          classId: cls,
          id: 222,
          name: 'Mock Second Project',
          slug: 'mock-second',
          downloadCount: 54321,
        },
      ],
      pagination: { index: 0, pageSize: 2, resultCount: 2, totalCount: 2 },
    })
    return
  }

  // P30：项目详情（支持 111 与 JEI 的 238222）
  const modDetail = /^\/v1\/mods\/(\d+)$/.exec(url)
  if (modDetail) {
    const id = Number(modDetail[1])
    if (id === 238222) {
      json(res, 200, { data: { ...MOD_PROJECT, id: 238222, name: 'Just Enough Items (JEI)', slug: 'jei' } })
      return
    }
    if (id === 111 || id === 222) {
      json(res, 200, { data: { ...MOD_PROJECT, id } })
      return
    }
    json(res, 404, { error: 'mod not found' })
    return
  }

  // P30：文件列表
  const modFiles = /^\/v1\/mods\/(\d+)\/files$/.exec(url)
  if (modFiles) {
    json(res, 200, { data: [FAKE_FILE], pagination: { index: 0, pageSize: 1, resultCount: 1, totalCount: 1 } })
    return
  }

  // P30：取下载地址（有的文件 downloadUrl 为空）
  const downloadUrl = /^\/v1\/mods\/(\d+)\/files\/(\d+)\/download-url$/.exec(url)
  if (downloadUrl) {
    json(res, 200, { data: `http://127.0.0.1:${PORT}/cdn/${FAKE_MOD_NAME}` })
    return
  }

  // P30：假 mod 文件本体
  if (url === `/cdn/${FAKE_MOD_NAME}`) {
    res.writeHead(200, { 'content-type': 'application/java-archive', 'content-length': FAKE_MOD_PAYLOAD.length })
    res.end(FAKE_MOD_PAYLOAD)
    return
  }

  json(res, 404, { error: 'not found', path: url })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-cf] listening on http://127.0.0.1:${PORT}`)
  console.log(`[mock-cf] fake mod sha1=${FAKE_MOD_SHA1} old mod sha1=${sha1Hex(MOD_NAME)}`)
})
