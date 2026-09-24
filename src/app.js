/**
 * app.js — 浏览器端 v2：Web Audio 收发 + 广播/扫描/连接界面 + 按设备分会话
 *
 * 音频链路：
 *   发送：modulate() 生成 Float32 波形 → AudioBuffer → BufferSource → 扬声器
 *   接收：getUserMedia（关掉 AGC/降噪/回声消除）→ ScriptProcessor → AcousticReceiver → 帧 → ChatSession
 *
 * 半双工处理：自己发声期间直接丢弃麦克风输入，发完 reset() 接收机。
 * 否则会解到自己的声音，且载波侦听会被自己触发。
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
import {
  peerHistory,
  appendHistory,
  clearPeerHistory,
  clearAllHistory,
  peerList,
  rememberPeer,
  renamePeer,
  forgetPeer,
} from './store.js';

/* ============================ DOM ============================ */

const $ = (id) => document.getElementById(id);
const el = {
  dot: $('dot'),
  titleText: $('titleText'),
  btnDevices: $('btnDevices'),
  btnBroadcast: $('btnBroadcast'),
  btnLog: $('btnLog'),
  statusText: $('statusText'),
  meText: $('meText'),
  peerText: $('peerText'),
  rateText: $('rateText'),
  meterFill: $('meterFill'),
  bcastBar: $('bcastBar'),
  pinText: $('pinText'),
  btnStopBcast: $('btnStopBcast'),
  chat: $('chat'),
  logPanel: $('logPanel'),
  text: $('text'),
  send: $('send'),
  devicePanel: $('devicePanel'),
  btnCloseDevices: $('btnCloseDevices'),
  profile: $('profile'),
  btnScan: $('btnScan'),
  scanHint: $('scanHint'),
  discoverList: $('discoverList'),
  peerList: $('peerList'),
  btnClearAll: $('btnClearAll'),
  pinModal: $('pinModal'),
  pinTitle: $('pinTitle'),
  pinInput: $('pinInput'),
  pinError: $('pinError'),
  btnPinCancel: $('btnPinCancel'),
  btnPinOk: $('btnPinOk'),
  overlay: $('overlay'),
  btnStart: $('btnStart'),
  btnSelfTest: $('btnSelfTest'),
  btnWav: $('btnWav'),
  selfTestResult: $('selfTestResult'),
};

/* ============================ 配置 ============================ */

// 载波侦听门限。归一化能量 ≈ 幅度²（满幅正弦 ≈ 0.72）。
// 原来 0.05（幅度 0.22）比解码门限还高得多，会出现"能解出对端却听不到它在发"的不一致，
// 现在对齐到接近解码下限。
const CARRIER_THRESHOLD = 0.02;
/** 电平表刻度：低于这个电平基本解不出来，用颜色区分「有信号」和「纯噪声」 */
const DECODE_LEVEL = 0.0009;
const MIC_GAIN = 1.0;

const state = {
  ctx: null,
  stream: null,
  rx: null,
  session: null,
  txActive: false,
  profileKey: 'robust',
  myId: 0,
  myName: '',
  nonce: 0,
  viewPeer: 0, // 当前显示的会话
  pinTarget: 0, // PIN 弹窗正在连的设备
  lastClipWarn: 0,
};

