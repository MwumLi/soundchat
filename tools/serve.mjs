/**
 * serve.mjs — 零依赖静态服务器，用于本机/局域网调试
 *
 *   node tools/serve.mjs [端口]
 *
 * 为什么需要它：
 *   - ES module 从 file:// 加载会被 CORS 拦掉，开发页面必须走 http://
 *   - 浏览器的 getUserMedia（麦克风）只在安全上下文可用：
 *     localhost 算安全上下文，局域网 IP 不算（手机访问需要用 https 或走单文件 + 应用内打开）
 *
 * 路由：
 *   /            → dist/soundchat.html（没构建就回落到 web/index.html）
 *   /web/...     → 开发页面
 *   /src/...     → 模块源码
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2] || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readFirst(paths) {
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (s.isFile()) return await readFile(p);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') {
      const buf = await readFirst([join(ROOT, 'dist/soundchat.html'), join(ROOT, 'web/index.html')]);
      if (!buf) {
        res.writeHead(500);
        res.end('找不到 dist/soundchat.html 或 web/index.html');
        return;
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(buf);
      return;
    }

    // 防目录穿越
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, safe);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const buf = await readFirst([file]);
    if (!buf) {
      res.writeHead(404);
      res.end(`404 ${path}`);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message));
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`声波聊天 开发服务器已启动：`);
  console.log(`  本机   http://localhost:${PORT}/          （localhost 是安全上下文，麦克风可用）`);
  for (const ip of lanAddresses()) {
    console.log(`  局域网 http://${ip}:${PORT}/   （注意：非 localhost 的 http 页面拿不到麦克风权限）`);
  }
  console.log(`\n开发页面 http://localhost:${PORT}/web/index.html`);
  console.log('按 Ctrl+C 退出');
});
