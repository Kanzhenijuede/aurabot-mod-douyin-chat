import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyState, isSeen, loadState, markReplied, markSeen, personState, saveState, summarize } from '../lib/state.mjs'

const file = () => join(mkdtempSync(join(tmpdir(), 'dychat-')), 'state.json')

test('loadState：没有文件时给空状态', () => {
  const state = loadState(file())
  assert.equal(state.sentToday, 0)
  assert.deepEqual(state.seen, [])
})

test('loadState：坏 JSON 不抛错，当空的处理', () => {
  const path = file()
  writeFileSync(path, '{ 不是 json', 'utf8')
  const state = loadState(path)
  assert.equal(state.version, 1)
  assert.deepEqual(state.people, {})
})

test('saveState 写回后能读回来', () => {
  const path = file()
  const state = loadState(path)
  markReplied(state, 'u1', { name: '小明' })
  saveState(path, state)
  const again = loadState(path)
  assert.equal(again.people.u1.name, '小明')
  assert.equal(again.people.u1.repliesToday, 1)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).sentToday, 1)
})

test('personState 跨天清零', () => {
  const state = emptyState(Date.UTC(2026, 10, 10))
  const day1 = Date.UTC(2026, 10, 10, 12)
  const day2 = Date.UTC(2026, 10, 11, 12)
  markReplied(state, 'u1', { now: day1 })
  markReplied(state, 'u1', { now: day1 })
  assert.equal(personState(state, 'u1', day1).repliesToday, 2)
  const next = personState(state, 'u1', day2)
  assert.equal(next.repliesToday, 0)
  assert.equal(next.lastReplyAt, day1)
})

test('markReplied 累加当天发送数', () => {
  const state = emptyState()
  const now = Date.now()
  markReplied(state, 'u1', { now })
  markReplied(state, 'u1', { name: '小明', now })
  assert.equal(state.sentToday, 2)
  assert.equal(state.people.u1.repliesToday, 2)
  assert.equal(state.lastSendAt, now)
})

test('markSeen / isSeen 去重并保留最近若干条', () => {
  const state = emptyState()
  markSeen(state, ['a', 'b', 'a'])
  assert.equal(state.seen.length, 2)
  assert.equal(isSeen(state, 'a'), true)
  assert.equal(isSeen(state, 'zzz'), false)
  markSeen(state, Array.from({ length: 50 }, (_, i) => `m${i}`), 10)
  assert.equal(state.seen.length, 10)
  assert.equal(state.seen.at(-1), 'm49')
})

test('summarize 给出面板要的摘要', () => {
  const state = emptyState()
  markReplied(state, 'u1')
  const brief = summarize(state, [{ uid: 'u1' }])
  assert.equal(brief.sentToday, 1)
  assert.equal(brief.knownPeople, 1)
  assert.equal(brief.people.length, 1)
})
