# OTP Relay — iPhone 验证码自动填到 Windows 浏览器

[English](README.en.md) | 中文

把 iPhone 收到短信验证码这件事，做成接近 Mac「连续互通」的体验：

```
iPhone 收到短信
   │  快捷指令（信息自动化，立即运行）
   ▼
POST http://你的NAS:8099/api/code
   │  NAS 上的 otp-relay（只存在内存，默认 180 秒过期）
   ▼
SSE 推送到 Chrome / Edge 扩展
   │
   ▼
当前网页的验证码输入框里自动出现 6 位数字
```

- 不需要 Apple 设备，不需要第三方云服务，验证码不经过任何外部服务器。
- 服务端只有一个 `server.js`，用 Docker 跑在 NAS 上，无数据库、无持久化。
- 浏览器找不到输入框时，会在右上角弹一个「验证码 123456 · 点击复制」的小提示。

---

## 目录

```
otp-relay/
├── server.js              # NAS 服务（Bun，零依赖）
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── README.md
└── extension/             # Chrome / Edge 扩展（加载已解压的扩展程序）
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── popup.html
    └── popup.js
```

---

## 一、在 NAS 上启动服务

### 1. 准备一个令牌

令牌是唯一的口令，长度至少 16 位，建议 32 位以上。Windows PowerShell 里执行：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
-join ($bytes | ForEach-Object { $_.ToString("x2") })
```

或者在 NAS 的 SSH 里：

```bash
openssl rand -hex 24
```

把输出复制下来，例如 `9f3c...`。下面所有地方都用同一个值。

### 2. 绿联 UGOS Pro 部署（Docker 项目）

需要 UGOS Pro 固件 **1.19.1.0126 或更高**（才有「项目 / Docker Compose」入口）。DH2300 不支持 Docker，DXP / DH4300 Plus 等型号一般支持。

1. 应用中心安装 **Docker**。安装完成后会自动创建一个 `docker` 共享文件夹。
2. 打开 Docker → 设置，确认已经配置**镜像加速器**（国内拉 Docker Hub 基本都需要）。
3. Docker → **项目** → **创建**：
   - 项目名称：`otp-relay`
   - Compose 配置：粘贴下面内容，把 `OTP_TOKEN` 换成第 1 步生成的令牌。

```yaml
services:
  otp-relay:
    image: oven/bun:1-alpine
    container_name: otp-relay
    restart: unless-stopped
    working_dir: /app
    command: ["bun", "/app/server.js"]
    ports:
      - "8099:8099"
    environment:
      OTP_TOKEN: "这里换成你的令牌"
      OTP_TTL_SECONDS: "180"
    volumes:
      - ./server.js:/app/server.js:ro
```

4. **先不要急着部署**。用「文件管理」进入共享文件夹 `docker`，找到 `otp-relay` 目录（绿联通常会自动建好；没有就手动建一个），把 `server.js` 上传进去。
5. 回到 Docker → 项目，点「部署 / 立即部署」。如果刚才已经自动部署并报错，传完文件后点「重新部署」即可。首次会拉取 `oven/bun:1-alpine`，等状态变成运行中。
6. 浏览器打开：

```
http://NAS的局域网IP:8099/health
```

看到 `{"ok":true}` 就成功了；再打开 `http://NAS的局域网IP:8099/` 能看到「OTP Relay 正在运行」。

**绿联上常见的两个坑：**

| 现象 | 处理 |
|---|---|
| 日志报 `Cannot find module '/app/server.js'` | `server.js` 不在项目目录。确认它在 `docker/otp-relay/server.js`；也可以把 volumes 改成绝对路径（在文件管理里查看实际路径） |
| 拉取镜像失败 / 超时 | 在 Docker 设置里换可用的镜像加速器；或先在「镜像」页手动拉取 `oven/bun:1-alpine` 再部署 |
| 8099 被占用 | 把 `ports` 左边改成别的端口，例如 `"18099:8099"`，访问地址也随之改 |

> 如果你更想自己构建镜像：SSH 到 NAS，在项目目录执行 `docker build -t otp-relay:local .`，然后把 compose 里的 `image:` 换成 `otp-relay:local`，并删掉 `working_dir` / `command` / `volumes` 三行。

### 3. 其他 NAS / Docker CLI

把整个 `otp-relay` 文件夹传到 NAS，编辑 `docker-compose.yml` 里的令牌，然后：

