/**
 * protocol.js — 会话层：配对、分片、停等 ARQ、重组
 *
 * 声波信道是半双工的广播信道，所以协议层要做三件事：
 *   1. 配对：用 HELLO / HELLO_ACK 交换 id 与昵称（声波无寻址，靠 id 过滤自己的回声）
 *   2. 可靠传输：停等 ARQ。发一帧 → 等 ACK → 超时重传，最多 maxRetries 次
 *   3. 分片重组：一条长消息拆成多个 MSG 帧，按 (src, msgId) 重组
 *
 * 定时器可注入（timers），因此可以在 Node 里用虚拟时钟做完整端到端测试。
 */

import { FRAME, MAX_PAYLOAD, buildFrame, textToBytes, bytesToText } from './modem.js';

/** 一条消息的最大文本字节数（分片前） */
export const MAX_TEXT_BYTES = 4000;

export const STATE = {
  IDLE: 'idle', // 空闲，正在监听
  TX: 'tx', // 正在发声
  WAIT_ACK: 'wait-ack', // 已发完，等确认
  PAIRING: 'pairing', // 等待配对
  BUSY: 'busy', // 对端正在发，我们等着
};

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class ChatSession {
  /**
   * @param {object} o
   * @param {number} o.myId            本机 id (1..255)
   * @param {string} [o.myName]        本机昵称
   * @param {(bytes:Uint8Array)=>Promise<void>} o.transmit 播放一帧音频，播完 resolve
   * @param {(msg:{from:string,text:string,at:number})=>void} [o.onMessage]
   * @param {(peer:{id:number,name:string})=>void} [o.onPeer]
   * @param {(state:string,info:object)=>void} [o.onStatus]
   * @param {(entry:object)=>void} [o.onLog]
   * @param {object} [o.timers]        定时器实现（测试时注入虚拟时钟）
   * @param {object} [o.opts]
   */
  constructor(o) {
    this.myId = o.myId & 0xff;
    this.myName = o.myName || `设备${this.myId}`;
    this.transmit = o.transmit;
    this.onMessage = o.onMessage || (() => {});
    this.onPeer = o.onPeer || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.onLog = o.onLog || (() => {});
    this.timers = o.timers || defaultTimers;
    const op = o.opts || {};

    this.profileKey = op.profileKey || 'robust';
    this.ackTimeout = op.ackTimeout ?? 3000; // 发完等 ACK 的时限
    this.ackDelay = op.ackDelay ?? 450; // 收到后延迟多久回 ACK（让对端切到监听）
    this.maxRetries = op.maxRetries ?? 3;
    this.helloInterval = op.helloInterval ?? 5000;
    this.rxMsgTimeout = op.rxMsgTimeout ?? 30000;
    this.txJitter = op.txJitter ?? 350; // 起发前随机退避，降低双方同时开口的概率
    this.deferMs = op.deferMs ?? 220; // 侦听到对端在发时，让行后重试的间隔
    this.carrierBusy = false;
    this._deferTimer = null;
    this._rand = op.rand || Math.random;

    this.state = STATE.IDLE;
    this.peerId = 0;
    this.peerName = '';
    this.paired = false;

    this.seq = 0; // 帧序号（1..255 循环）
    this.nextMsgId = 1;

    this.queue = []; // 待发送的分片
    this.current = null; // 当前在发/等确认的分片
    this.retries = 0;
    this.ackTimer = null;
    this.helloTimer = null;
    this.txChain = Promise.resolve(); // 串行化发送，避免叠音

    this.rxMsgs = new Map(); // msgId -> {total, parts:Map, at, from}
    this.seen = new Map(); // `${msgId}:${chunk}` -> 收到时间，用于去重
  }

  /* ============================ 对外 API ============================ */

  /** 开始监听；未配对时周期性广播 HELLO */
  start() {
    this._setState(STATE.IDLE);
    this._log('info', `启动，本机 id=${this.myId} 昵称="${this.myName}"`);
    this._beacon();
  }

  stop() {
    if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
    if (this.ackTimer) this.timers.clearTimeout(this.ackTimer);
    if (this._deferTimer) this.timers.clearTimeout(this._deferTimer);
    this.helloTimer = null;
    this.ackTimer = null;
    this._deferTimer = null;
  }

  /** 主动发起配对（重新广播 HELLO） */
  pair() {
    if (this.helloTimer) this.timers.clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.paired = false;
    this.peerId = 0;
    this.peerName = '';
    this._setState(STATE.PAIRING);
    this._log('info', '开始配对，正在广播声波握手…');
    this._sendHello();
    this._beacon();
  }

  /** 排队发送一条文本 */
  say(text) {
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

  /** 当前是否空闲（可以安全发声） */
  get busy() {
    return this.state === STATE.TX || this.state === STATE.WAIT_ACK || this.queue.length > 0;
  }

  /* ============================ 接收 ============================ */

  /** 解调器解出一帧后调用 */
  onFrame(frame) {
    if (frame.src === this.myId) return; // 自己的回声
    if (frame.dst !== 0 && frame.dst !== this.myId) return; // 不是发给我的

    this._log('rx', `收到 type=${this._typeName(frame.type)} seq=${frame.seq} src=${frame.src} ${frame.payload.length}B`);

    switch (frame.type) {
      case FRAME.HELLO:
        this._onHello(frame, false);
        break;
      case FRAME.HELLO_ACK:
        this._onHello(frame, true);
        break;
      case FRAME.MSG:
        this._onMsg(frame);
        break;
      case FRAME.ACK:
        this._onAck(frame, true);
        break;
      case FRAME.NACK:
        this._onAck(frame, false);
        break;
      case FRAME.BYE:
        this._log('info', `对端 ${frame.src} 已下线`);
        this.paired = false;
        this.peerId = 0;
        this._setState(STATE.IDLE);
        break;
      default:
        break;
    }
  }

  _onHello(frame, isAck) {
    const name = frame.payload.length ? bytesToText(frame.payload) : `设备${frame.src}`;
    const known = this.paired && this.peerId === frame.src && this.peerName === name;
    this.peerId = frame.src;
    this.peerName = name;
    this.paired = true;
    if (!known) {
      this._log('info', `配对成功：对端 id=${frame.src} 昵称="${name}"`);
      this.onPeer({ id: frame.src, name });
    }
    // 收到 HELLO 就回 ACK；双方同时 HELLO 时靠 id 错开，避免同时发声
    if (!isAck) this._delayedSend(() => this._sendHelloAck(), this.ackDelay + (this.myId % 4) * 180);
    if (this.helloTimer) {
      this.timers.clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    this._setState(this.busy ? this.state : STATE.IDLE);
  }

  _onMsg(frame) {
    const p = frame.payload;
    if (p.length < 4) return;
    const msgId = (p[0] << 8) | p[1];
    const chunk = p[2];
    const total = p[3];
    const data = p.subarray(4);
    const key = `${frame.src}:${msgId}:${chunk}`;

    // 无论是否重复，都要回 ACK：对端可能只是没收到上一次 ACK
    this._delayedSend(() => this._sendAck(frame.seq), this.ackDelay);

    if (this.seen.has(key)) {
      this._log('info', `重复分片 ${msgId}#${chunk}，已忽略但补发 ACK`);
      return;
    }
    this.seen.set(key, Date.now());
    if (this.seen.size > 400) {
      const first = this.seen.keys().next().value;
      this.seen.delete(first);
    }

    let rec = this.rxMsgs.get(msgId);
    if (!rec) {
      rec = { total, parts: new Map(), at: Date.now(), from: frame.src };
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
      this.onMessage({ from: this.peerName || `设备${rec.from}`, text: bytesToText(bytes), at: Date.now() });
    }
  }

  _onAck(frame, positive) {
    if (!this.current) return;
    const p = frame.payload;
    const ackSeq = p.length >= 1 ? p[0] : frame.seq;
    if (ackSeq !== this.current.seq) {
      this._log('info', `ACK seq=${ackSeq} 与当前 ${this.current.seq} 不匹配，忽略`);
      return;
    }
    if (this.ackTimer) {
      this.timers.clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (positive) {
      this._log('ok', `分片 ${this.current.chunk + 1}/${this.current.total} 已确认`);
      this.current = null;
      this.retries = 0;
      this._pump();
    } else {
      this._log('warn', '收到 NACK，立即重传');
      this._retransmit();
    }
  }

  /* ============================ 发送 ============================ */

  _beacon() {
    if (this.helloTimer) return;
    const tick = () => {
      this.helloTimer = this.timers.setTimeout(() => {
        this.helloTimer = null;
        if (!this.paired && !this.busy) this._sendHello();
        if (!this.paired) this._beacon();
      }, this.helloInterval);
    };
    tick();
  }

  _sendHello() {
    this._delayedSend(() =>
      buildFrame({ type: FRAME.HELLO, seq: this._nextSeq(), src: this.myId, dst: 0, payload: textToBytes(this.myName) })
    );
  }

  _sendHelloAck() {
    this._delayedSend(() =>
      buildFrame({ type: FRAME.HELLO_ACK, seq: this._nextSeq(), src: this.myId, dst: this.peerId, payload: textToBytes(this.myName) })
    );
  }

  _sendAck(seq) {
    this._delayedSend(() =>
      buildFrame({ type: FRAME.ACK, seq: this._nextSeq(), src: this.myId, dst: this.peerId, payload: Uint8Array.from([seq & 0xff]) })
    );
  }

  _nextSeq() {
    this.seq = (this.seq % 255) + 1;
    return this.seq;
  }

  /** 把发送串行化，避免两帧音频叠在一起 */
  _delayedSend(makeFrame) {
    this.txChain = this.txChain
      .then(async () => {
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
      if (this.state === STATE.TX) this._setState(STATE.IDLE);
    }
  }

  _pump() {
    if (this.current || !this.queue.length) {
      if (!this.current && !this.queue.length && this.state !== STATE.TX) this._setState(STATE.IDLE);
      return;
    }
    const job = this.queue.shift();
    this.current = { ...job, seq: this._nextSeq(), tries: 0 };
    // 一条消息的第一帧先随机退避一下：双方同时开口会互相盖掉
    const jitter = this.txJitter > 0 ? Math.floor(this._rand() * this.txJitter) : 0;
    if (jitter > 0) {
      this._log('info', `起发退避 ${jitter}ms`);
      this.timers.setTimeout(() => {
        if (this.current === this.current) this._sendCurrent();
      }, jitter);
    } else {
      this._sendCurrent();
    }
  }

  /**
   * 载波侦听：对端正在发声时先让行。
   * 声波是半双工广播信道，两边同时说话会互相盖掉，必须有人让。
   */
  setCarrierBusy(busy) {
    this.carrierBusy = !!busy;
  }

  _sendCurrent() {
    const job = this.current;
    if (!job) return;
    if (this.carrierBusy) {
      if (this._deferTimer) return;
      this._log('info', '信道忙（对端正在发），让行…');
      this._deferTimer = this.timers.setTimeout(() => {
        this._deferTimer = null;
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

  _retransmit() {
    const job = this.current;
    if (!job) return;
    job.tries++;
    if (job.tries > this.maxRetries) {
      this._log('error', `分片 ${job.chunk + 1}/${job.total} 重传 ${this.maxRetries} 次仍无确认，放弃`);
      this.current = null;
      this.retries = 0;
      this._setState(STATE.IDLE);
      this.onStatus(STATE.IDLE, { error: 'no-ack' });
      this._pump();
      return;
    }
    this._sendCurrent();
  }

  _onAckTimeout() {
    this.ackTimer = null;
    if (!this.current) return;
    this._log('warn', `等待确认超时（${this.ackTimeout}ms）`);
    this._retransmit();
  }

  /* ============================ 维护 ============================ */

  /** 清理超时未收全的消息；需要外部周期性调用（或由 push 循环驱动） */
  tick(now = Date.now()) {
    for (const [msgId, rec] of this.rxMsgs) {
      if (now - rec.at > this.rxMsgTimeout) {
        this._log('warn', `消息 ${msgId} 分片超时未收全（${rec.parts.size}/${rec.total}），丢弃`);
        this.rxMsgs.delete(msgId);
      }
    }
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onStatus(s, { peer: this.peerName, queue: this.queue.length });
  }

  _typeName(t) {
    return Object.keys(FRAME).find((k) => FRAME[k] === t) || String(t);
  }

  _log(level, text) {
    this.onLog({ level, text, at: Date.now() });
  }
}