/** localStorage / sessionStorage 的安全包装（隐私模式下会抛） */
function safeStorage(kind) {
  try {
    const s = kind === 'session' ? sessionStorage : localStorage;
    const probe = '__sc_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }
}
const LS = safeStorage('local');
const SS = safeStorage('session');

/* ============================ 小工具 ============================ */

function h(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.appendChild(c);
  return n;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtWhen(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return fmtTime(ms);
  return `${Math.floor(diff / 86400000)} 天前`;
}

function snrClass(snr) {
  if (snr >= 8) return 'strong';
  if (snr >= 4) return 'mid';
  return 'weak';
}
function snrLabel(snr) {
  if (snr >= 8) return '信号强';
  if (snr >= 4) return '信号中';
  return '信号弱';
}

/* ============================ 日志 ============================ */

function addLog(level, text) {
  const d = h('div', { class: level, text: `${fmtTime(Date.now())}  ${text}` });
  el.logPanel.appendChild(d);
  while (el.logPanel.childElementCount > 400) el.logPanel.removeChild(el.logPanel.firstChild);
  el.logPanel.scrollTop = el.logPanel.scrollHeight;
}

/* ============================ 消息渲染 ============================ */

function renderMsg(kind, text, meta = '') {
  const box = h('div', { class: `msg ${kind}` });
  if (meta) box.appendChild(h('div', { class: 'meta', text: meta }));
  box.appendChild(document.createTextNode(text));
  el.chat.appendChild(box);
  el.chat.scrollTop = el.chat.scrollHeight;
}

function addMsg(kind, text, meta = '', persistPeer = 0) {
  renderMsg(kind, text, meta);
  if (persistPeer) {
    appendHistory(LS, persistPeer, { k: kind, t: text, m: meta, a: Date.now() });
  }
}

/* ============================ 会话视图 ============================ */

function emptyChatHint() {
  el.chat.innerHTML = '';
  const box = h('div', { class: 'big-hint' });
  if (!state.session || !state.session.paired) {
    box.textContent = '还没连接任何设备。点上方「设备」→「检测设备」寻找对方，或点「广播」让对方找到你。';
  } else {
    box.textContent = `已连接「${state.session.peerName}」，可以发消息了。`;
  }
  el.chat.appendChild(box);
}

function showConversation(peerId) {
  state.viewPeer = peerId || 0;
  el.chat.innerHTML = '';
  if (!peerId) {
    emptyChatHint();
  } else {
    const hist = peerHistory(LS, peerId);
    for (const e of hist) renderMsg(e.k, e.t, e.m);
    if (!hist.length) {
      const name = peerNameOf(peerId);
      el.chat.appendChild(h('div', { class: 'big-hint', text: `这是与「${name}」的会话，还没有消息。` }));
    }
  }
  updateTitle();
  updateSendState();
}

function peerNameOf(id) {
  if (state.session && state.session.peerId === id && state.session.peerName) return state.session.peerName;
  const p = peerList(LS).find((x) => x.id === id);
  return p ? p.name : `设备${id}`;
}

function updateTitle() {
  if (!state.viewPeer) {
    el.titleText.textContent = '声波聊天';
    return;
  }
  const connected = state.session && state.session.paired && state.session.peerId === state.viewPeer;
  el.titleText.textContent = `${peerNameOf(state.viewPeer)}${connected ? '' : '（未连接）'}`;
}

function updateSendState() {
  const connected = state.session && state.session.paired && state.session.peerId === state.viewPeer;
  el.send.disabled = !connected;
  el.text.disabled = !connected;
  el.text.placeholder = connected ? '输入要发送的文字…' : '连接设备后才能发送';
}

/* ============================ 设备面板 ============================ */

function devRow({ name, meta, sig, actions }) {
  const grow = h('div', { class: 'grow' }, [
    h('div', { class: 'name', text: name }),
    meta ? h('div', { class: 'meta', text: meta }) : null,
  ]);
  const row = h('div', { class: 'dev' }, [grow]);
  if (sig) row.appendChild(h('span', { class: `sig ${sig.cls}`, text: sig.text }));
  for (const a of actions) row.appendChild(a);
  return row;
}

function renderDevices() {
  const s = state.session;
  el.discoverList.innerHTML = '';
  el.peerList.innerHTML = '';

  /* ---- 可连接 ---- */
  if (!s || !s.scanning) {
    el.discoverList.appendChild(h('div', { class: 'empty', text: '点「检测设备」开始扫描。' }));
  } else {
    const list = s.discoveredList;
    if (!list.length) {
      el.discoverList.appendChild(h('div', { class: 'empty', text: '扫描中… 还没发现设备。' }));
    } else {
      for (const d of list) {
        el.discoverList.appendChild(
          devRow({
            name: d.name,
            meta: `设备 ${d.id}`,
            sig: { cls: snrClass(d.snr), text: snrLabel(d.snr) },
            actions: [
              h('button', {
                class: 'primary',
                text: '连接',
                onclick: () => openPin(d.id, d.name),
              }),
            ],
          })
        );
      }
    }
  }

  /* ---- 已配对 ---- */
  const peers = peerList(LS);
  if (!peers.length) {
    el.peerList.appendChild(h('div', { class: 'empty', text: '还没有连接过任何设备。' }));
  } else {
    for (const p of peers) {
      const connected = s && s.paired && s.peerId === p.id;
      const actions = [
        h('button', {
          class: connected ? '' : 'ghost',
          text: connected ? '进入' : '查看',
          onclick: () => {
            showConversation(p.id);
            closeDevices();
          },
        }),
      ];
      actions.push(
        h('button', {
          class: 'ghost',
          text: '改名',
          onclick: () => {
            const nn = prompt(`把「${p.name}」改成：`, p.name);
            if (nn && nn.trim()) {
              renamePeer(LS, p.id, nn.trim());
              if (state.viewPeer === p.id) updateTitle();
              renderDevices();
            }
          },
        })
      );
      actions.push(
        h('button', {
          class: 'ghost',
          text: '删除',
          onclick: () => {
            if (!confirm(`删除「${p.name}」？该设备的聊天记录也会一起删掉。`)) return;
            forgetPeer(LS, p.id);
            clearPeerHistory(LS, p.id);
            if (state.viewPeer === p.id) showConversation(0);
            renderDevices();
          },
        })
      );
      el.peerList.appendChild(
        devRow({
          name: p.name,
          meta: connected ? '已连接' : `上次 ${fmtWhen(p.lastAt)}`,
          sig: connected ? { cls: 'strong', text: '在线' } : null,
          actions,
        })
      );
    }
  }

  el.scanHint.textContent = s && s.scanning ? '扫描中…' : '';
  el.btnScan.textContent = s && s.scanning ? '停止检测' : '检测设备';
  el.btnScan.classList.toggle('on', !!(s && s.scanning));
}

/**
 * 设备面板做成「内联视图」而不是全屏浮层：
 * 之前它 position:fixed 盖住整个屏幕，导致扫描时看不到电平表、也点不到「日志」，
 * 而排查「为什么发现不了对方」恰恰需要这两样东西。
 */
function openDevices() {
  renderDevices();
  el.devicePanel.classList.add('open');
  el.chat.classList.add('hidden');
  el.btnDevices.classList.add('on');
}
function closeDevices() {
  el.devicePanel.classList.remove('open');
  el.chat.classList.remove('hidden');
  el.btnDevices.classList.remove('on');
}
function toggleDevices() {
  if (el.devicePanel.classList.contains('open')) closeDevices();
  else openDevices();
}

/* ============================ PIN 弹窗 ============================ */

function openPin(peerId, name) {
  state.pinTarget = peerId;
  el.pinTitle.textContent = `连接「${name}」`;
  el.pinInput.value = '';
  el.pinError.textContent = '';
  el.pinModal.classList.remove('hidden');
  setTimeout(() => el.pinInput.focus(), 30);
}

function closePin() {
  el.pinModal.classList.add('hidden');
  state.pinTarget = 0;
}

function submitPin() {
  const pin = el.pinInput.value.trim();
  if (!/^\d{4}$/.test(pin)) {
    el.pinError.textContent = '请输入 4 位数字';
    return;
  }
  const r = state.session.connect(state.pinTarget, pin);
  if (!r.ok) {
    el.pinError.textContent =
      r.reason === 'not-found' ? '对方已不在列表里，请重新检测' : 'PIN 格式不对';
    return;
  }
  el.pinError.textContent = '正在连接…';
  el.btnPinOk.disabled = true;
}

/* ============================ 身份 ============================ */

function randomId() {
  return 1 + Math.floor(Math.random() * 254);
}

/**
 * 两层身份：
 *   sc.id       localStorage   持久身份，跨 tab / 跨会话稳定，会话记录按它归属
 *   sc.id.tab   sessionStorage 仅当本 tab 在 ID 撞车中"让位"时写入的临时覆盖
 *   sc.nonce    sessionStorage tab 级随机数，撞车裁决用（协议层比较 nonce，大的让位）
 */
function initIdentity() {
  let id = parseInt(SS.getItem('sc.id.tab') || '0', 10);
  if (!id || id < 1 || id > 254) id = parseInt(LS.getItem('sc.id') || '0', 10);
  if (!id || id < 1 || id > 254) {
    id = randomId();
    LS.setItem('sc.id', String(id));
  }
  state.myId = id;
  state.myName = LS.getItem('sc.name') || `设备${id}`;

  let nonce = parseInt(SS.getItem('sc.nonce') || '0', 10);
  if (!nonce) {
    nonce = (Math.random() * 0xffffffff) >>> 0;
    SS.setItem('sc.nonce', String(nonce));
  }
  state.nonce = nonce;
  el.meText.textContent = `我：${state.myName}`;
}

/* ============================ 音频 ============================ */

function normLevel() {
  const rx = state.rx;
  if (!rx) return 0;
  return rx.level / ((rx.winLen * rx.winLen) / 4);
}

async function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  state.ctx = new AC({ latencyHint: 'interactive' });
  if (state.ctx.state === 'suspended') await state.ctx.resume();

  // 必须关掉 AGC / 降噪 / 回声消除，否则浏览器会把我们的载波当噪声处理掉
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });

  const src = state.ctx.createMediaStreamSource(state.stream);
  const gain = state.ctx.createGain();
  gain.gain.value = MIC_GAIN;
  const proc = state.ctx.createScriptProcessor(4096, 1, 1);
  src.connect(gain);
  gain.connect(proc);
  proc.connect(state.ctx.destination); // 不接出去某些浏览器不回调
  proc.onaudioprocess = onAudio;
  return state.ctx.sampleRate;
}

