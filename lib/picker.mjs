/**
 * lib/picker.mjs —— 今天玩哪个
 * ============================================================================
 * 候选来自 Toy 广场的分类列表（读接口免登录），打分后取前 10 个按 softmax 抽一个：
 *   score = 风格匹配 + hotness·log10(播放) + novelty·没玩过 - 惩罚
 * 这样既不会天天开同一个，也不是纯随机。
 * ============================================================================
 */
import { loadToyApi } from './toyapi.mjs'
import { STYLE_KEYWORDS } from './state.mjs'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function styleScore(toy, cfg) {
  const text = `${toy.title || ''} ${toy.categoryCn || ''} ${toy.category || ''}`
  let hit = 0
  const matched = []
  const weights = cfg.styleWeights && typeof cfg.styleWeights === 'object' ? cfg.styleWeights : {}
  for (const style of cfg.styles || []) {
    const kws = STYLE_KEYWORDS[style] || [style]
    if (kws.some((k) => text.includes(k))) {
      const w = Number(weights[style])
      hit += Number.isFinite(w) ? w : 1
      matched.push(style)
    }
  }
  return { score: Math.min(3, hit), matched }
}

function hotnessScore(toy, cfg) {
  const plays = Number(toy.plays) || 0
  const norm = clamp(Math.log10(Math.max(10, plays)) / 7, 0, 1) // 10^7 封顶
  return norm * (Number(cfg.hotness) || 0) * 3
}

function penalty(toy, cfg, history) {
  let p = 0
  const text = `${toy.title || ''}`
  for (const kw of cfg.blacklistKeywords || []) {
    if (kw && text.includes(String(kw))) p += 100
  }
  const authors = (cfg.blacklistAuthors || []).map(String)
  if (authors.includes(String(toy.authorMid))) p += 100
  const deny = (cfg.denySlugs || []).map(String)
  if (toy.slug && deny.includes(String(toy.slug))) p += 100
  const played = history.toys?.[String(toy.id)]?.count || 0
  if (played >= (Number(cfg.maxPlaysPerToy) || 3)) p += 100
  return p
}

export function scoreToy(toy, cfg, history) {
  const style = styleScore(toy, cfg)
  const hot = hotnessScore(toy, cfg)
  const played = history.toys?.[String(toy.id)]?.count || 0
  const novel = played === 0 ? Number(cfg.novelty) || 0 : 0
  const pen = penalty(toy, cfg, history)
  return {
    score: style.score + hot + novel - pen,
    reasons: {
      style: style.matched,
      hotness: Number(hot.toFixed(2)),
      novelty: Number(novel.toFixed(2)),
      playedBefore: played,
      penalty: pen,
    },
  }
}

export function allowedByFilters(toy, cfg) {
  const plays = Number(toy.plays) || 0
  if (plays < (Number(cfg.minPlays) || 0)) return { ok: false, why: `播放太少（${plays}）` }
  if (plays > (Number(cfg.maxPlays) || 5_000_000)) return { ok: false, why: `太火（${plays} 播放）` }
  if (!toy.id) return { ok: false, why: '没有数字 id（只能是 slug 链接）' }
  const allow = (cfg.allowSlugs || []).map(String)
  if (allow.length && !allow.includes(String(toy.slug || ''))) return { ok: false, why: '不在白名单' }
  // 作者白名单：填了「只玩这些 UP 主」时，别的作者一律跳过（数字 mid 或名字都认）
  const allowAuthors = (cfg.allowAuthors || []).map(String).filter(Boolean)
  if (allowAuthors.length) {
    const hit = allowAuthors.includes(String(toy.authorMid || '')) || allowAuthors.includes(String(toy.author || ''))
    if (!hit) return { ok: false, why: '作者不在白名单' }
  }
  return { ok: true }
}

/**
 * plazaCategory / plazaRecommend 返回的 `items` 已经过 normalizeToy；
 * 只有拿到原始接口条目（带 stat / play_count / dyn_stat）时才需要再归一化一次。
 */
function asNormalized(lib, res) {
  const raw = (res && Array.isArray(res.items) && res.items.length ? res.items : lib.allItemsOf(res)) || []
  return raw
    .map((it) => (it && (it.stat || it.play_count !== undefined || it.dyn_stat) ? lib.normalizeToy(it) : it))
    .filter(Boolean)
}

/** 拉候选：按 preferCategories 各拉一页，合并去重 */
export async function fetchCandidates(cfg, api = null) {
  const lib = api || await loadToyApi()
  const cats = (cfg.preferCategories || ['GAME']).slice(0, 4)
  const byId = new Map()
  const errors = []
  for (const cat of cats) {
    try {
      const res = await lib.plazaCategory({ category: String(cat).toUpperCase(), page: 1, pageSize: 50 })
      if (res && res.ok === false) { errors.push(`${cat}: ${res.message || res.code}`); continue }
      for (const t of asNormalized(lib, res)) {
        if (t?.id && !byId.has(String(t.id))) byId.set(String(t.id), t)
      }
    } catch (e) {
      errors.push(`${cat}: ${e?.message || e}`)
    }
  }
  // 分类为空时退一步用推荐位
  if (byId.size === 0) {
    try {
      const res = await lib.plazaRecommend({ page: 1, days: 1 })
      for (const t of asNormalized(lib, res)) {
        if (t?.id && !byId.has(String(t.id))) byId.set(String(t.id), t)
      }
    } catch (e) { errors.push(`recommend: ${e?.message || e}`) }
  }
  return { toys: [...byId.values()], errors }
}

function weightedPick(list) {
  const weights = list.map((x) => Math.exp(x.score / 2))
  const total = weights.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return list[0]
  let r = Math.random() * total
  for (let i = 0; i < list.length; i++) {
    r -= weights[i]
    if (r <= 0) return list[i]
  }
  return list[list.length - 1]
}

/**
 * 挑一个。
 * @returns {{ok:boolean, pick?:object, candidates?:Array, skipped?:Array, errors?:Array, reason?:string}}
 */
export async function pickToy(cfg, history, { api = null, limit = 200 } = {}) {
  const lib = api || await loadToyApi()
  const { toys, errors } = await fetchCandidates(cfg, lib)
  if (!toys.length) return { ok: false, reason: '候选为空', errors }

  const passed = []
  const skipped = []
  for (const toy of toys.slice(0, limit)) {
    const f = allowedByFilters(toy, cfg)
    if (!f.ok) { skipped.push({ id: toy.id, title: toy.title, why: f.why }); continue }
    const s = scoreToy(toy, cfg, history)
    if (s.score <= -50) { skipped.push({ id: toy.id, title: toy.title, why: '黑名单/玩腻了' }); continue }
    passed.push({ toy, ...s })
  }
  if (!passed.length) return { ok: false, reason: '全被过滤掉了', skipped, errors }

  passed.sort((a, b) => b.score - a.score)
  const top = passed.slice(0, 10)
  const chosen = weightedPick(top)
  return { ok: true, pick: chosen, candidates: top.map((x) => ({ id: x.toy.id, title: x.toy.title, score: Number(x.score.toFixed(2)) })), skipped: skipped.slice(0, 10), errors }
}
