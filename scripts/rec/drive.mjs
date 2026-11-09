#!/usr/bin/env node
/**
 * 宣传片录屏场景驱动：启动演示用 Electron → 连 CDP → 按场景缓慢移动鼠标/点击/打字 → 录 screencast。
 *
 *   node scripts/rec/drive.mjs --scene=home          # 录一个场景
 *   node scripts/rec/drive.mjs --all                 # 录全部 5 个场景
 *   node scripts/rec/drive.mjs --all --skip-app      # 复用已开着的 9411 端口（不启动/不关闭 app）
 *
 * 其他参数：
 *   --port=9411      CDP 端口
 *   --keep-app       录完不关 app（调试用）
 *   --headful        显示 Electron 窗口（默认就是显示；保留参数占位）
 *
 * 录完产物：out/rec/<scene>/{frame_*.png, events.json, meta.json, ui-text.txt, safety.json}
 * 编码：node scripts/rec/encode.mjs --all
 *
 * 设计要点：
 * - 输入全部走 CDP Input.dispatchMouseEvent / Input.insertText，鼠标 ease-out 12~20 步、每步 16ms，不瞬移。
 * - 录制前用 Page.reload 回到干净首页；主进程状态（日志 ring、聊天记忆）保留，正好给 logs 场景攒日志。
 * - AI 场景用 scripts/mock-llm.mjs（127.0.0.1:18080），settings.json 的 llmBaseUrl 已在 prepare-demo 里指过去。
 * - 只 kill 自己 spawn 的 electron / mock-llm，绝不碰用户已经开着的方块鱼。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpClient, sleep, waitForPageTarget, waitForSelector } from './cdp-client.mjs'
import { ScreencastRecorder, VIEWPORT, configureViewport } from './cdp-rec.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const DEMO_DIR = path.join(ROOT, 'out', 'demo-data')
const REC_DIR = path.join(ROOT, 'out', 'rec')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MOCK_LLM_PORT = 18080
const MOCK_LLM_SCRIPT = path.join(ROOT, 'scripts', 'mock-llm.mjs')

const ALL_SCENES = ['home', 'versions', 'download', 'logs', 'ai']

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { scenes: [], port: 9411, keepApp: false, skipApp: false }
  for (const arg of argv) {
    if (arg === '--all') out.scenes = [...ALL_SCENES]
    else if (arg === '--keep-app') out.keepApp = true
    else if (arg === '--skip-app') out.skipApp = true
    else if (arg.startsWith('--scene=')) out.scenes.push(arg.slice('--scene='.length))
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length))
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  if (out.scenes.length === 0) out.scenes = ['home']
  return out
}

const log = (...args) => console.log('[drive]', ...args)
const round3 = (n) => Math.round(n * 1000) / 1000

async function waitHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1500) })
      return true
    } catch {
      await sleep(200)
    }
  }
  return false
}

function killTree(pid, label) {
  if (!pid) return
  log(`关闭${label} pid=${pid} …`)
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

function cleanChatState() {
  for (const file of ['chat-history.json', 'chat-sessions.json', 'ai-memory.json']) {
    rmSync(path.join(DEMO_DIR, file), { force: true })
  }
}

// ---------------------------------------------------------------------------
// 输入驱动
// ---------------------------------------------------------------------------
class Driver {
  constructor(client, recorder, { scene = 'scene', reviewDir = path.join(REC_DIR, 'review') } = {}) {
    this.client = client
    this.recorder = recorder
    this.sceneName = scene
    this.reviewDir = reviewDir
    this.mouse = { x: 800, y: 500 }
  }

  /** 记录一个代表帧时间点（零成本，不打断录制；encode 时按它抽 review 帧） */
  mark(label) {
    const hint = this.recorder.mark(label)
    log(`代表帧标记 ${this.sceneName}_${label} @ ${hint.t.toFixed(2)}s`)
    return hint
  }

  async wait(ms) {
    await sleep(ms)
  }

  async evaluate(expression) {
    return this.client.evaluate(expression)
  }

  async waitFor(selector, timeoutMs = 12000) {
    return waitForSelector(this.client, selector, { timeoutMs })
  }

  async waitForText(selector, text, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await this.client
        .evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && el.textContent && el.textContent.includes(${JSON.stringify(text)})); })()`,
        )
        .catch(() => false)
      if (found) return true
      await sleep(150)
    }
    throw new Error(`等待文字超时：${selector} 包含 ${text}`)
  }

  async rect(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      if (el.closest('[aria-hidden="true"]')) return null;
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    })()`)
  }

  /** 在 scope 里按文字找可点元素（先精确、后包含；最后退化为叶子节点精确匹配） */
  async textRect(scope, text, { contains = false } = {}) {
    return this.evaluate(`(() => {
      const scope = document.querySelector(${JSON.stringify(scope)});
      if (!scope) return null;
      const target = ${JSON.stringify(text)};
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (el.closest('[aria-hidden="true"]')) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      };
      const candidates = [...scope.querySelectorAll('button, a, [role="button"], label, .cf-icon-btn, .dc-nav-item, .home-btn, .launch, .home-switch, .cf-ai-pill')];
      const exact = candidates.find((el) => visible(el) && norm(el.textContent) === target);
      const containsMatch = candidates.find((el) => visible(el) && norm(el.textContent).includes(target));
      const picked = ${contains ? 'containsMatch || exact' : 'exact || containsMatch'};
      if (!picked) return null;
      const r = picked.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, text: norm(picked.textContent).slice(0, 40) };
    })()`)
  }

  async #emitMove(x, y) {
    await this.client.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    })
    this.recorder.pushEvent({ kind: 'move', x, y })
    this.mouse = { x, y }
  }

  /** ease-out 缓动移动，12~20 步，每步 16ms（默认） */
  async moveTo(x, y, { steps = 16, stepMs = 16 } = {}) {
    const from = { ...this.mouse }
    const easing = (t) => 1 - Math.pow(1 - t, 3)
    for (let i = 1; i <= steps; i += 1) {
      const p = easing(i / steps)
      const cx = Math.round(from.x + (x - from.x) * p)
      const cy = Math.round(from.y + (y - from.y) * p)
      await this.#emitMove(cx, cy)
      await sleep(stepMs)
    }
  }

  async hoverAt(x, y, { holdMs = 0, steps = 16 } = {}) {
    await this.moveTo(x, y, { steps })
    if (holdMs > 0) await sleep(holdMs)
  }

  async hoverSelector(selector, { holdMs = 0, steps = 16 } = {}) {
    const r = await this.rect(selector)
    if (!r) throw new Error(`找不到元素：${selector}`)
    await this.hoverAt(r.cx, r.cy, { holdMs, steps })
    return r
  }

  async hoverText(scope, text, { holdMs = 0, steps = 16, contains = false } = {}) {
    const r = await this.textRect(scope, text, { contains })
    if (!r) throw new Error(`在 ${scope} 里找不到文字：${text}`)
    await this.hoverAt(r.cx, r.cy, { holdMs, steps })
    return r
  }

  async clickAt(x, y) {
    const px = Math.round(x)
    const py = Math.round(y)
    await this.client.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: px,
      y: py,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    })
    this.recorder.pushEvent({ kind: 'click', x: px, y: py })
    await sleep(60)
    await this.client.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: px,
      y: py,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    })
  }

  async clickSelector(selector, { steps = 16, holdMs = 80 } = {}) {
    const r = await this.rect(selector)
    if (!r) throw new Error(`找不到元素：${selector}`)
    await this.moveTo(r.cx, r.cy, { steps })
    await sleep(holdMs)
    await this.clickAt(r.cx, r.cy)
    return r
  }

  async clickText(scope, text, { steps = 16, holdMs = 80, contains = false } = {}) {
    const r = await this.textRect(scope, text, { contains })
    if (!r) throw new Error(`在 ${scope} 里找不到文字：${text}`)
    await this.moveTo(r.cx, r.cy, { steps })
    await sleep(holdMs)
    await this.clickAt(r.cx, r.cy)
    return r
  }

  async pressKey(key, { code = key, vk = 0 } = {}) {
    const params = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    }
    await this.client.call('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await sleep(30)
    await this.client.call('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    await sleep(30)
  }

  async wheel(deltaY, { deltaX = 0, times = 1, gapMs = 260 } = {}) {
    for (let i = 0; i < times; i += 1) {
      await this.client.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(this.mouse.x),
        y: Math.round(this.mouse.y),
        deltaX,
        deltaY,
        button: 'none',
        buttons: 0,
        pointerType: 'mouse',
      })
      await sleep(gapMs)
    }
  }

  /** 逐字输入：每个字一次 Input.insertText，模拟打字机 */
  async typeText(text, { perCharMs = 120 } = {}) {
    for (const char of [...text]) {
      await this.client.call('Input.insertText', { text: char })
      this.recorder.pushEvent({ kind: 'type', x: this.mouse.x, y: this.mouse.y, text: char })
      await sleep(perCharMs)
    }
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------
async function sceneHome(d) {
  await d.wait(250)
  await d.moveTo(800, 520, { steps: 10 })
  await d.hoverSelector('.launch', { steps: 14, holdMs: 600 })
  d.mark('a')
  await d.hoverText('.home-actions', '打开游戏目录', { steps: 12, holdMs: 550 })
  d.mark('b')
  await d.hoverSelector('.launch', { steps: 12, holdMs: 850 })
  // 在启动按钮内部轻微移动，带出 hover 的层次感
  const r = await d.rect('.launch')
  if (r) await d.hoverAt(r.cx + r.w * 0.18, r.cy + 6, { steps: 8, holdMs: 400 })
  await d.hoverAt(r ? r.cx : 800, r ? r.cy : 560, { steps: 8, holdMs: 300 })
  d.mark('c')
}

// 断言：顶栏激活项必须是期望页面（防止点到隐藏/错误的按钮，录出废素材）
async function assertActiveNav(d, expected) {
  const active = await d.evaluate(`document.querySelector('.cf-nav .is-active')?.textContent?.trim() ?? ''`)
  if (active !== expected) {
    throw new Error(`导航断言失败：期望顶栏「${expected}」，实际 ${JSON.stringify(active)}`)
  }
  log(`导航断言通过：${expected}`)
}

async function sceneVersions(d) {
  await d.wait(300)
  // 只点顶栏 .cf-nav 里文字为「版本」的按钮（不要碰 .version-sidebar 里给 smoke 用的隐藏按钮）
  await d.clickText('.cf-nav', '版本', { steps: 10 })
  await d.waitFor('.vm-table', 12000)
  await assertActiveNav(d, '版本')
  const rows = await d.evaluate(`(() => [...document.querySelectorAll('.vm-row')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }))()`)
  if (rows.length === 0) throw new Error('版本页断言失败：没有 .vm-row 实例行')
  log(`版本页断言通过：${rows.length} 个实例行`)
  await d.wait(400)
  for (let i = 0; i < Math.min(rows.length, 3); i += 1) {
    await d.hoverAt(rows[i].cx, rows[i].cy, { steps: 12, holdMs: 420 })
  }
  d.mark('a')
  // 在版本列表上滚一下（内容不足时滚轮不动也无妨，画面里鼠标仍在列表上移动）
  const last = rows[Math.min(rows.length, 3) - 1]
  await d.hoverAt(last.cx, last.cy + 40, { steps: 10, holdMs: 200 })
  await d.wheel(360, { times: 2, gapMs: 320 })
  d.mark('b')
  await d.hoverAt(rows[0].cx, rows[0].cy, { steps: 12, holdMs: 500 })
  await d.wheel(-200, { times: 1, gapMs: 300 })
  await d.wait(700)
  d.mark('c')
}

async function sceneDownload(d) {
  await d.wait(300)
  await d.clickText('.cf-nav', '下载', { steps: 10 })
  await d.waitFor('.dc-pane', 12000)
  await assertActiveNav(d, '下载')
  await d.wait(400)

  // 等版本下拉列表加载（网络清单）
  const ready = await (async () => {
    for (let i = 0; i < 100; i += 1) {
      const count = await d
        .evaluate(`document.querySelectorAll('.dc-pane .dc-row select option').length`)
        .catch(() => 0)
      if (count > 5) return true
      await d.wait(200)
    }
    return false
  })()

  let installTarget = 'installed-row'
  if (ready) {
    // 找一个「未安装的正式版」，用键盘在 select 上选择（原生下拉弹层不会进 screencast，所以用键盘）
    const picked = await d.evaluate(`(() => {
      const sel = document.querySelector('.dc-pane .dc-row select');
      if (!sel) return null;
      const options = [...sel.options].map((o) => o.value);
      const installed = [...document.querySelectorAll('.dc-installed-name')].map((e) => e.textContent.trim());
      const release = /^\\d+\\.\\d+(\\.\\d+)?$/;
      let index = options.findIndex((v) => release.test(v) && !installed.includes(v));
      if (index < 0 || index > 45) index = options.findIndex((v) => !installed.includes(v));
      if (index < 0) return null;
      sel.focus();
      return { value: sel.value, index, target: options[index] };
    })()`)
    if (picked) {
      await d.pressKey('Home', { vk: 36 })
      for (let i = 0; i < picked.index; i += 1) await d.pressKey('ArrowDown', { vk: 40 })
      const now = await d.evaluate(`document.querySelector('.dc-pane .dc-row select')?.value ?? null`)
      if (now === picked.target) installTarget = picked.target
      else log(`select 键盘选择失败（now=${now} target=${picked.target}），回退到已装版本`)
    } else {
      log('没找到可安装的未安装版本，回退到已装版本')
    }
  } else {
    log('版本清单加载超时，回退到已装版本')
  }

  if (installTarget === 'installed-row') {
    // 回退：点本机已装版本里的「选中」，让界面有版本切换动作
    const r = await d.textRect('.dc-installed', '选中')
    if (r) {
      await d.moveTo(r.cx, r.cy, { steps: 10 })
      await d.wait(200)
      await d.clickAt(r.cx, r.cy)
      await d.wait(400)
    }
  }
  await d.wait(150)
  d.mark('a') // 选好版本的游戏页

  const installBtn = await d.textRect('.dc-actions', '安装', { contains: true })
  if (installBtn) {
    await d.moveTo(installBtn.cx, installBtn.cy, { steps: 10 })
    await d.wait(120)
    await d.clickAt(installBtn.cx, installBtn.cy)
    await d.waitFor('.progress-card', 2500).catch(async () => {
      const taskTab = await d.textRect('.dc-nav', '下载任务', { contains: true })
      if (taskTab) {
        await d.moveTo(taskTab.cx, taskTab.cy, { steps: 8 })
        await d.wait(100)
        await d.clickAt(taskTab.cx, taskTab.cy)
      }
      await d.waitFor('.progress-card', 6000).catch(() => undefined)
    })

    // 0% 阶段在拿版本信息 / 索引，等进度真正动起来再录「动」的部分
    let started = false
    for (let i = 0; i < 24; i += 1) {
      const pct = await d
        .evaluate(`Number((document.querySelector('.progress-pct')?.textContent ?? '').replace(/[^0-9.]/g, '')) || 0`)
        .catch(() => 0)
      if (i % 4 === 0) log(`等待进度启动 ${(i * 400) / 1000}s：${pct}%`)
      if (pct >= 3) {
        started = true
        break
      }
      await d.wait(400)
    }
    log(started ? '进度已开始动 ✅' : '8 秒内没等到进度（继续录当前状态）')
    await d.hoverSelector('.progress-card .progress-bar', { steps: 8, holdMs: 600 }).catch(() => undefined)
    d.mark('b')
    const progressEarly = await d
      .evaluate(`document.querySelector('.progress-card')?.innerText?.replace(/\\s+/g, ' ').slice(0, 150) ?? ''`)
      .catch(() => '')
    await d.hoverSelector('.progress-card .progress-facts', { steps: 8, holdMs: 3200 }).catch(() => undefined)
    const progressLate = await d
      .evaluate(`document.querySelector('.progress-card')?.innerText?.replace(/\\s+/g, ' ').slice(0, 150) ?? ''`)
      .catch(() => '')
    d.mark('c')
    log(`进度卡（前）：${progressEarly || '（无进度卡）'}`)
    log(`进度卡（后）：${progressLate || '（无进度卡）'}`)
    log(progressEarly !== progressLate ? '进度条在动 ✅' : '进度文本前后一致（可能下载已完成/失败）')
    // 取消下载，避免残留任务影响后续场景
    const cancel = await d.textRect('.progress-card', '取消', { contains: true })
    if (cancel) {
      await d.moveTo(cancel.cx, cancel.cy, { steps: 10 })
      await d.wait(100)
      await d.clickAt(cancel.cx, cancel.cy)
      await d.wait(400)
    }
  } else {
    log('没找到安装按钮，只录下载中心页面')
    await d.hoverSelector('.dc-installed', { steps: 12, holdMs: 1600 }).catch(() => undefined)
    d.mark('b')
    d.mark('c')
  }
}

async function sceneLogs(d) {
  await d.wait(400)
  await d.hoverText('.cf-topbar-tools', '日志', { steps: 12, holdMs: 150 })
  await d.clickText('.cf-topbar-tools', '日志', { steps: 12 })
  await d.waitFor('.log-list', 8000)
  await d.wait(900)
  const stats = await d.evaluate(`(() => {
    const el = document.querySelector('.log-list');
    return { rows: el ? el.children.length : 0, scrollHeight: el ? el.scrollHeight : 0, clientHeight: el ? el.clientHeight : 0 };
  })()`)
  log(`日志列表：${stats.rows} 行，${stats.scrollHeight}px / 视口 ${stats.clientHeight}px`)
  await d.hoverSelector('.log-list', { steps: 14, holdMs: 400 })
  d.mark('a')
  const canScroll = stats.scrollHeight > stats.clientHeight + 10
  if (canScroll) {
    await d.wheel(420, { times: 2, gapMs: 320 })
    d.mark('b')
    await d.wheel(420, { times: 1, gapMs: 320 })
    await d.wheel(-220, { times: 1, gapMs: 300 })
  } else {
    // 日志不够长时，在列表里上下滑动鼠标，画面仍有运动
    const r = await d.rect('.log-list')
    if (r) {
      await d.hoverAt(r.x + r.w * 0.5, r.cy, { steps: 10, holdMs: 300 })
      await d.hoverAt(r.x + r.w * 0.5, r.y + r.h * 0.25, { steps: 10, holdMs: 500 })
      d.mark('b')
      await d.hoverAt(r.x + r.w * 0.5, r.y + r.h * 0.75, { steps: 10, holdMs: 500 })
    }
  }
  await d.wait(500)
  d.mark('c')
}

async function sceneAi(d) {
  await d.wait(200)
  await d.clickSelector('.cf-ai-pill', { steps: 10 })
  await d.waitFor('.composer input', 8000)
  await d.wait(400)
  await d.clickSelector('.composer input', { steps: 8 })
  await d.wait(150)
  await d.typeText('帮我装个钠优化', { perCharMs: 110 })
  await d.wait(200)
  d.mark('a')
  await d.hoverText('.composer', '发送', { steps: 8, holdMs: 150 })
  await d.clickText('.composer', '发送', { steps: 8 })
  await d.wait(1100)
  // 等工具调用 + 流式回复；鼠标在聊天区轻轻下移
  await d.hoverSelector('.chat-list', { steps: 10, holdMs: 600 }).catch(() => undefined)
  await d.wheel(220, { times: 1, gapMs: 300 })
  d.mark('b')
  const midText = await d
    .evaluate(`document.querySelector('.chat-list')?.innerText?.slice(-240) ?? ''`)
    .catch(() => '')
  await d.wait(3400)
  const endText = await d
    .evaluate(`document.querySelector('.chat-list')?.innerText?.slice(-240) ?? ''`)
    .catch(() => '')
  const bubbles = await d
    .evaluate(`document.querySelectorAll('.chat-list .bubble').length`)
    .catch(() => 0)
  log(`AI 气泡数：${bubbles}，回复片段：${JSON.stringify(endText.replace(/\s+/g, ' ').slice(-160))}`)
  log(`AI 流式状态：${midText === endText ? '前后一致（可能未流式）' : '有增量/进度变化 ✅'}`)
  d.mark('c')
}

const SCENES = {
  home: { fn: sceneHome, label: '主页：启动游戏 hover → 打开游戏目录 → 回启动游戏' },
  versions: { fn: sceneVersions, label: '版本管理：点顶栏「版本」→ 实例列表 hover → 滚动' },
  download: { fn: sceneDownload, label: '下载中心：选版本 → 安装进度 → 下载任务' },
  logs: { fn: sceneLogs, label: '日志抽屉：打开 → 滚动列表' },
  ai: { fn: sceneAi, label: 'AI 助手：打开 → 逐字输入 → 发送 → 流式回复' },
}

// 背景遮罩：App 自带 `.app::before` 是 70–93% 的黑色渐变，会把任何自定义背景压成死黑。
// 宣传片需要看清 Minecraft 地形，所以录制时注入一条只降低该遮罩的样式（不动布局/文字/组件）。
const BRAND_VEIL_CSS =
  '.app::before{background:linear-gradient(180deg, rgba(4,7,11,0.32), rgba(4,7,11,0.42) 45%, rgba(4,7,11,0.55)) !important}'

// ---------------------------------------------------------------------------
// 保活重绘：CDP screencast 只在合成器有变化时推帧，静止页面几乎不推帧。
// 注入一个不可见的 0.2% 透明动画层，逼合成器持续出帧。
// 实测（1600×1000）：静止页面 JPEG q95 从 0.3fps → 47fps（q90 → 59fps）；
// PNG q100 只有 ~9fps（PNG 编码是瓶颈），所以录制帧格式改用 jpeg。
// 注意：透明度必须保持 ~0.002，不能再往 1 动画（那会变成不透明黑层，录出来全黑）。
// 页面 reload 后需要重新注入。
// ---------------------------------------------------------------------------
async function installKeepAlive(client) {
  return client.evaluate(`(() => {
    const mode = [];
    if (!document.getElementById('cf-keepalive')) {
      const style = document.createElement('style');
      style.id = 'cf-keepalive';
      style.textContent = '@keyframes cfKeep{0%{opacity:.002}100%{opacity:.003}}html::after{content:"";position:fixed;inset:0;background:#000;pointer-events:none;z-index:2147483647;animation:cfKeep .1s linear infinite}';
      document.head.appendChild(style);
      mode.push('keepalive');
    }
    if (!document.getElementById('cf-brand-veil')) {
      const veil = document.createElement('style');
      veil.id = 'cf-brand-veil';
      veil.textContent = ${JSON.stringify(BRAND_VEIL_CSS)};
      document.head.appendChild(veil);
      mode.push('brand-veil');
    }
    return mode.length > 0 ? mode.join('+') : 'already';
  })()`)
}

// ---------------------------------------------------------------------------
// 安全检查：把当前页面可见文字 + 输入值扫一遍，查真实路径/用户名/Key
// ---------------------------------------------------------------------------
function safetyScan(text, extraPatterns) {
  const masked = (value) => {
    if (!value) return value
    if (value.length <= 8) return `${value.slice(0, 2)}***`
    return `${value.slice(0, 4)}***${value.slice(-2)}`
  }
  const hits = []
  for (const [name, pattern] of extraPatterns) {
    if (!pattern) continue
    const matches = text.match(pattern)
    if (matches && matches.length > 0) {
      hits.push({ name, count: matches.length, samples: [...new Set(matches)].slice(0, 3).map(masked) })
    }
  }
  return hits
}

async function collectAndScan(d, scene, port) {
  const ui = await d.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input, textarea, select')].map((el) => {
      try { return String(el.value ?? ''); } catch { return ''; }
    });
    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText ?? '',
      values: inputs.join('\\n'),
    };
  })()`)
  const username = process.env.USERNAME || ''
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    ['windows-user-path', /[A-Za-z]:\\Users\\[^\\\s"']+/gi],
    ['appdata-qdoqmc', /AppData\\Roaming\\QDOQMC/gi],
    ['sk-key', /sk-[A-Za-z0-9_-]{8,}/g],
    ['deepseek-url', /api\.deepseek\.com/gi],
    ['real-username', username ? new RegExp(escapeRe(username), 'gi') : null],
    ['real-user-home', username ? new RegExp(`C:\\\\Users\\\\${escapeRe(username)}`, 'gi') : null],
  ]
  const combined = `${ui.url}\n${ui.title}\n${ui.text}\n${ui.values}`
  const hits = safetyScan(combined, patterns)
  const dir = path.join(REC_DIR, scene)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'ui-text.txt'), `${ui.text}\n\n--- input/select values ---\n${ui.values}\n`, 'utf8')
  writeFileSync(
    path.join(dir, 'safety.json'),
    `${JSON.stringify({ scene, port, url: ui.url, title: ui.title, hits, checkedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  if (hits.length > 0) {
    log(`⚠️ 安全检查命中（${scene}）：${hits.map((h) => `${h.name}×${h.count}`).join(', ')}`)
  } else {
    log(`安全检查通过（${scene}）：未发现真实用户名/路径/Key`)
  }
  return { ui, hits }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/rec/drive.mjs --scene=home | --all [--port=9411] [--skip-app] [--keep-app]')
    return
  }
  mkdirSync(REC_DIR, { recursive: true })
  if (!existsSync(path.join(DEMO_DIR, 'settings.json'))) {
    throw new Error(`缺少演示数据：${DEMO_DIR}（先运行 node scripts/rec/prepare-demo.mjs）`)
  }
  if (!existsSync(ELECTRON)) throw new Error(`缺少 electron：${ELECTRON}`)

  let appProc = null
  let mockProc = null
  let appLogFd = null
  let mockLogFd = null
  let client = null

  try {
    const already = await (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${args.port}/json/list`, { signal: AbortSignal.timeout(1200) })
        const list = await res.json()
        return Boolean(list.find((item) => item.type === 'page'))
      } catch {
        return false
      }
    })()

    if (already && !args.skipApp) {
      throw new Error(`端口 ${args.port} 已有 CDP 页面在跑；要复用它请加 --skip-app，否则先关掉那个进程（不会自动 kill 别人的 app）`)
    }

    // mock LLM（AI 场景需要）
    if (args.scenes.includes('ai')) {
      const up = await (async () => {
        try {
          await fetch(`http://127.0.0.1:${MOCK_LLM_PORT}/`, { signal: AbortSignal.timeout(1000) })
          return true
        } catch {
          return false
        }
      })()
      if (!up) {
        mockLogFd = openSync(path.join(REC_DIR, 'mock-llm.log'), 'a')
        mockProc = spawn(process.execPath, [MOCK_LLM_SCRIPT], {
          cwd: ROOT,
          env: { ...process.env, MOCK_LLM_PORT: String(MOCK_LLM_PORT) },
          stdio: ['ignore', mockLogFd, mockLogFd],
          windowsHide: true,
        })
        const ok = await waitHttp(`http://127.0.0.1:${MOCK_LLM_PORT}/`, 15000)
        if (!ok) throw new Error('mock-llm 启动超时')
        log(`mock-llm 已启动（127.0.0.1:${MOCK_LLM_PORT}）`)
      } else {
        log(`mock-llm 已在运行（127.0.0.1:${MOCK_LLM_PORT}）`)
      }
    }

    if (!args.skipApp) {
      cleanChatState()
      appLogFd = openSync(path.join(REC_DIR, 'app.log'), 'a')
      appProc = spawn(
        ELECTRON,
        ['.', `--remote-debugging-port=${args.port}`, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
        {
          cwd: ROOT,
          env: { ...process.env, QDOQMC_USER_DATA: DEMO_DIR },
          stdio: ['ignore', appLogFd, appLogFd],
          windowsHide: false,
        },
      )
      log(`electron 已启动 pid=${appProc.pid}，等待 CDP 端口 ${args.port} …`)
    } else {
      log(`--skip-app：复用 127.0.0.1:${args.port} 上的 app`)
    }

    const page = await waitForPageTarget(args.port, { timeoutMs: 40000 })
    log(`CDP 页面：${page.title || '(无标题)'} ${page.url || ''}`)
    client = await CdpClient.connect(page.webSocketDebuggerUrl)
    await client.call('Page.enable')
    await client.call('Runtime.enable')
    await configureViewport(client, VIEWPORT)
    await client.call('Page.bringToFront').catch(() => undefined)

    // 等 React 首屏
    await waitForSelector(client, '.cf-topbar', { timeoutMs: 20000 })
    await waitForSelector(client, '.home', { timeoutMs: 15000 }).catch(() => undefined)
    await sleep(1800)
    log(`app 已就绪，视口 ${VIEWPORT.width}×${VIEWPORT.height}`)

    const results = []
    for (const sceneName of args.scenes) {
      const scene = SCENES[sceneName]
      if (!scene) throw new Error(`未知场景：${sceneName}（可选：${Object.keys(SCENES).join(', ')}）`)
      log(`\n=== 录制 ${sceneName}：${scene.label} ===`)

      // 回干净首页
      await client.call('Page.reload', { ignoreCache: false }).catch(() => undefined)
      await sleep(500)
      await waitForSelector(client, '.cf-topbar', { timeoutMs: 15000 })
      await sleep(1400)
      // 注入保活重绘层（reload 会清掉，每个场景重新注入）
      const keep = await installKeepAlive(client).catch((err) => `失败：${err?.message ?? err}`)
      log(`保活重绘层：${keep}`)
      await sleep(300)

      const recorder = new ScreencastRecorder({
        port: args.port,
        scene: sceneName,
        outDir: `out/rec/${sceneName}`,
        client,
        log,
        format: 'jpeg',
        quality: 95,
      })
      await recorder.connect()
      const first = await recorder.start()
      log(`screencast 开始：首帧 ${first.width}×${first.height}`)
      const driver = new Driver(client, recorder, { scene: sceneName, reviewDir: path.join(REC_DIR, 'review') })
      const t0 = Date.now()
      try {
        await scene.fn(driver)
      } catch (err) {
        log(`场景 ${sceneName} 执行出错，中止录制（不产出废素材）：${err?.message ?? err}`)
        throw err
      }
      await sleep(350)
      const scan = await collectAndScan(driver, sceneName, args.port).catch((err) => {
        log(`安全检查失败：${err?.message ?? err}`)
        return { hits: [] }
      })
      const summary = await recorder.stop()
      const elapsed = round3((Date.now() - t0) / 1000)
      results.push({ ...summary, elapsed, safe: scan.hits.length === 0, hits: scan.hits })
      log(
        `完成 ${sceneName}：${summary.duration.toFixed(2)}s，${summary.frameCount} 帧，平均 ${summary.avgFps} fps，` +
          `事件 ${summary.events} 条，抽帧尺寸 ${summary.frameWidth}×${summary.frameHeight}`,
      )
      await sleep(500)
    }

    console.log('\n===== 录制汇总 =====')
    for (const r of results) {
      console.log(
        `${r.scene.padEnd(9)} ${r.duration.toFixed(2)}s  ${String(r.frameCount).padStart(4)} 帧  ${String(r.avgFps).padStart(5)} fps  ` +
          `event=${String(r.events).padStart(4)}  安全=${r.safe ? 'OK' : '⚠️ ' + JSON.stringify(r.hits)}`,
      )
    }
    writeFileSync(path.join(REC_DIR, 'summary.json'), `${JSON.stringify({ scenes: results, port: args.port }, null, 2)}\n`, 'utf8')
    console.log('\n下一步：node scripts/rec/encode.mjs --all')
  } finally {
    if (client) client.close()
    if (appProc && !args.keepApp) {
      killTree(appProc.pid, ' electron ')
      await sleep(600)
    } else if (appProc && args.keepApp) {
      log('--keep-app：保留 electron 运行')
      appProc.unref()
    }
    if (mockProc) killTree(mockProc.pid, ' mock-llm ')
    if (appLogFd) closeSync(appLogFd)
    if (mockLogFd) closeSync(mockLogFd)
  }
}

main().catch((err) => {
  console.error('[drive] 失败:', err?.message ?? err)
  process.exit(1)
})
