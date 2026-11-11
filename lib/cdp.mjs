/**
 * 专用浏览器 + CDP 客户端。
 *
 * 思路和「刷抖音」模块一样：用独立的用户资料目录起一个 Edge / Chrome（不用无头模式，
 * 抖音会拦），通过 CDP（Node 自带 WebSocket）在页面里执行脚本、按真实的鼠标键盘事件操作。
 *
 * 这个文件只管「开 / 连 / 点 / 打字 / 等接口返回」，抖音相关的都在 chat.mjs。
 */
import { createServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/** 面板里填了就用填的，否则 Edge 优先，再 Chrome / Chromium。 */
export function findBrowser(explicit = '') {
  if (explicit) return existsSync(explicit) ? explicit : ''
  return CANDIDATES.find((p) => existsSync(p)) || ''
}

/** 本机空闲端口。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 资料目录里记的调试端口（我们自己写的；DSH 重启后靠它接回已经开着的窗口）。 */
function readPortFile(profileDir) {
  try {
    const n = Number(String(readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0].trim())
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  } catch (error) {
    return 0
  }
}

function hasLock(profileDir) {
  try {
    lstatSync(join(profileDir, 'SingletonLock'))
    return true
  } catch (error) {
    return error.code === 'ENOENT' ? false : Boolean(error.code)
  }
}

async function getJson(url, ms = 2000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!response.ok) throw new Error(`${url} → ${response.status}`)
  return response.json()
}

/** 一条 CDP 连接：send 发命令，on 收事件。 */
export function connectCdp(wsUrl, { WS = globalThis.WebSocket } = {}) {
  if (!WS) throw new Error('当前 Node 没有 WebSocket（要 Node 22 以上）')
  const socket = new WS(wsUrl)
  let nextId = 1
  let closed = false
  const pending = new Map()
  const listeners = new Map()

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString())
    } catch (error) {
      return
    }
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message || 'CDP 出错'))
      else entry.resolve(message.result || {})
    } else if (message.method) {
      for (const fn of listeners.get(message.method) || []) {
        try {
          fn(message.params || {})
        } catch (error) {}
      }
    }
  })

  let finishReady = () => {}
  socket.addEventListener('close', () => {
    closed = true
    finishReady(new Error('浏览器连接断了'))
    for (const entry of pending.values()) entry.reject(new Error('浏览器连接断了'))
    pending.clear()
  })

  const ready = new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => finishReady(new Error('连不上浏览器调试端口')), 10000)
    finishReady = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    socket.addEventListener('open', () => finishReady())
    socket.addEventListener('error', () => finishReady(new Error('连不上浏览器调试端口')))
  })

  return {
    ready,
    get closed() {
      return closed
    },
    send(method, params = {}, ms = 30000) {
      if (closed) return Promise.reject(new Error('浏览器连接断了'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`浏览器没响应（${method}）`))
        }, ms)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => listeners.get(method)?.delete(fn)
    },
    close() {
      try {
        socket.close()
      } catch (error) {}
    },
  }
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error))
  })
}

/**
 * 专用浏览器。open() 才真的启动 / 连接；只读状态的地方不要调（打开面板不该弹窗口）。
 *
 * @param {object} options
 * @param {string} options.profileDir 独立资料目录（登录状态就存在这里）
 * @param {() => string} [options.browserPath] 面板里填的浏览器路径
 * @param {{info:Function,warn:Function}} [options.log]
 */
