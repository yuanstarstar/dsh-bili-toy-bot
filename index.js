/**
 * dsh-bili-toy-bot —— host 半端（M1：规划 / 记录 / 开关）
 * ============================================================================
 * 目标：一个按作息表自己去 Toy 广场玩游戏的机器人。
 *   M1（本文件）：配置、时段调度、选品、记录、会话播报的工具面；**还没真的玩**
 *   M2：CDP 打开页面、点开始、定时截图、到点收工（已验证 CDP 可用）
 *   M3：评论（默认 dryRun，只生成不发送）
 *
 * 依赖：dsh-bili-toy（借它的 lib/bili.mjs 与登录凭证）
 * 家目录：<DSH_HOME>/bili-toy-bot/
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadHostDeps } from './lib/hostdeps.mjs'
import {
  DEFAULT_CONFIG, homeDir, loadConfig, saveConfig, normalizeConfig,
  loadState, saveState, loadHistory, saveHistory, loadCommented, logLine, readLogTail, todayKey,
} from './lib/state.mjs'
import { canRunNow, describeSchedule, inAnyWindow, minuteOfDay, parseSlots, minutesLeftInWindow } from './lib/schedule.mjs'
import { loadToyApi } from './lib/toyapi.mjs'
import { createRun, listRuns, readRun, readDailyDigest, pruneOld, renderDiary, updateRun, appendStep, writeDiary, writeDailyDigest } from './lib/recorder.mjs'
import { pickToy } from './lib/picker.mjs'
import { playToy } from './lib/player.mjs'
import { makeDraft, atQuotaOk, commentQuotaOk, pickAtTarget, STYLE_LABEL, fillTemplate, pickCatchphrase } from './lib/commenter.mjs'
import { createBroadcaster, readFeed } from './lib/broadcast.mjs'
import { createVoice } from './lib/voice.mjs'
import { buildPlayPrompt, sendToSession } from './lib/handoff.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'bili-toy-bot'
export const inject = ['tools', 'webServer']

/** 宿主设置里的总开关；其余配置都在 config.json（bot_config_set 或设置页改） */
export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(false).extra('volatile', true),
})

const pluginDir = dirname(fileURLToPath(import.meta.url))

function myVersion() {
  try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '' } catch { return '' }
}

/** 一层深合并：对象字段按 key 合，其它直接替换（persona/voice 这类分组不会因为只改一项而丢别的） */
function mergePatch(base, patch) {
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(patch || {})) {
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = { ...cur, ...v }
    } else {
      out[k] = v
    }
  }
  return out
}

