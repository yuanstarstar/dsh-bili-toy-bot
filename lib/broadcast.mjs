/**
 * lib/broadcast.mjs —— 播报 + 会话绑定（M4）
 * ============================================================================
 * 三种落地方式：
 *   feed    —— 写进 <home>/feed.jsonl，设置页「动态 / 实时进度」里能看到；
 *   session —— 往绑定的 DSH 会话里追加一条插件消息（会出现在那个会话的对话流里）；
 *   off     —— 只在本地记账，不外发。
 *
 * 玩游戏时的「实时进度」默认直接进会话（progressToSession），而收工播报按 broadcastMode。
 * 任何一步失败都退回 feed，不抛错（播报不该拖垮机器人）。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function feedPath(home) { return join(home, 'feed.jsonl') }

export function readFeed(home, limit = 20) {
  const p = feedPath(home)
  if (!existsSync(p)) return []
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, limit)).map((l) => { try { return JSON.parse(l) } catch { return { at: 0, text: l } } }).reverse()
  } catch { return [] }
}

export function pushFeed(home, entry) {
  const p = feedPath(home)
  try {
    try { mkdirSync(dirname(p), { recursive: true }) } catch { /* 已存在 */ }
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8')
    // 太长就截断，只留最近 500 行
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    if (lines.length > 500) writeFileSync(p, lines.slice(-500).join('\n') + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 从消息内容里抠一段纯文本 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ')
}

function stampOf(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : 0
}

/** 一个会话的「一句话预览」：最近一条人话 */
function previewOf(session) {
  try {
    const msgs = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 40; i--) {
      const text = textOf(msgs[i]).replace(/\s+/g, ' ').trim()
      if (text) return text.slice(0, 80)
    }
  } catch { /* 投影不出来就算了 */ }
  try {
    const log = Array.isArray(session?.log) ? session.log : []
    for (let i = log.length - 1; i >= 0 && i >= log.length - 60; i--) {
      const ev = log[i]
      const text = textOf(ev?.data?.message) || textOf(ev?.message)
      if (text) return String(text).replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  } catch { /* 忽略 */ }
  return ''
}

/**
 * @param {{ ctx: any, home: () => string, getCfg: () => any, log: (m: string) => void }} deps
 */
export function createBroadcaster({ ctx, home, getCfg, log }) {
  /** 宿主的会话服务（不同版本可能挂在 ctx.sessions / ctx.get('sessions')） */
  function sessionsService() {
    try {
      const s = ctx.get?.('sessions') || ctx.sessions || null
      return s && typeof s.get === 'function' ? s : null
    } catch { return null }
  }

  function appendToSession(sessionId, text) {
    const sessions = sessionsService()
    if (!sessions) return { ok: false, why: '宿主没有 sessions 服务' }
    let session = null
    try { session = sessions.get(String(sessionId)) } catch { session = null }
    if (!session) return { ok: false, why: `会话不在线：${sessionId}` }
    if (typeof session.append !== 'function') return { ok: false, why: '会话不支持 append' }
    try {
      // ⚠️ user/message 是"能进对话流"的事件，必须显式声明 surfaceOp，否则宿主会拒：
      //    session event "user/message" is surface-eligible and requires a surfaceOp marker
      session.append('user/message', {
        message: {
          id: `bili-toy-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          source: { kind: 'plugin', name: 'dsh-bili-toy-bot' },
          content: [{ type: 'text', text }],
        },
        intent: { surfaceOp: 'append' },
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, why: String(e?.message || e) }
    }
  }

  /** 列出所有在线会话（给设置页的「绑定会话」展开用） */
  function listSessions() {
    const sessions = sessionsService()
    if (!sessions || typeof sessions.list !== 'function') return { ok: false, why: '宿主没有 sessions 服务', items: [] }
    let all = []
    try { all = sessions.list() } catch (e) { return { ok: false, why: String(e?.message || e), items: [] } }
    const cfg = getCfg() || {}
    const items = (Array.isArray(all) ? all : []).map((s) => {
      const events = Array.isArray(s?.log) ? s.log.length : 0
      return {
        id: String(s?.id || ''),
        createdAt: stampOf(s?.header?.createdAt),
        cwd: String(s?.header?.cwd || ''),
        events,
        preview: previewOf(s),
        bound: String(s?.id || '') === String(cfg.sessionId || ''),
      }
    }).filter((x) => x.id)
    return { ok: true, items, bound: String(cfg.sessionId || '') }
  }

  /** 建一个会话（用 DFM 同名风格：bili-toy-bot-<时间戳>），用于「新建并绑定」 */
  function createSession({ title = '' } = {}) {
    const sessions = sessionsService()
    if (!sessions || typeof sessions.create !== 'function') return { ok: false, why: '宿主不支持创建会话' }
    const id = `bili-toy-bot-${Date.now().toString(36)}`
    try {
      const session = sessions.create(id, { meta: { cwd: home() } })
      return { ok: true, id: String(session?.id || id), title }
    } catch (e) {
      return { ok: false, why: String(e?.message || e) }
    }
  }

  /** 激活一个会话：能拿到就给它发一条上线通知，让用户在那个会话里立刻看见机器人 */
  function activate(sessionId, text = '') {
    const id = String(sessionId || '')
    if (!id) return { ok: false, why: '没有会话 id' }
    const sessions = sessionsService()
    if (!sessions) return { ok: false, why: '宿主没有 sessions 服务' }
    let session = null
    try { session = sessions.get(id) } catch { session = null }
    if (!session) return { ok: false, why: `会话不在线：${id}` }
    const line = text || '我上线了，接下来玩 toy 的进度会实时发到这里。'
    const res = appendToSession(id, line)
    return res.ok ? { ok: true, id, text: line } : { ok: false, why: res.why }
  }

  return {
    listSessions,
    createSession,
    activate,
    appendToSession,
    /** 改一条消息发到指定会话（不做 broadcastMode 判断） */
    sendTo(sessionId, text) { return appendToSession(String(sessionId || ''), String(text || '')) },

    /** 播报一句；返回 { ok, via, text } */
    say(text, kind = 'run') {
      const c = getCfg() || {}
      const line = String(text || '').trim()
      if (!line) return { ok: false, message: '空播报' }
      const entry = { at: Date.now(), kind, persona: c.persona?.name || '小鲸鱼', text: line }

      // 实时进度：只要绑了会话就往会话里推（不受 broadcastMode 影响，除非显式关掉）
      const progressToSession = kind === 'progress' && c.progressToSession !== false
      const wantSession = (c.broadcastMode === 'session' && c.sessionId) || (progressToSession && c.sessionId)

      if (c.broadcastMode === 'off' && !wantSession) return { ok: true, via: 'off', text: line }

      if (wantSession) {
        try {
          const res = appendToSession(String(c.sessionId), `${entry.persona}：${line}`)
          if (res.ok) { pushFeed(home(), { ...entry, via: 'session' }); return { ok: true, via: 'session', text: line } }
          log(`播报没送进会话（${res.why}），改记到动态`)
        } catch (e) {
          log(`播报送会话失败：${e?.message || e}，改记到动态`)
        }
      }

      pushFeed(home(), { ...entry, via: 'feed' })
      return { ok: true, via: 'feed', text: line }
    },
  }
}