export function createBrowser({ profileDir, browserPath = () => '', log } = {}) {
  let cdp = null
  let owned = null
  let opening = null
  let failures = 0
  let retryAt = 0
  let lastError = ''

  const connected = () => Boolean(owned && !owned.exited && cdp && !cdp.closed)

  function observe(child, port) {
    const proc = { child, port, exited: false, error: null, stderr: '' }
    child.on('error', (error) => {
      proc.error = error
      if (!child.pid) proc.exited = true
    })
    child.once('exit', () => {
      proc.exited = true
      if (owned === proc) {
        cdp?.close()
        cdp = null
      }
    })
    child.stderr?.on('data', (data) => {
      proc.stderr = (proc.stderr + String(data)).slice(-2000)
    })
    child.stderr?.on('error', () => {})
    child.stderr?.unref?.()
    return proc
  }

  async function stopOwned(proc) {
    if (!proc) return
    if (!proc.exited && proc.child.pid) {
      await killTree(proc.child.pid).catch(() => {})
      for (let i = 0; i < 20 && !proc.exited; i++) await sleep(150)
    }
    if (owned === proc) {
      cdp?.close()
      cdp = null
      owned = null
    }
  }

  async function attach(port) {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])
    const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    const page = pages.find((t) => /douyin\.com/.test(t.url || '')) || pages[0]
    if (!page) throw new Error('浏览器起来了，但没有可用的标签页')
    const connection = connectCdp(page.webSocketDebuggerUrl)
    try {
      await connection.ready
      await connection.send('Page.enable')
      await connection.send('Runtime.enable')
      await connection.send('Page.setMuted', { muted: true }).catch(() => {})
      cdp = connection
    } catch (error) {
      connection.close()
      throw error
    }
  }

  async function launch() {
    const left = readPortFile(profileDir)
    if (left && (await getJson(`http://127.0.0.1:${left}/json/version`, 1200).catch(() => null))) {
      owned = { child: { pid: 0, kill() {} }, port: left, exited: false, error: null, stderr: '' }
      await attach(left)
      return
    }
    if (hasLock(profileDir)) throw new Error('抖音浏览器资料目录被占用：先把已经开着的那个抖音浏览器关掉，或关掉「刷抖音」模块')

    const configured = browserPath()
    const bin = findBrowser(configured)
    if (!bin) throw new Error(configured ? `浏览器路径不对：${configured}` : '找不到 Edge / Chrome，先装一个，或在设置里填浏览器路径')

    mkdirSync(profileDir, { recursive: true })
    const port = await freePort()
    log?.info?.(`启动抖音专用浏览器（端口 ${port}）`)
    const child = spawn(bin, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
      '--window-size=1280,860',
      // 放到屏幕外：不抢前台，但页面照常跑（不然会被当成被遮挡的后台窗口限速）
      '--window-position=-2400,-2400',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })

    owned = observe(child, port)
    child.unref()
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      if (owned.exited || owned.error) break
      const version = await getJson(`http://127.0.0.1:${port}/json/version`, 1200).catch(() => null)
      if (version) {
        // Edge 经常不写这个文件，自己写一份，DSH 重启后靠它接回窗口
        try {
          writeFileSync(join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/aurabot-douyin-chat\n`)
        } catch (error) {}
        await attach(port)
        return
      }
    }
    const detail = [owned?.error?.message, owned?.stderr?.trim()].filter(Boolean).join('；')
    await stopOwned(owned)
    throw new Error(detail ? `浏览器没起来：${detail}` : '浏览器没起来，请检查浏览器路径和资料目录')
  }

  /** 连上（必要时启动）。失败后按 1/2/4/8… 分钟退避，避免定时任务每轮都去撞。 */
  async function open() {
    if (connected()) return { ok: true }
    if (opening) return opening
    if (Date.now() < retryAt) return { ok: false, message: `${lastError}；${Math.ceil((retryAt - Date.now()) / 60_000)} 分钟后重试` }
    opening = (async () => {
      try {
        await launch()
        failures = 0
        retryAt = 0
        lastError = ''
        return { ok: true }
      } catch (error) {
        failures++
        lastError = error.message
        retryAt = Date.now() + Math.min(30, 2 ** Math.min(failures - 1, 4)) * 60_000
        log?.warn?.(`抖音浏览器启动失败：${error.message}`)
        return { ok: false, message: error.message }
      }
    })().finally(() => {
      opening = null
    })
    return opening
  }

  function need() {
    if (!connected()) throw new Error('浏览器没连上')
    return cdp
  }

  async function evaluate(expression, ms = 30000) {
    const result = await need().send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms)
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || result.exceptionDetails.text || '页面脚本出错')
    }
    return result.result?.value
  }

  async function goto(url, ms = 9000) {
    const connection = need()
    const loaded = new Promise((resolve) => {
      const off = connection.on('Page.loadEventFired', () => {
        off()
        resolve()
      })
      setTimeout(() => {
        off()
        resolve()
      }, ms)
    })
    await connection.send('Page.navigate', { url })
    await loaded
  }

  async function waitFor(selector, ms = 10000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const box = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        if (!node) return null
        node.scrollIntoView({ block: 'center', inline: 'center' })
        const r = node.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return null
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || '').slice(0, 200) }
      })()`).catch(() => null)
      if (box) return box
      await sleep(300)
    }
    return null
  }

  async function click(x, y) {
    const connection = need()
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await connection.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      await sleep(40 + Math.random() * 60)
    }
  }

  /**
   * 点一个元素。
   *
   * 窗口放在屏幕外时，CDP 注入的真鼠标事件会被浏览器当成「被遮挡窗口」吞掉（私信列表点了没反应）。
   * 所以在页面里按真实顺序派发 pointerdown → mousedown → pointerup → mouseup → click：
   * React 的事件委托挂在根节点上，这些事件照样能触发组件自己的 onClick。
   */
  async function press(selector) {
    const ok = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return false
      node.scrollIntoView({ block: 'center', inline: 'center' })
      const r = node.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) return false
      const options = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        button: 0,
        buttons: 1,
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse',
      }
      node.dispatchEvent(new PointerEvent('pointerdown', options))
      node.dispatchEvent(new MouseEvent('mousedown', options))
      node.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }))
      node.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }))
      node.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }))
      return true
    })()`).catch(() => false)
    await sleep(150)
    return Boolean(ok)
  }

  /**
   * 往当前焦点里输入文字。
   * 优先用 Input.insertText（对 contenteditable / 富文本编辑器有效，抖音私信输入框就是这种），
   * 失败再退回逐字按键。逐字按键在富文本里常常只留下一个零宽字符。
   */
  async function type(text) {
    const connection = need()
    const value = String(text)
    try {
      await connection.send('Input.insertText', { text: value }, 15000)
      await sleep(200 + Math.random() * 200)
      return
    } catch (error) {}
    for (const ch of value) {
      await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
      await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
      await sleep(18 + Math.random() * 34)
    }
  }

  /**
   * 清空当前焦点里的字。
   * 富文本编辑器（抖音私信）不认 Ctrl+A，先试着在页面里全选 + 删除，再退回按键。
   */
  async function clearFocused() {
    const connection = need()
    const key = async (k, code, vk, modifiers = 0, commands = []) => {
      const base = { key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(commands.length ? { commands } : {}) }
      await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
      await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    }
    await key('a', 'KeyA', 65, 2, ['selectAll'])
    await key('Backspace', 'Backspace', 8, 0, ['deleteBackward'])
    await sleep(150)
    const left = await evaluate(`(() => {
      const node = document.querySelector('[data-dychat-edit]') || document.activeElement
      return node ? node.innerText : ''
    })()`).catch(() => '')
    if (comparableText(left)) {
      // 还有残留：在页面里全选 + 删除再来一次（编辑器有时吞掉按键）
      await evaluate(`(() => {
        const node = document.querySelector('[data-dychat-edit]') || document.activeElement
        if (!node) return false
        node.focus()
        const range = document.createRange()
        range.selectNodeContents(node)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        document.execCommand('delete')
        return true
      })()`).catch(() => {})
      await sleep(120)
    }
  }

  /** 判断输入框里是不是还有可见文字（零宽字符、emoji 占位不算）。 */
  function comparableText(text) {
    return String(text || '')
      .normalize('NFC')
      .replace(/[\s\u00a0\u200b\u200d\ufe0f]|\p{Extended_Pictographic}|\p{Emoji_Modifier}/gu, '')
  }

  async function pressEnter() {
    const connection = need()
    await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }

  /** 等一个接口回应（按 URL 正则）；超时返回 null。 */
  function waitResponse(urlRe, ms = 10000) {
    const connection = need()
    return new Promise((resolve) => {
      const offs = [
        connection.on('Network.responseReceived', (params) => {
          if (!urlRe.test(params.response?.url || '')) return
          finish(params.response)
        }),
        connection.on('Network.loadingFinished', () => {}),
      ]
      const timer = setTimeout(() => finish(null), ms)
      function finish(response) {
        clearTimeout(timer)
        for (const off of offs) off()
        resolve(response ? { status: response.status, url: response.url, headers: response.headers } : null)
      }
      connection.send('Network.enable').catch(() => {})
    })
  }

  async function screenshot(clip) {
    const params = { format: 'png' }
    if (clip) params.clip = { ...clip, scale: 1 }
    const result = await need().send('Page.captureScreenshot', params)
    return result.data ? `data:image/png;base64,${result.data}` : ''
  }

  /** 把窗口移到屏幕里 / 屏幕外（登录、过验证码时要看一眼）。 */
  async function show(visible) {
    const result = await need().send('Browser.getWindowForTarget').catch(() => null)
    if (result?.windowId != null) {
      await need().send('Browser.setWindowBounds', {
        windowId: result.windowId,
        bounds: visible ? { left: 80, top: 80, width: 1280, height: 860, windowState: 'normal' } : { left: -2400, top: -2400 },
      })
    }
    return { ok: true, visible: Boolean(visible) }
  }

  async function close() {
    await stopOwned(owned)
  }

  return { open, connected, evaluate, goto, waitFor, press, type, clearFocused, pressEnter, waitResponse, screenshot, show, close, send: (method, params, ms) => need().send(method, params, ms) }
}
