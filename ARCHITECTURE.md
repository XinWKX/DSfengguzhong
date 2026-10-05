# 架构说明

这份文档说明 DS峰谷钟的**分层、依赖方向、以及为什么这样分**。
它不是教程（那是 [README](README.md) 的活），而是给要改代码的人看的约束说明。

---

## 一、首要约束：4 个文件即可部署

```
server.js                 HTTP 服务 + 编排
peak-valley-core.js       峰谷判定（浏览器 / Node 共用）
peak-valley-feeds.js      联网数据源：校时 + 节假日日历（浏览器 / Node 共用）
deepseek-peak-valley.html 网页（单文件）
```

这 4 个文件放在同一目录、`node server.js` 就能跑。**整个项目的结构选择都服从这条约束**：

- `deploy/install.sh` 会逐一校验这 4 个文件是否存在；
- `build-dist.mjs` 只把这 4 个文件（+ 部署辅助文件）打进 `dist/`；
- README 的部署章节承诺「只需要 4 个文件」；
- 使用者（包括已经在跑的服务器）就是按这个目录布置的。

**因此：任何「把运行时拆成 `src/` 多层目录」的重构都会破坏部署契约**，
除非同时改 `install.sh`、`build-dist.mjs`、README、测试，以及使用者已经部署好的服务器目录。
本项目的判断是**不划算** —— 代码规模（运行时合计约 1900 行）还没有到需要多层目录的程度。

---

## 二、分层与依赖方向

```
                    ┌──────────────────────────────┐
                    │  peak-valley-core.js         │  纯计算，无 I/O、无 DOM、无网络
                    │  规则 / 日历判定 / 区间缓存   │
                    └───────────┬──────────────────┘
                                │ require / <script>
                    ┌───────────▼──────────────────┐
                    │  peak-valley-feeds.js        │  只负责「取数据」：校时 + 节假日
                    │  注入式 fetch，可完全离线测试 │
                    └───────────┬──────────────────┘
              ┌─────────────────┴─────────────────┐
              │                                   │
   ┌──────────▼──────────┐            ┌───────────▼────────────┐
   │  server.js          │            │ deepseek-peak-valley.html│
   │  HTTP + 编排        │            │ 渲染 + 交互（单个 IIFE） │
   └─────────────────────┘            └────────────────────────┘
```

**依赖只能向下，且只允许这三种方向：**

| 谁 | 可以依赖 | 不允许依赖 |
|---|---|---|
| `peak-valley-core.js` | 无（纯函数 + 常量） | feeds / server / DOM |
| `peak-valley-feeds.js` | core（解析后的数据交给它用） | server / DOM |
| `server.js` | core + feeds | DOM |
| 网页 | core + feeds（`<script>` 引入） | server（除 HTTP 接口外） |

**这条约束保证了一件关键的事**：峰谷判定只有一份实现。网页与服务端不可能算出不同结果 ——
`test/check-quality.cjs` 会检查「服务端与网页共用核心」这个不变量，`test/test-api.mjs`
还会把接口返回的每个字段与核心模块直接对比，不一致就失败。

### 两个必须遵守的写法

1. **`core` / `feeds` 用 UMD 包裹**（`module.exports` + 挂到全局），这样浏览器与服务端共用同一份源码。
   不要改成 ESM：加了 `"type": "module"` 会让 `.js` 被当成 ESM，UMD 的 `module.exports` 分支失效，
   而改成 `.mjs` 又会让网页的 `<script src>` 需要额外处理。
2. **`feeds` 的 `fetch` 必须可注入**。测试全部用假 fetch 覆盖降级链（三源依次重试、超时、空数据、
   限流、脏键），不联网。真实 fetch 只在 `server.js` 与网页里各绑定一次。

---

## 三、数据流

```
时间源（worldtimeapi → timeapi.io → 淘宝授时）
        │  依次重试、按半程时延补偿
        ▼
   clockOffsetMs ─────────────┐
                              │  nowMs() = Date.now() + offset
   CAL（内置表 + timor.tech） ─┤
        │  mergeCalendar      │
        │  + bumpCalendar     │   ← 合并后必须让核心的区间缓存失效
        ▼                     ▼
   peak-valley-core.getSegment(nowMs, CAL)
        │
        ├─► server.js  buildStatus()  → JSON（/v1/fenggu）｜ 纯文本（buildText）
        └─► 网页       渲染导航/状态卡/时段表/14 天日历
```

三个出口（JSON / 文本 / 网页）**共用同一个 `getSegment` 结果**，不存在各算各的。

### 缓存与失效

`core` 里有一份**单条**区间缓存（key = 日界 + span + 内部版本 + 日历指纹）。
契约：

| 改动方式 | 是否自动失效 |
|---|---|
| 换一份日历对象 | ✅ 指纹能识别 |
| 就地增删条目（条数变化） | ✅ 指纹能识别 |
| 就地替换键、条数不变 | ❌ **必须显式调用 `bumpCalendar()`** |

