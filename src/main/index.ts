import electron from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootKernel, type Kernel } from './kernel'
import { runInstallCli, runLaunchTest } from './cli'

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

      const info = k.ctx.get('appMeta') as { version?: string } | undefined
      console.log(
        `SMOKE_RESULT ${JSON.stringify({
          ok: true,
          ms: Date.now() - startedAt,
          version: info?.version ?? app.getVersion(),
          plugins: k.summary.plugins,
          failed: k.summary.failed,
          screenshots: [firstShot],
          ui: JSON.parse(uiText),
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
