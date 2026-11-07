/**
 * 评论草稿（M3）
 * ============================================================================
 * 只负责「说什么」：按风格模板生成一条短评，可选 @ 作者。
 * 发不发由 index.js 决定（dryRun / commentEnabled / 每日上限 / @ 上限）。
 * ============================================================================
 */

/** 每种风格的几个句子；{title} {minutes} {author} {n} 会被替换 */
export const STYLE_TEMPLATES = {
  cute: [
    '《{title}》也太可爱了吧，一玩就是 {minutes} 分钟 🐳',
    '在《{title}》里玩得不想走，谁懂啊',
    '哦呼，《{title}》真好玩，下次还来',
  ],
  sincere: [
    '认真玩了 {minutes} 分钟《{title}》，节奏挺舒服的',
    '《{title}》做得挺用心，{minutes} 分钟没觉得腻',
    '第一次玩《{title}》，比我预想的有意思',
  ],
  funny: [
    '《{title}》玩到第 {minutes} 分钟，我已经不知道自己是谁了',
    '手残如我也能把《{title}》玩 {minutes} 分钟，说明它真的简单易懂',
    '救命，《{title}》太上头了',
  ],
  quiet: [
    '打卡《{title}》，{minutes} 分钟',
    '安静地玩了一会儿《{title}》',
    '《{title}》，{minutes} 分钟，不错',
  ],
}

export const STYLE_LABEL = {
  cute: '可爱卖萌',
  sincere: '真诚夸',
  funny: '吐槽玩笑',
  quiet: '安静打卡',
  custom: '自己写的',
}

/** 把 {title} {minutes} {n} {author} {catchphrase} 换成实际值 */
export function fillTemplate(tpl, vars = {}) {
  return String(tpl || '')
    .replace(/\{title\}/g, vars.title ?? '')
    .replace(/\{minutes\}/g, vars.minutes == null ? '' : String(vars.minutes))
    .replace(/\{n\}/g, vars.n == null ? '' : String(vars.n))
    .replace(/\{author\}/g, vars.author ?? '')
    .replace(/\{catchphrase\}/g, vars.catchphrase ?? '')
    .replace(/\{actions\}/g, vars.actions == null ? '' : String(vars.actions))
    .replace(/\{elapsed\}/g, vars.elapsed == null ? '' : String(vars.elapsed))
    .replace(/\{owner\}/g, vars.owner ?? '')
    .replace(/\{comment\}/g, vars.comment ?? '')
}

/** 人设里的一条口头禅（随机） */
export function pickCatchphrase(cfg) {
  const own = String(cfg?.voice?.catchphrase || '').trim()
  if (own) return own
  const list = Array.isArray(cfg?.persona?.catchphrases) ? cfg.persona.catchphrases.filter(Boolean) : []
  if (!list.length) return ''
  return list[Math.floor(Math.random() * list.length)]
}

export const POLICY_STYLE_HINT = {
  L0: ['quiet'],
  L1: ['sincere', 'quiet'],
  L2: ['cute', 'sincere', 'quiet'],
  L3: ['cute', 'funny', 'sincere', 'quiet'],
}

/** 稳定的整数散列，保证同一局生成同一句（可复现、可测试） */
export function hash32(text) {
  let h = 2166136261
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function clip(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * 从「可以 @ 的人」名单里挑一个（默认第一条，也就是主人）。
 * @returns {{ name: string, uid: string } | null}
 */
export function pickAtTarget(cfg) {
  const c = cfg || {}
  if (c.atEnabled !== true) return null
  if (!(Number(c.atMaxPerDay) > 0)) return null
  const list = (Array.isArray(c.atTargets) ? c.atTargets : [])
    .map((t) => ({ name: String(t?.name || '').trim(), uid: String(t?.uid || '').trim() }))
    .filter((t) => t.name || t.uid)
  if (!list.length) return null
  return list[0]
}

/**
 * 生成一条评论草稿（不发送）。
 * @returns {{ ok: boolean, text?: string, style?: string, styleLabel?: string, atName?: string, atUid?: string, message?: string, skip?: string }}
 */
export function makeDraft({ cfg, toy, run }) {
  const c = cfg || {}
  if (!toy || !toy.title) return { ok: false, skip: '没有 toy 信息' }
  const minutes = Math.max(1, Math.round(Number(run?.minutes) || 1))
  const vars = {
    title: toy.title,
    minutes,
    n: run?.actions || 0,
    author: toy.author || '',
    catchphrase: pickCatchphrase(c),
  }

  const target = pickAtTarget(c)
  const atName = target ? target.name : ''
  const atUid = target ? target.uid : ''

  // ① 自己写的评论模板优先（设置页「说话风格 → 评论模板」）
  const custom = String(c.voice?.commentTemplate || '').trim()
  if (custom) {
    const text = clip(fillTemplate(custom, vars), 90)
    if (text) return { ok: true, text, style: 'custom', styleLabel: STYLE_LABEL.custom, atName, atUid }
  }

  // ② 内置风格句子（0.4.0 起默认没有内置风格；只有用户自己显式配了 commentStyles 才用）
  const styles = (Array.isArray(c.commentStyles) ? c.commentStyles : []).filter((s) => STYLE_TEMPLATES[s])
  if (!styles.length) {
    // 没有风格：用最朴素的一句（不带预设人设的卖萌/吐槽腔）
    const plain = clip(`${toy.title}，玩了 ${minutes} 分钟`, 90)
    return { ok: true, text: plain, style: 'plain', styleLabel: '', atName, atUid }
  }

  const seed = hash32(`${run?.id || ''}|${toy.id}|${toy.title}`)
  const style = styles[seed % styles.length]
  const list = STYLE_TEMPLATES[style]
  const template = list[(seed >>> 7) % list.length]

  let text = fillTemplate(template, vars)

  return {
    ok: true,
    text: clip(text, 90),
    style,
    styleLabel: STYLE_LABEL[style] || style,
    atName,
    atUid,
  }
}

/** 今天还能不能 @（0 = 不 @） */
export function atQuotaOk(cfg, state) {
  const max = Number(cfg?.atMaxPerDay)
  if (!Number.isFinite(max) || max <= 0) return false
  return (Number(state?.atsToday) || 0) < max
}

/** 今天还能不能评论 */
export function commentQuotaOk(cfg, state) {
  const max = Number(cfg?.commentMaxPerDay)
  const cap = Number.isFinite(max) && max >= 0 ? max : 5
  return (Number(state?.commentsToday) || 0) < cap
}
