/**
 * modem.js — 声波调制解调器（连续相位 MFSK）
 *
 * 设计要点
 * --------
 * 1. 调制：16 音 MFSK，每符号 4 bit，连续相位（CPFSK）避免符号切换时的爆音与频谱扩散。
 *    音间隔 300~400 Hz，远大于符号率对应的 DFT 分辨率（约 47~94 Hz），对室内多径有较强容忍度。
 * 2. 同步：16 个符号的升调前导码 [0,1,2,...,15]，接收端在"符号能量列"上做二维搜索
 *    （起始位置 × 每符号采样数），再对前导码做精细二维搜索（位置 × 周期）。
 *    搜索"每符号采样数"是为了兼容收发两端采样率不一致（44.1k ↔ 48k，偏差 8.8%）。
 * 3. 帧结构：header(5B) + payload(0~200B) + CRC16(2B)，每字节拆成 2 个 4bit 符号。
 * 4. 解调：Hann 窗 Goertzel 音阶组 + 取最大，非相干检测，不需要载波恢复。
 *
 * 本文件是纯计算模块：不依赖 DOM、Web Audio、任何第三方库，可在 Node 中直接单测。
 */

/* ============================ 常量 ============================ */

/**
 * 帧类型（v2，见 docs/design.md）
 * 物理层只负责按 type 的 4 个 bit 编解码，具体语义由会话层定义。
 */
export const FRAME = {
  BEACON: 0x1, // A→广播：宣告存在（nonce + 昵称），不含 PIN
  CONNECT_REQ: 0x2, // B→A：请求连接（PIN + 昵称）
  CONNECT_ACK: 0x3, // A→B：同意连接
  REJECT: 0x4, // A→B：拒绝（原因码）
  MSG: 0x5, // 双向：聊天正文
  ACK: 0x6, // 双向：停等确认
  BYE: 0x7, // 双向：主动断开
};

/** 帧类型的合法范围（帧头校验用） */
export const FRAME_TYPE_MIN = 1;
export const FRAME_TYPE_MAX = 7;

export const VERSION = 1;
export const HEADER_BYTES = 6; // ver|type, seq, src, dst, len, crc8(header)
export const CRC_BYTES = 2;
export const MAX_PAYLOAD = 200;

/** 传输档位：以「时间」而非「采样数」定义，从而与设备采样率解耦 */
export const PROFILES = {
  robust: {
    key: 'robust',
    label: '稳健',
    symbolMs: 21.333, // 1024 @48k
    nTones: 16,
    toneBase: 1000,
    toneSpacing: 400, // 1000..7000 Hz
    desc: '抗混响/抗噪优先，约 23 B/s',
  },
  fast: {
    key: 'fast',
    label: '快速',
    symbolMs: 13.333, // 512 @48k
    nTones: 16,
    toneBase: 1000,
    toneSpacing: 400, // 1000..7000 Hz
    desc: '速度优先，约 31 B/s，混响容忍度略低于稳健档',
  },
};

export const DEFAULT_PROFILE = 'robust';

/* ============================ CRC16-CCITT ============================ */

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

/** CRC-8/ATM，用于保护帧头（帧头本身很短，必须有校验才能挡住假同步） */
export function crc8(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = CRC8_TABLE[crc ^ bytes[i]];
  return crc;
}

export function crc16ccitt(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  return crc;
}

/* ============================ 文本 <-> 字节 ============================ */

const _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const _dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

export function textToBytes(s) {
  if (_enc) return _enc.encode(s);
  return Uint8Array.from(Buffer.from(s, 'utf8'));
}
export function bytesToText(b) {
  if (_dec) return _dec.decode(b);
  return Buffer.from(b).toString('utf8');
}

/* ============================ 帧编解码 ============================ */

/**
 * 组装帧字节：header(5) + payload(len) + crc16(2)
 * @returns {Uint8Array}
 */