```bash
cd /path/to/otp-relay
docker compose up -d
```

- 群晖 Container Manager：新建「项目」→ 选择文件夹里的 `docker-compose.yml` → 启动。
- 群晖旧版命令可能是 `docker-compose up -d`。
- QNAP / Unraid：同样支持 Compose；或者用 `Dockerfile` 构建镜像后映射 8099。

### 4. 没有 Docker 的备用启动方式

NAS 能装 Bun 的话：

```bash
curl -fsSL https://bun.sh/install | bash
cd /path/to/otp-relay
OTP_TOKEN="你的令牌" PORT=8099 bun server.js
```

想后台常驻，用 `nohup`、`systemd` 或 NAS 自带的任务计划。**不推荐**把服务直接暴露到公网。

### 5. 网络要求

- iPhone 和 NAS 在同一个 Wi-Fi，或通过 Tailscale / WireGuard 互通。
- NAS 防火墙放行 8099（只对局域网放行即可）。
- 不建议在路由器上做端口转发。要在外面用，优先 Tailscale，而不是公网暴露。

---

## 二、安装浏览器扩展（Chrome / Edge）

1. 把 `extension` 文件夹复制到 Windows 电脑上（放哪都行，别删）。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 打开右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择 `extension` 文件夹。
5. 在工具栏点扩展图标，填写：
   - **NAS 地址**：`http://192.168.1.10:8099`（换成你的 NAS IP）
   - **访问令牌**：第 1 步生成的令牌
6. 点「测试连接」→ 显示「连接正常（xx ms）」即可。
7. 如果之前已经开着登录页面，刷新一下页面，让内容脚本注入。

扩展权限说明：它需要「读取和更改所有网站的数据」，因为验证码输入框可能出现在任何站点。扩展只做两件事：找验证码输入框、把码填进去；不会上传页面内容。

---

## 三、iPhone 快捷指令（核心步骤，约 2 分钟）

### 先确认 iPhone 能访问 NAS

在 iPhone 的 Safari 打开：

```
http://192.168.1.10:8099/health
```

看到 `{"ok":true}` 再继续。第一次访问时如果弹出「本地网络」权限，点允许。

### 创建「信息」自动化

以 iOS 26 中文界面为例（iOS 27 的差异见括号）：

1. 打开「快捷指令」→ 底部「自动化」→ 右上角「+」。
2. 选择「信息」。
3. 「信息包含」填：`验证码`
   - 英文短信可以再建一条，关键词用 `code`。
   - 银行短信常见「动态码」「校验码」：再建一条自动化，或把关键词改成这些词之一（一条自动化只能匹配一个短语）。
4. 运行方式：
   - **iOS 26**：选「立即运行」，如果有「运行时通知」就关掉。
   - **iOS 27**：创建后点触发器旁边的箭头，关闭「运行前确认」；再点 ⓘ → 隐私 → 打开「锁定时允许运行」。
5. 下一步 →「新建空白快捷指令」，命名例如 `转发验证码`。

### 快捷指令里的动作

只需要 **一个动作**。代码提取放在 NAS 上做，快捷指令不用写正则：

| 顺序 | 动作 | 配置 |
|---|---|---|
| 1 | **获取 URL 内容** | 见下方 |

「获取 URL 内容」的配置：

- URL：`http://192.168.1.10:8099/api/code`
- 方法：`POST`
- 请求头：新增一行
  - 键：`X-Token`
  - 值：你的令牌
- 请求体：`JSON`
  - `text` → 变量「快捷指令输入」（整条短信）

NAS 会优先找「验证码 / 校验码 / 动态码 / verification code / OTP」后面的 4–8 位数字；找不到时再退回到短信里第一个独立的 4–8 位数字。手机号（11 位）和订单号通常不会被误取。

> 想只发提取后的数字也可以：把请求体改成 `code` → 你要的数字变量即可，服务端同样支持。

### 测试

1. 先随便打开一个验证码页面（比如某个网站的登录页），点「获取验证码」。
2. 用另一部手机给你的 iPhone 发一条短信：`验证码 123456`。
3. 正常情况下：
   - iPhone 上不会跳出来让你点确认（已经设为立即运行）；
   - 电脑浏览器当前页面的验证码框里出现 `123456`；
   - 如果没找到输入框，右上角出现可点击复制的提示。