function onAudio(e) {
  if (state.txActive || !state.rx || !state.session) return;
  const input = e.inputBuffer.getChannelData(0);
  const chunk = new Float32Array(input.length);
  chunk.set(input);
  const frames = state.rx.push(chunk);
  for (const f of frames) state.session.onFrame(f);

  state.session.setCarrierBusy(normLevel() > CARRIER_THRESHOLD);

  // 电平表用 dB 刻度：线性刻度下"能解出来但很弱"的信号只显示 0.1%，看起来像没收到。
  const raw = normLevel();
  const db = 10 * Math.log10(Math.max(1e-9, raw));
  const lv = Math.min(1, Math.max(0, (db + 60) / 60)); // -60dB → 0%，0dB → 100%
  el.meterFill.style.width = `${(lv * 100).toFixed(0)}%`;
  el.meterFill.style.background = raw >= DECODE_LEVEL ? 'var(--ok)' : 'var(--line)';
  if (raw > 0.95 && Date.now() - state.lastClipWarn > 8000) {
    state.lastClipWarn = Date.now();
    addLog('warn', '输入电平接近满幅，可能削波失真；同机双开时请把音量调小一些');
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
      if (state.rx) state.rx.reset(); // 丢掉自己发声期间录到的内容
      resolve();
    };
    node.start();
  });
}

