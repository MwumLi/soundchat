# 声波聊天 · SoundChat

> 两台设备用**扬声器 → 麦克风**直接互传文字。不需要局域网、不需要蓝牙、不需要联网。
>
> Text chat over sound waves — speaker to microphone. No Wi-Fi, no Bluetooth, no internet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

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

全流程 **129 项自动化测试**，包括白噪声、采样率偏移（44.1k ↔ 48k）、多径混响、
广播/扫描/连接时序、PIN 校验与锁定、丢包重传、ACK 丢失去重。

> 设计细节（帧格式、时序、参数表、已知边界）见 [`docs/design.md`](docs/design.md)。
> 改行为请先改文档再改代码。

## 快速开始

### 方式零：同一台机器双开（最快的自测方式，不需要第二台设备）

同一台 PC 上开两个浏览器窗口，或同一浏览器的两个 tab，就能自己跟自己聊。

**两个前提，都会直接影响能不能用：**

**① 设备身份是持久的，撞车会自动裁决。**
设备 ID 存在 `localStorage`（跨 tab、跨会话稳定），所以同一台机器默认永远是同一台设备，
聊天记录也归在同一个身份下。

那"两个 tab 会不会抢同一个 ID"？会，但会自动解决：`HELLO` 握手包里带一个
**tab 级随机数 nonce**，双方一比，nonce 小的那个自动让位、换一个临时 ID
（只写本 tab 的 `sessionStorage` 覆盖，**不动持久身份**），然后重新配对。
所以另一个 tab 的「设备N」身份和它的历史记录都不会被影响。

| 双开方式 | 结果 |
|---|---|
| 同一浏览器两个 tab | 两边都是「设备N」→ 自动裁决，一个让位改名，另一个保持「设备N」 |
| 两个不同浏览器（如 Chrome + Edge） | 各自独立的 `localStorage` → 天然不同 ID |
| 两个无痕窗口 | 独立会话 → 天然不同 ID |

**② 音量要调小。**
扬声器和麦克风在同一台机器上，声程只有几厘米，信号强度远高于"两台设备隔 1–3 米"。
音量开大会让麦克风输入削波，反而解不出来。建议从 **20–30%** 开始，
盯着页面上的电平表——接近满格就往回调（日志里也会提示"输入电平接近满幅"）。

> 只想验证链路本身的话，「自检」按钮或 `node tools/cli.mjs loopback "你好"` 更省事。

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
| `http://192.168.1.100:8080` | ❌ | ❌ `navigator.mediaDevices` 直接是 `undefined` |

按 [MDN 的定义](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)，
只有 `https` / `wss` / `file` 协议，以及主机名是 `localhost` 或 `127.0.0.0/8`、`::1/128` 的才算安全上下文。
**局域网 IP 不在其中**，所以跑服务那台（localhost）能用，另一台（局域网 IP）拿不到麦克风。

本机实测（Chrome headless）：

```
file:///.../soundchat.html          → isSecureContext: true,  mediaDevices: ✅
http://localhost:8099/...           → isSecureContext: true,  mediaDevices: ✅
http://192.168.1.100:8099/...       → 该机器上连自己的局域网 IP 都访问不通（见下）
```

> 另外实测发现：某些网络环境下（无线客户端隔离、AP 隔离）连本机的局域网 IP 都访问不通
> ——`curl --noproxy '*' http://<自己的局域网IP>:8099/` 返回 `000`，而 `localhost` 返回 `200`。
> 也就是说，即便绕过权限问题，局域网互访也未必通。

**所以正确做法是：不要用服务。** 见方式三，两台设备各自本地打开同一个单文件即可。

如果确实想走局域网，只有三条路（都不推荐）：

