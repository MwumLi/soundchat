# 声波聊天 · SoundChat

两台设备用**扬声器 → 麦克风**直接互传文字。不需要局域网、不需要蓝牙、不需要联网、不需要配对码。

```
设备甲                          设备乙
 [文本] → 调制 → 扬声器 ~~~~~~~> 麦克风 → 解调 → [文本]
                 (1–7 kHz 声波)
```

## 这是什么

一个可用的最小实现，不是 demo：

- **物理层**：16 音连续相位 MFSK，前导码同步，CRC8 保护帧头 + CRC16 保护整帧
- **会话层**：声波配对、长文本分片、停等 ARQ（超时重传）、载波侦听让行、分片去重重组
- **应用层**：浏览器聊天界面（Web Audio API），Mac / Windows / Android / iOS 都能跑

全流程 **79 项自动化测试**，包括白噪声、采样率偏移（44.1k ↔ 48k）、多径混响、丢包重传、ACK 丢失去重。

## 快速开始

### 方式一：先在本机自检（30 秒，推荐先做这个）

```bash
node tools/cli.mjs loopback "你好，声波"
```

看到 `✓ 回环成功` 说明编解码链路正常。还可以导出真实音频试听：

```bash
node tools/cli.mjs encode "你好" out.wav     # 生成声波 WAV
afplay out.wav                                # macOS 播放
```

### 方式二：两台电脑（同一台机器上开发调试）

```bash
node tools/serve.mjs
```

浏览器打开 `http://localhost:8080/`，点「开始监听」，再点「配对」。

### ⚠️ 为什么不能让"一台跑服务、另一台走局域网 IP 访问"

这是最容易踩的坑。**服务只负责把网页送过去，跟聊天数据毫无关系**——
数据全程走声波。但麦克风权限会被浏览器拦下：

| 打开方式 | 是安全上下文吗 | 能拿到麦克风吗 |
|---|---|---|
| `https://...` | ✅ | ✅ |
| `http://localhost:8080` | ✅ | ✅ |
| `file:///.../soundchat.html` | ✅ | ✅ |
| `http://10.91.145.249:8080` | ❌ | ❌ `navigator.mediaDevices` 直接是 `undefined` |

按 [MDN 的定义](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)，
只有 `https` / `wss` / `file` 协议，以及主机名是 `localhost` 或 `127.0.0.0/8`、`::1/128` 的才算安全上下文。
**局域网 IP 不在其中**，所以跑服务那台（localhost）能用，另一台（局域网 IP）拿不到麦克风。

本机实测（Chrome headless）：

```
file:///.../soundchat.html          → isSecureContext: true,  mediaDevices: ✅
http://localhost:8099/...           → isSecureContext: true,  mediaDevices: ✅
http://10.91.145.249:8099/...       → 该机器上连自己的局域网 IP 都访问不通（见下）
```

> 附加发现：这台 Mac 上 `curl --noproxy '*' http://10.91.145.249:8099/` 返回 `000`（而 localhost 返回 `200`），
> Chrome 同样打不开。可能是无线网络的客户端隔离或企业管控。
> 也就是说，即便绕过权限问题，局域网互访在这台机器所在的网络上也未必通。

**所以正确做法是：不要用服务。** 见方式三，两台设备各自本地打开同一个单文件即可。

如果确实想走局域网，只有三条路（都不推荐）：

1. 给服务器配 HTTPS 证书。iOS 需要在设置里手动信任证书；Android Chrome 对"证书有错误"的页面仍视为非安全上下文。
2. 桌面 Chrome 加启动参数把局域网 IP 临时当作安全源（**仅限桌面，手机不行**）：
   ```bash
   open -a "Google Chrome" --args --unsafely-treat-insecure-origin-as-secure=http://10.91.145.249:8080
   ```
3. 内网 DNS 指一个域名到那台机器 + 配真证书（企业内网常见做法）。

### 方式三：电脑 + 手机（推荐用法）

手机没法直接跑 Node，所以用**单文件产物**：

```bash
node build.mjs        # 生成 dist/soundchat.html（约 60 KB，零依赖、全离线）
```