export function buildFrame({ type, seq = 0, src = 0, dst = 0, payload = new Uint8Array(0) }) {
  if (payload.length > MAX_PAYLOAD) throw new Error(`payload 过长: ${payload.length} > ${MAX_PAYLOAD}`);
  const buf = new Uint8Array(HEADER_BYTES + payload.length + CRC_BYTES);
  buf[0] = ((VERSION & 0x0f) << 4) | (type & 0x0f);
  buf[1] = seq & 0xff;
  buf[2] = src & 0xff;
  buf[3] = dst & 0xff;
  buf[4] = payload.length;
  buf[5] = crc8(buf.subarray(0, 5));
  buf.set(payload, HEADER_BYTES);
  const crc = crc16ccitt(buf.subarray(0, HEADER_BYTES + payload.length));
  buf[HEADER_BYTES + payload.length] = (crc >> 8) & 0xff;
  buf[HEADER_BYTES + payload.length + 1] = crc & 0xff;
  return buf;
}

/** 解析帧字节，CRC 不符返回 null */
export function parseFrame(bytes) {
  if (bytes.length < HEADER_BYTES + CRC_BYTES) return null;
  const ver = bytes[0] >> 4;
  const type = bytes[0] & 0x0f;
  const len = bytes[4];
  if (bytes[5] !== crc8(bytes.subarray(0, 5))) return null;
  if (bytes.length !== HEADER_BYTES + len + CRC_BYTES) return null;
  const body = bytes.subarray(0, HEADER_BYTES + len);
  const got = (bytes[HEADER_BYTES + len] << 8) | bytes[HEADER_BYTES + len + 1];
  if (crc16ccitt(body) !== got) return null;
  return {
    version: ver,
    type,
    seq: bytes[1],
    src: bytes[2],
    dst: bytes[3],
    payload: bytes.subarray(HEADER_BYTES, HEADER_BYTES + len),
  };
}

/* ============================ 调制 ============================ */

/** 每符号采样数（按给定采样率） */
export function samplesPerSymbol(profile, fs) {
  return Math.max(32, Math.round((profile.symbolMs * fs) / 1000));
}

/** 该档位在给定采样率下的原始比特率（bit/s，含前导码与 CRC 开销之外的理论值） */
export function rawBitrate(profile) {
  return (Math.log2(profile.nTones) / profile.symbolMs) * 1000;
}

/**
 * 生成一帧的音频波形（Float32Array，峰值 0.85）
 * @param {Uint8Array} frameBytes 由 buildFrame 产生的字节
 * @param {object} profile
 * @param {number} fs 采样率
 */
export function modulate(frameBytes, profile, fs) {
  const sps = samplesPerSymbol(profile, fs);
  const nPre = profile.nTones;
  const nSym = nPre + frameBytes.length * 2;
  const out = new Float32Array(nSym * sps);
  const twoPi = Math.PI * 2;
  const dphiTab = new Float64Array(nPre);
  for (let t = 0; t < nPre; t++) dphiTab[t] = (twoPi * (profile.toneBase + t * profile.toneSpacing)) / fs;

  let phase = 0;
  let idx = 0;
  for (let s = 0; s < nSym; s++) {
    let tone;
    if (s < nPre) tone = s;
    else {
      const d = s - nPre;
      const b = frameBytes[d >> 1];
      tone = (d & 1) === 0 ? b >> 4 : b & 0x0f;
    }
    const dphi = dphiTab[tone];
    for (let n = 0; n < sps; n++) {
      out[idx++] = Math.sin(phase);
      phase += dphi;
      if (phase >= twoPi) phase -= twoPi;
    }
  }

  // 淡入必须极短：CPFSK 从相位 0 起振（sin0=0），本身没有爆音，
  // 而长淡入会削弱前导码第一个符号，把接收端的周期估计带偏。
  const fadeIn = Math.min(Math.round(0.001 * fs), Math.floor(sps / 8));
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  const fadeOut = Math.min(Math.round(0.005 * fs), Math.floor(sps / 4));
  for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] *= i / fadeOut;

  // 归一化
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i] < 0 ? -out[i] : out[i];
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = 0.85 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }
  return out;
}

/** 生成前导码的纯音序列（供调试/频谱查看） */
export function preambleTones(profile) {
  return Array.from({ length: profile.nTones }, (_, i) => profile.toneBase + i * profile.toneSpacing);
}

/* ============================ 解调器 ============================ */

const NEED_MORE = Symbol('need-more');

