/**
 * selftest.mjs —— 假 ctx 跑一遍本插件的 apply、全部工具与设置页用的 HTTP 路由
 * 运行：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   Start-Process '<DSH 安装目录>\\DSH Desktop.exe' -ArgumentList '"…\selftest.mjs"' -NoNewWindow -Wait
 * 结果：同目录 selftest-out.json
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⚠️ 自检不要碰真实家目录（否则会把用户的 sessionId / 人设 / 计数写坏）：临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bili-toy-bot-selftest-'))

const here = dirname(fileURLToPath(import.meta.url))
const out = { tools: [], results: {}, routes: [], errors: [] }

const tools = new Map()
const routeSpecs = []
let disposers = []

// 假的会话服务：够让「绑定会话 / 新建 / 发测试消息」走通就行
const fakeSessions = new Map()
const makeSession = (id) => ({
  id,
  header: { id, createdAt: new Date().toISOString(), cwd: 'D:\\demo' },
  log: [],
  append(type, data) { this.log.push({ type, data }) },
  deriveMessages() {
    return this.log.filter((x) => x.type === 'user/message').map((x) => x.data?.message).filter(Boolean)
  },
})
fakeSessions.set('sess-alpha', makeSession('sess-alpha'))
const sessionsService = {
  list() { return [...fakeSessions.values()] },
  get(id) { return fakeSessions.get(id) },
  create(id, opts) {
    const sid = id || 'sess-' + fakeSessions.size
    const s = makeSession(sid)
    if (opts?.meta?.cwd) s.header.cwd = opts.meta.cwd
    fakeSessions.set(sid, s)
    return s
  },
}

// 假的 agents 服务：只实现 followup（真宿主里这是唤醒会话跑一轮的那个入口）
const fakeAgents = new Map()
const agentsService = {
  get(id) { return fakeAgents.get(String(id)) || null },
  ensure(id) {
    const key = String(id)
    if (!fakeAgents.has(key)) {
      fakeAgents.set(key, {
        id: key,
        inbox: [],
        followup(msg) { this.inbox.push(msg); return { ok: true } },
      })
    }
    return fakeAgents.get(key)
  },
}

const ctx = {
  tools: {
    register(t) {
      const id = t.name || t.id
      tools.set(id, t)
      out.tools.push(id)
      return { id, dispose() { tools.delete(id) } }
    },
  },
  webServer: {
    register(spec) { routeSpecs.push(spec); return { path: spec.path, dispose() {} } },
  },
  effect(fn, label) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return () => {}
  },
  get(name) {
    if (name === 'webServer') return ctx.webServer
    if (name === 'tools') return ctx.tools
    if (name === 'sessions') return sessionsService
    if (name === 'agents') return agentsService
    return undefined
  },
  sessions: sessionsService,
  agents: agentsService,
  logger() { return { info() {}, warn() {}, error() {} } },
}

async function call(name, args) {
  const t = tools.get(name)
  if (!t) { out.results[name] = { ok: false, error: 'tool not registered' }; return null }
  try {
    const r = await t.execute(args || {}, {})
    out.results[name] = { ok: r?.ok !== false, sample: summarize(r) }
    return r
  } catch (e) {
    out.results[name] = { ok: false, error: String(e?.message || e) }
    out.errors.push(`${name}: ${e?.message || e}`)
    return null
  }
}

function summarize(v) {
  if (v === null || typeof v !== 'object') return v
  const s = JSON.stringify(v)
  return s.length > 500 ? s.slice(0, 500) + '…' : JSON.parse(s)
}

/** 用假 req/res 打一次插件的 HTTP 路由 */
async function http(method, path, body) {
  const spec = routeSpecs.find((r) => path.startsWith(r.path))
  if (!spec) return { ok: false, error: 'route not found' }
  const chunks = []
  const res = {
    code: 0,
    writeHead(code) { this.code = code },
    end(b) { chunks.push(b) },
  }
  const payload = body === undefined ? '' : JSON.stringify(body)
  const listeners = new Map()
  const req = {
    method,
    url: path,   // 宿主的 webServer 只调 handler(req, res) 两个参数，路径全在 req.url 里
    on(ev, fn) { listeners.set(ev, fn); return this },
    destroy() {},
  }
  // 先把 handler 跑起来（它会同步注册 data/end 监听），再喂 body，避免死等
  // ⚠️ 故意只传两个参数，和 dsh-host-webserver 的真实调用保持一致
  const running = Promise.resolve(spec.handler(req, res))
  if (payload && listeners.get('data')) listeners.get('data')(payload)
  if (listeners.get('end')) listeners.get('end')()
  await running
  let parsed = null
  try { parsed = JSON.parse(chunks.join('') || '{}') } catch { parsed = { raw: chunks.join('') } }
  return { ok: res.code === 200 && parsed?.ok !== false, code: res.code, body: parsed }
}

