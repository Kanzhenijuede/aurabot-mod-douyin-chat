/**
 * 抖音私信：列会话、打开会话、读消息、发消息。
 *
 * 数据走两种路：
 *  - 自己的身份 / 用户资料：在页面里 fetch 抖音网页接口（签名由页面脚本自动加）
 *  - 会话列表 / 消息：读页面里 React 组件的 props（抖音的消息对象在 fiber 上，
 *    比扒 DOM 文本稳；这也是「刷抖音」模块验证过的做法）
 *
 * 所有元素标记都用 data-dychat-*，不和别的模块的 data-aurabot-* 打架。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const HOME = 'https://www.douyin.com/'
const CHAT = `${HOME}chat?isPopup=1`
const BASE = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '290100',
  version_name: '29.1.0',
  cookie_enabled: 'true',
  platform: 'PC',
  downlink: '10',
}
const NOT_LOGIN = new Set([8, 2190008])

const clean = (text, max = 300) => [...String(text ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')

/** 编辑器可能把 emoji 显示成图片；比较可见文字时要把它们去掉。 */
export function comparable(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\s\u00a0\u200b\u200d\ufe0f]|\p{Extended_Pictographic}|\p{Emoji_Modifier}/gu, '')
}

/** 会话 id `0:1:<a>:<b>` 里的两个人。 */
export function peerTokens(conversationId = '') {
  const parts = String(conversationId).split(':').slice(2)
  return parts.flatMap((x) => x.split(/[-_]/)).filter((x) => /^\d{3,}$/.test(x))
}

/**
 * @param {object} options
 * @param {object} options.browser lib/cdp.mjs 的浏览器
 * @param {{info:Function,warn:Function,debug:Function}} [options.log]
 */
