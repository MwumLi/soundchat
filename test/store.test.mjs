/**
 * store.test.mjs — 持久化层单测
 *
 * store.js 是纯函数、storage 靠注入，所以不需要浏览器就能测。
 * 运行：node test/store.test.mjs
 */

import {
  HISTORY_MAX,
  loadHistory,
  peerHistory,
  appendHistory,
  clearPeerHistory,
  clearAllHistory,
  historyPeerIds,
  loadPeers,
  rememberPeer,
  renamePeer,
  forgetPeer,
  peerList,
} from '../src/store.js';

/* ============================ 假 storage ============================ */

function fakeStorage() {
  const m = new Map();
  return {
    _m: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** 写入就会抛的 storage（模拟隐私模式 / 配额满） */
function brokenStorage() {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceeded');
    },
    removeItem: () => {},
  };
}

/* ============================ 断言框架 ============================ */

let nPass = 0;
const failures = [];
let g = '';
function group(n) {
  g = n;
  console.log(`\n\x1b[1m── ${n}\x1b[0m`);
}
function check(name, cond, extra = '') {
  if (cond) {
    nPass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push(`${g} / ${name}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  }
}

/* ============================ 1. 会话记录 ============================ */

group('1. 会话记录按设备分组');

{
  const s = fakeStorage();
  check('初始为空', historyPeerIds(s).length === 0);
  check('读不存在的设备返回空数组', peerHistory(s, 7).length === 0);

  appendHistory(s, 1, { k: 'me', t: '给甲的', a: 1 });
  appendHistory(s, 1, { k: 'peer', t: '甲回的', a: 2 });
  appendHistory(s, 2, { k: 'me', t: '给乙的', a: 3 });

  check('甲有 2 条', peerHistory(s, 1).length === 2, JSON.stringify(peerHistory(s, 1).map((x) => x.t)));
  check('乙有 1 条', peerHistory(s, 2).length === 1);
  check('两个设备互不串台', peerHistory(s, 1).every((x) => x.t !== '给乙的'));
  check('设备 id 列表正确', historyPeerIds(s).sort().join(',') === '1,2', historyPeerIds(s).join(','));
}

/* ============================ 2. 上限与清理 ============================ */

group('2. 上限与清理');

{
  const s = fakeStorage();
  for (let i = 0; i < HISTORY_MAX + 50; i++) appendHistory(s, 1, { k: 'me', t: `第${i}条`, a: i });
  const arr = peerHistory(s, 1);
  check(`超过 ${HISTORY_MAX} 条后只保留最近 ${HISTORY_MAX} 条`, arr.length === HISTORY_MAX, `实际 ${arr.length}`);
  check('丢的是最旧的', arr[0].t === '第50条', arr[0].t);
  check('保留的是最新的', arr[arr.length - 1].t === `第${HISTORY_MAX + 49}条`, arr[arr.length - 1].t);

  clearPeerHistory(s, 1);
  check('清空单个设备', peerHistory(s, 1).length === 0);

  appendHistory(s, 1, { k: 'me', t: 'x', a: 1 });
  appendHistory(s, 2, { k: 'me', t: 'y', a: 2 });
  clearAllHistory(s);
  check('清空全部', historyPeerIds(s).length === 0);
}

/* ============================ 3. 旧格式丢弃 ============================ */

group('3. v1 旧格式（扁平数组）直接丢弃，不做迁移');

{
  const s = fakeStorage();
  s.setItem('sc.history', JSON.stringify([{ k: 'me', t: '旧的', a: 1 }]));
  check('读到旧格式返回空容器', historyPeerIds(s).length === 0);
  appendHistory(s, 3, { k: 'me', t: '新的', a: 2 });
  check('写入后变成新格式', peerHistory(s, 3).length === 1);

  const s2 = fakeStorage();
  s2.setItem('sc.history', '这不是 JSON');
  check('坏 JSON 不抛异常', historyPeerIds(s2).length === 0);

  const s3 = fakeStorage();
  s3.setItem('sc.history', JSON.stringify({ peers: null }));
  check('peers 为 null 也不抛', historyPeerIds(s3).length === 0);
}

/* ============================ 4. 已知设备 ============================ */

group('4. 已知设备列表');

{
  const s = fakeStorage();
  check('初始为空', peerList(s).length === 0);

  rememberPeer(s, 1, '甲', 1000);
  rememberPeer(s, 2, '乙', 2000);
  check('记住两台', peerList(s).length === 2);
  check('按最后联系时间倒序', peerList(s)[0].id === 2, `第一台是 ${peerList(s)[0].name}`);
  check('昵称正确', peerList(s)[0].name === '乙');

  rememberPeer(s, 1, '甲', 3000);
  check('再次连接会更新 lastAt 并排到前面', peerList(s)[0].id === 1, `第一台是 ${peerList(s)[0].name}`);
  check('不会重复添加', peerList(s).length === 2);

  check('可以改名', renamePeer(s, 1, '老王')?.name === '老王');
  check('改名生效', peerList(s).find((p) => p.id === 1).name === '老王');
  check('改名后 lastAt 不变', peerList(s).find((p) => p.id === 1).lastAt === 3000);
  check('改不存在的设备返回 null', renamePeer(s, 99, 'x') === null);

  rememberPeer(s, 1, '', 4000);
  check('传空昵称时保留原昵称', peerList(s).find((p) => p.id === 1).name === '老王');

  forgetPeer(s, 2);
  check('可以忘记设备', peerList(s).length === 1);
}

/* ============================ 5. 存储不可用 ============================ */

group('5. 存储不可用时不崩（隐私模式 / 配额满）');

{
  const b = brokenStorage();
  let threw = null;
  try {
    appendHistory(b, 1, { k: 'me', t: 'x', a: 1 });
    rememberPeer(b, 1, '甲');
    clearAllHistory(b);
  } catch (e) {
    threw = e;
  }
  check('写失败不抛异常', threw === null, threw ? threw.message : '');
  check('读回来是空容器', historyPeerIds(b).length === 0 && peerList(b).length === 0);
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
