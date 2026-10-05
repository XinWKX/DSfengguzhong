# 在 1Panel + OpenResty 上部署 DS峰谷钟

1Panel 的网站功能基于**应用商店安装的 OpenResty**（跑在 Docker 容器里）。
本站是一个自带 HTTP 服务的 Node 程序，所以核心就两件事：**让 Node 服务常驻** + **让 OpenResty 反代过去**。

---

## 一、两种方案怎么选

| | 方案 A：反向代理 + systemd（推荐） | 方案 B：1Panel 原生 Node 运行环境网站 |
|---|---|---|
| 进程管理 | systemd（面板外，最稳） | 1Panel 托管 |
| 需要上传 | 4 个文件 | 4 个文件 |
| 端口 | Node 监听 8787，OpenResty 反代 | 面板创建时指定 |
| 优点 | 与面板版本无关；进程行为完全透明；一条 `systemctl restart` 就能重启 | 全在面板里点，少写一个 service 文件 |
| 缺点 | 要执行一次安装脚本 | 各版本 Node 网站的字段略有差异 |

**建议用方案 A**：本项目零依赖、单文件入口，systemd 是最省事也最不容易出岔子的方式。

---

## 二、方案 A：反向代理 + systemd

### 步骤 1：上传 4 个文件

1Panel 左侧 **系统 → 文件**，进入 `/opt`，新建目录 `ds-fenggu`，
把部署包里的 4 个文件传进去（`server.js`、`peak-valley-core.js`、`peak-valley-feeds.js`、`deepseek-peak-valley.html`）。
也可以传 zip 后在面板里解压。

> 也可以直接在 **终端** 里操作：
> ```bash
> mkdir -p /opt/ds-fenggu && cd /opt/ds-fenggu
> # 把 4 个文件放进来（面板上传 / scp / wget 均可）
> ls -l   # 确认 4 个都在
> ```

### 步骤 2：确认 Node.js 18+

1Panel 左侧 **终端**：

```bash
node -v
```

没装或用的是老版本（低于 18 就没有全局 `fetch`，联网校时和节假日同步会失效）：

```bash
# Debian / Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
# RHEL / CentOS / Rocky
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs
```

> 也可以用 1Panel **应用商店** 里的 Node.js 运行环境来装，二选一即可。

### 步骤 3：注册为系统服务

把部署包里的 `install.sh` 传到 `/opt/ds-fenggu/`，然后：

```bash
cd /opt/ds-fenggu
bash install.sh
```

脚本会：校验 Node 版本与 4 个文件是否齐全 → 生成 `/etc/systemd/system/ds-fenggu.service`
→ `systemctl enable --now ds-fenggu` → 打印状态并自检接口。

手工等价操作（不想跑脚本的话）：

```bash
cat > /etc/systemd/system/ds-fenggu.service <<'EOF'
[Unit]
Description=DS峰谷钟
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ds-fenggu
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Environment=HOST=0.0.0.0
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload && systemctl enable --now ds-fenggu
systemctl status ds-fenggu --no-pager
```

`ExecStart` 里的 node 路径用 `command -v node` 的实际结果。

### 步骤 4：建反向代理网站

1Panel 左侧 **网站 → 创建网站 → 反向代理** 标签页，按官方字段逐个填：

| 字段 | 填什么 |
|---|---|
| 分组 | 默认分组即可 |
| 主域名 | 你的域名（如 `fenggu.example.com`），不带端口 |
| 其他域名 | 留空 |
| 监听 IPv6 | 按需 |
| 代号 | 如 `ds-fenggu`（决定网站目录名） |
| **代理地址** | `127.0.0.1:8787` ← **不要带 `http://`**，见下方说明 |
| 启用 HTTPS | 先不勾，证书申请好再开 |
| 备注 | DS峰谷钟 |

> 当前项目**一个反代即可覆盖全部路径**：网页在 `/`，接口在 `/v1/fenggu`，
> 都由 Node 提供，不需要分流。

#### 代理地址为什么不能带 `http://`

1Panel 会把「代理地址」写进 nginx 的 **upstream 块**：

```nginx
upstream fenggu.example.com {
    server 127.0.0.1:8787;      # ← 这里只能是 host:port
}
```

填成 `http://127.0.0.1:8787` 会直接报错、保存失败：

```
[emerg] invalid port in upstream "http://127.0.0.1:8787"
          in /www/sites/<域名>/proxy/root.conf:2
nginx: configuration file .../nginx.conf test failed
```

**规则总结：**

| 位置 | 写法 |
|---|---|
| 1Panel 界面「代理地址」 | `127.0.0.1:8787`（不带协议） |
| 手写 nginx 的 `proxy_pass` | `http://127.0.0.1:8787;`（必须带协议） |
| 命令行 curl | `http://127.0.0.1:8787/healthz`（必须带协议） |

### 步骤 5：HTTPS

**网站 → 选中该站点 → 配置 → HTTPS**：
1. 点「申请证书」（Let's Encrypt，1Panel 会自动续期），或先在 **证书** 菜单上传自己的证书；
2. 选择该证书 → **启用 HTTPS**；
3. 打开 **强制 HTTPS**（HTTP 自动 301 到 HTTPS）。

