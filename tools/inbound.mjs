/**
 * 只读探针：逐个打开会话，看「对方发的」消息能不能读出来（mine=false 且带 uid）。
 * 不发送任何内容。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBrowser } from '../lib/cdp.mjs'
import { createChat } from '../lib/chat.mjs'

const profileDir = join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'douyin', 'edge-profile')
const log = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), debug: () => {} }
const browser = createBrowser({ profileDir, browserPath: () => '', log })
const chat = createChat({ browser, log })

try {
  const opened = await browser.open()
  if (!opened.ok) throw new Error(opened.message)
  const me = await chat.self()
  console.log('self uid:', me?.uid)
  await chat.openChatPage()
  let list = []
  for (let i = 0; i < 10 && !list.length; i++) {
    list = await chat.listConversations()
    if (!list.length) await new Promise((r) => setTimeout(r, 2000))
  }

  for (const conversation of list.slice(0, 4)) {
    const ok = await chat.openConversation(conversation)
    if (!ok) {
      console.log(`\n[${conversation.name || conversation.conversationId}] 打不开`)
      continue
    }
    const messages = await chat.waitMessages()
    const theirs = messages.filter((m) => !m.mine)
    const noUid = theirs.filter((m) => !m.uid)
    console.log(`\n[${conversation.name || '?'}] ${conversation.conversationId} 共 ${messages.length} 条，对方 ${theirs.length} 条（其中无 uid ${noUid.length} 条）`)
    for (const m of theirs.slice(-6)) {
      console.log(`   对方(${m.uid || '空'}) ${new Date(m.at).toISOString()} | ${m.text || (m.card ? `[视频《${m.card.title}》]` : '[非文本]')}`)
    }
    for (const m of messages.slice(-3)) {
      console.log(`   末尾：${m.mine ? '我' : '对方'} | ${m.text || '[非文本]'} | id=${m.id.slice(0, 24)}`)
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
} catch (error) {
  console.error('inbound probe failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
