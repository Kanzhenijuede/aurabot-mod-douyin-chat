/**
 * 抖音聊天 —— 让 Aurabot 驻扎在抖音。
 *
 * 她自己的抖音号里，私信会被这个模块读出来，交给她（带人格、带心情、带记忆）回；
 * 每个人单独计数、单独节奏，默认「只读不发送」，要先在面板里关掉试运行才真的发。
 *
 * 组成：
 *   lib/cdp.mjs    专用浏览器 + CDP（Edge/Chrome，独立资料目录，登录状态在本地）
 *   lib/chat.mjs   抖音私信：列会话、打开、读消息、发消息
 *   lib/policy.mjs 要不要回（名单、免打扰、每日上限、间隔）——纯函数，可单测
 *   lib/state.mjs  看到哪、回过几
 */
import { join, resolve } from 'node:path'
import { createBrowser } from './lib/cdp.mjs'
import { createChat } from './lib/chat.mjs'
import { chunkReply, decide, isSilence, parseIds } from './lib/policy.mjs'
import { isSeen, loadState, markReplied, markSeen, personState, saveState, summarize } from './lib/state.mjs'

const TITLE = '抖音 · '

export default {
  id: 'douyin-chat',
  name: '抖音聊天',  version: '0.1.0',
  api: 1,
  description: '让她驻扎在抖音：读私信、按人格回，按人单独计数和节奏，默认只读不发送。',

  defaults: {
    enabled: false,
    dryRun: true,
    pollMinutes: 3,
    conversationsPerTick: 3,
    replyStrangers: false,
    allowList: '',
    ignoreList: '',
    maxPerPersonPerDay: 12,
    maxPerDay: 40,
    minGapSeconds: 20,
    quietStart: '23:30',
    quietEnd: '08:00',
    freshMinutes: 180,
    maxChars: 120,
    lines: 2,
    profile: 'shared',
    browserPath: '',
  },

  settings: [
    { key: 'enabled', label: '打开抖音聊天', type: 'switch', hint: '关着时一句都不会发，也不会启动浏览器' },
    { key: 'dryRun', label: '试运行（只写日志不发送）', type: 'switch', hint: '第一次用建议开着，确认回复口气没问题再关' },
    { key: 'pollMinutes', label: '多久看一次私信（分钟）', type: 'number', min: 1, max: 120, step: 1 },
    { key: 'conversationsPerTick', label: '每轮最多看几个会话', type: 'number', min: 1, max: 20, step: 1, hint: '多的话轮着看，不会每轮都从头翻' },
    { key: 'replyStrangers', label: '陌生人也回', type: 'switch', hint: '关着时只回名单里的人（适合先小范围试）' },
    { key: 'allowList', label: '名单（抖音号 / uid / 昵称）', type: 'textarea', hint: '逗号或换行分隔；填写后这些人即使不是好友也回' },
    { key: 'ignoreList', label: '忽略名单', type: 'textarea', hint: '这些人一律不回（优先于名单）' },
    { key: 'maxPerPersonPerDay', label: '每人每天最多回几条', type: 'number', min: 0, max: 200, step: 1, hint: '0 = 不限' },
    { key: 'maxPerDay', label: '每天总共最多回几条', type: 'number', min: 0, max: 500, step: 1, hint: '0 = 不限' },
    { key: 'minGapSeconds', label: '两次发送至少隔几秒', type: 'number', min: 0, max: 600, step: 1 },
    { key: 'quietStart', label: '免打扰开始（HH:MM）', type: 'text', placeholder: '23:30' },
    { key: 'quietEnd', label: '免打扰结束（HH:MM）', type: 'text', placeholder: '08:00' },
    { key: 'freshMinutes', label: '只回多久以内的消息（分钟）', type: 'number', min: 1, max: 1440, step: 1, hint: 'DSH 关着那段时间的旧消息不追' },
    { key: 'maxChars', label: '每条最多几个字', type: 'number', min: 10, max: 300, step: 1 },
    { key: 'lines', label: '一条回复最多拆几条', type: 'number', min: 1, max: 5, step: 1 },
    { key: 'profile', label: '浏览器资料目录', type: 'select', options: [
      { value: 'shared', label: '和「刷抖音」共用（登录状态不用重新扫）' },
      { value: 'own', label: '本模块专用（各登各的）' },
    ] },
    { key: 'browserPath', label: '浏览器路径', type: 'text', placeholder: '留空自动找 Edge / Chrome' },
  ],

  setup(api) {
    const log = api.log
    const settings = () => ({ ...api.settings() })

    const baseDir = api.dataDir()
    const stateFile = join(baseDir, 'state.json')
    const sharedProfile = resolve(baseDir, '../../douyin/edge-profile')
    const profileDir = () => (settings().profile === 'own' ? join(baseDir, 'edge-profile') : sharedProfile)

    const browser = createBrowser({
      profileDir: profileDir(),
      browserPath: () => settings().browserPath || api.config()?.douyin?.browserPath || '',
      log,
    })
    const chat = createChat({ browser, log })

    const state = loadState(stateFile)
    const save = () => saveState(stateFile, state)
    let running = false
    let lastRun = { at: 0, trigger: '', result: null }

    const think = api.think
      ? (prompt, opts) => api.think(prompt, opts)
      : (prompt, opts) => api.core.hub.runSystemTurn('ext-douyin-chat', opts?.title || '抖音私信', prompt, opts)

    /** 把会话里的消息写成给她看的对话记录。 */
    function digest(messages, name) {
      return messages
        .map((m) => `${m.mine ? '你' : name}：${m.card ? `[分享了抖音视频《${m.card.title || '没标题'}》]` : m.text || '[图片或表情]'}`)
        .join('\n')
    }

    function prompt(messages, name, uid) {
      return (
        `【抖音私信：这是你在抖音上收到的私信，发消息的人是「${name}」（抖音 uid ${uid}），不是 QQ 上的朋友，也不是主人。` +
        `用你平时的口气回一两句，像发微信那样，别用 Markdown、别列清单、别说教。不想回就只输出 [沉默]。这一轮不能用工具。】\n` +
        `最近的私信（从旧到新）：\n${digest(messages, name)}\n\n只输出要发的话。`
      )
    }

    /** 处理一个会话：打开、读、判断、回。 */
    async function handleConversation(conversation, me, current) {
      const opened = await chat.openConversation(conversation)
      if (!opened) return { opened: false }
      const messages = await chat.waitMessages()
      if (!messages.length) return { opened: true, messages: 0 }

      const peer = conversation.tokens.find((token) => token && token !== me.uid) || messages.find((m) => !m.mine && m.uid)?.uid || ''
      if (!peer) return { opened: true, messages: messages.length, skipped: '认不出对方是谁' }

      // 会话没真的切过去时读到的是上一个人的消息：对方的 uid 一个都对不上就别动，免得回错人
      const others = messages.filter((m) => !m.mine && m.uid)
      if (others.length && !others.some((m) => m.uid === peer)) {
        return { opened: true, messages: messages.length, skipped: '读到的消息不属于这个会话，跳过' }
      }

      const inbound = messages.filter((m) => !m.mine && m.uid === peer && !isSeen(state, m.id))
      markSeen(state, messages.filter((m) => m.mine).map((m) => m.id))
      if (!inbound.length) return { opened: true, messages: messages.length, fresh: 0 }

      const name = conversation.name || (await chat.openChatName()) || `抖音用户${String(peer).slice(-4)}`
      const person = { uid: peer, name }
      const newest = inbound[inbound.length - 1]
      const counters = personState(state, peer)

      const verdict = decide({
        person,
        messageAt: newest.at,
        now: Date.now(),
        settings: current,
        state: counters,
        sentToday: state.sentToday || 0,
      })
      if (!verdict.reply) {
        const permanent = /陌生|忽略|太旧|未来/.test(verdict.reason)
        if (permanent) markSeen(state, inbound.map((m) => m.id))
        save()
        log.debug(`抖音私信（${name}）不回：${verdict.reason}`)
        return { opened: true, fresh: inbound.length, replied: 0, reason: verdict.reason }
      }

      const reply = await think(prompt(messages.slice(-14), name, peer), { title: `${TITLE}${name}`, timeoutMs: 150_000, noTools: true })
      const text = typeof reply === 'string' ? reply : String(reply?.text ?? reply ?? '')
      if (isSilence(text)) {
        markSeen(state, inbound.map((m) => m.id))
        save()
        log.info(`抖音私信（${name}）：她选择不回`)
        return { opened: true, fresh: inbound.length, replied: 0, reason: '她不想回' }
      }

      const chunks = chunkReply(text, { maxChars: Number(current.maxChars) || 120, lines: Number(current.lines) || 2 })
      if (!chunks.length) {
        markSeen(state, inbound.map((m) => m.id))
        save()
        return { opened: true, fresh: inbound.length, replied: 0, reason: '没生成出要发的话' }
      }

      if (current.dryRun) {
        log.info(`试运行：本来要在抖音私信里回 ${name}：${chunks.join(' / ')}`)
        markSeen(state, inbound.map((m) => m.id))
        save()
        return { opened: true, fresh: inbound.length, replied: 0, dryRun: chunks }
      }

      const sent = []
      try {
        for (const piece of chunks) {
          await chat.sendMessage(piece)
          sent.push(piece)
          markReplied(state, peer, { name })
          await new Promise((done) => setTimeout(done, 900 + Math.random() * 1600))
        }
        markSeen(state, inbound.map((m) => m.id))
        log.info(`抖音私信：回了 ${name} ${sent.length} 条`)
        return { opened: true, fresh: inbound.length, replied: sent.length, sent }
      } catch (error) {
        // 一条都没发出去：不记为看过，下次再试；发了半截：剩下的别补，避免语气断裂
        if (sent.length) markSeen(state, inbound.map((m) => m.id))
        log.warn(`抖音私信回 ${name} 失败：${error.message}`)
        return { opened: true, fresh: inbound.length, replied: sent.length, error: error.message }
      } finally {
        save()
      }
    }

    /** 一轮检查。定时入口按 pollMinutes 节流，手动入口（面板 / 工具）立即跑。 */
    async function tick(trigger = '定时') {
      const current = settings()
      if (!current.enabled) return { ok: false, message: '抖音聊天没打开' }
      if (running) return { ok: false, message: '上一轮还没跑完' }
      const interval = Math.max(1, Number(current.pollMinutes) || 3) * 60_000
      if (trigger === '定时' && Date.now() - lastRun.at < interval) return { ok: false, message: '还没到下一次' }

      running = true
      lastRun = { at: Date.now(), trigger, result: null }
      const summary = { trigger, conversations: 0, fresh: 0, replied: 0, notes: [] }
      try {
        const opened = await browser.open()
        if (!opened.ok) return { ok: false, message: opened.message }
        const me = await chat.self()
        if (!me) return { ok: false, message: '抖音没登录：先在面板里打开专用浏览器扫码登录' }

        const page = await chat.openChatPage()
        if (!page.ok) return { ok: false, message: `私信页没打开（${page.href || '停在别的页面'}）` }

        const conversations = await chat.listConversations()
        summary.conversations = conversations.length
        if (!conversations.length) {
          summary.notes.push('左栏没读到会话（页面可能还没加载好）')
          return { ok: true, ...summary }
        }

        const limit = Math.max(1, Number(current.conversationsPerTick) || 3)
        const total = conversations.length
        const start = (state.cursor || 0) % total
        const picked = []
        for (let i = 0; i < Math.min(limit, total); i++) picked.push(conversations[(start + i) % total])
        state.cursor = (start + picked.length) % total

        for (const conversation of picked) {
          try {
            const result = await handleConversation(conversation, me, current)
            if (result?.fresh) summary.fresh += result.fresh
            if (result?.replied) summary.replied += result.replied
            if (result?.error) summary.notes.push(`${conversation.conversationId}：${result.error}`)
            if (result?.reason) summary.notes.push(`${conversation.conversationId}：${result.reason}`)
            await new Promise((done) => setTimeout(done, 1200 + Math.random() * 1500))
          } catch (error) {
            summary.notes.push(`${conversation.conversationId}：${error.message}`)
            log.warn(`处理会话 ${conversation.conversationId} 出错：`, error.message)
          }
          save()
        }
        return { ok: true, ...summary }
      } catch (error) {
        log.warn('抖音聊天这一轮失败：', error.message)
        return { ok: false, message: error.message, ...summary }
      } finally {
        lastRun.result = summary
        running = false
        save()
      }
    }

    api.every(60_000, () => tick('定时'), '抖音私信')
    api.onDispose(() => browser.close())

    // ---- 面板接口 -----------------------------------------------------------
    api.route('/state', async () => ({
      ok: true,
      browser: browser.connected(),
      profile: profileDir(),
      settings: { ...settings(), allowList: undefined, ignoreList: undefined },
      state: summarize(state),
      lastRun,
    }))

    api.route('/conversations', async () => {
      if (!browser.connected()) return { ok: false, message: '浏览器没连上（先打开开关跑一轮，或在下面点「连上浏览器」）' }
      const list = await chat.listConversations()
      return { ok: true, conversations: list.map((c) => ({ id: c.conversationId, name: c.name, preview: c.preview, tokens: c.tokens })) }
    })

    api.route('/connect', async () => {
      const opened = await browser.open()
      const me = opened.ok ? await chat.self().catch(() => null) : null
      return { ok: opened.ok, message: opened.message || '', self: me }
    })

    api.route('/show', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      return chat.show(Boolean(body?.visible))
    })

    api.route('/shot', async () => ({ ok: true, shot: await chat.screenshot() }))

    api.route('/run', async () => tick('面板'))

    // 用接口改设置：面板表单之外还想自动化（或从 QQ 里让 DSH 帮她开/关）时用。
    // 只认下面这些键，别的忽略，避免一把把整个 ext 写坏。
    api.route('/settings', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const allowed = new Set(Object.keys(api.settings()))
      const patch = {}
      for (const [key, value] of Object.entries(body || {})) {
        if (!allowed.has(key)) continue
        if (key === 'browserPath' || key === 'allowList' || key === 'ignoreList' || key === 'quietStart' || key === 'quietEnd') {
          patch[key] = String(value ?? '')
        } else if (key === 'profile') {
          patch[key] = value === 'own' ? 'own' : 'shared'
        } else if (typeof api.settings()[key] === 'boolean') {
          patch[key] = Boolean(value)
        } else {
          const number = Number(value)
          patch[key] = Number.isFinite(number) ? number : api.settings()[key]
        }
      }
      if (!Object.keys(patch).length) return { ok: false, message: '没有可改的字段' }
      api.setConfig((current) => ({
        ...current,
        ext: { ...(current.ext || {}), [api.id]: { ...(current.ext?.[api.id] || {}), ...patch } },
      }))
      return { ok: true, settings: { ...settings(), allowList: undefined, ignoreList: undefined } }
    })

    api.route('/send', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const uid = String(body?.uid || '').trim()
      const text = String(body?.text || '').trim()
      if (!uid || !text) return { ok: false, message: '要 uid 和 text' }
      const opened = await browser.open()
      if (!opened.ok) return { ok: false, message: opened.message }
      const page = await chat.openChatPage()
      if (!page.ok) return { ok: false, message: '私信页没打开' }
      const list = await chat.listConversations()
      const hit = list.find((c) => c.tokens.includes(uid))
      if (!hit) return { ok: false, message: `左栏里没有和 ${uid} 的会话` }
      await chat.openConversation(hit)
      if (settings().dryRun && body?.force !== true) return { ok: false, message: '现在是试运行，带上 force 才会真发' }
      await chat.sendMessage(text)
      markReplied(state, uid, { name: hit.name })
      save()
      return { ok: true }
    })

    // 只读的名单解析结果，方便排查「为什么名单没生效」。
    api.route('/list', async () => ({ allow: [...parseIds(settings().allowList)], ignore: [...parseIds(settings().ignoreList)] }))

    log.info('抖音聊天已加载：默认只读，打开开关并关掉试运行后才会真的发私信')
    return { tick, state: () => summarize(state), browser: () => browser.connected() }
  },
}
