/**
 * 抖音私信的本地状态：谁回过什么、回了几条、看到哪一条。
 *
 * 全部落在一个 JSON 文件里（api.dataDir() 下），DSH 重启、模块热重载都不丢。
 * 只存判断需要的东西，不存消息正文之外的内容。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rollover } from './policy.mjs'

/** 一个空状态。 */
export function emptyState(now = Date.now()) {
  return {
    version: 1,
    day: new Date(now).toISOString().slice(0, 10),
    sentToday: 0,
    lastSendAt: 0,
    cursor: 0,
    seen: [],
    people: {},
  }
}

/** 读回状态；文件坏了就当空的，不让一个坏 JSON 把模块卡死。 */
export function loadState(file, now = Date.now()) {
  let raw = null
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    raw = null
  }
  const base = emptyState(now)
  const state = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) }
  state.people = state.people && typeof state.people === 'object' ? state.people : {}
  state.seen = Array.isArray(state.seen) ? state.seen.filter((x) => typeof x === 'string') : []
  return rollover(state, now)
}

/** 写回状态：先写临时文件再改名，断电/崩溃不会留下半个 JSON。 */
export function saveState(file, state) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state), 'utf8')
  renameSync(tmp, file)
}

/** 某个人的计数（跨天自动清零）。 */
export function personState(state, uid, now = Date.now()) {
  const key = String(uid || '')
  if (!key) return { repliesToday: 0, lastReplyAt: 0, firstSeenAt: now }
  const day = new Date(now).toISOString().slice(0, 10)
  const prev = state.people[key] || {}
  const fresh = prev.day === day ? prev : { ...prev, day, repliesToday: 0 }
  state.people[key] = fresh
  return fresh
}

/** 记一条已经回过：计数 + 时间 + 名字。 */
export function markReplied(state, uid, { name = '', now = Date.now() } = {}) {
  const person = personState(state, uid, now)
  person.repliesToday = (person.repliesToday || 0) + 1
  person.lastReplyAt = now
  person.name = name || person.name || ''
  person.firstSeenAt = person.firstSeenAt || now
  state.sentToday = (state.sentToday || 0) + 1
  state.lastSendAt = now
  return person
}

/** 记一条「看过了」，不当作没回过：下次不会再拿它触发回复。 */
export function markSeen(state, ids, keep = 600) {
  const set = new Set(state.seen)
  for (const id of ids || []) if (id) set.add(String(id))
  state.seen = [...set].slice(-Math.max(1, keep))
}

/** 这个人的消息 id 是不是已经处理过。 */
export function isSeen(state, id) {
  return state.seen.includes(String(id))
}

/** 状态里给面板看的一小段摘要。 */
export function summarize(state, people = []) {
  const day = state.day
  const replies = Object.values(state.people).filter((p) => p.day === day).reduce((n, p) => n + (p.repliesToday || 0), 0)
  return {
    day,
    sentToday: state.sentToday || 0,
    repliesRecorded: replies,
    knownPeople: Object.keys(state.people).length,
    seen: state.seen.length,
    people,
  }
}