第一次运行时，iOS 可能会问一次「允许快捷指令访问本地网络」，点允许。

---

## 四、手动测试服务端

在 Windows PowerShell 里（不经过 iPhone）直接发一个验证码，验证 NAS 和扩展：

```powershell
Invoke-RestMethod -Method Post -Uri http://192.168.1.10:8099/api/code `
  -Headers @{ "X-Token" = "你的令牌" } `
  -ContentType "application/json" `
  -Body '{"code":"123456"}'
```

返回 `{"ok":true,...}` 后，切到浏览器里的验证码页面，码应该已经填进去了。

也可以发整条短信，服务端会自动提取 4–8 位数字：

```powershell
-Body '{"text":"【某银行】您的验证码是 654321，5 分钟内有效。"}'
```

---

## 五、常见问题

| 现象 | 处理 |
|---|---|
| 快捷指令完全不触发 | iOS 26 选「立即运行」；iOS 27 关闭「运行前确认」并打开「锁定时允许运行」；确认自动化开关是开的；短信必须包含你设置的关键词 |
| 快捷指令报「无法连接到服务器」 | 手机和 NAS 是否同一 Wi-Fi；NAS IP/端口是否正确；NAS 防火墙是否放行 8099；Safari 能否打开 `/health`；设置 → 隐私与安全性 → 本地网络 → 快捷指令 是否允许；临时关掉 VPN/代理再试 |
| 锁屏时收到短信不触发 | iOS 27：ⓘ → 隐私 →「锁定时允许运行」；iOS 26：确认是「立即运行」。低电量模式可能延迟触发 |
| 扩展显示「未连接」 | 点「测试连接」看具体错误；令牌要和服务端 `OTP_TOKEN` 完全一致；改完配置后扩展会自动重连，不行就重新加载扩展 |
| 扩展连上了但页面没填 | 有些站点用 Shadow DOM、iframe 或 canvas 输入框，识别不到；看右上角有没有复制提示，手动粘贴即可。也可以先把光标点进验证码框再触发 |
| 填到了不该填的框 | 点扩展图标 → 取消「启用自动填充」，或临时关闭自动化；把页面告诉我，我可以把匹配规则收紧 |
| NAS 重启后要手动重连吗 | 不需要。容器是 `restart: unless-stopped`，扩展会自动重连（指数退避） |
| 收到多条验证码 | 服务端只保留最新一条，旧的直接覆盖；默认 180 秒后过期 |

---

## 六、安全说明

- 验证码只存在 NAS 进程内存里，**不写磁盘、不打日志**，默认 180 秒过期。
- `/api/latest` 和 `/api/events` 都需要令牌。拿到令牌的人能读取最近一条验证码，所以令牌要当密码对待。
- 只在局域网使用。要远程用，用 Tailscale / WireGuard 之类的私有网络，不要把 8099 直接映射到公网。
- 短信验证码本身就是敏感凭据。这套方案比「把短信同步到第三方云」安全得多，但仍建议只在自己可控的设备和网络里用。
- 想换成 HTTPS：在 NAS 上套一层带证书的反向代理（例如群晖反向代理 + Let's Encrypt），然后把扩展和快捷指令里的地址改成 `https://...`。

---

## 七、可调参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `OTP_TOKEN` | 无（必填，≥16 字符） | 访问令牌 |
| `PORT` | `8099` | 监听端口 |
| `OTP_TTL_SECONDS` | `180` | 验证码有效期，最小 30 秒 |

服务端接口：

- `POST /api/code`：`{"code":"123456"}` 或 `{"text":"完整短信"}`
- `GET /api/events`：SSE 推送（需要 `X-Token` 头或 `?token=`）
- `GET /api/latest`：读取当前未过期的验证码
- `GET /health`：健康检查（无需令牌）

---

## 八、已知限制

- iPhone 关机、没信号时，快捷指令不会运行；这是系统限制。
- iOS 的「信息」自动化只能处理新收到的短信，不会补跑历史短信。
- 只识别 4–8 位纯数字验证码。遇到字母数字混合的码，改快捷指令正则和服务端校验即可。
- 浏览器端只测试了 Chrome / Edge（Chromium）。Firefox 需要自己适配。
- 没有在 iOS 26 / 27 的每个小版本上逐一验证「锁屏触发」——如果遇到锁屏不跑，先检查上面那两个开关。
