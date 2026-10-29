import electron from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
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
  runMarketCli,
  runMarketInstallCli,
  runModpackCli,
  runInspectModpackCli,
  runNeoForgeCli,
  runForgeCli,
  runFixesCli,
  runApplyFixCli,
  runCallToolCli,
  runBindAccountCli,
  runExportInstanceCli,
  runImportInstanceCli,
  runGameLogCli,
  runCursePackCli,
  runInspectCursePackCli,
  runAccountCli,
  runLoginMsCli,
  runLogoutCli,
  runAccountsCli,
  runSwitchAccountCli,
  runRemoveAccountCli,
  runToolsCli,
  runUpdateApplyCli,
  runUpdateDownloadCli,
  runP32CheckCli,
} from './cli'

const { app, BrowserWindow, shell } = electron
// 测试/多开隔离：QDOQMC_USER_DATA 指定独立的 Electron userData（同时改变单实例锁与日志目录）
if (process.env.QDOQMC_USER_DATA) {
  try {
    app.setPath('userData', process.env.QDOQMC_USER_DATA)
    app.setPath('sessionData', process.env.QDOQMC_USER_DATA)
  } catch {
    /* 忽略：必须在 ready 之前 */
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
// 插件沙箱 worker 与主进程 bundle 同级（out/plugin-worker.mjs）
process.env.QDOQMC_PLUGIN_WORKER = path.join(here, '..', 'plugin-worker.mjs')
const isSmoke = process.argv.includes('--smoke')
const isCrashSmoke = process.argv.includes('--smoke-crash')
const isSettingsSmoke = process.argv.includes('--smoke-settings')

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
const marketMode = process.argv.includes('--market')
const marketInstallTarget = argValue('market-install')
const modpackTarget = argValue('modpack')
const inspectModpackTarget = argValue('inspect-modpack')
const neoforgeTarget = argValue('neoforge')
const forgeTarget = argValue('forge')
const fixesMode = process.argv.includes('--fixes')
const applyFixTarget = argValue('apply-fix')
const callToolTarget = argValue('call-tool')
const p32CheckMode = process.argv.includes('--check-p32')
const bindAccountTarget = argValue('bind-account')
const bindInstanceTarget = argValue('bind-instance')
const unbindAccountMode = process.argv.includes('--unbind-account')
const exportInstanceTarget = argValue('export-instance')
const exportToTarget = argValue('export-to')
const importInstanceTarget = argValue('import-instance')
const gameLogTarget = argValue('game-log')
const cursePackTarget = argValue('curse-pack')
const inspectCurseTarget = argValue('inspect-curse-pack')
const accountMode = process.argv.includes('--account')
const loginMsMode = process.argv.includes('--login-ms')
const logoutMode = process.argv.includes('--logout')
const accountsMode = process.argv.includes('--accounts')
const switchAccountTarget = argValue('switch-account')
const removeAccountTarget = argValue('remove-account')
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


async function runSettingsSmoke(win: BrowserWindowType, startedAt: number): Promise<void> {
  win.webContents.once('did-finish-load', async () => {
    const dir = path.join(process.cwd(), 'out')
    mkdirSync(dir, { recursive: true })
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    try {
      await wait(2400)
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '设置'); btn?.click(); return 'settings' })()`,
      )
      await wait(1200)
      const image = await win.webContents.capturePage()
      const file = path.join(dir, 'smoke-settings.png')
      writeFileSync(file, image.toPNG())
      await win.webContents.executeJavaScript(`(() => { const body = document.querySelector('.dialog-body'); if (body) body.scrollTop = body.scrollHeight; return 'scrolled' })()`)
      await wait(700)
      // P30：点「测试 Key」验证 CurseForge 三个接口的连通性（需要环境变量里带 Key）
      const cfTested = (await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dialog button')].find((b) => b.textContent?.trim() === '测试 Key'); if (!btn) return 'no-button'; btn.click(); return 'clicked' })()`,
      )) as string
      if (cfTested === 'clicked') await wait(3500)
      const cfText = (await win.webContents.executeJavaScript(
        `document.querySelector('.cf-test-result')?.textContent ?? ''`,
      )) as string
      const bottomImage = await win.webContents.capturePage()
      writeFileSync(path.join(dir, 'smoke-settings-bottom.png'), bottomImage.toPNG())
      const info = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          accounts: [...document.querySelectorAll('.account-item')].map((el) => el.textContent ?? ''),
          loginButton: [...document.querySelectorAll('.dialog button')].map((el) => el.textContent ?? '').find((text) => text.includes('微软账号')) ?? '',
          clientIdField: Boolean([...document.querySelectorAll('.field-label')].find((el) => el.textContent?.includes('client_id'))),
          curseforgeKeyField: Boolean([...document.querySelectorAll('.field-label')].find((el) => el.textContent?.includes('CurseForge'))),
          titleField: Boolean([...document.querySelectorAll('.field-label')].find((el) => el.textContent?.includes('标题'))),
          accentInput: Boolean(document.querySelector('input[type="color"]')),
          gpuToggle: Boolean([...document.querySelectorAll('.field-inline span')].find((el) => (el.textContent ?? '').includes('高性能显卡'))),
          javaRadios: document.querySelectorAll('input[name="java-pref"]').length,
          cfTest: ${JSON.stringify(cfText)}
        })`,
      )) as string
      console.log(`SETTINGS_SMOKE_RESULT ${JSON.stringify({ ok: true, screenshot: file, ms: Date.now() - startedAt, ui: JSON.parse(info) })}`)
      app.exit(0)
    } catch (err) {
      console.log(`SETTINGS_SMOKE_RESULT ${JSON.stringify({ ok: false, error: String(err) })}`)
      app.exit(1)
    }
  })
}

async function runCrashSmoke(win: BrowserWindowType, k: Kernel, startedAt: number): Promise<void> {
  win.webContents.once('did-finish-load', async () => {
    const dir = path.join(process.cwd(), 'out')
    mkdirSync(dir, { recursive: true })
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    try {
      await wait(2400)
      // 点击启动：当前实例预置了坏模组，Fabric 会在依赖解析阶段崩溃并弹错误窗口
      const clicked = (await win.webContents.executeJavaScript(
        `(() => { const btn = document.querySelector('.launch'); if (!btn || btn.disabled) return 'disabled'; btn.click(); return 'clicked' })()`,
      )) as string
      await wait(16_000)
      // 模拟用户关掉 Fabric 的崩溃窗口：结束进程 → 启动器收到退出事件
      const launch = k.ctx.get('launch') as { stop(): Promise<unknown> }
      await launch.stop()
      let fixes: string[] = []
      let diagnosis = ''
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await wait(1000)
        const info = (await win.webContents.executeJavaScript(
          `JSON.stringify({
            fixButtons: [...document.querySelectorAll('.fix-actions button')].map((el) => el.textContent ?? ''),
            diagnosis: document.querySelector('.diag-summary')?.textContent ?? '',
            exitCard: document.querySelector('.diag-block') ? 'diag' : document.querySelector('.bubble') ? 'bubble' : 'none',
            launchSub: document.querySelector('.launch-sub')?.textContent ?? ''
          })`,
        )) as string
        const parsed = JSON.parse(info) as { fixButtons: string[]; diagnosis: string; exitCard: string; launchSub: string }
        if (process.env.QDOQMC_CRASH_SMOKE_DEBUG) console.log(`CRASH_POLL ${attempt} ${JSON.stringify(parsed)}`)
        if (parsed.fixButtons.length > 0) {
          fixes = parsed.fixButtons
          diagnosis = parsed.diagnosis
          break
        }
      }
      const fixShot = await shotCrash('smoke-fix.png')
      const info = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          fixButtons: [...document.querySelectorAll('.fix-actions button')].map((el) => el.textContent ?? ''),
          diagnosis: document.querySelector('.diag-summary')?.textContent ?? '',
          exitHint: document.querySelector('.launch-sub')?.textContent ?? ''
        })`,
      )) as string
      console.log(
        `CRASH_SMOKE_RESULT ${JSON.stringify({ ok: fixes.length > 0, clicked, diagnosis, fixes, screenshot: fixShot, ms: Date.now() - startedAt, ui: JSON.parse(info) })}`,
      )
      app.exit(fixes.length > 0 ? 0 : 1)
    } catch (err) {
      console.log(`CRASH_SMOKE_RESULT ${JSON.stringify({ ok: false, error: String(err) })}`)
      app.exit(1)
    }

    async function shotCrash(name: string): Promise<string> {
      const image = await win.webContents.capturePage()
      const file = path.join(dir, name)
      writeFileSync(file, image.toPNG())
      return file
    }
  })
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

      // ---- P29：打开下载中心（游戏页），看版本 ↔ 加载器可用性 ----
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '下载'); btn?.click(); return 'dc-open' })()`,
      )
      await wait(1500)
      const loaderPicked = (await win.webContents.executeJavaScript(
        `(() => {
          const sel = document.querySelector('.dc-row select')
          if (!sel) return 'no-select'
          const target = [...sel.options].find((option) => option.value === '1.20.1') ?? [...sel.options][0]
          if (!target) return 'empty'
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
          setter.call(sel, target.value)
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          return target.value
        })()`,
      )) as string
      // 首次查询要打 3 个上游接口，直接给足时间（约 2~3 秒）
      await wait(6000)
      const loaderShot = await shot('smoke-loader.png')
      const loaderInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          picked: ${JSON.stringify(loaderPicked)},
          cards: [...document.querySelectorAll('.dc-loader')].map((el) => (el.textContent ?? '').trim().replace(/\\s+/g, ' ')),
          install: document.querySelector('.dc-actions .primary')?.textContent ?? ''
        })`,
      )) as string
      await win.webContents.executeJavaScript(
        `(() => { const card = [...document.querySelectorAll('.dc-loader')].find((el) => (el.textContent ?? '').includes('Fabric')); card?.click(); return 'fabric-picked' })()`,
      )
      await wait(700)
      const loaderDetail = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          loaderVersion: document.querySelectorAll('.dc-row select')[1]?.value ?? '',
          install: document.querySelector('.dc-actions .primary')?.textContent ?? ''
        })`,
      )) as string
      console.log('SMOKE_STEP loaders-done')

      // ---- P29：真下载 + 逐文件清单（下载任务页） ----
      const downloadPicked = (await win.webContents.executeJavaScript(
        `(() => {
          const sel = document.querySelector('.dc-row select')
          if (!sel) return 'no-select'
          const next = [...sel.options].find((option) => !(option.textContent ?? '').includes('✓'))
          if (!next) return 'none'
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
          setter.call(sel, next.value)
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          return next.value
        })()`,
      )) as string
      let downloadStart = 'disabled'
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(1000)
        downloadStart = (await win.webContents.executeJavaScript(
          `(() => {
            const card = [...document.querySelectorAll('.dc-loader')].find((el) => (el.textContent ?? '').includes('原版'))
            card?.click()
            const btn = document.querySelector('.dc-actions .primary')
            if (!btn || btn.disabled) return 'disabled'
            btn.click()
            return 'clicked'
          })()`,
        )) as string
        if (downloadStart === 'clicked') break
      }
      await wait(1500)
      await win.webContents.executeJavaScript(
        `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('下载任务')); item?.click(); return 'task-tab' })()`,
      )
      await wait(5500)
      const downloadSnap = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          title: document.querySelector('.progress-title')?.textContent ?? '',
          pct: document.querySelector('.progress-pct')?.textContent ?? '',
          facts: document.querySelector('.progress-facts')?.textContent ?? '',
          current: document.querySelector('.progress-current code')?.textContent ?? '',
          files: [...document.querySelectorAll('.task-file')].slice(0, 6).map((el) => (el.textContent ?? '').trim().replace(/\\s+/g, ' ')),
          fileCount: document.querySelectorAll('.task-file').length,
          stages: [...document.querySelectorAll('.progress-stage')].map((el) => (el.textContent ?? '').trim().replace(/\\s+/g, ' '))
        })`,
      )) as string
      const downloadShot = await shot('smoke-download.png')
      const cancelClicked = (await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.progress-actions button')].find((el) => (el.textContent ?? '').includes('取消')); if (!btn) return 'no-cancel'; btn.click(); return 'clicked' })()`,
      )) as string
      await wait(3000)
      const cancelInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ title: document.querySelector('.progress-title')?.textContent ?? '', toast: document.querySelector('.toast')?.textContent ?? '' })`,
      )) as string
      // 收起下载中心，免得后面的截图都带着它
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dc-head .ghost')].find((b) => b.textContent?.trim() === '关闭'); btn?.click(); return 'dc-closed' })()`,
      )
      await wait(900)

      console.log('SMOKE_STEP download-done')
      // 等进度卡/取消提示自己收起，后面的截图别带着它
      await wait(8000)

      // 版本管理：打开面板截图 → UI 重命名来回一次 → 读取目录信息
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.version-sidebar button')].find((b) => b.textContent?.trim() === '版本管理'); btn?.click(); return 'versions-open' })()`,
      )
      await wait(900)
      const versionShot = await shot('smoke-versions.png')
      const versionInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          rows: document.querySelectorAll('.vm-row').length,
          folders: [...document.querySelectorAll('.vm-folders button')].map((el) => el.textContent ?? ''),
          activeRow: document.querySelector('.vm-row.is-active .vm-name')?.textContent ?? ''
        })`,
      )) as string
      const foldersInfo = (await win.webContents.executeJavaScript(
        `window.qdo.instances.folders('default').then((value) => JSON.stringify(value))`,
      )) as string
      // 重命名（来回各一次，验证 UI + API，最后恢复原名）
      const renameResult = await (async () => {
        const set = async (name: string) => {
          await win.webContents.executeJavaScript(
            `(() => {
              const row = document.querySelector('.vm-row')
              const btn = [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === '重命名')
              btn?.click()
              return 'rename-open'
            })()`,
          )
          await wait(400)
          await win.webContents.executeJavaScript(
            `(() => {
              const input = document.querySelector('.vm-rename input')
              if (!input) return 'no-input'
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
              setter.call(input, ${JSON.stringify(name)})
              input.dispatchEvent(new Event('input', { bubbles: true }))
              const save = [...document.querySelectorAll('.vm-rename button')].find((b) => b.textContent?.trim() === '保存')
              save?.click()
              return 'rename-saved'
            })()`,
          )
          await wait(900)
          return (await win.webContents.executeJavaScript(
            `JSON.stringify({ toast: document.querySelector('.toast')?.textContent ?? '', first: document.querySelector('.vm-row .vm-name')?.textContent ?? '' })`,
          )) as string
        }
        const renamed = await set('默认实例（改名测试）')
        const restored = await set('默认实例')
        return { renamed: JSON.parse(renamed), restored: JSON.parse(restored) }
      })()
      // 实例导出：版本管理里点某一行的「导出」（保存对话框用环境变量跳过，便于自动化）
      process.env.QDOQMC_SAVE_FILE = path.join(dir, 'smoke-export.zip')
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.vm-row button')].find((b) => b.textContent?.trim() === '导出'); btn?.click(); return 'export-clicked' })()`,
      )
      await wait(1600)
      const exportInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ toast: document.querySelector('.toast')?.textContent ?? '' })`,
      )) as string
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dialog-head button')].find((b) => b.textContent?.trim() === '关闭'); btn?.click(); return 'versions-closed' })()`,
      )
      await wait(500)
      const exportDir = path.join(process.env.APPDATA ?? '', 'QDOQMC', 'exports')
      let exportFiles: string[] = []
      try {
        exportFiles = readdirSync(exportDir)
      } catch {
        exportFiles = []
      }

      let exportFromDialog = { exists: false, bytes: 0 }
      try {
        const saved = path.join(dir, 'smoke-export.zip')
        exportFromDialog = { exists: existsSync(saved), bytes: statSync(saved).size }
      } catch {
        exportFromDialog = { exists: false, bytes: 0 }
      }

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
          versionSelect: document.querySelector('.vm-row select')?.value ?? '',
          optionCount: document.querySelectorAll('.vm-row select option').length,
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

      // 切到插件市场页，验证 feed 加载（签名校验结果在 source 字段）
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.kind-tab')].find((b) => b.textContent?.trim() === '插件市场'); btn?.click(); return 'market' })()`,
      )
      await wait(2200)
      const marketShot = await shot('smoke-market.png')
      const marketInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ rows: document.querySelectorAll('.plugin-row').length, hint: document.querySelector('.plugins-hint')?.textContent ?? '' })`,
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

      // ---- P29：下载中心 · 模组页（搜索 / 预览 / 检查更新 / 冲突检查） ----
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '下载'); btn?.click(); return 'dc-open' })()`,
      )
      await wait(1000)
      await win.webContents.executeJavaScript(
        `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('模组')); item?.click(); return 'dc-mods' })()`,
      )
      await wait(3200)
      const modsShot = await shot('smoke-mods.png')
      const modsInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          rows: document.querySelectorAll('.dc-item').length,
          first: document.querySelector('.dc-item-title')?.textContent ?? '',
          installed: document.querySelectorAll('.dc-installed-row').length
        })`,
      )) as string

      // 点列表项看图片预览（有些项目本身没有 gallery，挨个试前 4 个）
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await win.webContents.executeJavaScript(
          `(() => { const items = [...document.querySelectorAll('.dc-item')]; items[${attempt}]?.click(); return 'preview' })()`,
        )
        await wait(2200)
        const hasImage = (await win.webContents.executeJavaScript(
          `Boolean(document.querySelector('.dc-preview-img'))`,
        )) as boolean
        if (hasImage) break
      }
      const previewShot = await shot('smoke-preview.png')
      const previewInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          open: Boolean(document.querySelector('.dc-preview-img')),
          title: document.querySelector('.dc-preview-head')?.textContent ?? '',
          desc: (document.querySelector('.dc-preview-desc')?.textContent ?? '').slice(0, 80)
        })`,
      )) as string

      // 检查更新（已装模组 vs Modrinth）
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dc-search button')].find((b) => (b.textContent ?? '').includes('检查更新')); btn?.click(); return 'updates' })()`,
      )
      await wait(3200)
      const updatesShot = await shot('smoke-updates.png')
      const updatesInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          rows: document.querySelectorAll('.dc-updates .dc-installed-row').length,
          text: document.querySelector('.dc-report')?.textContent ?? document.querySelector('.dc-updates')?.textContent ?? ''
        })`,
      )) as string

      // 冲突检查
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dc-search button')].find((b) => (b.textContent ?? '').includes('冲突检查')); btn?.click(); return 'conflict' })()`,
      )
      await wait(2200)
      const conflictShot = await shot('smoke-conflict.png')
      const conflictInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ text: document.querySelector('.dc-report')?.textContent ?? '', bad: Boolean(document.querySelector('.dc-report.is-bad')) })`,
      )) as string

      // 资源包页（只按游戏版本过滤）
      await win.webContents.executeJavaScript(
        `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('资源包')); item?.click(); return 'rp' })()`,
      )
      await wait(3000)
      const rpShot = await shot('smoke-resourcepack.png')
      const rpInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ rows: document.querySelectorAll('.dc-item').length, head: document.querySelector('.dc-head h2')?.textContent ?? '' })`,
      )) as string

      // 光影页
      await win.webContents.executeJavaScript(
        `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('光影')); item?.click(); return 'shader' })()`,
      )
      await wait(3000)
      const shaderShot = await shot('smoke-shader.png')
      const shaderInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ rows: document.querySelectorAll('.dc-item').length })`,
      )) as string

      // 整合包页整页截图（在线搜索）
      await win.webContents.executeJavaScript(
        `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('整合包')); item?.click(); return 'modpack' })()`,
      )
      await wait(3200)
      const modpackShot = await shot('smoke-modpack.png')
      const modpackInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ rows: document.querySelectorAll('.dc-item').length })`,
      )) as string
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dc-head .ghost')].find((b) => b.textContent?.trim() === '关闭'); btn?.click(); return 'dc-closed' })()`,
      )
      await wait(600)

      console.log('SMOKE_STEP gamelog-start')
      // 游戏日志：写一份假的 latest.log，打开日志抽屉 → 游戏日志 tab → 截图
      try {
        const logDir = path.join(process.env.APPDATA ?? '', 'QDOQMC', 'instances', 'default', '.minecraft', 'logs')
        mkdirSync(logDir, { recursive: true })
        writeFileSync(
          path.join(logDir, 'latest.log'),
          [
            '[00:00:01] [main/INFO]: Setting user: Player',
            '[00:00:02] [main/INFO]: Backend library: LWJGL version 3.3.3',
            '[00:00:03] [Render thread/INFO]: Reloading ResourceManager: vanilla',
            '[00:00:04] [Worker-Main-1/WARN]: Failed to load texture atlas for testing',
            '[00:00:05] [Render thread/ERROR]: java.lang.RuntimeException: smoke game log line',
            '[00:00:06] [Render thread/INFO]: OpenAL initialized on device OpenAL Soft',
            '[00:00:07] [main/INFO]: Sound engine started',
          ].join('\n'),
        )
      } catch (err) {
        console.log('GAMELOG_SETUP_ERROR', String(err))
      }
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '日志'); btn?.click(); return 'log-open' })()`,
      )
      await wait(900)
      await win.webContents.executeJavaScript(
        `(() => { const tab = [...document.querySelectorAll('.kind-tab')].find((b) => b.textContent?.trim() === '游戏日志'); tab?.click(); return 'game-tab' })()`,
      )
      await wait(1200)
      const gameLogShot = await shot('smoke-gamelog.png')
      const gameLogInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          file: document.querySelector('.log-gamebar')?.textContent ?? '',
          rows: document.querySelectorAll('.log-row.log-game').length,
          errors: document.querySelectorAll('.log-row.log-error.log-game').length,
          sample: [...document.querySelectorAll('.log-row.log-game .log-msg')].slice(-2).map((el) => el.textContent ?? '')
        })`,
      )) as string
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.drawer .drawer-actions button')].find((b) => b.textContent?.trim() === '关闭'); btn?.click(); return 'closed' })()`,
      )
      await wait(500)

      console.log('SMOKE_STEP gamelog-done')
      // ---- P29：本机整合包（生成一个自带 mods 的 CurseForge 包，走「预览 → 安装 → 任务进度」） ----
      const packPath = path.join(dir, 'smoke-pack.zip')
      try {
        const packZip = new AdmZip()
        packZip.addFile(
          'manifest.json',
          Buffer.from(
            JSON.stringify({
              manifestType: 'minecraftModpack',
              manifestVersion: 1,
              name: 'Smoke Fabric 包',
              version: '1.0.0',
              author: 'QDOQMC',
              minecraft: { version: '1.21.11', modLoaders: [{ id: 'fabric-0.20.1', primary: true }] },
              files: [],
              overrides: 'overrides',
            }),
          ),
        )
        packZip.addFile('mods/smoke-bundled.jar', Buffer.from('SMOKE-BUNDLED-MOD'))
        packZip.addFile('overrides/config/smoke-pack.txt', Buffer.from('smoke pack overrides'))
        packZip.writeZip(packPath)
      } catch (err) {
        console.log('PACK_SETUP_ERROR', String(err))
      }

      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '下载'); btn?.click(); return 'dc-open' })()`,
      )
      await wait(1200)
      await win.webContents.executeJavaScript(
        `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('整合包')); item?.click(); return 'pack-tab' })()`,
      )
      await wait(1500)
      process.env.QDOQMC_PICK_FILE = packPath
      await win.webContents.executeJavaScript(
        `(() => { const pick = [...document.querySelectorAll('.dc-row button')].find((x) => x.textContent?.trim() === '选择文件…'); pick?.click(); return 'pick-clicked' })()`,
      )
      await wait(800)
      const pickedPath = (await win.webContents.executeJavaScript(
        `document.querySelector('.dc-input')?.value ?? ''`,
      )) as string
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dc-row button')].find((b) => b.textContent?.trim() === '预览'); btn?.click(); return 'preview-clicked' })()`,
      )
      await wait(1600)
      const packShot = await shot('smoke-pack.png')
      const packInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({
          preview: document.querySelector('.dc-pack')?.textContent ?? '',
          previewOk: Boolean(document.querySelector('.dc-pack:not(.is-bad)'))
        })`,
      )) as string
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dc-row button')].find((b) => b.textContent?.trim() === '安装'); btn?.click(); return 'install-clicked' })()`,
      )
      let packDone = JSON.stringify({ toast: '', loader: 'vanilla', waited: 0 })
      let packDoneShot = packShot
      let packTaskShot = packShot
      let packTaskInfo = JSON.stringify({ files: 0, pct: '', facts: '' })
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await wait(1500)
        // 整合包安装会切到任务页，先把任务页的文件清单拍下来
        if (attempt === 1) {
          await win.webContents.executeJavaScript(
            `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('下载任务')); item?.click(); return 'task' })()`,
          )
          await wait(900)
          packTaskShot = await shot('smoke-pack-progress.png')
          packTaskInfo = (await win.webContents.executeJavaScript(
            `JSON.stringify({
              title: document.querySelector('.progress-title')?.textContent ?? '',
              pct: document.querySelector('.progress-pct')?.textContent ?? '',
              facts: document.querySelector('.progress-facts')?.textContent ?? '',
              files: document.querySelectorAll('.task-file').length
            })`,
          )) as string
        }
        const state = (await win.webContents.executeJavaScript(
          `window.qdo.instances.list().then((list) => JSON.stringify({
            toast: document.querySelector('.toast')?.textContent ?? '',
            loader: list.find((item) => item.name === 'Smoke Fabric 包')?.loader ?? '',
            versionId: list.find((item) => item.name === 'Smoke Fabric 包')?.versionId ?? '',
            count: list.length
          }))`,
        )) as string
        packDone = state
        const parsed = JSON.parse(state) as { toast: string; loader: string }
        if (parsed.loader && parsed.loader !== 'vanilla') {
          await wait(600)
          packDoneShot = await shot('smoke-pack-done.png')
          break
        }
      }
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dc-head .ghost')].find((b) => b.textContent?.trim() === '关闭'); btn?.click(); return 'dc-closed' })()`,
      )
      await wait(600)

      // 导入对话框：验证「选择…」把路径填进输入框
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.version-sidebar button')].find((b) => b.textContent?.trim() === '+ 新建'); btn?.click(); return 'new-instance-open' })()`,
      )
      await wait(600)
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dialog .pack-row button')].find((b) => b.textContent?.trim() === '选择…'); btn?.click(); return 'import-pick' })()`,
      )
      await wait(700)
      const importPicked = (await win.webContents.executeJavaScript(
        `document.querySelector('.dialog .pack-row input')?.value ?? ''`,
      )) as string
      await win.webContents.executeJavaScript(
        `(() => { const btn = [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent?.trim() === '取消'); btn?.click(); return 'cancel' })()`,
      )
      await wait(400)

      // ---- P30：CurseForge 源（有 mock 基址或真实 Key 都跑） ----
      let cfInfo = JSON.stringify({ skipped: true })
      let cfShot = ''
      if (process.env.QDOQMC_CF_API_BASE || process.env.QDOQMC_CF_API_KEY) {
        await win.webContents.executeJavaScript(
          `(() => { const btn = [...document.querySelectorAll('.titlebar-actions button')].find((b) => b.textContent?.trim() === '下载'); btn?.click(); return 'dc' })()`,
        )
        await wait(1000)
        await win.webContents.executeJavaScript(
          `(() => { const item = [...document.querySelectorAll('.dc-nav-item')].find((el) => (el.textContent ?? '').includes('模组')); item?.click(); return 'dc-mods' })()`,
        )
        await wait(1800)
        // 把「来源」切到 CurseForge，看真实/模拟结果
        await win.webContents.executeJavaScript(
          `(() => {
             const sel = document.querySelector('.dc-source')
             if (!sel) return 'no-select'
             const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
             setter.call(sel, 'curseforge')
             sel.dispatchEvent(new Event('change', { bubbles: true }))
             return 'cf-source'
           })()`,
        )
        await wait(3200)
        cfShot = await shot('smoke-curseforge.png')
        const cfUi = (await win.webContents.executeJavaScript(
          `JSON.stringify({
             rows: document.querySelectorAll('.dc-item').length,
             first: document.querySelector('.dc-item-title')?.textContent ?? '',
             badge: document.querySelector('.dc-tag.is-cf') ? 'cf' : '',
             error: document.querySelector('.dc-error')?.textContent ?? ''
           })`,
        )) as string
        const cfApi = (await win.webContents.executeJavaScript(
          `window.qdo.content.search('', { type: 'mod', source: 'curseforge', mcVersion: '1.20.1', loader: 'fabric', limit: 5 })
             .then((hits) => JSON.stringify({ count: hits.length, first: hits[0]?.title ?? '', source: hits[0]?.source ?? '', id: hits[0]?.projectId ?? '' }))
             .catch((err) => JSON.stringify({ error: String(err) }))`,
        )) as string
        const cfTest = (await win.webContents.executeJavaScript(
          `window.qdo.content.testCurseForge().then((r) => JSON.stringify(r)).catch((e) => JSON.stringify({ ok: false, error: String(e) }))`,
        )) as string
        const cfInstall = (await win.webContents.executeJavaScript(
          `window.qdo.content.install('default', 'cf-111', { mcVersion: '1.20.1', loader: 'fabric' })
             .then((r) => JSON.stringify({ ok: r.ok, fileName: (r.files ?? [])[0] ?? '', error: r.error ?? '' }))
             .catch((e) => JSON.stringify({ ok: false, error: String(e) }))`,
        )) as string
        cfInfo = JSON.stringify({ ui: JSON.parse(cfUi), api: JSON.parse(cfApi), test: JSON.parse(cfTest), install: JSON.parse(cfInstall) })
        console.log(`CF_CHECK ${cfInfo}`)
        await win.webContents.executeJavaScript(
          `(() => { const btn = [...document.querySelectorAll('.dc-head .ghost')].find((b) => b.textContent?.trim() === '关闭'); btn?.click(); return 'dc-closed' })()`,
        )
        await wait(600)
      }

      console.log('SMOKE_STEP pack-done')

      // ---- P30：删除实例（覆盖 confirm，点「Smoke Fabric 包」那行的删除） ----
      let deleteInfo = JSON.stringify({ skipped: true })
      try {
        await win.webContents.executeJavaScript(`window.confirm = () => true; 'confirm-patched'`)
        await win.webContents.executeJavaScript(
          `(() => { const btn = [...document.querySelectorAll('.version-sidebar button')].find((b) => b.textContent?.trim() === '版本管理'); btn?.click(); return 'vm-open' })()`,
        )
        await wait(800)
        const found = (await win.webContents.executeJavaScript(
          `(() => {
             const rows = [...document.querySelectorAll('.vm-row')]
             const row = rows.find((el) => (el.textContent ?? '').includes('Smoke Fabric'))
             if (!row) return 'no-row'
             const btn = [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === '删除')
             btn?.click()
             return 'delete-clicked'
           })()`,
        )) as string
        await wait(1200)
        const countAfter = (await win.webContents.executeJavaScript(
          `window.qdo.instances.list().then((list) => JSON.stringify({ count: list.length, names: list.map((x) => x.name) }))`,
        )) as string
        const toast = (await win.webContents.executeJavaScript(
          `document.querySelector('.toast')?.textContent ?? ''`,
        )) as string
        deleteInfo = JSON.stringify({ found, countAfter: JSON.parse(countAfter), toast })
        await win.webContents.executeJavaScript(
          `(() => { const btn = [...document.querySelectorAll('.dialog-head button')].find((b) => b.textContent?.trim() === '关闭'); btn?.click(); return 'vm-closed' })()`,
        )
        await wait(500)
      } catch (err) {
        deleteInfo = JSON.stringify({ error: String(err) })
      }

      // 左侧版本栏：点第一张卡片切回默认实例
      await win.webContents.executeJavaScript(
        `(() => { const card = document.querySelector('.ver-card'); card?.click(); return 'card-clicked' })()`,
      )
      await wait(1000)
      const switchInfo = (await win.webContents.executeJavaScript(
        `JSON.stringify({ active: document.querySelector('.ver-card.is-active .ver-card-name')?.textContent ?? '', toast: document.querySelector('.toast')?.textContent ?? '', cards: document.querySelectorAll('.ver-card').length })`,
      )) as string

      // ---- P32：AI 写插件 / 自升级（不依赖 LLM，直接走 tools 服务验证整条链路） ----
      let p32 = JSON.stringify({ skipped: true })
      try {
        const toolsSvc = k.ctx.get('tools') as {
          call(name: string, args: unknown): Promise<{ ok: boolean; summary: string; data?: unknown }>
        }
        const pluginCode = [
          'export function apply(api) {',
          '  api.registerTool({',
          '    name: "smoke_ai_tool",',
          '    description: "AI 写插件的冒烟工具",',
          '    parameters: { type: "object", properties: {}, additionalProperties: false },',
          '    async handler() { return { ok: true, summary: "AI 插件工作正常" } },',
          '  })',
          '}',
        ].join('\n')
        const installed = await toolsSvc.call('write_plugin', {
          id: 'smoke-ai-plugin',
          name: 'AI 写插件测试',
          description: '冒烟：AI 生成的插件',
          code: pluginCode,
        })
        const listed = await toolsSvc.call('list_plugins', {})
        const invoked = await toolsSvc.call('smoke_ai_tool', {})
        const removed = await toolsSvc.call('remove_plugin', { id: 'smoke-ai-plugin' })
        p32 = JSON.stringify({
          installOk: installed.ok,
          installSummary: installed.summary,
          pluginCount: Array.isArray(listed.data) ? listed.data.length : -1,
          invokeOk: invoked.ok,
          invokeSummary: invoked.summary,
          removeOk: removed.ok,
        })
      } catch (err) {
        p32 = JSON.stringify({ error: String(err) })
      }
      console.log(`P32_CHECK ${p32}`)


      const info = k.ctx.get('appMeta') as { version?: string } | undefined
      console.log(
        `SMOKE_RESULT ${JSON.stringify({
          ok: true,
          ms: Date.now() - startedAt,
          version: info?.version ?? app.getVersion(),
          plugins: k.summary.plugins,
          failed: k.summary.failed,
          screenshots: [firstShot, aiShot, pluginsShot, marketShot, modsShot, previewShot, updatesShot, rpShot, shaderShot, modpackShot, conflictShot],
          ui: JSON.parse(uiText),
          ai: JSON.parse(aiInfo),
          pluginPanel: JSON.parse(pluginsInfo),
          market: JSON.parse(marketInfo),
          mods: JSON.parse(modsInfo),
          preview: { info: JSON.parse(previewInfo), screenshot: previewShot },
          updates: { info: JSON.parse(updatesInfo), screenshot: updatesShot },
          resourcepack: JSON.parse(rpInfo),
          shader: { info: JSON.parse(shaderInfo), screenshot: shaderShot },
          modpack: JSON.parse(modpackInfo),
          conflict: JSON.parse(conflictInfo),
          pack: {
            preview: JSON.parse(packInfo),
            done: JSON.parse(packDone),
            task: JSON.parse(packTaskInfo),
            screenshot: packShot,
            doneScreenshot: packDoneShot,
            taskScreenshot: packTaskShot,
            pickedPath,
          },
          importPicker: { picked: importPicked },
          gameLog: { info: JSON.parse(gameLogInfo), screenshot: gameLogShot },
          instanceExport: { info: JSON.parse(exportInfo), files: exportFiles, saved: exportFromDialog },
          versions: { info: JSON.parse(versionInfo), folders: JSON.parse(foldersInfo), rename: renameResult, screenshot: versionShot },
          loaders: { info: JSON.parse(loaderInfo), detail: JSON.parse(loaderDetail), screenshot: loaderShot },
          download: {
            picked: downloadPicked,
            start: downloadStart,
            snapshot: JSON.parse(downloadSnap),
            cancel: { clicked: cancelClicked, ui: JSON.parse(cancelInfo) },
            screenshot: downloadShot,
          },
          sidebar: JSON.parse(switchInfo),
          deleteInstance: JSON.parse(deleteInfo),
          p32: JSON.parse(p32),
          curseforge: { info: JSON.parse(cfInfo), screenshot: cfShot },
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
        dataDir: process.env.QDOQMC_DATA_DIR || app.getPath('userData'),
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
      if (marketMode) {
        const code = await runMarketCli(kernel)
        app.exit(code)
        return
      }
      if (marketInstallTarget) {
        const code = await runMarketInstallCli(kernel, marketInstallTarget)
        app.exit(code)
        return
      }
      if (modpackTarget) {
        const code = await runModpackCli(kernel, modpackTarget)
        app.exit(code)
        return
      }
      if (inspectModpackTarget) {
        const code = await runInspectModpackCli(kernel, inspectModpackTarget)
        app.exit(code)
        return
      }
      if (neoforgeTarget) {
        const code = await runNeoForgeCli(kernel, neoforgeTarget)
        app.exit(code)
        return
      }
      if (forgeTarget) {
        const code = await runForgeCli(kernel, forgeTarget)
        app.exit(code)
        return
      }
      if (fixesMode) {
        const code = await runFixesCli(kernel)
        app.exit(code)
        return
      }
      if (applyFixTarget) {
        const code = await runApplyFixCli(kernel, applyFixTarget)
        app.exit(code)
        return
      }
      if (callToolTarget) {
        const code = await runCallToolCli(kernel, callToolTarget)
        app.exit(code)
        return
      }
      if (p32CheckMode) {
        const code = await runP32CheckCli(kernel)
        app.exit(code)
        return
      }
      if (bindAccountTarget || unbindAccountMode) {
        const code = await runBindAccountCli(kernel, unbindAccountMode ? undefined : bindAccountTarget, bindInstanceTarget)
        app.exit(code)
        return
      }
      if (exportInstanceTarget) {
        const code = await runExportInstanceCli(kernel, exportInstanceTarget, exportToTarget)
        app.exit(code)
        return
      }
      if (importInstanceTarget) {
        const code = await runImportInstanceCli(kernel, importInstanceTarget)
        app.exit(code)
        return
      }
      if (gameLogTarget) {
        const code = await runGameLogCli(kernel, gameLogTarget)
        app.exit(code)
        return
      }
      if (cursePackTarget) {
        const code = await runCursePackCli(kernel, cursePackTarget)
        app.exit(code)
        return
      }
      if (inspectCurseTarget) {
        const code = await runInspectCursePackCli(kernel, inspectCurseTarget)
        app.exit(code)
        return
      }
      if (accountMode) {
        const code = await runAccountCli(kernel)
        app.exit(code)
        return
      }
      if (loginMsMode) {
        const code = await runLoginMsCli(kernel)
        app.exit(code)
        return
      }
      if (logoutMode) {
        const code = await runLogoutCli(kernel)
        app.exit(code)
        return
      }
      if (accountsMode) {
        const code = await runAccountsCli(kernel)
        app.exit(code)
        return
      }
      if (switchAccountTarget) {
        const code = await runSwitchAccountCli(kernel, switchAccountTarget)
        app.exit(code)
        return
      }
      if (removeAccountTarget) {
        const code = await runRemoveAccountCli(kernel, removeAccountTarget)
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

      app.on('before-quit', () => {
        try {
          const host = kernel?.ctx.get('pluginHost') as { beginShutdown?: () => void } | undefined
          host?.beginShutdown?.()
        } catch {
          /* 忽略 */
        }
      })

      if (isSmoke) await runSmoke(mainWindow, kernel, startedAt)
      if (isCrashSmoke) await runCrashSmoke(mainWindow, kernel, startedAt)
      if (isSettingsSmoke) await runSettingsSmoke(mainWindow, startedAt)

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