export function apply(ctx, config) {
  const rawCfg = config || {}
  const hostEnabled = typeof rawCfg.enabled === 'boolean' ? rawCfg.enabled : false
  const log = (m) => { try { logLine('host', typeof m === 'string' ? m : JSON.stringify(m)) } catch { /* 忽略 */ } }

  let cfg = loadConfig()
  // 文件里的 enabled 优先于宿主默认；只有用户显式改过才同步
  cfg.enabled = hostEnabled || cfg.enabled
  saveConfig(cfg)
  log(`已挂载 v${myVersion()}，enabled=${cfg.enabled}，时段=${describeSchedule(cfg)}`)

  const state = loadState()
  let lastOk = null
  // 心跳：只在内存里记，别每次写 state 文件（10 秒一次太费，而且会跟收工写计数打架）
  const heartbeat = { at: 0, beats: 0, everySec: 0 }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  let toolCount = 0
  const tool = (spec) => {
    toolCount += 1
    return ctx.tools.register(defineTool({
      ...spec,
      output: textOutput,
      async execute(args, exec) { return safe(await spec.execute(args, exec)) },
    }))
  }

  const reload = () => { cfg = loadConfig(); cfg.enabled = hostEnabled || cfg.enabled; return cfg }

  const broadcaster = createBroadcaster({ ctx, home: () => homeDir(), getCfg: () => loadConfig(), log })
  const voice = createVoice({ ctx, log })

  /** 把播报模板填好：填了就用自己的模板，没填就用内置写法 */
  function renderLine(tplKey, vars, fallback) {
    const cfgNow = loadConfig()
    const tpl = String(cfgNow?.voice?.[tplKey] || '').trim()
    if (!tpl) return fallback
    const text = fillTemplate(tpl, { ...vars, catchphrase: pickCatchphrase(cfgNow) }).trim()
    return text || fallback
  }

  /* ─────────────── 评论（M3：先出草稿，默认不发） ─────────────── */

  /**
   * 给一局生成评论草稿；满足条件（commentEnabled && !dryRun && 未超上限）才真的发。
   * @returns {{ ok: boolean, text?: string, sent?: boolean, rpid?: string, skip?: string, via?: string }}
   */
  async function commentForRun({ runId, toy, minutes, actions = 0 }) {
    const c = loadConfig()
    // 设置了「说话风格」就先让模型按人设现写一句；写不出来再走模板
    let ai = null
    try { ai = await voice.draftComment({ cfg: c, toy, minutes, actions }) } catch (e) { log(`写评论出错：${e?.message || e}`) }
    let draft = ai?.ok
      ? { ok: true, text: ai.text, style: 'custom', styleLabel: 'AI 现写', atName: '', atUid: '' }
      : makeDraft({ cfg: c, toy, run: { id: runId, minutes, actions } })
    if (!draft.ok) return { ok: false, skip: draft.skip }
    if (ai?.ok) {
      const t = pickAtTarget(c)
      draft.atName = t ? t.name : ''
      draft.atUid = t ? t.uid : ''
    }

    const st = loadState()
    const canAt = !!draft.atName && atQuotaOk(c, st)
    let text = canAt ? `@${draft.atName} ${draft.text}` : draft.text
    if (Number(c.commentLengthMax) > 0) text = text.slice(0, Number(c.commentLengthMax))

    const rec = {
      text,
      style: draft.style,
      styleLabel: STYLE_LABEL[draft.style] || draft.style,
      atName: canAt ? draft.atName : '',
      atUid: canAt ? draft.atUid : '',
      at: Date.now(),
      sent: false,
      rpid: '',
      skip: '',
    }

    if (c.commentEnabled !== true || c.dryRun !== false) {
      rec.skip = c.commentEnabled !== true ? '评论开关没开' : 'dryRun=true'
      return { ok: true, dryRun: true, ...rec }
    }
    if (!commentQuotaOk(c, st)) {
      rec.skip = `今天评论已达上限（${c.commentMaxPerDay}）`
      return { ok: true, dryRun: true, ...rec }
    }

    try {
      const api = await loadToyApi()
      const res = await api.postComment({
        toyId: toy.id,
        text: rec.text,
        atName: rec.atName || undefined,
        atUid: rec.atUid || undefined,
      })
      if (!res?.ok) {
        rec.skip = `发送失败：${res?.message || '未知错误'}`
        log(`评论没发出去：${rec.skip}`)
        return { ok: false, ...rec }
      }
      rec.sent = true
      rec.rpid = String(res.rpid || '')
      const s2 = loadState()
      s2.commentsToday = (Number(s2.commentsToday) || 0) + 1
      s2.lastCommentAt = Date.now()
      if (rec.atName) { s2.atsToday = (Number(s2.atsToday) || 0) + 1; s2.lastAtAt = Date.now() }
      saveState(s2)
      log(`评论已发：${rec.text}${rec.rpid ? `（rpid=${rec.rpid}）` : ''}`)
      return { ok: true, ...rec }
    } catch (e) {
      rec.skip = `发送异常：${e?.message || e}`
      return { ok: false, ...rec }
    }
  }

  /* ─────────────── 玩一局（M2：真的开浏览器） ─────────────── */

  let playing = false

  async function runOne({ forcedToyId = '', trigger = 'manual', minutesCap = 0 } = {}) {
    if (playing) return { ok: false, message: '已经有一局在跑了，等它收工' }
    playing = true
    try {
      const c = reload()
      const history = loadHistory()
      let toy = null
      let pick = null
      if (forcedToyId) {
        const api = await loadToyApi()
        const d = await api.detail(String(forcedToyId))
        if (!d?.ok) return { ok: false, message: `查不到这个 toy：${forcedToyId}` }
        const it = d.item || d.toy || d.data || d
        toy = { id: String(it.id || forcedToyId), title: it.title || '', url: it.url || '', category: it.category || '', categoryCn: it.categoryCn || '', author: it.author || '', plays: it.plays || 0 }
      } else {
        const res = await pickToy(c, history)
        if (!res.ok) return { ok: false, reason: res.reason, skipped: res.skipped, errors: res.errors }
        toy = res.pick.toy
        pick = res.candidates
      }
      if (!toy?.url) return { ok: false, message: '这个 toy 没有直接播放链接（可能只有 slug）', toy: { id: toy?.id, title: toy?.title } }

      const run = createRun({ toy, persona: c.persona, cfg: c })
      const dir = join(homeDir(), 'runs', run.id)
      appendStep(run.id, { action: 'plan', trigger, note: `选中「${toy.title}」` })

      if (c.dryRun !== false) {
        return {
          ok: true, dryRun: true, runId: run.id, toy: { id: toy.id, title: toy.title, url: toy.url },
          status: 'planned', candidates: pick,
          note: 'dryRun=true：只规划、不打开页面；bot_config_set {dryRun:false} 之后才会真的玩',
          where: dir,
        }
      }

      let minutes = Math.max(1, Math.min(Number(c.maxMinutesPerToy) || 20, 60))
      if (minutesCap > 0) minutes = Math.min(minutes, minutesCap)
      updateRun(run.id, { status: 'playing', startedAt: Date.now(), trigger, limitMinutes: minutes })
      log(`开工：${toy.title}（最多 ${minutes} 分钟，trigger=${trigger}）`)

      // —— 只在开局报一句、玩完再评价；过程中不刷屏（用户要求）——
      const live = { actions: 0, last: '', steps: 0 }
      try {
        const line = renderLine('progressTemplate', {
          title: toy.title, minutes, actions: 0, elapsed: '刚开局',
        }, `开始了：玩「${toy.title}」，最多 ${minutes} 分钟`)
        broadcaster.say(line, 'progress')
      } catch { /* 播报失败不影响玩 */ }

      const res = await playToy({
        toy,
        cfg: { ...c, maxMinutesPerToy: minutes },
        runId: dir,
        onStep: (s) => {
          live.steps += 1
          if (s?.action === 'click' || s?.action === 'key' || s?.action === 'click-start' || s?.action === 'click-center') live.actions += 1
          live.last = s?.action || ''
          appendStep(run.id, s)
        },
      })
      const realMinutes = Math.max(0, Math.min(Number(res.minutes) || 0, 60))
      const patch = {
        status: res.ok ? 'done' : 'failed',
        endedAt: Date.now(),
        minutes: realMinutes,
        actions: res.actions || 0,
        shots: res.shots || 0,
        stopReason: res.stopReason || '',
        pageTitle: res.title || toy.title,
        pageText: (res.text || '').slice(0, 300),
        error: res.ok ? '' : String(res.message || ''),
      }
      updateRun(run.id, patch)

      const st = loadState()
      st.runsToday = (st.runsToday || 0) + 1
      st.minutesToday = (st.minutesToday || 0) + Math.round(realMinutes)
      st.lastRunAt = Date.now()
      saveState(st)

      const hist = loadHistory()
      const prevCount = hist.toys?.[String(toy.id)]?.count || 0
      hist.toys = hist.toys || {}
      hist.toys[String(toy.id)] = { count: prevCount + 1, lastAt: Date.now(), title: toy.title }
      saveHistory(hist)

      const meta = readRun(run.id) || { ...patch, toy }
      try { writeDiary(run.id, renderDiary(meta, meta.steps || [])) } catch { /* 忽略 */ }
      try {
        const key = todayKey()
        const prev = readDailyDigest(key)
        const line = `- ${new Date().toLocaleTimeString('zh-CN')} 玩了「${toy.title}」${realMinutes} 分钟（${res.shots || 0} 张截图）${res.ok ? '' : '，没玩成：' + (res.message || '')}`
        writeDailyDigest(prev ? `${prev}\n${line}` : `# ${key} 玩 toy 日报\n\n${line}`, key)
      } catch (e) { log(`日报写入失败：${e?.message || e}`) }
      log(`收工：${toy.title} ${realMinutes} 分钟，${res.shots || 0} 张图，${res.ok ? '正常' : '出错：' + res.message}`)

      // M3：给这一局出评论草稿（默认只生成不发）
      let comment = null
      try {
        const cr = await commentForRun({ runId: run.id, toy, minutes: realMinutes, actions: patch.actions })
        if (cr?.ok) { comment = cr; updateRun(run.id, { comment: cr }) }
      } catch (e) { log(`出评论草稿失败：${e?.message || e}`) }

      // M4：播报一句（用设置页里自己写的模板，没写就用内置的）
      if (c.announcePerRun !== false) {
        try {
          const commentNote = comment?.sent ? '，还留了条评论' : comment?.text ? '，评论草稿写好了' : ''
          const line = renderLine('announceTemplate', {
            title: toy.title,
            minutes: realMinutes,
            actions: patch.actions,
            comment: commentNote,
          }, `玩了「${toy.title}」${realMinutes} 分钟，动了 ${patch.actions} 下${commentNote}`)
          broadcaster.say(line, 'run')
        } catch (e) { log(`播报失败：${e?.message || e}`) }
      }

      return {
        ok: !!res.ok,
        runId: run.id,
        toy: { id: toy.id, title: toy.title, url: toy.url },
        status: patch.status,
        minutes: realMinutes,
        actions: patch.actions,
        shots: patch.shots,
        stopReason: patch.stopReason,
        pageTitle: patch.pageTitle,
        pageText: patch.pageText,
        message: res.message || '',
        comment: comment?.text || '',
        commentSent: !!comment?.sent,
        where: dir,
        shotsDir: join(dir, 'shots'),
      }
    } catch (e) {
      log(`runOne 出错：${e?.message || e}`)
      return { ok: false, message: String(e?.message || e) }
    } finally {
      playing = false
    }
  }

  /**
   * 0.4.0：一局怎么开始。
   *   playMode='session'（默认且已绑会话）→ 把整局任务写成提示词，agent.followup 发进绑定会话，
   *                                      由那个会话里的 agent 自己挑游戏/打开/操作/收工/评论；
   *   playMode='headless' 或没有绑会话      → 退回插件自己开 headless 浏览器玩（老路）。
   */
  async function dispatchPlay({ trigger = 'manual', forcedToyId = '', minutesCap = 0, minutes = 0 } = {}) {
    const c = reload()
    const mode = String(c.playMode || 'session') === 'headless' ? 'headless' : 'session'
    if (mode === 'headless' || !c.sessionId) {
      const tips = mode === 'session' ? '（还没绑定会话，先自己玩；设置页里可以绑一个）' : ''
      const r = await runOne({ forcedToyId, trigger, minutesCap })
      return { ...r, mode: 'headless', ...(tips ? { note: tips } : {}) }
    }
    if (playing) return { ok: false, mode: 'session', message: '已经有一局在跑了，等它收工' }
    playing = true
    let runId = ''
    try {
      const text = buildPlayPrompt(c, { minutes: minutes || minutesCap || c.maxMinutesPerToy, reason: trigger })
      const run = createRun({ toy: { id: String(forcedToyId || ''), title: '（由会话挑）' }, persona: c.persona, cfg: c })
      runId = run.id
      const sent = sendToSession({ ctx, sessionId: c.sessionId, text, log })
      appendStep(run.id, { action: 'handoff', trigger, via: sent.via, sessionId: c.sessionId, note: sent.ok ? '已把整局任务发给会话' : (sent.message || '') })
      updateRun(run.id, {
        status: sent.ok ? 'handoff' : 'handoff-failed',
        trigger,
        sessionId: c.sessionId,
        prompt: text,
        note: sent.message || '',
      })
      if (!sent.ok) {
        log(`交接失败：${sent.message || '未知原因'}`)
        return { ok: false, mode: 'session', runId: run.id, sessionId: c.sessionId, message: sent.message || '交接失败', prompt: text }
      }
      const st = loadState()
      st.runsToday = (st.runsToday || 0) + 1
      st.lastRunAt = Date.now()
      saveState(st)
      broadcaster.say(`今天的玩具时间交给会话了（${sent.via}）`, 'run')
      log(`已把整局任务交给会话 ${c.sessionId}（${sent.via}）`)
      return {
        ok: true,
        mode: 'session',
        via: sent.via,
        runId: run.id,
        sessionId: c.sessionId,
        prompt: text,
        note: sent.via === 'followup' ? '会话已经开工了，去那个会话里就能看到' : (sent.message || '消息已写进会话'),
      }
    } catch (e) {
      log(`交接出错：${e?.message || e}`)
      return { ok: false, mode: 'session', runId, message: String(e?.message || e) }
    } finally {
      playing = false
    }
  }

  tool({
    name: 'bot_status',
    description: '机器人现在什么状态：开关、是否在时段内、今天玩了几局、下一局什么时候。',
    parameters: {},
    async execute() {
      const c = reload()
      const s = loadState()
      const now = new Date()
      const verdict = canRunNow(now, c, s)
      const wins = parseSlots(c.slots)
      const next = verdict.nextAt ? verdict.nextAt.toISOString() : null
      return {
        ok: true,
        version: myVersion(),
        enabled: c.enabled,
        inSlot: wins.length > 0 && inAnyWindow(minuteOfDay(now), wins),
        canRun: verdict.ok,
        reason: verdict.reason,
        hint: verdict.text,
        nextRunAt: next,
        today: { runs: s.runsToday, maxRuns: c.maxRunsPerDay, minutes: s.minutesToday, maxMinutes: c.dailyTotalMinutes, comments: s.commentsToday },
        slots: describeSchedule(c),
        policy: c.policy,
        dryRun: c.dryRun,
        gapMinutes: c.minGapMinutes,
        lastRunAt: s.lastRunAt || null,
        heartbeat: {
          at: heartbeat.at,
          beats: heartbeat.beats,
          everySec: heartbeat.everySec || Math.max(2, Number(c.heartbeatSeconds) || 10),
          ageSec: heartbeat.at ? Math.max(0, Math.round((Date.now() - heartbeat.at) / 1000)) : null,
        },
        home: homeDir(),
        note: c.dryRun
          ? 'dryRun=true：到点只规划不玩；bot_config_set {dryRun:false} 才会真开 headless 浏览器'
          : '到点会真的开 headless 浏览器玩（不抢前台、不动你的鼠标键盘）',
      }
    },
  })

  tool({
    name: 'bot_config_get',
    description: '读取机器人全部配置（时段、风格、人设、评论、会话等）。',
    parameters: {},
    async execute() { return { ok: true, config: reload(), defaults: DEFAULT_CONFIG } },
  })

  tool({
    name: 'bot_config_set',
    description: '改机器人配置（只传要改的字段，深合并；数字/布尔/数组会按类型校验）。',
    parameters: { patch: { type: 'object', properties: {}, additionalProperties: true, description: '要合并的字段（对象）' } },
    async execute({ patch }) {
      const cur = loadConfig()
      const merged = { ...cur }
      for (const [k, v] of Object.entries(patch || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof cur[k] === 'object' && !Array.isArray(cur[k])) {
          merged[k] = { ...cur[k], ...v }
        } else {
          merged[k] = v
        }
      }
      const next = saveConfig(normalizeConfig(merged))
      log(`config 更新：${Object.keys(patch || {}).join(',')}`)
      return { ok: true, config: next, changed: Object.keys(patch || {}) }
    },
  })

  tool({
    name: 'bot_plan',
    description: '只挑不玩：现在会选哪个 toy、为什么、候选前十。',
    parameters: { limit: { type: 'number', description: '候选池上限，默认 200' } },
    async execute({ limit }) {
      const c = reload()
      const history = loadHistory()
      const res = await pickToy(c, history, { limit: limit || 200 })
      if (!res.ok) return { ok: false, reason: res.reason, skipped: res.skipped, errors: res.errors }
      return {
        ok: true,
        pick: { id: res.pick.toy.id, title: res.pick.toy.title, categoryCn: res.pick.toy.categoryCn, plays: res.pick.toy.plays, url: res.pick.toy.url, score: Number(res.pick.score.toFixed(2)) },
        why: res.pick.reasons,
        candidates: res.candidates,
        filteredOut: res.skipped?.slice(0, 8) || [],
      }
    },
  })

  tool({
    name: 'bot_start',
    description: '打开机器人（写进 config.json，重启后仍生效）。',
    parameters: {},
    async execute() {
      const c = loadConfig()
      c.enabled = true
      saveConfig(c)
      log('机器人已开启')
      return { ok: true, enabled: true, hint: '已开启：到点会按你的时段自己开工（dryRun=true 时只规划不打开页面）' }
    },
  })

  tool({
    name: 'bot_stop',
    description: '关掉机器人（当前局也会优雅收尾）。',
    parameters: {},
    async execute() {
      const c = loadConfig()
      c.enabled = false
      saveConfig(c)
      log('机器人已关闭')
      return { ok: true, enabled: false }
    },
  })

  tool({
    name: 'bot_play_now',
    description: '立刻玩一局（可指定 toyId）。默认把整局任务当提示词发进绑定会话，由会话自己玩；没绑会话或 playMode=headless 才由插件自己开浏览器玩。',
    parameters: { toyId: { type: 'string', description: '想指定玩的 toy 数字 id，可省略' } },
    async execute({ toyId }) {
      return dispatchPlay({ forcedToyId: toyId || '', trigger: 'manual' })
    },
  })

  tool({
    name: 'bot_runs',
    description: '最近几局（时间、标题、时长、结果）。',
    parameters: { limit: { type: 'number' } },
    async execute({ limit }) {
      const runs = listRuns(limit || 10)
      return { ok: true, count: runs.length, runs: runs.map((r) => ({ id: r.id, status: r.status, toy: r.toy?.title, minutes: r.minutes, createdAt: r.createdAt })) }
    },
  })

  tool({
    name: 'bot_run_get',
    description: '看单局详情（元信息 + 日记 + 步骤）。',
    parameters: { runId: { type: 'string' } },
    async execute({ runId }) {
      if (!runId) return { ok: false, message: '缺少 runId' }
      const run = readRun(runId)
      if (!run) return { ok: false, message: `没有这一局：${runId}` }
      return { ok: true, run }
    },
  })

  tool({
    name: 'bot_diary',
    description: '看某天的日报（不传就是今天）。',
    parameters: { date: { type: 'string', description: 'YYYY-MM-DD' } },
    async execute({ date }) {
      const key = date || todayKey()
      const text = readDailyDigest(key)
      return text ? { ok: true, date: key, text } : { ok: false, date: key, message: '这天还没有日报' }
    },
  })

  tool({
    name: 'bot_stats',
    description: '累计统计：玩了几局、总时长、评论/被回复数、日志尾巴。',
    parameters: { logLines: { type: 'number' } },
    async execute({ logLines }) {
      const runs = listRuns(200)
      const done = runs.filter((r) => r.status === 'done')
      const minutes = done.reduce((a, r) => a + (Number(r.minutes) || 0), 0)
      return {
        ok: true,
        runs: runs.length,
        done: done.length,
        minutes,
        commented: done.filter((r) => r.comment?.text).length,
        lastRunAt: runs[0]?.createdAt || 0,
        log: readLogTail(logLines || 20),
      }
    },
  })

  tool({
    name: 'bot_say',
    description: '以人设口吻说一句话（写进「动态」，broadcastMode=session 时发到绑定会话）。用法：开局报一句，**玩完再评价**（1~3 句，说说好不好玩、卡在哪）；玩的过程中不要用它刷进度。',
    parameters: { text: { type: 'string', description: '要说的话；玩完之后写一句点评最合适' } },
    async execute({ text }) {
      if (!text) return { ok: false, message: '缺少 text' }
      const c = reload()
      const line = `${c.persona.name}：${text}`
      const r = broadcaster.say(text, 'say')
      log(`say ${line} → ${r.via}`)
      return { ok: !!r.ok, persona: c.persona.name, line, via: r.via, mode: c.broadcastMode, session: c.sessionId || '（未绑定）' }
    },
  })

  tool({
    name: 'bot_comment_draft',
    description: '给某一局重新生成一条评论草稿（只生成、不发送；runId 省略取最近一局）。',
    parameters: { runId: { type: 'string' } },
    async execute({ runId }) {
      const runs = listRuns(50)
      const target = runId ? readRun(runId) : runs[0]
      if (!target) return { ok: false, message: runId ? `没有这一局：${runId}` : '还没有任何一局' }
      const c = reload()
      const draft = makeDraft({ cfg: c, toy: target.toy, run: { id: target.id, minutes: target.minutes, actions: target.actions } })
      if (!draft.ok) return { ok: false, skip: draft.skip }
      const st = loadState()
      const canAt = !!draft.atName && atQuotaOk(c, st)
      const text = (canAt ? `@${draft.atName} ${draft.text}` : draft.text).slice(0, Number(c.commentLengthMax) || 200)
      return {
        ok: true,
        runId: target.id,
        toy: target.toy?.title,
        text,
        style: draft.style,
        styleLabel: draft.styleLabel,
        at: canAt ? draft.atName : '',
        willSend: c.commentEnabled === true && c.dryRun === false && commentQuotaOk(c, st),
        note: c.commentEnabled !== true ? '评论开关没开（commentEnabled=false），只生成不发送' : 'dryRun=false 时会真的发',
      }
    },
  })

  tool({
    name: 'bot_comment_send',
    description: '把某局的评论草稿真的发出去（也可直接给 text）。会扣当天的评论/@ 配额。',
    parameters: { runId: { type: 'string' }, text: { type: 'string' } },
    async execute({ runId, text }) {
      const runs = listRuns(50)
      const target = runId ? readRun(runId) : runs[0]
      if (!target) return { ok: false, message: '找不到要评论的那一局' }
      const c = reload()
      let finalText = String(text || '').trim()
      let atName = ''
      let atUid = ''
      if (!finalText) {
        const draft = makeDraft({ cfg: c, toy: target.toy, run: { id: target.id, minutes: target.minutes, actions: target.actions } })
        if (!draft.ok) return { ok: false, skip: draft.skip }
        const st = loadState()
        const canAt = !!draft.atName && atQuotaOk(c, st)
        finalText = (canAt ? `@${draft.atName} ${draft.text}` : draft.text)
        atName = canAt ? draft.atName : ''
        atUid = canAt ? draft.atUid : ''
      }
      try {
        const api = await loadToyApi()
        const res = await api.postComment({ toyId: target.toy?.id, text: finalText, atName: atName || undefined, atUid: atUid || undefined })
        if (!res?.ok) return { ok: false, message: res?.message || '发送失败', text: finalText }
        const st = loadState()
        st.commentsToday = (Number(st.commentsToday) || 0) + 1
        st.lastCommentAt = Date.now()
        if (atName) { st.atsToday = (Number(st.atsToday) || 0) + 1; st.lastAtAt = Date.now() }
        saveState(st)
        const rec = { text: finalText, atName, atUid, at: Date.now(), sent: true, rpid: String(res.rpid || ''), style: target.comment?.style || 'manual' }
        updateRun(target.id, { comment: rec })
        log(`手动评论已发：${finalText}`)
        return { ok: true, runId: target.id, rpid: rec.rpid, text: finalText, at: atName }
      } catch (e) {
        return { ok: false, message: String(e?.message || e) }
      }
    },
  })

  tool({
    name: 'bot_comment_list',
    description: '看最近生成的评论（发了的和没发的都列出来）。',
    parameters: { limit: { type: 'number' } },
    async execute({ limit }) {
      const runs = listRuns(200).filter((r) => r.comment?.text)
      return { ok: true, count: runs.length, items: runs.slice(0, limit || 10).map((r) => ({ runId: r.id, toy: r.toy?.title, text: r.comment.text, sent: !!r.comment.sent, rpid: r.comment.rpid || '', at: r.comment.at })) }
    },
  })

  tool({
    name: 'bot_feed',
    description: '看最近几条播报（开工/收工/说话）。',
    parameters: { limit: { type: 'number' } },
    async execute({ limit }) { return { ok: true, items: readFeed(homeDir(), limit || 20) } },
  })

  tool({
    name: 'bot_sessions',
    description: '列出当前在线的 DSH 会话（设置页「绑定会话」展开用的同一份数据），带最近一句预览与是否已绑定。',
    parameters: {},
    async execute() {
      const list = broadcaster.listSessions()
      return { ok: !!list.ok, why: list.why || '', bound: list.bound || '', count: (list.items || []).length, items: list.items || [] }
    },
  })

  tool({
    name: 'bot_session_bind',
    description: '绑定/解除机器人会话；绑定时会往那个会话发一条“我上线了”，让它在会话里立刻出现。传 create=true 则新建一个会话再绑定。',
    parameters: {
      sessionId: { type: 'string', description: '会话 id；留空 = 解除绑定' },
      create: { type: 'boolean', description: 'true = 不用 sessionId，新建一个会话并绑定' },
      text: { type: 'string', description: '激活时发到会话里的第一句话（可选）' },
    },
    async execute({ sessionId, create, text }) {
      if (create) {
        const made = broadcaster.createSession({ title: String(text || '') })
        if (!made.ok) return { ok: false, message: made.why }
        const c = loadConfig(); c.sessionId = made.id; c.broadcastMode = 'session'; saveConfig(c)
        const act = broadcaster.activate(made.id, String(text || ''))
        log(`新建并绑定会话：${made.id}`)
        return { ok: true, sessionId: made.id, activated: act.ok, why: act.why || '', broadcastMode: c.broadcastMode }
      }
      const c = loadConfig()
      c.sessionId = String(sessionId || '')
      if (c.sessionId) c.broadcastMode = 'session'
      else if (c.broadcastMode === 'session') c.broadcastMode = 'feed'
      saveConfig(c)
      const act = c.sessionId ? broadcaster.activate(c.sessionId, String(text || '')) : { ok: true }
      log(c.sessionId ? `绑定会话：${c.sessionId}` : '解除会话绑定')
      return { ok: true, bound: c.sessionId, sessionId: c.sessionId, activated: !!act.ok, why: act.why || '', broadcastMode: c.broadcastMode }
    },
  })

  tool({
    name: 'bot_session_activate',
    description: '给已绑定的会话发一句话（确认它还在线、也让会话里能看到机器人）',
    parameters: { text: { type: 'string' } },
    async execute({ text }) {
      const c = loadConfig()
      if (!c.sessionId) return { ok: false, message: '还没绑定会话（先 bot_session_bind 或用设置页展开选择）' }
      const r = broadcaster.sendTo(c.sessionId, `${c.persona?.name || '小鲸鱼'}：${text || '我在。'}`)
      return { ok: r.ok, why: r.why || '', sessionId: c.sessionId }
    },
  })

  tool({
    name: 'bot_voice',
    description: '看/改人设与说话风格（都是自由文本）：persona 里放 name/species/temperament/catchphrases/bio，voice 里放 styleText/catchphrase/commentTemplate/announceTemplate。注意：中途进度播报已取消，只保留开局一句和玩完的点评。',
    parameters: {
      persona: { type: 'object', properties: {}, additionalProperties: true, description: '人设字段（可只传要改的）' },
      voice: { type: 'object', properties: {}, additionalProperties: true, description: '说话风格字段（可只传要改的）' },
      styles: { type: 'array', items: { type: 'string' }, description: '选片口味（自由文本数组，例如 ["休闲","沙雕"]）' },
    },
    async execute({ persona, voice: v, styles }) {
      const c = loadConfig()
      const patch = {}
      if (persona && typeof persona === 'object') patch.persona = { ...c.persona, ...persona }
      if (v && typeof v === 'object') patch.voice = { ...c.voice, ...v }
      if (Array.isArray(styles)) patch.styles = styles.filter(Boolean).map(String)
      saveConfig({ ...c, ...patch })
      const next = loadConfig()
      log(`人设 / 说话风格更新：${Object.keys(patch).join(',')}`)
      return { ok: true, persona: next.persona, voice: next.voice, styles: next.styles, modelReady: voice.available() }
    },
  })

  /* ─────────────── 定时巡检（M2：到点就真的开工） ─────────────── */

  ctx.effect(() => {
    const beat = () => {
      try {
        const c = loadConfig()
        const s = loadState()
        // 心跳：记一笔「我还活着、上次看表是什么时候」，设置页据此显示"心跳 x 秒前"
        heartbeat.at = Date.now()
        heartbeat.beats += 1
        heartbeat.everySec = Math.max(2, Number(c.heartbeatSeconds) || 10)
        const verdict = canRunNow(new Date(), c, s)
        if (verdict.ok) {
          if (lastOk !== 'ok') { lastOk = 'ok'; log(`到点了：可以开工（${describeSchedule(c)}）`) }
          if (!playing) {
            // 0.4.0：默认交给绑定会话玩（会话里能看见）；没绑会话或 playMode=headless 才是插件自己开浏览器
            dispatchPlay({ trigger: 'schedule', minutesCap: minutesLeftInWindow(new Date(), parseSlots(c.slots)) })
              .catch((e) => log(`定时开工失败：${e?.message || e}`))
          }
        } else if (lastOk !== verdict.reason) {
          lastOk = verdict.reason
          log(`暂不开工：${verdict.text}`)
        }
      } catch (e) { log(`tick 出错：${e?.message || e}`) }
    }
    const tick = beat
    // 心跳间隔可配（默认 10 秒），保存后最多 30 秒内换新的间隔
    let cur = Math.max(2, Number(loadConfig().heartbeatSeconds) || 10)
    let id = setInterval(tick, cur * 1000)
    const timer = setInterval(() => {
      const want = Math.max(2, Number(loadConfig().heartbeatSeconds) || 10)
      if (want !== cur) {
        clearInterval(id)
        cur = want
        id = setInterval(tick, want * 1000)
      }
    }, 30_000)
    tick()
    return () => { clearInterval(id); clearInterval(timer) }
  }, 'bili-toy-bot scheduler')

  /* ─────────────── HTTP 路由（给设置页用） ─────────────── */

  const json = (res, code, body) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch { /* 连接已断 */ }
  }

  const readBody = (req) => new Promise((resolve) => {
    let buf = ''
    req.on('data', (d) => { buf += d; if (buf.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/bili-toy-bot',
    handler: async (req, res) => {
      // ⚠️ 不要用第三个参数 url：不同宿主版本传进来的可能是剥掉前缀的路径或压根不是 URL 对象。
      // 统一从 req.url 自己解析，并把前缀剥掉，得到 '/status' 这种后缀再比。
      let full = ''
      try { full = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch { full = '' }
      const prefix = '/api/bili-toy-bot'
      const path = full.startsWith(prefix) ? (full.slice(prefix.length) || '/') : full
      const method = (req.method || 'GET').toUpperCase()
      try {
        if (path === '/status') {
          const c = reload()
          const s = loadState()
          const v = canRunNow(new Date(), c, s)
          let sessionInfo = { id: c.sessionId || '', online: false, preview: '' }
          try {
            const list = broadcaster.listSessions()
            const hit = list.ok ? list.items.find((x) => x.id === String(c.sessionId || '')) : null
            if (hit) sessionInfo = { id: hit.id, online: true, preview: hit.preview, events: hit.events, createdAt: hit.createdAt }
          } catch { /* 忽略 */ }
          return json(res, 200, {
            ok: true,
            version: myVersion(),
            enabled: c.enabled,
            dryRun: c.dryRun,
            commentEnabled: c.commentEnabled,
            slots: describeSchedule(c),
            broadcastMode: c.broadcastMode,
            playMode: String(c.playMode || 'session'),
            sessionId: c.sessionId,
            session: sessionInfo,
            voice: voice.describe(),
            progressEverySec: c.progressEverySec,
            canRun: v.ok,
            hint: v.text,
            playing,
            state: s,
            config: c,
            heartbeat: {
              at: heartbeat.at,
              beats: heartbeat.beats,
              everySec: heartbeat.everySec || Math.max(2, Number(c.heartbeatSeconds) || 10),
              ageSec: heartbeat.at ? Math.max(0, Math.round((Date.now() - heartbeat.at) / 1000)) : null,
            },
          })
        }
        if (path === '/sessions') {
          const list = broadcaster.listSessions()
          return json(res, 200, { ok: !!list.ok, why: list.why || '', bound: list.bound || '', items: list.items || [] })
        }
        if (path === '/session/bind' && method === 'POST') {
          const body = await readBody(req)
          const id = String(body.sessionId || '').trim()
          if (!id) return json(res, 400, { ok: false, message: '缺少 sessionId' })
          const c = loadConfig()
          c.sessionId = id
          if (body.broadcastMode !== false) c.broadcastMode = 'session'
          saveConfig(c)
          const act = broadcaster.activate(id, String(body.text || ''))
          log(`绑定会话：${id}（激活${act.ok ? '成功' : '失败：' + act.why}）`)
          return json(res, 200, { ok: true, bound: id, sessionId: id, activated: act.ok, why: act.why || '', broadcastMode: c.broadcastMode })
        }
        if (path === '/session/create' && method === 'POST') {
          const body = await readBody(req)
          const made = broadcaster.createSession({ title: String(body.title || '') })
          if (!made.ok) return json(res, 200, { ok: false, message: made.why })
          const c = loadConfig()
          c.sessionId = made.id
          c.broadcastMode = 'session'
          saveConfig(c)
          const act = broadcaster.activate(made.id, String(body.text || ''))
          log(`新建并绑定会话：${made.id}`)
          return json(res, 200, { ok: true, sessionId: made.id, activated: act.ok, why: act.why || '' })
        }
        if (path === '/session/unbind' && method === 'POST') {
          const c = loadConfig()
          c.sessionId = ''
          c.broadcastMode = 'feed'
          saveConfig(c)
          log('已解除会话绑定')
          return json(res, 200, { ok: true, sessionId: '' })
        }
        if (path === '/session/test' && method === 'POST') {
          const c = loadConfig()
          if (!c.sessionId) return json(res, 200, { ok: false, message: '还没绑定会话' })
          const body = await readBody(req)
          const line = String(body.text || '我在，进度会实时发在这里。')
          const r = broadcaster.sendTo(c.sessionId, `${c.persona?.name || '小鲸鱼'}：${line}`)
          return json(res, 200, { ok: r.ok, why: r.why || '', text: line })
        }
        if (path === '/voice/comment' && method === 'POST') {
          const body = await readBody(req)
          const c = loadConfig()
          const toy = { title: String(body.title || '这个 toy'), author: String(body.author || ''), id: String(body.toyId || 'preview') }
          const minutes = Math.max(1, Number(body.minutes) || 3)
          const ai = await voice.draftComment({ cfg: c, toy, minutes, actions: Number(body.actions) || 0 }).catch(() => null)
          const d = ai?.ok ? { ok: true, text: ai.text, style: 'custom', styleLabel: 'AI 现写' } : makeDraft({ cfg: c, toy, run: { id: 'preview', minutes, actions: 0 } })
          return json(res, 200, {
            ok: !!d.ok,
            via: ai?.ok ? 'model' : 'template',
            modelReady: voice.available(),
            styleText: String(c.voice?.styleText || ''),
            text: d.text || '',
            styleLabel: d.styleLabel || '',
            skip: d.skip || '',
            note: ai?.ok ? '按你写的人设和说话风格现写的' : (String(c.voice?.styleText || '').trim() ? `模型没写成（${ai?.message || '未知'}），用模板顶` : '还没填「说话风格」，用的是模板'),
          })
        }
        if (path === '/progress') {
          const items = readFeed(homeDir(), 60).filter((x) => x.kind === 'progress' || x.kind === 'run')
          return json(res, 200, { ok: true, items: items.slice(0, 30), via: loadConfig().broadcastMode })
        }
        if (path === '/config' && method === 'GET') {
          return json(res, 200, { ok: true, config: reload() })
        }
        if (path === '/config' && method === 'POST') {
          const body = await readBody(req)
          const next = saveConfig(normalizeConfig(mergePatch(loadConfig(), body.patch || body || {})))
          log(`设置页改了配置：${Object.keys(body.patch || body || {}).join(',')}`)
          return json(res, 200, { ok: true, config: next })
        }
        if (path === '/start' && method === 'POST') {
          const c = loadConfig(); c.enabled = true; saveConfig(c)
          log('机器人已开启（设置页）')
          return json(res, 200, { ok: true, enabled: true })
        }
        if (path === '/stop' && method === 'POST') {
          const c = loadConfig(); c.enabled = false; saveConfig(c)
          log('机器人已关闭（设置页）')
          return json(res, 200, { ok: true, enabled: false })
        }
        if (path === '/play' && method === 'POST') {
          if (playing) return json(res, 200, { ok: false, message: '已经有一局在跑了' })
          const body = await readBody(req)
          const c = loadConfig()
          // ⚠️ 这里**不许**写回 maxMinutesPerToy：面板点「玩一局」只是这一次的临时上限。
          // 0.4.4 之前误把 body.minutes 存进配置，默认 2 → 用户改好的单局时长总被改回 2 分钟。
          const oneShotCap = Number(body.minutes) > 0 ? Math.min(60, Number(body.minutes)) : 0
          // 0.4.0：默认把整局任务发进绑定会话，并**立刻**把结果回给面板（不再让按钮看起来没反应）
          const r = await dispatchPlay({ forcedToyId: body.toyId || '', trigger: 'panel', minutesCap: oneShotCap })
          log(`设置页「玩一局」：${r?.ok ? '已交接' : '失败'}（${r?.mode || '?'}${r?.via ? '/' + r.via : ''}）${r?.toy?.title || ''}${oneShotCap ? `，本次上限 ${oneShotCap} 分钟` : ''}`)
          return json(res, 200, {
            ok: !!r?.ok,
            mode: r?.mode || '',
            via: r?.via || '',
            sessionId: r?.sessionId || '',
            runId: r?.runId || '',
            started: !!r?.ok,
            message: r?.message || r?.note || '',
            prompt: r?.prompt || '',
            dryRun: c.dryRun !== false,
          })
        }
        if (path === '/plan') {
          const c = reload()
          const r2 = await pickToy(c, loadHistory())
          return json(res, 200, r2.ok ? { ok: true, pick: r2.pick.toy, why: r2.pick.reasons, candidates: r2.candidates } : { ok: false, reason: r2.reason })
        }
        if (path === '/runs') {
          const runs = listRuns(20).map((r) => ({ id: r.id, status: r.status, toy: r.toy?.title, minutes: r.minutes, shotCount: r.shots, createdAt: r.createdAt, comment: r.comment?.text || '' }))
          return json(res, 200, { ok: true, runs })
        }
        if (path === '/feed') {
          return json(res, 200, { ok: true, items: readFeed(homeDir(), 30) })
        }
        if (path === '/comments') {
          const runs = listRuns(200).filter((r) => r.comment?.text)
          return json(res, 200, { ok: true, items: runs.slice(0, 20).map((r) => ({ runId: r.id, toy: r.toy?.title, text: r.comment.text, sent: !!r.comment.sent, at: r.comment.at })) })
        }
        return json(res, 404, { ok: false, message: 'not found' })
      } catch (e) {
        return json(res, 500, { ok: false, message: String(e?.message || e) })
      }
    },
  }), 'bili-toy-bot routes')

  log(`注册完成：${toolCount} 个工具 + /api/bili-toy-bot`)
}
