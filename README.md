# DS峰谷钟

实时显示 DeepSeek API 当前处于**高峰**（戏称「梁文峰」）还是**空闲**（戏称「梁文谷」）时段，
倒计时到下一次切换，并附带法定节假日日历、未来 14 天时段表和一个零依赖的 HTTP 接口。

> 由 **创想工作室** 开发与维护 · 版权归创想工作室所有 · 以 [GPL-3.0](LICENSE) 开源（copyleft）

![banner](assets/logo.svg)

- **单文件网页**：一个 HTML 打开即用，也可以脱离服务端离线打开（接口部分不可用）
- **零依赖服务端**：只用 Node 内置模块，没有 `npm install` 这一步
- **判定逻辑只写一份**：`peak-valley-core.js` 同时被网页与服务端引用，不会两边分叉
- **自动同步信息**：三源联网校时（依次重试）+ 自动拉取法定节假日日历（含调休上班日）
- **11 个测试套件 / 337 项断言**：含一份独立重写的对照实现、变异测试与性能基线

---

## 峰谷规则

依据 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：

| 时段 | 北京时间 | 计费 |
|---|---|---|
| **高峰**（梁文峰） | 周一至周五（**不含**中国法定节假日）`09:00–12:00`、`14:00–18:00` | 全价 |
| **空闲**（梁文谷） | 其余全部：工作日夜间与午休、**周末全天**、**法定节假日全天**，以及调休上班的周末 | **半价** |

一天里的切换只会发生在 `00:00 / 09:00 / 12:00 / 14:00 / 18:00`。
国庆这类长假会让「空闲」连续覆盖 7 天以上（例：2026 年国庆从 `09-30 18:00` 一直到 `10-08 09:00`）。

> 节假日数据来自公开日历接口，并内置 2025–2026 年表作为离线兜底。
> 若查询年份尚未录入（例如国务院还没公布），接口会返回 `calendar_warning` 而不是静默给出错误结果。

---

## 快速开始

需要 **Node.js 18 或更高**（用到全局 `fetch`；更低版本仍可启动，但无法联网校时与同步日历）。

```bash
git clone https://github.com/XinWKX/ds-fenggu.git
cd ds-fenggu
npm start                 # 默认 0.0.0.0:8787
```

打开 <http://127.0.0.1:8787> 即可。

只想看网页、不跑服务：直接双击 `deepseek-peak-valley.html`（它需要与两个 `.js` 放在同一目录）。

常用环境变量：

```bash
PORT=9000 HOST=127.0.0.1 node server.js
```

---

## HTTP API

| 端点 | 说明 |
|---|---|
| `GET /` | 网页 |
| `GET /v1/fenggu` | 当前峰谷状态（JSON） |
| `GET /v1/fenggu.txt` | 纯文本摘要（状态、名称、判定依据、距下次切换，共 7~8 行） |
| `GET /fenggu` | `/v1/fenggu` 的短别名 |
| `GET /healthz` | 存活检查（含请求数、内存、校时来源） |
| `GET /peak-valley-core.js`、`/peak-valley-feeds.js` | 网页依赖的模块 |

查询参数：

| 参数 | 说明 |
|---|---|
| `?at=<ISO 或 unix>` | 查询任意时刻，如 `?at=2026-10-09T10:00:00+08:00`；纯数字按 unix 时间戳解释（≤10 位为秒）。**不带时区偏移的时间串按北京时间解释**（`2026-10-09T10:00:00` 与 `2026-10-09` 都按 +08:00），所以结果不随服务器时区变化 |
| `?format=text` | 返回纯文本（等价于 `.txt`，也支持 `Accept: text/plain`） |
| `?pretty` | JSON 缩进输出，便于人看 |

```bash
curl -s localhost:8787/v1/fenggu
```

