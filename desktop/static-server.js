'use strict';

/**
 * 依存ゼロの極小静的ファイルサーバ。
 * Electron からアプリ内で起動し、karenda- の Web 資産を http://127.0.0.1:<port> で配信する。
 * file:// を避けることで正規の origin が得られ、localStorage / Service Worker /
 * manifest.json（すべて相対パス）が Web 版と同じ挙動になる。
 *
 * 加えて Google OAuth 用に、同一オリジン上で /oauth-callback を受け取る。
 * 固定ポート（候補の先頭から確保）にすることで:
 *   - OAuth リダイレクト URL を Supabase に登録できる
 *   - origin が起動間で安定し、ログインセッション（localStorage）が永続化される
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// OAuth リダイレクトに使う固定ポート候補（Supabase の Redirect URLs に登録する）
const PREFERRED_PORTS = [8923, 8924, 8925];
const OAUTH_CALLBACK_PATH = '/oauth-callback';

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

// OAuth コールバック後に表示するページ（ブラウザ側に出る）
const CALLBACK_HTML_OK = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ログイン完了</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;background:#f4f6fb;color:#222;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
.card{background:#fff;border-radius:14px;padding:32px 28px;box-shadow:0 10px 40px rgba(0,0,0,.12);text-align:center;max-width:340px}
.emoji{font-size:44px}h1{font-size:18px;margin:14px 0 6px}p{font-size:13px;color:#666;line-height:1.7;margin:0}</style></head>
<body><div class="card"><div class="emoji">✅</div><h1>ログインしました</h1>
<p>このタブを閉じて<br><strong>My Calendar</strong> アプリに戻ってください。</p></div>
<script>setTimeout(function(){window.close();},800);</script></body></html>`;

const CALLBACK_HTML_ERR = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ログイン失敗</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;background:#f4f6fb;color:#222;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
.card{background:#fff;border-radius:14px;padding:32px 28px;box-shadow:0 10px 40px rgba(0,0,0,.12);text-align:center;max-width:340px}
.emoji{font-size:44px}h1{font-size:18px;margin:14px 0 6px}p{font-size:13px;color:#666;line-height:1.7;margin:0}</style></head>
<body><div class="card"><div class="emoji">⚠️</div><h1>ログインできませんでした</h1>
<p>このタブを閉じて、<strong>My Calendar</strong> アプリでもう一度お試しください。</p></div></body></html>`;

function _listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 指定ディレクトリを配信するサーバを起動する。
 * @param {string} rootDir 配信ルート（karenda- の絶対パス）
 * @returns {Promise<{server: http.Server, port: number, url: string, waitForOAuthCallback: Function}>}
 */
async function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);

  // OAuth コールバック待ち受け（one-shot）
  let _pendingResolve = null;
  function waitForOAuthCallback(timeoutMs = 300000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { _pendingResolve = null; resolve({ error: 'timeout' }); }, timeoutMs);
      _pendingResolve = (result) => { clearTimeout(timer); _pendingResolve = null; resolve(result); };
    });
  }

  const server = http.createServer((req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (_) {
      res.writeHead(400); res.end('Bad Request'); return;
    }

    // ── OAuth コールバック（ファイル探索の前に短絡）──
    if (parsed.pathname === OAUTH_CALLBACK_PATH) {
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error') ||
                    parsed.searchParams.get('error_description');
      const ok = !!code && !error;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(ok ? CALLBACK_HTML_OK : CALLBACK_HTML_ERR);
      if (_pendingResolve) _pendingResolve(ok ? { code } : { error: error || 'no_code' });
      return;
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent(parsed.pathname);
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

  // 候補ポートを先頭から試し、空いている最初のものを確保
  let lastErr = null;
  for (const port of PREFERRED_PORTS) {
    try {
      await _listen(server, port);
      return { server, port, url: `http://127.0.0.1:${port}`, waitForOAuthCallback };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'EADDRINUSE') continue;  // 次の候補へ
      throw err;                                        // それ以外は致命的
    }
  }
  throw new Error(
    `ローカルサーバを起動できません（ポート ${PREFERRED_PORTS.join(', ')} がすべて使用中）。` +
    (lastErr ? ` 詳細: ${lastErr.message}` : '')
  );
}

module.exports = { startStaticServer, PREFERRED_PORTS, OAUTH_CALLBACK_PATH };
