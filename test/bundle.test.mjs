/**
 * bundle.test.mjs — 单文件构建产物的冒烟测试
 *
 * 浏览器里那部分没法在 Node 里跑真实音频，但最容易出错的两类问题可以在这里挡住：
 *   1. 构建产物残留 ESM 语法（file:// 下会被 CORS 拦死）
 *   2. app.js 里 getElementById 引用的 id 在 HTML 里不存在（点一下就报 null）
 * 顺带用一个最小 DOM 桩把整个 bundle 执行一遍，确认模块初始化阶段不抛异常。
 *
 * 运行：node test/bundle.test.mjs
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let nPass = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    nPass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  ' + extra : ''}`);
  }
}

console.log('\n\x1b[1m── 单文件构建产物冒烟\x1b[0m');

/* ---------- 1. 构建 ---------- */

// 先读提交里的产物，构建之后对比 —— 用来抓「改了 src 但忘了重新构建 dist」
let committedDist = null;
try {
  committedDist = readFileSync(join(ROOT, 'dist/soundchat.html'), 'utf8');
} catch {
  /* 首次构建前可能不存在 */
}

let buildOut = '';
try {
  buildOut = execFileSync(process.execPath, [join(ROOT, 'build.mjs')], { cwd: ROOT, encoding: 'utf8' });
  check('build.mjs 执行成功', true, buildOut.trim().split('\n')[0]);
} catch (e) {
  check('build.mjs 执行成功', false, e.message);
  process.exit(1);
}

const dist = readFileSync(join(ROOT, 'dist/soundchat.html'), 'utf8');

{
  const same = committedDist === null || committedDist === dist;
  check(
    '提交的 dist 与重新构建完全一致（没忘记重新构建）',
    same,
    same ? '' : '不一致 → 改了 src 之后要跑一次 node build.mjs 并一起提交'
  );
}
const m = dist.match(/<script>([\s\S]*?)<\/script>/);
check('产物里有内联 script', !!m);

// 构建标识：两台设备靠它判断是不是同一个构建
const stampMatch = dist.match(/window\.__BUILD__ = (\{[^}]*\});/);
check('产物里有构建标识 __BUILD__', !!stampMatch, stampMatch ? stampMatch[1] : '');
if (stampMatch) {
  const bi = JSON.parse(stampMatch[1]);
  check('构建标识含版本号', typeof bi.version === 'string' && bi.version !== 'dev', `v${bi.version}`);
  check('构建标识含内容哈希', /^[0-9a-f]{7}$/.test(bi.stamp || ''), bi.stamp);
}

