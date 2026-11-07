# dsh-bili-toy-bot

> 一个按作息表自己去 B站 **Toy 广场**玩游戏的机器人。配套插件：`dsh-bili-toy`（提供 Toy 接口与登录凭证）。

## 安装（不需要 npm 安装器）

前提：已经有 **dsh-bili-toy**（同一父目录放一份即可，机器人通过 `@local/dsh-bili-toy/lib/bili.mjs` 取接口，找不到就退回 `../../dsh-bili-toy/lib/bili.mjs`）。

```powershell
# 1) 把 zip 解压到任意目录，例如 D:\plugins\dsh-bili-toy-bot
# 2) 在 profile 的 node_modules 里建软链（管理员不需要，普通用户即可）
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$profile\node_modules\@local\dsh-bili-toy-bot" -Target "D:\plugins\dsh-bili-toy-bot"
```

```
# 3) 编辑 $profile\package.json（保持 UTF-8 无 BOM）
"dependencies":  { "@local/dsh-bili-toy-bot": "link:D:/plugins/dsh-bili-toy-bot" }
"dsh": { "profile": { "bundles": [ ..., "@local/dsh-bili-toy-bot" ] } }
```

4) **重启 DSH Desktop**（宿主代码不热更新；只有 cordis 配置补丁会被 HMR）。重启后：设置页多出「玩toy机器人」，工具列表多出 20 个 `bot_*`。

包内 **`preset.json`** 是出厂人设（大肥鱼 / 鲸鱼娘 + 说话风格 + 选片口味），首次启动会当作默认值；它**不含**登录凭证、会话 id、运行状态。运行时数据一律写在家目录（见「家目录」）。

当前版本 **0.4.5**：

- **0.4.5 修复（本轮）**：
  - **「单局时长」被改回 2 分钟的真凶**：设置页点「立刻玩一局」时，面板固定发 `{ minutes: 2 }`，而 `/play` 路由把它当成新配置 **写回了 `maxMinutesPerToy`**（还带 `|| 2` 兜底），于是每次点完「玩一局」，你刚改的单局时长就变成 2 分钟。两头都修了：面板改成发当前「单局最长」的值（不写配置），`/play` 只把它当**这一次的临时上限**，绝不落盘。
  - 回归测试写进 `selftest.mjs`：把 `maxMinutesPerToy` 设成 20 → POST `/play {minutes:2}` → 断言配置仍是 20（`minutesNotClobbered: true`）。
  - 顺手修了同一处删代码后漏掉的 `c is not defined`（`/play` 曾返回 500）。

- **0.4.4 新增**：
  - **改名**：「心跳」这个词容易和「两局间隔」混，面板上一律改叫 **「看表间隔」**（每几秒看一眼该不该开工），状态行也改成 `看表：3 秒前（每 10 秒看一眼，共 42 次）`。它不影响玩什么，只影响「到点后多久开始」。
  - **「能 @ 的人」改成列表编辑器**：不再是一整块文本域，而是一行一个「昵称 + mid」的输入框，带 **`+ 添加一个能 @ 的人`** 和每行 **`删`**；第一行标「主人」。保存时按行收成 `atTargets: [{name, uid}]`，中间的空行/空人自动丢掉。

- **0.4.3 新增**：
  - **「两局间隔」搬进设置页**：`minGapMinutes`（默认 20 分钟）——**上一局玩完之后，至少隔这么久才开下一局**。之前只有配置文件里有，面板看不到，于是会出现「到点了却一直不开工」且不知道为什么；现在面板里能直接改，状态卡也会写「两局间隔 N 分钟（上一局 …）」。
  - **看表（原心跳）可见、可调**：`heartbeatSeconds`（默认 10 秒）——插件每隔几秒看一次「现在该不该开工」。状态卡显示「看表：3 秒前（…）」，只记在内存里（不写 state 文件）。
  - 定时器从「固定 60 秒一跳」改成按 `heartbeatSeconds` 跳，改完保存 30 秒内自动换间隔。
  - **修跨夜时段**：`minutesLeftInWindow()` 对 `21:00-01:00` 这类跨夜时段原来恒返回 0（`endAbs` 没跨回 0），现在正确返回剩余分钟。
