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
let _idle = false;                 // アイドル（peek）状態か
let _prevAlwaysOnTop = false;      // アイドル前の最前面固定状態（復元用）
let _slideTimer = null;            // スライドアニメの setInterval ハンドル（in-flight）

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
    resizable: true,              // アスペクト比を保ったまま拡大縮小可
    maximizable: false,           // 最大化はアスペクト比を崩すので無効
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

  // アスペクト比を iPhone 枠（STAGE_W:STAGE_H）に固定したままリサイズ可能にする
  mainWindow.setAspectRatio(STAGE_W / STAGE_H);
  // 小さくしすぎないよう下限を設定（上限は画面サイズに任せる）
  mainWindow.setMinimumSize(Math.round(STAGE_W * 0.4), Math.round(STAGE_H * 0.4));

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

// ── アイドル（peek）ジオメトリ計算 ───────────────────────────────────────
// 右下ドック位置と、アイドル/展開の Y を求める。frameless なので getBounds はコンテンツ実px。
function computeDockGeometry() {
  const b = mainWindow.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;   // タスクバー等を除いた作業領域
  const scale = b.height / STAGE_H;                    // 実px/論理px
  const topMargin = SHADOW * scale;                    // ボディ上の透明マージン
  const bodyH = BODY_H * scale;                        // 端末ボディの実高さ
  const dockX = Math.round(wa.x + wa.width - b.width);                      // idle/展開で共通＝横ブレ無し
  const idleY = Math.round(wa.y + wa.height - (topMargin + bodyH / 6));     // 上部1/6+上マージンのみ露出
  const expandedY = Math.round(wa.y + wa.height - b.height);                // 全体を画面内・下端揃え
  return { dockX, idleY, expandedY };
}

// ── スライドアニメ（easeOutCubic）。in-flight は必ずキャンセルしてから開始 ──
// サイズは常に固定で渡す＝setAspectRatio に補正の余地を与えず、x/y だけを動かす。
function animateBounds(targetX, targetY, done) {
  if (!mainWindow) return;
  if (_slideTimer) { clearInterval(_slideTimer); _slideTimer = null; }
  const start = mainWindow.getBounds();
  const fromX = start.x, fromY = start.y;
  const dx = targetX - fromX, dy = targetY - fromY;
  if (dx === 0 && dy === 0) { if (done) done(); return; }
  const DURATION = 260, STEP = 16;
  const t0 = Date.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);          // easeOutCubic
  _slideTimer = setInterval(() => {
    if (!mainWindow) { clearInterval(_slideTimer); _slideTimer = null; return; }
    let p = (Date.now() - t0) / DURATION;
    if (p >= 1) p = 1;
    const e = ease(p);
    mainWindow.setBounds({
      x: Math.round(fromX + dx * e),
      y: Math.round(fromY + dy * e),
      width: start.width, height: start.height          // サイズ固定＝アスペクト比不変
    });
    if (p >= 1) { clearInterval(_slideTimer); _slideTimer = null; if (done) done(); }
  }, STEP);
}

// ── ウィンドウ操作（frameless のため独自に提供）──────────────────────────
ipcMain.handle('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('win:close',    () => { if (mainWindow) mainWindow.close(); });
// 常に最前面（always-on-top）の ON/OFF。シェルのピンボタンから切替・復元される。
ipcMain.handle('win:setAlwaysOnTop', (_e, flag) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!flag);
  return !!flag;
});

// ── アイドル（peek）モード ──────────────────────────────────────────────
// enter: 右下へ沈め、上部1/6だけ露出。常に最前面化し、直前のピン状態を控える。
ipcMain.handle('win:enterIdle', (_e, prevPinned) => {
  if (!mainWindow || _idle) return false;
  _idle = true;
  _prevAlwaysOnTop = (typeof prevPinned === 'boolean')
    ? prevPinned : mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(true);
  const g = computeDockGeometry();
  animateBounds(g.dockX, g.idleY);
  return true;
});
// exit: 下から上へせり上げて全体表示。最前面固定を元のピン状態へ復元。
ipcMain.handle('win:exitIdle', () => {
  if (!mainWindow || !_idle) return false;
  _idle = false;
  const g = computeDockGeometry();
  animateBounds(g.dockX, g.expandedY, () => {
    if (mainWindow) mainWindow.setAlwaysOnTop(_prevAlwaysOnTop);
  });
  return _prevAlwaysOnTop;   // シェルがピンボタン表示を再同期できるよう返す
});

// ベゼルのドラッグでウィンドウ移動（CSS transform 下でも安定するよう手動実装）
ipcMain.on('win:dragStart', () => {
  if (!mainWindow || _idle) return;   // アイドル中はドラッグ起点にしない
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
