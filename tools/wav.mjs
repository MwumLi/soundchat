/**
 * wav.mjs — 极简 WAV 读写（16bit PCM 单声道），零依赖。
 * 用于离线生成/解析声波文件，方便在没有第二台设备时验证链路。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** Float32Array[-1,1] -> WAV Buffer（16bit PCM 单声道） */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** WAV Buffer -> { samples: Float32Array, sampleRate }，支持 8/16/32bit PCM 与 32bit float */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是合法的 WAV 文件');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');

  const { format, channels, bits } = fmt;
  const bytesPer = bits / 8;
  const frames = Math.floor(data.length / (bytesPer * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const off = i * bytesPer * channels;
    let v;
    if (format === 3 && bits === 32) v = data.readFloatLE(off);
    else if (bits === 16) v = data.readInt16LE(off) / 32768;
    else if (bits === 8) v = (data.readUInt8(off) - 128) / 128;
    else if (bits === 32) v = data.readInt32LE(off) / 2147483648;
    else throw new Error(`不支持的位深: ${bits}`);
    out[i] = v;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

export function writeWavFile(path, samples, sampleRate) {
  writeFileSync(path, encodeWav(samples, sampleRate));
}

export function readWavFile(path) {
  return decodeWav(readFileSync(path));
}