- **0.4.2 新增**：
  - **@ 的对象改成「主人」，不再是作者**：配置里的 `atOwner/ownerUid/atTemplate` 全部去掉，换成 `atEnabled`（要不要 @）+ `atTargets`（**可以 @ 的人**：`[{name, uid}]`，第一条当主人）。`commenter.pickAtTarget()` 只从这份名单里挑；提示词里明确「只许 @ 名单里的人，名单外一律不许 @」。
  - **设置页把「是否评论」和「是否 @」放在一起**：同一组「评论与 @」里依次是 是否评论 ☑ / 是否 @ 人 ☑ / 每天最多 @ N 次 / 可以 @ 的人（一行一个「名字,mid」，第一个当主人；mid 留空就只写昵称）。顶栏去掉了重复的「允许评论」按钮。
- **0.4.1 新增**：
  - **`bot_say` 改成「玩完再评价」**：删掉 `runOne()` 里的进度定时器（不再每 20 秒往会话推一条）；只在**开局报一句**，**收工后用 `bot_say` 说 1~3 句点评**（好不好玩、卡在哪、值不值得推荐）。交棒提示词里也明确写「玩的过程中不要说话」。
  - **设置页补上「@ 策略」和「白名单」**：新增「评论时 @ 作者」开关、`allowAuthors`（只玩这些 UP 主，昵称或 mid，一行一个）、`allowSlugs`（只玩这些 toy）、`blacklistKeywords`（不玩的关键词，逗号分隔，单独一张卡）。`picker.allowedByFilters()` 现在真的按作者白名单过滤。
  - 「进度模板」改名「开局模板」（只在开局用一次）；`bot_voice` 去掉 `progressEverySec` 参数。
- **0.4.0 新增**：
  - **「玩一局」改成交给会话玩**：点击后不再让插件自己在后台开浏览器，而是把整局任务写成一段提示词，用 `agent.followup()` 发进**绑定的会话**，由那个会话里的 agent 自己调 `toy_*` / `coach_*` 完成：挑游戏 → `toy_open` 打开 → 看画面操作 → 收工 → 评论。设置页里「怎么玩」可选 `交给绑定会话玩（推荐）` / `插件自己开浏览器玩`；`playPrompt` 可以自定义那段提示词（占位符 `{name}{minutes}{slots}{styles}{categories}{commentRule}`）。
  - **点「玩一局」立刻有反馈**：接口同步返回 `mode/via/sessionId/message`，面板直接把「已经交给会话 / 会话不在线」写出来。
  - **去掉「内置风格」和「进度间隔」**：可爱卖萌 / 真诚夸 / 吐槽玩笑 / 安静打卡 四个预设不再出现（`commentStyles` 默认空），评论改由会话按人设自己写；面板不再显示「进度间隔」。
  - 修 `minutesLeftInWindow` 传参错误（原来把分钟数当 Date 传，定时开工必抛 `d.getHours is not a function`）。
  - 修会话追加消息缺 `intent.surfaceOp` 被宿主拒：`session event "user/message" is surface-eligible and requires a surfaceOp marker`。
  - 自检 `selftest.mjs` 改用临时 `DSH_HOME`，不再把真实 `config.json` 里的 sessionId / 人设 / 计数写坏。
- **0.3.x 已有**：
  - **绑定会话可展开**：设置页「玩toy机器人 → 绑定会话」点开就是在线会话列表（时间、事件数、最近一句），一键「绑定 / 重新激活」；也能「新建一个并绑定」。绑定后机器人会先往那个会话发一句上线消息，你在会话里就能看到它。
  - **玩游戏 = 在会话里玩**：真开始玩以后，进度按 `progressEverySec`（默认 20 秒）实时发到绑定会话；收工播报也发进去。面板里另有一条「实时进度」时间线，标了哪些已经发进会话。
  - **人设可以自己写**：名字、物种/形象、性格、口头禅（一行一条）、来历、选片口味，全是可编辑文本。
  - **说话风格可以自己写**：一段自由描述的「说话风格」+ 口头禅 + 评论/进度/收工模板（占位符 `{title}{minutes}{actions}{catchphrase}{author}` 等），填了风格就让模型按你的话现写，写不出来才用模板；面板里有「试写一条评论」可以当场看效果。
  - 新增 3 个工具：`bot_sessions`、`bot_session_activate`、`bot_voice`；HTTP 新增 `/sessions` `/session/bind` `/session/create` `/session/unbind` `/session/test` `/voice/comment` `/progress`。
