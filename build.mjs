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
const SRC = ['src/modem.js', 'src/protocol.js', 'src/app.js'];

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
  const parts = [];
  for (const f of SRC) {
    parts.push(stripModule(await readFile(join(ROOT, f), 'utf8'), f));
  }

  const bundle = [
    '(function () {',
    "'use strict';",
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
  console.log('这个文件可以直接用浏览器打开（file:// 也能跑，但手机上的麦克风权限见 README）。');
}

main().catch((e) => {
  console.error(`构建失败：${e.message}`);
  process.exit(1);
});
