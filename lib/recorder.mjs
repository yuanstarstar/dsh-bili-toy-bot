/**
 * lib/recorder.mjs —— 每局的记录
 * ============================================================================
 * runs/<runId>/
 *   meta.json     这一局的元信息（toy、起止、时长、动作数、结果、评论）
 *   steps.jsonl   每一步（时间、动作、目标、判定）
 *   shots/*.jpg   关键帧
 *   diary.md      第一人称日记（人设口吻）
 * daily/<YYYY-MM-DD>.md  当天日报
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dailyDir, homeDir, runsDir, todayKey, writeJson } from './state.mjs'

const pad = (n) => String(n).padStart(2, '0')

export function newRunId(d = new Date()) {
  const stamp = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `${todayKey(d)}-${stamp}-${rand}`
}

export function runDir(runId) {
  return join(runsDir(), runId)
}

export function createRun({ toy, persona, cfg }) {
  const id = newRunId()
  const dir = runDir(id)
  mkdirSync(join(dir, 'shots'), { recursive: true })
  const meta = {
    id,
    status: 'planned',
    toy: { id: toy.id, title: toy.title, category: toy.category, categoryCn: toy.categoryCn, author: toy.author, url: toy.url, plays: toy.plays },
    persona: persona?.name || '',
    policy: cfg?.policy || 'L2',
    createdAt: Date.now(),
    startedAt: 0,
    endedAt: 0,
    minutes: 0,
    actions: 0,
    shots: 0,
    outcome: '',
    comment: null,
  }
  writeJson(join(dir, 'meta.json'), meta)
  return { id, dir, meta }
}

export function readRun(runId) {
  try {
    const dir = runDir(runId)
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    let diary = ''
    try { diary = readFileSync(join(dir, 'diary.md'), 'utf8') } catch { /* 没有就算了 */ }
    let steps = []
    try {
      steps = readFileSync(join(dir, 'steps.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch { /* 没有就算了 */ }
    return { ...meta, diary, steps }
  } catch { return null }
}

export function updateRun(runId, patch) {
  const dir = runDir(runId)
  const file = join(dir, 'meta.json')
  let meta = {}
  try { meta = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 新建 */ }
  Object.assign(meta, patch, { updatedAt: Date.now() })
  writeJson(file, meta)
  return meta
}

export function appendStep(runId, step) {
  const dir = runDir(runId)
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
  appendFileSync(join(dir, 'steps.jsonl'), JSON.stringify({ t: Date.now(), ...step }) + '\n', 'utf8')
}

export function saveShot(runId, buffer, name = `shot-${Date.now()}.jpg`) {
  const dir = join(runDir(runId), 'shots')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
  const file = join(dir, name)
  writeFileSync(file, buffer)
  return file
}

export function writeDiary(runId, text) {
  const dir = runDir(runId)
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
  writeFileSync(join(dir, 'diary.md'), text, 'utf8')
}

export function listRuns(limit = 20) {
  try {
    const dirs = readdirSync(runsDir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    dirs.sort().reverse()
    return dirs.slice(0, limit).map((id) => {
      try { return JSON.parse(readFileSync(join(runDir(id), 'meta.json'), 'utf8')) } catch { return { id, status: 'broken' } }
    })
  } catch { return [] }
}

export function writeDailyDigest(text, dateKey = todayKey()) {
  mkdirSync(dailyDir(), { recursive: true })
  const file = join(dailyDir(), `${dateKey}.md`)
  writeFileSync(file, text, 'utf8')
  return file
}

export function readDailyDigest(dateKey = todayKey()) {
  try { return readFileSync(join(dailyDir(), `${dateKey}.md`), 'utf8') } catch { return '' }
}

/** 清理超过 keepDays 的 runs 与日报 */
export function pruneOld(keepDays = 30) {
  const cutoff = Date.now() - Math.max(1, keepDays) * 86400_000
  let removed = 0
  try {
    for (const name of readdirSync(runsDir())) {
      const dir = join(runsDir(), name)
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
        const ts = meta.createdAt || 0
        if (ts && ts < cutoff) { rmSync(dir, { recursive: true, force: true }); removed++ }
      } catch { /* 坏目录也清掉 */ try { rmSync(dir, { recursive: true, force: true }); removed++ } catch { /* 忽略 */ } }
    }
  } catch { /* 目录不存在 */ }
  return removed
}

/** 用简单模板生成日记；有模型时可以在上层换成 LLM 版本 */
export function renderDiary(meta, steps = []) {
  const p = meta.persona || '我'
  const toy = meta.toy || {}
  const lines = []
  lines.push(`# ${new Date(meta.createdAt || Date.now()).toLocaleString('zh-CN')} · ${toy.title || '一个 toy'}`)
  lines.push('')
  lines.push(`> ${p} 今天打开了「${toy.title || toy.id}」（${toy.categoryCn || toy.category || '未知分类'}，${Number(toy.plays || 0).toLocaleString()} 播放）。`)
  lines.push('')
  if (meta.status === 'planned') {
    lines.push('还在计划阶段，没真正开玩（M1）。')
  } else {
    lines.push(`一共待了 ${meta.minutes || 0} 分钟，点了 ${meta.actions || 0} 下，${meta.shots || 0} 张截图。`)
  }
  if (steps.length) {
    lines.push('')
    lines.push('## 我做了什么')
    for (const s of steps.slice(0, 40)) {
      lines.push(`- ${new Date(s.t).toLocaleTimeString('zh-CN')} ${s.action || ''} ${s.target || ''} ${s.note || ''}`.trim())
    }
  }
  if (meta.comment?.text) {
    lines.push('')
    lines.push(`## 我留的评论（${meta.comment.dryRun ? '试运行，未发送' : '已发送'}）`)
    lines.push(`> ${meta.comment.text}`)
  }
  return lines.join('\n')
}

export function logPath() {
  return join(homeDir(), 'bot.log')
}

export function pathsExist() {
  const p = homeDir()
  return { home: p, exists: existsSync(p) }
}