把 `dist/soundchat.html` 用任意方式传到手机（微信文件传输助手 / 邮件 / 数据线 / 云盘都行），然后：

- **Android**：Chrome 把 `file://` 当安全上下文（本机实测 `isSecureContext: true`、`mediaDevices` 可用），
  用文件管理器打开这个 HTML 即可
- **iOS**：Safari 在 `file://` 下**不给麦克风权限**。需要把这个 HTML 放到任意 `https://` 静态托管上（GitHub Pages、内网 nginx 都行），用 Safari 打开后「添加到主屏幕」，之后就能离线用了

> 这一步是唯一的"引导"环节——需要把文件本身送到手机上。
> 一旦页面加载完成，之后传文字就完全靠声波，不再需要任何网络。

## 怎么用

1. 两台设备放在**同一房间，距离 1–3 米**，把**音量调到较大**（建议 70% 以上）
2. 都打开页面 → 点「开始监听」→ 授权麦克风
3. 点「配对」；看到「已与「XXX」建立声波连接」就成功了
4. 输入文字 → 发送

**两端必须选同一个档位**（稳健 / 快速），否则解不出来。

## 性能（实测数据，不是理论值）

| 档位 | 符号时长 | 音间隔 | 原始速率 | 有效吞吐（60 字节帧） |
|---|---|---|---|---|
| 稳健 | 21.33 ms | 400 Hz | 188 bit/s | **18.5 B/s**（60 字节约 3.2 秒） |
| 快速 | 13.33 ms | 400 Hz | 300 bit/s | **29.6 B/s**（60 字节约 2.0 秒） |

换算成体感：

| 内容 | 稳健档 | 快速档 |
|---|---|---|
| 一条 20 字中文（60 字节） | 3.2 s | 2.0 s |
| 一条 200 字中文（600 字节） | 32 s | 20 s |
| 一张 100 KB 缩略图 | 1.5 小时 | 56 分钟 |

**结论：传文字很合适，传图片勉强，传大文件不现实。** 这是声波信道的物理上限，不是实现问题——
可听频段只有几 kHz，还要对抗室内混响。

## 工作原理

### 物理层（`src/modem.js`）

```
[前导码 16 符号: 音 0,1,2,...,15] [header 6B] [payload ≤200B] [crc16 2B]
        每个字节 → 2 个 4bit 符号 → 每个符号 = 一个音（16 音 MFSK）
```

- **调制**：连续相位 FSK。符号切换时不重置相位，因此没有爆音、没有额外频谱扩散
- **同步**：接收端在"符号能量列"上做二维搜索（起始位置 × 每符号采样数），再对前导码做精细二维搜索
- **解调**：Hann 窗 Goertzel 音阶组，取最大音（非相干检测，不需要载波恢复）
- **定时跟踪**：逐符号 bang-bang 早-晚门，把采样相位锁到符号中心

### 会话层（`src/protocol.js`）

- **配对**：`HELLO` / `HELLO_ACK` 交换 id 与昵称。声波是广播信道，靠 id 过滤自己的回声
- **ARQ**：发一帧 → 等 ACK → 超时重传，最多 3 次；超限放弃并提示，不死循环
- **载波侦听**：半双工信道，侦听到对端在发声就让行；再加起发抖动降低双方同时开口的概率
- **分片重组**：长文本按 196 字节切片，按 `(src, msgId)` 重组，`(msgId, chunk)` 去重

## 已知限制

1. **半双工**。同一时刻只有一方能说。双方同时发送时靠退避 + 让行错开，但如果两端都在大声说话，
   仍然可能撞车——此时 ARQ 会自动重传。
2. **混响敏感**。快速档在强混响环境（RT60 较长的房间）下比稳健档容易失败；实测快速档能扛住
   3/9/21 ms 三重回声，但真实房间更复杂时建议切稳健档。
3. **没有前向纠错**。目前只靠 CRC + 重传。加 Reed-Solomon 可以让它在噪声下更稳，是下一步的事。
4. **超声波模式没做**。原因很实际：多数手机扬声器在 18 kHz 以上衰减严重，麦克风前置滤波器也会
   直接砍掉，实际可用性很差（这一点在 ggwave / wave-share 的 issue 里被反复验证过）。
