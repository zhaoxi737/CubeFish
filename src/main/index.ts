import electron from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootKernel, type Kernel } from './kernel'
import {
  runAnalyzeCli,
  runChatCli,
  runContentCli,
  runDiagnoseCli,
  runFabricCli,
  runInstallCli,
  runInstancesCli,
  runCreateInstanceCli,
  runActivateInstanceCli,
  runLaunchTest,
  runModCli,
  runPluginToggleCli,
  runPluginsCli,
  runToolsCli,
  runUpdateApplyCli,
  runUpdateDownloadCli,
} from './cli'

const { app, BrowserWindow, shell } = electron
const here = path.dirname(fileURLToPath(import.meta.url))
const isSmoke = process.argv.includes('--smoke')

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

const installTarget = argValue('install')
const launchTarget = argValue('launch')
const fabricTarget = argValue('fabric')
const modTarget = argValue('mod')
const analyzeMode = process.argv.includes('--analyze')
const diagnoseMode = process.argv.includes('--diag')
const chatTarget = argValue('chat')
const enablePlugin = argValue('enable-plugin')
const disablePlugin = argValue('disable-plugin')
const pluginsMode = process.argv.includes('--plugins')
const toolsMode = process.argv.includes('--tools')
const updateDownloadMode = process.argv.includes('--update-download')
const updateApplyMode = process.argv.includes('--update-apply')
const instancesMode = process.argv.includes('--instances')
const createInstanceTarget = argValue('create-instance')
const activateInstanceTarget = argValue('activate-instance')
const contentTarget = argValue('content')
const waitMs = Number(argValue('wait') ?? 60000)

let mainWindow: BrowserWindowType | null = null
let kernel: Kernel | null = null

function createWindow(): BrowserWindowType {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0d12',
    title: 'QDOQMC',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // 安全边界：启动器不允许新开窗口或导航到外部页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  void win.loadFile(path.join(here, '../renderer/index.html'))
  return win
}

