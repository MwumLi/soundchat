/**
 * app.js — 浏览器端：Web Audio 收发 + 聊天界面
 *
 * 音频链路：
 *   发送：modulate() 生成 Float32 波形 → AudioBuffer → BufferSource → 扬声器
 *   接收：getUserMedia（关掉 AGC/降噪/回声消除）→ ScriptProcessor → AcousticReceiver → 帧 → ChatSession
 *
 * 半双工处理：
 *   自己发声期间直接丢弃麦克风输入，发完 reset() 接收机。
 *   否则会解到自己的声音，且载波侦听会被自己触发。
 */

import {
  PROFILES,
  DEFAULT_PROFILE,
  FRAME,
  buildFrame,
  modulate,
  AcousticReceiver,
  textToBytes,
  bytesToText,
  frameDuration,
  samplesPerSymbol,
} from './modem.js';
import { ChatSession, STATE } from './protocol.js';

/* ============================ DOM ============================ */

const $ = (id) => document.getElementById(id);
const el = {
  dot: $('dot'),
  profile: $('profile'),
  btnPair: $('btnPair'),
  btnLog: $('btnLog'),
  statusText: $('statusText'),
  meText: $('meText'),
  peerText: $('peerText'),
  rateText: $('rateText'),
  meterFill: $('meterFill'),
  chat: $('chat'),
  logPanel: $('logPanel'),
  text: $('text'),
  send: $('send'),
  overlay: $('overlay'),
  btnStart: $('btnStart'),
  btnClear: $('btnClear'),
  btnSelfTest: $('btnSelfTest'),
  btnWav: $('btnWav'),
};

/* ============================ 配置 ============================ */

/** 载波侦听门限（归一化能量：满幅正弦 ≈ 0.72） */
const CARRIER_THRESHOLD = 0.05;
/** 麦克风增益（有些设备录音偏小） */
const MIC_GAIN = 1.0;

const state = {
  ctx: null,
  stream: null,
  rx: null,
  session: null,
  txActive: false,
  profileKey: localStorage.getItem('sc.profile') || DEFAULT_PROFILE,
  myId: 0,
  myName: '',
  lastTick: 0,
  lastClipWarn: 0,
  nonce: 0,
};

/* ============================ 工具 ============================ */

function localGet(k, d) {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
}
function localSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 忽略 */
  }
}

/**
 * 两层身份：
 *   sc.id       localStorage   —— 这台机器的**持久身份**，跨 tab、跨会话稳定，
 *                                 聊天记录按它归属，所以不能每个 tab 换一个。
 *   sc.id.tab   sessionStorage —— 仅当本 tab 在 ID 撞车中"让位"时写入的临时覆盖。
 *
 * 为什么不直接用 sessionStorage 当身份：那样每开一个 tab 就是一台新设备，
 * 身份和历史都跟着碎掉。撞车问题改由 HELLO 里的 nonce 做无歧义裁决解决
 * （nonce 小的让位），这样既保住了持久身份，同机双开也不会互抢。
 */