```json
{
  "ok": true,
  "fenggu": "谷",
  "name": "梁文谷",
  "is_valley": true,
  "price": { "tier": "off_peak", "label": "空闲时段 · 半价", "ratio": 0.5 },
  "reason": "法定节假日「国庆节」全天按空闲时段计费",
  "now": {
    "iso": "2026-10-03T20:55:53+08:00",
    "utc": "2026-10-03T12:55:53Z",
    "unix": 1791032153,
    "date": "2026-10-03",
    "weekday": "周六",
    "is_weekend": true,
    "holiday": "国庆节",
    "makeup_workday": null,
    "minute_of_day": 1255
  },
  "current": {
    "start": "2026-09-30T18:00:00+08:00",
    "end": "2026-10-08T09:00:00+08:00",
    "duration_seconds": 658800,
    "elapsed_seconds": 361844,
    "remaining_seconds": 296956,
    "progress": 0.5492
  },
  "next": {
    "fenggu": "峰",
    "name": "梁文峰",
    "tier": "peak",
    "at": "2026-10-08T09:00:00+08:00",
    "in_seconds": 296956,
    "in_human": "3 天 10:29:15",
    "in_duration": "3 天 10 小时"
  },
  "day": {
    "date": "2026-10-04",
    "weekday": "周日",
    "is_weekend": true,
    "holiday": "国庆节",
    "makeup_workday": null,
    "all_day_valley": true
  },
  "rules": {
    "peak_windows_cst": [["09:00", "12:00"], ["14:00", "18:00"]],
    "peak_days": "周一至周五（不含中国法定节假日）",
    "valley": "其余全部：工作日夜间与午休、周末全天、法定节假日全天、调休上班的周末",
    "ratio": "空闲时段单价 = 高峰时段单价的一半"
  },
  "calendar": {
    "year": "2026",
    "covered": true,
    "counts": { "holidays": 33, "workdays": 6 },
    "source": "内置 + timor.tech（2025、2026）",
    "years": ["2025", "2026"]
  },
  "server": {
    "version": "1.1.0",
    "time_source": "timeapi.io",
    "clock_offset_ms": 213,
    "clock_synced_at": "2026-10-04T22:12:51+08:00",
    "calendar_current": { "year": "2026", "holidays": 33, "workdays": 6 },
    "uptime_seconds": 8278,
    "generated_at": "2026-10-04T22:30:44+08:00"
  },
  "source": "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
  "project": { "name": "DS峰谷钟", "author": "创想工作室", "license": "GPL-3.0-or-later" }
}
```

> 上面是**完整**响应（某次真实请求的输出）。`test/test-api.mjs` 会把这个示例的
> 字段集合与真实响应比对，多一个漏一个都会失败，所以文档与接口不会走偏。

主要字段：

| 字段 | 说明 |
|---|---|
| `fenggu` / `name` / `is_valley` | 当前状态：`谷`（梁文谷）/ `峰`（梁文峰） |
| `price` | `tier`（`off_peak` / `peak`）、展示文案、`ratio`（半价 0.5 / 全价 1） |
| `reason` | 当前判定的依据（如「法定节假日「国庆节」全天按空闲时段计费」） |
| `now` | 北京时间各分量；`minute_of_day` 是当天第几分钟 |
| `current` | 当前时段的起止与耗时进度（含 `remaining_seconds`） |
| `next` | 下一次切换的时间、倒计时（秒 / 人话 / 时长三种写法） |
| `day` | 当天属性汇总；`all_day_valley` 表示整天都是空闲 |
| `rules` | 判定规则本身，便于调用方自行解释 |
| `calendar` | 日历覆盖情况；`covered=false` 时会附带 `calendar_warning` |
| `server` | 校时来源与偏移、运行时长、生成时刻 |
| `project` | 项目署名：名称 / 作者 / 协议 |

响应头里有四个可直接用于探活/展示的字段：

```
X-Fenggu: valley | peak          机器友好
X-Fenggu-CN: %E8%B0%B7           百分号编码的「谷 / 峰」
X-Next-At: 2026-10-08T09:00:00+08:00
Server-Timing: app;dur=0.173     服务端真实处理耗时（毫秒）
```

错误码：`400 invalid_at`（时间参数无法解析或超出可表示范围）、`404 not_found`、`405 method_not_allowed`。

---

## 部署

### 1. 只需要 4 个文件

| 文件 | 作用 |
|---|---|
| `server.js` | API 服务 + 网页托管 |
| `peak-valley-core.js` | 峰谷判定核心（服务端与网页共用） |
| `peak-valley-feeds.js` | 联网数据源：校时 + 节假日日历 |
| `deepseek-peak-valley.html` | 网页 |

放在同一目录，`node server.js` 即可。其余文件（测试、工具）服务器不需要。

也可以 `npm run build` 生成 `dist/` 部署包（含 `install.sh` 与 systemd 单元）。

### 2. systemd

```bash
cd /opt/ds-fenggu && sudo bash install.sh
```

脚本会校验 Node 版本与文件完整性、生成 systemd 服务并自检接口。

### 3. 1Panel + OpenResty

