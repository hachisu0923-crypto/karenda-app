# ISSUES — karenda 問題棚卸し（セキュリティ除く）

> 監査日: 2026-06-29 / 対象: 作業ツリー現状（未コミット変更を含む）
> 方法: 5つの並列コードレビュー（コア正当性 / 機能ロジック / 保守性 / desktopラッパー / 性能・PWA・データ層）
> **スコープ外**: セキュリティ（認証・秘密鍵・XSS・インジェクション・RLS・CSRF・パストラバーサル等）は本書では扱わない。
> 性質上、**データ消失・破損はセキュリティではなく「正当性バグ」**として本書に含む。

## サマリ

| 深刻度 | 件数 | 概要 |
|---|---|---|
| 🔴 Critical | 9 | データ破損・サイレント消失・コア操作破綻・起動失敗 |
| 🟠 Important | 18 | 実バグ・レース・性能・信頼性 |
| 🟧 構造的負債 | 7 | モノリス／グローバル状態／重複（保守性 **3.5/10**） |
| 🟡 Minor | 16 | 後片付け・地雷・軽微 |

**推奨対応順（影響度 × 修正コスト）**
1. 即修正: [C1](#c1) `month_key`、[C5](#c5) 月送り、[C2](#c2) unique制約、[C6](#c6) budget再フェッチ分離、[M1](#m1) `console.log`削除
2. 次に: [C4](#c4) 孤児行、[C7](#c7) 起動の try/catch＋ポート毎新サーバ、[C8](#c8) ドラッグ固着、[I1](#i1) 一度きり初期化
3. 計画的に: [C3](#c3) 読み書き列の対称化、タイムゾーン統一（[I4](#i4)/[I5](#i5)）、[S1](#s1) `app.js` モジュール分割

---

## 🔴 Critical

<a id="c1"></a>
### C1. 家計簿の `month_key` を「表示中の月」から決めている → 別月に誤保存
- **場所**: `karenda-/app.js:4798`（insert）, `:4815`〜`:4828`（update / `month_key` を更新しない）, 読み側 `:4740` / 繰越 `:4771`
- **問題**: `month_key: _budgetMonthKey()`（= `curDate` の月）。エントリの `date` は任意月を入力できる（`index.html:344` の `type="date"` に min/max 無し）。日付を別月に編集しても `month_key` は据え置きで行が孤立。
- **影響**: 収入/支出/収支と月跨ぎ繰越がサイレントに破損。ユーザーが最も信頼する数字が、エラー無しで狂う。
- **修正**: insert・update 双方で `month_key = entry.date.slice(0,7)` に。既存行は `substr(date,1,7) <> month_key` を backfill 修復。
- [x] **コード修正済み（本セッション）** — insert/update を `monthKeyFromDate(entry.date)` 由来に。※既存の誤った月に保存された行の backfill は別途必要。

<a id="c2"></a>
### C2. 新 base マイグレーションに `(user_id, cat_id)` unique 制約が無い → フレッシュDBが初回ログインで失敗
- **場所**: `karenda-/supabase/migrations/20260219000000_base_events_tasks_categories.sql:60-73` ↔ `karenda-/app.js:644`（`upsert(rows,{onConflict:'user_id,cat_id'})`）
- **問題**: `categories` に `(user_id,cat_id)` の unique が無いと `ON CONFLICT` は `42P10` を送出。`loadFromSupabase()`（`:576`）が初回ログインで既定カテゴリを seed（`saveCategoriesToSupabase` `:642`）する瞬間に発生。
- **影響**: 災害復旧用マイグレーションが本番を再現できず、新規ユーザーのカテゴリ永続化が静かに失敗。目的を自壊。
- **修正**: `create unique index if not exists categories_user_cat_uniq on public.categories (user_id, cat_id);` を追加。`tasks.task_id` / `todos.todo_id` 等、他の `onConflict` 対象も監査。
- [x] **修正済み（本セッション）** — categories に unique index 追加（tasks/todos は upsert 未使用のため見送り）。フレッシュ DB で `supabase db reset` 検証推奨。

<a id="c3"></a>
### C3. 書き込み列（自動検出）と読み込み列（ハードコード）の非対称 → サイレントデータ消失
- **場所**: 書き `detectEventColumns` `karenda-/app.js:667-698` ↔ 読み `loadFromSupabase` `:588-611`
- **問題**: 保存は検出された列名（`endtime` 等にも解決しうる）に書くが、読み込みは固定の allow-list。検出が allow-list 外の列を選ぶと、保存成功・再読込で消失。
- **影響**: 列検出の設計目的（命名ドリフト吸収）が読み側非対応で無効化。潜在的データ消失トラップ。
- **修正**: `loadFromSupabase` でも同じ `detectEventColumns` マップ経由で読む（書き＝読みの対称化）。
- [ ] 未対応

<a id="c4"></a>
### C4. 保存中に削除すると孤児DB行が残り、消せない幽霊予定になる（optimistic-UI レース）
- **場所**: `karenda-/app.js:2002-2004`（addEvent）, `:2050-2052`（addShift）, 削除ハンドラ `:1705-1718`, `deleteEventFromSupabase` `:731`
- **問題**: `await addEventToSupabase` 前に DOM/状態へ反映。await 中に削除すると `ev._dbId` 未確定で `deleteEventFromSupabase` は何もせず return、ローカルは splice。insert は完走しDBに行が残る。
- **影響**: 再読込で幽霊として復活し、UIから二度と消せない。
- **修正**: `_dbId` 確定までは行の削除を無効化／保留キュー化、または insert 完了後に保留削除を実行。
- [ ] 未対応

<a id="c5"></a>
### C5. 月送りが `setMonth` の日付クランプ漏れで月をスキップ（月末バグ）
- **場所**: `karenda-/app.js:2741-2742, 2765-2767, 2776-2777, 2895-2896`（計8箇所）
- **問題**: `curDate.setMonth(curDate.getMonth()±1)` のみ。1/31→「次月」→「2/31」→3/2。**2月が単クリックで到達不能**。今日が29〜31日なら誰でも踏む（`curDate=new Date()`）。
- **影響**: コア操作が月末数日間壊れる。2月が最も被害。
- **修正**: 月変更前に `curDate.setDate(1)`。`goToMonth(delta)` ヘルパに集約。
- [x] **修正済み（本セッション）** — `shiftMonth()`+`lib/date-utils.js` に集約。単体テスト7件＋ライブで Jun→Jul 確認。

<a id="c6"></a>
### C6. `renderAll` が毎描画で「12ヶ月分 Supabaseフェッチ＋12回シフト再計算」
- **場所**: `karenda-/app.js:2948-2950` → `_syncBudgetMonth:4909` →（"常に再フェッチ"）`_fetchPrevMonthData:4859` → `loadBudgetMonthsFromSupabase:4762`。`renderAll` の呼び出しは 20+ 箇所（月送り・キーボード `←/→/t`・予定CRUD/ドラッグ）。
- **影響**: 即時であるべきカレンダー操作がネットワーク律速に。最大の性能欠陥。モバイル不安定回線で「壊れた」体感。
- **修正**: budget 再フェッチを描画から分離（パネル表示中かつ月/データ変化時のみ）。`prevMonthData` を月単位キャッシュし、家計簿変更時だけ無効化。
- [x] **修正済み（本セッション）** — renderAll の同期を `isBudgetPanelVisible()` でゲート＋タブ表示時に同期。ライブでタブ切替を確認。

<a id="c7"></a>
### C7. desktop 起動失敗チェーン: ポートフォールバック破綻 ＋ `createWindow` 例外未処理
- **場所**: `desktop/static-server.js:93`（server を1度だけ生成）, `:158-169`（同一 errored server を使い回し）／`desktop/main.js:130-204`（async・try/catch無し）, `:262`（`.catch` 無し）
- **問題**: `EADDRINUSE` 後の同一 `http.Server` 再 `listen` は不確実 → 8924/8925 への切替が機能しない。サーバ起動が失敗すると `await startStaticServer` が reject、誰も捕捉せず**透明フレームレスウィンドウが出たまま無反応・エラーも exit も無し**。
- **影響**: 引継ぎ.md 記載の「ウィンドウが固まる」既知失敗モードそのもの。8923 が埋まるだけで起動不能・無診断。
- **修正**: ポート毎に **新しい `http.Server`** を生成（または `close()` 後に再生成）。`createWindow` を try/catch で包み、失敗時に `dialog.showErrorBox`（既存の日本語メッセージを表示）→ `app.quit()`。
- [ ] 未対応

<a id="c8"></a>
### C8. window ドラッグで `iframe.pointerEvents='none'` が外れず固着
- **場所**: `desktop/shell.html:198-217`（`:203` で無効化 / `:212` の `window` `mouseup` 依存）
- **問題**: 画面外（別アプリ上）でボタンを離すと `window` の `mouseup` を取り逃し、`dragging=true` と `pointerEvents='none'` が残存。
- **影響**: カレンダーiframe がクリック不能のまま固まる（main.js は `:100` で同じ教訓を学習済みだが shell.html 未対応）。
- **修正**: Pointer Capture（`setPointerCapture`）＋ `finally` 相当で必ず `pointerEvents` 復帰。`window` の `mouseup`/`blur`/`mouseleave` を購読。
- [ ] 未対応

<a id="c9"></a>
### C9. マイグレーション集合が冪等でない（再適用で `42710`）
- **場所**: `karenda-/supabase/migrations/` の overtime / daily_drinks / push_subscriptions（`DROP POLICY IF EXISTS` 無しの `CREATE POLICY`）
- **問題**: `supabase db reset` や再適用で「policy already exists」。base 単体は冪等だが集合として再現不可。
- **修正**: 各 `create policy` の前に `drop policy if exists "<name>" on <table>;`（base/budget_source の既存パターンに合わせる）。
- [ ] 未対応

---

## 🟠 Important

<a id="i1"></a>
### I1. `showApp` が `TOKEN_REFRESHED` で毎回フル再初期化 → interval/リスナー累積
- **場所**: `karenda-/app.js:1198-1208` → `:997-1017`。`initNotifications:366,371-374`（60秒/24時間 `setInterval`）, `initBottomPanelResize/Swipe:4038/4048/4056`（document リスナー）, `initBudgetPanel:4968-5042` / `initTaskPanel`（フォームハンドラ）。
- **影響**: 1時間毎のトークン更新で多重化。長時間セッション後は**1操作で N回 Supabase 書き込み**、通知チェッカも多重。
- **修正**: interval と document/フォームのワンタイム配線を「初期化済みフラグ」でガード、またはブートストラップ一度きりへ移動。更新時はデータ再読込のみ。
- [ ] 未対応

<a id="i2"></a>
### I2. 全 grid `innerHTML=''` 再構築＋セル毎リスナー再バインド（委譲なし）
- **場所**: `karenda-/app.js:1359`（`grid.innerHTML=''`）, `:1387-1393`（セル3リスナー）, `:1469,1472-1478`（ピル毎）
- **影響**: 1回の月送りで数百のDOM操作＋~150リスナー登録。[C6](#c6) と合わせ「全DOM再構築＋ネットワーク」。
- **修正**: `#js-cal-grid` に `dragover`/`drop`/`click` を**1度だけ**バインドし `e.target.closest('.day-cell')`＋`dataset.dateKey` で解決。将来はセル差分更新。
- [ ] 未対応

<a id="i3"></a>
### I3. `matchMedia` をピル毎ループ内で評価（レイアウトスラッシュ）
- **場所**: `karenda-/app.js:1451,1458`（`buildCell:1381` 内）, `isNarrowScreen:163-165`
- **影響**: 35〜42セル×最大3ピルで1描画 100+ 回の style flush。ビューポート幅は描画中不変なのに無駄。
- **修正**: `renderMain`/`renderAll` 冒頭で `const narrow = isNarrowScreen()` を1度評価し渡す。
- [ ] 未対応

<a id="i4"></a>
### I4. タイムゾーン月バケツ: `new Date('YYYY-MM-DD')` の UTC parse で前月に誤計上
- **場所**: `karenda-/app.js:937`（`monthlyCashoutsByCat`）, `:516-517`（`monthlySalaryToDate`）, 履歴 `:2396,2401`
- **影響**: UTC負オフセット圏で1日の給料/キャッシュアウトを前月集計。JST(+9)では顕在化しないが潜在バグ。
- **修正**: `new Date(key+'T00:00:00')` か、`key.slice(0,7) === \`${y}-${pad(m+1)}\`` の文字列比較（`dateKey()` と整合）。
- [ ] 未対応

<a id="i5"></a>
### I5. `_dateAddDays` が UTC 往復で1日ズレ（正しい兄弟と二重実装）
- **場所**: `karenda-/app.js:4160-4164`（`toISOString().slice(0,10)`）。正: `_addDaysToStr:271-275`。利用先 `_formatGoalDate:4167`。
- **影響**: JST で「今日/明日」ラベルや目標日が1日ズレ（主対象ユーザーで顕在）。
- **修正**: ローカル getter で整形 or `_addDaysToStr` に統合（`_dateAddDays` は冗長）。
- [ ] 未対応

<a id="i6"></a>
### I6. `calcShift` が end≤start を無警告で +24時間
- **場所**: `karenda-/app.js:448-449`（`if (total <= 0) total += 1440`）
- **影響**: 17:00→07:00 の打ち間違いを14h夜勤として誤請求。start==end も24h。
- **修正**: end<start で「夜勤?」警告。`total===0` は0分（`<=` を `<` に）。
- [ ] 未対応

<a id="i7"></a>
### I7. 日/週ビューが逆転・日跨ぎ時刻で崩れる
- **場所**: `karenda-/app.js:3570-3573,3600`（日）, `:3789-3791,3811`（週）
- **影響**: start>end や深夜跨ぎで重なり計算が誤り、ブロックが誤った列/位置に描画。
- **修正**: レイアウト前に `if (endMin < startMin) endMin += 1440` で正規化（`calcShift` と整合）し overlap 判定をガード。
- [ ] 未対応

<a id="i8"></a>
### I8. `timeStrToMin` が不正入力で `NaN` を返す → 予定が消える
- **場所**: `karenda-/app.js:3463-3467`
- **問題**: `"9"`（コロン無し）→ `9*60+NaN=NaN`。`=== null` でないため timed 扱いされ `top=NaN`px で消失。all-day 判定も崩れる。
- **修正**: `/^(\d{1,2}):(\d{2})$/` で検証し失敗時 `null`。
- [ ] 未対応

<a id="i9"></a>
### I9. Google サインイン二度押しで login が5分ロック
- **場所**: `desktop/main.js:230-248`、`waitForOAuthCallback`（`static-server.js:86-91` が `_pendingResolve` を無条件クロバー）
- **影響**: 2回目の `openExternalAuth` が1回目の resolver を上書き、1回目は5分タイムアウトまで解決せず login UI がハング。
- **修正**: 進行中なら新規を即 reject（`in_progress`）または旧 timer/resolver を破棄して再武装。
- [ ] 未対応

<a id="i10"></a>
### I10. OAuth タイムアウト後の遅延コールバックで「ブラウザ成功/アプリ失敗」食い違い
- **場所**: `desktop/static-server.js:113-122`（waiter 無しでも 200 OK）, timeout `:86-91`
- **修正**: `state` に nonce を持たせ一致時のみ resolve。waiter 不在時は「アプリに戻ってください」ページを返す。
- [ ] 未対応

<a id="i11"></a>
### I11. Service Worker: デプロイ後の再接続で古い資産配信＋クロスオリジン傍受
- **場所**: `karenda-/sw.js:2,9,25-29`
- **問題**: `app.js`/`style.css` にハッシュ無し、無効化は `CACHE_NAME` 手動バンプ依存。`fetch` ハンドラが全GET（CDN/Supabase/YouTube）を傍受。
- **修正**: 同一オリジンのみに限定（`if (new URL(req.url).origin !== location.origin) return;`）。ファイル名バージョニング or デプロイ毎に `CACHE_NAME` 自動更新、stale-while-revalidate。
- [ ] 未対応

<a id="i12"></a>
### I12. 当月シフト給が家計簿「収入」合計に未計上（サイドバーと不一致）【要・意図確認】
- **場所**: `karenda-/app.js:5199-5211`（`renderBudgetPanel`）。サイドバーは `renderSalarySummary:1212`/`monthlySalary:475` で当月分を表示。
- **問題**: `totalIncome` に当月シフト給が入らず、当月は繰越（翌月 `:5147-5158`）でのみ現れる。コメント `:5184` 的に意図的かもしれない。
- **修正（意図でなければ）**: 当月の `_collectShiftsForMonth(...).totalShiftPay` を `totalIncome` に加算。
- [ ] 未対応（要確認）

<a id="i13"></a>
### I13. タイマービープが背景タブで無音化
- **場所**: `karenda-/app.js:3268-3283`（`audioCtx.resume()` 未await、`currentTime` 即読み）。`tick` は250ms `setInterval` で背景throttle。
- **修正**: `resume().then(() => { /* ここでオシレータ予約 */ })`。通知経路を主シグナルに。
- [ ] 未対応

<a id="i14"></a>
### I14. static-server が I/Oエラーを一律 404 で隠す
- **場所**: `desktop/static-server.js:142-154`（`fs.readFile` 失敗→常に404）
- **影響**: `EACCES`/`EMFILE`/`EISDIR` が「Not Found」に偽装され、同時アセット読み込み時の `EMFILE` が誤った404→UI崩れに。
- **修正**: `rErr.code` で分岐（`ENOENT`/`ENOTDIR`→404、他→500＋ログ）。
- [ ] 未対応

<a id="i15"></a>
### I15. MIME マップに `.wasm` 等が欠落
- **場所**: `desktop/static-server.js:23-42`
- **影響**: `.wasm` が `application/octet-stream` で `WebAssembly.instantiateStreaming` 破綻。`.xml`/`.mp3`/`.wav` も無し。
- **修正**: `.wasm:'application/wasm'` 等を追加。
- [ ] 未対応

<a id="i16"></a>
### I16. `mailto:`/`tel:`/`blob:`/`data:` 外部リンク・DLを黙殺
- **場所**: `desktop/main.js:171-184`（`setWindowOpenHandler`/`will-navigate` が http(s) のみ）
- **影響**: 将来のエクスポート(.ics/レシート画像)等が無反応に。
- **修正**: `mailto:`/`tel:` は `shell.openExternal`、`blob:`/`data:` DL を許可（`will-download` 配線）。
- [ ] 未対応

<a id="i17"></a>
### I17. SYNTH_SRC 再注入の契約が曖昧（`did-frame-finish-load` + `did-frame-navigate` 二重購読）
- **場所**: `desktop/main.js:188-199`、ガード `SYNTH_SRC:43-44`（`window.__karSwipeSynthInstalled`）
- **影響**: 同一ドキュメント維持の soft reload では再注入されずスワイプが沈黙する可能性。二重購読は冗長で危険。
- **修正**: イベントを1本化（`did-frame-navigate`）、もしくは「常にフルロード」前提を明文化し冗長購読を削除。
- [ ] 未対応

<a id="i18"></a>
### I18. `createWindow` 再呼び出しガード無し（`activate` 経由でサーバ二重bindリーク）
- **場所**: `desktop/main.js:264`（`app.on('activate')`）, `:196-199`（listeners 未除去）
- **影響**: macOS の dock-activate 等で2度目の `startStaticServer` が [C7](#c7) 経路で失敗、旧 `staticServer` を `close()` せず上書きしリーク。
- **修正**: 冒頭で `if (mainWindow) { mainWindow.focus(); return; }`。既存サーバを再利用。
- [ ] 未対応

---

## 🟧 構造的負債（保守性 3.5/10）

<a id="s1"></a>
### S1. `app.js` がモノリス（5,759行 / 136関数 / 単一グローバルスコープ）
`import/export` ゼロ、`<script src>` 読み込み。87個のコメント罫線が擬似モジュール代わり。データ層(19 `*Supabase`)・描画(22 `render*`)・イベント配線が完全に interleave。**最優先の構造改善: 機能別 ES モジュール分割。**

<a id="s2"></a>
### S2. グローバル可変状態が約20箇所に散在＋parse-time 副作用
`app.js:108-121,154,665,1196,2100,...`。`applyTheme:2955`/IIFE`:2959`/133個の top-level `addEventListener` が副作用実行。初期化順が暗黙で `renderAll` が自分の状態を `typeof` ガード（`:2944,2948`）。**集中管理（state/storageキー/DBスキーマ名を定数化）。**

<a id="s3"></a>
### S3. 二つの作法が混在
旧部は `const`/arrow。新部（家計簿/レシートOCR `:5092-5759`）は ES5 `var`＋`function(){}`＋`\uXXXX`エスケープ（`:5143` 等）が UTF-8 リテラル（`:5556`）と同居。**規約未整備のドリフトの証拠。**

<a id="s4"></a>
### S4. 日付/整形ヘルパの重複（4〜10回）
`dateKey:150`/`formatYMD:3901`/`_pad2:3890` があるのに手書き `padStart` ~10×、`_addDaysToStr`(`:271`) と `_dateAddDays`(`:4160`) は挙動が違う二重実装（[I5](#i5)）。**正準ヘルパに集約。**

<a id="s5"></a>
### S5. 支出/収入のコピペ並行構造
`budgetExpenseCats`/`budgetIncomeCats` 等の双子配列を `mode==='budget_exp'?...:'budget_inc'?...` の三項で ~10箇所（`:2620-2621,2814-2821`）。片側変更は手動ミラー必須。

<a id="s6"></a>
### S6. マジック文字列（DB名・localStorageキー）
`.from('events')`×6 等の表/列名がベタ書き、列名定数なし。localStorageキーが定数(`NOTIF_STORAGE_KEY`)とリテラル(`'kuro_budget_exp_cats':4722`,`'cal_dark':118`)混在、名前空間 `cal_*`/`kuro_*`/`*_v1` 不統一。

<a id="s7"></a>
### S7. CSS 重複・デッドルール
`.template-chip`/`.tpl-section`/`.tpl-input` が2箇所重複（`style.css:2021/2315,2063/2334,2086/2358`、片方だけ差分ドリフト）。死にCSS `.apikey-hint/.apikey-link/.bp-hint/.budget-cat-pct`。

---

## 🟡 Minor / 後片付け

<a id="m1"></a>
- **M1**: デバッグ `console.log('events カラム名:', cols)` 残存 — `app.js:673`
- **M2**: 死にレシート解析コードに `fetch('about:blank',{method:'POST'})` 地雷（早期 `return` で現在は到達不能だが暴発リスク）— `app.js:5492-5573`。**完全削除推奨。**
- **M3**: 重複ヘルパ `escHtml`(`:2902`)/`escapeHtml`(`:3892`)、`_todayStrLocal`/`_todayStr`
- **M4**: `checkAndSendNotifications` が存在しない `ev.timeStart` を読むため通知に時刻が出ない — `app.js:433`（`ev.time` にすべき）
- **M5**: ログイン時の二重 `renderAll`（`:1012-1013`）
- **M6**: `getHolidayName` が空キーで throw（`:137-139`）／`loadFromSupabase` が null `date_key` で `events[undefined]` を生成（`:589-590`）
- **M7**: 123KB 未minify CSS が render-blocking（`index.html:14`）
- **M8**: SRI 1点固定で CDN 再公開/404時に起動不能、ローカルfallback無し — `index.html:16`（self-host 検討）
- **M9**: `make-icon.js:40` の `main()` 未await・`.catch` 無し（"失敗してもビルド継続"契約と矛盾、新Nodeで build 中断の恐れ）
- **M10**: frameless ウィンドウを画面外へドラッグ可能・clamp無しで回収困難 — `main.js:221-224`
- **M11**: ステータス時計が分表示なのに1秒 `setInterval` — `shell.html:162`
- **M12**: `/__shell` を毎リクエスト disk 読み・読みエラー無ログ — `static-server.js:104-108`
- **M13**: SYNTH が全 `.event-pill` を touch変換除外するが draggable は `_dbId` 有る物だけ → スワイプ挙動不一致 — `main.js:91` ↔ `app.js:1470-1471`
- **M14**: 全アセット `Cache-Control:no-cache`・ETag無しで毎回再取得 — `static-server.js:149-153`
- **M15**: base マイグレーションの PK 戦略不統一（`bigserial` ↔ `identity`）
- **M16**: OAuth タイムアウト5分は2FA/同意で短すぎる場合 — `static-server.js:86-91`

---

## メタ
- 本書は読み取り専用監査の結果であり、コードは未変更。
- 多くの Critical/重要項目が**未コミットの作業ツリー変更**（家計簿 `month_key`、新マイグレーション、CSP対応の `app-init.js`、無効化レシートコード）に関係。
- 関連: `引継ぎ.md`（設計の要点・既知の失敗モード）。