/**
 * 流式声波接收机。
 *
 *   const rx = new AcousticReceiver(PROFILES.robust, ctx.sampleRate);
 *   const frames = rx.push(float32Chunk);   // 返回本次新解出的帧
 */
export class AcousticReceiver {
  /**
   * @param {object} profile
   * @param {number} rxFs 接收端采样率
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.42] 前导码归一化匹配分阈值
   * @param {number} [opts.energyGate=3000] 前导码单符号期望音能量下限（噪声门限）
   * @param {number} [opts.historySeconds=20] 环形缓冲保留时长
   */
  constructor(profile, rxFs, opts = {}) {
    this.profile = profile;
    this.fs = rxFs;
    this.nominalSps = (profile.symbolMs * rxFs) / 1000;
    this.hop = Math.max(8, Math.round(this.nominalSps / 8));
    this.winLen = Math.round(this.nominalSps);
    this.threshold = opts.threshold ?? 0.42;
    this.timingGain = opts.timingGain ?? 0.05; // 每符号最大定时修正（占符号比例）
    this.energyGate = opts.energyGate ?? 3000;
    this.historySeconds = opts.historySeconds ?? 20;

    this.cap = Math.ceil(rxFs * this.historySeconds);
    this.ring = new Float32Array(this.cap);
    this.written = 0;

    this.colAbs = []; // 每列窗口起始的绝对采样位置
    this.colE = []; // 每列 16 个音的能量
    this.colT = []; // 每列 16 个音的能量之和（预计算，加速前导码扫描）
    this.colNextAbs = 0;
    this.scanFrom = 0;
    this._pending = null; // 已粗定位、正在等数据到齐的帧

    // 音阶系数缓存
    this._coef = new Float64Array(profile.nTones);
    for (let t = 0; t < profile.nTones; t++) {
      this._coef[t] = 2 * Math.cos((2 * Math.PI * (profile.toneBase + t * profile.toneSpacing)) / rxFs);
    }
    this._bank = new Float64Array(profile.nTones);

    // 扫描参数
    this.maxSpan = Math.round(((profile.nTones - 1) * this.nominalSps * 1.085) / this.hop);
    this.acceptNeed = Math.ceil(profile.nTones * this.nominalSps * 1.085);
    this.lookback = Math.ceil((this.acceptNeed - this.winLen) / this.hop) + 4;
    this.cands = [];
    for (let k = 0.92; k <= 1.0851; k += 0.005) this.cands.push(this.nominalSps * k);
    this._tried = new Set();
    this.decodeFloor = 0; // 已解出的帧之前的列不再扫描，避免重复出帧
    this._hannCache = new Map();
    this._scratchCache = new Map();

    this.lastSignal = 0; // 最近一次扫描的最大列能量（UI 用）
    this.level = 0; // 最近一次 push 生成列的最大总能量，供载波侦听用
  }

