'use strict';

/**
 * My Calendar (karenda) — Electron メインプロセス
 *
 * 既存の Web アプリ（../karenda-）をアプリ内のローカル HTTP サーバで配信し、
 * iPhone 風の枠（frameless + transparent）の中に iframe で読み込むことで
 * 「スマホ実機のような」デスクトップアプリにする。Web アプリ側のコードは一切変更しない。
 *
 *   トップフレーム = shell.html（iPhone ボディ＋ノッチ＋丸い画面＋影を CSS で描画）
 *   画面部分       = <iframe src="/">（カレンダー本体、論理幅 390px = 常にスマホ UI）
 */

const { app, BrowserWindow, shell, ipcMain, screen, webFrameMain } = require('electron');
const path = require('path');
const { startStaticServer } = require('./static-server');

// マウスのドラッグを「指スワイプ」として扱えるよう、タッチ API（TouchEvent/Touch
// コンストラクタ）を有効化する。タッチ非搭載 PC でもコンストラクタが使えるようになる。
// 実際のマウス→タッチ変換は SYNTH_SRC を iframe に注入して行う（下記）。
app.commandLine.appendSwitch('touch-events', 'enabled');

// ── iPhone デバイス寸法（shell.html と一致させること）──
const SCREEN_W = 390, SCREEN_H = 844;   // iframe（画面）論理サイズ＝常にスマホ UI
const BEZEL_SIDE = 14;                   // 左右ベゼル
const BEZEL_TOP  = 30;                   // 上ベゼル（ダイナミックアイランド用に厚め）
const BEZEL_BOT  = 14;                   // 下ベゼル
const SHADOW   = 36;                      // 影を描くための透明マージン
const BODY_W  = SCREEN_W + BEZEL_SIDE * 2;            // 端末ボディ
const BODY_H  = SCREEN_H + BEZEL_TOP + BEZEL_BOT;
const STAGE_W = BODY_W + SHADOW * 2;      // ウィンドウ（透明マージン込み）
const STAGE_H = BODY_H + SHADOW * 2;

let mainWindow = null;
let staticServer = null;
let waitForOAuthCallback = null;   // static-server が提供する one-shot 待受
let _dragOrigin = null;            // ウィンドウドラッグ移動の基準

// カレンダー本体の iframe（メインワールド）に注入する「マウス→タッチ変換器」。
// 左ボタンのドラッグを touchstart/touchmove/touchend に変換し、指スワイプと同じ
// 操作を可能にする。予定の移動（HTML5 ネイティブ DnD = draggable 要素）は除外する。
const SYNTH_SRC = `(function () {
  if (window.__karSwipeSynthInstalled) return;
  window.__karSwipeSynthInstalled = true;
  if (typeof window.TouchEvent !== 'function' || typeof window.Touch !== 'function') return;

  // スワイプ（マウスドラッグ）で本文テキストが選択されるのを防ぐ。
  // 入力欄/テキストエリア/編集要素では選択・編集を維持する。
  try {
    var st = document.createElement('style');
    st.textContent =
      'html,body{-webkit-user-select:none;user-select:none;}' +
      'input,textarea,select,[contenteditable],[contenteditable=""],[contenteditable="true"]' +
      '{-webkit-user-select:text;user-select:text;}';
    (document.head || document.documentElement).appendChild(st);
  } catch (err) { /* ignore */ }

  var pressed = false, startTarget = null, lastX = 0, lastY = 0, idCounter = 1, identifier = 1;

  function makeTouch(target, x, y) {
    return new Touch({
      identifier: identifier, target: target,
      clientX: x, clientY: y,
      pageX: x + window.scrollX, pageY: y + window.scrollY,
      screenX: x, screenY: y,
      radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1
    });
  }
  function fire(type, target, touches, changed) {
    try {
      target.dispatchEvent(new TouchEvent(type, {
        touches: touches, targetTouches: touches, changedTouches: changed,
        bubbles: true, cancelable: true, composed: true, view: window
      }));
    } catch (err) { /* ignore */ }
  }
  function endGesture() {
    if (!pressed) return;
    fire('touchend', startTarget, [], [makeTouch(startTarget, lastX, lastY)]);
    pressed = false; startTarget = null;
    clearSelection();
  }
  function clearSelection() {
    try { var s = window.getSelection(); if (s && !s.isCollapsed) s.removeAllRanges(); } catch (e2) { /* ignore */ }
  }

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    // 予定のドラッグ＆ドロップ（ネイティブ DnD）と、入力欄/編集要素は合成しない
    // （フィールド内のドラッグはネイティブの選択・編集をそのまま使う）
    if (e.target && e.target.closest && e.target.closest('[draggable="true"], .event-pill, input, textarea, select, [contenteditable], [contenteditable=""], [contenteditable="true"]')) return;
    pressed = true; startTarget = e.target;
    lastX = e.clientX; lastY = e.clientY; identifier = idCounter++;
    var t = makeTouch(startTarget, lastX, lastY);
    fire('touchstart', startTarget, [t], [t]);
  }, true);

  window.addEventListener('mousemove', function (e) {
    if (!pressed) return;
    if (e.buttons === 0) { endGesture(); return; }   // mouseup 取りこぼし回復
    lastX = e.clientX; lastY = e.clientY;
    var t = makeTouch(startTarget, lastX, lastY);
    fire('touchmove', startTarget, [t], [t]);
    clearSelection();   // ドラッグ中に選択が出ないよう即クリア
  }, true);

  window.addEventListener('mouseup', function (e) {
    if (!pressed) return;
    if (e.button === 0) { lastX = e.clientX; lastY = e.clientY; }
    endGesture();   // ネイティブ click より先に touchend を出す
  }, true);

  window.addEventListener('blur', endGesture, true);
  document.addEventListener('pointercancel', endGesture, true);

  // ドラッグ中のテキスト選択を能動的に止める（後付け user-select だけでは効かない環境向け）。
  // pressed は本文ドラッグ時のみ true なので、入力欄/編集要素・通常クリックには影響しない。
  document.addEventListener('selectstart', function (e) { if (pressed) e.preventDefault(); }, true);
})();`;

