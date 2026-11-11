/**
 * 切换会话验证：依次打开左栏第 1/3/5 个会话，看右侧标题和消息是否真的跟着换。
 * 只读，不发消息。
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

try {
  const opened = await browser.open()
  if (!opened.ok) throw new Error(opened.message)
  await chat.openChatPage()
  let list = []
  for (let i = 0; i < 10 && !list.length; i++) {
    list = await chat.listConversations()
    if (!list.length) await sleep(2000)
  }
  console.log('conversations:', list.length, '→', list.map((c) => c.name).join(' / '))

  for (const index of [0, 2, 4]) {
    const target = list[index]
    if (!target) continue
    const ok = await chat.openConversation(target)
    const header = await chat.openChatName()
    const messages = await chat.waitMessages({ tries: 4 })
    const theirs = messages.filter((m) => !m.mine)
    console.log(`\n#${index} 期望「${target.name}」→ 打开=${ok} 标题=${JSON.stringify(header)} 消息=${messages.length} 对方=${theirs.length}`)
    console.log('   最近：', messages.slice(-3).map((m) => `${m.mine ? '我' : '对方'}：${m.text || '[非文本]'}`).join(' | '))
    await sleep(1200)
  }
} catch (error) {
  console.error('switch probe failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
