'use strict';

/**
 * Electron preload — レンダラ（karenda- の Web アプリ）に最小限の OAuth ブリッジを公開する。
 * contextIsolation 有効下で安全に橋渡しする（Node API はレンダラに露出しない）。
 *
 * window.electronOAuth の存在を以て app.js は「Electron 上で動作中」と判定し、
 * Google ログインを PKCE + 外部ブラウザ方式に切り替える。Web ブラウザでは
 * このオブジェクトは存在しないため、Web 版の挙動は一切変わらない。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronOAuth', {
  // 認可 URL を OS の規定ブラウザで開き、/oauth-callback の受信を待って
  // { code } または { error } を返す。
  openExternalAuth: (url) => ipcRenderer.invoke('oauth:openExternalAuth', url)
});