完整步骤见 [`deploy/DEPLOY-1PANEL.md`](deploy/DEPLOY-1PANEL.md)。要点：

1. 4 个文件传到 `/opt/ds-fenggu`，`sudo bash install.sh`；
2. 1Panel：**网站 → 创建网站 → 反向代理**，**代理地址填 `127.0.0.1:8787`（不要带 `http://`）**
   —— 1Panel 会把它写进 nginx 的 `upstream` 块，带协议会报 `invalid port in upstream`；
3. **网站配置 → HTTPS** 申请证书并开启强制 HTTPS（桌面通知功能必须走 HTTPS）；
4. 防火墙只放行 80/443，不要放行 8787。

> ⚠️ OpenResty 跑在 Docker 容器里，容器内的 `127.0.0.1` 未必是宿主机。
> 若改完仍 502，按 `DEPLOY-1PANEL.md` 第四章排查（host 网络模式填 `127.0.0.1`，bridge 模式填 Docker 网关 `172.17.0.1` 或宿主机内网 IP）。

---

## 架构与设计

分层、依赖方向、为什么是 4 个文件、为什么不拆 CSS/JS、扩展点与已知取舍，
见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 开发与测试

```bash
npm run test:unit     # 不需要服务：判定逻辑、独立对照、数据源、网页 UI、结构/图标/质量检查
npm start &           # 另开一个终端
npm test              # 全套 11 个套件（含 API 端到端、加固审计、压测）
```

> 所有命令都**不依赖当前工作目录** —— 脚本用自身位置推导仓库根，从任意目录调用都可以；
> `check-cwd.mjs` 会从仓库外的目录把无需服务端的套件再跑一遍，确保这一点不回退。

`BASE` 环境变量可以指定被测服务地址（默认 `http://127.0.0.1:8787`）：

```bash
BASE=http://127.0.0.1:8788 npm test
```

| 套件 | 断言 | 覆盖内容 |
|---|---|---|
| `test/test-peak-valley.mjs` | 66 | 规则边界、节假日、调休、日历覆盖检测 |
| `test/test-oracle.mjs` | 14 | **独立重写一份对照实现**逐分钟比对（157 万分钟）＋性能基线；末节会真实联网与线上日历交叉核对，源不可达或返回空数据时该项自动跳过（此时为 12） |
| `test/test-feeds.mjs` | 45 | 校时降级链、超时、日历解析校验（全部用注入的假 fetch，不联网） |
| `test/test-ui.mjs` | 81 | **真跑网页 UI 脚本**（最小 DOM 桩）＋渲染性能＋通知功能的七种结局 |
| `test/test-api.mjs` | 72 | 端到端 HTTP，逐字段与核心模块对齐，并校验 README 的响应示例与真实响应一致 |
| `test/test-hardening.mjs` | 40 | 外部数据污染、参数语义、HTTP 边界、越权读取 |
| `test/test-load.mjs` | 19 | 延迟分位、并发、gzip、内存漂移 |
| `test/check-html.cjs` | — | id/锚点/标签配对、脚本编译、字体链、无表情符号守卫、品牌色钉死 |
| `test/check-icons.mjs` | — | 手绘 SVG 图标的路径语法与弧线几何 |
| `test/check-quality.cjs` | — | 死代码、重复实现守卫、库模块纯净度、CSS 死类、署名与协议一致性、版本一致性 |
| `test/check-cwd.mjs` | — | 从仓库外的目录把无需服务端的套件再跑一遍，确保脚本不依赖当前工作目录 |

全部套件都在 `test/` 目录下，可直接 `node test/<文件名>` 单独运行。

几处值得一提的做法：

- **测试用真实代码，不复制逻辑**：套件直接 `require` 交付用的模块，不存在"测试通过但线上是另一份代码"。
- **变异测试验证断言有效**：曾故意把 `moveTo` 从粒子路径里删掉、把旧的通知实现换回去、
  把读取路径改回 CWD 相对写法，确认对应断言都会变红。
- **性能有基线**：`getSegment` 约 50 万次/秒（区间缓存），服务端处理 p50 约 0.07 ms。

---

## 项目结构

