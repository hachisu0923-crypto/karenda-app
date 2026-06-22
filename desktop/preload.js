'use strict';

/**
 * Electron preload — レンダラ（shell.html とその中の karenda- iframe）に最小限の
 * ブリッジを公開する。contextIsolation 有効下で安全に橋渡しする（Node API は露出しない）。
 *
 * nodeIntegrationInSubFrames:true により、この preload は iframe（カレンダー本体）にも
 * 注入される。そのため iframe 内の app.js は従来どおり window.electronOAuth を参照でき、
 * Google ログイン（PKCE + 規定ブラウザ）がそのまま機能する。
 */

const { contextBridge, ipcRenderer } = require('electron');

// Google OAuth ブリッジ（iframe 内の app.js が使用）
contextBridge.exposeInMainWorld('electronOAuth', {
  openExternalAuth: (url) => ipcRenderer.invoke('oauth:openExternalAuth', url)
});

// ウィンドウ操作ブリッジ（shell.html の枠が使用）
contextBridge.exposeInMainWorld('electronControls', {
  minimize:  () => ipcRenderer.invoke('win:minimize'),
  close:     () => ipcRenderer.invoke('win:close'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('win:setAlwaysOnTop', flag),
  dragStart: () => ipcRenderer.send('win:dragStart'),
  dragMove:  (dx, dy) => ipcRenderer.send('win:dragMove', dx, dy),
  dragEnd:   () => ipcRenderer.send('win:dragEnd')
});