- **M1 已完成**：配置、时段调度、选品、记录。
- **M2 已完成**：真正开 **headless Edge**（CDP）去玩 —— 导航、点「开始游戏」、定时截图、到点/挂机收工，全程不抢前台、不动你的鼠标键盘。
- **M3 已完成**：玩完自动出评论草稿，可 @ 「可以 @ 的人」名单里的人（默认主人）；`commentEnabled` 打开才真发，`commentMaxPerDay` / `atMaxPerDay` 兜底。
- **M4 已完成（会话播报部分）**：`broadcastMode: 'feed' | 'session' | 'off'`，session 模式发进你绑定的专属会话；L3（读画面做决策）还没做。
- **M5 已完成**：设置页「玩toy机器人」（状态、开关、配置表单、最近几局、动态、评论记录，8s 轮询）。

## 它怎么玩

**默认：交给绑定会话玩（`playMode: 'session'`）**

```
到点 → 建 run 记录 → 生成整局提示词（buildPlayPrompt）
     → agent.followup(message) 发进绑定会话 → 会话里的 agent 自己开始干活：
         toy_square/toy_search 挑一个 → toy_detail → toy_open 打开
         → coach_windows/coach_anchor/coach_now/coach_click 看画面操作
         → 玩 N 分钟、中途用 bot_say 报进度 → 收工总结 →（可选）toy_comment 评论
     → 播报一句到动态/会话
```

**备选：插件自己玩（`playMode: 'headless'` 或没绑会话时兜底）**

```
到点 → 选品（广场分类 + 打分）→ 建 run 记录 → headless Edge 开页
     → 找「开始游戏/Toy启动」点下去 → 每 5s 截一帧、隔一会做个轻动作
     → 到点 / 挂在原地 45s → 收工 → 写日记 + 当日日报 + 计数
     → （可选）出评论草稿 / 真发 → 播报到动态或专属会话
```

- headless 模式动作很笨但安全：只点有文字的按钮、点画面中下方、偶尔按空格；频率上限 `maxActionsPerMinute`。
- 误点进「设置 / 排行榜」这类弹层时，会找「返回游戏」自己退回去。
- 画面全靠截图留证：`runs/<id>/shots/*.jpg`。

## 家目录