function sessGet(k, d) {
  try {
    return sessionStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
}
function sessSet(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* 忽略 */
  }
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/* ============================ 聊天记录持久化 ============================ */

const HISTORY_KEY = 'sc.history';
const HISTORY_MAX = 300;

function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function pushHistory(entry) {
  const h = loadHistory();
  h.push(entry);
  while (h.length > HISTORY_MAX) h.shift();
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch {
    /* 配额满 / 隐私模式，忽略即可，不影响聊天 */
  }
}

function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 只渲染，不落盘 */
function renderMsg(kind, text, meta = '') {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  if (meta) {
    const m = document.createElement('div');
    m.className = 'meta';
    m.textContent = meta;
    div.appendChild(m);
  }
  div.appendChild(document.createTextNode(text));
  el.chat.appendChild(div);
  el.chat.scrollTop = el.chat.scrollHeight;
}

function addMsg(kind, text, meta = '', persist = true) {
  renderMsg(kind, text, meta);
  if (persist) pushHistory({ k: kind, t: text, m: meta, a: Date.now() });
}

function addLog(level, text) {
  const d = document.createElement('div');
  d.className = level;
  d.textContent = `${fmtTime(Date.now())}  ${text}`;
  el.logPanel.appendChild(d);
  while (el.logPanel.childElementCount > 400) el.logPanel.removeChild(el.logPanel.firstChild);
  el.logPanel.scrollTop = el.logPanel.scrollHeight;
}

const LEVEL_TEXT = {
  [STATE.IDLE]: '监听中',
  [STATE.TX]: '正在发声…',
  [STATE.WAIT_ACK]: '等待对端确认…',
  [STATE.PAIRING]: '配对中…',
  [STATE.BUSY]: '对端正在发…',
};

function setStatus(s, info = {}) {
  el.statusText.textContent = LEVEL_TEXT[s] || s;
  el.dot.className = 'dot';
  if (s === STATE.TX || s === STATE.WAIT_ACK) el.dot.classList.add('tx');
  else if (s === STATE.IDLE) el.dot.classList.add('on');
  if (info.error === 'no-ack') {
    addMsg('err', '对方没有确认，这一条可能没送达（可以再发一次）', '', false);
    el.dot.className = 'dot err';
  }
}

/* ============================ 设备身份 ============================ */

function randomId() {
  return 1 + Math.floor(Math.random() * 254);
}

function initIdentity() {
  // 优先用本 tab 的临时覆盖（说明这个 tab 之前让过位），否则用持久身份
  let id = parseInt(sessGet('sc.id.tab', '0'), 10);
  if (!id || id < 1 || id > 254) id = parseInt(localGet('sc.id', '0'), 10);
  if (!id || id < 1 || id > 254) {
    id = randomId();
    localSet('sc.id', String(id));
  }
  state.myId = id;
  state.myName = localGet('sc.name', '') || `设备${id}`;

  // tab 内随机数：ID 撞车时用来裁决谁让位（协议层比较，大的让位）
  let nonce = parseInt(sessGet('sc.nonce', '0'), 10);
  if (!nonce) {
    nonce = (Math.random() * 0xffffffff) >>> 0;
    sessSet('sc.nonce', String(nonce));
  }
  state.nonce = nonce;
  if (el.meText) el.meText.textContent = `我：${state.myName}`;
}

/* ============================ 音频 ============================ */

/** 归一化信号强度，用于电平表与载波侦听 */
function normLevel() {
  const rx = state.rx;
  if (!rx) return 0;
  return rx.level / ((rx.winLen * rx.winLen) / 4);
}

async function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  state.ctx = new AC({ latencyHint: 'interactive' });
  if (state.ctx.state === 'suspended') await state.ctx.resume();

  // 关键：必须关掉 AGC / 降噪 / 回声消除，否则浏览器会把我们的载波当噪声处理掉
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  const src = state.ctx.createMediaStreamSource(state.stream);
  const gain = state.ctx.createGain();
  gain.gain.value = MIC_GAIN;
  // ScriptProcessor 已废弃但兼容性最好（含 iOS Safari），且不需要额外文件
  const proc = state.ctx.createScriptProcessor(4096, 1, 1);
  src.connect(gain);
  gain.connect(proc);
  proc.connect(state.ctx.destination); // 不连出去某些浏览器不回调
  gain.gain.value = MIC_GAIN;
  proc.onaudioprocess = onAudio;
  return state.ctx.sampleRate;
}

const now2 = () => Date.now();

function onAudio(e) {
  if (state.txActive || !state.rx) return;
  const input = e.inputBuffer.getChannelData(0);
  const chunk = new Float32Array(input.length);
  chunk.set(input);
  const frames = state.rx.push(chunk);
  for (const f of frames) state.session.onFrame(f);

  // 载波侦听：对端在发就让行（自己发声期间不会走到这里）
  state.session.setCarrierBusy(normLevel() > CARRIER_THRESHOLD);

  // 电平表
  const raw = normLevel();
  const lv = Math.min(1, raw / 0.7);
  if (raw > 0.95 && now2() - state.lastClipWarn > 8000) {
    state.lastClipWarn = now2();
    addLog('warn', '输入电平接近满幅，可能削波失真；同机双开时请把音量调小一些');
  }
  el.meterFill.style.width = `${(lv * 100).toFixed(0)}%`;
  el.meterFill.style.background = lv > 0.5 ? 'var(--accent)' : 'var(--ok)';

  const now = Date.now();
  if (now - state.lastTick > 1000) {
    state.lastTick = now;
    state.session.tick(now);
  }
}