`server.js` 在合并联网日历后确实调用了 `bumpCalendar()`（见 `syncHolidays`）。

---

## 四、`server.js` 的内部分层

472 行的单文件，按依赖顺序分成 7 段（文件头部有导航注释）：

| 段 | 职责 |
|---|---|
| 常量与运行时状态 | 端口、`stats`、`STARTED_AT` |
| 日历与时钟状态 | `CAL`（内置表克隆）、`clockOffsetMs`、`timeSource` |
| 校时 / 日历同步 | `syncClock` / `syncHolidays`（失败只降级、不抛） |
| 状态构建 | `buildStatus` / `buildText` / `calendarStats`（领域对象 → API 载荷） |
| HTTP 响应 helper | `applyCommonHeaders` / `sendJson` / `sendText` / `parseAt` / `serveStatic` |
| 路由分发 | `handleRequest`（OPTIONS → 方法校验 → API → healthz → 静态 → 404） |
| 服务与进程生命周期 | `createServer` / `installProcessHandlers` / `start` |

**三条响应路径（JSON / 文本 / 静态）必须用同一个 `applyCommonHeaders()`** ——
CORS、禁嗅探、`Server-Timing` 集中一处，避免某一路径漏设（静态文件曾经就漏了 `Server-Timing`）。

`errors` 计数只有一个自增点（`res` 的 `finish` 事件，且只统计 5xx）。
请求处理里出错**不要**再手动自增，否则同一次失败会被记两次。

---

## 五、网页为什么是单文件

如果把 CSS/JS 拆成独立文件，会失去：

- 双击打开即可离线使用（`file://` 下没有同源限制，但如果拆成相对路径引入反而更容易缺文件）；
- 无构建步骤、无缓存失效问题（一个文件就是一次请求）；
- 发布简单（传 1 个文件 vs 传 3 个）。

代价是文件较大（约 1100 行）。缓解办法是**文件头部的结构导航 + 段落分隔注释**，
而不是拆分。`test/test-ui.mjs` 直接从 HTML 里抽取内联脚本在最小 DOM 桩里执行，
因此 UI 逻辑是被真实测试覆盖的（不是"看着对"）。

---

## 六、扩展点

| 想加什么 | 改哪里 | 注意 |
|---|---|---|
| 新的时段规则 | `core` 的 `boundaryMinutes()` / `isValleyAt` | `test-oracle.mjs` 里有一份**独立重写**的对照实现，改完必须同步，否则它会失败（这正是它的用处） |
| 新的数据源 | `feeds` 的 `TIME_SOURCES` | 保持「依次重试 + 超时 + 失败降级」，并用注入式 fetch 补测试 |
| 新的端点 | `server.js` 的 `handleRequest` + `STATIC` 表 | 记得走 `applyCommonHeaders`，并补 `test-api` 断言 |
| 新的 UI 模块 | 网页 IIFE 里新增一段 + `test-ui.mjs` 补场景 | 外部数据进 `innerHTML` 前必须过 `esc()` |
| 新的检查项 | `test/check-*.cjs` | 优先做成「违反即失败」的不变量，而不是打印一行提示 |

---

## 七、测试架构

```
npm run test:unit   8 个套件，不需要服务端（含 check-cwd：从仓库外目录再跑一遍）
npm test            11 个套件 + README 数字一致性校验（需要先 npm start）
```

- **断言集中在 `test/`，不复制交付代码**：套件直接 `require` 交付用的模块，避免"测试通过但线上是另一份代码"。
- **独立对照实现**：`test-oracle.mjs` 用另一种写法逐分钟比对 157 万分钟。
- **变异测试**：粒子路径、通知失败、XSS 转义、重试频率等修复都做过"故意改回去看测试是否变红"的验证。
- **文档防漂移**：`test-all.mjs` 会解析各套件的实际断言数，与 README 表格交叉比对，不一致即失败。
- **`check-cwd.mjs`** 保证所有套件不依赖当前工作目录（脚本用自身位置推导仓库根）。

---

## 八、明确的取舍（知道就好，不必改）

| 取舍 | 原因 |
|---|---|
| 运行时不做多目录分层 | 4 文件部署契约 + 代码量不足以摊薄目录成本 |
| 不用 ESM | 浏览器与服务端共用 UMD 源码；切 ESM 会破坏共享方式 |
| 不引入构建步骤 | 零依赖、零构建是主要卖点之一 |
| 网页不拆 CSS/JS | 保离线单文件 |
| 不引第三方库（含测试框架） | Node 内置足以覆盖；也避免依赖供应链风险 |
| 进程级兜底只在作为服务运行时安装 | 被 `require` 时不应污染宿主进程（例如测试进程） |
