/**
 * lib/handoff.mjs —— 「把玩一局」交接给会话（0.4.0）
 * ============================================================================
 * 以前是插件自己在后台开 headless 浏览器玩，会话里什么都看不见 → 点「玩一局」像没反应。
 * 现在默认把「整局任务」写成一段提示词，用 agent.followup() 发进绑定会话，
 * 由那个会话里的 agent 自己调 toy_* / coach_* 工具完成：挑游戏 → 打开 → 操作 → 收工 → 评论。
 *
 * 宿主 API（已读源码确认）：
 *   dsh-agent-loop/lib/index.js  agent.followup(message) = inbox.splice('next-turn', …) + wakeDriver()
 *   dsh-api-session-controller  const message = createUserMessage({content, source}); agent.followup(message)
 * 注意：只 session.append('user/message') 不会触发一轮对话，必须 followup。
 * ============================================================================
 */

/** 默认提示词模板：占位符 {} 会按配置替换 */
export const DEFAULT_PLAY_PROMPT = `现在轮到「{name}」玩 toy 了（今天的时段：{slots}）。请你亲自完成整局，中途不用问我。

1) 挑一个：先 toy_square（tab 可选 recommend/weekly/game/test）或 toy_search 找；偏好分类 {categories}，口味偏 {styles}，播放量 {minPlays}~{maxPlays}，同一个 toy 今天别超过 3 次。
2) 看看它：toy_detail{toyId}（拿标题、作者、评论数）。
3) 打开：toy_open{toyId}，会在默认浏览器新开一页。
4) 操作：coach_windows 找到浏览器窗口 → coach_anchor{action:"window", title:"..."} 锚定 → coach_now / coach_snapshot{ocr:true} 看画面 → coach_click_text 或 coach_click{x,y} 或 coach_key 操作。看不懂就点画面中间、按空格继续，别点「设置/充值/分享/下载/登录」。
5) 时长：最多 {minutes} 分钟。**玩的过程中不要说话**（不播报进度、不刷屏），专心把这一局玩完。
6) 收工：**玩完之后再评价** —— 用 bot_say 说一段 1~3 句的点评（玩了什么、玩起来怎么样、卡在哪、值不值得推荐），像人一样说，别用客服腔。需要查历史再调 bot_feed / bot_diary。
7) 评论：{commentRule}
8) 约束：遇到登录/实名/扫码/付费弹窗就换一个；别同时开一堆标签；玩完把标签关掉。`

/** 把 {xxx} 换成 vars 里的值；没给的留着原样 */
export function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars[key]
    return v === undefined || v === null ? m : String(v)
  })
}

/** 拼出这一局要发给会话的提示词 */
export function buildPlayPrompt(cfg, { minutes = 0, reason = 'manual' } = {}) {
  const c = cfg || {}
  const p = c.persona || {}
  const sent = c.commentEnabled === true && c.dryRun === false
  const atTargets = (Array.isArray(c.atTargets) ? c.atTargets : [])
    .map((t) => ({ name: String(t?.name || '').trim(), uid: String(t?.uid || '').trim() }))
    .filter((t) => t.name || t.uid)
  const atHint = c.atEnabled === true && Number(c.atMaxPerDay) > 0 && atTargets.length
    ? `要不要 @ 人：只许 @「可以 @ 的人」名单里的（${atTargets.map((t) => `${t.name}${t.uid ? `(${t.uid})` : ''}`).join('、')}；第一个是主人），toy_comment 的 atName/atUid 填名单里的名字和 mid，一次只 @ 一个，每天最多 ${c.atMaxPerDay} 次，**名单外的人一律不许 @**`
    : '不要 @ 任何人'
  const commentRule = sent
    ? `真的发一条评论：toy_comment{toyId, text}，≤${c.commentLengthMax || 60} 字，语气按人设（${p.temperament || '自然一点'}）；${atHint}。`
    : `评论只写草稿、别真的发出去（dryRun=true 或评论没开）：把它并进收工那次 bot_say 的评价里，别单独再刷一条（≤${c.commentLengthMax || 60} 字）；也不要 @ 任何人。`

  const vars = {
    name: p.name || '小鲸鱼',
    minutes: Math.max(1, Math.min(60, Number(minutes) || Number(c.maxMinutesPerToy) || 20)),
    slots: String(c.slots || ''),
    maxRuns: c.maxRunsPerDay ?? 1,
    styles: Array.isArray(c.styles) && c.styles.length ? c.styles.join('、') : '不限',
    categories: Array.isArray(c.preferCategories) && c.preferCategories.length ? c.preferCategories.join('、') : 'GAME',
    minPlays: c.minPlays ?? 0,
    maxPlays: c.maxPlays ?? 5000000,
    commentRule,
    reason,
  }
  const tpl = String(c.playPrompt || '').trim() || DEFAULT_PLAY_PROMPT
  return renderTemplate(tpl, vars)
}

function newMessageId() {
  return `bili-toy-bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function textMessage(text) {
  return {
    id: newMessageId(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: String(text || '') }],
  }
}

function pickService(ctx, ...names) {
  for (const name of names) {
    try {
      const svc = ctx?.get?.(name)
      if (svc) return svc
    } catch { /* 继续找 */ }
    try {
      const svc = ctx?.[name]
      if (svc) return svc
    } catch { /* 继续找 */ }
  }
  return null
}

/**
 * 把一段提示词发进会话，并尝试唤醒它跑一轮。
 * @returns {{ok:boolean, via:string, sessionId:string, message?:string}}
 */
export function sendToSession({ ctx, sessionId, text, log = () => {} }) {
  const id = String(sessionId || '')
  if (!id) return { ok: false, via: 'none', sessionId: '', message: '还没绑定会话' }
  const body = String(text || '').trim()
  if (!body) return { ok: false, via: 'none', sessionId: id, message: '提示词是空的' }

  // ① 优先：活着的 agent → followup（会真的开始跑一轮）
  const agents = pickService(ctx, 'agents')
  let agent = null
  try { agent = agents?.get?.(id) || null } catch (e) { log(`取 agent 失败：${e?.message || e}`) }
  if (agent && typeof agent.followup === 'function') {
    try {
      agent.followup(textMessage(body))
      return { ok: true, via: 'followup', sessionId: id }
    } catch (e) {
      log(`followup 失败：${e?.message || e}，改用追加消息`)
    }
  }

  // ② 兜底：会话在（但 agent 已经 idle/没挂载）→ 追加一条用户消息，等它下一轮会读到
  const sessions = pickService(ctx, 'sessions')
  let session = null
  try { session = sessions?.get?.(id) || null } catch { session = null }
  if (session && typeof session.append === 'function') {
    try {
      // 和 broadcast 一样：user/message 必须带 surfaceOp: 'append' 才收
      session.append('user/message', { message: textMessage(body), intent: { surfaceOp: 'append' } })
      return { ok: true, via: 'append', sessionId: id, message: '会话不在运行状态，消息已写进会话（下一轮它会看到）' }
    } catch (e) {
      return { ok: false, via: 'append', sessionId: id, message: String(e?.message || e) }
    }
  }

  return { ok: false, via: 'none', sessionId: id, message: `会话不在线：${id}` }
}