async function runSmoke(win: BrowserWindowType, k: Kernel, startedAt: number): Promise<void> {
  win.webContents.once('did-finish-load', async () => {
    const dir = path.join(process.cwd(), 'out')
    mkdirSync(dir, { recursive: true })
    const shot = async (name: string) => {
      const image = await win.webContents.capturePage()
      const file = path.join(dir, name)
      writeFileSync(file, image.toPNG())
      return file
    }
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    try {
      await wait(2400)
      const firstShot = await shot('smoke.png')

      // AI 对话：发一条自然语言，验证「模型 → 工具 → 回答」轨迹（需要 mock 或真实 LLM 环境变量）
      const sent = (await win.webContents.executeJavaScript(
        `(() => {
          const input = document.querySelector('.composer input')
          if (!input) return 'no-input'
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, '帮我检查下这个实例有没有冲突')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          const btn = document.querySelector('.composer button')
          if (btn) btn.click()
          return 'sent'
        })()`,
      )) as string
      await wait(4500)
      const aiShot = await shot('smoke-ai.png')
      const aiInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          sent: ${JSON.stringify(sent)},
          trace: [...document.querySelectorAll('.trace-item')].map((el) => el.textContent ?? ''),
          bubbles: [...document.querySelectorAll('.bubble')].slice(-2).map((el) => (el.textContent ?? '').slice(0, 240))
        })`,
      )) as string

      const uiText = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          versionSelect: document.querySelector('.version-row select')?.value ?? '',
          optionCount: document.querySelectorAll('.version-row select option').length,
          chips: [...document.querySelectorAll('.chip')].map((el) => el.textContent),
          launchLabel: document.querySelector('.launch-main')?.textContent ?? '',
          launchDisabled: Boolean(document.querySelector('.launch')?.disabled),
          status: document.querySelector('.statusbar')?.textContent ?? '',
          toast: document.querySelector('.toast')?.textContent ?? ''
        })`,
      )) as string

      const chat = (await win.webContents.executeJavaScript(
        `window.qdo.chat.send('/status').then((r) => r.text)`,
      )) as string

      // 打开「模组」市场，截一张真实 Modrinth 搜索结果的图
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '模组'); btn?.click(); return 'mods' })()`,
      )
      // 打开「插件」面板：验证插件列表与启用状态
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '插件'); btn?.click(); return 'plugins' })()`,
      )
      await wait(1200)
      const pluginsShot = await shot('smoke-plugins.png')
      const pluginsInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          rows: document.querySelectorAll('.plugin-row').length,
          states: [...document.querySelectorAll('.plugin-state')].map((el) => el.textContent ?? '')
        })`,
      )) as string
      // 关闭插件面板：可能需要点一次 + 等 React 更新
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const remaining = (await win.webContents.executeJavaScript(
          `(() => {
            const overlay = [...document.querySelectorAll('.overlay')].pop()
            if (!overlay) return 0
            const btn = [...overlay.querySelectorAll('button')].find((b) => b.textContent?.trim() === '关闭')
            btn?.click()
            return document.querySelectorAll('.overlay').length
          })()`,
        )) as number
        if (remaining === 0) break
        await wait(400)
      }
      await wait(300)

      // 点「冲突检查」前的模组面板
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '模组'); btn?.click(); return 'mods' })()`,
      )
      await wait(2600)
      const modsShot = await shot('smoke-mods.png')
      const modsInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ rows: document.querySelectorAll('.mod-row').length, first: document.querySelector('.mod-title')?.textContent ?? '' })`,
      )) as string

      // 切到「资源包」标签，验证内容类型切换 + 资源包搜索
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.kind-tab')].find((b) => b.textContent?.trim() === '资源包'); btn?.click(); return 'rp' })()`,
      )
      await wait(2800)
      const rpShot = await shot('smoke-resourcepack.png')
      const rpInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ rows: document.querySelectorAll('.mod-row').length, activeTab: document.querySelector('.kind-tab.is-active')?.textContent ?? '' })`,
      )) as string
      // 切回模组，再做冲突检查
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.kind-tab')].find((b) => b.textContent?.trim() === '模组'); btn?.click(); return 'mod' })()`,
      )
      await wait(900)

      // 点「冲突检查」，截一张冲突报告
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.drawer-actions button')].find((b) => b.textContent?.includes('冲突检查')); btn?.click(); return 'check' })()`,
      )
      await wait(1200)
      const conflictShot = await shot('smoke-conflict.png')
      const conflictInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ issues: document.querySelectorAll('.conflict-item').length, text: document.querySelector('.conflict-head')?.textContent ?? '' })`,
      )) as string

      const info = k.ctx.get('appMeta') as { version?: string } | undefined
      console.log(
        `SMOKE_RESULT ${JSON.stringify({
          ok: true,
          ms: Date.now() - startedAt,
          version: info?.version ?? app.getVersion(),
          plugins: k.summary.plugins,
          failed: k.summary.failed,
          screenshots: [firstShot, aiShot, pluginsShot, modsShot, rpShot, conflictShot],
          ui: JSON.parse(uiText),
          ai: JSON.parse(aiInfo),
          pluginPanel: JSON.parse(pluginsInfo),
          mods: JSON.parse(modsInfo),
          resourcepack: JSON.parse(rpInfo),
          conflict: JSON.parse(conflictInfo),
          chatStatus: chat,
        })}`,
      )
    } catch (err) {
      console.log(`SMOKE_RESULT ${JSON.stringify({ ok: false, error: String(err) })}`)
      process.exitCode = 1
    } finally {
      setTimeout(() => app.exit(0), 250)
    }
  })
}

app.setAppUserModelId('com.qdoqmc.launcher')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(async () => {
      const startedAt = Date.now()
      kernel = await bootKernel({
        dataDir: app.getPath('userData'),
        appName: app.getName(),
        appVersion: app.getVersion(),
        isSmoke,
        getWindow: () => mainWindow,
      })

      if (installTarget) {
        const code = await runInstallCli(kernel, installTarget)
        app.exit(code)
        return
      }
      if (fabricTarget) {
        const code = await runFabricCli(kernel, fabricTarget)
        app.exit(code)
        return
      }
      if (modTarget) {
        const code = await runModCli(kernel, modTarget)
        app.exit(code)
        return
      }
      if (analyzeMode) {
        const code = await runAnalyzeCli(kernel)
        app.exit(code)
        return
      }
      if (diagnoseMode) {
        const code = await runDiagnoseCli(kernel)
        app.exit(code)
        return
      }
      if (chatTarget) {
        const code = await runChatCli(kernel, chatTarget)
        app.exit(code)
        return
      }
      if (pluginsMode) {
        const code = await runPluginsCli(kernel)
        app.exit(code)
        return
      }
      if (enablePlugin) {
        const code = await runPluginToggleCli(kernel, enablePlugin, true)
        app.exit(code)
        return
      }
      if (disablePlugin) {
        const code = await runPluginToggleCli(kernel, disablePlugin, false)
        app.exit(code)
        return
      }
      if (toolsMode) {
        const code = await runToolsCli(kernel)
        app.exit(code)
        return
      }
      if (updateDownloadMode) {
        const code = await runUpdateDownloadCli(kernel)
        app.exit(code)
        return
      }
      if (updateApplyMode) {
        const code = await runUpdateApplyCli(kernel)
        // 给更新脚本留出启动时间，再退出进程（脚本会等本进程退出后替换文件）
        setTimeout(() => app.exit(code), 2000)
        return
      }
      if (instancesMode) {
        const code = await runInstancesCli(kernel)
        app.exit(code)
        return
      }
      if (createInstanceTarget) {
        const code = await runCreateInstanceCli(kernel, createInstanceTarget)
        app.exit(code)
        return
      }
      if (activateInstanceTarget) {
        const code = await runActivateInstanceCli(kernel, activateInstanceTarget)
        app.exit(code)
        return
      }
      if (contentTarget) {
        const code = await runContentCli(kernel, contentTarget)
        app.exit(code)
        return
      }
      if (launchTarget) {
        const code = await runLaunchTest(kernel, launchTarget, Number.isFinite(waitMs) ? waitMs : 60000)
        app.exit(code)
        return
      }

      mainWindow = createWindow()
      mainWindow.on('closed', () => {
        mainWindow = null
      })

      if (isSmoke) await runSmoke(mainWindow, kernel, startedAt)

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
      })
    })
    .catch((err) => {
      console.error('[main] 启动失败:', err)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    void kernel?.dispose()
  })
}