  /**
   * 流结束（停止录音）时调用：把挂起等待的帧硬解一次。
   *
   * 必须要有这个：接收机在等「末符号数据到齐」，如果输入流刚好在帧尾结束、
   * 后面没有尾随静音，就永远等不到更多数据，帧会被无声丢掉。
   * @returns {Array<object>} 本次解出的帧
   */
  flush() {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const pd = this._pending;
      if (!pd || pd.totalSyms <= 0) break;
      this._pending = null;
      const f = this._emitFrame(pd, true);
      if (f && f !== NEED_MORE) {
        out.push(f);
        break;
      }
      if (this._pending) continue;
      break;
    }
    this._pending = null;
    return out;
  }

  /** 清空缓冲（例如即将开始发射时调用，避免解到自己的声音） */
  reset() {
    this.ring.fill(0);
    this.written = 0;
    this.colAbs.length = 0;
    this.colE.length = 0;
    this.colT.length = 0;
    this.colNextAbs = 0;
    this.scanFrom = 0;
    this._pending = null;
    this._tried.clear();
    this.decodeFloor = 0;
    this.lastSignal = 0;
    this.level = 0;
  }

  /* ---------- 内部工具 ---------- */

  _scratch(len) {
    let b = this._scratchCache.get(len);
    if (!b) {
      b = new Float32Array(len);
      this._scratchCache.set(len, b);
    }
    return b;
  }

  _hann(len) {
    let w = this._hannCache.get(len);
    if (!w) {
      w = new Float64Array(len);
      for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
      this._hannCache.set(len, w);
    }
    return w;
  }

  /** 从环形缓冲读取 [abs, abs+len) 到 dst */
  _readInto(abs, len, dst) {
    const cap = this.cap;
    let p = abs % cap;
    if (p < 0) p += cap;
    const first = Math.min(len, cap - p);
    dst.set(this.ring.subarray(p, p + first), 0);
    if (first < len) dst.set(this.ring.subarray(0, len - first), first);
    return dst;
  }

  /** 以 center 为中心、长度 len 的窗内 16 个音的能量（Hann 窗 Goertzel） */
  _toneBank(center, len, windowed) {
    const P = this.profile;
    const start = Math.round(center - len / 2);
    const buf = this._readInto(start, len, this._scratch(len));
    const win = windowed ? this._hann(len) : null;
    const out = this._bank;
    for (let t = 0; t < P.nTones; t++) {
      const c = this._coef[t];
      let s1 = 0;
      let s2 = 0;
      if (win) {
        for (let i = 0; i < len; i++) {
          const s0 = buf[i] * win[i] + c * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
      } else {
        for (let i = 0; i < len; i++) {
          const s0 = buf[i] + c * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
      }
      out[t] = s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    return out;
  }

  /**
   * 前导码归一化匹配分：期望音能量 / 全部音能量。
   *
   * winFrac 取接近 1（0.95）很关键：窗口几乎盖满整个符号，只有窗口完全落在符号内才拿满分，
   * 于是 (起始位置, 每符号采样数) 平面上的满分平台很窄，周期才估得准。
   * 取 0.7 会让平台宽到 ±0.15 符号，周期误差累积到帧尾就解不出来了。
   */
  _preambleScore(startAbs, sps, winFrac = 0.95) {
    const nPre = this.profile.nTones;
    const len = Math.max(16, Math.round(sps * winFrac));
    const half = len / 2;
    const lo = Math.max(0, this.written - this.cap + 2);
    let num = 0;
    let den = 0;
    for (let s = 0; s < nPre; s++) {
      const center = startAbs + (s + 0.5) * sps;
      if (center + half > this.written || center - half < lo) return -1;
      // 矩形窗：边缘不衰减，窗口稍微越界就会掺进邻符号的音，对周期误差更敏感
      const e = this._toneBank(center, len, false);
      let tot = 0;
      for (let t = 0; t < nPre; t++) tot += e[t];
      num += e[s];
      den += tot;
    }
    if (den <= 1e-12) return 0;
    this.lastSignal = Math.max(this.lastSignal, num / nPre);
    return num / den;
  }

  /* ---------- 主流程 ---------- */

  /**
   * 送入一段音频
   * @param {Float32Array} samples
   * @returns {Array<object>} 本次解出的帧
   */
  push(samples) {
    const n = samples.length;
    if (n === 0) return [];
    let p = this.written % this.cap;
    for (let i = 0; i < n; i++) {
      this.ring[p] = samples[i];
      p++;
      if (p === this.cap) p = 0;
    }
    this.written += n;

    // 生成新的符号能量列
    const maxStart = this.written - this.winLen;
    let lvl = 0;
    while (this.colNextAbs <= maxStart) {
      const e = Float64Array.from(this._toneBank(this.colNextAbs + this.winLen / 2, this.winLen, false));
      let tot = 0;
      for (let t = 0; t < e.length; t++) tot += e[t];
      this.colAbs.push(this.colNextAbs);
      this.colE.push(e);
      this.colT.push(tot);
      if (tot > lvl) lvl = tot;
      this.colNextAbs += this.hop;
    }
    this.level = lvl; // 没有新列时为 0，表示这段音频是静音

    // 淘汰过老的数据
    const minAbs = this.written - this.cap + this.winLen + 2;
    let drop = 0;
    while (drop < this.colAbs.length && this.colAbs[drop] < minAbs) drop++;
    if (drop > 0) {
      this.colAbs.splice(0, drop);
      this.colE.splice(0, drop);
      this.colT.splice(0, drop);
      // scanFrom / decodeFloor 都是「列下标」，淘汰后必须一起平移，
      // 否则长会话（环形缓冲转一圈以后）扫描起点会越界，再也解不出帧。
      this.scanFrom = Math.max(0, this.scanFrom - drop);
      this.decodeFloor = Math.max(0, this.decodeFloor - drop);
    }

    return this._tryDecode();
  }

  _tryDecode() {
    const out = [];
    for (let guard = 0; guard < 4; guard++) {
      const f = this._scan();
      if (!f || f === NEED_MORE) break;
      out.push(f);
    }
    return out;
  }

  /**
   * 扫描流程：
   *   粗搜（符号能量列 + 周期候选） → 精细定位（前导码二维搜索）
   *   → 解 header 并校验 → 等整帧到齐 → 解调 + CRC
   */
  _scan() {
    const P = this.profile;
    const nPre = P.nTones;
    const hop = this.hop;
    const nCols = this.colE.length;

    // 0) 已定位、在等整帧到齐 —— O(1) 返回
    if (this._pending) {
      const pd0 = this._pending;
      if (this.written < pd0.needWritten) {
        if (this.written < pd0.deadline) return NEED_MORE;
        // 等太久（对端中途停了）。若最低限度样本已够就硬解一次，否则不拉黑、回退窗口重扫
        this._pending = null;
        if (pd0.totalSyms > 0 && this.written >= this._minNeed(pd0)) return this._emitFrame(pd0);
        this.scanFrom = Math.max(this.decodeFloor, this.colE.length - this.maxSpan - this.lookback);
        return null;
      }
      this._pending = null;
      return pd0.headerPending ? this._afterHeader(pd0) : this._emitFrame(pd0);
    }

    if (nCols < this.maxSpan + 2) return null;

    // 扫描窗口必须回看 lookback 列：因为「列已生成」比「前导码整段可判定」早约 15 个符号，
    // 不回看就会把当时判定不了的真实前导码永久跳过。
    const windowStart = Math.max(0, nCols - this.maxSpan - this.lookback);
    const from = Math.max(this.decodeFloor, Math.max(0, Math.min(this.scanFrom, nCols - 1)));

    let best = null;
    for (let ci = 0; ci < this.cands.length; ci++) {
      const sps = this.cands[ci];
      const stepCols = sps / hop;
      const span = Math.round((nPre - 1) * stepCols);
      const last = nCols - 1 - span;
      for (let i = from; i <= last; i++) {
        if (this.colAbs[i] + this.acceptNeed > this.written) continue;
        if (this._tried.has(this.colAbs[i])) continue;
        let num = 0;
        let den = 0;
        for (let s = 0; s < nPre; s++) {
          const c = i + Math.round(s * stepCols);
          num += this.colE[c][s];
          den += this.colT[c];
        }
        // 只看平均能量。不要对每个前导符号单独设能量门：
        // 多径频率选择性深衰落会让个别符号整体掉下去，那样会误杀真实前导码。
        // 「锚定在静音段」的假匹配交给后面的 header 合法性校验挡住。
        if (num / nPre < this.energyGate) continue;
        const score = num / den;
        if (!best || score > best.score) best = { score, i, sps };
      }
    }

    if (!best || best.score < this.threshold * 0.75) {
      this.scanFrom = windowStart;
      return null;
    }

    const colAbsValue = this.colAbs[best.i];

    // 1) 精细定位（此时前导码已整段到齐）
    const fine = this._fineSearch(colAbsValue, best.sps);
    if (!fine || fine.score < this.threshold) return this._failCandidate(colAbsValue);

    // 2) 等 header 到齐后再解。精细定位只需前导码，但 header 在后面 10 个符号，
    //    不等齐就读会读到脏数据，解出 len=0 之类的假长度（实测踩过）。
    const pd = { colIdx: best.i, colAbsValue, startGuess: fine.start, sps: fine.sps, score: fine.score, totalSyms: 0 };
    const hdrSyms = HEADER_BYTES * 2;
    const headerNeed = Math.ceil(fine.start + (nPre + hdrSyms) * fine.sps);
    if (this.written < headerNeed) {
      this._pending = { ...pd, headerPending: true, needWritten: headerNeed, deadline: headerNeed + this.fs * 2 };
      return NEED_MORE;
    }
    return this._afterHeader(pd);
  }

  /**
   * header 到齐后：解 header、做合法性校验、算整帧长度。
   * header 自身没有校验码，垃圾长度会让接收机傻等十几秒，必须先挡住。
   */
  _afterHeader(pd) {
    const nPre = this.profile.nTones;
    const hdrSyms = HEADER_BYTES * 2;
    const hdr = unpackNibbles(this._demodSymbols(pd.startGuess, pd.sps, hdrSyms));
    const len = hdr[4];
    if (
      hdr[5] !== crc8(hdr.subarray(0, 5)) ||
      hdr[0] >> 4 !== VERSION ||
      (hdr[0] & 0x0f) < FRAME_TYPE_MIN ||
      (hdr[0] & 0x0f) > FRAME_TYPE_MAX ||
      len > MAX_PAYLOAD
    ) {
      return this._failCandidate(pd.colAbsValue);
    }
    const totalSyms = hdrSyms + len * 2 + CRC_BYTES * 2;
    const next = { ...pd, totalSyms, headerPending: false };
    const needWritten = this._needFor(pd.startGuess, nPre, totalSyms, pd.sps);
    if (this.written < needWritten) {
      this._pending = { ...next, needWritten, deadline: needWritten + this.fs * 2 };
      return NEED_MORE;
    }
    return this._emitFrame(next);
  }

  /** 整帧解调所需的最少样本（最后一个符号窗的下沿） */
  _minNeed(pd) {
    return pd.startGuess + (this.profile.nTones + pd.totalSyms - 0.15) * pd.sps;
  }

  /**
   * 首次尝试解调所需的样本数。
   *
   * 这里刻意「少等一点」：前导码估出的周期误差约 ±0.5%，432 个符号累积能差 2000+ 采样，
   * 按保守上界算会等到流结束都凑不齐（实测快速档 200B 就卡死在这）。
   * 所以先按估计值动手，CRC 不过再靠 retry 多等几个符号——自适应，两头都不误。
   */
  _needFor(startGuess, nPre, totalSyms, sps) {
    return Math.ceil(startGuess + (nPre + totalSyms - 0.15) * sps + sps);
  }

  /** 解调整帧并做 CRC 校验 */
  _emitFrame(pd, force = false) {
    const nPre = this.profile.nTones;
    if (!force && this.written < this._minNeed(pd)) {
      const need = this._needFor(pd.startGuess, nPre, pd.totalSyms, pd.sps);
      this._pending = { ...pd, needWritten: need, deadline: need + this.fs * 2 };
      return NEED_MORE;
    }
    const nib = this._demodSymbols(pd.startGuess, pd.sps, pd.totalSyms);
    const frame = parseFrame(unpackNibbles(nib));
    if (!frame) {
      // CRC 不过：可能只是末符号数据还没到齐，再多等几个符号重试；重试用尽才判失败
      const retries = pd.retries || 0;
      if (!force && retries < 4) {
        const need = this.written + Math.round(4 * pd.sps);
        this._pending = { ...pd, retries: retries + 1, needWritten: need, deadline: need + this.fs * 2 };
        return NEED_MORE;
      }
      return this._failCandidate(pd.colAbsValue);
    }

    const endAbs = pd.startGuess + (nPre + pd.totalSyms) * pd.sps;
    let nextCol = pd.colIdx + 1;
    while (nextCol < this.colAbs.length && this.colAbs[nextCol] < endAbs) nextCol++;

    // decodeFloor 保证已解出的帧不会被重复解出
    this.decodeFloor = nextCol;
    this.scanFrom = nextCol;
    return {
      ...frame,
      score: pd.score,
      snr: this._snrFromScore(pd.score),
      samples: endAbs - pd.startGuess,
      startAbs: pd.startGuess,
      sps: pd.sps,
    };
  }

  /** 候选判定失败：拉黑该列并回退扫描窗口，避免跳过附近的真实前导码 */
  _failCandidate(colAbsValue) {
    this._tried.add(colAbsValue);
    if (this._tried.size > 512) this._tried.clear();
    this.scanFrom = Math.max(this.decodeFloor, this.colE.length - this.maxSpan - this.lookback);
    return null;
  }

  /** 精细二维搜索：起始偏移 ±hop，周期 ±0.5% */
  _fineSearch(startGuess, spsGuess) {
    let best = { score: -1, start: startGuess, sps: spsGuess };
    const offStep = Math.max(4, Math.round(this.hop / 4));
    const spsStep = spsGuess * 0.0005;
    for (let d = -10; d <= 10; d++) {
      const sps = spsGuess + d * spsStep;
      for (let o = -this.hop; o <= this.hop; o += offStep) {
        const sc = this._preambleScore(startGuess + o, sps);
        if (sc > best.score) best = { score: sc, start: startGuess + o, sps };
      }
    }
    return best.score < 0 ? null : best;
  }

  _snrFromScore(score) {
    const s = Math.min(0.995, Math.max(1e-6, score));
    return 10 * Math.log10(s / (1 - s)) - 10 * Math.log10(this.profile.nTones - 1);
  }

  /**
   * 逐符号解调，带有界 bang-bang 定时跟踪。
   *
   * 为什么必须跟踪：前导码只有 16 个符号，用它估出的每符号采样数误差约 0.5%，
   * 一个 400 符号的长帧累积漂移能到 2 个符号，直接解废。
   *
   * 为什么不用连续早-晚门：能量-偏移曲线在符号中心是「平顶 + 三角」，
   * 偏得较远时 (E_late - E_early) 会反向，环路朝错误方向发散，
   * 实测会让解调整体跳一个符号。改成比较「当前中心 vs ±δ 处同一音的能量」，
   * 只朝更高的一侧走固定小步（≤5% 符号），天然有界、捕获范围大。
   */
  _demodSymbols(startAbs, sps, n) {
    const P = this.profile;
    const nPre = P.nTones;
    const len = Math.max(16, Math.round(sps * 0.7));
    const delta = Math.max(2, Math.round(sps * 0.22));
    const half = len / 2;
    const lo = Math.max(0, this.written - this.cap + 2);
    const maxStep = this.timingGain * sps;
    const out = new Uint8Array(n);
    let center = startAbs + (nPre + 0.5) * sps;

    for (let k = 0; k < n; k++) {
      const eC = this._toneBank(center, len, true);
      let bi = 0;
      let v0 = -1;
      for (let t = 0; t < P.nTones; t++) {
        if (eC[t] > v0) {
          v0 = eC[t];
          bi = t;
        }
      }
      out[k] = bi;

      const track = center + delta + half + 2 <= this.written && center - delta - half - 2 >= lo;
      let step = 0;
      if (track && v0 > 0) {
        const eM = this._toneBank(center - delta, len, true);
        const vM = eM[bi];
        const eP = this._toneBank(center + delta, len, true);
        const vP = eP[bi];
        if (vP > v0 * 1.05 && vP >= vM) step = 1;
        else if (vM > v0 * 1.05 && vM > vP) step = -1;
      }
      center += sps + step * maxStep;
    }
    return out;
  }
}

/* ============================ 辅助 ============================ */

/** 4bit 符号序列 -> 字节序列 */
export function unpackNibbles(nib) {
  const out = new Uint8Array(Math.floor(nib.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = ((nib[2 * i] & 0x0f) << 4) | (nib[2 * i + 1] & 0x0f);
  return out;
}

/** 字节序列 -> 4bit 符号序列 */
export function packNibbles(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    out[2 * i] = bytes[i] >> 4;
    out[2 * i + 1] = bytes[i] & 0x0f;
  }
  return out;
}

/** 一帧的符号数 */
export function frameSymbols(profile, frameBytes) {
  return profile.nTones + frameBytes.length * 2;
}

/** 估算一帧的空中时长（秒） */
export function frameDuration(profile, frameBytes) {
  return (frameSymbols(profile, frameBytes) * profile.symbolMs) / 1000;
}

/** 一帧的有效载荷吞吐（字节/秒，含前导码与 CRC 开销） */
export function effectiveByteRate(profile, payloadBytes) {
  const f = buildFrame({ type: FRAME.MSG, payload: new Uint8Array(payloadBytes) });
  const d = frameDuration(profile, f);
  return payloadBytes / d;
}