### 步骤 6：防火墙只放 80 / 443

**主机 → 防火墙**：放行 `80`、`443`。
**不要**放行 `8787` —— 反代的意义就是只暴露 80/443。

如果 OpenResty 是 bridge 网络、必须让容器通过宿主机 IP 访问 Node，
那 8787 会对外可听，此时务必在 1Panel 防火墙里**拒绝** 8787，或限制来源为内网段。

### 步骤 7：自检

```bash
curl -s localhost:8787/healthz            # {"ok":true,...}
curl -s localhost:8787/v1/fenggu.txt      # 当前峰谷状态
curl -sI localhost:8787/v1/fenggu | grep -i x-fenggu
curl -s https://你的域名/v1/fenggu.txt    # 走域名（反代 + HTTPS）
curl -s https://你的域名/ | head -3       # 网页
```

---

## 三、方案 B：1Panel 原生 Node.js 运行环境网站

1. **运行环境** → 新建一个 Node.js 运行环境（选 18 以上版本）。
2. **网站 → 创建网站 → 运行环境**：
   - **类型**：选 `Node.js` 及刚才创建的那个运行环境；
   - **端口**：`8787`（或让面板分配）；
   - **主域名 / 代号**：同上；
   - **启用 HTTPS**：证书准备好后勾选。
3. 把 4 个文件放进该网站的目录（面板里会显示路径，通常在 `/opt/1panel/www/sites/<代号>/` 下）。
4. 在站点配置里把**启动文件/入口**指向 `server.js`（不同 1Panel 版本这里的叫法略有差异），保存并启动。
5. 打开站点 → 确认状态为「运行中」，再按方案 A 的步骤 7 自检。

> 方案 B 的面板字段随版本变动较大。如果找不到「启动文件」之类的设置，直接改用方案 A。

---

## 四、502 排查（1Panel 最常见的坑）

OpenResty 装在 Docker 容器里，**容器内的 `127.0.0.1` 不一定是宿主机的 `127.0.0.1`**。
官方论坛有同样的问题：<https://bbs.fit2cloud.com/t/topic/13989/>

按下面顺序排查：

**1）先在服务器上确认 Node 本身是好的**

```bash
curl -s http://127.0.0.1:8787/healthz      # 宿主机上能通
systemctl status ds-fenggu --no-pager      # 服务在跑
ss -lntp | grep 8787                       # 有进程在监听
```

宿主机通、域名 502 → 问题在容器到宿主机这一段。

**2）看 OpenResty 的网络模式**

1Panel **应用商店 → 已安装 → OpenResty → 查看参数**（或 **容器 → 容器列表** 点 OpenResty 看网络）：

- 参数里有 `network_mode: host`（或网络显示 `host`）→ **容器与宿主机共用网络**，
  代理地址填 `127.0.0.1:8787` 即可，这也是 1Panel 多数情况的默认值。
- 若是 bridge 模式（有独立 IP，如 `172.18.0.x`）→ 容器里的 `127.0.0.1` 是它自己，会 502。

**3）bridge 模式下的正确填法**

```bash
ip addr show docker0 | grep 'inet '        # 取网关，通常是 172.17.0.1
# 或者直接取宿主机内网 IP
hostname -I
```

- 代理地址填 `172.17.0.1:8787`（Docker 网关）或 `<宿主机内网IP>:8787`（同样**不带** `http://`）；
- 前提是 Node 监听在 `0.0.0.0`（部署包默认就是），只监听 `127.0.0.1` 的话容器访问不到。

**4）从容器内部直接验证**

```bash
docker ps | grep -i openresty              # 拿到容器名
docker exec <容器名> curl -s http://172.17.0.1:8787/healthz
docker exec <容器名> curl -s http://127.0.0.1:8787/healthz
```

哪条通就用哪条对应的地址填进「代理地址」。

---

## 五、日常运维

```bash
# 日志
journalctl -u ds-fenggu -f

# 重启 / 停止
systemctl restart ds-fenggu
systemctl stop ds-fenggu

# 看接口是否正常（含服务端处理耗时）
curl -sI https://你的域名/v1/fenggu | grep -i server-timing
```

**升级**：覆盖 4 个文件 → `systemctl restart ds-fenggu`。
**回滚**：保留上一版 4 个文件，覆盖回去再重启即可（无数据库、无状态，回滚零成本）。

**检查出网**（不通会降级为内置日历 + 本机时钟，日志里会有告警）：

```bash
journalctl -u ds-fenggu | grep -E 'clock|calendar'
```

---

## 六、说明

- 本指南的 **Node 运行、接口自检、4 个文件的完整性** 都在开发机上实测过（部署包 `dist/` 实测可独立运行）。
- **1Panel 界面步骤** 依据官方文档字段（[创建网站](https://docs.fit2cloud.com/1panel/user_manual/websites/website-create)、[OpenResty](https://docs.fit2cloud.com/1panel/user_manual/appstore/openresty)）编写，界面随版本可能有细微差异。
- **systemd / install.sh** 无法在开发环境（Windows）执行验证，语法按标准写法编写；如报错把输出发我。
