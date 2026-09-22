/**
 * protocol.test.mjs — 会话层 v2 端到端测试
 *
 * 用「虚拟时钟 + 内存声学信道」把两个 ChatSession 接起来：
 *   发送 → 真实 modulate 成波形 → 送到对端 AcousticReceiver 解调 → 对端 onFrame
 * 因此验证的是「调制解调 + 广播/扫描/连接 + ARQ + 重组」的完整闭环，且不依赖真实时间。
 *
 * 运行：node test/protocol.test.mjs
 */

import {
  PROFILES,
  modulate,
  AcousticReceiver,
  FRAME,
  buildFrame,
  parseFrame,
  textToBytes,
  bytesToText,
} from '../src/modem.js';
import { ChatSession, STATE, MAX_TEXT_BYTES, REJECT } from '../src/protocol.js';

const FS = 48000;
const PROFILE = PROFILES.robust;

/* ============================ 虚拟时钟 ============================ */

class Clock {
  constructor() {
    this.now = 0;
    this.q = [];
    this.id = 0;
  }
  setTimeout(fn, ms) {
    const id = ++this.id;
    this.q.push({ id, at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id) {
    this.q = this.q.filter((t) => t.id !== id);
  }
  async settle(rounds = 12) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
  }
  /**
   * 推进到 now+ms。
   * 关键：必须先排空微任务再推进时间——发送是 Promise 链串行化的，
   * 新定时器往往在微任务里才排进来；若先把 now 跳到 target，新定时器就落在窗口外。
   */
  async advance(ms) {
    await this.settle();
    const target = this.now + ms;
    for (let guard = 0; guard < 300000; guard++) {
      let due = null;
      for (const t of this.q) if (t.at <= target && (!due || t.at < due.at)) due = t;
      if (due) {
        this.q = this.q.filter((t) => t !== due);
        this.now = Math.max(this.now, due.at);
        due.fn();
        await this.settle(6);
        continue;
      }
      this.now = target;
      await this.settle();
      let again = null;
      for (const t of this.q) if (t.at <= target && (!again || t.at < again.at)) again = t;
      if (!again) break;
    }
    await this.settle();
  }
}

/* ============================ 内存声学信道 ============================ */

function makeChannel(clock, stats, shouldDrop) {
  const peers = { a: null, b: null };
  let txCount = 0;

  const transmit = (from, to) => async (bytes) => {
    const wav = modulate(bytes, PROFILE, FS);
    const durMs = (wav.length / FS) * 1000;
    stats[`tx${from.toUpperCase()}`]++;
    stats.sent[from].push({ type: bytes[0] & 0x0f, len: bytes.length, at: clock.now });
    const n = ++txCount;
    const drop = shouldDrop ? shouldDrop(bytes, n, from) : false;
    if (drop) stats.dropped++;
    // 声波是广播信道：任何人发声期间整条信道都算被占用
    const markBusy = (v) => {
      if (peers.a?.session) peers.a.session.setCarrierBusy(v);
      if (peers.b?.session) peers.b.session.setCarrierBusy(v);
    };
    await new Promise((resolve) => {
      markBusy(true);
      clock.setTimeout(() => {
        markBusy(false);
        if (!drop && peers[to]) {
          const rx = peers[to].rx;
          const got = [];
          for (let i = 0; i < wav.length; i += 960) {
            for (const f of rx.push(wav.subarray(i, Math.min(i + 960, wav.length)))) got.push(f);
          }
          for (const f of rx.flush()) got.push(f);
          for (const f of got) peers[to].session.onFrame(f);
        }
        resolve();
      }, Math.ceil(durMs));
    });
  };
  return { peers, transmit };
}

/* ============================ 断言框架 ============================ */

let nPass = 0;
const failures = [];
let groupName = '';
function group(n) {
  groupName = n;
  console.log(`\n\x1b[1m── ${n}\x1b[0m`);
}
function check(name, cond, extra = '') {
  if (cond) {
    nPass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push(`${groupName} / ${name}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  }
}

/* ============================ 装配一对会话 ============================ */

function setupPair({
  shouldDrop,
  opts,
  randA = () => 0.3,
  randB = () => 0.3,
  idA = 1,
  idB = 2,
  nameA = '甲',
  nameB = '乙',
  nonceA,
  nonceB,
} = {}) {
  const clock = new Clock();
  const stats = { txA: 0, txB: 0, dropped: 0, sent: { a: [], b: [] } };
  const ch = makeChannel(clock, stats, shouldDrop);
  const logs = { a: [], b: [] };
  const inbox = { a: [], b: [] };
  const pins = { a: null, b: null };
  const connects = { a: [], b: [] };

  const a = { rx: new AcousticReceiver(PROFILE, FS), session: null };
  const b = { rx: new AcousticReceiver(PROFILE, FS), session: null };
  ch.peers.a = a;
  ch.peers.b = b;

  const mk = (side, obj, id, name, txTo, rand, nonce) =>
    new ChatSession({
      myId: id,
      myName: name,
      nonce,
      transmit: ch.transmit(side, txTo),
      timers: clock,
      now: () => clock.now,
      rand,
      opts,
      onMessage: (m) => inbox[side].push(m),
      onLog: (e) => logs[side].push(e),
      onPin: (p) => (pins[side] = p),
      onConnectResult: (r) => connects[side].push(r),
    });

  a.session = mk('a', a, idA, nameA, 'b', randA, nonceA);
  b.session = mk('b', b, idB, nameB, 'a', randB, nonceB);
  return { clock, stats, a, b, inbox, logs, pins, connects };
}

/* ============================ 1. 默认静默 ============================ */

group('1. 默认静默：「开始使用」不发声');

{
  const { clock, stats, a, b } = setupPair();
  a.session.start();
  b.session.start();
  await clock.advance(30000);
  check('A 一声没发', stats.txA === 0, `txA=${stats.txA}`);
  check('B 一声没发', stats.txB === 0, `txB=${stats.txB}`);
  check('状态为空闲', a.session.state === STATE.IDLE && b.session.state === STATE.IDLE);
}

/* ============================ 2. 扫描开关 ============================ */

group('2. 扫描开关：没点「检测设备」就不显示');

{
  const { clock, stats, a, b } = setupPair();
  a.session.start();
  b.session.start();
  a.session.startBroadcast();

  await clock.advance(12000);
  check('A 确实在广播', stats.txA >= 2, `广播 ${stats.txA} 次`);
  check('B 未扫描 → 列表为空', b.session.discovered.size === 0, `列表 ${b.session.discovered.size} 项`);

  b.session.startScan();
  await clock.advance(12000);
  check('B 开始扫描 → 发现 A', b.session.discovered.size === 1, `列表 ${b.session.discovered.size} 项`);
  const dev = b.session.discovered.get(1);
  check('发现项带昵称', dev && dev.name === '甲', dev && dev.name);
  check('发现项带信号强度', dev && typeof dev.snr === 'number', dev && `snr=${dev.snr?.toFixed(1)}`);
}

/* ============================ 3. 广播节奏 ============================ */

group('3. 广播节奏：周期性发声 + 静默窗口');

{
  const { clock, stats, a } = setupPair();
  a.session.start();
  a.session.startBroadcast();
  await clock.advance(20000);
  const times = stats.sent.a.map((x) => x.at);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const avg = gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : 0;
  check('持续广播（20 秒内 >= 3 次）', times.length >= 3, `共 ${times.length} 次`);
  check('间隔约等于 发声时长 + 静默 2.8s', avg > 3000 && avg < 4500, `平均间隔 ${Math.round(avg)}ms`);
  check('PIN 已生成', typeof a.session.pin === 'number' && a.session.pin >= 0 && a.session.pin <= 9999, `PIN=${a.session.pad4(a.session.pin)}`);
}

/* ============================ 4. 连接成功 ============================ */

group('4. 连接：PIN 正确 → 双方配对');

{
  const { clock, a, b, pins, connects } = setupPair();
  a.session.start();
  b.session.start();
  a.session.startBroadcast();
  b.session.startScan();

  await clock.advance(6000);
  check('B 发现 A', b.session.discovered.size === 1);
  const pin = a.session.pin;
  check('A 屏幕上有 PIN', typeof pin === 'number', `PIN=${a.session.pad4(pin)}`);

  const r = b.session.connect(1, pin);
  check('发起连接成功', r.ok);
  await clock.advance(30000);

  check('B 侧配对成功', b.session.paired && b.session.peerId === 1, `peer=${b.session.peerName}`);
  check('A 侧配对成功', a.session.paired && a.session.peerId === 2, `peer=${a.session.peerName}`);
  check('B 收到成功回调', connects.b.some((c) => c.ok), JSON.stringify(connects.b));
  check('连接成功后停止广播', a.session.broadcasting === false);
  check('PIN 已作废', a.session.pin === null);
  check('未收到过拒绝', !connects.b.some((c) => !c.ok));
}

/* ============================ 5. PIN 错误 ============================ */

group('5. PIN 错误：拒绝 + 累计 3 次后停止广播');

{
  const { clock, a, b, connects } = setupPair();
  a.session.start();
  a.session.startBroadcast();
  await clock.advance(3000);
  const realPin = a.session.pin;
  const wrong = (realPin + 1) % 10000;

  const r = b.session.connect(1, wrong);
  check('PIN 格式合法但内容错误', !r.ok && r.reason === 'not-found', '（B 没扫描，所以先发现不了）');

  // 直接构造连接请求帧发给 A，做白盒验证
  const mkReq = (pin) => {
    const name = textToBytes('乙');
    const p = new Uint8Array(3 + name.length);
    p[0] = (pin >> 8) & 0xff;
    p[1] = pin & 0xff;
    p[2] = name.length;
    p.set(name, 3);
    return buildFrame({ type: FRAME.CONNECT_REQ, seq: 1, src: 2, dst: 1, payload: p });
  };

  a.session.onFrame(parseFrame(mkReq(wrong)));
  await clock.advance(3000);
  check('第 1 次错：仍在广播', a.session.broadcasting === true, `pinErrors=${a.session.pinErrors}`);

  a.session.onFrame(parseFrame(mkReq(wrong)));
  await clock.advance(3000);
  check('第 2 次错：仍在广播', a.session.broadcasting === true, `pinErrors=${a.session.pinErrors}`);

  a.session.onFrame(parseFrame(mkReq(wrong)));
  await clock.advance(3000);
  check('第 3 次错：已自动停止广播', a.session.broadcasting === false, `pinErrors=${a.session.pinErrors}`);
  check('停止后 PIN 作废', a.session.pin === null);
  check('未配对（防住了穷举）', a.session.paired === false);
}

/* ============================ 6. 未广播时收到请求 ============================ */

group('6. 未广播时收到连接请求 → 拒绝');

{
  const { clock, stats, a, logs } = setupPair();
  a.session.start();
  check('启动后没在广播', a.session.broadcasting === false);

  const name = textToBytes('乙');
  const p = new Uint8Array(3 + name.length);
  p[0] = 0;
  p[1] = 5; // 随便一个 PIN
  p[2] = name.length;
  p.set(name, 3);
  const beforeTx = stats.txA;
  a.session.onFrame(parseFrame(buildFrame({ type: FRAME.CONNECT_REQ, seq: 1, src: 2, dst: 1, payload: p })));
  await clock.advance(3000);

  check('确实回了帧（拒绝）', stats.txA === beforeTx + 1, `txA ${beforeTx} → ${stats.txA}`);
  check('未配对', a.session.paired === false);
  check('日志里说明了拒绝原因', logs.a.some((l) => l.text.includes('没在广播')), '');
}

/* ============================ 7. 连接后收发消息 ============================ */

group('7. 连接后收发消息（ARQ 仍然工作）');

{
  const { clock, a, b, inbox } = setupPair();
  a.session.start();
  b.session.start();
  a.session.startBroadcast();
  b.session.startScan();
  await clock.advance(6000);
  b.session.connect(1, a.session.pin);
  await clock.advance(30000);
  check('已配对', a.session.paired && b.session.paired);

  const r = a.session.say('你好，这是声波消息。');
  check('入队成功', r.ok && r.chunks === 1, `chunks=${r.chunks}`);
  await clock.advance(30000);
  check('B 收到 1 条', inbox.b.length === 1, `实收 ${inbox.b.length}`);
  check('正文一致', inbox.b[0]?.text === '你好，这是声波消息。', JSON.stringify(inbox.b[0]?.text));
  check('带对端名字', inbox.b[0]?.fromName === '甲', inbox.b[0]?.fromName);

  b.session.say('收到');
  await clock.advance(30000);
  check('A 收到回复', inbox.a.length === 1, `实收 ${inbox.a.length}`);
}

/* ============================ 8. 长消息分片 + 丢包重传 ============================ */

group('8. 长消息分片重组 + 丢包重传');

{
  let dataFrames = 0;
  const { clock, a, b, inbox, stats } = setupPair({
    shouldDrop: (bytes) => {
      if ((bytes[0] & 0x0f) === FRAME.MSG) {
        dataFrames++;
        return dataFrames === 1; // 丢第一个数据帧
      }
      return false;
    },
  });
  a.session.start();
  b.session.start();
  a.session.startBroadcast();
  b.session.startScan();
  await clock.advance(6000);
  b.session.connect(1, a.session.pin);
  await clock.advance(30000);

  const longText = '声波'.repeat(120); // 720 字节 → 多帧
  const r = a.session.say(longText);
  check('长消息被分片', r.chunks > 1, `${textToBytes(longText).length} 字节 → ${r.chunks} 帧`);
  await clock.advance(180000);

  check('确实丢了一帧', stats.dropped === 1, `dropped=${stats.dropped}`);
  check('重传后完整送达', inbox.b.length === 1 && inbox.b[0].text === longText, `实收 ${inbox.b.length} 条，长度 ${inbox.b[0]?.text?.length}`);
}

/* ============================ 9. 设备 ID 冲突 ============================ */

group('9. 设备 ID 冲突：nonce 大的让位');

{
  const { clock, a, b } = setupPair({
    idA: 1,
    idB: 1,
    nameA: '设备1',
    nameB: '设备1',
    nonceA: 100,
    nonceB: 200,
  });
  let aCollide = 0;
  let bCollide = 0;
  a.session.onIdCollision = () => {
    aCollide++;
    a.session.myId = 2;
    a.session.startBroadcast();
  };
  b.session.onIdCollision = () => {
    bCollide++;
  };
  a.session.start();
  b.session.start();
  a.session.startBroadcast();
  await clock.advance(5000);
  b.session.startBroadcast();
  await clock.advance(20000);

  check('只有 nonce 小的一方让位', aCollide > 0 && bCollide === 0, `A 触发 ${aCollide} / B 触发 ${bCollide}`);
  check('让位方已换 ID', a.session.myId === 2, `A id=${a.session.myId}`);
  check('未让位方 ID 不变', b.session.myId === 1, `B id=${b.session.myId}`);
}

/* ============================ 10. 发现项过期 ============================ */

group('10. 发现项过期自动移除');

{
  const { clock, a, b } = setupPair({ opts: { discoverTtl: 5000 } });
  a.session.start();
  b.session.start();
  a.session.startBroadcast();
  b.session.startScan();
  await clock.advance(6000);
  check('已发现 A', b.session.discovered.size === 1);

  a.session.stopBroadcast();
  await clock.advance(30000);
  check('A 停止广播后，发现项过期移除', b.session.discovered.size === 0, `列表 ${b.session.discovered.size} 项`);
}

/* ============================ 11. 边界 ============================ */

group('11. 边界');

{
  const { clock, a, b } = setupPair();
  a.session.start();
  b.session.start();

  check('未配对时不能发消息', a.session.say('hi').reason === 'no-peer');
  const r = b.session.connect(99, '1234');
  check('连接不存在的设备被拒', !r.ok && r.reason === 'not-found');
  const r2 = b.session.connect(1, '12');
  check('PIN 位数不对被拒', !r2.ok && r2.reason === 'bad-pin');
  const r3 = b.session.connect(1, 'abcd');
  check('PIN 非数字被拒', !r3.ok && r3.reason === 'bad-pin');
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
