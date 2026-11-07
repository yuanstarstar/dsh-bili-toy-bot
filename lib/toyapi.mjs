/**
 * lib/toyapi.mjs —— 借用 dsh-bili-toy 的接口层（不复制代码）
 * ============================================================================
 * 机器人不自己实现 B站接口，直接 import 隔壁 `dsh-bili-toy/lib/bili.mjs`：
 *   · 同一份登录凭证（<DSH_HOME>/bili-toy/credential.json）
 *   · 同一套已验证的端点（广场 / 详情 / 评论 / 点赞 / 收藏）
 *
 * 解析顺序：
 *   1. 包解析 `@local/dsh-bili-toy/lib/bili.mjs`（两个插件都装在 node_modules/@local 时）
 *   2. 相对路径（plugins/dsh-bili-toy 与 plugins/dsh-bili-toy-bot 是兄弟目录时）
 *   3. 报错并给出可读提示
 * ============================================================================
 */
let cached = null

export async function loadToyApi() {
  if (cached) return cached
  const attempts = []
  try {
    const mod = await import('@local/dsh-bili-toy/lib/bili.mjs')
    cached = mod
    return mod
  } catch (e) { attempts.push(`包解析失败：${e?.code || e?.message}`) }

  try {
    const url = new URL('../../dsh-bili-toy/lib/bili.mjs', import.meta.url).href
    const mod = await import(url)
    cached = mod
    return mod
  } catch (e) { attempts.push(`相对路径失败：${e?.code || e?.message}`) }

  throw new Error(
    '找不到 dsh-bili-toy 的接口层（lib/bili.mjs）。请先安装工具包 dsh-bili-toy，' +
    '并保证它和本插件在同一个 plugins 目录下。详情：' + attempts.join(' / ')
  )
}

export async function toyVersion() {
  try {
    const api = await loadToyApi()
    return typeof api.probe === 'function' ? 'ok' : 'ok'
  } catch { return 'missing' }
}