/** 播放一帧波形，播完 resolve */
function transmit(bytes) {
  const ctx = state.ctx;
  const profile = PROFILES[state.profileKey];
  const wav = modulate(bytes, profile, ctx.sampleRate);
  const buf = ctx.createBuffer(1, wav.length, ctx.sampleRate);
  buf.copyToChannel(wav, 0);
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(ctx.destination);
  state.txActive = true;
  return new Promise((resolve) => {
    node.onended = () => {
      state.txActive = false;
      // 丢掉自己发声期间录到的内容，避免解到自己的声音
      if (state.rx) state.rx.reset();
      resolve();
    };
    node.start();
  });
}

/* ============================ 启动 ============================ */

// 身份与档位选择不依赖音频权限，页面一加载就准备好，
// 这样用户点「开始监听」时不会再因为初始化顺序出问题。
initIdentity();
buildProfileSelect();

function buildProfileSelect() {
  el.profile.innerHTML = '';
  for (const key of Object.keys(PROFILES)) {
    const p = PROFILES[key];
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `${p.label}档`;
    el.profile.appendChild(o);
  }
  el.profile.value = state.profileKey;
  updateRateText();
}

function updateRateText() {
  const p = PROFILES[state.profileKey];
  const fs = state.ctx ? state.ctx.sampleRate : 48000;
  const sps = samplesPerSymbol(p, fs);
  const dur = frameDuration(p, buildFrame({ type: FRAME.MSG, payload: new Uint8Array(60) }));
  el.rateText.textContent = `${p.symbolMs.toFixed(1)}ms/符号 · 60字节约 ${dur.toFixed(1)}s · ${fs}Hz`;
}

async function boot() {
  const fs = await startAudio();
  state.rx = new AcousticReceiver(PROFILES[state.profileKey], fs);
  updateRateText();
  addLog('ok', `音频就绪：${fs}Hz，本机 id=${state.myId} 昵称=${state.myName}`);

  state.session = new ChatSession({
    myId: state.myId,
    myName: state.myName,
    transmit,
    opts: { profileKey: state.profileKey },
    onMessage: (m) => addMsg('peer', m.text, `${m.from} · ${fmtTime(m.at)}`),
    onPeer: (p) => {
      el.peerText.textContent = `已配对：${p.name}`;
      addMsg('sys', `已与「${p.name}」建立声波连接`);
    },
    onStatus: setStatus,
    onLog: (e) => addLog(e.level, e.text),
    onIdCollision: () => {
      // 协议层已经裁决过：走到这里说明本 tab 的 nonce 更大，由本 tab 让位。
      // 只写 sessionStorage 覆盖，不动 localStorage 的持久身份 ——
      // 否则会把另一个 tab（以及将来的会话）的身份一起改掉。
      const old = state.myId;
      let id = randomId();
      while (id === old) id = randomId();
      state.myId = id;
      state.myName = `设备${id}`;
      sessSet('sc.id.tab', String(id));
      if (el.meText) el.meText.textContent = `我：${state.myName}`;
      state.session.setId(id);
      addLog('warn', `设备 ID 与另一个窗口撞车，本 tab 临时改用「${state.myName}」（持久身份仍是设备${old}）`);
      addMsg('sys', `检测到另一个窗口也叫「设备${old}」，本窗口临时改名为「${state.myName}」`, '', false);
      state.session.pair();
    },
  });

  state.session.start();
  el.overlay.classList.add('hide');

  const hist = loadHistory();
  if (hist.length) {
    for (const e of hist) renderMsg(e.k, e.t, e.m);
    addMsg('sys', `已恢复 ${hist.length} 条本机聊天记录`, '', false);
  }
  addMsg('sys', '开始监听。把两台设备放在同一房间，点「配对」或直接发消息。', '', false);
  el.text.focus();
}

/* ============================ 自检 / 导出 ============================ */

function selfTest() {
  const p = PROFILES[state.profileKey];
  const fs = state.ctx ? state.ctx.sampleRate : 48000;
  const text = '自检：声波链路正常 123';
  const bytes = buildFrame({ type: FRAME.MSG, seq: 1, src: 1, dst: 2, payload: textToBytes(text) });
  const wav = modulate(bytes, p, fs);
  const rx = new AcousticReceiver(p, fs);
  const t0 = performance.now();
  const out = [];
  for (let i = 0; i < wav.length; i += 960) {
    for (const f of rx.push(wav.subarray(i, Math.min(i + 960, wav.length)))) out.push(f);
  }
  for (const f of rx.flush()) out.push(f);
  const ms = (performance.now() - t0).toFixed(0);
  const ok = out.length === 1 && bytesToText(out[0].payload) === text;
  addLog(ok ? 'ok' : 'error', `自检 ${ok ? '通过' : '失败'}：${p.label}档，${wav.length} 采样，解码耗时 ${ms}ms`);
  addMsg(ok ? 'sys' : 'err', ok ? `自检通过（${p.label}档，解码 ${ms}ms）` : '自检失败，请查看日志', '', false);
}

