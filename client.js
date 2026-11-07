/**
 * dsh-bili-toy-bot —— 浏览器半端（设置里的一页「玩toy机器人」）
 * ============================================================================
 * 自注册脚本：window.__ModuleLoader__.load({ id, factory })
 * 进设置：slots.register({ name: 'settings.section', id: 'bili-toy-bot', order: 33, label: '玩toy机器人' })
 * 只负责「看状态 + 改配置 + 点按钮」，真正的活在宿主半端做。
 *
 * 这一版的三件事：
 *   ① 绑定会话可展开：列出在线会话、一键绑定并激活、也能新建一个；
 *   ② 开局/收工的消息推进会话（面板里也有一条时间线）；
 *   ③ 人设 / 说话风格全部是自由文本，想怎么改就怎么改。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-toy-bot',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const API = '/api/bili-toy-bot'
    
    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status + (res.status === 403 ? '（被宿主拦了）' : ''))
    }
    const jget = (p) => fetch(API + p, { credentials: 'same-origin' }).then(asJson)
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(asJson)

    const CSS = `
    [data-bb-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:660px;}
    [data-bb-card]{border:1px solid var(--dsw-alias-border-secondary,#2c2f36);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;}
    [data-bb-title]{font-size:14px;font-weight:600;}
    [data-bb-group]{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c9ced6);margin-top:6px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-secondary,#2c2f36);}
    [data-bb-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
    [data-bb-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
    [data-bb-btn]{border:1px solid var(--dsw-alias-border-secondary,#3a3f47);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;}
    [data-bb-btn]:hover{background:rgba(127,127,127,.12);}
    [data-bb-btn][data-primary]{background:#1a73e8;border-color:#1a73e8;color:#fff;}
    [data-bb-btn]:disabled{opacity:.5;cursor:default;}
    [data-bb-badge]{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,#3a3f47);}
    [data-bb-badge][data-on]{border-color:#2e7d32;color:#3ddc84;}
    [data-bb-input]{background:transparent;border:1px solid var(--dsw-alias-border-secondary,#3a3f47);border-radius:8px;padding:6px 10px;color:inherit;font-size:12px;width:180px;}
    [data-bb-check]{width:16px;height:16px;margin-top:4px;accent-color:#3ddc84;}
    [data-bb-area]{background:transparent;border:1px solid var(--dsw-alias-border-secondary,#3a3f47);border-radius:8px;padding:6px 10px;color:inherit;font-size:12px;width:100%;min-height:52px;resize:vertical;font-family:inherit;line-height:18px;}
    [data-bb-list]{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto;}
    [data-bb-item]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#c4c8ce);border-left:2px solid rgba(127,127,127,.35);padding-left:8px;}
    [data-bb-field]{display:flex;align-items:flex-start;gap:8px;font-size:12px;}
    [data-bb-field]>span:first-child{min-width:96px;padding-top:6px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
    [data-bb-field]>[data-bb-grow]{flex:1;min-width:0;}
    [data-bb-head]{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;}
    [data-bb-chip]{font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(26,115,232,.14);color:#8ab4f8;}
    [data-bb-srow]{display:flex;align-items:center;gap:8px;justify-content:space-between;border:1px solid var(--dsw-alias-border-secondary,#2c2f36);border-radius:8px;padding:6px 8px;}
    [data-bb-srow][data-bound]{border-color:#1a73e8;}
    `

    const fmtTime = (t) => {
      if (!t) return ''
      const d = new Date(t)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    const Badge = ({ on, children }) => h('span', { 'data-bb-badge': '', 'data-on': on ? '' : undefined }, children)
    const Field = ({ label, children }) => h('div', { 'data-bb-field': '' }, h('span', {}, label), h('div', { 'data-bb-grow': '' }, children))
    const Area = ({ value, onChange, rows = 3, placeholder }) => h('textarea', {
      'data-bb-area': '', rows, value: value || '', placeholder: placeholder || '',
      onChange: (e) => onChange(e.target.value),
    })

    const lines = (text) => String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const splitList = (text) => String(text || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
    // 「能 @ 的人」：一行一个人 {name, uid}；第一行当「主人」，mid 留空就只写昵称
    const cleanTargets = (list) => (Array.isArray(list) ? list : [])
      .map((t) => ({ name: String(t?.name || '').trim(), uid: String(t?.uid || '').trim() }))
      .filter((t) => t.name || t.uid)

    function Panel() {
      const [status, setStatus] = useState(null)
      const [feed, setFeed] = useState([])
      const [runs, setRuns] = useState([])
      const [comments, setComments] = useState([])
      const [sessions, setSessions] = useState({ ok: false, items: [], why: '' })
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')
      const [form, setForm] = useState(null)
      const [sessionOpen, setSessionOpen] = useState(false)
      const [voiceOpen, setVoiceOpen] = useState(false)
      const [voicePreview, setVoicePreview] = useState(null)
      const timer = useRef(null)

      // 「能 @ 的人」列表：加一行 / 改一行 / 删一行
      const setTarget = (i, patch) => setForm((f) => ({
        ...f,
        atTargets: (f.atTargets || []).map((t, j) => (j === i ? { ...t, ...patch } : t)),
      }))
      const addTarget = () => setForm((f) => ({ ...f, atTargets: [...(f.atTargets || []), { name: '', uid: '' }] }))
      const delTarget = (i) => setForm((f) => ({ ...f, atTargets: (f.atTargets || []).filter((_, j) => j !== i) }))

      const load = async () => {
        try {
          const s = await jget('/status')
          setStatus(s)
          setForm((f) => f || {
            slots: s.config?.slots || '12:00-23:00',
            maxMinutesPerToy: s.config?.maxMinutesPerToy ?? 20,
            maxRunsPerDay: s.config?.maxRunsPerDay ?? 6,
            minGapMinutes: s.config?.minGapMinutes ?? 20,
            heartbeatSeconds: s.config?.heartbeatSeconds ?? 10,
            commentMaxPerDay: s.config?.commentMaxPerDay ?? 5,
            commentEnabled: s.config?.commentEnabled === true,
            atEnabled: s.config?.atEnabled === true,
            atMaxPerDay: s.config?.atMaxPerDay ?? 1,
            atTargets: cleanTargets(s.config?.atTargets),
            allowAuthors: (s.config?.allowAuthors || []).join('\n'),
            allowSlugs: (s.config?.allowSlugs || []).join('\n'),
            blacklistKeywords: (s.config?.blacklistKeywords || []).join('，'),
            playMode: s.config?.playMode || 'session',
            playPrompt: s.config?.playPrompt || '',
            broadcastMode: s.config?.broadcastMode || 'feed',
            sessionId: s.config?.sessionId || '',
            stylesText: (s.config?.styles || []).join('，'),
            personaName: s.config?.persona?.name || '小鲸鱼',
            personaSpecies: s.config?.persona?.species || '',
            personaTemperament: s.config?.persona?.temperament || '',
            personaCatchphrases: (s.config?.persona?.catchphrases || []).join('\n'),
            personaBio: s.config?.persona?.bio || '',
            voiceStyleText: s.config?.voice?.styleText || '',
            voiceCatchphrase: s.config?.voice?.catchphrase || '',
            voiceCommentTemplate: s.config?.voice?.commentTemplate || '',
            voiceAnnounceTemplate: s.config?.voice?.announceTemplate || '',
            voiceProgressTemplate: s.config?.voice?.progressTemplate || '',
          })
        } catch (e) { setMessage('读状态失败：' + e.message) }
      }
      const loadLists = async () => {
        try {
          const [f, r, c, ss] = await Promise.all([jget('/feed'), jget('/runs'), jget('/comments'), jget('/sessions')])
          if (f.ok) setFeed(f.items || [])
          if (r.ok) setRuns(r.runs || [])
          if (c.ok) setComments(c.items || [])
          setSessions(ss || { ok: false, items: [], why: '读不到会话' })
        } catch (e) { /* 忽略 */ }
      }

      useEffect(() => {
        load()
        loadLists()
        timer.current = setInterval(() => { load(); loadLists() }, 8000)
        return () => { if (timer.current) clearInterval(timer.current) }
      }, [])

      const save = async () => {
        if (!form) return
        setBusy('save'); setMessage('')
        try {
          const patch = {
            slots: String(form.slots || ''),
            maxMinutesPerToy: Number(form.maxMinutesPerToy) || 20,
            maxRunsPerDay: Number(form.maxRunsPerDay) || 6,
            minGapMinutes: Number(form.minGapMinutes) || 0,
            heartbeatSeconds: Math.max(2, Number(form.heartbeatSeconds) || 10),
            commentMaxPerDay: Number(form.commentMaxPerDay) || 0,
            commentEnabled: !!form.commentEnabled,
            atEnabled: !!form.atEnabled,
            atMaxPerDay: Number(form.atMaxPerDay) || 0,
            atTargets: cleanTargets(form.atTargets),
            allowAuthors: lines(form.allowAuthors),
            allowSlugs: lines(form.allowSlugs),
            blacklistKeywords: splitList(form.blacklistKeywords),
            playMode: form.playMode,
            playPrompt: String(form.playPrompt || ''),
            broadcastMode: form.broadcastMode,
            sessionId: String(form.sessionId || ''),
            styles: splitList(form.stylesText),
            persona: {
              name: String(form.personaName || '小鲸鱼'),
              species: String(form.personaSpecies || ''),
              temperament: String(form.personaTemperament || ''),
              catchphrases: lines(form.personaCatchphrases),
              bio: String(form.personaBio || ''),
            },
            voice: {
              styleText: String(form.voiceStyleText || ''),
              catchphrase: String(form.voiceCatchphrase || ''),
              commentTemplate: String(form.voiceCommentTemplate || ''),
              announceTemplate: String(form.voiceAnnounceTemplate || ''),
              progressTemplate: String(form.voiceProgressTemplate || ''),
            },
          }
          const r = await jpost('/config', { patch })
          if (r.ok) {
            setStatus((s) => ({ ...(s || {}), config: r.config }))
            setMessage('已保存')
            loadLists()
          } else setMessage('保存失败：' + (r.message || ''))
        } catch (e) { setMessage('保存失败：' + e.message) } finally { setBusy('') }
      }

      const toggle = async (key) => {
        const on = key === 'enabled' ? !status?.enabled : !status?.config?.[key]
        setBusy(key)
        try {
          if (key === 'enabled') await jpost(on ? '/start' : '/stop')
          else await jpost('/config', { patch: { [key]: on } })
          await load()
        } catch (e) { setMessage('操作失败：' + e.message) } finally { setBusy('') }
      }

      const playNow = async () => {
        setBusy('play'); setMessage('')
        try {
          // 只发这一次要跑的时长（跟着「单局最长」走），不改配置；不传 minutes 就用配置里的值
          const cap = Number(form?.maxMinutesPerToy) > 0 ? Number(form.maxMinutesPerToy) : 0
          const r = await jpost('/play', cap ? { minutes: cap } : {})
          if (r.ok && r.mode === 'session') {
            setMessage(r.via === 'followup'
              ? '这一局已经交给会话了 —— 切到绑定的那个会话，就能看到它开工'
              : ('已写进会话：' + (r.message || '会话下一轮会看到')))
          } else if (r.ok) {
            setMessage(r.dryRun ? '已开始（插件自己玩）：dryRun 只影响评论，只写草稿' : '已开始：插件自己在后台玩')
          } else {
            setMessage(r.message || '没能开始')
          }
          setTimeout(() => { load(); loadLists() }, 1500)
        } catch (e) { setMessage('开始失败：' + e.message) } finally { setBusy('') }
      }

      const bindSession = async (id) => {
        setBusy('bind:' + id); setMessage('')
        try {
          const r = await jpost('/session/bind', { sessionId: id })
          setMessage(r.ok ? (r.activated ? '已绑定并激活：会话里应该能看到它说话了' : '已绑定，但那个会话现在不在线') : ('绑定失败：' + (r.why || '')))
          setForm((f) => (f ? { ...f, sessionId: id, broadcastMode: 'session' } : f))
          await load(); await loadLists()
        } catch (e) { setMessage('绑定失败：' + e.message) } finally { setBusy('') }
      }

      const createSession = async () => {
        setBusy('create'); setMessage('')
        try {
          const r = await jpost('/session/create', {})
          setMessage(r.ok ? '新会话建好了，并且已经绑定' : ('新建失败：' + (r.message || '')))
          if (r.ok) setForm((f) => (f ? { ...f, sessionId: r.sessionId, broadcastMode: 'session' } : f))
          await load(); await loadLists()
        } catch (e) { setMessage('新建失败：' + e.message) } finally { setBusy('') }
      }

      const unbindSession = async () => {
        setBusy('unbind'); setMessage('')
        try {
          await jpost('/session/unbind')
          setForm((f) => (f ? { ...f, sessionId: '', broadcastMode: 'feed' } : f))
          setMessage('已解除绑定，播报回落到「动态」')
          await load()
        } catch (e) { setMessage('解绑失败：' + e.message) } finally { setBusy('') }
      }

      const testSession = async () => {
        setBusy('test'); setMessage('')
        try {
          const r = await jpost('/session/test', {})
          setMessage(r.ok ? '已把一句话发进绑定会话，去会话里看看' : ('没发进去：' + (r.why || r.message || '')))
        } catch (e) { setMessage('发送失败：' + e.message) } finally { setBusy('') }
      }

      const previewVoice = async () => {
        setBusy('voice'); setMessage('')
        try {
          const r = await jpost('/voice/comment', { title: '测试小游戏', minutes: 5, actions: 9 })
          setVoicePreview(r)
          if (!r.ok) setMessage('预览失败：' + (r.skip || ''))
        } catch (e) { setMessage('预览失败：' + e.message) } finally { setBusy('') }
      }

      const s = status || {}
      const cfg = s.config || {}
      const bound = s.session || {}
      const voiceInfo = s.voice || {}
      const progressItems = feed.filter((x) => x.kind === 'progress' || x.kind === 'run')
      const sessionItems = sessions.items || []

      return h('div', { 'data-bb-page': '' },

        /* ── 状态 ── */
        h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-row': '' },
            h('span', { 'data-bb-title': '' }, '玩 toy 机器人'),
            h(Badge, { on: s.enabled }, s.enabled ? '已开启' : '已关闭'),
            h(Badge, { on: s.playMode === 'session' }, s.playMode === 'session' ? '交给会话玩' : '插件自己玩'),
            h(Badge, { on: s.commentEnabled && s.dryRun === false }, s.commentEnabled && s.dryRun === false ? '真发评论' : '评论只写草稿'),
            h(Badge, { on: s.playing }, s.playing ? '正在开始…' : '空闲'),
            h(Badge, { on: bound.online }, bound.online ? '会话已连' : '会话未连'),
          ),
          h('div', { 'data-bb-note': '' },
            '时段 ' + (s.slots || '—') + ' · ' + (s.hint || '') + (s.version ? ' · v' + s.version : '')),
          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', 'data-primary': '', disabled: !!busy, onClick: () => toggle('enabled') },
              s.enabled ? '停一下' : '开起来'),
            h('button', { 'data-bb-btn': '', disabled: !!busy || s.playing, onClick: playNow }, s.playing ? '正在交接…' : '立刻玩一局'),
            h('button', { 'data-bb-btn': '', disabled: !!busy, onClick: () => toggle('dryRun') },
              s.dryRun === false ? '评论只写草稿' : '评论真的发'),
          ),
          h('div', { 'data-bb-note': '' },
            '今天玩了 ' + (s.state?.runsToday ?? 0) + '/' + (cfg.maxRunsPerDay ?? '?') + ' 局，' +
            (s.state?.minutesToday ?? 0) + ' 分钟；评论 ' + (s.state?.commentsToday ?? 0) + ' 条，@ ' + (s.state?.atsToday ?? 0) + ' 次。'),
          h('div', { 'data-bb-note': '' },
            '看表：' + (s.heartbeat?.at
              ? (s.heartbeat.ageSec <= 1 ? '刚刚' : s.heartbeat.ageSec + ' 秒前') + '（每 ' + (s.heartbeat.everySec || 10) + ' 秒看一眼，共 ' + (s.heartbeat.beats || 0) + ' 次）'
              : '还没看过（插件刚起，等 ' + (cfg.heartbeatSeconds || 10) + ' 秒）') +
            ' · 两局间隔 ' + (cfg.minGapMinutes ?? 20) + ' 分钟' +
            (s.state?.lastRunAt ? '（上一局 ' + fmtTime(s.state.lastRunAt) + '）' : '') + '。'),
          message ? h('div', { 'data-bb-note': '' }, message) : null,
        ),

        /* ── 绑定会话（可展开） ── */
        h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-head': '', onClick: () => setSessionOpen((v) => !v) },
            h('span', { 'data-bb-title': '' }, (sessionOpen ? '▾ ' : '▸ ') + '绑定会话'),
            h('span', { 'data-bb-row': '' },
              bound.id
                ? h('span', { 'data-bb-chip': '' }, bound.online ? '已绑定：在线' : '已绑定：离线')
                : h('span', { 'data-bb-note': '' }, '还没绑定'),
            ),
          ),
          h('div', { 'data-bb-note': '' },
            bound.id
              ? ('会话 ' + String(bound.id).slice(0, 18) + (String(bound.id).length > 18 ? '…' : '') +
                 (bound.preview ? ' · 最近：' + bound.preview : '') + (bound.events ? ' · ' + bound.events + ' 条事件' : ''))
              : '展开后选一个会话：以后玩 toy 的开局和收工消息都发到那里，你在那个会话里就能看到它今天玩了什么。'),
          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', disabled: !!busy, onClick: () => setSessionOpen((v) => !v) },
              sessionOpen ? '收起列表' : '展开会话列表'),
            h('button', { 'data-bb-btn': '', disabled: !!busy, onClick: createSession }, '新建一个并绑定'),
            h('button', { 'data-bb-btn': '', disabled: !!busy || !bound.id, onClick: testSession }, '发条测试消息'),
            h('button', { 'data-bb-btn': '', disabled: !!busy || !bound.id, onClick: unbindSession }, '解绑'),
          ),
          sessionOpen ? h('div', { 'data-bb-list': '' },
            sessions.ok === false ? h('div', { 'data-bb-note': '' }, '读不到会话：' + (sessions.why || '')) : null,
            sessionItems.length
              ? sessionItems.map((it) => h('div', { 'data-bb-srow': '', key: it.id, 'data-bound': it.id === String(cfg.sessionId || '') ? '' : undefined },
                h('div', { 'data-bb-item': '', style: { borderLeft: 'none', paddingLeft: 0 } },
                  h('div', {}, it.id + (it.id === String(cfg.sessionId || '') ? ' · 当前绑定' : '')),
                  h('div', { 'data-bb-note': '' }, (it.createdAt ? fmtTime(it.createdAt) + ' · ' : '') + (it.events || 0) + ' 条事件' + (it.preview ? ' · ' + it.preview : '')),
                ),
                h('button', { 'data-bb-btn': '', 'data-primary': it.id === String(cfg.sessionId || '') ? '' : undefined, disabled: !!busy, onClick: () => bindSession(it.id) },
                  it.id === String(cfg.sessionId || '') ? '重新激活' : '绑定'),
              ))
              : h('div', { 'data-bb-note': '' }, '现在没有在线的会话（先在左边开一个会话再回来绑定）'),
          ) : null,
          h('div', { 'data-bb-note': '' },
            '播报去向：'),
        ),

        /* ── 配置 ── */
        form ? h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-title': '' }, '配置'),
          h(Field, { label: '时段' }, h('input', {
            'data-bb-input': '', value: form.slots,
            onChange: (e) => setForm({ ...form, slots: e.target.value }),
          })),
          h(Field, { label: '单局最长' }, h('input', {
            'data-bb-input': '', type: 'number', value: form.maxMinutesPerToy,
            onChange: (e) => setForm({ ...form, maxMinutesPerToy: e.target.value }),
          })),
          h(Field, { label: '每天最多' }, h('input', {
            'data-bb-input': '', type: 'number', value: form.maxRunsPerDay,
            onChange: (e) => setForm({ ...form, maxRunsPerDay: e.target.value }),
          }), h('span', { 'data-bb-note': '' }, '局/天')),
          h(Field, { label: '两局间隔' }, h('input', {
            'data-bb-input': '', type: 'number', value: form.minGapMinutes,
            onChange: (e) => setForm({ ...form, minGapMinutes: e.target.value }),
          }), h('span', { 'data-bb-note': '' }, '分钟：上一局玩完之后，至少隔这么久才开下一局')),
          h('div', { 'data-bb-group': '' }, '能 @ 的人'),
          h('div', { 'data-bb-note': '' }, '只许 @ 名单里的人，名单外一律不 @。第一行当「主人」；mid 留空就只写昵称（不是真 @）。'),
          ...(form.atTargets || []).map((t, i) => h('div', { 'data-bb-row': '', key: 'at-' + i },
            h('span', { 'data-bb-note': '' }, i === 0 ? '主人' : '#' + (i + 1)),
            h('input', {
              'data-bb-input': '', placeholder: '昵称', value: t.name,
              onChange: (e) => setTarget(i, { name: e.target.value }),
            }),
            h('input', {
              'data-bb-input': '', placeholder: 'mid（可留空）', value: t.uid,
              onChange: (e) => setTarget(i, { uid: e.target.value }),
            }),
            h('button', { 'data-bb-btn': '', onClick: () => delTarget(i) }, '删'),
          )),
          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', onClick: addTarget }, '+ 添加一个能 @ 的人'),
            h('span', { 'data-bb-note': '' }, '按顺序 @：第一个是主人，后面的当备选')),
          h(Field, { label: '看表间隔' }, h('input', {
            'data-bb-input': '', type: 'number', value: form.heartbeatSeconds,
            onChange: (e) => setForm({ ...form, heartbeatSeconds: e.target.value }),
          }), h('span', { 'data-bb-note': '' }, '秒：每隔几秒看一眼"现在该不该开工"（默认 10 秒）')),
          h(Field, { label: '评论上限' }, h('input', {            'data-bb-input': '', type: 'number', value: form.commentMaxPerDay,
            onChange: (e) => setForm({ ...form, commentMaxPerDay: e.target.value }),
          }), h('span', { 'data-bb-note': '' }, '条/天')),
          h('div', { 'data-bb-group': '' }, '评论与 @'),
          h(Field, { label: '是否评论' }, h('input', {
            'data-bb-check': '', type: 'checkbox', checked: !!form.commentEnabled,
            onChange: (e) => setForm({ ...form, commentEnabled: e.target.checked }),
          }), h('span', { 'data-bb-note': '' }, '勾上 = 玩完可以评论；不勾只写点评、不发出去')),
          h(Field, { label: '是否 @ 人' }, h('input', {
            'data-bb-check': '', type: 'checkbox', checked: !!form.atEnabled,
            onChange: (e) => setForm({ ...form, atEnabled: e.target.checked }),
          }), h('span', { 'data-bb-note': '' }, '勾上 = 评论里 @ 下面名单里的人（默认 @ 主人）；不勾就不 @ 任何人')),
          h(Field, { label: '每天最多 @' }, h('input', {
            'data-bb-input': '', type: 'number', value: form.atMaxPerDay,
            onChange: (e) => setForm({ ...form, atMaxPerDay: e.target.value }),
          }), h('span', { 'data-bb-note': '' }, '次/天，0 = 不 @')),
          h(Field, { label: '怎么玩' }, h('select', {
            'data-bb-input': '', value: form.playMode,
            onChange: (e) => setForm({ ...form, playMode: e.target.value }),
          },
            h('option', { value: 'session' }, '交给绑定会话玩（推荐）'),
            h('option', { value: 'headless' }, '插件自己开浏览器玩'),
          ), h('span', { 'data-bb-note': '' }, '交给会话 = 把整局任务当提示词发进去，由会话自己挑游戏、打开、操作、收工、评论')),
          h(Field, { label: '播报去向' }, h('select', {
            'data-bb-input': '', value: form.broadcastMode,
            onChange: (e) => setForm({ ...form, broadcastMode: e.target.value }),
          },
            h('option', { value: 'feed' }, '写到「动态」'),
            h('option', { value: 'session' }, '发到绑定会话'),
            h('option', { value: 'off' }, '不播报'),
          )),
          h(Field, { label: '开局提示词' }, h(Area, {
            rows: 4, value: form.playPrompt,
            placeholder: '留空用内置模板。可用占位符：{name} {minutes} {slots} {styles} {categories} {commentRule}',
            onChange: (v) => setForm({ ...form, playPrompt: v }),
          }), h('span', { 'data-bb-note': '' }, '就是发进会话的那段话，想让它怎么玩就怎么写')),
          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', 'data-primary': '', disabled: !!busy, onClick: save }, '保存'),
            h('span', { 'data-bb-note': '' }, '改完保存即可，不用重启'),
          ),
        ) : null,

        /* ── 白名单 / 黑名单 ── */
        form ? h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-title': '' }, '白名单 / 黑名单'),
          h(Field, { label: '只玩这些 UP 主' }, h(Area, {
            rows: 3, value: form.allowAuthors,
            placeholder: '一行一个：昵称或 mid（比如\n大肥鱼打游戏\n3546707958696755）',
            onChange: (v) => setForm({ ...form, allowAuthors: v }),
          }), h('span', { 'data-bb-note': '' }, '留空 = 不限作者；填了就只玩这些作者发布的 toy')),
          h(Field, { label: '只玩这些 toy' }, h(Area, {
            rows: 2, value: form.allowSlugs,
            placeholder: '一行一个 slug（链接 /toy/xxxx/index.html 里那串）',
            onChange: (v) => setForm({ ...form, allowSlugs: v }),
          }), h('span', { 'data-bb-note': '' }, '留空 = 不限；只影响插件自己挑的那条路（交给会话时会话按提示词挑）')),
          h(Field, { label: '不玩的关键词' }, h(Area, {
            rows: 2, value: form.blacklistKeywords,
            placeholder: '逗号分隔，比如：抽奖，充值，广告，扫码，实名',
            onChange: (v) => setForm({ ...form, blacklistKeywords: v }),
          }), h('span', { 'data-bb-note': '' }, '标题里带这些词的直接跳过')),
          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', 'data-primary': '', disabled: !!busy, onClick: save }, '保存'),
            h('span', { 'data-bb-note': '' }, '和上面「配置」共用同一个保存按钮'),
          ),
        ) : null,

        /* ── 人设（全部可编辑文本） ── */
        form ? h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-title': '' }, '人设'),
          h('div', { 'data-bb-note': '' }, '这些字直接决定它怎么说话、怎么看自己。'),
          h(Field, { label: '名字' }, h('input', {
            'data-bb-input': '', value: form.personaName,
            onChange: (e) => setForm({ ...form, personaName: e.target.value }),
          })),
          h(Field, { label: '物种 / 形象' }, h('input', {
            'data-bb-input': '', value: form.personaSpecies, placeholder: '比如：蓝鲸 / 一条蓝色大肥鱼',
            onChange: (e) => setForm({ ...form, personaSpecies: e.target.value }),
          })),
          h(Field, { label: '性格' }, h(Area, {
            rows: 2, value: form.personaTemperament, placeholder: '好奇、话少、偶尔毒舌…',
            onChange: (v) => setForm({ ...form, personaTemperament: v }),
          })),
          h(Field, { label: '口头禅' }, h(Area, {
            rows: 2, value: form.personaCatchphrases, placeholder: '一行一条，比如：\n这个有点意思\n……看不懂但大受震撼',
            onChange: (v) => setForm({ ...form, personaCatchphrases: v }),
          })),
          h(Field, { label: '来历' }, h(Area, {
            rows: 2, value: form.personaBio, placeholder: '从哪来的、为什么在直播间玩 toy…',
            onChange: (v) => setForm({ ...form, personaBio: v }),
          })),
          h(Field, { label: '选片口味' }, h('input', {
            'data-bb-input': '', value: form.stylesText, placeholder: '休闲，沙雕，解谜',
            onChange: (e) => setForm({ ...form, stylesText: e.target.value }),
          }), h('span', { 'data-bb-note': '' }, '逗号分隔')),
        ) : null,

        /* ── 说话风格（自由文本 + 模板） ── */
        form ? h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-head': '', onClick: () => setVoiceOpen((v) => !v) },
            h('span', { 'data-bb-title': '' }, (voiceOpen ? '▾ ' : '▸ ') + '说话风格 / 模板'),
            h('span', { 'data-bb-note': '' }, voiceInfo.available ? '模型可用' : '模型不可用（用模板）'),
          ),
          h(Field, { label: '说话风格' }, h(Area, {
            rows: 3, value: form.voiceStyleText,
            placeholder: '用你自己的话写，比如：嘴贫一点，句子短，爱自嘲，偶尔用颜文字，不许说“感谢观看”这种客服腔',
            onChange: (v) => setForm({ ...form, voiceStyleText: v }),
          })),
          h('div', { 'data-bb-note': '' }, '填了它，评论会先让模型按这段话现写一句；写不出来才用下面的模板。'),
          voiceOpen ? h('div', { 'data-bb-page': '' },
            h(Field, { label: '口头禅' }, h('input', {
              'data-bb-input': '', value: form.voiceCatchphrase, placeholder: '留空就从人设里抽',
              onChange: (e) => setForm({ ...form, voiceCatchphrase: e.target.value }),
            })),
            h(Field, { label: '评论模板' }, h(Area, {
              rows: 2, value: form.voiceCommentTemplate,
              placeholder: '比如：刚玩了《{title}》{minutes} 分钟，{catchphrase}',
              onChange: (v) => setForm({ ...form, voiceCommentTemplate: v }),
            })),
            h('div', { 'data-bb-note': '' }, '可用：{title} 游戏名、{minutes} 分钟数、{n} 动作数、{author} 作者、{catchphrase} 口头禅'),
            h(Field, { label: '开局模板' }, h(Area, {
              rows: 2, value: form.voiceProgressTemplate,
              placeholder: '比如：开工，今天先玩「{title}」，最多 {minutes} 分钟',
              onChange: (v) => setForm({ ...form, voiceProgressTemplate: v }),
            })),
            h('div', { 'data-bb-note': '' }, '只用开局那一次；玩的过程中不再播报进度，玩完用点评（bot_say）收尾'),
            h(Field, { label: '收工模板' }, h(Area, {
              rows: 2, value: form.voiceAnnounceTemplate,
              placeholder: '比如：玩了「{title}」{minutes} 分钟，动了 {actions} 下{comment}',
              onChange: (v) => setForm({ ...form, voiceAnnounceTemplate: v }),
            })),
            h('div', { 'data-bb-note': '' }, '可用：{title}、{minutes}、{actions}、{comment}'),
          ) : null,
          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', disabled: !!busy, onClick: previewVoice }, '试写一条评论'),
            voicePreview ? h('span', { 'data-bb-note': '' },
              (voicePreview.via === 'model' ? '模型现写：' : '模板：') + (voicePreview.text || '（空）') +
              (voicePreview.note ? ' · ' + voicePreview.note : '')) : null,
          ),
          h('div', { 'data-bb-row': '' },
            h('button', { 'data-bb-btn': '', 'data-primary': '', disabled: !!busy, onClick: save }, '保存人设 / 风格'),
          ),
        ) : null,

        /* ── 实时进度 ── */
        h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-title': '' }, '这一局的消息' + (bound.online ? '（会话已连，开局/收工会发过去）' : '')),
          h('div', { 'data-bb-list': '' },
            progressItems.length ? progressItems.slice(0, 12).map((x, i) => h('div', { 'data-bb-item': '', key: i },
              fmtTime(x.at) + ' · ' + (x.kind === 'progress' ? '进度' : '收工') + ' · ' + (x.text || '') + (x.via === 'session' ? ' · 已发会话' : ''))) :
              h('div', { 'data-bb-note': '' }, '还没有消息（真玩一局才会有）')),
        ),

        /* ── 最近的局 ── */
        h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-title': '' }, '最近的局'),
          h('div', { 'data-bb-list': '' },
            runs.length ? runs.slice(0, 8).map((r) => h('div', { 'data-bb-item': '', key: r.id },
              fmtTime(r.createdAt) + ' · ' + (r.toy || '?') + ' · ' + (r.minutes || 0) + ' 分钟 · ' + (r.status || '')
              + (r.comment ? ' · 评论：' + r.comment : '')
            )) : h('div', { 'data-bb-note': '' }, '还没有记录')),
        ),

        /* ── 动态 ── */
        h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-title': '' }, '动态'),
          h('div', { 'data-bb-list': '' },
            feed.length ? feed.slice(0, 12).map((x, i) => h('div', { 'data-bb-item': '', key: i },
              fmtTime(x.at) + ' · ' + (x.text || ''))) : h('div', { 'data-bb-note': '' }, '还没有播报')),
        ),

        /* ── 评论 ── */
        h('div', { 'data-bb-card': '' },
          h('div', { 'data-bb-title': '' }, '评论'),
          h('div', { 'data-bb-list': '' },
            comments.length ? comments.slice(0, 10).map((x, i) => h('div', { 'data-bb-item': '', key: i },
              (x.sent ? '已发 ' : '草稿 ') + '· ' + (x.toy || '') + ' · ' + (x.text || ''))) :
              h('div', { 'data-bb-note': '' }, '还没有评论草稿')),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-bili-toy-bot')
          style.textContent = CSS
          document.head.appendChild(style)
          if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'bili-toy-bot: 设置页样式')
        } catch (e) { /* 忽略 */ }

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        try {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'bili-toy-bot', order: 33, label: '玩toy机器人' },
            () => h(Panel),
          ))
        } catch (e) { /* 忽略 */ }
      },
    }
  },
})