/** 配信ルート（karenda-）の解決：開発時とパッケージ時で異なる */
function resolveWebRoot() {
  if (app.isPackaged) {
    // electron-builder の extraResources で resources/app-web に同梱
    return path.join(process.resourcesPath, 'app-web');
  }
  return path.join(__dirname, '..', 'karenda-');
}

async function createWindow() {
  const webRoot = resolveWebRoot();
  const shellPath = path.join(__dirname, 'shell.html');
  const started = await startStaticServer(webRoot, shellPath);
  const { server, url } = started;
  staticServer = server;
  waitForOAuthCallback = started.waitForOAuthCallback;

  // 画面に収まるよう必要なら一律縮小（iframe 論理幅 390 は維持＝スマホ UI 不変）
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const scale = Math.min(1, (wa.height * 0.94) / STAGE_H, (wa.width * 0.94) / STAGE_W);
  const contentW = Math.round(STAGE_W * scale);
  const contentH = Math.round(STAGE_H * scale);

  mainWindow = new BrowserWindow({
    width: contentW,
    height: contentH,
    useContentSize: true,
    frame: false,                 // iPhone 風：OS の枠を消す
    transparent: true,            // 角丸・影のために透過
    hasShadow: false,             // native 影は使わず CSS 影を描く
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000', // 完全透過
    title: 'My Calendar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,  // preload を iframe にも注入（OAuth/操作を iframe から利用）
      spellcheck: false
    }
  });

  // 外部リンク（target="_blank" / Anthropic コンソール等）は OS ブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  // 同一オリジン内の通常遷移のみ許可し、外部 URL への離脱はブラウザへ
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    }
  });

  // マウス→タッチ変換器を、カレンダー本体の iframe（子フレーム）のメインワールドへ注入。
  // シェル（メインフレーム）には注入しない＝ベゼルのウィンドウ移動はそのまま。
  const injectInto = (isMainFrame, pid, rid) => {
    if (isMainFrame) return;
    let frame;
    try { frame = webFrameMain.fromId(pid, rid); } catch (_) { return; }
    if (!frame || typeof frame.url !== 'string') return;
    if (!frame.url.startsWith(url) || frame.url.includes('/__shell')) return;
    frame.executeJavaScript(SYNTH_SRC, true).catch(() => {});
  };
  mainWindow.webContents.on('did-frame-finish-load',
    (_e, isMainFrame, pid, rid) => injectInto(isMainFrame, pid, rid));
  mainWindow.webContents.on('did-frame-navigate',
    (_e, _u, _code, _status, isMainFrame, pid, rid) => injectInto(isMainFrame, pid, rid));

  mainWindow.loadURL(`${url}/__shell?scale=${scale}`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── ウィンドウ操作（frameless のため独自に提供）──────────────────────────
ipcMain.handle('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('win:close',    () => { if (mainWindow) mainWindow.close(); });

// ベゼルのドラッグでウィンドウ移動（CSS transform 下でも安定するよう手動実装）
ipcMain.on('win:dragStart', () => {
  if (!mainWindow) return;
  const b = mainWindow.getBounds();
  _dragOrigin = { x: b.x, y: b.y };
});
ipcMain.on('win:dragMove', (_e, dx, dy) => {
  if (!mainWindow || !_dragOrigin) return;
  mainWindow.setPosition(Math.round(_dragOrigin.x + dx), Math.round(_dragOrigin.y + dy));
});
ipcMain.on('win:dragEnd', () => { _dragOrigin = null; });

// ── Google OAuth ブリッジ ──────────────────────────────────────────────
// レンダラ（preload 経由）から認可 URL を受け取り、規定ブラウザで開いて
// /oauth-callback の受信を待ち、{ code } または { error } を返す。
ipcMain.handle('oauth:openExternalAuth', async (_e, authUrl) => {
  if (typeof authUrl !== 'string' || !/^https?:\/\//i.test(authUrl)) {
    return { error: 'invalid_url' };
  }
  if (!waitForOAuthCallback) return { error: 'server_not_ready' };
  const pending = waitForOAuthCallback();   // ブラウザを開く前に待受を開始（取りこぼし防止）
  try {
    await shell.openExternal(authUrl);
  } catch (e) {
    return { error: 'open_external_failed' };
  }
  const result = await pending;
  // 認証後はアプリを前面に戻す
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  return result;
});

// 多重起動防止
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (staticServer) { try { staticServer.close(); } catch (_) {} }
  app.quit();
});
