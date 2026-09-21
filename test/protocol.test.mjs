/**
 * protocol.test.mjs — 会话层端到端测试
 *
 * 用「虚拟时钟 + 内存声学信道」把两个 ChatSession 接起来：
 *   发送 → 真实 modulate 成波形 → 送到对端 AcousticReceiver 解调 → 对端 onFrame
 * 因此这一层验证的是「调制解调 + 配对 + 分片 + 停等 ARQ + 重组」的完整闭环，
 * 而且不依赖真实时间，跑得很快。
 *
 * 运行：node test/protocol.test.mjs
 */

import { PROFILES, modulate, AcousticReceiver, FRAME, buildFrame, textToBytes, bytesToText } from '../src/modem.js';
import { ChatSession, STATE, MAX_TEXT_BYTES } from '../src/protocol.js';

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
  /**
   * 推进到 now+ms，按时间顺序执行所有到期定时器。
   *
   * 每轮循环开头必须先 flush 微任务：发送是通过 Promise 链串行化的，
   * 新的定时器往往是在微任务里才被排进来；不 flush 就会漏掉它们，
   * 表现为「消息排队了但永远发不出去」。
   */
  async advance(ms) {
    // 关键：先把微任务排干净，再推进时间。
    // 发送链是 Promise 串起来的，定时器往往在这一刻才被排进来；
    // 若先把 now 跳到 target，新定时器就落在窗口之外，表现为「消息永远发不出去」。
    await this.settle();
    const target = this.now + ms;
    for (let guard = 0; guard < 200000; guard++) {
      let due = null;
      for (const t of this.q) if (t.at <= target && (!due || t.at < due.at)) due = t;
      if (due) {
        this.q = this.q.filter((t) => t !== due);
        this.now = Math.max(this.now, due.at);
        due.fn();
        await this.settle(6);
        continue;
      }
      const prev = this.now;
      this.now = target;
      await this.settle();
      // 刚跳完时间，微任务里可能又排出窗口内的定时器（它们用的是 prev 时刻）
      let again = null;
      for (const t of this.q) if (t.at <= target && (!again || t.at < again.at)) again = t;
      if (!again) break;
    }
    await this.settle();
  }

  /** 排空微任务（用真实 setImmediate 让 await/.then 链推进） */
  async settle(rounds = 12) {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
  }
}

/* ============================ 内存声学信道 ============================ */

/**
 * @param {Clock} clock
 * @param {object} stats 统计（发送数、丢包数）
 * @param {(frameBytes:Uint8Array, n:number)=>boolean} [shouldDrop]
 */
