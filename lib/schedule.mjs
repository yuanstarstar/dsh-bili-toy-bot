/**
 * lib/schedule.mjs —— 时段解析与"现在该不该开工"
 * ============================================================================
 * 时段写法：`12:00-23:00` 或 `09:30-11:00, 14:00-15:30, 21:00-01:00`
 *   · 逗号（中英文都行）分隔多段
 *   · 结束早于开始 = 跨夜（21:00-01:00 → 1260..1500）
 *   · 每段开始后 random(0, jitterMinutes) 分钟内才真正触发，避免整点准点上线
 * ============================================================================
 */

export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

export function parseSlots(text) {
  const out = []
  for (const part of String(text || '').split(/[,，;；]/)) {
    const p = part.trim()
    if (!p) continue
    const m = /^(\d{1,2}:\d{2})\s*[-~—到]\s*(\d{1,2}:\d{2})$/.exec(p)
    if (!m) continue
    const start = parseClock(m[1])
    let end = parseClock(m[2])
    if (start === null || end === null) continue
    const overnight = end <= start
    if (overnight) end += 24 * 60
    out.push({ start, end, overnight, raw: p })
  }
  return out
}

export function minuteOfDay(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes()
}

/** ISO 星期：周一=1 … 周日=7 */
export function isoDay(d = new Date()) {
  return ((d.getDay() + 6) % 7) + 1
}

export function inWindow(minute, win) {
  if (!win) return false
  if (!win.overnight) return minute >= win.start && minute < win.end
  // 跨夜：当天 [start, 1440) 或 次日 [0, end-1440)
  return minute >= win.start || minute < win.end - 24 * 60
}

export function inAnyWindow(minute, wins) {
  return wins.some((w) => inWindow(minute, w))
}

export function windowContainsDate(d, win) {
  return inWindow(minuteOfDay(d), win)
}

/** 距离当前时段结束还有多少分钟（不在时段内返回 0） */
export function minutesLeftInWindow(d, wins) {
  const minute = minuteOfDay(d)
  let best = 0
  for (const w of wins) {
    if (!inWindow(minute, w)) continue
    // 跨夜时段：21:00-01:00 在 23:30 时，结束点是"明天 01:00"，也就是 1500；凌晨 00:30 时结束点是 60。
    const endAbs = w.overnight
      ? (minute >= w.start ? w.end : w.end - 24 * 60)
      : w.end
    best = Math.max(best, endAbs - minute)
  }
  return Math.max(0, best)
}

/** 下一天里这个时段的开始时间 */
function nextDailyStart(after, win, days) {
  const base = new Date(after.getTime())
  for (let i = 0; i <= 8; i++) {
    const d = new Date(base.getTime())
    d.setDate(d.getDate() + i)
    d.setHours(Math.floor(win.start / 60), win.start % 60, 0, 0)
    if (d.getTime() <= after.getTime()) continue
    if (days.length && !days.includes(isoDay(d))) continue
    return d
  }
  return null
}

export function nextSlotStart(after, cfg) {
  const wins = parseSlots(cfg.slots)
  if (!wins.length) return null
  const days = Array.isArray(cfg.daysOfWeek) && cfg.daysOfWeek.length ? cfg.daysOfWeek : []
  const candidates = []
  for (const w of wins) {
    const t = nextDailyStart(after, w, days)
    if (t) candidates.push({ at: t, win: w })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.at - b.at)
  const pick = candidates[0]
  const jitter = Math.max(0, Math.min(60, Number(cfg.jitterMinutes) || 0))
  const offset = jitter ? Math.floor(Math.random() * jitter) : 0
  return new Date(pick.at.getTime() + offset * 60_000)
}

export function inQuietHours(d, cfg) {
  const wins = parseSlots(cfg.quietHours)
  return wins.length > 0 && inAnyWindow(minuteOfDay(d), wins)
}

/**
 * 现在能不能开工。返回 { ok, reason, nextAt }
 * 检查顺序：总开关 → 星期 → 静默时段 → 时段内 → 每日局数 → 每日总时长 → 冷却
 */
export function canRunNow(now, cfg, state) {
  const at = now.getTime()
  if (!cfg.enabled) return { ok: false, reason: 'disabled', text: '机器人没开（enabled=false）' }

  const days = Array.isArray(cfg.daysOfWeek) && cfg.daysOfWeek.length ? cfg.daysOfWeek : null
  if (days && !days.includes(isoDay(now))) {
    return { ok: false, reason: 'weekday', text: `今天星期${isoDay(now)}不在运行日里` }
  }

  const wins = parseSlots(cfg.slots)
  if (!wins.length) return { ok: false, reason: 'bad-slots', text: `时段写法看不懂："${cfg.slots}"` }
  const nextAt = nextSlotStart(now, cfg)

  if (inQuietHours(now, cfg)) {
    return { ok: false, reason: 'quiet', text: `静默时段 ${cfg.quietHours} 内不开工`, nextAt }
  }
  if (!inAnyWindow(minuteOfDay(now), wins)) {
    return { ok: false, reason: 'outside', text: '不在时段内', nextAt }
  }
  if (state.runsToday >= cfg.maxRunsPerDay) {
    return { ok: false, reason: 'quota', text: `今天已经玩了 ${state.runsToday}/${cfg.maxRunsPerDay} 局` }
  }
  if (state.minutesToday >= cfg.dailyTotalMinutes) {
    return { ok: false, reason: 'total', text: `今天总时长 ${state.minutesToday}/${cfg.dailyTotalMinutes} 分钟已用完` }
  }
  const gapMs = Math.max(0, Number(cfg.minGapMinutes) || 0) * 60_000
  if (state.lastRunAt && at - state.lastRunAt < gapMs) {
    const waitMin = Math.ceil((gapMs - (at - state.lastRunAt)) / 60_000)
    return { ok: false, reason: 'gap', text: `距上一局太近，还要等 ${waitMin} 分钟` }
  }
  return { ok: true, reason: 'ok', text: '可以开工', nextAt }
}

export function describeSchedule(cfg) {
  const wins = parseSlots(cfg.slots)
  if (!wins.length) return '（没有有效时段）'
  return wins.map((w) => w.raw).join('、')
}
