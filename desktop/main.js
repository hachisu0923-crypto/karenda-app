'use strict';

/**
 * My Calendar (karenda) — Electron メインプロセス
 *
 * 既存の Web アプリ（../karenda-）をアプリ内のローカル HTTP サーバで配信し、
 * 幅を狭く固定したウィンドウで読み込むことで「常時スマホ表示」のデスクトップアプリにする。
 * Web アプリ側のコードは一切変更しない。
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { startStaticServer } = require('./static-server');

// スマホ表示を確実にするためのウィンドウ寸法（コンテンツ領域）
const PHONE_WIDTH  = 390;   // mobile-preview.html の既定（iPhone 14）に合わせる
const PHONE_HEIGHT = 844;
const MIN_WIDTH = 340, MIN_HEIGHT = 560;
const MAX_WIDTH = 600;      // <720px に固定 → 常にモバイル UI（@media max-width:720px）
const MAX_HEIGHT = 4000;    // 高さは実質無制限

let mainWindow = null;
let staticServer = null;

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
  const { server, url } = await startStaticServer(webRoot);
  staticServer = server;

  mainWindow = new BrowserWindow({
    width: PHONE_WIDTH,
    height: PHONE_HEIGHT,
    useContentSize: true,          // 寸法はコンテンツ領域基準（innerWidth が breakpoint 判定に直結）
    autoHideMenuBar: true,         // File/Edit メニューを隠してスマホ風に
    backgroundColor: '#ffffff',
    title: 'My Calendar',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // 幅を <720px に固定（広げてもデスクトップ UI に切り替わらない）。高さは可変。
  mainWindow.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
  mainWindow.setMaximumSize(MAX_WIDTH, MAX_HEIGHT);

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

  mainWindow.loadURL(url);

  mainWindow.on('closed', () => { mainWindow = null; });
}

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