// 可复现性：同一份源码构建两次，产物必须逐字节相同
{
  const before = readFileSync(join(ROOT, 'dist/soundchat.html'), 'utf8');
  execFileSync(process.execPath, [join(ROOT, 'build.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const after = readFileSync(join(ROOT, 'dist/soundchat.html'), 'utf8');
  check('构建可复现（两次产物逐字节相同）', before === after);
}
const code = m ? m[1] : '';

/* ---------- 2. 不能残留 ESM 语法 ---------- */

const esmLines = code.split('\n').filter((l) => /^\s*(import|export)\s/.test(l));
check('没有残留 import/export 语句', esmLines.length === 0, esmLines.slice(0, 3).join(' | '));
check('产物里没有外链 script', !/<script[^>]+src=/.test(dist));

/* ---------- 3. DOM id 交叉校验 ---------- */

const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));
const appSrc = readFileSync(join(ROOT, 'src/app.js'), 'utf8');
const usedIds = [...appSrc.matchAll(/\$\('([^']+)'\)/g)].map((x) => x[1]);
const missing = usedIds.filter((id) => !htmlIds.has(id));
check(`app.js 引用的 ${usedIds.length} 个 DOM id 都存在`, missing.length === 0, missing.join(','));

/* ---------- 3b. 所有被 import 的名字都必须在合并后的产物里有定义 ---------- */
// 拦「build 漏了某个模块」：漏掉时 import 被剥掉、模块代码没进来，
// 静态检查能立刻发现，而 DOM 桩不一定碰得到那些函数。
{
  const srcFiles = ['src/modem.js', 'src/protocol.js', 'src/store.js', 'src/app.js'];
  const all = srcFiles.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  const names = new Set();
  for (const f of srcFiles) {
    const code = readFileSync(join(ROOT, f), 'utf8');
    for (const m of code.matchAll(/^import\s+\{([\s\S]*?)\}\s+from\s+['"][^'"]+['"]/gm)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
  }
  const undeclared = [...names].filter((n) => {
    const re = new RegExp(`\\b(?:const|let|var|function|class)\\s+${n}\\b`);
    return !re.test(all);
  });
  check(`每个 import 的名字都有定义（共 ${names.size} 个）`, undeclared.length === 0, undeclared.slice(0, 4).join(', '));

  // 产物里必须包含所有 src 模块的标志性内容
  const markers = [
    ['src/modem.js', 'AcousticReceiver'],
    ['src/protocol.js', 'ChatSession'],
    ['src/store.js', 'appendHistory'],
    ['src/app.js', '__soundchat'],
  ];
  const absent = markers.filter(([, m]) => !code.includes(m)).map(([f]) => f);
  check('产物包含全部 src 模块', absent.length === 0, absent.length ? `缺少 ${absent.join(', ')}` : `${markers.length} 个模块都在`);
}

/* ---------- 3c. JS 里 classList 操作的 class 必须有 CSS 规则 ---------- */
// 拦「加了 class 但 CSS 里没这个规则」：不会报错、不会抛异常，
// 只是那个元素永远不会变成预期样式 —— 曾经因此让启动遮罩永远盖着页面。
{
  const cssText = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
  const used = new Set();
  for (const f of ['src/app.js', 'src/protocol.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) used.add(m[1]);
  }
  const wild = [...used].filter((c) => !new RegExp(`\\.${c}(?![\\w-])`).test(cssText));
  check(
    `classList 用到的 ${used.size} 个 class 都有 CSS 规则`,
    wild.length === 0,
    wild.length ? `没有规则: ${wild.join(', ')}` : ''
  );
}

/* ---------- 4. 用最小 DOM 桩跑一遍 bundle ---------- */

const requestedIds = [];
const elCache = new Map();
const makeEl = (id) => {
  const el = {
    id,
    textContent: '',
    value: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    childElementCount: 0,
    firstChild: null,
    lastElementChild: null,
    children: [],
    style: {},
    classList: {
      _s: new Set(),
      add(c) {
        this._s.add(c);
      },
      remove(c) {
        this._s.delete(c);
      },
      toggle(c) {
        this._s.has(c) ? this._s.delete(c) : this._s.add(c);
      },
      contains(c) {
        return this._s.has(c);
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) {
      this.children.push(c);
      this.childElementCount = this.children.length;
      this.lastElementChild = c;
      this.firstChild = this.children[0];
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      this.childElementCount = this.children.length;
      this.lastElementChild = this.children[this.children.length - 1] || null;
      this.firstChild = this.children[0] || null;
      return c;
    },
    focus() {},
    click() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
  };
  return el;
};

const store = new Map();
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance: { now: () => Date.now() },
  URLSearchParams,
  Math,
  Date,
  JSON,
  Uint8Array,
  Uint16Array,
  Float32Array,
  Float64Array,
  ArrayBuffer,
  DataView,
  TextEncoder,
  TextDecoder,
  Blob: class {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  location: { search: '', href: 'file:///dist/soundchat.html' },
  navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('测试环境没有麦克风'); } } },
  alert: () => {},
  document: {
    // 按 id 缓存：真实 DOM 里同一个 id 永远是同一个节点，
    // 不缓存的话就没法断言「代码真的把版本号写进了元素」。
    getElementById(id) {
      requestedIds.push(id);
      if (!htmlIds.has(id)) return null;
      if (!elCache.has(id)) elCache.set(id, makeEl(id));
      return elCache.get(id);
    },
    createElement: () => makeEl('created'),
    createTextNode: () => ({}),
    body: makeEl('body'),
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let threw = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 10000 });
} catch (e) {
  threw = e;
}
check('bundle 初始化不抛异常', !threw, threw ? `${threw.name}: ${threw.message}` : '');

const nullIds = requestedIds.filter((id) => !htmlIds.has(id));
check('初始化时没有取到 null 的 DOM 节点', nullIds.length === 0, [...new Set(nullIds)].join(','));

{
  const ver = elCache.get('verText');
  const detail = elCache.get('verDetail');
  check(
    '版本号已渲染到状态行',
    !!ver && /^v\d+\.\d+\.\d+/.test(ver.textContent || ''),
    ver ? ver.textContent : '（没取到元素）'
  );
  check(
    '设备面板里的版本详情已渲染',
    !!detail && (detail.textContent || '').includes('本机'),
    detail ? detail.textContent : '（没取到元素）'
  );
}

check(
  '导出的调试句柄存在',
  !!sandbox.window.__soundchat && typeof sandbox.window.__soundchat.myId === 'number',
  sandbox.window.__soundchat ? `本机 id=${sandbox.window.__soundchat.myId}` : ''
);

/* ---------- 汇总 ---------- */

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m全部通过：${nPass} 项\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m失败 ${failures.length} 项 / 通过 ${nPass} 项\x1b[0m`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