function exportWav() {
  const p = PROFILES[state.profileKey];
  const fs = state.ctx ? state.ctx.sampleRate : 48000;
  const text = el.text.value.trim() || '声波聊天测试';
  const bytes = buildFrame({ type: FRAME.MSG, seq: 1, src: state.myId, dst: 0, payload: textToBytes(text) });
  const wav = modulate(bytes, p, fs);
  const buf = new ArrayBuffer(44 + wav.length * 2);
  const dv = new DataView(buf);
  const wstr = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + wav.length * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, fs, true);
  dv.setUint32(28, fs * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, wav.length * 2, true);
  for (let i = 0; i < wav.length; i++) {
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, wav[i])) * 32767, true);
  }
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'soundchat.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  addLog('ok', `已导出 ${a.download}（${(wav.length / fs).toFixed(2)}s），可用另一台设备外放试听`);
}

/* ============================ 事件 ============================ */

function doSend() {
  const text = el.text.value.trim();
  if (!text) return;
  if (!state.session) {
    addMsg('err', '请先点「开始监听」');
    return;
  }
  const r = state.session.say(text);
  if (!r.ok) {
    addMsg('err', r.reason === 'too-long' ? '文字太长了，请分段发送' : '不能发送空消息');
    return;
  }
  addMsg('me', text, `我 · ${fmtTime(Date.now())}${r.chunks > 1 ? ` · 分 ${r.chunks} 帧` : ''}`);
  el.text.value = '';
  el.text.style.height = 'auto';
}

el.btnStart.addEventListener('click', () => {
  boot().catch((e) => {
    addLog('error', `启动失败：${e.message}`);
    alert(`启动失败：${e.message}\n\n如果是麦克风权限问题，请确认页面是通过 https:// 或 localhost 打开的。`);
  });
});

el.send.addEventListener('click', doSend);

el.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});
el.text.addEventListener('input', () => {
  el.text.style.height = 'auto';
  el.text.style.height = `${Math.min(120, el.text.scrollHeight)}px`;
});

el.profile.addEventListener('change', () => {
  state.profileKey = el.profile.value;
  localSet('sc.profile', state.profileKey);
  const fs = state.ctx ? state.ctx.sampleRate : 48000;
  if (state.rx) state.rx = new AcousticReceiver(PROFILES[state.profileKey], fs);
  if (state.session) state.session.profileKey = state.profileKey;
  updateRateText();
  addLog('info', `切换到 ${PROFILES[state.profileKey].label}档（两端必须用同一档位）`);
  addMsg('sys', `已切换到「${PROFILES[state.profileKey].label}」档，对方也要切到同一档`);
});

el.btnPair.addEventListener('click', () => {
  if (!state.session) {
    addMsg('err', '请先点「开始监听」');
    return;
  }
  state.session.pair();
});

el.btnLog.addEventListener('click', () => {
  el.logPanel.classList.toggle('show');
});

el.btnClear.addEventListener('click', () => {
  if (!confirm('清空本机保存的聊天记录？\n（只影响这台设备的浏览器本地记录，不影响对方）')) return;
  clearHistory();
  el.chat.innerHTML = '';
  addMsg('sys', '聊天记录已清空', '', false);
});

el.btnSelfTest.addEventListener('click', selfTest);
el.btnWav.addEventListener('click', exportWav);

// 供调试用
window.__soundchat = state;

// 自动化验证入口：?selftest=1 时页面加载后自动跑一次自检，并把结果写进 DOM，
// 这样可以用无头 Chrome --dump-dom 做冒烟测试。
if (new URLSearchParams(location.search).has('selftest')) {
  setTimeout(() => {
    try {
      selfTest();
      const d = document.createElement('div');
      d.id = 'selftest-result';
      d.textContent = el.logPanel.lastElementChild ? el.logPanel.lastElementChild.textContent : 'no-result';
      document.body.appendChild(d);
    } catch (e) {
      const d = document.createElement('div');
      d.id = 'selftest-result';
      d.textContent = 'THREW: ' + e.message;
      document.body.appendChild(d);
    }
  }, 60);
}
