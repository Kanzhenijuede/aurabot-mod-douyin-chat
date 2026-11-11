/**
 * 原始消息对象探针：把当前会话里所有「带 isMyMessage 的 props」去重后打出来，
 * 再试着把消息列表滚到顶（触发加载历史），确认「对方发的消息」上有哪些字段。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBrowser } from '../lib/cdp.mjs'
import { createChat } from '../lib/chat.mjs'

const profileDir = join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'douyin', 'edge-profile')
const log = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), debug: () => {} }
const browser = createBrowser({ profileDir, browserPath: () => '', log })
const chat = createChat({ browser, log })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dump = () =>
  browser.evaluate(`(() => {
    const seen = new Set(), out = []
    for (const node of document.querySelectorAll('div')) {
      const key = Object.keys(node).find((x) => x.startsWith('__reactFiber$'))
      if (!key) continue
      for (let f = node[key], j = 0; f && j < 4; f = f.return, j++) {
        const v = f.memoizedProps && f.memoizedProps.message
        if (!v || typeof v !== 'object' || !('isMyMessage' in v)) continue
        const id = String(v.serverId || '')
        const marker = id || JSON.stringify(v).slice(0, 120)
        if (seen.has(marker)) continue
        seen.add(marker)
        out.push({
          keys: Object.keys(v).slice(0, 12),
          isMy: v.isMyMessage,
          serverId: v.serverId ?? null,
          sender: v.sender ?? null,
          at: v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt),
          text: (v.parsedContent && v.parsedContent.text) || '',
          aweType: v.parsedContent && v.parsedContent.aweType,
        })
      }
    }
    return out
  })()`)

const scrollTopMost = () =>
  browser.evaluate(`(() => {
    const scrollables = [...document.querySelectorAll('div')]
      .filter((n) => n.scrollHeight > n.clientHeight + 200 && n.getBoundingClientRect().x > 300)
    scrollables.forEach((n) => { n.scrollTop = 0 })
    return scrollables.map((n) => ({ x: Math.round(n.getBoundingClientRect().x), sh: n.scrollHeight, ch: n.clientHeight }))
  })()`)

try {
  const opened = await browser.open()
  if (!opened.ok) throw new Error(opened.message)
  await chat.openChatPage()
  await sleep(2500)

  const list = await chat.listConversations()
  const anthony = list.find((c) => c.name === 'Anthony') || list[0]
  console.log('open:', anthony.name)
  await chat.openConversation(anthony)
  await sleep(1500)

  console.log('scrollables:', JSON.stringify(await scrollTopMost()))
  await sleep(2500)
  console.log('scrollables:', JSON.stringify(await scrollTopMost()))
  await sleep(2500)

  const messages = await dump()
  console.log('messages:', messages.length)
  for (const m of messages.slice(0, 40)) {
    console.log(`${m.isMy ? '我  ' : '对方'} ${String(m.sender).padEnd(17)} ${m.at} ${m.aweType ?? ''} | ${m.text || '(非文本)'} | keys=${m.keys.join(',')}`)
  }
} catch (error) {
  console.error('raw probe failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
