/**
 * modem.test.mjs — 声波调制解调器单测
 *
 * 用纯 JS 仿真信道，验证四类场景：
 *   1. 理想回环（数字链路本身正确）
 *   2. 白噪声（抗噪能力 / 门限标定）
 *   3. 采样率偏移（44.1k ↔ 48k，模拟收发两端时钟不一致）
 *   4. 多径回声（模拟室内混响）
 *
 * 运行：node test/modem.test.mjs
 */

import {
  PROFILES,
  FRAME,
  buildFrame,
  parseFrame,
  modulate,
  AcousticReceiver,
  textToBytes,
  bytesToText,
  effectiveByteRate,
  samplesPerSymbol,
  frameDuration,
} from '../src/modem.js';

/* ============================ 微型断言框架 ============================ */

let nPass = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

function check(name, cond, extra = '') {
  if (cond) {
    nPass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push(`${currentGroup} / ${name}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  }
}

/* ============================ 信道仿真 ============================ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 高斯白噪声，按整段信号功率定 SNR */
function awgn(x, snrDb, rng) {
  let sp = 0;
  for (let i = 0; i < x.length; i++) sp += x[i] * x[i];
  sp /= x.length;
  const sigma = Math.sqrt(sp / Math.pow(10, snrDb / 10));
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    // Box-Muller
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    y[i] = x[i] + sigma * g;
  }
  return y;
}

/** 多径：taps = [[delaySamples, gain], ...] */
function multipath(x, taps) {
  const maxD = Math.max(...taps.map((t) => t[0]));
  const y = new Float32Array(x.length + maxD);
  for (const [d, g] of taps) {
    for (let i = 0; i < x.length; i++) y[i + d] += x[i] * g;
  }
  return y;
}

/** 线性插值重采样，ratio = 输出长度 / 输入长度 */
function resample(x, ratio) {
  const n = Math.floor(x.length * ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i / ratio;
    const i0 = Math.floor(s);
    const f = s - i0;
    const a = x[i0] ?? 0;
    const b = x[i0 + 1] ?? a;
    y[i] = a * (1 - f) + b * f;
  }
  return y;
}

/** 加淡入淡出，避免重采样边界突变 */
function withGuard(x, fs) {
  const pad = Math.round(0.05 * fs);
  const y = new Float32Array(x.length + pad * 2);
  y.set(x, pad);
  return y;
}

/* ============================ 收发一条 ============================ */

function roundTrip({
  profile,
  fsTx = 48000,
  fsRx = 48000,
  payload,
  snrDb = Infinity,
  taps = null,
  chunk = 960,
  threshold,
  energyGate,
  seed = 12345,
}) {
  const frameBytes = buildFrame({ type: FRAME.MSG, seq: 7, src: 0x11, dst: 0x22, payload });
  let wav = modulate(frameBytes, profile, fsTx);
  wav = withGuard(wav, fsTx);
  if (taps) wav = multipath(wav, taps);
  if (fsRx !== fsTx) wav = resample(wav, fsRx / fsTx);
  if (Number.isFinite(snrDb)) wav = awgn(wav, snrDb, mulberry32(seed));

  const rx = new AcousticReceiver(profile, fsRx, {
    threshold: threshold ?? 0.42,
    energyGate: energyGate ?? 3000,
  });
  const frames = [];
  for (let i = 0; i < wav.length; i += chunk) {
    const got = rx.push(wav.subarray(i, Math.min(i + chunk, wav.length)));
    for (const f of got) frames.push(f);
  }
  return { frames, frameBytes, wav, samples: wav.length };
}

/** 随机字节载荷 */
function randomPayload(n, seed) {
  const rng = mulberry32(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
  return b;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ============================ 1. 理想回环 ============================ */

group('1. 理想回环（无噪声、同采样率）');

for (const key of ['robust', 'fast']) {
  const p = PROFILES[key];
  for (const n of [1, 10, 50, 200]) {
    const payload = randomPayload(n, 1000 + n);
    const r = roundTrip({ profile: p, payload });
    const ok = r.frames.length === 1 && sameBytes(r.frames[0].payload, payload);
    check(
      `${p.label}档 ${String(n).padStart(3)} 字节`,
      ok,
      ok ? `解出 1 帧, SNR≈${r.frames[0].snr.toFixed(1)}dB` : `解出 ${r.frames.length} 帧`
    );
  }
}

// 中文文本往返
{
  const text = '你好，这是一条声波消息。';
  const payload = textToBytes(text);
  const r = roundTrip({ profile: PROFILES.robust, payload });
  const got = r.frames.length === 1 ? bytesToText(r.frames[0].payload) : '';
  check('UTF-8 中文往返', got === text, got ? `"${got}"` : '未解出');
}

// 帧字段完整性
{
  const payload = textToBytes('field check');
  const r = roundTrip({ profile: PROFILES.robust, payload });
  const f = r.frames[0];
  const ok = f && f.type === FRAME.MSG && f.seq === 7 && f.src === 0x11 && f.dst === 0x22 && f.version === 1;
  check('帧头字段完整（type/seq/src/dst/ver）', ok, ok ? '' : JSON.stringify(f && { t: f.type, s: f.seq, a: f.src, b: f.dst }));
}

/* ============================ 2. 白噪声 ============================ */

group('2. 白噪声（加性高斯噪声，同采样率）');

for (const key of ['robust', 'fast']) {
  const p = PROFILES[key];
  for (const snr of [20, 15, 10, 6, 3]) {
    const payload = textToBytes('noise test 噪声测试');
    const r = roundTrip({ profile: p, payload, snrDb: snr });
    const ok = r.frames.length === 1 && sameBytes(r.frames[0].payload, payload);
    check(`${p.label}档 SNR ${String(snr).padStart(2)} dB`, ok, ok ? '' : '解码失败');
  }
}

/* ============================ 3. 采样率偏移 ============================ */

group('3. 采样率偏移（收发时钟不一致）');

for (const key of ['robust', 'fast']) {
  const p = PROFILES[key];
  for (const [tx, rx] of [
    [44100, 48000],
    [48000, 44100],
    [44100, 44100],
  ]) {
    const payload = textToBytes(`rate ${tx}->${rx}`);
    const r = roundTrip({ profile: p, payload, fsTx: tx, fsRx: rx });
    const ok = r.frames.length === 1 && sameBytes(r.frames[0].payload, payload);
    const dev = ((r.frames[0]?.sps ?? 0) / ((p.symbolMs * rx) / 1000) - 1) * 100;
    check(
      `${p.label}档 ${tx} → ${rx}`,
      ok,
      ok ? `估计周期偏差 ${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%` : '解码失败'
    );
  }
}

/* ============================ 4. 多径回声 ============================ */

group('4. 多径回声（模拟室内混响）');

const MULTIPATH_CASES = [
  { label: '5ms 单次回声 0.6', taps: [[0, 1.0], [240, 0.6]] },
  { label: '15ms 单次回声 0.7', taps: [[0, 1.0], [720, 0.7]] },
  { label: '30ms 单次回声 0.5', taps: [[0, 1.0], [1440, 0.5]] },
  { label: '三重回声 (3/9/21ms)', taps: [[0, 1.0], [144, 0.7], [432, 0.5], [1008, 0.35]] },
];

for (const key of ['robust', 'fast']) {
  const p = PROFILES[key];
  for (const mc of MULTIPATH_CASES) {
    const payload = textToBytes('reverb test 混响');
    const r = roundTrip({ profile: p, payload, taps: mc.taps });
    const ok = r.frames.length === 1 && sameBytes(r.frames[0].payload, payload);
    check(`${p.label}档 ${mc.label}`, ok, ok ? '' : '解码失败');
  }
}

/* ============================ 5. 综合压力 ============================ */

group('5. 综合压力（噪声 + 采样率偏移 + 多径，20 次随机）');

{
  let ok = 0;
  const total = 20;
  for (let i = 0; i < total; i++) {
    const payload = randomPayload(40 + (i % 5) * 20, 9000 + i);
    const r = roundTrip({
      profile: PROFILES.robust,
      payload,
      fsTx: 44100,
      fsRx: 48000,
      snrDb: 15,
      taps: [[0, 1.0], [300, 0.6], [900, 0.35]],
      seed: 500 + i,
    });
    if (r.frames.length === 1 && sameBytes(r.frames[0].payload, payload)) ok++;
  }
  check(`稳健档通过率 ${ok}/${total}`, ok >= 18, ok < 18 ? '低于 90%' : '');
}

/* ============================ 6. 流结束 flush ============================ */

group('6. 流结束 flush（帧尾无尾随静音，必须靠 flush 收尾）');

for (const key of ['robust', 'fast']) {
  const p = PROFILES[key];
  for (const text of ['短', '这是一条没有尾随静音的消息']) {
    const payload = textToBytes(text);
    const fb = buildFrame({ type: FRAME.MSG, seq: 3, src: 1, dst: 2, payload });
    const wav = modulate(fb, p, 48000); // 注意：不加任何 padding
    const rx = new AcousticReceiver(p, 48000);
    const frames = [];
    for (let i = 0; i < wav.length; i += 960) {
      for (const f of rx.push(wav.subarray(i, Math.min(i + 960, wav.length)))) frames.push(f);
    }
    for (const f of rx.flush()) frames.push(f);
    const ok = frames.length === 1 && bytesToText(frames[0].payload) === text;
    check(`${p.label}档 "${text}"`, ok, ok ? '' : `解出 ${frames.length} 帧`);
  }
}

/* ============================ 7. 性能指标 ============================ */

group('6. 性能指标');

for (const key of ['robust', 'fast']) {
  const p = PROFILES[key];
  const sps48 = samplesPerSymbol(p, 48000);
  const sps441 = samplesPerSymbol(p, 44100);
  const raw = (Math.log2(p.nTones) / p.symbolMs) * 1000;
  const rate = effectiveByteRate(p, 60);
  const dur = frameDuration(p, buildFrame({ type: FRAME.MSG, payload: new Uint8Array(60) }));
  console.log(
    `  ${p.label}档: 符号 ${p.symbolMs.toFixed(2)}ms (${sps48}@48k / ${sps441}@44.1k), ` +
      `原始 ${raw.toFixed(0)} bit/s, 60B 帧 ${dur.toFixed(2)}s, 有效 ${rate.toFixed(1)} B/s`
  );
  console.log(`         音阶 ${p.toneBase}..${p.toneBase + (p.nTones - 1) * p.toneSpacing} Hz, 间隔 ${p.toneSpacing} Hz`);
}

/* ============================ 汇总 ============================ */

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m全部通过：${nPass} 项\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m失败 ${failures.length} 项 / 通过 ${nPass} 项\x1b[0m`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
