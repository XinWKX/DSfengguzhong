# DS峰谷钟 部署包

## 文件清单（就这 4 个，必须放在同一目录）

| 文件 | 作用 |
|---|---|
| `server.js` | API 服务：/v1/fenggu、静态托管、校时与日历同步 |
| `peak-valley-core.js` | 峰谷判定核心（服务端与网页共用同一份） |
| `peak-valley-feeds.js` | 联网数据源：三源校时 + 法定节假日日历 |
| `deepseek-peak-valley.html` | 网页本体（通过相对路径加载上面两个 js） |

本目录已实测可独立运行：不依赖任何 npm 包，只用 Node 内置模块（http / fs / path / zlib）。

## 运行要求

- **Node.js 18 或更高**（需要全局 `fetch` 用于联网校时与节假日同步）。
  低于 18 仍可启动，但拿不到网络时间与最新日历，会退回内置节假日表 + 本机时钟。
- 单个进程，内存约 60–75 MB，CPU 几乎为零（服务端处理 p50 约 0.07ms）。
- 只有一个文件读写动作：启动后按请求读取本目录下的网页与两个 js，无数据库、无缓存目录。

## 启动

```bash
node server.js            # 默认 0.0.0.0:8787
node server.js 9000       # 指定端口
PORT=9000 HOST=127.0.0.1 node server.js   # 用环境变量
```

开机自启（Linux systemd 示例）：

```ini
[Unit]
Description=DeepSeek peak/valley API
After=network-online.target

[Service]
WorkingDirectory=/opt/ds-fenggu
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Windows 可用 nssm 或任务计划程序注册为服务。

## 对外提供域名

反向代理到本服务端口即可（nginx 示例）：

```nginx
server {
    listen 443 ssl http2;
    server_name your.domain.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Caddy 更简单：`your.domain.com { reverse_proxy 127.0.0.1:8787 }`（自动签证书）。

## 用 1Panel + OpenResty 部署

1Panel 的网站功能基于应用商店安装的 OpenResty（Docker 容器），完整步骤见 `DEPLOY-1PANEL.md`，
要点：

1. 把 4 个运行文件传到服务器同一目录（如 `/opt/ds-fenggu`）；
2. `cd /opt/ds-fenggu && sudo bash install.sh` 注册 systemd 服务（脚本会自检并打印状态）；
3. 1Panel：**网站 → 创建网站 → 反向代理**，代理地址填 `127.0.0.1:8787`
   （**不要带 http://** —— 1Panel 会把它写进 nginx upstream 块，带协议会报
   `invalid port in upstream` 并导致配置测试失败）；
4. **网站配置 → HTTPS** 申请证书并开启强制 HTTPS；
5. **防火墙**只放行 80/443，不要放行 8787。

遇到 502 先看 `DEPLOY-1PANEL.md` 第四章：OpenResty 在容器里，`127.0.0.1` 未必指宿主机，
bridge 网络下需改填 Docker 网关（`172.17.0.1`）或宿主机内网 IP。

## 出网要求（可选，失败会优雅降级）

| 域名 | 用途 |
|---|---|
| worldtimeapi.org / timeapi.io / api.m.taobao.com | 校时（三源依次重试） |
| timor.tech | 法定节假日日历（每年更新） |

三个授时源全不通时使用本机时钟；日历不通时使用内置的 2025–2026 表并在响应里给出 `calendar_warning`。

## 部署后自检

```bash
curl -s localhost:8787/healthz            # {"ok":true,...}
curl -s localhost:8787/v1/fenggu | head   # 当前峰谷状态
curl -sI localhost:8787/v1/fenggu         # 应看到 X-Fenggu: valley|peak
curl -s localhost:8787/v1/fenggu?at=2026-10-09T10:00:00%2B08:00   # 工作日高峰应为「峰」
curl -s localhost:8787/ | head -3         # 网页
```

## 不需要上传的文件

源码目录里还有测试与检查脚本（`test-*.mjs` / `check-*.cjs`）以及一次性工具
（`gen-holidays.mjs` / `sample-theme.py`），它们**只用于开发与验证，服务器不需要**。
建议留在代码仓库或 CI 里跑：`node test/test-all.mjs`（11 套件 / 313 项断言）。
