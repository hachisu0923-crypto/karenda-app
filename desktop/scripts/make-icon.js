'use strict';

/**
 * Windows 用アイコン (build/icon.ico) を Web アプリの PNG から生成する。
 * icon-192.png（192px ≤ 256 で ICO として有効）を入力に使う。
 * 失敗してもビルドは止めない（electron-builder の既定アイコンにフォールバック）。
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const srcPng = path.join(__dirname, '..', '..', 'karenda-', 'icon-192.png');
  const outDir = path.join(__dirname, '..', 'build');
  const outIco = path.join(outDir, 'icon.ico');

  if (!fs.existsSync(srcPng)) {
    console.warn('[make-icon] 入力 PNG が見つかりません:', srcPng, '— スキップします');
    return;
  }

  let pngToIco;
  try {
    pngToIco = require('png-to-ico');
  } catch (e) {
    console.warn('[make-icon] png-to-ico が未インストールです — スキップします');
    return;
  }

  try {
    fs.mkdirSync(outDir, { recursive: true });
    const buf = await pngToIco(srcPng);
    fs.writeFileSync(outIco, buf);
    console.log('[make-icon] 生成しました:', outIco);
  } catch (e) {
    console.warn('[make-icon] icon.ico の生成に失敗しました:', e && e.message ? e.message : e);
  }
}

main();
