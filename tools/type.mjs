/**
 * 输入框测试：打开和主人的会话，聚焦输入框、打字、核对框里的字、再清空。
 * 全程不按回车、不发送。
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
  const target = list[0]
  console.log('target:', target.name)
  console.log('opened:', await chat.openConversation(target))

  const focused = await browser.evaluate(`(() => {
    const node = document.querySelector('.editor-kit-container[contenteditable="true"]')
    if (!node) return false
    node.setAttribute('data-test-edit', '1')
    node.focus()
    return document.activeElement === node
  })()`)
  console.log('focused:', focused)

  await browser.type('测试一下输入')
  await sleep(600)
  const typed = await browser.evaluate(`(() => { const e = document.querySelector('[data-test-edit]'); return e ? e.innerText : '' })()`)
  console.log('typed:', JSON.stringify(typed))

  const button = await browser.evaluate(`(() => {
    const node = document.querySelector('[class*="publishBtn"]')
    if (!node) return null
    return { text: (node.innerText || '').trim(), disabled: node.getAttribute('aria-disabled') || node.disabled || '' }
  })()`)
  console.log('send button:', JSON.stringify(button))

  await browser.clearFocused()
  await sleep(400)
  const cleared = await browser.evaluate(`(() => { const e = document.querySelector('[data-test-edit]'); return e ? e.innerText : '' })()`)
  console.log('cleared:', JSON.stringify(cleared))
  console.log('没有发送任何消息（没按回车）')
} catch (error) {
  console.error('type probe failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