const mod = await import(pathToFileURL(join(here, 'index.js')).href)
mod.apply(ctx, { enabled: false })

out.toolCount = out.tools.length
out.routes = routeSpecs.map((r) => r.path)

await call('bot_status')
await call('bot_config_get')
await call('bot_plan')
// 先绑一个假会话，验证「玩一局」走的是交接路径（agent.followup）
await call('bot_config_set', { patch: { sessionId: 'sess-alpha', playMode: 'session', broadcastMode: 'session' } })
agentsService.ensure('sess-alpha')
const playNowRes = await call('bot_play_now')
await call('bot_runs', { limit: 3 })
const runs = out.results.bot_runs?.sample?.runs || []
if (runs[0]?.id) await call('bot_run_get', { runId: runs[0].id })
await call('bot_diary')
await call('bot_stats', { logLines: 5 })
await call('bot_say', { text: '今天广场人好多' })
await call('bot_feed', { limit: 5 })
await call('bot_session_bind', { sessionId: '' })
await call('bot_comment_draft', runs[0]?.id ? { runId: runs[0].id } : {})
await call('bot_comment_list', { limit: 5 })
const cfg = out.results.bot_config_get?.sample?.config || {}
await call('bot_config_set', { patch: { enabled: false, maxRunsPerDay: cfg.maxRunsPerDay || 6 } })
await call('bot_start')
await call('bot_stop')
await call('bot_sessions')
await call('bot_voice', { title: '测试小游戏', minutes: 5 })
await call('bot_session_activate', { sessionId: '' })
const voiceRound = await call('bot_config_set', {
  patch: {
    persona: { name: '测试鱼', species: '一条测试用的小鱼', temperament: '嘴硬心软', catchphrases: ['鱼在呢', '别刷了'], bio: '来测一下人设能不能改。' },
    voice: { styleText: '句子短，爱自嘲', commentTemplate: '玩了「{title}」{minutes} 分钟，{catchphrase}' },
  },
})
// @ 策略 + 白名单：设置页新加的两块，写进去要能原样读回来
await call('bot_config_set', {
  patch: {
    commentEnabled: true,
    atEnabled: true,
    atMaxPerDay: 2,
    atTargets: [{ name: '主人', uid: '3546830222657967' }, { name: '大肥鱼打游戏', uid: '3546707958696755' }],
    allowAuthors: ['大肥鱼打游戏', '3546707958696755'],
    allowSlugs: ['TY5AaSWHJQ7R8Zdt'],
    blacklistKeywords: ['抽奖', '实名'],
    minGapMinutes: 35,
    heartbeatSeconds: 6,
  },
})
await call('bot_config_get')
const after = await call('bot_config_get')
const afterCfg = (after || {}).config || {}
out.policyConfig = {
  atEnabled: afterCfg.atEnabled,
  atMaxPerDay: afterCfg.atMaxPerDay,
  atTargets: afterCfg.atTargets,
  allowAuthors: afterCfg.allowAuthors,
  allowSlugs: afterCfg.allowSlugs,
  blacklistKeywords: afterCfg.blacklistKeywords,
  minGapMinutes: afterCfg.minGapMinutes,
  heartbeatSeconds: afterCfg.heartbeatSeconds,
}
const bindOut = (await call('bot_session_bind', { sessionId: 'sess-alpha' })) || {}

