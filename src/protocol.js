/**
 * protocol.js — 会话层 v2：广播 / 扫描 / 连接(PIN 授权) / 停等 ARQ
 *
 * 设计依据见 docs/design.md，这里只强调三个最容易做错的点：
 *
 * 1. 半双工推论：「一直广播」不能是「不间断发声」。
 *    自己发声期间我们会丢弃麦克风输入（否则会解到自己的声音），
 *    所以广播必须是 [发声 BEACON] → [静默窗口] 循环，
 *    否则 A 永远收不到 B 的连接请求。
 *
 * 2. B 借 A 的广播节奏发请求：A 的 BEACON 一结束就是它静默窗口的起点，
 *    B 解完 BEACON 的时刻约等于该起点。因此不需要任何时钟同步，
 *    B 每听到一次广播就发一次请求，天然落在窗口里。
 *
 * 3. PIN 只在 A 的屏幕上，绝不进入任何声波帧。
 *    并且必须限制错误次数（默认 3 次后停止广播），否则 4 位数字
 *    在同一房间几分钟就能被穷举完。
 */

import { FRAME, MAX_PAYLOAD, buildFrame, textToBytes, bytesToText } from './modem.js';

export { FRAME };

/** 拒绝原因码 */
export const REJECT = {
  PIN_WRONG: 1,
  NOT_BROADCASTING: 2,
  BUSY: 3,
};

export const REJECT_TEXT = {
  1: 'pin-wrong',
  2: 'not-broadcasting',
  3: 'busy',
};

/** 界面状态（顶部状态行用；broadcasting/scanning 是并行的开关，见 statusInfo） */
export const STATE = {
  IDLE: 'idle', // 静默监听
  TX: 'tx', // 正在发声
  WAIT_ACK: 'wait-ack', // 发完等确认
  CONNECTING: 'connecting', // 正在发起连接
};

export const MAX_TEXT_BYTES = 4000;
export const MAX_NAME_BYTES = 32;

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/* ============================ 载荷编解码 ============================ */

function packName(name) {
  return textToBytes(name || '').subarray(0, MAX_NAME_BYTES);
}

function unpackName(buf, off) {
  if (off >= buf.length) return '';
  const len = buf[off];
  const end = Math.min(buf.length, off + 1 + len);
  return bytesToText(buf.subarray(off + 1, end));
}

