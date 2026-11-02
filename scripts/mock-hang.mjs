/**
 * 「模型卡住」模拟端点：接受连接、读掉请求、永远不回任何字节。
 * 用来确定性地复现「模型端不返回数据」的场景（验证看门狗 / 停止按钮 / 界面是否被拖死）。
 *
 *   node scripts/mock-hang.mjs 18081
 */
import http from 'node:http'

const PORT = Number(process.argv[2] || 18081)

const server = http.createServer((req, res) => {
  console.log(`[mock-hang] ${req.method} ${req.url} —— 只挂住，不返回`)
  req.on('data', () => {})
  req.on('end', () => {
    // 故意什么都不做：连接保持打开，客户端永远等不到响应头
  })
  req.socket.on('close', () => console.log('[mock-hang] 客户端断开'))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-hang] listening on http://127.0.0.1:${PORT}`)
})
