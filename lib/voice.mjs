/**
 * lib/voice.mjs —— 用「编辑过的人设 + 说话风格」现写一句评论
 * ============================================================================
 * 只在设置页填了「说话风格」（voice.styleText）时才走模型；模型不可用 / 出错就
 * 返回 null，调用方回落到模板（lib/commenter.mjs 的内置句子或自己写的模板）。
 * 这样「人设和说话风格可以自己编辑文本」是真的生效，而不是存着好看。
 * ============================================================================
 */
import { randomUUID } from 'node:crypto'

const clipText = (s, max = 80) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '')
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

/** 人设描述（给模型看的自我认知） */
export function personaBrief(cfg) {
  const p = cfg?.persona || {}
  const bits = []
  if (p.name) bits.push(`名字：${p.name}`)
  if (p.species) bits.push(`物种：${p.species}`)
  if (p.temperament) bits.push(`性格：${p.temperament}`)
  if (p.bio) bits.push(`来历：${p.bio}`)
  const phrases = Array.isArray(p.catchphrases) ? p.catchphrases.filter(Boolean) : []
  if (phrases.length) bits.push(`口头禅：${phrases.join(' / ')}`)
  if (cfg?.voice?.styleText) bits.push(`说话风格：${cfg.voice.styleText}`)
  return bits.join('\n')
}

/**
 * @param {{ ctx: any, log: (m: string) => void }} deps
 */
export function createVoice({ ctx, log }) {
  // opencode-go 这类网关要求带会话 id，否则会被 400 掉（在 dafeiyu-moderator 里踩过）
  const sessionId = `bili-toy-bot-${randomUUID()}`

  const llm = () => {
    try { return ctx.get?.('llm') || ctx.llm || null } catch { return null }
  }
  const selection = () => {
    try {
      const svc = ctx.get?.('agentDefaultModel') || ctx.agentDefaultModel
      const cur = svc?.currentSelection?.()
      return cur && cur.provider && cur.model ? cur : null
    } catch { return null }
  }

  const available = () => !!llm() && !!selection()

  async function complete({ system, user, maxTokens = 220, temperature = 0.9, timeoutMs = 20000 }) {
    const svc = llm()
    const sel = selection()
    if (!svc || typeof svc.stream !== 'function') throw new Error('宿主没有 llm 服务')
    if (!sel) throw new Error('宿主没有可用的默认模型')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let text = ''
    try {
      const stream = svc.stream({
        provider: sel.provider,
        model: sel.model,
        ...(sel.reasoning !== undefined ? { reasoningEffort: sel.reasoning } : {}),
        sessionId,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        temperature,
        maxTokens,
        signal: ac.signal,
      })
      for await (const chunk of stream) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') text += chunk.text || ''
        else if (chunk.type === 'finish' || chunk.type === 'done') {
          const kind = chunk.reason?.kind || chunk.stopReason
          if (kind === 'error' || kind === 'aborted') {
            throw new Error(chunk.reason?.failure?.message || chunk.message || '模型调用失败')
          }
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('模型调用超时')
      throw e
    } finally { clearTimeout(timer) }
    return text.trim()
  }

  /**
   * 现写一条评论。返回 { ok, text } / null（不该用模型时）/ { ok:false, message }
   */
  async function draftComment({ cfg, toy, minutes = 1, actions = 0 }) {
    const styleText = String(cfg?.voice?.styleText || '').trim()
    if (!styleText) return null
    if (!available()) return { ok: false, message: '这台机器没有可用的模型（或没登录），改用模板' }
    const brief = personaBrief(cfg)
    const system = [
      brief ? `你是这样的角色：\n${brief}` : '你是一个普通的观众。',
      '现在你要在一个游戏（toy）的评论区留一句话，就像真人随口说的那样。',
      `说话风格必须遵守：${styleText}`,
      '要求：只输出这一句评论，不要引号、不要解释、不要换行；20~40 个字；不要像广告。',
    ].join('\n')
    const user = [
      `游戏名：《${toy?.title || ''}》`,
      toy?.author ? `作者：${toy.author}` : '',
      `我玩了 ${minutes} 分钟，动了 ${actions} 下。`,
      '写一句话。',
    ].filter(Boolean).join('\n')
    try {
      const text = clipText(await complete({ system, user, maxTokens: 180, temperature: 0.95 }), 60)
      if (!text) return { ok: false, message: '模型没写出内容' }
      return { ok: true, text }
    } catch (e) {
      log?.(`写评论失败：${e?.message || e}`)
      return { ok: false, message: String(e?.message || e) }
    }
  }

  /** 现写一句「玩的过程中」的感受（进度播报用，可选） */
  async function draftProgress({ cfg, toy, minutes = 0, actions = 0 }) {
    const styleText = String(cfg?.voice?.styleText || '').trim()
    if (!styleText || !available()) return null
    const brief = personaBrief(cfg)
    const system = [
      brief ? `你是这样的角色：\n${brief}` : '',
      `说话风格：${styleText}`,
      '用一句话说你现在玩得怎么样，像真人自言自语。只输出这一句，不要引号，20~40 字。',
    ].filter(Boolean).join('\n')
    const user = `正在玩《${toy?.title || ''}》，已经 ${minutes} 分钟，动了 ${actions} 下。`
    try {
      const text = clipText(await complete({ system, user, maxTokens: 160, temperature: 0.9 }), 60)
      return text ? { ok: true, text } : null
    } catch (e) {
      log?.(`写进度失败：${e?.message || e}`)
      return null
    }
  }

  return {
    available,
    draftComment,
    draftProgress,
    describe() {
      const sel = selection()
      return { available: available(), model: sel?.model || '', provider: sel?.provider || '' }
    },
  }
}