`C:\Users\<你>\.dsh\bili-toy-bot\`

```
config.json     机器人配置（bot_config_get / bot_config_set 读写）
state.json      今日计数、上次开工时间
history.json    每个 toy 玩过几次
bot.log         运行日志（保留 800 行）
cdp-profile/    headless Edge 的独立 profile（不碰你平常用的小号/标签）
runs/<id>/      meta.json + steps.jsonl + shots/ + diary.md
daily/<日期>.md 当天日报
```

## 20 个工具

| 工具 | 说明 |
| --- | --- |
| `bot_status` | 开关、是否在时段内、今天玩了几局、下一局什么时候（含绑定的会话是否在线） |
| `bot_config_get` / `bot_config_set` | 读 / 深合并改配置（人设、说话风格、模板都在这里改） |
| `bot_plan` | 只挑不玩：现在会选哪个、为什么、候选前十 |
| `bot_start` / `bot_stop` | 开 / 关机器人 |
| `bot_play_now` | 立刻玩一局（`dryRun=true` 只规划并落记录） |
| `bot_runs` / `bot_run_get` | 最近几局 / 单局详情（含日记与步骤） |
| `bot_diary` / `bot_stats` | 某天日报 / 累计统计 |
| `bot_say` | 用小人设口吻说一句话（按 `broadcastMode` 发到会话或动态） |
| `bot_sessions` | 列出所有在线会话（id、时间、事件数、最近一句），用来挑要绑哪个 |
| `bot_session_bind` | 绑定专属会话（`sessionId` 留空=解绑，`create: true`=新建一个再绑） |
| `bot_session_activate` | 往已绑定会话发一句话（确认它在线） |
| `bot_voice` | 现写一句评论看看效果（`title`/`minutes` 可给） |
| `bot_comment_draft` | 给某一局生成评论草稿（不发送） |
| `bot_comment_send` | 把草稿（或你改过的文本）真的发出去 |
| `bot_comment_list` | 机器人发过的评论记录（含 rpid） |
| `bot_feed` | 最近的动态（设置页「动态」区同源） |

## 默认配置（节选）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关 |
| `slots` | `12:00-23:00` | 时段，逗号分隔；支持跨夜 `21:00-01:00` |
| `maxRunsPerDay` / `minGapMinutes` | 6 / 20 | 每天最多几局、**两局最短间隔**（上一局玩完到下一局） |
| `heartbeatSeconds` | 10 | 心跳间隔：每隔几秒看一次「该不该开工」（设置页可改） |
| `dailyTotalMinutes` | 90 | 每天总时长上限 |
| `quietHours` | `23:30-08:00` | 静默时段 |
| `dryRun` | `true` | **只规划不玩**；关掉才真的开浏览器 |
| `headless` | `true` | 后台无窗口运行 |
| `maxMinutesPerToy` | 20 | 单局最长 |
| `maxActionsPerMinute` | 12 | 动作频率上限 |
| `policy` | `L2` | 只做「点一下 / 按空格」，不读游戏状态、不连招 |
| `commentEnabled` | `false` | 玩完自动评论（**默认关**） |
| `commentMaxPerDay` / `atMaxPerDay` | 5 / 1 | 每天评论上限 / 每天 @ 上限（0 = 不 @） |
| `atEnabled` | `false` | 评论里要不要 @ 人 |
| `atTargets` | `[{name:'主人', uid:''}]` | **可以 @ 的人**：`name` + B站 mid；第一条当主人，名单外一律不 @ |
| `commentStyles` | `[]` | 评论风格池（0.4.0 起默认空，评论由会话按人设写） |
| `broadcastMode` | `'feed'` | `feed` 写动态 / `session` 发进绑定会话 / `off` 不说 |
| `sessionId` | `''` | `broadcastMode:'session'` 时播报到的会话 |
| `persona.name` | `'小鲸鱼'` | 播报与评论里的自称 |

## 开关流程

```
bot_config_set { sessionId: '<会话id>', playMode: 'session' }   # 绑定会话 + 交给它玩（设置页里点也行）
bot_play_now                                  # 手测一局 → 提示词发进会话，会话开始干活
bot_config_set { commentEnabled: true }       # 让会话在收工时真发评论（false = 只写草稿）
bot_config_set { dryRun: false }              # dryRun 现在只影响评论：false 才真发
bot_start                                     # 开启自动：到点自己把任务发进会话
bot_stop                                      # 随时停
```

> 改源码后要**重启 DSH Desktop** 才生效（Node ESM 按 URL 缓存模块，HMR 重建入口也拿到旧代码）；`client.js` 属浏览器半端，刷新页面即可。

## 已验证（2026-11-07）

- 0.4.3：`selftest.mjs` 20 工具全绿（含 `minGapMinutes=35`、`heartbeatSeconds=6` 写读回、`atPolicySaved`）；设置页渲染 178 节点，「两局间隔」「心跳间隔」「心跳：…（每 10 秒，共 42 次）」都在，且没有「@ 作者」残留。
- M2：2 分钟真实一局：`大狗大狗叫叫叫` / `大狗叫园区`，22 张截图，`status: done`，日记与日报正常落盘。
- M3：端到端真跑一局 + 自动评论真发出 —— run `2026-11-07-130754-ai7l`（《大肥鱼炫饭服》1.1 分钟），评论「@大肥鱼打游戏 安静地玩了一会儿《大肥鱼炫饭服》」，`rpid=319450944353`，`bot_comment_list` / `bot_feed` 都能回读。
- M4：`createBroadcaster().say()` 的 session 分支实测写入 `user/message`（`source.kind='plugin'`），无会话时自动退回 `feed`。
- M5：`client.js` 用最小 React 桩跑过：`settings.section` 注册成功（id `bili-toy-bot`，order 33，label「玩toy机器人」），样式注入 1 次。
- `selftest.mjs`（0.4.2，临时家目录 + 假 agents）：20 个工具全注册，`toolsOk/routesOk/planOk/playNowOk/handoffOk/commentDraftOk/feedOk/sessionsOk/personaSaved/voiceSaved/atPolicySaved/bindOk/activated/httpOk/httpSessionsOk` 全 true，`errors: []`；`atPolicySaved` 断言 `atEnabled===true`、`atMaxPerDay===2`、`atTargets[0]` 是「主人 / 3546830222657967」。
- 0.4.2 另外验过（`D:\\plugins\\.tmp\botcheck\check5.mjs`）：`buildPlayPrompt` 在「开了 @ 且有名单」时输出 `主人(3546830222657967)、大肥鱼打游戏(3546707958696755)` + 「第一个是主人」+「名单外的人一律不许 @」，关闭或无名单时输出「不要 @ 任何人」；`makeDraft()` 的 `atName/atUid` 指向**主人**而不是 toy 作者。
- 0.4.2 设置页离线渲染（展开函数组件后 166 节点）：同一组「评论与 @」里依次出现「是否评论 / 是否 @ 人 / 每天最多 @ / 可以 @ 的人」，两个复选框都在，且没有「@ 作者」。`parseTargets()` 把「名字,mid」逐行转成 `[{name,uid}]`。
- 0.4.1 另外验过：`buildPlayPrompt` 三种分支（真发 + @ / 真发不 @ / dryRun 只写草稿）文案正确，含「玩完之后再评价」、不含「每 2~3 分钟用 bot_say」；`allowedByFilters` 对白名单作者放行、非白名单返回「作者不在白名单」。
- 之前 `ECONNRESET`、`spawn EPERM` 全是 `workspace-write` 沙箱造成的假象，`danger-full-access` 下 CDP 全链路可用。

## 踩坑记录

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 设置页「读状态失败：HTTP 404」 | `dsh-host-webserver` 调 `route.handler(req, res)` **只传两个参数**，代码却读第三个参数 `url?.pathname` → 恒为空 → 落到自己的 404 兜底 | 从 `req.url` 自己 `new URL()` 解析并剥掉 `/api/bili-toy-bot` 前缀；`selftest.mjs` 也改成只传两个参数，防止假测试再骗过 |
| 改源码不生效 | Node ESM 按 URL 缓存模块；HMR 只监听 cordis 配置文件，不监听插件源码 | 改宿主代码要重启 DSH Desktop；`client.js` 刷新页面即可 |
| 点「玩一局」没反应 | ① 旧逻辑是插件自己 headless 玩，会话里看不到任何东西；② `/play` 因为 handler 少参数一直 404；③ 往会话 append 消息没带 `intent.surfaceOp` 被宿主拒 | 0.4.0 改成 `agent.followup()` 把任务发进会话（面板同步回执），并给所有 `user/message` 追加补 `intent: { surfaceOp: 'append' }` |
| 定时开工必报 `d.getHours is not a function` | `minutesLeftInWindow(分钟数, slots)` 传参错了（它要 Date） | 传 `new Date()`；这条只在 `dryRun=false` 的定时分支里才会踩到，之前一直没测到 |
| 自检把真实配置写坏 | `selftest.mjs` 用的是真实 `C:\Users\<你>\.dsh\bili-toy-bot`，会改 sessionId / 人设 / 计数 | 自检开头把 `process.env.DSH_HOME` 指到临时目录 |

## 已知边界

- 只点「有文字的按钮」+ 画面中下方，复杂游戏（拖拽、连续操作、3D 走位）玩不好，属于"陪玩打卡"而不是"代打"。
- 个别 toy 有防盗链或需要登录才能开始（headless profile 没有你的登录态）。
- 评论走的是你的登录态（`%USERPROFILE%\.dsh\bili-toy\credential.json`），每局最多一条，`commentMaxPerDay` 兜底；**默认 `commentEnabled:false`**，不会自己乱评。
- `broadcastMode:'session'` 需要目标会话存在（`ctx.sessions.get(id)` 不为空），否则静默退回动态。
