/**
 * build.mjs — 把 src/*.js 内联进 web/index.html，产出单文件 dist/soundchat.html
 *
 * 为什么要单文件：手机要能直接打开用，不能依赖本地服务器。
 * 而 file:// 下浏览器禁止 ES module 的跨文件 import（CORS），
 * 所以必须把三个模块合成一个普通 <script>（去掉 import/export）。
 *
 * 运行：node build.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
/**
 * 入口文件。依赖顺序由 resolveSrc 自动推导 —— 之前手写数组漏了 store.js，
 * 单文件产物运行到一半才报 "xxx is not defined"，所以改成自动扫描。
 */
const ENTRY = 'src/app.js';

/** 按 import 关系递归收集依赖（被依赖的排在前面） */
async function resolveSrc(entry) {
  const seen = new Set();
  const out = [];
  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const code = await readFile(join(ROOT, file), 'utf8');
    const deps = [...code.matchAll(/^import\s+[\s\S]*?from\s+['"](\.\/[^'"]+)['"];?/gm)].map((m) => m[1]);
    for (const d of deps) await visit(join(dirname(file), d).replace(/\\/g, '/'));
    out.push(file);
  }
  await visit(entry);
  return out;
}

/** 去掉 ESM 语法，让多文件能拼成一个普通脚本 */
function stripModule(code, name) {
  const before = code;
  code = code.replace(/^import\b[^;]*;\s*$/gm, '');
  code = code.replace(/^export\s+/gm, '');
  if (/^\s*(import|export)\s/m.test(code)) {
    const bad = code.split('\n').filter((l) => /^\s*(import|export)\s/.test(l));
    throw new Error(`${name} 里仍有未处理的 ESM 语句：\n${bad.join('\n')}`);
  }
  return `/* ==================== ${name} ==================== */\n${code.trim()}\n`;
}

async function main() {
  const html = await readFile(join(ROOT, 'web/index.html'), 'utf8');
  const SRC = await resolveSrc(ENTRY);
  const parts = [];
  for (const f of SRC) {
    parts.push(stripModule(await readFile(join(ROOT, f), 'utf8'), f));
  }

  // 构建标识 = 版本号 + **内容哈希**。
  //
  // 为什么不用 git commit 或构建时间：
  //   - 构建时间会让每次构建产物都不同 → 跑一次测试 git 就变脏
  //   - git commit 会带 -dirty 状态，导致「提交的产物」和「CI 从干净检出重建的产物」
  //     标识不一致，正好把要排查的问题引入进来
  // 内容哈希只取决于源码：同一份源码永远得到同一个标识（可复现），
  // 而代码一改标识就变 —— 正好用来判断两台设备是不是同一个构建。
  const { createHash } = await import('node:crypto');
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const stamp = createHash('sha256')
    .update(html + '\n' + parts.join('\n'))
    .digest('hex')
    .slice(0, 7);
  const buildInfo = { version: pkg.version || '0.0.0', stamp };

  const bundle = [
    '(function () {',
    "'use strict';",
    `window.__BUILD__ = ${JSON.stringify(buildInfo)};`,
    parts.join('\n'),
    '})();',
  ].join('\n');

  const tag = '<script type="module" src="../src/app.js"></script>';
  if (!html.includes(tag)) throw new Error('web/index.html 里找不到模块 script 标签，构建模板可能被改过');

  const out = html
    .replace(
      '<title>声波聊天 · SoundChat</title>',
      '<title>声波聊天 · SoundChat（单文件版）</title>'
    )
    .replace(tag, `<script>\n${bundle}\n</script>`);

  await mkdir(join(ROOT, 'dist'), { recursive: true });
  const dest = join(ROOT, 'dist/soundchat.html');
  await writeFile(dest, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log(`已生成 dist/soundchat.html（${kb} KB，内联 ${SRC.length} 个模块）`);
  console.log(`构建标识：v${buildInfo.version} · ${buildInfo.stamp}`);
  console.log('这个文件可以直接用浏览器打开（file:// 也能跑，但手机上的麦克风权限见 README）。');
}

main().catch((e) => {
  console.error(`构建失败：${e.message}`);
  process.exit(1);
});
