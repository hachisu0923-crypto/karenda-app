'use strict';

/**
 * 依存ゼロの極小静的ファイルサーバ。
 * Electron からアプリ内で起動し、karenda- の Web 資産を http://127.0.0.1:<port> で配信する。
 * file:// を避けることで正規の origin が得られ、localStorage / Service Worker /
 * manifest.json（すべて相対パス）が Web 版と同じ挙動になる。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8'
};

/**
 * 指定ディレクトリを配信するサーバを起動する。
 * @param {string} rootDir 配信ルート（karenda- の絶対パス）
 * @returns {Promise<{server: http.Server, port: number, url: string}>}
 */
function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    } catch (_) {
      res.writeHead(400); res.end('Bad Request'); return;
    }
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    // ルート配下に正規化（ディレクトリトラバーサル防止）
    const safePath = path.normalize(path.join(root, urlPath));
    if (safePath !== root && !safePath.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(safePath, (err, stat) => {
      let filePath = safePath;
      if (!err && stat.isDirectory()) filePath = path.join(safePath, 'index.html');

      fs.readFile(filePath, (rErr, data) => {
        if (rErr) {
          // SPA ではないので素直に 404（未知パスのみ）
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(data);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 127.0.0.1 の ephemeral ポート（衝突回避）
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { startStaticServer };