/* ============================ 状态显示 ============================ */

const STATE_TEXT = {
  [STATE.IDLE]: '待机',
  [STATE.TX]: '正在发声…',
  [STATE.WAIT_ACK]: '等待对端确认…',
  [STATE.CONNECTING]: '正在连接…',
};

function setStatus(s, info = {}) {
  let text = STATE_TEXT[s] || s;
  if (info.connecting) text = `正在连接「${info.connecting}」…`;
  else if (info.paired) text = s === STATE.IDLE ? `已连接「${info.peer}」` : text;
  else if (info.scanning) text = '扫描中…';

  el.statusText.textContent = text;
  el.dot.className = 'dot';
  if (s === STATE.TX || s === STATE.WAIT_ACK) el.dot.classList.add('tx');
  else if (info.paired) el.dot.classList.add('on');
  else if (info.broadcasting) el.dot.classList.add('tx');

  el.peerText.textContent = info.paired ? `已连接：${info.peer}` : '未连接';

  // 广播横幅
  if (info.broadcasting && typeof info.pin === 'number') {
    el.bcastBar.classList.remove('hidden');
    el.pinText.textContent = state.session.pad4(info.pin);
    el.btnBroadcast.classList.add('on');
    el.btnBroadcast.textContent = '广播中';
  } else {
    el.bcastBar.classList.add('hidden');
    el.btnBroadcast.classList.remove('on');
    el.btnBroadcast.textContent = '广播';
  }

  renderDevices();
  updateSendState();
}

/* ============================ 启动 ============================ */

function buildProfileSelect() {
  el.profile.innerHTML = '';
  for (const key of Object.keys(PROFILES)) {
    el.profile.appendChild(h('option', { value: key, text: `${PROFILES[key].label}档` }));
  }
  el.profile.value = state.profileKey;
  updateRateText();
}