// 设置页用的路由
out.http = {
  status: await http('GET', '/api/bili-toy-bot/status'),
  feed: await http('GET', '/api/bili-toy-bot/feed'),
  runs: await http('GET', '/api/bili-toy-bot/runs'),
  configGet: await http('GET', '/api/bili-toy-bot/config'),
  configPost: await http('POST', '/api/bili-toy-bot/config', { patch: { maxRunsPerDay: cfg.maxRunsPerDay || 6 } }),
  sessions: await http('GET', '/api/bili-toy-bot/sessions'),
  sessionBind: await http('POST', '/api/bili-toy-bot/session/bind', { sessionId: 'sess-alpha' }),
  sessionCreate: await http('POST', '/api/bili-toy-bot/session/create', {}),
  sessionTest: await http('POST', '/api/bili-toy-bot/session/test', {}),
  voiceComment: await http('POST', '/api/bili-toy-bot/voice/comment', { title: '测试小游戏', minutes: 5 }),
  progress: await http('GET', '/api/bili-toy-bot/progress'),
}

// 回归 0.4.5：面板点「玩一局」带 minutes 只是这一次的临时上限，**不许写回 maxMinutesPerToy**
await http('POST', '/api/bili-toy-bot/config', { patch: { maxMinutesPerToy: 20 } })
const playRoute = await http('POST', '/api/bili-toy-bot/play', { minutes: 2 })
const cfgAfterRoutePlay = (await call('bot_config_get'))?.config || {}
out.regressMinutes = {
  playRouteCode: playRoute?.code,
  playOk: playRoute?.body?.ok,
  playBody: playRoute?.body,
  maxMinutesPerToyAfter: cfgAfterRoutePlay.maxMinutesPerToy,
}

out.summary = {
  toolsOk: out.toolCount >= 20,
  routesOk: out.routes.includes('/api/bili-toy-bot'),
  planOk: out.results.bot_plan?.ok === true,
  playNowOk: out.results.bot_play_now?.ok === true,
  handoffOk: playNowRes?.via === 'followup' && playNowRes?.mode === 'session' && agentsService.get('sess-alpha')?.inbox?.length > 0,
  commentDraftOk: out.results.bot_comment_draft?.ok === true,
  feedOk: out.results.bot_feed?.ok === true,
  sessionsOk: Array.isArray(out.results.bot_sessions?.sample?.items) || Array.isArray((await call('bot_sessions'))?.items),
  personaSaved: afterCfg.persona?.name === '测试鱼' && (afterCfg.persona?.catchphrases || []).includes('鱼在呢'),
  voiceSaved: String(afterCfg.voice?.commentTemplate || '').includes('{title}'),
  atPolicySaved: afterCfg.atEnabled === true
    && Number(afterCfg.atMaxPerDay) === 2
    && Array.isArray(afterCfg.atTargets)
    && afterCfg.atTargets[0]?.name === '主人'
    && afterCfg.atTargets[0]?.uid === '3546830222657967'
    && (afterCfg.allowAuthors || []).includes('大肥鱼打游戏')
    && (afterCfg.allowSlugs || []).includes('TY5AaSWHJQ7R8Zdt')
    && (afterCfg.blacklistKeywords || []).includes('实名')
    && Number(afterCfg.minGapMinutes) === 35
    && Number(afterCfg.heartbeatSeconds) === 6,
  bindOk: bindOut.ok === true && bindOut.bound === 'sess-alpha',
  activated: bindOut.activated === true,
  httpOk: Object.values(out.http).every((x) => x?.ok === true),
  httpSessionsOk: Array.isArray(out.http.sessions?.body?.items) && out.http.sessions.body.items.length > 0,
  minutesNotClobbered: Number(out.regressMinutes?.maxMinutesPerToyAfter) === 20,
  errors: out.errors,
}

writeFileSync(join(here, 'selftest-out.json'), JSON.stringify(out, null, 2), 'utf8')
for (const d of disposers) { try { d() } catch { /* 忽略 */ } }
process.exit(0)
