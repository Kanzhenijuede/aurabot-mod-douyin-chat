import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkReply, decide, inQuietHours, isListed, isSilence, minuteOfDay, parseIds } from '../lib/policy.mjs'

const base = {
  enabled: true,
  dryRun: false,
  replyStrangers: true,
  allowList: '',
  ignoreList: '',
  maxPerPersonPerDay: 10,
  maxPerDay: 30,
  minGapSeconds: 0,
  quietStart: '',
  quietEnd: '',
  freshMinutes: 60,
}
const now = Date.UTC(2026, 10, 11, 12, 0, 0)

test('parseIds 支持逗号、顿号、换行、空格，并统一小写', () => {
  const set = parseIds('Abc,123、抖音号\nX y;Z')
  assert.deepEqual([...set].sort(), ['123', 'abc', 'x', 'y', 'z', '抖音号'].sort())
})

test('isListed 认 uid、secUid、昵称', () => {
  const list = parseIds('MS4WABC,123456,小明')
  assert.equal(isListed(list, { uid: '123456' }), true)
  assert.equal(isListed(list, { secUid: 'ms4wabc' }), true)
  assert.equal(isListed(list, { name: '小明' }), true)
  assert.equal(isListed(list, { uid: '999' }), false)
})

test('minuteOfDay / inQuietHours 支持跨零点', () => {
  assert.equal(minuteOfDay('08:30'), 510)
  assert.equal(minuteOfDay('24:00'), null)
  assert.equal(minuteOfDay('8.30'), null)
  assert.equal(inQuietHours(23 * 60 + 40, { quietStart: '23:30', quietEnd: '08:00' }), true)
  assert.equal(inQuietHours(7 * 60, { quietStart: '23:30', quietEnd: '08:00' }), true)
  assert.equal(inQuietHours(9 * 60, { quietStart: '23:30', quietEnd: '08:00' }), false)
  assert.equal(inQuietHours(600, { quietStart: '08:00', quietEnd: '08:00' }), false)
})

test('chunkReply 拆行、去掉称呼前缀、截断、限制条数', () => {
  assert.deepEqual(chunkReply('在呢\n刚吃完饭'), ['在呢', '刚吃完饭'])
  assert.deepEqual(chunkReply('她：在呢|||你：刚吃完'), ['在呢', '刚吃完'])
  assert.deepEqual(chunkReply('一\n二\n三', { lines: 2 }), ['一', '二'])
  assert.equal(chunkReply('x'.repeat(200), { maxChars: 20 })[0].length, 20)
  assert.equal(chunkReply('x'.repeat(200), { maxChars: 20 })[0].endsWith('…'), true)
  assert.deepEqual(chunkReply('   '), [])
})

test('isSilence 认沉默写法', () => {
  for (const text of ['', '  ', '[沉默]', '【沉默】', '（不回）', '跳过']) assert.equal(isSilence(text), true)
  assert.equal(isSilence('在的'), false)
})

test('decide：开关关着就不回', () => {
  const verdict = decide({ person: { uid: '1' }, messageAt: now, now, settings: { ...base, enabled: false } })
  assert.equal(verdict.reply, false)
  assert.match(verdict.reason, /开关/)
})

test('decide：陌生人默认不回', () => {
  const verdict = decide({ person: { uid: '1' }, messageAt: now, now, settings: { ...base, replyStrangers: false } })
  assert.equal(verdict.reply, false)
  assert.match(verdict.reason, /陌生/)
  const allowed = decide({ person: { uid: '1' }, messageAt: now, now, settings: { ...base, replyStrangers: false, allowList: '1' } })
  assert.equal(allowed.reply, true)
})

test('decide：忽略名单优先', () => {
  const verdict = decide({ person: { uid: '1' }, messageAt: now, now, settings: { ...base, allowList: '1', ignoreList: '1' } })
  assert.equal(verdict.reply, false)
  assert.match(verdict.reason, /忽略/)
})

test('decide：太旧的消息不追', () => {
  const verdict = decide({ person: { uid: '1' }, messageAt: now - 61 * 60_000, now, settings: base })
  assert.equal(verdict.reply, false)
  assert.match(verdict.reason, /太旧|久/)
})

test('decide：每人每天上限与全站上限', () => {
  const capped = decide({ person: { uid: '1' }, messageAt: now, now, settings: base, state: { repliesToday: 10, lastReplyAt: 0 } })
  assert.equal(capped.reply, false)
  const global = decide({ person: { uid: '1' }, messageAt: now, now, settings: base, sentToday: 30 })
  assert.equal(global.reply, false)
})

test('decide：间隔和免打扰', () => {
  const gap = decide({ person: { uid: '1' }, messageAt: now, now, settings: { ...base, minGapSeconds: 60 }, state: { repliesToday: 1, lastReplyAt: now - 10_000 } })
  assert.equal(gap.reply, false)
  const quietNow = new Date(now)
  const settings = { ...base, quietStart: `${String(quietNow.getHours()).padStart(2, '0')}:00`, quietEnd: `${String((quietNow.getHours() + 1) % 24).padStart(2, '0')}:00` }
  assert.equal(decide({ person: { uid: '1' }, messageAt: now, now, settings }).reply, false)
})

test('decide：正常情况放行', () => {
  const verdict = decide({ person: { uid: '1' }, messageAt: now - 60_000, now, settings: base, state: { repliesToday: 1, lastReplyAt: now - 3_600_000 } })
  assert.equal(verdict.reply, true)
})
