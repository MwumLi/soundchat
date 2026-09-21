#!/usr/bin/env node
/**
 * cli.mjs — 声波调制解调器的命令行工具（零依赖）
 *
 *   node tools/cli.mjs loopback "你好"            # 内存回环自检：编码→解码
 *   node tools/cli.mjs encode "你好" out.wav      # 生成可播放的声波 WAV
 *   node tools/cli.mjs decode in.wav              # 解码一段录音/WAV
 *   node tools/cli.mjs decode in.wav --dump       # 附带逐符号诊断
 *
 * 没有第二台设备时，用 encode 生成 wav → 手机/电脑外放 → decode 另一段录音，
 * 就能验证真实声学链路。
 */

import {
  PROFILES,
  FRAME,
  DEFAULT_PROFILE,
  buildFrame,
  modulate,
  AcousticReceiver,
  textToBytes,
  bytesToText,
  frameDuration,
  samplesPerSymbol,
  MAX_PAYLOAD,
} from '../src/modem.js';
import { writeWavFile, readWavFile } from './wav.mjs';

const FS = 48000;

function usage() {
  console.log(`声波调制解调器 CLI

用法:
  node tools/cli.mjs loopback <文本> [档位]        内存回环自检
  node tools/cli.mjs encode <文本> <out.wav> [档位]  生成声波 WAV
  node tools/cli.mjs decode <in.wav> [档位]          解码 WAV

档位: robust(默认) | fast
`);
}

function makeFrame(text, profile) {
  const payload = textToBytes(text);
  if (payload.length > MAX_PAYLOAD) {
    console.error(`文本过长: ${payload.length} > ${MAX_PAYLOAD} 字节（中文约 ${Math.floor(MAX_PAYLOAD / 3)} 字）`);
    process.exit(2);
  }
  return buildFrame({ type: FRAME.MSG, seq: 1, src: 0x01, dst: 0x02, payload });
}

function getProfile(name) {
  const p = PROFILES[name || DEFAULT_PROFILE];
  if (!p) {
    console.error(`未知档位: ${name}`);
    process.exit(2);
  }
  return p;
}

/** 全量喂入并收集帧 */
function feed(samples, sampleRate, profile, chunk = 960) {
  const rx = new AcousticReceiver(profile, sampleRate);
  const frames = [];
  for (let i = 0; i < samples.length; i += chunk) {
    const got = rx.push(samples.subarray(i, Math.min(i + chunk, samples.length)));
    for (const f of got) frames.push(f);
  }
  for (const f of rx.flush()) frames.push(f);
  return { frames, rx };
}

function report(frames, profile, payloadBytes, wallMs) {
  const sps = samplesPerSymbol(profile, FS);
  console.log(`  档位      ${profile.label}（符号 ${profile.symbolMs.toFixed(2)}ms / ${sps} 采样，音间隔 ${profile.toneSpacing}Hz）`);
  console.log(`  空中时长  ${frameDuration(profile, buildFrame({ type: FRAME.MSG, payload: new Uint8Array(payloadBytes) })).toFixed(2)} s`);
  console.log(`  有效吞吐  ${(payloadBytes / frameDuration(profile, buildFrame({ type: FRAME.MSG, payload: new Uint8Array(payloadBytes) }))).toFixed(1)} B/s`);
  console.log(`  解码耗时  ${wallMs} ms`);
  for (const f of frames) {
    console.log(`  帧        type=${f.type} seq=${f.seq} src=${f.src} dst=${f.dst} ${f.payload.length}B SNR≈${f.snr.toFixed(1)}dB 周期≈${f.sps.toFixed(1)}`);
    console.log(`  正文      ${JSON.stringify(bytesToText(f.payload))}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '-h' || cmd === '--help') {
  usage();
  process.exit(0);
}

if (cmd === 'loopback') {
  const text = rest[0];
  const profile = getProfile(rest[1]);
  if (!text) {
    usage();
    process.exit(2);
  }
  const fb = makeFrame(text, profile);
  const wav = modulate(fb, profile, FS);
  const t0 = Date.now();
  const { frames } = feed(wav, FS, profile);
  const ms = Date.now() - t0;
  console.log(`回环自检：${JSON.stringify(text)}（${fb.length} 字节帧，${wav.length} 采样）`);
  report(frames, profile, textToBytes(text).length, ms);
  const ok = frames.length === 1 && bytesToText(frames[0].payload) === text;
  console.log(ok ? '\n\x1b[32m✓ 回环成功\x1b[0m' : '\n\x1b[31m✗ 回环失败\x1b[0m');
  process.exit(ok ? 0 : 1);
} else if (cmd === 'encode') {
  const [text, out, profileName] = rest;
  const profile = getProfile(profileName);
  if (!text || !out) {
    usage();
    process.exit(2);
  }
  const fb = makeFrame(text, profile);
  const wav = modulate(fb, profile, FS);
  writeWavFile(out, wav, FS);
  console.log(`已写出 ${out}`);
  console.log(`  档位 ${profile.label}，${fb.length} 字节帧，${wav.length} 采样 = ${(wav.length / FS).toFixed(2)} s`);
  console.log(`  播放: afplay ${out}   （macOS）`);
} else if (cmd === 'decode') {
  const [file, profileName] = rest;
  const profile = getProfile(profileName);
  if (!file) {
    usage();
    process.exit(2);
  }
  const { samples, sampleRate } = readWavFile(file);
  console.log(`读入 ${file}：${samples.length} 采样 @ ${sampleRate}Hz = ${(samples.length / sampleRate).toFixed(2)} s`);
  const t0 = Date.now();
  const { frames } = feed(samples, sampleRate, profile);
  const ms = Date.now() - t0;
  if (!frames.length) {
    console.log('\n\x1b[31m未解出任何帧\x1b[0m（可尝试换成另一个档位，或确认录音未被系统降噪/AGC 处理）');
    process.exit(1);
  }
  report(frames, profile, frames[0].payload.length, ms);
} else {
  usage();
  process.exit(2);
}
