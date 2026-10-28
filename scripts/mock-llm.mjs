/**
 * 本地 mock LLM（OpenAI 兼容），用于验证「模型 → 工具调用 → 结果 → 模型」完整链路，
 * 不需要真实 API Key。只在测试时启动：
 *   node scripts/mock-llm.mjs
 *   QDOQMC_LLM_BASE_URL=http://127.0.0.1:18080/v1 QDOQMC_LLM_KEY=test electron . --chat="帮我检查冲突"
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_LLM_PORT || 18080)

function toolCall(name, args) {
  return {
    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function decide(userText, lastToolContent) {
  if (lastToolContent !== undefined) {
    return { content: `已完成：${lastToolContent.replace(/\s+/g, ' ').slice(0, 180)}`, tool_calls: [] }
  }
  const text = userText
  if (/冲突|检查|兼容/.test(text)) return { content: '', tool_calls: [toolCall('analyze_conflicts', {})] }
  if (/崩|报错|日志|打不开/.test(text)) return { content: '', tool_calls: [toolCall('diagnose_crash', {})] }
  if (/装|安装|模组/.test(text)) {
    const query = /sodium/i.test(text) ? 'sodium' : /优化/.test(text) ? 'optimization' : 'jei'
    return { content: '', tool_calls: [toolCall('search_mods', { query, limit: 3 })] }
  }
  if (/启动|开玩|进游戏/.test(text)) return { content: '', tool_calls: [toolCall('get_status', {})] }
  return { content: '', tool_calls: [toolCall('get_status', {})] }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }

  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid json' } }))
      return
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const lastTool = [...messages].reverse().find((msg) => msg.role === 'tool')
    const lastUser = [...messages].reverse().find((msg) => msg.role === 'user')
    const choice = decide(lastUser?.content ?? '', lastTool ? (lastTool.content ?? '') : undefined)

    console.log(
      `[mock-llm] msgs=${messages.length} tools=${(payload.tools ?? []).length} model=${payload.model} stream=${Boolean(payload.stream)} user="${String(lastUser?.content ?? '').slice(0, 40)}" -> ${
        choice.tool_calls.length > 0 ? choice.tool_calls.map((call) => call.function.name).join(',') : 'final'
      }`,
    )

    if (payload.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (delta) => {
        res.write(`data: ${JSON.stringify({ id: 'mock-chunk', object: 'chat.completion.chunk', model: payload.model ?? 'mock-model', choices: [{ index: 0, delta }] })}\n\n`)
      }
      if (choice.tool_calls.length > 0) {
        send({
          role: 'assistant',
          tool_calls: choice.tool_calls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: call.function,
          })),
        })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const text = choice.content ?? ''
      const step = 8
      for (let i = 0; i < text.length; i += step) {
        send({ role: 'assistant', content: text.slice(i, i + step) })
      }
      send({ content: '' })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'mock-completion',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model ?? 'mock-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: choice.tool_calls.length > 0 ? null : choice.content,
              tool_calls: choice.tool_calls.length > 0 ? choice.tool_calls : undefined,
            },
            finish_reason: choice.tool_calls.length > 0 ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    )
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1/chat/completions`)
})
