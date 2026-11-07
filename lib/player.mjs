/**
 * lib/player.mjs —— 真的去玩（CDP）
 * ============================================================================
 * 用 Edge/Chrome 的 DevTools 协议开一个后台页面：导航到 toy → 点「开始」→
 * 每隔几秒截一张图当证据、隔一会做一个轻动作（点/空格），到点收工。
 *
 * 好处：headless 跑，不抢前台、不动用户的鼠标键盘；玩的过程全在截图里。
 * 注意：只做 L2 该做的事 —— 不读游戏状态、不连招，动作频率有上限。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BROWSERS = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

/** 找一个能用的浏览器可执行文件 */
export function findBrowser(cfg = {}) {
  const custom = cfg.browserPath ? String(cfg.browserPath) : ''
  if (custom && existsSync(custom)) return { ok: true, path: custom, kind: 'custom' }
  for (const p of BROWSERS) {
    if (existsSync(p)) return { ok: true, path: p, kind: /chrome\.exe$/i.test(p) ? 'chrome' : 'edge' }
  }
  return { ok: false, message: '没找到 Edge/Chrome：在配置里给 browserPath 指一个可执行文件' }
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.seq = 1
    this.pending = new Map()
    this.handlers = []
  }

  async connect(timeoutMs = 10000) {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      this.ws.onopen = () => { clearTimeout(timer); resolve() }
      this.ws.onerror = (e) => { clearTimeout(timer); reject(new Error('CDP 连接失败：' + (e?.message || 'ws error'))) }
    })
    this.ws.onmessage = (ev) => {
      let msg = null
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'}${msg.error.code ? ` (${msg.error.code})` : ''}`))
        else resolve(msg.result)
        return
      }
      if (msg.method) for (const h of this.handlers) { try { h(msg) } catch { /* 忽略 */ } }
    }
    return this
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.seq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时 ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(fn) { this.handlers.push(fn) }

  close() { try { this.ws.close() } catch { /* 已关 */ } }
}

async function getJSON(url, timeoutMs = 3000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) }
  } finally { clearTimeout(timer) }
}

/** 起一个带调试端口的浏览器，等它可用 */
async function launchBrowser({ executable, port, userDataDir, headless = true, width = 1280, height = 800 }) {
  mkdirSync(userDataDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--window-size=${width},${height}`,
  ]
  if (headless) args.push('--headless=new')
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const v = await getJSON(`http://127.0.0.1:${port}/json/version`, 1500)
    if (v.ok) return { ok: true, child, version: v.data?.Browser || '' }
    await sleep(250)
  }
  try { child.kill() } catch { /* 忽略 */ }
  return { ok: false, message: `浏览器没起来（端口 ${port}）` }
}

const CLICK_TEXT_JS = (words) => `(() => {
  const words = ${JSON.stringify(words)};
  const els = Array.from(document.querySelectorAll('button,a,div,span,p,img,canvas'));
  for (const el of els) {
    const t = (el.innerText || el.textContent || el.alt || '').trim();
    if (!t || t.length > 16) continue;
    if (!words.some((w) => t === w || t.includes(w))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (r.left < 0 || r.top < 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    return { ok: true, text: t, tag: el.tagName, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  return { ok: false, title: document.title, text: (document.body && document.body.innerText || '').slice(0, 200) };
})()`

const PAGE_INFO_JS = `(() => ({
  title: document.title,
  url: location.href,
  ready: document.readyState,
  text: (document.body && document.body.innerText || '').replace(/\\n{2,}/g, '\\n').slice(0, 400),
  buttons: Array.from(document.querySelectorAll('button,a')).map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 12),
}))()`

const sha = (buf) => createHash('sha1').update(buf).digest('hex')

/**
 * 玩一局。
 * @param {object} o
 * @param {{id:string,title:string,url:string}} o.toy
 * @param {object} o.cfg      机器人配置
 * @param {string} o.runId    记录目录
 * @param {(step:object)=>void} [o.onStep]
 */
