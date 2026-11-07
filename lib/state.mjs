/**
 * lib/state.mjs —— 机器人的配置与运行状态
 * ============================================================================
 * 家目录：<DSH_HOME>/bili-toy-bot/
 *   config.json   设置（设置页 / bot_config_set 都改它）
 *   state.json    今日已跑局数、上次运行时间、评论计数
 *   comment.json  已评论过的 toy（防重复）
 *   history.json  每个 toy 玩过几次
 *   bot.log       运行日志（保留 800 行）
 *
 * ⚠️ 血泪教训（来自 dsh-bili-toy）：宿主传进来的 config 每个字段都可能是
 *    undefined / "0" / 空对象 {}（schemastery 默认值没展开），所以所有值都要
 *    按"期望类型"归一化，绝不能直接信任。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function homeDir() {
  const root = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(root, 'bili-toy-bot')
}

export const runsDir = () => join(homeDir(), 'runs')
export const dailyDir = () => join(homeDir(), 'daily')

export function ensureDirs() {
  for (const d of [homeDir(), runsDir(), dailyDir()]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 已存在 */ }
  }
}

/** 默认配置（全部按 2026-11-07 拍板的决策） */
export const DEFAULT_CONFIG = {
  // —— 总开关 ——
  enabled: false,

  // —— 时段 ——
  slots: '12:00-23:00',          // 逗号分隔，支持 21:00-01:00 跨夜
  daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
  jitterMinutes: 5,
  maxRunsPerDay: 6,
  minGapMinutes: 20,
  catchUp: 'skip',
  quietHours: '23:30-08:00',
  dailyTotalMinutes: 90,

  // —— 选品 ——
  styles: ['休闲', '解谜', '模拟经营', '沙雕'],
  styleWeights: {},
  preferCategories: ['GAME', 'INTERACTIVE_PLAY'],
  hotness: 0.6,
  freshness: 0.3,
  novelty: 0.4,
  maxPlaysPerToy: 3,
  minPlays: 1000,
  maxPlays: 5000000,
  blacklistKeywords: ['抽奖', '充值', '广告', '扫码', '实名'],
  blacklistAuthors: [],
  allowAuthors: [],              // 作者白名单（mid 或昵称）：填了就只玩这些 UP 主的 toy
  allowSlugs: [],                // toy 白名单（slug）：填了就只玩这些
  denySlugs: [],

  // —— 玩 ——
  policy: 'L2',                  // L1 只会点开始 / L2 试探点击 / L3 视觉决策（未实现）
  maxMinutesPerToy: 20,
  minMinutesPerToy: 2,
  heartbeatSeconds: 10,          // 心跳：每隔几秒看一眼"该不该开工"，并在状态里露出心跳时间
  tickSeconds: 3,                // 旧名，兼容用；没配 heartbeatSeconds 时兜底
  maxActionsPerMinute: 12,
  idleStopSeconds: 45,
  maxBrowserMinutes: 45,
  headless: true,

  // —— 记录 ——
  recordEnabled: true,
  screenshotPolicy: 'key-frames', // none | key-frames | all
  diary: true,
  keepDays: 30,

  // —— 人设 ——
  persona: {
    name: '小鲸鱼',
    species: '蓝鲸',
    temperament: '好奇、话少、偶尔毒舌，看不懂就直说看不懂',
    catchphrases: ['这个有点意思', '……看不懂但大受震撼'],
    bio: '从深海来的小鲸鱼，专程上来看看人类都在玩什么。',
  },

  // —— 说话风格（全部是自由文本，设置页里直接编辑） ——
  voice: {
    styleText: '',              // 说话风格，自由描述：语气、句长、用不用梗/颜文字…
    catchphrase: '',            // 口头禅（留空就从 persona.catchphrases 里抽）
    commentTemplate: '',        // 自定义评论模板，占位符 {title} {minutes} {n} {author}
    announceTemplate: '',       // 收工播报模板，占位符 {title} {minutes} {actions} {comment}
    progressTemplate: '',       // 中途进度模板，占位符 {title} {minutes} {actions} {elapsed}
    atTemplate: '',             // 带 @ 的模板，占位符 {owner} {title} {minutes} {n}
  },
  progressEverySec: 20,         // 玩的过程中多久往会话推一次进度（0 = 不推）

  // —— 评论 ——
  commentEnabled: false,
  dryRun: true,
  commentStyle: '吐槽+夸',
  commentMaxPerDay: 5,
  commentMaxPerToy: 1,
  commentStyles: [],             // 已去掉内置风格（可爱卖萌/真诚夸/吐槽玩笑/安静打卡）；评论由会话按人设自己写
  commentMinGapMinutes: 30,
  commentLengthMax: 60,
  atEnabled: false,             // 评论里要不要 @ 人（和 commentEnabled 一起显示在设置页）
  atMaxPerDay: 1,               // 每日 @ 次数上限，可配置；0 = 永不 @
  atTargets: [{ name: '主人', uid: '' }], // 可以 @ 的人：名字 + B站 mid（第一条当「主人」用；名单外的人一律不许 @）
  commentTemplate: '{verdict}',

  // —— 怎么玩：交给会话（默认）还是插件自己开 headless 浏览器 ——
  playMode: 'session',           // session = 把整局任务当提示词发进绑定会话，由会话自己操作；headless = 插件自己开浏览器玩
  playPrompt: '',                // 自定义开局提示词，留空用内置模板（占位符 {name} {minutes} {slots} {styles} {categories} {commentRule}）

  // —— 会话 ——
  bindSession: 'new',
  sessionId: '',
  broadcastMode: 'feed',        // feed（写动态）| session（写进绑定会话）| off
  sessionTitle: '小鲸鱼的玩具时间',
  announcePerRun: true,
  dailyDigest: true,

  // —— 社交动作（默认全关） ——
  allowLike: false,
  allowFavorite: false,
  allowShare: false,
}

