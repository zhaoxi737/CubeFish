/**
 * QDOQMC 示例插件：hello-world
 *
 * 演示三件事：
 * 1. 注册聊天命令（/hello）——用户可直接调用；
 * 2. 注册 AI 工具（plugin_hello）——模型可以调用；
 * 3. 使用插件存储（api.storage）——按插件 id 命名空间持久化。
 */
export function apply(api) {
  api.registerCommand({
    name: 'hello',
    description: '示例插件命令：打个招呼',
    async run() {
      const total = ((await api.storage.get('greetCount', 0)) ?? 0) + 1
      await api.storage.set('greetCount', total)
      return `你好！这是示例插件「hello-world」返回的第 ${total} 次问候。`
    },
  })

  api.registerTool({
    name: 'plugin_hello',
    description: '示例插件提供的工具：向某人问好（用来验证插件注册的 AI 工具可以被模型调用）',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要问候的名字' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      return {
        ok: true,
        summary: `你好，${args?.name || '世界'}！—— 来自示例插件 hello-world`,
      }
    },
  })

  api.log.info('hello-world 已加载')
  return () => api.log.info('hello-world 已卸载')
}
