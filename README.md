# 抖音聊天 · Aurabot 模块

让 Aurabot 驻扎在**抖音**上：读她抖音号里的私信，按人格回；每个人单独计数、单独节奏；默认只读不发送。

> 这是 **Aurabot 的模块**（放进 `%USERPROFILE%\.dsh\plugins-data\aurabot\modules\`），不是独立的 DSH 插件。
> 依赖 `dsh-aurabot-qq` 插件本体（扩展接口 v1）。

---

## 她能做到什么

| | 能力 | 说明 |
|---|---|---|
| 💬 | **读私信** | 专用浏览器打开 `douyin.com/chat`，从左栏读会话、进会话读消息（读的是页面 React 组件里的消息对象，不是截屏认字） |
| 🗣️ | **回私信** | 交给 Aurabot 本体去想（带人格、心情、记忆），再回到会话里真发出去 |
| 👤 | **按人管** | 名单 / 忽略名单、每人每天上限、全站每天上限、两次发送最小间隔、免打扰时段 |
| 🕰️ | **只回新的** | 只回 N 分钟以内的消息，DSH 关着那段时间的旧私信不追 |
| 🧪 | **试运行** | 默认开着：只写日志、不发送；先看几天口气对不对再关 |
| 🖥️ | **面板接口** | `/state`、`/conversations`、`/run`、`/settings`、`/send`、`/show`、`/shot`，面板里能看状态、连浏览器、手动跑一轮 |

接口都在 `/aurabot/api/ext/douyin-chat/*` 下（只接受本机回环访问，和插件其它管理接口一样）。
`POST /settings` 只认设置里已有的键，用来从面板之外开关（比如让 DSH 自己开/关）：

```bash
curl -X POST http://127.0.0.1:<面板端口>/aurabot/api/ext/douyin-chat/settings \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"dryRun":true,"allowList":"97864829521"}'
curl -X POST http://127.0.0.1:<面板端口>/aurabot/api/ext/douyin-chat/run -d '{}'
```

## 已经实测过的部分

| 项 | 结果 |
|---|---|
| 启动专用浏览器 + 认登录号 | ✅ 用真实资料目录认出 `冰镇夏花冬天吃 / uid 4210499486753368` |
| 读会话列表 | ✅ 11 个会话，昵称 / 预览都对 |
| 切换会话 | ✅ 点开 🐟 / 🍦 后右侧标题和消息都真的换了 |
| 读对方消息 | ✅ 能分出「对方 5 条 / 我 9 条」（靠 `sender` 比 uid，不靠 `isMyMessage`） |
| 发私信 | ✅ 收到 `/v1/message/send` 200 回执并读回（发到主人自己的号，内容是「模块测试」） |
| 整条链路（读→think→试运行记录） | ✅ 面板接口触发：`conversations: 11, fresh: 2, replied: 0`，日志里是「试运行：本来要在抖音私信里回 Anthony：在」 |

没实测：真实对外发送（只在试运行里跑过；发送函数本身已单独验证）、评论/直播弹幕（这一版没做）。

## 安装

```powershell
# 1) 把整个文件夹放到 Aurabot 的模块目录
$dst = "$env:USERPROFILE\.dsh\plugins-data\aurabot\modules\douyin-chat"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force .\* $dst

# 2) 保存后几秒内自动加载，面板「已安装」会出现「抖音聊天」；报错会在那里显示
```

不需要重启 DSH：模块内核会把它拍快照后热加载，改任何文件都会自动重载。

## 打开顺序（重要）

1. 面板「已安装」里确认模块在跑；
2. 打开 **「打开抖音聊天」**（这一步只允许它启动浏览器、读私信，不动别处）；
3. 点界面上的「连上浏览器」，如果是第一次用，浏览器会停在抖音登录页 —— 扫码登录（登录状态存在
   `plugins-data/aurabot/douyin/edge-profile`，和「刷抖音」共用，所以通常已经登录）；
4. **先保持「试运行」开着跑几轮**，看日志里她打算怎么回；
5. 觉得口气没问题，关掉试运行，她才真的发。

## 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| 打开抖音聊天 | 关 | 总开关 |
| 试运行（只写日志不发送） | **开** | 先看再发 |
| 多久看一次私信 | 3 分钟 | 定时轮询间隔 |
| 每轮最多看几个会话 | 3 | 多了轮着看（`state.cursor` 记位置） |
| 陌生人也回 | 关 | 关着时只回名单里的人 |
| 名单 / 忽略名单 | 空 | 抖音号、uid、secUid、昵称都行；忽略优先 |
| 每人每天最多回几条 | 12 | 0 = 不限 |
| 每天总共最多回几条 | 40 | 0 = 不限 |
| 两次发送至少隔几秒 | 20 | 防手滑连发 |
| 免打扰开始 / 结束 | 23:30 / 08:00 | 支持跨零点；两者相同 = 不启用 |
| 只回多久以内的消息 | 180 分钟 | 旧消息不追 |
| 每条最多几个字 / 最多拆几条 | 120 / 2 | 回复会被拆成 1~2 条发 |
| 浏览器资料目录 | 共用 | 和「刷抖音」共用登录状态，或本模块专用 |
| 浏览器路径 | 空 | 留空自动找 Edge / Chrome |

## 她怎么工作（实现）

```
api.every(60s) → tick()
  ├─ browser.open()            lib/cdp.mjs：独立资料目录起 Edge，CDP 连上（不是无头，抖音拦无头）
  ├─ chat.self()               /aweme/v1/web/user/profile/self/ 认「我是谁」
  ├─ chat.openChatPage()       douyin.com/chat?isPopup=1
  ├─ chat.listConversations()  外层容器 props 拿 conversationId，行元素文字拿昵称/预览
  ├─ chat.openConversation()   按「第几行 + 昵称」点开，用右侧标题确认真的切过去了
  ├─ chat.readMessages()       读 message props；用 sender 和 self.uid 比，判断谁说的
  ├─ policy.decide()           名单 / 上限 / 间隔 / 免打扰 / 新旧 —— 纯函数，有单测
  ├─ api.think(prompt)         交给 Aurabot 本体：人格 + 心情 + 记忆，noTools
  └─ chat.sendMessage()        清空 → Input.insertText → 核对 → 点最右端发送按钮 → 等 /v1/message/send 回执
```

几个踩过的坑（都写在代码注释里）：

* 页面上的 `isMyMessage` **不可靠**（对方发的也是 `true`），必须用 `sender === self.uid` 判断。
* 会话 id 只在**外层容器**的 React props 上，行元素自己没有；一个容器套多行，`querySelector` 只会拿到第一行 ——
  所以按「行号 + 昵称」认行，点完再用标题确认。
* 窗口放在屏幕外时，CDP 注入的**真鼠标事件会被吞**（点了没反应）；必须改用页面内派发的
  `pointerdown → mousedown → pointerup → mouseup → click` 链。
* 私信编辑器是 Slate（`data-slate-editor`），**回车不发送**只换行；发送按钮没有 class / aria / data-e2e，
  只能按位置认：输入行最右端那个 32×32 图标。
* 逐字按键在 Slate 里只留零宽字符，必须用 `Input.insertText`。
* 回执没等到时不要重试 —— 抖音的 IM 会自己补发，重试就是两条。

## 单测

```bash
node --test test/policy.test.mjs test/state.test.mjs
```

覆盖：名单解析、免打扰跨零点、拆条、沉默判定、上限/间隔/新旧、状态跨天清零、坏 JSON 容错。

## 探针（只读，用来在抖音改版后重新对齐选择器）

```bash
node tools/probe.mjs      # 我是谁 + 会话列表 + 第一个会话的消息
node tools/switch.mjs     # 依次切三个会话，确认标题和消息真的跟着换
node tools/inbound.mjs    # 每个会话里「对方发的」有多少条
node tools/rows.mjs       # 会话行的 DOM / props 结构
node tools/button.mjs     # 输入框几何 + 发送按钮候选
node tools/type.mjs       # 输入框打字 + 清空（不发送）
node tools/sendtest.mjs   # 给主人自己的号发一条测试私信并读回
```

## 边界与已知限制

* **只做私信**：评论、@、直播弹幕不在这一版里（结构不同，得单独做）。
* **陌生人只能发一条**：抖音限制「对方回复或关注你之前，只能发送一条文字消息」，第一条发完对方不回就发不出第二条 —— 这是平台规则，不是模块 bug。
* **不能和「刷抖音」同时开**：两个模块共用同一个浏览器资料目录（`douyin/edge-profile`），同时开会撞 `SingletonLock`；
  要么关掉「刷抖音」，要么把本模块的资料目录设成「本模块专用」再去扫一次码。
* **抖音改版会坏**：所有定位都依赖当前页面结构（类名前缀、Slate 编辑器、输入行几何）。坏了先跑 `tools/probe.mjs`，
  再按报错改 `lib/chat.mjs` 里的选择器。
* **她记得的东西是「这一轮上下文」**：私信历史通过每轮的对话摘要给她，长期记忆仍走 Aurabot 自己的记忆库（按 QQ 聊天归属），
  所以抖音上的人不会被写进她的长期记忆 —— 这是有意的：抖音是公开平台，不把那边的对话带进 QQ 的私人记忆。

## 设计取舍

* **为什么用浏览器而不是逆接口**：抖音网页端的私信接口要 `a_bogus` / `msToken` 签名，签名算法随时变；
  在页面里操作等于用页面自己的会话和签名，跟着网页走。代价是依赖 DOM，得靠探针维护。
* **为什么默认「只读」**：这是会说话、会发消息的东西，默认必须见到日志才允许对外发。开关分两层（总开关 + 试运行）。
* **为什么回复要过 `api.think`**：人格、心情、记忆都在 Aurabot 本体里，模块只提供「平台」和「规则」，不复制一套人格。

## License

MIT。`lib/cdp.mjs` 的浏览器启动参数与「刷抖音」模块
（[dsh-aurabot-qq-mods/modules/douyin](https://github.com/aureth-labs/dsh-aurabot-qq-mods)）同源，MIT。