/** 出厂人设：包里的 preset.json（分发包只带人设/风格，**不带任何凭证和运行状态**） */
function loadPreset() {
  try {
    const p = JSON.parse(readFileSync(new URL('../preset.json', import.meta.url), 'utf8'))
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  } catch { return {} }
}

const PRESET = loadPreset()
const presetIsObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
for (const key of ['persona', 'voice']) {
  if (presetIsObj(PRESET[key])) DEFAULT_CONFIG[key] = { ...DEFAULT_CONFIG[key], ...PRESET[key] }
}
for (const key of ['styles', 'commentStyles', 'preferCategories']) {
  if (Array.isArray(PRESET[key])) DEFAULT_CONFIG[key] = [...PRESET[key]]
}

/** 内置风格 → 关键词，用于标题/分类文本匹配 */
export const STYLE_KEYWORDS = {
  休闲: ['休闲', '轻松', '消消', '放置', '萌', '猫', '摸鱼'],
  解谜: ['解谜', '谜', '推理', '密室', '逃脱', '找', '数独', '迷宫'],
  模拟经营: ['模拟', '经营', '商店', '餐厅', '养成', '农场', '小镇'],
  沙雕: ['沙雕', '魔性', '沙盒', '搞怪', '离谱', '大狗', '梗'],
  节奏: ['节奏', '音游', '音乐', '术力口', '打歌'],
  文字测试: ['测试', '人格', 'MBTI', '问卷', '心理', '测算'],
  射击: ['射击', '枪', '弹幕', '飞机'],
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 按默认值的"形状"把用户值掰回来；类型不对就用默认值 */
export function normalizeConfig(raw, defaults = DEFAULT_CONFIG) {
  const out = {}
  for (const [k, def] of Object.entries(defaults)) {
    const v = isPlainObject(raw) ? raw[k] : undefined
    if (Array.isArray(def)) {
      out[k] = Array.isArray(v) ? v : def.slice()
    } else if (isPlainObject(def)) {
      out[k] = normalizeConfig(v, def)
    } else if (typeof def === 'number') {
      const n = Number(v)
      out[k] = v === null || v === undefined || v === '' || !Number.isFinite(n) ? def : n
    } else if (typeof def === 'boolean') {
      out[k] = typeof v === 'boolean' ? v : def
    } else {
      out[k] = typeof v === 'string' ? v : def
    }
  }
  return out
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 原子写 + 无 BOM（BOM 会让宿主 JSON.parse 崩） */
export function writeJson(file, value) {
  ensureDirs()
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8' })
  renameSync(tmp, file)
}

export function loadConfig() {
  ensureDirs()
  return normalizeConfig(readJson(join(homeDir(), 'config.json'), {}))
}

export function saveConfig(cfg) {
  const normalized = normalizeConfig(cfg)
  writeJson(join(homeDir(), 'config.json'), normalized)
  return normalized
}

export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const EMPTY_STATE = {
  day: '',
  runsToday: 0,
  minutesToday: 0,
  commentsToday: 0,
  atsToday: 0,
  lastRunAt: 0,
  lastCommentAt: 0,
  lastAtAt: 0,
  running: null,
  browserPid: 0,
}

export function loadState() {
  ensureDirs()
  const s = { ...EMPTY_STATE, ...readJson(join(homeDir(), 'state.json'), {}) }
  const today = todayKey()
  if (s.day !== today) {
    Object.assign(s, { ...EMPTY_STATE, day: today })
  }
  return s
}

export function saveState(state) {
  writeJson(join(homeDir(), 'state.json'), state)
  return state
}

export function loadHistory() {
  return readJson(join(homeDir(), 'history.json'), { toys: {}, updatedAt: 0 })
}

export function saveHistory(h) {
  h.updatedAt = Date.now()
  writeJson(join(homeDir(), 'history.json'), h)
}

export function loadCommented() {
  return readJson(join(homeDir(), 'commented.json'), { items: {} })
}

export function saveCommented(c) {
  writeJson(join(homeDir(), 'commented.json'), c)
}

export function logLine(scope, msg) {
  ensureDirs()
  const line = `[${new Date().toISOString()}] ${scope} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`
  try {
    const file = join(homeDir(), 'bot.log')
    let lines = []
    if (existsSync(file)) lines = readFileSync(file, 'utf8').split('\n')
    lines.push(line.trimEnd())
    if (lines.length > 900) lines = lines.slice(-800)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

export function readLogTail(n = 60) {
  try {
    const lines = readFileSync(join(homeDir(), 'bot.log'), 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n)
  } catch { return [] }
}
