/**
 * 只读探针：用真实抖音资料目录启动专用浏览器，打开私信页，读「我是谁 + 会话列表 + 第一个会话的消息」。
 * 不发任何消息。用来验证 lib/cdp.mjs 与 lib/chat.mjs 的选择器在当前抖音页面上还成立。
 *
 * 用法：node tools/probe.mjs [--profile <dir>]
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBrowser } from '../lib/cdp.mjs'
import { createChat } from '../lib/chat.mjs'

const arg = process.argv.indexOf('--profile')
const profileDir = arg > 0 ? process.argv[arg + 1] : join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'douyin', 'edge-profile')

const log = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  debug: () => {},
}

const browser = createBrowser({ profileDir, browserPath: () => process.env.CHROME_PATH || '', log })
const chat = createChat({ browser, log })

try {
  const opened = await browser.open()
  console.log('open:', JSON.stringify(opened))
  if (!opened.ok) process.exit(4)

  const me = await chat.self()
  console.log('self:', JSON.stringify(me))

  const page = await chat.openChatPage()
  console.log('chat page:', JSON.stringify(page))
  if (!page.ok) process.exit(5)

  // 会话列表要十几秒才出来
  let conversations = []
  for (let i = 0; i < 12 && !conversations.length; i++) {
    conversations = await chat.listConversations()
    if (!conversations.length) await new Promise((r) => setTimeout(r, 2000))
  }
  console.log('conversations:', conversations.length)
  for (const item of conversations.slice(0, 8)) {
    console.log('  -', item.conversationId, '| tokens:', item.tokens.join(','), '| name:', item.name || '(空)', '| preview:', item.preview || '(空)')
  }

  if (conversations.length) {
    const first = conversations[0]
    const ok = await chat.openConversation(first)
    console.log('open first conversation:', ok)
    const messages = ok ? await chat.waitMessages() : []
    console.log('messages:', messages.length)
    for (const message of messages.slice(-6)) {
      console.log('   ', message.mine ? '我' : `对方(${message.uid})`, '|', message.text || (message.card ? `[视频《${message.card.title}》]` : '[非文本]'), '|', new Date(message.at).toISOString())
    }
    const name = await chat.openChatName()
    console.log('header name:', name || '(空)')
  }
} catch (error) {
  console.error('probe failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