function updateRateText() {
  const p = PROFILES[state.profileKey];
  const fs = state.ctx ? state.ctx.sampleRate : 48000;
  const dur = frameDuration(p, buildFrame({ type: FRAME.MSG, payload: new Uint8Array(60) }));
  // 带上档位名：两台设备一眼比对，不用记「21.3ms = 稳健」这种对应关系
  el.rateText.textContent = `${p.label}档 · ${p.symbolMs.toFixed(1)}ms/符号 · 60字节约 ${dur.toFixed(1)}s`;
}

async function boot() {
  const fs = await startAudio();
  state.rx = new AcousticReceiver(PROFILES[state.profileKey], fs);
  updateRateText();
  addLog('ok', `音频就绪：${fs}Hz，本机 id=${state.myId} 昵称=${state.myName}`);

  state.session = new ChatSession({
    myId: state.myId,
    myName: state.myName,
    nonce: state.nonce,
    transmit,
    opts: {},
    onLog: (e) => addLog(e.level, e.text),
    onStatus: setStatus,
    onDiscover: () => renderDevices(),
    onPin: () => {},
    onPeer: (p) => {
      rememberPeer(LS, p.id, p.name);
      showConversation(p.id);
      addMsg('sys', `已与「${p.name}」建立声波连接`, '', 0);
      renderDevices();
      updateTitle();
    },
    onConnectResult: (r) => {
      if (r.ok) {
        el.pinError.textContent = '';
        closePin();
        el.btnPinOk.disabled = false;
      } else if (r.reason === 'pin-wrong') {
        el.btnPinOk.disabled = false;
        el.pinError.textContent = '数字不对，请重新输入';
        el.pinInput.value = '';
        el.pinInput.focus();
        return; // 弹窗留着让用户重输
      } else if (r.reason === 'peer-left') {
        addMsg('err', '对方已断开连接', '', 0);
      } else if (r.reason === 'no-ack') {
        addMsg('err', '对方没有确认，这一条可能没送达（可以再发一次）', '', 0);
      } else {
        el.btnPinOk.disabled = false;
        el.pinError.textContent =
          r.reason === 'timeout'
            ? '连接超时：对方可能已停止广播，或距离太远'
            : r.reason === 'not-broadcasting'
              ? '对方已停止广播'
              : '连接被拒绝';
      }
      renderDevices();
    },
    onMessage: (m) => {
      const meta = `${peerNameOf(m.from)} · ${fmtTime(m.at)}`;
      if (state.viewPeer === m.from) renderMsg('peer', m.text, meta);
      else addLog('info', `收到来自「${m.fromName}」的消息（当前未打开该会话）`);
      appendHistory(LS, m.from, { k: 'peer', t: m.text, m: meta, a: m.at });
      rememberPeer(LS, m.from, m.fromName);
    },
    onIdCollision: () => {
      // 协议层已裁决：走到这里说明本 tab nonce 更大，由本 tab 让位
      const old = state.myId;
      let id = randomId();
      while (id === old) id = randomId();
      state.myId = id;
      state.myName = `设备${id}`;
      SS.setItem('sc.id.tab', String(id));
      el.meText.textContent = `我：${state.myName}`;
      state.session.myId = id;
      addLog('warn', `设备 ID 与另一个窗口撞车，本 tab 临时改用「${state.myName}」（持久身份仍是设备${old}）`);
      addMsg('sys', `检测到另一个窗口也叫「设备${old}」，本窗口临时改名为「${state.myName}」`, '', 0);
      state.session.startBroadcast();
    },
  });

  state.session.start();
  el.overlay.classList.add('hidden'); // 注意是 .hidden；v2 重写时误写成 .hide（无对应 CSS 规则），遮罩永远盖着
  showConversation(0);
  addLog('info', '已进入静默监听状态，不会自动发声。');
  renderDevices();
}

/* ============================ 自检 / 导出 ============================ */

