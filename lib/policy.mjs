/**
 * 纯函数：要不要回、什么时候回、回几条。
 *
 * 这里不碰网络、不碰浏览器，所有判断都能单测。index.mjs 只负责把「观察到的事实」
 * 交进来，然后照着结论执行。
 */

/** 抖音号 / uid / secUid / 昵称统一成小写比较；列表支持逗号、空格、换行、顿号分隔。 */
export function parseIds(text) {
  return new Set(
    String(text || '')
      .split(/[\s,，、;；|]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.toLowerCase()),
  )
}

/** 一个人所有可能被写进名单的标识。 */
export function identityOf(person = {}) {
  return [person.uid, person.secUid, person.douyinId, person.name]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase())
}

/** 名单里有没有这个人。 */
export function isListed(list, person) {
  return identityOf(person).some((id) => list.has(id))
}

/** 'HH:MM' → 一天中的分钟数；不合法返回 null。 */
export function minuteOfDay(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 现在是不是免打扰时段；开始 = 结束表示没有免打扰。支持跨零点。 */
export function inQuietHours(minutes, { quietStart = '', quietEnd = '' } = {}) {
  const start = minuteOfDay(quietStart)
  const end = minuteOfDay(quietEnd)
  if (start === null || end === null || start === end) return false
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** 当前本地时间的一天中的分钟数。 */
export function minutesNow(now) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

/** 按天滚动：跨天了就把当天的计数清零。 */
export function rollover(state, now) {
  const day = new Date(now).toISOString().slice(0, 10)
  if (state.day === day) return state
  state.day = day
  state.sentToday = 0
  return state
}

/**
 * 把一段回复切成要发出去的几条。
 * - 按换行拆；模型偶尔会把几句用 ||| 连起来，也当分隔符
 * - 去空、去首尾空白、超长的截断
 * - 最多 lines 条
 */
export function chunkReply(text, { maxChars = 120, lines = 2 } = {}) {
  const parts = String(text ?? '')
    .split(/\n+|\|\|\|/)
    .map((x) => x.replace(/^\s*(?:她|你|我)[:：]\s*/, '').trim())
    .filter(Boolean)
  const out = []
  for (const part of parts) {
    out.push(part.length > maxChars ? `${part.slice(0, Math.max(1, maxChars - 1))}…` : part)
    if (out.length >= Math.max(1, lines)) break
  }
  return out
}

/** 她不想说话时的固定写法。 */
export function isSilence(text) {
  const t = String(text ?? '').trim()
  return !t || /^[[【(（]?\s*(沉默|跳过|不回|不说话)\s*[\]】)）]?$/.test(t)
}

/**
 * 要不要回这一条。返回 { reply: boolean, reason }；reason 会写进日志，方便你回头看为什么没回。
 *
 * @param {object} input
 * @param {object} input.person     对方 { uid, secUid, douyinId, name }
 * @param {number} input.messageAt  这条消息的时间（毫秒）
 * @param {number} input.now        现在
 * @param {object} input.settings   模块设置（api.settings()）
 * @param {object} input.state      这个人的计数 { repliesToday, lastReplyAt }
 * @param {number} input.sentToday  今天全站已经发了几条
 */
export function decide({ person, messageAt, now, settings, state = {}, sentToday = 0 }) {
  if (!settings.enabled) return { reply: false, reason: '开关没打开' }
  if (!messageAt) return { reply: false, reason: '消息没有时间，判断不了新旧' }
  const freshMs = Math.max(1, Number(settings.freshMinutes) || 180) * 60_000
  if (now - messageAt > freshMs) return { reply: false, reason: '消息太久了，不追' }
  if (messageAt - now > 5 * 60_000) return { reply: false, reason: '消息时间在未来，跳过' }

  const ignore = parseIds(settings.ignoreList)
  if (isListed(ignore, person)) return { reply: false, reason: '在忽略名单里' }

  const allow = parseIds(settings.allowList)
  const stranger = !isListed(allow, person)
  if (stranger && !settings.replyStrangers) return { reply: false, reason: '是陌生人，且只回名单里的人' }

  if (inQuietHours(minutesNow(now), settings)) return { reply: false, reason: '免打扰时段' }

  const gapSec = Math.max(0, Number(settings.minGapSeconds) || 0)
  if (state.lastReplyAt && now - state.lastReplyAt < gapSec * 1000) return { reply: false, reason: `距上次回复不到 ${gapSec} 秒` }

  const perPerson = Math.max(0, Number(settings.maxPerPersonPerDay) || 0)
  if (perPerson && (state.repliesToday || 0) >= perPerson) return { reply: false, reason: `这个人今天已经回了 ${perPerson} 条` }

  const perDay = Math.max(0, Number(settings.maxPerDay) || 0)
  if (perDay && sentToday >= perDay) return { reply: false, reason: `今天全站已经发了 ${perDay} 条` }

  return { reply: true, reason: '可以回' }
}