5. **明文传输**。目前没有加密。声波是广播的，同一房间里任何设备都能解码——
   如果你要传敏感内容，需要自己加一层（ECDH + AES-GCM 是下一步计划）。
6. **麦克风权限**。浏览器只在安全上下文（`https://` 或 `localhost`）下给麦克风权限，
   这决定了手机端必须先解决"文件怎么到手机上"这一步。

## 开发

```bash
npm test      # 79 项测试：调制解调 / 协议端到端 / 单文件产物
npm run build # 生成 dist/soundchat.html
npm run serve # 起本地开发服务器
npm run cli   # 命令行工具
```

单独跑某一层：

```bash
node test/modem.test.mjs      # 39 项：回环 / 噪声 / 采样率偏移 / 多径 / flush
node test/protocol.test.mjs   # 32 项：配对 / 分片 / ARQ / 丢包 / 去重 / 载波侦听
node test/bundle.test.mjs     #  8 项：单文件构建 / DOM 接线 / 初始化
```

### 目录结构

```
src/modem.js        物理层：调制、解调、帧编解码、CRC（纯计算，无 DOM 依赖）
src/protocol.js     会话层：配对、分片、ARQ、重组（定时器可注入，便于测试）
src/app.js          浏览器：Web Audio 收发 + 聊天界面
web/index.html      开发页面（HTML + CSS）
build.mjs           把三个模块内联成单文件 dist/soundchat.html
tools/cli.mjs       命令行：loopback / encode / decode
tools/wav.mjs       零依赖 WAV 读写
tools/serve.mjs     零依赖静态服务器
test/*.test.mjs     三套测试
```

### 为什么接收端要"跟踪"定时

这是整个项目里最关键、也最容易做错的一点，记一下：

前导码只有 16 个符号，用它估出的"每符号采样数"误差约 **0.5%**。
一个 432 符号的长帧，累积漂移能到 **2 个符号**，直接解废。
所以必须在解调过程中逐符号跟踪定时。而常见的连续早-晚门（early-late gate）在这里会**反向发散**——
能量-偏移曲线是"平顶 + 三角"，偏得较远时 `E_late - E_early` 符号反了，环路朝错误方向跑，
实测表现为解调整体跳一个符号。最终用的是**有界 bang-bang**：比较当前中心与 ±δ 处同一音的能量，
只朝更高的一侧走固定小步（≤5% 符号），天然有界、捕获范围大。

另外几个踩过的坑写在 `git log` 的提交信息里，包括：

- 前导码匹配窗必须接近满符号（0.95）且用矩形窗，否则满分平台太宽、周期估不准
- 扫描窗口必须回看 lookback 列，因为"列已生成"比"前导码整段可判定"早约 15 个符号
- 帧头必须自带校验（CRC8），否则假同步解出垃圾长度会让接收机傻等十几秒
- 环形缓冲淘汰旧列时 `scanFrom` 和 `decodeFloor` 必须一起平移，
  否则 20 秒以后扫描起点越界，表现为"聊一会儿就再也收不到消息"

## 参考

- [ggwave](https://github.com/ggerganov/ggwave) — 同类开源库，FSK，8–16 B/s，极稳
- [libquiet / quiet.js](https://github.com/quiet/quiet) — OFDM，可听模式约 7 kbps，线缆模式 64 kbps
- [wave-share](https://github.com/ggerganov/wave-share) — 用声波做 WebRTC 信令，数据走网络
- [PairSonic](https://github.com/seemoo-lab/pairsonic) — 学术界的声波配对方案
- [Evaluating Acoustic Data Transmission Schemes for Ad-Hoc Communication Between Nearby Smart Devices](https://arxiv.org/abs/2602.02249)（ACM TIoT 2026）—
  11000+ 次真机传输的系统性评测，结论是多数论文方案在真实房间里会大幅失效

## 许可

仅供学习与内部实验使用。声波是广播信道，明文传输，请勿用于传递敏感信息。
