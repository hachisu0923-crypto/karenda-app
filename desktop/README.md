# My Calendar — Windows デスクトップ版

既存の Web アプリ `../karenda-`（バニラ HTML/CSS/JS + Supabase の PWA）を、
**スマホ表示（モバイル UI）固定の Windows アプリ**として動かす Electron ラッパーです。
Web アプリ側のコードは一切変更していません。

## しくみ

- アプリ起動時に、内蔵の極小ローカル HTTP サーバ（`static-server.js`、外部依存なし）で
  `../karenda-` を `http://127.0.0.1:<ポート>` として配信します。
- そのページを **幅の狭いウィンドウ（最大 600px）** で読み込みます。
  Web アプリは `@media (max-width: 720px)` でモバイル UI に切り替わるため、
  幅を 600px 以下に固定することで**常にスマホ表示**になります（高さは可変）。
- `file://` ではなく `http://127.0.0.1` で配信するため、`localStorage`（ログイン状態の保持）・
  Service Worker・`manifest.json` が Web 版と同じように動作します。
- 配信ポートは **8923（使用中なら 8924 → 8925）に固定**しています。origin が起動間で
  安定するため、**一度ログインすれば次回以降もログイン状態が維持されます**。

## 開発（ローカルで動作確認）

Node.js がインストールされた環境で:

```bash
cd desktop
npm install
npm start
```

> Linux/macOS でも `npm start` で起動して UI を確認できます（あくまで動作確認用）。

## Windows の .exe を作る

### 方法 A: GitHub Actions（推奨・Windows 不要）

リポジトリに push すると `.github/workflows/build-windows.yml` が動き、
`windows-latest` 上でインストーラとポータブル exe を生成します。

1. GitHub の **Actions** タブ → `build-windows` ワークフロー
2. 完了した実行を開き、**Artifacts** の `my-calendar-windows` をダウンロード
   - `My Calendar Setup 1.0.0.exe` … インストーラ（NSIS）
   - `MyCalendar-1.0.0-portable.exe` … インストール不要のポータブル版
3. （任意）`v1.0.0` のような **タグを push** すると、GitHub Release に自動添付されます。

手動実行する場合は Actions 画面の **Run workflow** ボタンからでも実行できます。

### 方法 B: 手元の Windows PC でビルド

```bash
cd desktop
npm install
npm run dist
```

`desktop/dist/` にインストーラとポータブル exe が出力されます。

## アイコン

`scripts/make-icon.js` が `../karenda-/icon-192.png` から `build/icon.ico` を自動生成します
（`npm run dist` / `npm run pack` の中で実行）。失敗してもビルドは止まらず、
electron-builder の既定アイコンにフォールバックします。

## 既知の制限

- **バックグラウンドのプッシュ通知は届きません。** サーバ送信の Web Push は PWA/スマホ向けの機能です。
  ただし、**アプリ起動中**は予定の「X分前」ローカルリマインダーと当日チェックが動作します。
- Supabase SDK は CDN（jsdelivr）から読み込みます。アプリは元々 Supabase 通信に
  インターネット接続が必要なため、初回起動時もネット接続が必要です。
- レシート読取（Anthropic API）とファイル選択は Web 版と同様に動作します。

## Google ログイン

デスクトップ版では Google ログインに対応しています。Google は埋め込みブラウザでの
認証を拒否するため、**規定の Web ブラウザで認証 → アプリに自動で戻る**方式（PKCE フロー）
を採用しています。

```
Googleボタン → 規定ブラウザで認証 → http://127.0.0.1:8923/oauth-callback に復帰
   → アプリが認証コードを受け取りログイン完了
```

### 初回のみ必要な Supabase 設定

Google ログインを使う前に、Supabase ダッシュボードで以下を 1 回だけ設定してください。

1. **Authentication → URL Configuration → Redirect URLs** に次の 3 つを追加して保存：
   - `http://127.0.0.1:8923/oauth-callback`
   - `http://127.0.0.1:8924/oauth-callback`
   - `http://127.0.0.1:8925/oauth-callback`
   （アプリは 8923 から順に空きポートを使うため、3 つとも登録しておくと確実です）
2. **Authentication → Providers → Google** が有効であること
   （Web 版でログイン画面に Google ボタンが表示されていれば、すでに有効です）。
3. Google Cloud Console 側の変更は不要です（Google のリダイレクト先は Supabase の
   コールバック URL のままで、ループバック URL は Supabase だけが知っていれば十分です）。

> メール / パスワードのログインは設定不要でそのまま使えます。
