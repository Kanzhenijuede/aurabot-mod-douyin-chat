/**
 * 发送连通性测试：给「主人自己的抖音号」发一条说明这是测试的私信，然后读回消息确认。
 * 只发这一条，发给自己的号，不发别人。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBrowser } from '../lib/cdp.mjs'
import { createChat } from '../lib/chat.mjs'

const profileDir = join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'douyin', 'edge-profile')
const log = { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a), debug: () => {} }
const browser = createBrowser({ profileDir, browserPath: () => '', log })
const chat = createChat({ browser, log })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TEXT = '（模块测试）抖音聊天模块连通性测试，忽略这条'

try {
  const opened = await browser.open()
  if (!opened.ok) throw new Error(opened.message)
  const me = await chat.self()
  console.log('self:', me?.nickname, me?.uid)
  await chat.openChatPage()
  let list = []
  for (let i = 0; i < 10 && !list.length; i++) {
    list = await chat.listConversations()
    if (!list.length) await sleep(2000)
  }
  const target = list.find((c) => c.tokens.includes('97864829521')) || list[0]
  console.log('target:', target.name, target.conversationId)
  console.log('opened:', await chat.openConversation(target))

  const result = await chat.sendMessage(TEXT)
  console.log('send result:', JSON.stringify(result))
  await sleep(2000)
  const messages = await chat.readMessages()
  const hit = messages.filter((m) => m.mine && m.text === TEXT)
  console.log('readback:', hit.length, '条匹配')
  console.log('最近 3 条:', messages.slice(-3).map((m) => `${m.mine ? '我' : '对方'}：${m.text || '[非文本]'}`).join(' | '))
} catch (error) {
  console.error('send test failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
