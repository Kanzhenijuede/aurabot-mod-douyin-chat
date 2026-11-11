/**
 * 找发送按钮：把输入框右下角那块的结构打出来（祖先类名 + 可疑节点的 outerHTML 片段）。
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
  await chat.openConversation(list[0])

  const info = await browser.evaluate(`(() => {
    const edit = document.querySelector('.editor-kit-container[contenteditable="true"]')
    if (!edit) return { error: 'no editor' }
    const r = edit.getBoundingClientRect()
    const points = [
      { x: r.right - 20, y: r.bottom - 20 },
      { x: r.right - 30, y: r.bottom - 12 },
      { x: r.right - 60, y: r.bottom - 20 },
    ]
    const found = points.map((p) => {
      const node = document.elementFromPoint(p.x, p.y)
      const chain = []
      for (let n = node, i = 0; n && i < 5; n = n.parentElement, i++) {
        chain.push({ tag: n.tagName, cls: String(n.className || '').slice(0, 70), text: (n.innerText || '').trim().slice(0, 10) })
      }
      return { point: p, chain, html: node ? node.outerHTML.slice(0, 200) : '' }
    })
    const editorBox = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    const near = [...document.querySelectorAll('*')]
      .filter((n) => {
        const b = n.getBoundingClientRect()
        return b.x > r.right - 120 && b.y > r.bottom - 80 && b.width > 10 && b.width < 120 && b.height > 10 && b.height < 60
      })
      .map((n) => ({ tag: n.tagName, cls: String(n.className || '').slice(0, 70), text: (n.innerText || '').trim().slice(0, 10), attrs: [...n.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 30)).slice(0, 4) }))
      .slice(0, 12)
    return { editorBox, found, near }
  })()`)
  console.log(JSON.stringify(info, null, 1).slice(0, 5000))
} catch (error) {
  console.error('button probe failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