function selfTest() {
  const p = PROFILES[state.profileKey];
  const fs = state.ctx ? state.ctx.sampleRate : 48000;
  el.selfTestResult.className = '';
  el.selfTestResult.textContent = '自检中…';
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
  const detail = ok
    ? `✓ 自检通过 · ${p.label}档 · ${wav.length} 采样 · 解码 ${ms}ms`
    : `✗ 自检失败 · ${p.label}档 · 解出 ${out.length} 帧（应为 1 帧），请点「日志」看细节`;
  el.selfTestResult.className = ok ? 'ok' : 'err';
  el.selfTestResult.textContent = detail;
  addLog(ok ? 'ok' : 'error', `自检 ${ok ? '通过' : '失败'}：${p.label}档，解码耗时 ${ms}ms`);
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
  for (let i = 0; i < wav.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, wav[i])) * 32767, true);
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'soundchat.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  addLog('ok', `已导出 ${a.download}（${(wav.length / fs).toFixed(2)}s）`);
}

/* ============================ 事件 ============================ */

function doSend() {
  const text = el.text.value.trim();
  if (!text) return;
  if (!state.session || !state.session.paired) {
    addMsg('err', '还没有连接设备', '', 0);
    return;
  }
  const r = state.session.say(text);
  if (!r.ok) {
    addMsg('err', r.reason === 'too-long' ? '文字太长了，请分段发送' : '不能发送空消息', '', 0);
    return;
  }
  addMsg('me', text, `我 · ${fmtTime(Date.now())}${r.chunks > 1 ? ` · 分 ${r.chunks} 帧` : ''}`, state.session.peerId);
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

el.btnDevices.addEventListener('click', toggleDevices);
el.btnCloseDevices.addEventListener('click', closeDevices);

el.btnScan.addEventListener('click', () => {
  if (!state.session) return;
  if (state.session.scanning) state.session.stopScan();
  else state.session.startScan();
  renderDevices();
});

el.btnBroadcast.addEventListener('click', () => {
  if (!state.session) {
    addMsg('err', '请先点「开始使用」', '', 0);
    return;
  }
  if (state.session.broadcasting) state.session.stopBroadcast('user');
  else state.session.startBroadcast();
});

el.btnStopBcast.addEventListener('click', () => state.session && state.session.stopBroadcast('user'));

el.btnLog.addEventListener('click', () => el.logPanel.classList.toggle('show'));
el.btnSelfTest.addEventListener('click', selfTest);
el.btnWav.addEventListener('click', exportWav);

el.btnClearAll.addEventListener('click', () => {
  if (!confirm('清空本机保存的全部聊天记录？\n（只影响这台设备的浏览器，不影响对方）')) return;
  clearAllHistory(LS);
  showConversation(state.session && state.session.paired ? state.session.peerId : 0);
  renderDevices();
  addLog('info', '已清空全部聊天记录');
});

el.btnPinCancel.addEventListener('click', () => {
  el.btnPinOk.disabled = false;
  closePin();
});
el.btnPinOk.addEventListener('click', submitPin);
el.pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPin();
});
el.pinInput.addEventListener('input', () => {
  el.pinInput.value = el.pinInput.value.replace(/\D/g, '').slice(0, 4);
});

el.profile.addEventListener('change', () => {
  state.profileKey = el.profile.value;
  LS.setItem('sc.profile', state.profileKey);
  const fs = state.ctx ? state.ctx.sampleRate : 48000;
  if (state.rx) state.rx = new AcousticReceiver(PROFILES[state.profileKey], fs);
  updateRateText();
  addLog('info', `切换到 ${PROFILES[state.profileKey].label}档（两端必须用同一档位）`);
});

/* ============================ 初始化 ============================ */

state.profileKey = LS.getItem('sc.profile') || DEFAULT_PROFILE;
initIdentity();
buildProfileSelect();

window.__soundchat = state;

// 自动化验证入口：?selftest=1 自动跑一次自检并把结果写进 DOM（供无头浏览器冒烟）
if (new URLSearchParams(location.search).has('selftest')) {
  setTimeout(() => {
    try {
      selfTest();
      const d = document.createElement('div');
      d.id = 'selftest-result';
      d.textContent = el.selfTestResult.textContent || 'no-result';
      document.body.appendChild(d);
    } catch (e) {
      const d = document.createElement('div');
      d.id = 'selftest-result';
      d.textContent = 'THREW: ' + e.message;
      document.body.appendChild(d);
    }
  }, 60);
}
