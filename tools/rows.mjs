/**
 * 会话行诊断：每一行的类名、有没有 React fiber、能读到的 conversationId。
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
  await sleep(3000)

  const rows = await browser.evaluate(`(() => {
    const out = []
    const nodes = [...document.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
    out.push({ note: 'row count', value: nodes.length })
    nodes.slice(0, 12).forEach((node, index) => {
      const fiberKey = Object.keys(node).find((x) => x.startsWith('__reactFiber$')) || ''
      const ids = []
      if (fiberKey) {
        for (let f = node[fiberKey], j = 0; f && j < 6; f = f.return, j++) {
          for (const v of Object.values(f.memoizedProps || {})) {
            if (!v || typeof v !== 'object') continue
            let id = ''
            try { id = String(v.conversationId || '') } catch (e) {}
            if (/^0:1:/.test(id)) ids.push(id)
          }
        }
      }
      out.push({
        index,
        cls: String(node.className || '').slice(0, 80),
        fiber: Boolean(fiberKey),
        ids: [...new Set(ids)].slice(0, 3),
        text: (node.innerText || '').replace(/\\n/g, ' | ').slice(0, 40),
        box: (() => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
      })
    })
    return out
  })()`)
  console.log(JSON.stringify(rows, null, 1))
} catch (error) {
  console.error('diagnose failed:', error.message)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