export function createChat({ browser, log }) {
  const b = browser
  let selfCache = null

  async function api(path, params = {}) {
    const url = new URL(path, HOME)
    for (const [key, value] of Object.entries({ ...BASE, ...params })) url.searchParams.set(key, String(value))
    const result = await b.evaluate(
      `fetch(${JSON.stringify(url.toString())}, { credentials: 'include' }).then(async (r) => ({ status: r.status, text: await r.text() }))`,
    )
    if (!result || result.status !== 200) throw Object.assign(new Error(`抖音接口返回 ${result?.status || '空'}`), { code: result?.status })
    let json
    try {
      json = JSON.parse(result.text)
    } catch (error) {
      throw Object.assign(new Error('抖音接口返回的不是 JSON（可能被风控了）'), { code: 'bad' })
    }
    const code = Number(json.status_code || 0)
    if (NOT_LOGIN.has(code)) throw Object.assign(new Error('抖音还没登录'), { code: 'login' })
    if (code) throw Object.assign(new Error(json.status_msg || `抖音接口出错（${code}）`), { code })
    return json
  }

  /** 当前登录的号；没登录返回 null。 */
  async function self() {
    if (selfCache) return selfCache
    try {
      const json = await api('/aweme/v1/web/user/profile/self/', {
        publish_video_strategy_type: 2,
        source: 'channel_pc_web',
        personal_center_strategy: 1,
      })
      const user = json.user || {}
      if (!user.sec_uid) return null
      selfCache = { uid: String(user.uid || ''), secUid: String(user.sec_uid), nickname: clean(user.nickname, 40) }
      return selfCache
    } catch (error) {
      if (error.code === 'login') return null
      throw error
    }
  }

  /** 停在私信页。 */
  async function openChatPage() {
    const href = String(await b.evaluate('location.href').catch(() => ''))
    if (/^https:\/\/www\.douyin\.com\/chat/.test(href)) return { ok: true }
    await b.goto(CHAT)
    await sleep(1200)
    const moved = String(await b.evaluate('location.href').catch(() => ''))
    return { ok: /^https:\/\/www\.douyin\.com\/chat/.test(moved), href: moved }
  }

  /**
   * 左栏里的会话列表（去重）。
   *
   * 会话 id 只挂在「外层容器」的 React props 上，而能点的行是它里面的
   * conversationConversationItemwrapper（行文字 = 昵称 / 时间 / 最后一条）。
   * 所以这里扫外层容器拿 id，再下沉到行元素上取昵称和预览。
   * @returns {Promise<Array<{conversationId:string, tokens:string[], name:string, preview:string}>>}
   */
  async function listConversations() {
    const rows = await b
      .evaluate(`(() => {
        const out = new Map()
        for (const node of document.querySelectorAll('div')) {
          const key = Object.keys(node).find((x) => x.startsWith('__reactFiber$'))
          if (!key) continue
          let id = ''
          for (let f = node[key], j = 0; f && j < 5 && !id; f = f.return, j++) {
            for (const v of Object.values(f.memoizedProps || {})) {
              if (!v || typeof v !== 'object') continue
              let candidate = ''
              try { candidate = String(v.conversationId || v.id || '') } catch (e) {}
              if (/^0:1:/.test(candidate)) { id = candidate; break }
            }
          }
          if (!id) continue
          const row = node.querySelector('[class*="conversationConversationItemwrapper"]') ||
            (String(node.className || '').includes('conversationConversationItemwrapper') ? node : null)
          if (!row) continue
          // 一个容器里可能套着好几行：这一段文字只当「这一行」用，名字对不上就跳过
          const prev = out.get(id) || { conversationId: id, name: '', preview: '' }
          const lines = String(row.innerText || '').split('\\n').map((x) => x.trim()).filter(Boolean)
          if (!prev.name && lines[0] && lines[0].length <= 40) prev.name = lines[0]
          if (!prev.preview && lines.length > 2) prev.preview = lines.slice(2).join(' ').slice(0, 60)
          out.set(id, prev)
        }
        return [...out.values()]
      })()`)
      .catch(() => [])
    const list = Array.isArray(rows) ? rows : []
    // 左栏的可见顺序 = 真实顺序；index 用来在名字重复 / 为空时定位
    return list.map((row, index) => ({ ...row, index, tokens: peerTokens(row.conversationId) }))
  }

  /**
   * 标记并点开某个会话。
   *
   * 行元素本身没有会话 id（id 在更外层容器的 props 上），而一个容器常套着好几行，
   * 从容器往下 querySelector 只会拿到第一行 —— 所以这里按「左栏里的第几行 + 昵称」
   * 认行，点完再用右侧标题确认真的切过去了。
   *
   * @param {{conversationId?:string, tokens?:string[], name?:string, index?:number}} target
   */
  async function openConversation({ conversationId = '', tokens = [], name = '', index = -1 } = {}) {
    const before = await openChatName()
    const marked = await b
      .evaluate(`(() => {
        const rows = [...document.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
        const name = ${JSON.stringify(name)}
        const index = ${JSON.stringify(index)}
        const firstLine = (row) => ((row.innerText || '').split('\\n')[0] || '').trim()
        let pick = null
        if (index >= 0 && index < rows.length) {
          const byIndex = rows[index]
          if (!name || firstLine(byIndex) === name) pick = byIndex
        }
        if (!pick && name) pick = rows.find((row) => firstLine(row) === name) || null
        if (!pick) {
          // 昵称和序号都对不上：退回按会话 id 找（找得到容器就行，点它里面最像行的那块）
          const want = ${JSON.stringify(tokens.length ? tokens : peerTokens(conversationId))}
          for (const node of document.querySelectorAll('div')) {
            const key = Object.keys(node).find((x) => x.startsWith('__reactFiber$'))
            if (!key) continue
            let id = ''
            for (let f = node[key], j = 0; f && j < 5 && !id; f = f.return, j++) {
              for (const v of Object.values(f.memoizedProps || {})) {
                if (!v || typeof v !== 'object') continue
                let candidate = ''
                try { candidate = String(v.conversationId || v.id || '') } catch (e) {}
                if (/^0:1:/.test(candidate)) { id = candidate; break }
              }
            }
            if (!id) continue
            const have = id.split(':').slice(2).flatMap((x) => x.split(/[-_]/))
            if (!want.some((w) => have.includes(w))) continue
            const rowsInside = [...node.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
            const own = String(node.className || '').includes('conversationConversationItemwrapper') ? node : null
            const inside = rowsInside.find((row) => !name || firstLine(row) === name)
            pick = inside || own || (rowsInside.length === 1 ? rowsInside[0] : null)
            if (pick) break
          }
        }
        if (!pick) return false
        document.querySelectorAll('[data-dychat-conv]').forEach((x) => x.removeAttribute('data-dychat-conv'))
        pick.setAttribute('data-dychat-conv', '1')
        return true
      })()`)
      .catch(() => false)
    if (!marked) return false
    await b.press('[data-dychat-conv]')

    // 真切换了才算打开：右侧标题变成这个人，或者至少换了
    for (let i = 0; i < 12; i++) {
      await sleep(500)
      const now = await openChatName()
      if (name && now === name) return true
      if (now && now !== before) return true
    }
    return false
  }

  /**
   * 当前会话里的消息（从旧到新）：{ id, uid, mine, text, at, card }。
   *
   * 注意：页面上的 message 对象里 `isMyMessage` 并不可靠（对方发的也会是 true），
   * 真正能区分的是 `sender`（发送者 uid）——所以这里用「当前登录号」去比。
   */
  async function readMessages() {
    const selfUid = (await self().catch(() => null))?.uid || ''
    const list = await b
      .evaluate(`(() => {
        const selfUid = ${JSON.stringify(selfUid)}
        const out = new Map()
        for (const node of document.querySelectorAll('div')) {
          const k = Object.keys(node).find((x) => x.startsWith('__reactFiber$'))
          if (!k) continue
          let message = null
          for (let f = node[k], j = 0; f && j < 4 && !message; f = f.return, j++) {
            const v = f.memoizedProps && f.memoizedProps.message
            if (v && typeof v === 'object' && 'isMyMessage' in v) message = v
          }
          if (!message) continue
          const parsed = message.parsedContent || {}
          const at = message.createdAt instanceof Date ? message.createdAt.getTime() : Number(message.createdAt) || 0
          const uid = String(message.sender ?? message.senderUid ?? '')
          const mine = uid ? (selfUid ? uid === selfUid : message.isMyMessage === true) : message.isMyMessage === true
          const text = String(parsed.text || '').slice(0, 500)
          const serverId = String(message.serverId ?? message.id ?? '')
          // 有些节点上的消息对象是精简版：没有 serverId 就用「时间 + 发送方 + 文字」拼一个稳定的 id
          const id = serverId || (at ? 'v-' + at + '-' + (uid || (mine ? 'me' : 'x')) + '-' + text.slice(0, 24) : '')
          if (!id) continue
          const prev = out.get(id)
          if (prev && (prev.uid || !uid) && (prev.at || !at)) continue
          out.set(id, {
            id,
            uid,
            mine,
            text,
            at,
            card: parsed.itemId ? { awemeId: String(parsed.itemId), title: String(parsed.content_title || '').slice(0, 80) } : null,
          })
        }
        return [...out.values()].sort((a, c) => a.at - c.at)
      })()`)
      .catch(() => [])
    return Array.isArray(list) ? list : []
  }

  /** 读当前会话，页在后台时消息要等一会儿才出来。 */
  async function waitMessages({ tries = 12, gapMs = 800 } = {}) {
    let list = []
    for (let i = 0; i < tries; i++) {
      list = await readMessages()
      if (list.length) break
      await sleep(gapMs)
    }
    return list
  }

  /** 当前打开的会话是谁（从消息里认，认不出返回空串）。 */
  async function peerOfOpenChat(selfUid = '') {
    const list = await readMessages()
    const other = list.find((m) => !m.mine && m.uid)
    return other?.uid || (selfUid ? '' : list.find((m) => m.uid)?.uid || '')
  }

  /**
   * 在当前会话里发一条私信。
   *
   * 抖音的私信编辑器是 Slate（`data-slate-editor`），回车不会发送、只会换行；
   * 真的发送按钮是输入行最右边那个 32×32 的图标（没有 class / aria / data-e2e 可认），
   * 所以这里按结构找：输入行里最靠右的小方框。
   *
   * 流程：清空 → 输入 → 核对框里的字 → 点发送并等 `/v1/message/send` 回执 →
   * 回执没等到就看消息列表里有没有自己这条；状态不确定就抛错，绝不重试（避免发两遍）。
   */
  async function sendMessage(text, { timeoutMs = 8000 } = {}) {
    const message = String(text || '')
    if (!message.trim()) throw new Error('要发的私信是空的')

    const ready = await b
      .evaluate(`(() => {
        const node =
          document.querySelector('.editor-kit-container[contenteditable="true"]') ||
          [...document.querySelectorAll('[contenteditable="true"]')].find((x) => /发送消息/.test(x.getAttribute('data-placeholder') || x.getAttribute('placeholder') || ''))
        if (!node) return false
        node.setAttribute('data-dychat-edit', '1')
        node.focus()
        return document.activeElement === node
      })()`)
      .catch(() => false)
    if (!ready) throw new Error('找不到私信输入框（会话没打开？）')

    const inBox = () =>
      b.evaluate(`(() => { const e = document.querySelector('[data-dychat-edit]'); return e ? e.innerText : '' })()`).catch(() => '')

    for (let tries = 0; ; tries++) {
      await b.clearFocused().catch(() => {})
      await b.type(message)
      await sleep(350 + Math.random() * 400)
      if (comparable(await inBox()) === comparable(message)) break
      if (tries >= 1) {
        await b.clearFocused().catch(() => {})
        throw new Error('输入框里的字对不上，没发')
      }
    }

    const markSend = () =>
      b
        .evaluate(`(() => {
          document.querySelectorAll('[data-dychat-send]').forEach((x) => x.removeAttribute('data-dychat-send'))
          const row = document.querySelector('[class*="messageMsgInputinputRow"]')
          if (!row) return false
          const rr = row.getBoundingClientRect()
          // 发送按钮没有 class / aria / data-e2e 可认：就是输入行最右端那个图标
          const point = { x: rr.right - 24, y: rr.y + rr.height / 2 }
          const node = document.elementFromPoint(point.x, point.y)
          if (!node || !row.contains(node)) return false
          node.setAttribute('data-dychat-send', '1')
          return true
        })()`)
        .catch(() => false)

    const startedAt = Date.now()
    const sentRe = /\/v1\/message\/send/
    let receipt = null
    if (await markSend()) {
      const waiting = b.waitResponse(sentRe, timeoutMs)
      await b.press('[data-dychat-send]')
      receipt = await waiting
    }
    if (!receipt) {
      // 兜底：有些版本的回车就是发送
      const waiting = b.waitResponse(sentRe, timeoutMs)
      await b.pressEnter()
      receipt = await waiting
    }

    if (!receipt) {
      await sleep(1500)
      const mine = (await readMessages()).some((m) => m.mine && m.at >= startedAt - 3000 && comparable(m.text) === comparable(message))
      if (mine) return { ok: true, via: 'readback' }
      const remaining = await inBox()
      if (comparable(remaining) === comparable(message)) {
        await b.clearFocused().catch(() => {})
        throw Object.assign(new Error('没等到发送回执，输入框里的字还在，已清空；先不重试'), { code: 'uncertain' })
      }
      // 框空了又没回执：可能已经发出去了，按回读再确认一次
      await sleep(1200)
      const again = (await readMessages()).some((m) => m.mine && m.at >= startedAt - 3000 && comparable(m.text) === comparable(message))
      if (again) return { ok: true, via: 'readback-late' }
      throw Object.assign(new Error('私信发送状态不确定，先不重试（避免发两遍）'), { code: 'uncertain' })
    }

    if (receipt.status !== 200) {
      await b.evaluate(`(() => { const e = document.querySelector('[data-dychat-edit]'); e && e.focus() })()`).catch(() => {})
      await b.clearFocused().catch(() => {})
      throw new Error(`私信没发出去（HTTP ${receipt.status}）`)
    }
    return { ok: true, via: 'receipt' }
  }

  /** 会话标题上的昵称（尽力而为，拿不到就空串）。 */
  async function openChatName() {
    const name = await b
      .evaluate(`(() => {
        const selectors = [
          '[class*="RightPanelHeadertitle"]',
          '[class*="conversationHeader"]',
          '[data-e2e="chat-title"]',
        ]
        for (const s of selectors) {
          const node = document.querySelector(s)
          const text = node && (node.innerText || '').trim()
          if (text && text.length <= 40 && !text.includes('\\n')) return text
        }
        return ''
      })()`)
      .catch(() => '')
    return String(name || '').trim()
  }

  return {
    api,
    self,
    openChatPage,
    listConversations,
    openConversation,
    readMessages,
    waitMessages,
    peerOfOpenChat,
    sendMessage,
    openChatName,
    screenshot: (clip) => b.screenshot(clip).catch(() => ''),
    show: (visible) => b.show(visible),
    connected: () => b.connected(),
    pageUrl: () => b.evaluate('location.href').catch(() => ''),
  }
}