export async function playToy({ toy, cfg, runId, onStep }) {
  const started = Date.now()
  const found = findBrowser(cfg)
  if (!found.ok) return { ok: false, message: found.message }

  const port = 9500 + Math.floor(Math.random() * 300)
  const profileDir = join(process.env.DSH_HOME || process.env.USERPROFILE || '.', '.dsh', 'bili-toy-bot', 'cdp-profile')
  const userDataDir = cfg.browserUserDataDir ? String(cfg.browserUserDataDir) : profileDir
  const width = 1280
  const height = 800
  if (!toy?.url) return { ok: false, message: '这个 toy 没有可打开的直接链接（只有 slug）' }

  const launched = await launchBrowser({ executable: found.path, port, userDataDir, headless: cfg.headless !== false, width, height })
  if (!launched.ok) return { ok: false, message: launched.message }

  const steps = []
  const shots = []
  let page = null
  let browserVer = launched.version
  const step = (action, extra = {}) => {
    const s = { action, ...extra }
    steps.push(s)
    try { onStep?.(s) } catch { /* 忽略 */ }
  }

  try {
    const made = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    if (!made.ok) throw new Error(`开新标签页失败 HTTP ${made.status}`)
    const target = await made.json()
    page = await new CDP(target.webSocketDebuggerUrl).connect()
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    step('launch', { browser: found.kind, headless: cfg.headless !== false, version: browserVer })

    // 导航
    let loaded = false
    page.on((m) => { if (m.method === 'Page.loadEventFired') loaded = true })
    await page.send('Page.navigate', { url: toy.url })
    for (let i = 0; i < 120 && !loaded; i++) await sleep(250)
    await sleep(Math.max(600, Number(cfg.startDelayMs) || 1500))
    // 等页面真的画出东西再截图（有些 toy 是 canvas，文字可能很少，最多等 12s）
    for (let i = 0; i < 24; i++) {
      const len = await page.send('Runtime.evaluate', { expression: 'document.body ? (document.body.innerText || "").length : 0', returnByValue: true })
        .then((r) => Number(r.result?.value) || 0).catch(() => 0)
      if (len > 20) break
      await sleep(500)
    }
    step('navigate-settle', { url: toy.url, loaded })

    const info = await page.send('Runtime.evaluate', { expression: PAGE_INFO_JS, returnByValue: true })
      .then((r) => r.result?.value).catch(() => null)
    step('inspect', { title: info?.title || '', buttons: info?.buttons || [], text: (info?.text || '').slice(0, 160) })

    // 截图
    const shoot = async (tag) => {
      try {
        const res = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, 20000)
        const buf = Buffer.from(res.data, 'base64')
        const file = join(runId, 'shots', `${String(shots.length + 1).padStart(2, '0')}-${tag}.jpg`)
        mkdirSync(join(runId, 'shots'), { recursive: true })
        const { writeFileSync } = await import('node:fs')
        writeFileSync(file, buf)
        shots.push({ file, hash: sha(buf), at: Date.now() })
        return buf
      } catch { return null }
    }

    await shoot('start')

    // 点开始：游戏菜单往往在导航完成后才画出来，所以重试几次，别一进来就点空
    const startWords = ['开始游戏', '开始玩', '开始', 'Toy启动', '进入游戏', '点击开始', 'START', 'Play', '确定']
    const tryStart = async () => {
      try {
        const r = await page.send('Runtime.evaluate', { expression: CLICK_TEXT_JS(startWords), returnByValue: true })
        const hit = r.result?.value
        if (!hit?.ok) return null
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y })
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
        await sleep(90)
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
        step('click-start', { text: hit.text, x: hit.x, y: hit.y })
        return hit
      } catch { return null }
    }

    let inGame = false
    for (let i = 0; i < 8 && !inGame; i++) {
      const hit = await tryStart()
      if (hit) {
        await sleep(1600)
        const info2 = await page.send('Runtime.evaluate', { expression: PAGE_INFO_JS, returnByValue: true })
          .then((r) => r.result?.value).catch(() => null)
        const stillMenu = /开始游戏|开始玩|Toy启动/.test(info2?.text || '')
        inGame = !stillMenu
        step('start-check', { clicked: hit.text, stillMenu })
        if (inGame) break
      }
      await sleep(2500)
    }

    if (!inGame) {
      // 兜底：点画面中下方（菜单按钮通常在这一带）
      const cx = Math.round(width / 2)
      const cy = Math.round(height * 0.62)
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
      await sleep(90)
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
      step('click-center', { x: cx, y: cy })
    }
    await sleep(1200)
    await shoot('after-start')

    // 玩：定时截图 + 轻动作，到点/挂机收工
    const maxMinutes = Math.max(1, Math.min(Number(cfg.maxMinutesPerToy) || 20, 60))
    const deadline = started + maxMinutes * 60_000
    const perMinute = Math.max(1, Math.min(Number(cfg.maxActionsPerMinute) || 12, 60))
    let actions = 0
    let lastHash = shots[shots.length - 1]?.hash || ''
    let still = 0
    let lastShotAt = Date.now()
    let lastActAt = Date.now()

    while (Date.now() < deadline) {
      await sleep(5000)
      const res = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 20000).catch(() => null)
      if (res?.data) {
        const buf = Buffer.from(res.data, 'base64')
        const h = sha(buf)
        const changed = h !== lastHash
        if (changed) { still = 0; lastHash = h } else { still += 5 }
        // 画面变了就留一张，另外最多每 30s 留一张
        if (changed || Date.now() - lastShotAt > 30_000) {
          const { writeFileSync } = await import('node:fs')
          const file = join(runId, 'shots', `${String(shots.length + 1).padStart(2, '0')}-play.jpg`)
          try { writeFileSync(file, buf); shots.push({ file, hash: h, at: Date.now() }); lastShotAt = Date.now() } catch { /* 忽略 */ }
        }
      }
      if (still >= Math.max(15, Number(cfg.idleStopSeconds) || 45)) {
        step('idle-stop', { stillSeconds: still })
        break
      }
      // 还没进游戏就继续试着点开始（有些游戏要加载很久）
      if (!inGame) {
        const hit = await tryStart()
        if (hit) { inGame = true; await sleep(1200) }
      } else {
        // 误点进设置/排行榜之类的弹层：看到「返回游戏」就退回去
        try {
          const r2 = await page.send('Runtime.evaluate', { expression: CLICK_TEXT_JS(['返回游戏', '继续游戏', '返回']), returnByValue: true })
          const back = r2.result?.value
          if (back?.ok) {
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: back.x, y: back.y })
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: back.x, y: back.y, button: 'left', clickCount: 1 })
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: back.x, y: back.y, button: 'left', clickCount: 1 })
            step('recover', { text: back.text })
            await sleep(400)
          }
        } catch { /* 没有这些按钮就算了 */ }
      }
      const canAct = (Date.now() - lastActAt) > (60_000 / perMinute) && actions < perMinute * maxMinutes
      if (canAct) {
        const cx = Math.round(width / 2)
        const cy = Math.round(height / 2 + 60)
        try {
          if (actions % 3 === 2) {
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
            step('key', { key: 'space' })
          } else {
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
            step('click', { x: cx, y: cy })
          }
          actions++
          lastActAt = Date.now()
        } catch { /* 点不动就算了 */ }
      }
    }

    // 收尾：再看一眼页面
    const tail = await page.send('Runtime.evaluate', { expression: PAGE_INFO_JS, returnByValue: true })
      .then((r) => r.result?.value).catch(() => null)
    await shoot('end')

    const minutes = Math.round((Date.now() - started) / 6000) / 10
    return {
      ok: true,
      minutes,
      actions,
      shots: shots.length,
      steps,
      stopReason: Date.now() >= deadline ? 'timeout' : 'idle',
      title: tail?.title || info?.title || toy.title,
      text: (tail?.text || '').slice(0, 300),
      shotFiles: shots.map((s) => s.file),
    }
  } catch (e) {
    return { ok: false, message: String(e?.message || e), steps, shots: shots.length, minutes: Math.round((Date.now() - started) / 6000) / 10 }
  } finally {
    try { if (page) await page.send('Browser.close', {}, 3000).catch(() => {}) } catch { /* 忽略 */ }
    try { page?.close() } catch { /* 忽略 */ }
    try { launched.child?.kill() } catch { /* 忽略 */ }
  }
}