function packU32(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function unpackU32(b, off) {
  if (!b || b.length < off + 4) return 0;
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

/* ============================ 会话 ============================ */

export class ChatSession {
  /**
   * @param {object} o
   * @param {number} o.myId
   * @param {string} [o.myName]
   * @param {number} [o.nonce]   tab 级随机数（ID 撞车裁决用，nonce 大的让位）
   * @param {(bytes:Uint8Array)=>Promise<void>} o.transmit
   * @param {object} [o.timers]  可注入定时器（测试用虚拟时钟）
   * @param {()=>number} [o.now]
   * @param {()=>number} [o.rand]
   * @param {object} [o.opts]
   */
  constructor(o) {
    this.myId = o.myId & 0xff;
    this.myName = o.myName || `设备${this.myId}`;
    this.nonce = (o.nonce ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.transmit = o.transmit;
    this.timers = o.timers || defaultTimers;
    this._now = o.now || (() => Date.now());
    this._rand = o.rand || Math.random;

    // 回调
    this.onLog = o.onLog || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.onDiscover = o.onDiscover || (() => {});
    this.onPin = o.onPin || (() => {});
    this.onPeer = o.onPeer || (() => {});
    this.onConnectResult = o.onConnectResult || (() => {});
    this.onMessage = o.onMessage || (() => {});
    this.onIdCollision = o.onIdCollision || (() => {});

    const op = o.opts || {};
    this.beaconGapMs = op.beaconGapMs ?? 2800; // 广播的静默窗口
    this.connectDelay = op.connectDelay ?? 300; // B 首次请求延迟
    this.connectJitter = op.connectJitter ?? 400; // 多台 B 之间的随机错开
    this.connectRetries = op.connectRetries ?? 3;
    this.connectTimeout = op.connectTimeout ?? 20000;
    this.maxPinErrors = op.maxPinErrors ?? 3;
    this.discoverTtl = op.discoverTtl ?? 30000;
    this.ackTimeout = op.ackTimeout ?? 3000;
    this.ackDelay = op.ackDelay ?? 450;
    this.maxRetries = op.maxRetries ?? 3;
    this.rxMsgTimeout = op.rxMsgTimeout ?? 30000;
    this.txJitter = op.txJitter ?? 350;
    this.deferMs = op.deferMs ?? 220;

    /* ---- 状态 ---- */
    this.state = STATE.IDLE;
    this.broadcasting = false;
    this.scanning = false;
    this.pin = null;
    this.pinErrors = 0;
    this.discovered = new Map(); // peerId -> {id,name,nonce,snr,at}
    this.peerId = 0;
    this.peerName = '';
    this.paired = false;
    this.activePeer = 0;
    this.connecting = null;
    this.carrierBusy = false;
    this.beaconCount = 0;

    /* ---- 定时器 ---- */
    this.beaconTimer = null;
    this.connectTimer = null;
    this.connectAckTimer = null;
    this.ackTimer = null;
    this.deferTimer = null;
    this._lastTxEndAt = null; // null = 从未发过声

    /* ---- 发送 ---- */
    this.seq = 0;
    this.nextMsgId = 1;
    this.queue = [];
    this.current = null;
    this.retries = 0;
    this.txChain = Promise.resolve();

    /* ---- 接收 ---- */
    this.rxMsgs = new Map();
    this.seen = new Map();
  }

  /* ============================ 生命周期 ============================ */

  /** 开始使用：只开监听，不发声 */
  start() {
    this._scheduleTick();
    this._setState(STATE.IDLE);
    this._log('info', `就绪：id=${this.myId} 昵称="${this.myName}"（静默监听，不发声）`);
  }

  stop() {
    this.stopBroadcast('stop');
    this.stopScan();
    this.cancelConnect();
    if (this.ackTimer) this.timers.clearTimeout(this.ackTimer);
    if (this.deferTimer) this.timers.clearTimeout(this.deferTimer);
    this.ackTimer = null;
    this.deferTimer = null;
    if (this._tickTimer) {
      this.timers.clearTimeout(this._tickTimer);
      this._tickTimer = null;
    }
  }

  /* ============================ 广播（A 侧） ============================ */

  /** 开始广播：生成新 PIN，进入 [发声] → [静默] 循环 */
  startBroadcast() {
    if (this.broadcasting) return this.pin;
    this.pin = Math.floor(this._rand() * 10000) % 10000;
    this.pinErrors = 0;
    this.broadcasting = true;
    this.beaconCount = 0;
    this.onPin(this.pin);
    this._log('info', `开始广播，PIN=${this.pad4(this.pin)}（只显示在本机屏幕上，不会进入声波）`);
    this._emitStatus();
    this._beaconLoop();
    return this.pin;
  }

  /** 停止广播：PIN 立即作废 */
  stopBroadcast(reason = 'user') {
    if (!this.broadcasting) return;
    this.broadcasting = false;
    if (this.beaconTimer) {
      this.timers.clearTimeout(this.beaconTimer);
      this.beaconTimer = null;
    }
    this.pin = null;
    this.pinErrors = 0;
    this.onPin(null);
    this._log('info', `停止广播（${reason}）`);
    this._emitStatus();
  }

  _beaconLoop() {
    if (!this.broadcasting || this.beaconTimer) return;
    // 信道忙（对端在发 / 自己在发）先让一让，避免叠音
    if (this.carrierBusy || this.current || this.state === STATE.TX) {
      this.beaconTimer = this.timers.setTimeout(() => {
        this.beaconTimer = null;
        this._beaconLoop();
      }, this.deferMs);
      return;
    }
    this.beaconCount++;
    this._log('tx', `发送广播（第 ${this.beaconCount} 次）`);
    this._delayedSend(() => this._beaconFrame()).then(() => {
      if (!this.broadcasting) return;
      // 静默窗口：B 的连接请求要落在这里
      this.beaconTimer = this.timers.setTimeout(() => {
        this.beaconTimer = null;
        this._beaconLoop();
      }, this.beaconGapMs);
    });
  }

  _beaconFrame() {
    const name = packName(this.myName);
    const p = new Uint8Array(5 + name.length);
    p.set(packU32(this.nonce), 0);
    p[4] = name.length;
    p.set(name, 5);
    return buildFrame({ type: FRAME.BEACON, seq: this._nextSeq(), src: this.myId, dst: 0, payload: p });
  }

  /* ============================ 扫描（B 侧） ============================ */

  startScan() {
    if (this.scanning) return;
    this.scanning = true;
    this._log('info', '开始扫描可连接设备');
    this._emitDiscover();
    this._emitStatus();
  }

  stopScan() {
    if (!this.scanning) return;
    this.scanning = false;
    this._log('info', '停止扫描');
    this._emitStatus();
  }

  /** 可连接设备列表（按最后收到时间倒序） */
  get discoveredList() {
    return [...this.discovered.values()].sort((a, b) => b.at - a.at);
  }

  /* ============================ 连接（B 侧） ============================ */

  /**
   * 向已发现的设备发起连接
   * @param {number} peerId
   * @param {string|number} pin 对方屏幕上显示的 4 位数字
   */
  connect(peerId, pin) {
    const pinStr = String(pin ?? '').trim();
    if (!/^\d{4}$/.test(pinStr)) return { ok: false, reason: 'bad-pin' };
    const dev = this.discovered.get(peerId);
    if (!dev) return { ok: false, reason: 'not-found' };
    if (this.connecting) this.cancelConnect();

    const c = { peerId, pin: parseInt(pinStr, 10), name: dev.name, tries: 0, inflight: false };
    this.connecting = c;
    this._setState(STATE.CONNECTING);
    this._log('info', `正在连接「${c.name}」…`);
    // B 要等 A 的下一次广播再发请求，所以超时给足
    this.connectAckTimer = this.timers.setTimeout(() => this._failConnect('timeout'), this.connectTimeout);
    // 刚听到广播的话静默窗口可能还没过，可以立刻发
    if (this._now() - dev.at < 1500) this._scheduleConnectReq(c);
    return { ok: true };
  }

  cancelConnect() {
    if (!this.connecting) return;
    this.connecting = null;
    this._clearConnectTimers();
    if (this.state === STATE.CONNECTING) this._setState(STATE.IDLE);
    this._log('info', '已取消连接');
  }

  _scheduleConnectReq(c) {
    if (this.connecting !== c || c.inflight) return;
    c.inflight = true;
    const delay = this.connectDelay + Math.floor(this._rand() * this.connectJitter);
    this.connectTimer = this.timers.setTimeout(() => {
      if (this.connecting !== c) return;
      c.inflight = false;
      c.tries++;
      this._log('tx', `发送连接请求（第 ${c.tries}/${this.connectRetries} 次）`);
      this._delayedSend(() => this._connectReqFrame(c)).then(() => {
        if (this.connecting !== c) return;
        if (c.tries >= this.connectRetries) this._log('warn', `已尝试 ${c.tries} 次，继续等待对端回应…`);
      });
    }, delay);
  }

  _connectReqFrame(c) {
    const name = packName(this.myName);
    const p = new Uint8Array(3 + name.length);
    p[0] = (c.pin >> 8) & 0xff;
    p[1] = c.pin & 0xff;
    p[2] = name.length;
    p.set(name, 3);
    return buildFrame({ type: FRAME.CONNECT_REQ, seq: this._nextSeq(), src: this.myId, dst: c.peerId, payload: p });
  }

  _failConnect(reason) {
    const c = this.connecting;
    if (!c) return;
    this.connecting = null;
    this._clearConnectTimers();
    this._setState(STATE.IDLE);
    this._log('warn', `连接「${c.name}」失败：${reason}`);
    this.onConnectResult({ ok: false, reason, peerId: c.peerId, name: c.name });
  }

  _clearConnectTimers() {
    if (this.connectTimer) {
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.connectAckTimer) {
      this.timers.clearTimeout(this.connectAckTimer);
      this.connectAckTimer = null;
    }
  }

  /* ============================ 接收分发 ============================ */

  onFrame(frame) {
    // src 等于自己 = 「自己的回声」或「对端用了同一个设备 ID」。
    //
    // 用 nonce 精确区分，不要用「多久没发声」这种时间窗：
    // 广播时每约 3.8 秒就发一次，时间窗稍微给宽一点就会把真实的 ID 撞车
    // 误判成自己的回声而漏掉（实测踩过）。
    // 自己的 BEACON 里带的是自己的 nonce，对端的 nonce 一定不同。
    if (frame.src === this.myId) {
      if (frame.type === FRAME.BEACON) {
        const their = unpackU32(frame.payload, 0);
        if (their !== this.nonce) {
          if (their > this.nonce) {
            this.onIdCollision({ nonce: their, src: frame.src });
          } else {
            this._log('info', `对端也叫设备${frame.src}，但它 nonce 更小，由它让位`);
          }
        }
        // their === this.nonce → 确实是自己的回声，忽略
      }
      return;
    }
    if (frame.dst !== 0 && frame.dst !== this.myId) return;

    // 每收到一帧都记一行。排障时最关键的一条：能区分「根本没收到」和「收到了但没处理」。
    this._log('rx', `收到 ${this._typeName(frame.type)} src=${frame.src} ${frame.payload.length}B`);

    switch (frame.type) {
      case FRAME.BEACON:
        this._onBeacon(frame);
        break;
      case FRAME.CONNECT_REQ:
        this._onConnectReq(frame);
        break;
      case FRAME.CONNECT_ACK:
        this._onConnectAck(frame);
        break;
      case FRAME.REJECT:
        this._onReject(frame);
        break;
      case FRAME.MSG:
        this._onMsg(frame);
        break;
      case FRAME.ACK:
        this._onAck(frame);
        break;
      case FRAME.BYE:
        this._onBye(frame);
        break;
      default:
        this._log('warn', `未知帧类型 ${frame.type}`);
    }
  }

  _onBeacon(frame) {
    const nonce = unpackU32(frame.payload, 0);
    const name = unpackName(frame.payload, 4) || `设备${frame.src}`;
    const snr = frame.snr ?? 0;

    // 只有扫描中才记入列表 —— 用户明确要求"点了检测才显示"
    if (this.scanning) {
      const existed = this.discovered.has(frame.src);
      this.discovered.set(frame.src, { id: frame.src, name, nonce, snr, at: this._now() });
      if (!existed) this._log('rx', `发现设备「${name}」（信号 ${snr.toFixed(1)}dB）`);
      this._emitDiscover();
      this._scheduleTick();
    }

    // 正在连这台设备：借它刚结束的这次广播，把请求发进静默窗口
    const c = this.connecting;
    if (c && c.peerId === frame.src && !c.inflight && c.tries < this.connectRetries) {
      this._scheduleConnectReq(c);
    }
  }

  _onConnectReq(frame) {
    const pin = (frame.payload[0] << 8) | frame.payload[1];
    const name = unpackName(frame.payload, 2) || `设备${frame.src}`;

    if (!this.broadcasting) {
      this._log('warn', `「${name}」请求连接，但本机没在广播，已拒绝`);
      this._delayedSend(() => this._rejectFrame(frame.src, REJECT.NOT_BROADCASTING));
      return;
    }
    if (pin === this.pin) {
      this._log('ok', `「${name}」PIN 校验通过，接受连接`);
      this.stopBroadcast('connected');
      this._setPeer(frame.src, name);
      this._delayedSend(() => this._connectAckFrame(frame.src));
      return;
    }
    this.pinErrors++;
    this._log('warn', `「${name}」PIN 错误（${this.pinErrors}/${this.maxPinErrors}）`);
    this._delayedSend(() => this._rejectFrame(frame.src, REJECT.PIN_WRONG));
    if (this.pinErrors >= this.maxPinErrors) {
      this.stopBroadcast('pin-errors');
      this._log('error', `PIN 连续错误 ${this.maxPinErrors} 次，已自动停止广播（防暴力穷举）`);
    }
  }

  _onConnectAck(frame) {
    const c = this.connecting;
    if (!c || frame.src !== c.peerId) return;
    const name = unpackName(frame.payload, 0) || c.name;
    this.connecting = null;
    this._clearConnectTimers();
    this._log('ok', `已连接「${name}」`);
    this._setPeer(frame.src, name);
    this.onConnectResult({ ok: true, peerId: frame.src, name });
  }

  _onReject(frame) {
    const c = this.connecting;
    if (!c || frame.src !== c.peerId) return;
    const reason = REJECT_TEXT[frame.payload[0]] || 'refused';
    this.connecting = null;
    this._clearConnectTimers();
    this._setState(STATE.IDLE);
    this._log('warn', `连接「${c.name}」被拒绝：${reason}`);
    this.onConnectResult({ ok: false, reason, peerId: frame.src, name: c.name });
  }

  _connectAckFrame(dst) {
    const name = packName(this.myName);
    const p = new Uint8Array(1 + name.length);
    p[0] = name.length;
    p.set(name, 1);
    return buildFrame({ type: FRAME.CONNECT_ACK, seq: this._nextSeq(), src: this.myId, dst, payload: p });
  }

  _rejectFrame(dst, reason) {
    return buildFrame({
      type: FRAME.REJECT,
      seq: this._nextSeq(),
      src: this.myId,
      dst,
      payload: Uint8Array.from([reason & 0xff]),
    });
  }

  _setPeer(id, name) {
    this.peerId = id & 0xff;
    this.peerName = name || `设备${id}`;
    this.paired = true;
    this.activePeer = this.peerId;
    this._setState(STATE.IDLE);
    this.onPeer({ id: this.peerId, name: this.peerName });
    this._emitStatus();
  }

  /** 断开当前连接 */
  disconnect() {
    if (!this.paired) return;
    const dst = this.peerId;
    this._delayedSend(() =>
      buildFrame({ type: FRAME.BYE, seq: this._nextSeq(), src: this.myId, dst, payload: new Uint8Array(0) })
    );
    this._clearPeer();
  }

  _onBye(frame) {
    if (frame.src !== this.peerId) return;
    const name = this.peerName;
    this._log('info', `「${name}」已断开`);
    this._clearPeer();
    this.onConnectResult({ ok: false, reason: 'peer-left', name });
  }

  _clearPeer() {
    this.paired = false;
    this.peerId = 0;
    this.peerName = '';
    this.activePeer = 0;
    this._setState(STATE.IDLE);
    this._emitStatus();
  }

  /* ============================ 发送消息 ============================ */

  say(text) {
    if (!this.paired) return { ok: false, reason: 'no-peer' };
    const bytes = textToBytes(text);
    if (!bytes.length) return { ok: false, reason: 'empty' };
    if (bytes.length > MAX_TEXT_BYTES) return { ok: false, reason: 'too-long' };

    const msgId = this.nextMsgId++ & 0xffff;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += MAX_PAYLOAD - 4) {
      chunks.push(bytes.subarray(i, Math.min(i + MAX_PAYLOAD - 4, bytes.length)));
    }
    for (let i = 0; i < chunks.length; i++) {
      this.queue.push({ msgId, chunk: i, total: chunks.length, data: chunks[i] });
    }
    this._log('tx', `排队发送 ${bytes.length} 字节 → ${chunks.length} 帧`);
    this._pump();
    return { ok: true, msgId, chunks: chunks.length };
  }

  get busy() {
    return this.state === STATE.TX || this.state === STATE.WAIT_ACK || this.queue.length > 0;
  }

  _pump() {
    if (this.current || !this.queue.length) {
      if (!this.current && !this.queue.length && this.state !== STATE.TX) this._setState(STATE.IDLE);
      return;
    }
    const job = this.queue.shift();
    this.current = { ...job, seq: this._nextSeq(), tries: 0 };
    const jitter = this.txJitter > 0 ? Math.floor(this._rand() * this.txJitter) : 0;
    if (jitter > 0) {
      this._log('info', `起发退避 ${jitter}ms`);
      this.timers.setTimeout(() => {
        if (this.current) this._sendCurrent();
      }, jitter);
    } else {
      this._sendCurrent();
    }
  }

  /** 载波侦听：对端正在发声时让行（半双工信道必须有人让） */
  setCarrierBusy(busy) {
    this.carrierBusy = !!busy;
  }

  _sendCurrent() {
    const job = this.current;
    if (!job) return;
    if (this.carrierBusy) {
      if (this.deferTimer) return;
      this._log('info', '信道忙（对端正在发），让行…');
      this.deferTimer = this.timers.setTimeout(() => {
        this.deferTimer = null;
        this._sendCurrent();
      }, this.deferMs);
      return;
    }
    const payload = new Uint8Array(4 + job.data.length);
    payload[0] = (job.msgId >> 8) & 0xff;
    payload[1] = job.msgId & 0xff;
    payload[2] = job.chunk;
    payload[3] = job.total;
    payload.set(job.data, 4);
    const bytes = buildFrame({ type: FRAME.MSG, seq: job.seq, src: this.myId, dst: this.peerId, payload });

    this._delayedSend(() => bytes).then(() => {
      if (this.current !== job) return;
      this._setState(STATE.WAIT_ACK);
      this._log('tx', `已发出分片 ${job.chunk + 1}/${job.total}（seq=${job.seq}，第 ${job.tries + 1} 次），等待确认…`);
      this.ackTimer = this.timers.setTimeout(() => this._onAckTimeout(), this.ackTimeout);
    });
  }

  _onAck(frame) {
    if (!this.current) return;
    const ackSeq = frame.payload.length >= 1 ? frame.payload[0] : frame.seq;
    if (ackSeq !== this.current.seq) {
      this._log('info', `ACK seq=${ackSeq} 与当前 ${this.current.seq} 不匹配，忽略`);
      return;
    }
    if (this.ackTimer) {
      this.timers.clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    this._log('ok', `分片 ${this.current.chunk + 1}/${this.current.total} 已确认`);
    this.current = null;
    this.retries = 0;
    this._pump();
  }

  _onAckTimeout() {
    this.ackTimer = null;
    if (!this.current) return;
    this._log('warn', `等待确认超时（${this.ackTimeout}ms）`);
    this._retransmit();
  }

  _retransmit() {
    const job = this.current;
    if (!job) return;
    job.tries++;
    if (job.tries > this.maxRetries) {
      this._log('error', `分片 ${job.chunk + 1}/${job.total} 重传 ${this.maxRetries} 次仍无确认，放弃`);
      this.current = null;
      this.retries = 0;
      this._setState(STATE.IDLE);
      this.onConnectResult({ ok: false, reason: 'no-ack' });
      this._pump();
      return;
    }
    this._sendCurrent();
  }

  /* ============================ 接收消息 ============================ */

  _onMsg(frame) {
    if (frame.src !== this.peerId) {
      this._log('info', `收到非当前连接设备(${frame.src})的消息，已忽略`);
      return;
    }
    const p = frame.payload;
    if (p.length < 4) return;
    const msgId = (p[0] << 8) | p[1];
    const chunk = p[2];
    const total = p[3];
    const data = p.subarray(4);
    const key = `${frame.src}:${msgId}:${chunk}`;

    // 无论是否重复都要回 ACK：对端可能只是没收到上一次 ACK
    this._delayedSend(() => this._ackFrame(frame.seq), this.ackDelay);

    if (this.seen.has(key)) {
      this._log('info', `重复分片 ${msgId}#${chunk}，已忽略但补发 ACK`);
      return;
    }
    this.seen.set(key, this._now());
    if (this.seen.size > 400) this.seen.delete(this.seen.keys().next().value);

    let rec = this.rxMsgs.get(msgId);
    if (!rec) {
      rec = { total, parts: new Map(), at: this._now(), from: frame.src };
      this.rxMsgs.set(msgId, rec);
    }
    rec.parts.set(chunk, data);
    this._log('rx', `分片 ${chunk + 1}/${total}（msgId=${msgId}）`);

    if (rec.parts.size === rec.total) {
      const parts = [];
      for (let i = 0; i < rec.total; i++) parts.push(rec.parts.get(i) || new Uint8Array(0));
      const bytes = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
      let off = 0;
      for (const part of parts) {
        bytes.set(part, off);
        off += part.length;
      }
      this.rxMsgs.delete(msgId);
      this.onMessage({ from: frame.src, fromName: this.peerName, text: bytesToText(bytes), at: this._now() });
    }
  }

  _ackFrame(seq) {
    return buildFrame({
      type: FRAME.ACK,
      seq: this._nextSeq(),
      src: this.myId,
      dst: this.peerId,
      payload: Uint8Array.from([seq & 0xff]),
    });
  }

  /* ============================ 维护 ============================ */

  /**
   * 自调度清理。不能只依赖外部调用 tick()：
   * 忘了调就表现为「设备停了广播但列表里一直在」，实测踩过。
   */
  _scheduleTick() {
    if (this._tickTimer) return;
    this._tickTimer = this.timers.setTimeout(() => {
      this._tickTimer = null;
      this.tick();
      if (this.discovered.size || this.rxMsgs.size) this._scheduleTick();
    }, 2000);
  }

  /** 清理过期的发现项和收不全的消息（由 _scheduleTick 周期驱动） */
  tick(now = this._now()) {
    let changed = false;
    for (const [id, d] of this.discovered) {
      if (now - d.at > this.discoverTtl) {
        this.discovered.delete(id);
        changed = true;
      }
    }
    if (changed) this._emitDiscover();
    if (this.discovered.size || this.rxMsgs.size) this._scheduleTick();

    for (const [msgId, rec] of this.rxMsgs) {
      if (now - rec.at > this.rxMsgTimeout) {
        this._log('warn', `消息 ${msgId} 分片超时未收全（${rec.parts.size}/${rec.total}），丢弃`);
        this.rxMsgs.delete(msgId);
      }
    }
  }

  /* ============================ 内部工具 ============================ */

  /** 串行化发送，避免两帧音频叠在一起 */
  _delayedSend(makeFrame, delay = 0) {
    this.txChain = this.txChain
      .then(async () => {
        if (delay > 0) await new Promise((r) => this.timers.setTimeout(r, delay));
        const bytes = makeFrame();
        if (!bytes) return;
        await this._tx(bytes);
      })
      .catch((e) => this._log('error', `发送失败: ${e.message}`));
    return this.txChain;
  }

  async _tx(bytes) {
    this._setState(STATE.TX);
    try {
      await this.transmit(bytes);
    } finally {
      this._lastTxEndAt = this._now();
      if (this.state === STATE.TX) this._setState(STATE.IDLE);
    }
  }

  /** 帧类型名（日志用） */
  _typeName(type) {
    for (const k of Object.keys(FRAME)) if (FRAME[k] === type) return k;
    return `0x${type.toString(16)}`;
  }

  _nextSeq() {
    this.seq = (this.seq % 255) + 1;
    return this.seq;
  }

  pad4(n) {
    return String(n).padStart(4, '0');
  }

  statusInfo() {
    return {
      broadcasting: this.broadcasting,
      scanning: this.scanning,
      pin: this.pin,
      peer: this.peerName,
      peerId: this.peerId,
      paired: this.paired,
      connecting: this.connecting ? this.connecting.name : null,
      connectingTries: this.connecting ? this.connecting.tries : 0,
      discovered: this.discovered.size,
      queue: this.queue.length,
    };
  }

  _setState(s) {
    this.state = s;
    this.onStatus(s, this.statusInfo());
  }

  _emitStatus() {
    this.onStatus(this.state, this.statusInfo());
  }

  _emitDiscover() {
    this.onDiscover(this.discoveredList);
  }

  _log(level, text) {
    this.onLog({ level, text, at: this._now() });
  }
}