function makeChannel(clock, stats, shouldDrop) {
  const peers = { a: null, b: null };
  let txCount = 0;

  const transmit = (from, to) => async (bytes) => {
    const wav = modulate(bytes, PROFILE, FS);
    const durMs = (wav.length / FS) * 1000;
    stats[`tx${from.toUpperCase()}`]++;
    const n = ++txCount;
    const drop = shouldDrop ? shouldDrop(bytes, n, from) : false;
    if (drop) stats.dropped++;
    // 声波是广播信道：任何人发声期间，整条信道都算被占用
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

function setupPair({ shouldDrop, opts, randA, randB, idA = 1, idB = 2, nameA = '甲', nameB = '乙' } = {}) {
  const clock = new Clock();
  const stats = { txA: 0, txB: 0, dropped: 0 };
  const ch = makeChannel(clock, stats, shouldDrop);
  const logs = { a: [], b: [] };
  const inbox = { a: [], b: [] };

  const a = { rx: new AcousticReceiver(PROFILE, FS), session: null };
  const b = { rx: new AcousticReceiver(PROFILE, FS), session: null };
  ch.peers.a = a;
  ch.peers.b = b;

  a.session = new ChatSession({
    myId: idA,
    myName: nameA,
    now: () => clock.now,
    transmit: ch.transmit('a', 'b'),
    timers: clock,
    opts: { ...opts, rand: randA },
    onMessage: (m) => inbox.a.push(m),
    onLog: (e) => logs.a.push(e),
  });
  b.session = new ChatSession({
    myId: idB,
    myName: nameB,
    now: () => clock.now,
    transmit: ch.transmit('b', 'a'),
    timers: clock,
    opts: { ...opts, rand: randB },
    onMessage: (m) => inbox.b.push(m),
    onLog: (e) => logs.b.push(e),
  });
  return { clock, stats, a, b, inbox, logs };
}

/* ============================ 1. 配对 ============================ */

group('1. 声波配对');

{
  const { clock, a, b } = setupPair();
  a.session.start();
  b.session.start();
  check('初始未配对', !a.session.paired && !b.session.paired);

  await clock.advance(20000);
  check('双方完成配对', a.session.paired && b.session.paired);
  check('交换了 id', a.session.peerId === 2 && b.session.peerId === 1, `a.peer=${a.session.peerId} b.peer=${b.session.peerId}`);
  check('交换了昵称', a.session.peerName === '乙' && b.session.peerName === '甲', `a.peerName=${a.session.peerName} b.peerName=${b.session.peerName}`);
}

/* ============================ 2. 单帧文本 ============================ */

group('2. 单帧文本收发');

{
  const { clock, a, b, inbox } = setupPair();
  a.session.start();
  b.session.start();
  await clock.advance(20000);

  const r = a.session.say('你好，这是第一条声波消息。');
  check('入队成功', r.ok && r.chunks === 1, `chunks=${r.chunks}`);
  await clock.advance(20000);

  check('对端收到 1 条', inbox.b.length === 1, `实收 ${inbox.b.length}`);
  check('正文一致', inbox.b[0]?.text === '你好，这是第一条声波消息。', JSON.stringify(inbox.b[0]?.text));
  check('显示对端昵称', inbox.b[0]?.from === '甲', inbox.b[0]?.from);
  check('发送队列已清空', a.session.queue.length === 0 && a.session.current === null);
}

/* ============================ 3. 双向 + 长消息分片 ============================ */

group('3. 双向通信与长消息分片重组');

{
  const { clock, a, b, inbox } = setupPair();
  a.session.start();
  b.session.start();
  await clock.advance(20000);

  const longText = '声波'.repeat(120); // 240 个汉字 = 720 字节，必然多帧
  const r = a.session.say(longText);
  check('长消息被分片', r.chunks > 1, `${textToBytes(longText).length} 字节 → ${r.chunks} 帧`);

  // 声波是半双工：等甲把长消息发完，乙再回复（真实使用也是这个节奏）
  await clock.advance(60000);
  check('甲发完后队列清空', a.session.current === null && a.session.queue.length === 0);

  b.session.say('收到，我这边一切正常。');
  await clock.advance(30000);
  check('乙收到长消息', inbox.b.length === 1, `实收 ${inbox.b.length}`);
  check('长消息完整重组', inbox.b[0]?.text === longText, `长度 ${inbox.b[0]?.text?.length} vs ${longText.length}`);
  check('甲收到回复', inbox.a.length === 1, `实收 ${inbox.a.length}`);
  check('回复正文一致', inbox.a[0]?.text === '收到，我这边一切正常。');
}

/* ============================ 4. 丢包重传 ============================ */

group('4. 丢包重传（丢第 1 个数据帧，应自动重传后送达）');

{
  let dataFrames = 0;
  const { clock, a, b, inbox, stats } = setupPair({
    shouldDrop: (bytes) => {
      // 只丢 A 发出的第一个 MSG 帧（header 第 0 字节低 4 位 = 帧类型）
      if ((bytes[0] & 0x0f) === FRAME.MSG) {
        dataFrames++;
        return dataFrames === 1;
      }
      return false;
    },
  });
  a.session.start();
  b.session.start();
  await clock.advance(20000);

  a.session.say('这条消息的第一个数据帧会被丢掉');
  await clock.advance(60000);

  check('确实丢了一帧', stats.dropped === 1, `dropped=${stats.dropped}`);
  check('重传后仍然送达', inbox.b.length === 1, `实收 ${inbox.b.length}`);
  check('正文正确', inbox.b[0]?.text === '这条消息的第一个数据帧会被丢掉');
}

/* ============================ 5. ACK 丢失去重 ============================ */

group('5. ACK 丢失（对端会重复收到同一帧，必须去重且只交付一次）');

{
  let ackDropped = 0;
  const { clock, a, b, inbox, stats } = setupPair({
    shouldDrop: (bytes, n, from) => {
      if (from === 'b' && (bytes[0] & 0x0f) === FRAME.ACK && ackDropped < 1) {
        ackDropped++;
        return true;
      }
      return false;
    },
  });
  a.session.start();
  b.session.start();
  await clock.advance(20000);

  a.session.say('ACK 会丢一次，触发重传');
  await clock.advance(60000);

  check('ACK 被丢了一次', ackDropped === 1);
  check('发送方重传过', stats.txA >= 2, `txA=${stats.txA}`);
  check('接收方只交付一次（去重生效）', inbox.b.length === 1, `实收 ${inbox.b.length}`);
  check('正文正确', inbox.b[0]?.text === 'ACK 会丢一次，触发重传');
}

/* ============================ 6. 持续丢包最终放弃 ============================ */

group('6. 持续丢包（超过重传上限后放弃，不能死循环）');

{
  let seen = 0;
  const { clock, a, b, inbox, stats } = setupPair({
    shouldDrop: (bytes, n, from) => {
      if (from === 'a' && (bytes[0] & 0x0f) === FRAME.MSG) {
        seen++;
        return true; // 数据帧全丢
      }
      return false;
    },
  });
  a.session.start();
  b.session.start();
  await clock.advance(20000);

  a.session.say('这条永远发不出去');
  await clock.advance(120000);

  check('重传次数受控', seen === 4, `实际发出 ${seen} 次（1 次首发 + 3 次重传）`);
  check('接收方什么都没收到', inbox.b.length === 0);
  check('发送方已回到空闲（未死循环）', a.session.current === null && a.session.queue.length === 0);
  check('上报了 no-ack 错误', a.session.state === STATE.IDLE);
}

/* ============================ 7. 拒绝超长文本 ============================ */

group('7. 边界：超长文本');

{
  const { a, b, clock } = setupPair();
  a.session.start();
  b.session.start();
  await clock.advance(20000);
  const r = a.session.say('x'.repeat(MAX_TEXT_BYTES + 1));
  check('超过上限被拒绝', !r.ok && r.reason === 'too-long');
  const r2 = a.session.say('');
  check('空文本被拒绝', !r2.ok && r2.reason === 'empty');
}

/* ============================ 8. 载波侦听让行 ============================ */

group('8. 载波侦听：双方同时起发时，退避 + 让行保证都能送达');

{
  // A 退避 30ms，B 退避 350ms —— 模拟两端随机退避错开
  const { clock, a, b, inbox } = setupPair({
    opts: { txJitter: 400, deferMs: 200 },
    randA: () => 0.05,
    randB: () => 0.9,
  });
  a.session.start();
  b.session.start();
  await clock.advance(20000);

  a.session.say('甲先开口');
  b.session.say('乙也想同时开口');
  await clock.advance(120000);

  check('甲的消息送达', inbox.b.length === 1, `实收 ${inbox.b.length}`);
  check('乙的消息送达', inbox.a.length === 1, `实收 ${inbox.a.length}`);
  check('甲正文正确', inbox.b[0]?.text === '甲先开口', JSON.stringify(inbox.b[0]?.text));
  check('乙正文正确', inbox.a[0]?.text === '乙也想同时开口', JSON.stringify(inbox.a[0]?.text));
}

/* ============================ 9. 设备 ID 冲突 ============================ */

group('9. 设备 ID 冲突自动检测（同机两个 tab 共用身份时会撞车）');

{
  // 两端都用 id=1，模拟「同一个浏览器两个 tab 拿到了同一个设备 ID」
  const { clock, a, b, inbox } = setupPair({ idA: 1, idB: 1, nameA: '设备1', nameB: '设备1' });
  let collisions = 0;
  a.session.onIdCollision = () => {
    collisions++;
    a.session.setId(2); // 换一个 ID 重新配对
    a.session.pair();
  };
  b.session.onIdCollision = () => {
    collisions++;
  };

  a.session.start();
  await clock.advance(3000); // 错开启动时间，模拟真实的两个 tab
  b.session.start();
  await clock.advance(30000);

  check('检测到了 ID 冲突', collisions > 0, `触发 ${collisions} 次`);
  check('冲突方已换 ID', a.session.myId === 2, `现在 id=${a.session.myId}`);
  check('换 ID 后成功配对', a.session.paired && b.session.paired, `a.peer=${a.session.peerId} b.peer=${b.session.peerId}`);

  a.session.say('换过 ID 之后应该能正常聊天');
  await clock.advance(30000);
  check('换 ID 后消息能送达', inbox.b.length === 1, `实收 ${inbox.b.length}`);
  check('正文正确', inbox.b[0]?.text === '换过 ID 之后应该能正常聊天', JSON.stringify(inbox.b[0]?.text));
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