1. 给服务器配 HTTPS 证书。iOS 需要在设置里手动信任证书；Android Chrome 对"证书有错误"的页面仍视为非安全上下文。
2. 桌面 Chrome 加启动参数把局域网 IP 临时当作安全源（**仅限桌面，手机不行**）：
   ```bash
   open -a "Google Chrome" --args --unsafely-treat-insecure-origin-as-secure=http://192.168.1.100:8080
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

## 聊天记录

**按设备分开保存**。聊天内容会自动存进浏览器 `localStorage`（键 `sc.history`），
每个设备最多保留 300 条，刷新、关标签页、下次打开都还在。

- 切换设备 = 切换会话，各自的历史互不干扰
- 「设备」面板里可以**手动改对端昵称**，改名不影响历史
- 「删除」某台设备会连同它的记录一起删掉；底部可清空全部

两点提醒：

- 记录是**明文**存在浏览器本地存储里的。如果设备是公司配发的或装了管控软件，
  浏览器数据可能在审计范围内——传敏感内容前先想清楚。
- 记录**只在本机**，不会同步给对方、也不上传。

**已知代价**：会话记录以对方的设备 ID 为主键。对方一旦**重置浏览器数据、换浏览器或用无痕模式**，
ID 就会变，历史会断成"一台新设备"。这是这套方案的固有代价，没有做伪造的稳定指纹。

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

1. **PIN 只授权，不加密**。PIN 挡的是"别人乱连你的设备"；挡不住"别人偷听你们的聊天内容"——
   声波是广播的，同一房间任何设备都能解码，不需要连接。要防偷听得上加密
   （ECDH + AES-GCM 是下一步，而且 PIN 正好可以复用成 ECDH 的认证材料）。
2. **同一时刻只能有一个活跃连接**。声波是半双工广播信道，没法同时跟两台设备对话。
   "设备列表"里可以保存多台，但发消息只能对当前连接的那台。
3. **半双工**。同一时刻只有一方能说。双方同时发送时靠退避 + 让行错开，但仍可能撞车——
   此时 ARQ 会自动重传。
4. **广播是周期性的，会持续出声**。每约 4 秒一声，直到配对成功或手动停止。
   这是半双工的必然结果（见「怎么用」里的解释）。
5. **对方的设备 ID 会变**。对方重置浏览器数据 / 换浏览器 / 用无痕模式后，会话记录会断成新设备。
   这是把 peerId 当主键的固有代价。
6. **混响敏感**。快速档在强混响环境（RT60 较长的房间）下比稳健档容易失败；实测快速档能扛住
   3/9/21 ms 三重回声，但真实房间更复杂时建议切稳健档。
7. **没有前向纠错**。目前只靠 CRC + 重传。加 Reed-Solomon 可以让它在噪声下更稳。
8. **超声波模式没做**。原因很实际：多数手机扬声器在 18 kHz 以上衰减严重，麦克风前置滤波器也会
   直接砍掉，实际可用性很差（这一点在 ggwave / wave-share 的 issue 里被反复验证过）。
9. **麦克风权限**。浏览器只在安全上下文（`https://` 或 `localhost`）下给麦克风权限，
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
node test/protocol.test.mjs   # 48 项：广播 / 扫描 / 连接 / PIN / ARQ / ID 冲突
node test/store.test.mjs      # 29 项：按设备分历史 / 上限 / 改名 / 存储不可用
node test/bundle.test.mjs     # 10 项：单文件构建 / 依赖完整 / DOM 接线 / 初始化
```

### 目录结构

```
src/modem.js        物理层：调制、解调、帧编解码、CRC（纯计算，无 DOM 依赖）
src/protocol.js     会话层：广播/扫描/连接、分片、ARQ、重组（定时器可注入）
src/store.js        持久化层：会话记录按设备分组 + 已知设备（纯函数，注入 storage）
src/app.js          浏览器：Web Audio 收发 + 界面
docs/design.md      设计文档（唯一事实来源）
LICENSE             MIT
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

[MIT License](LICENSE) © MwumLi

> ⚠️ 与许可证无关的一点提醒：声波是**广播信道**，当前实现**没有加密**。
> 同一房间里任何设备都能解码你们的对话，不需要连接、也不需要 PIN。
> PIN 只解决"谁能连上我"，不解决"谁能偷听我"。传敏感内容请自行加一层加密。