```
.
├── server.js                 # HTTP 服务：API + 静态托管 + 校时/日历同步
├── peak-valley-core.js       # 峰谷判定核心（浏览器 / Node 共用，UMD）
├── peak-valley-feeds.js      # 联网数据源：三源校时 + 节假日日历（UMD）
├── deepseek-peak-valley.html # 网页（内含 UI 脚本与手绘 SVG 图标库）
├── ARCHITECTURE.md           # 分层、依赖方向、扩展点与取舍
├── build-dist.mjs            # 生成 dist/ 部署包
├── deploy/
│   ├── DEPLOY-1PANEL.md      # 1Panel + OpenResty 部署与 502 排查
│   ├── install.sh            # 一键注册 systemd 服务
│   └── ds-fenggu.service     # 服务单元参考模板
├── test/                     # 11 个测试/检查套件 + 运行器
└── tools/                    # 一次性工具（生成日历表、从参考图取色）
```

---

## 数据来源

| 用途 | 来源 |
|---|---|
| 计费规则 | [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) |
| 法定节假日 / 调休 | 公开节假日接口（`timor.tech`），与各省放假通知核对过 |
| 校时 | `worldtimeapi.org` → `timeapi.io` → 淘宝授时，依次重试，按半程时延补偿 |

四个域名都不可达时会优雅降级：校时退回本机时钟，日历退回内置表，接口照常可用，
并在响应里说明情况（`calendar_warning`、日志告警）。本项目的判定全程按 UTC 计算，
所以**修改服务器或浏览器的时区不会影响结果**。

---

## 免责声明

- 本项目与 DeepSeek 官方**没有任何关系**，是个人工具，「DS峰谷钟」也不是官方产品名。
- 「梁文峰 / 梁文谷」是把高峰价与空闲价戏称为「梁文锋价 / 梁文谷价」的网络说法，属用户玩梗，
  与任何真实人物无关。
- 计费与空闲时段规则**以官方公告为准**。本项目只按公开规则与日历做时间判定，不构成任何计费承诺。

## 项目归属

**DS峰谷钟（DS Fenggu Zhong）是创想工作室的项目**，版权归创想工作室所有，
以 **GNU 通用公共许可证第 3 版或更新版本（GPL-3.0-or-later）** 开源。

| 位置 | 署名 |
|---|---|
| [`NOTICE`](NOTICE) | `DS峰谷钟 (DS Fenggu Zhong)` / `Copyright (C) 2022 创想工作室 (Chuangxiang Studio)` |
| `LICENSE` | GNU General Public License v3 全文（35,149 字节，与官方一致） |
| 四个运行文件头部 | 版权声明 + `SPDX-License-Identifier: GPL-3.0-or-later` |
| `package.json` | `"author": "创想工作室"` · `"license": "GPL-3.0-or-later"` |
| 网页页脚 | `© 2022 创想工作室 — 以创意为经纬，以技术为基石` |
| 网页 `<meta name="author">` | `创想工作室` |
| `/v1/fenggu` 响应 `project` 字段 | `{ "name": "DS峰谷钟", "author": "创想工作室", "license": "GPL-3.0-or-later" }` |

### 为什么用 GPL-3.0

GPL-3.0 是**强 copyleft**：任何分发衍生作品的人，都必须把**完整源码**以同一许可证
（GPL-3.0）公开，并显著标明改了哪些文件。因此没人能把本项目改个名字闭源卖掉，
来源与作者自然也就保留了下来。

| 协议 | 别人改完可以不公开源码吗 | 适合的场景 |
|---|---|---|
| MIT / Apache-2.0 | **可以**（只需保留声明） | 希望被最广泛采用、允许闭源集成 |
| **GPL-3.0**（本项目） | **不可以**，衍生作品必须同样开源 | 希望改动回馈社区、防止被闭源私有化 |
| AGPL-3.0 | 不可以，且**架成网络服务也要开源** | 担心别人拿去做闭源 SaaS |

> **一个必须知道的边界**：GPL-3.0 约束的是**分发**。如果有人只是把本项目部署成网站
> 对外提供服务、并不分发程序本身，GPL-3.0 **不要求**他公开源码 —— 这正是 AGPL-3.0
> 要堵的缺口。如果你在意的是这个场景，把 `LICENSE` 换成 AGPL-3.0 并同步三处标注即可。

引用、二次开发或分发时，请保留 `LICENSE` 与源码里的版权声明（GPL-3.0 的强制要求）。

## License

[GNU General Public License v3.0 or later](LICENSE) © 2022 创想工作室 (Chuangxiang Studio)

本程序是自由软件：你可以依据 GNU 通用公共许可证（第 3 版或更新版本）的条款重新分发
和/或修改它。本程序按“原样”提供，不带任何担保。完整条款见 [`LICENSE`](LICENSE)，
或 <https://www.gnu.org/licenses/>。
