/* ============================================================
   app.js — Calendar Application + Supabase sync
   ============================================================ */
'use strict';

// ── Login diagnostics (helps when auth fails) ─────────────────────────────────
function _fmtErr(e){
  if(!e) return '';
  if(typeof e === 'string') return e;
  const parts = [];
  if(e.message) parts.push(e.message);
  if(e.status) parts.push(`status=${e.status}`);
  if(e.code) parts.push(`code=${e.code}`);
  if(e.details) parts.push(`details=${e.details}`);
  if(e.hint) parts.push(`hint=${e.hint}`);
  try{
    // Supabase errors sometimes include __isAuthError / name
    if(e.name && !parts.includes(e.name)) parts.push(`name=${e.name}`);
  }catch(_){}
  return parts.join(' / ');
}

function _envHints(){
  const hints = [];
  if (location.protocol === 'file:') {
    hints.push('いま file:// で開いています。Authのリダイレクトやセッション保存が不安定になるので、VSCode Live Server などで http://localhost で開いてください。');
  }
  hints.push(`origin=${location.origin}`);
  return hints.join('\n');
}

// 捕捉できない例外も画面に出す（ログイン押して無反応…を潰す）
window.addEventListener('error', (ev) => {
  const box = document.getElementById('js-auth-error');
  if(!box) return;
  box.style.display = 'block';
  box.textContent = `エラー: ${ev.message}\n${_envHints()}`;
});
window.addEventListener('unhandledrejection', (ev) => {
  const box = document.getElementById('js-auth-error');
  if(!box) return;
  box.style.display = 'block';
  box.textContent = `Promiseエラー: ${_fmtErr(ev.reason)}\n${_envHints()}`;
});


// ── Supabase ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://oungvayvmxkszsokxwxd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91bmd2YXl2bXhrc3pzb2t4d3hkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDEyODgsImV4cCI6MjA4NzA3NzI4OH0.pfwa_xQDlm6Mba3Rw4hx2V9LB1Qf__EioCW-NOGHenQ';

const _sb = window.supabase;
if (!_sb || typeof _sb.createClient !== 'function') {
  console.error('Supabase SDK not loaded. Check the <script> tag for @supabase/supabase-js.');
}
const { createClient } = _sb || {};
// Electron デスクトップ版（window.electronOAuth が preload で注入される）では
// Google ログインを PKCE フローで行うため flowType を切り替える。
// Web ブラウザでは _electronAuthOpts は undefined となり、従来どおりの挙動。
const _electronAuthOpts = (typeof window !== 'undefined' && window.electronOAuth)
  ? { auth: { flowType: 'pkce', detectSessionInUrl: false } }
  : undefined;
const db = createClient ? createClient(SUPABASE_URL, SUPABASE_KEY, _electronAuthOpts) : null;

function ensureDb(){
  if(db) return true;
  showAuthMsg('Supabase SDK の読み込みに失敗しています。ネットワーク/拡張機能/HTMLの<script>読み込み順を確認してください。', true);
  return false;
}



// ── Constants ─────────────────────────────────────────────────────────────────

const MONTHS_EN = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
const MONTHS_INIT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS_JA = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const DAYS_JA   = ['日','月','火','水','木','金','土'];

const PRESET_COLORS = [
  '#e03131','#c2255c','#9c36b5','#6741d9','#3b5bdb','#1971c2',
  '#0c8599','#087f5b','#2f9e44','#74b816','#e67700','#f76707',
  '#ff6b6b','#748ffc','#63e6be','#a9e34b','#ffd43b','#845ef7'
];

const DEFAULT_CATEGORIES = [
  { id:1, name:'仕事',   color:'#e67700', type:'normal',
    templates:[
      { label:'定例ミーティング', title:'定例ミーティング', start:'10:00', end:'11:00' },
      { label:'ランチ', title:'ランチ', start:'12:00', end:'13:00' }
    ]
  },
  { id:2, name:'個人',   color:'#845ef7', type:'normal' },
  { id:3, name:'健康',   color:'#2f9e44', type:'normal' },
  { id:4, name:'締切',   color:'#e03131', type:'normal' },
  { id:5, name:'バイト', color:'#1971c2', type:'shift', hourlyWage:1100,
    templates:[
      { label:'夕方', start:'17:00', end:'22:00', breakMin:60 },
      { label:'昼間', start:'10:00', end:'15:00', breakMin:45 }
    ]
  }
];

// ── State ─────────────────────────────────────────────────────────────────────

let categories     = [];
let events         = {};          // { dateKey: [ eventObj, … ] }
let projects       = [];   // [{id, _dbId, name, color, archived, createdAt}] 作業テーマ
let overtimeCashouts = [];        // [{ id, catId, minutes, note, dateKey, createdAt }]
let dailyDrinks      = {};        // { dateKey: count }
let curDate        = new Date();
let selectedKey    = null;
let selectedCatId  = null;
let editingCats    = [];
let colorTargetIdx = null;
let _colorMode     = 'calendar'; // 'calendar' | 'budget_exp' | 'budget_inc'
let isDark         = loadLocalJSON('cal_dark') ?? true;   // Obsidian の既定はダーク
let activeTab      = 'event';
let currentUser    = null;
let currentView    = 'month';  // 'month' | 'week' | 'day' | 'budget' | 'goal' | 'task' | 'graph'

// ── Graph view state ──
// ここで宣言するのは位置の問題: applyTheme() はブートストラップで走り
// _graphTheme を読む。ファイル末尾で let すると TDZ に入り、起動時に
// ReferenceError で app.js 全体が止まる（VIEW_ELS 以降が全部消える）。
let _graphSim = null;      // 現在のシミュレーション
let _graphData = null;     // 現在の { nodes, edges, adj }
let _graphWindow = null;   // 組み立て済みの窓の起点（'YYYY-MM-DD'。常に今日）
let _graphCam = { zoom: 1, tx: 0, ty: 0 };
let _graphRaf = null;      // 動いているフレームループ / 予約された単発フレーム
let _graphHover = null;    // ホバー中のノード id（隣接以外を減光する）
let _graphDrag = null;     // ドラッグ中のノード
// アクティブなポインタ（pointerId -> 直近の座標）。iOS のピンチは gesture 系が
// アプリ全体で preventDefault 済み（:3099）なので、2点の距離比で自前に測る。
let _graphPointers = new Map();
// canvas は CSS 変数を読めないので getComputedStyle で拾って持つ。捨てるのは applyTheme()。
let _graphTheme = null;

// ── Japan Holidays ─────────────────────────────────────────────────────────────

const _holidays = {};  // { year: { 'YYYY-MM-DD': '祝日名' } }

async function fetchHolidays(year) {
  if (_holidays[year] !== undefined) return;
  _holidays[year] = {};  // mark in-progress to prevent duplicate requests
  try {
    const res = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
    if (!res.ok) return;
    _holidays[year] = await res.json();
  } catch(e) { console.warn('祝日取得失敗', e); }
}

function getHolidayName(key) {
  // key = 'YYYY-MM-DD'
  return (_holidays[+key.slice(0,4)] || {})[key] || '';
}

// ── Local helpers (theme / misc only — data lives in Supabase) ────────────────

function loadLocalJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveLocalJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function dateKey(y, m, d) {
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

let _catMap = new Map();
function rebuildCatMap() { _catMap = new Map(categories.map(c => [c.id, c])); }

function getCat(id)   { return _catMap.get(id); }
function normalCats() { return categories.filter(c => c.type !== 'shift'); }
function shiftCats()  { return categories.filter(c => c.type === 'shift'); }
function isShift(id)  { return getCat(id)?.type === 'shift'; }

// スマホ幅（モバイル UI）かどうか。月表示の簡素化などに使用。
function isNarrowScreen() {
  return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
}

// 月セル用：開始時刻 "HH:MM" を指す小さなアナログ時計アイコン。
// 文字盤の色で時間帯を示す（午前 0:00–11:59 = オレンジ / 午後・夜 12:00–23:59 = 青）。針のみ。
function clockGlyph(hhmm) {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!mt) return '';
  const h = +mt[1], mn = +mt[2];
  const cls = h < 12 ? 'is-am' : 'is-pm';
  const minAng = mn * 6;                 // 分針: 360/60
  const hrAng  = (h % 12) * 30 + mn * 0.5; // 時針: 360/12 + 分の寄与
  const pt = (a, l) => {
    const r = (a - 90) * Math.PI / 180;
    return [(8 + l * Math.cos(r)).toFixed(1), (8 + l * Math.sin(r)).toFixed(1)];
  };
  const [hx, hy] = pt(hrAng, 3.1);
  const [mx, my] = pt(minAng, 4.8);
  return `<svg class="event-pill-clock ${cls}" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">`
    + `<circle class="epc-face" cx="8" cy="8" r="7" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>`
    + `<line x1="8" y1="8" x2="${hx}" y2="${hy}" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`
    + `<line x1="8" y1="8" x2="${mx}" y2="${my}" stroke="#fff" stroke-width="1" stroke-linecap="round"/>`
    + `<circle cx="8" cy="8" r="0.9" fill="#fff"/></svg>`;
}

function catCounts() {
  // カテゴリ別の「今月の予定数」を集計（サイドバー表示用）
  const y = curDate.getFullYear();
  const m = curDate.getMonth();
  const dim = new Date(y, m + 1, 0).getDate();
  const c = Object.fromEntries(categories.map(cat => [cat.id, 0]));
  for (let d = 1; d <= dim; d++) {
    const key = dateKey(y, m, d);
    (events[key] || []).forEach(ev => {
      if (c[ev.catId] !== undefined) c[ev.catId]++;
    });
  }
  return c;
}

// ── Push Notification ─────────────────────────────────────────────────────────

// VAPID public key（Edge Function の VAPID_PUBLIC_KEY と一致させること）
const VAPID_PUBLIC_KEY = 'BHHdWaRp_PkaJ49UF_c7pW7deXy79CtIx8K3SZ-gK18i7C-PjbYuBqhdEDzI7lUwp0NfSIqUEMPs5ra9IE4fiQg';

function _urlBase64ToUint8Array(base64String) {
  const pad = '='.repeat((4 - base64String.length % 4) % 4);
  const b64 = (base64String + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** サーバー Push 購読を取得・保存する */
async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!currentUser || !db) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // VAPID 公開鍵が変わっていたら古い購読を破棄して再購読
    if (sub && sub.options?.applicationServerKey) {
      const cur  = new Uint8Array(sub.options.applicationServerKey);
      const want = _urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      const same = cur.length === want.length && cur.every((b, i) => b === want[i]);
      if (!same) { try { await sub.unsubscribe(); } catch (_) {} sub = null; }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const j = sub.toJSON();
    await db.from('push_subscriptions').upsert({
      user_id:  currentUser.id,
      endpoint: j.endpoint,
      p256dh:   j.keys.p256dh,
      auth:     j.keys.auth
    }, { onConflict: 'user_id,endpoint' });
  } catch (e) {
    console.warn('Push subscription failed:', e);
  }
}

const NOTIF_STORAGE_KEY = 'notified_keys_v1';

function _getNotifiedKeys() {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // 今日の日付キーのみ保持（昨日以前は自動削除）
    const today = _todayStrLocal();
    if (parsed._date !== today) return {};
    return parsed;
  } catch { return {}; }
}

function _saveNotifiedKeys(keys) {
  keys._date = _todayStrLocal();
  localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(keys));
}

function _todayStrLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _addDaysToStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _diffDays(dateStr) {
  const today = new Date(_todayStrLocal() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

async function _showNotif(title, body, tag) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body, tag, icon: '' });
  } catch {
    new Notification(title, { body, tag });
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ── 通知有効化ボタン（タップ起点での許可取得：iOS / Chrome の必須要件）──────

const _isStandalone = () => window.navigator.standalone === true
  || window.matchMedia('(display-mode: standalone)').matches;
const _isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);  // iPadOS

// ボタンは <svg>＋<span> の2要素。btn.textContent への代入はアイコンごと
// 消してしまうので、ラベルとアイコンを個別に差し替える。
function _setNotifBtn(icon, label) {
  const use = document.querySelector('#js-notif-btn .svg-icon use');
  const lbl = document.getElementById('js-notif-label');
  if (use) use.setAttribute('href', `#lucide-${icon}`);
  if (lbl) lbl.textContent = label;
}

function _updateNotifBtn() {
  const btn = document.getElementById('js-notif-btn');
  if (!btn) return;
  if (!('Notification' in window)) {
    // iOS Safari（未インストール）は通知 API 自体が無い → 案内導線として表示を残す
    if (_isIOS() && !_isStandalone()) { _setNotifBtn('bell', '通知を有効にする'); return; }
    btn.style.display = 'none';
    return;
  }
  const p = Notification.permission;
  btn.classList.toggle('is-on', p === 'granted');
  btn.classList.toggle('is-denied', p === 'denied');
  if (p === 'granted')      _setNotifBtn('bell', '通知 ON（テスト送信）');
  else if (p === 'denied')  _setNotifBtn('bell-off', 'ブラウザ設定で許可が必要');
  else                      _setNotifBtn('bell', '通知を有効にする');
}

document.getElementById('js-notif-btn')?.addEventListener('click', async () => {
  // iOS でホーム画面に追加されていない（or 通知 API なし）→ 追加手順を案内
  if (_isIOS() && !_isStandalone()) { openOverlay('js-ios-guide-overlay'); return; }
  if (!('Notification' in window)) {
    if (_isIOS()) { openOverlay('js-ios-guide-overlay'); return; }
    alert('このブラウザは通知に対応していません。');
    return;
  }
  if (Notification.permission === 'denied') {
    alert('通知がブロックされています。ブラウザの設定（サイトの権限）からこのサイトの通知を許可してください。');
    return;
  }
  const granted = await requestNotificationPermission();
  if (granted) {
    await subscribeToPush();
    checkAndSendNotifications();
    _showNotif('🔔 通知テスト', '通知はこのように届きます');
  }
  _updateNotifBtn();
});

document.getElementById('js-ios-guide-close')?.addEventListener('click', () => closeOverlay('js-ios-guide-overlay'));
document.getElementById('js-ios-guide-ok')?.addEventListener('click', () => closeOverlay('js-ios-guide-overlay'));
document.getElementById('js-ios-guide-overlay')?.addEventListener('click', e => {
  if (_isBackdropClick(e, 'js-ios-guide-overlay')) closeOverlay('js-ios-guide-overlay');
});

// ログイン後に呼ぶ：許可済みなら Push 購読を更新し、当日分チェック
// ※許可ダイアログは自動では出さない（iOS / Chrome はユーザー操作起点が必須）。
//   未許可の場合はサイドバーの通知ボタン（js-notif-btn）から取得する。
async function initNotifications() {
  _updateNotifBtn();
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    checkAndSendNotifications();
    subscribeToPush();   // 購読を最新化（VAPID 鍵変更時は再購読）
  }

  // 予定の「X分前」リマインダーを 1 分間隔でチェック（許可状態は内部で判定）
  checkDueReminders();
  setInterval(checkDueReminders, 60000);

  // 次の00:00に再チェックをスケジュール
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1).getTime() - now.getTime();
  setTimeout(() => {
    checkAndSendNotifications();
    setInterval(checkAndSendNotifications, 86400000);
  }, msUntilMidnight);
}

// 当日の予定で reminderMinutes が設定されたものを走査し、発火時刻を過ぎていれば通知
function checkDueReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  const todayKey = dateKey(now.getFullYear(), now.getMonth(), now.getDate());
  const list = events[todayKey] || [];
  if (!list.length) return;
  const notified = _getNotifiedKeys();
  let changed = false;
  list.forEach(ev => {
    if (!ev.title || !ev.time || ev.reminderMinutes == null) return;
    const hm = ev.time.split(':').map(Number);
    if (hm.length < 2 || isNaN(hm[0])) return;
    const evTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hm[0], hm[1]);
    const fireAt = new Date(evTime.getTime() - ev.reminderMinutes * 60000);
    if (now < fireAt || now >= evTime) return;       // 発火ウィンドウ外
    const key = `rem_${ev._dbId ?? ev.title}_${todayKey}`;
    if (notified[key]) return;
    notified[key] = 1;
    changed = true;
    _showNotif('⏰ まもなく予定', `「${ev.title}」が ${ev.time} に始まります`, key);
  });
  if (changed) _saveNotifiedKeys(notified);
}

function checkAndSendNotifications() {
  if (Notification.permission !== 'granted') return;
  const today = _todayStrLocal();
  const notified = _getNotifiedKeys();

  // ── タスク通知（4日前・2日前・当日）──
  const taskDays = [4, 2, 0];
  const allTasks = _taskState?.tasks ?? [];
  allTasks.forEach(task => {
    if (task.done || !task.dueDate) return;
    const diff = _diffDays(task.dueDate);
    if (!taskDays.includes(diff)) return;
    const key = `task_${task.id}_${today}_d${diff}`;
    if (notified[key]) return;
    notified[key] = 1;
    const label = diff === 0 ? '今日が期限' : `${diff}日後が期限`;
    _showNotif('📋 タスクのお知らせ', `「${task.title}」の${label}です`, key);
  });

  // ── イベント通知（前日・当日）──
  const eventDays = [1, 0];
  Object.entries(events ?? {}).forEach(([dateKey, evList]) => {
    if (!evList?.length) return;
    const diff = _diffDays(dateKey);
    if (!eventDays.includes(diff)) return;
    evList.forEach(ev => {
      if (!ev.title) return;
      const key = `event_${ev._dbId ?? dateKey}_${today}_d${diff}`;
      if (notified[key]) return;
      notified[key] = 1;
      const label = diff === 0 ? '今日' : '明日';
      const timeStr = ev.timeStart ? ` (${ev.timeStart}〜)` : '';
      _showNotif('📅 イベントのお知らせ', `${label}「${ev.title}」${timeStr}があります`, key);
    });
  });

  _saveNotifiedKeys(notified);
}

// ── Wage helpers ──────────────────────────────────────────────────────────────

function calcShift(ev) {
  if (!ev.shiftStart || !ev.shiftEnd)
    return { totalMinutes:0, breakMinutes:0, workMinutes:0, pay:0 };
  const [sh,sm] = ev.shiftStart.split(':').map(Number);
  const [eh,em] = ev.shiftEnd.split(':').map(Number);
  let total = (eh*60+em) - (sh*60+sm);
  if (total <= 0) total += 1440;
  const brk  = Math.max(0, ev.breakMinutes ?? 0);
  const work = Math.max(0, total - brk);
  const wage = getCat(ev.catId)?.hourlyWage ?? 0;
  return { totalMinutes:total, breakMinutes:brk, workMinutes:work, pay:Math.floor(work/60*wage) };
}

// "HH:MM" → 分。空・不正なら0。
function parseHHMMtoMin(str) {
  if (!str || typeof str !== 'string') return 0;
  const m = str.match(/^(\d{1,3}):(\d{1,2})$/);
  if (!m) return 0;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(mi) || mi >= 60) return 0;
  return h * 60 + mi;
}

// 分 → "HH:MM"
function formatMinToHHMM(mins) {
  const m = Math.max(0, Math.floor(mins || 0));
  return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
}

function fmtMin(m) { const h=Math.floor(m/60),r=m%60; return r?`${h}h${r}m`:`${h}h`; }
function fmtYen(n) { return '¥'+Math.round(n).toLocaleString('ja-JP'); }

function monthlySalary() {
  const y=curDate.getFullYear(), m=curDate.getMonth();
  const dim=new Date(y,m+1,0).getDate(), res={};
  for (let d=1;d<=dim;d++) {
    (events[dateKey(y,m,d)]||[]).filter(ev=>isShift(ev.catId)).forEach(ev=>{
      const {workMinutes,pay}=calcShift(ev);
      if (!res[ev.catId]) res[ev.catId]={workMinutes:0,pay:0,cashoutPay:0};
      res[ev.catId].workMinutes+=workMinutes;
      res[ev.catId].pay+=pay;
    });
  }
  // 当月にキャッシュアウトされた残業を給料に加算
  shiftCats().forEach(cat => {
    const cashoutPay = monthlyCashoutPayByCat(cat.id, y, m);
    if (cashoutPay > 0) {
      if (!res[cat.id]) res[cat.id]={workMinutes:0,pay:0,cashoutPay:0};
      res[cat.id].cashoutPay = cashoutPay;
      res[cat.id].pay += cashoutPay;
    }
  });
  return res;
}

function monthlySalaryToDate() {
  const y=curDate.getFullYear(), m=curDate.getMonth();
  const today=new Date();
  const isCurrentMonth=(y===today.getFullYear()&&m===today.getMonth());
  const maxDay=isCurrentMonth?today.getDate():new Date(y,m+1,0).getDate();
  const res={};
  for (let d=1;d<=maxDay;d++) {
    (events[dateKey(y,m,d)]||[]).filter(ev=>isShift(ev.catId)).forEach(ev=>{
      const {workMinutes,pay}=calcShift(ev);
      if (!res[ev.catId]) res[ev.catId]={workMinutes:0,pay:0,cashoutPay:0};
      res[ev.catId].workMinutes+=workMinutes;
      res[ev.catId].pay+=pay;
    });
  }
  // 当月分のキャッシュアウト（今日以前のもののみ）
  shiftCats().forEach(cat => {
    const cashouts = monthlyCashoutsByCat(cat.id, y, m).filter(c => {
      if (!isCurrentMonth) return true;
      const d = new Date(c.dateKey);
      return d.getDate() <= maxDay;
    });
    const minutes = cashouts.reduce((s, c) => s + c.minutes, 0);
    const wage = getCat(cat.id)?.hourlyWage ?? 0;
    const cashoutPay = Math.floor(minutes / 60 * wage);
    if (cashoutPay > 0) {
      if (!res[cat.id]) res[cat.id]={workMinutes:0,pay:0,cashoutPay:0};
      res[cat.id].cashoutPay = cashoutPay;
      res[cat.id].pay += cashoutPay;
    }
  });
  return res;
}

// ── Sync indicator ────────────────────────────────────────────────────────────

// Obsidian は同期状態をステータスバーに出す。旧メニューバーの
// #js-sync-indicator と #js-status-sync は同じ状態の二重表示だったので統合した。
const _SYNC_UI = {
  syncing: { icon: 'refresh-cw',      label: '同期中',   title: '同期中...' },
  synced:  { icon: 'calendar-check',  label: '同期済み', title: '同期済み' },
  error:   { icon: 'alert-triangle',  label: 'エラー',   title: '同期エラー' },
};

function setSyncStatus(status) { // 'syncing' | 'synced' | 'error'
  const el = document.getElementById('js-status-sync');
  if (!el) return;
  const ui = _SYNC_UI[status] || _SYNC_UI.error;
  el.className = 'status-bar-item mod-clickable sync-indicator ' + status;
  el.title = ui.title;
  el.innerHTML = `<svg class="svg-icon"><use href="#lucide-${ui.icon}"/></svg><span>${ui.label}</span>`;
}

// ── Supabase: load data ───────────────────────────────────────────────────────

async function loadFromSupabase() {
  setSyncStatus('syncing');
  try {
    const uid = currentUser.id;

    // Load categories
    const { data: cats, error: cErr } = await db
      .from('categories')
      .select('*')
      .eq('user_id', uid)
      .order('sort_order');

    if (cErr) throw cErr;

    if (cats && cats.length > 0) {
      categories = cats.map(r => ({
        id:          r.cat_id,
        name:        r.name,
        color:       r.color,
        type:        r.type,
        hourlyWage:  r.hourly_wage ?? undefined,
        templates:   r.templates ?? []
      }));
      rebuildCatMap();
    } else {
      // First login: seed defaults
      categories = deepClone(DEFAULT_CATEGORIES);
      rebuildCatMap();
      await saveCategoriesToSupabase();
    }

    // Load events
    const { data: evs, error: eErr } = await db
      .from('events')
      .select('*')
      .eq('user_id', uid);

    if (eErr) throw eErr;

    events = {};
    (evs || []).forEach(r => {
      const key = r.date_key ?? r.dateKey ?? r.date;
      if (!events[key]) events[key] = [];
      // カラム名を複数パターンで対応（テーブルごとの命名揺れに対応）
      const timeEnd      = r.time_end      ?? r.timeEnd      ?? r.time_end_col ?? '';
      const shiftStart   = r.shift_start   ?? r.shiftStart   ?? r.start        ?? '';
      const shiftEnd     = r.shift_end     ?? r.shiftEnd     ?? r.end          ?? '';
      const breakMinutes    = r.break_minutes    ?? r.breakMinutes    ?? r.break        ?? 0;
      const overtimeMinutes = r.overtime_minutes ?? r.overtimeMinutes ?? 0;
      const catId           = r.cat_id           ?? r.catId           ?? r.category_id  ?? 0;
      const dateKey2        = r.date_key         ?? r.dateKey         ?? r.date         ?? key;
      events[key].push({
        _dbId:        r.id,
        catId,
        title:        r.title ?? '',
        time:         r.time  ?? '',
        timeEnd,
        shiftStart,
        shiftEnd,
        breakMinutes,
        overtimeMinutes,
        reminderMinutes: r.reminder_minutes ?? r.reminderMinutes ?? null
      });
    });

    selectedCatId = normalCats()[0]?.id ?? categories[0]?.id;
    await loadOvertimeCashoutsFromSupabase();
    await loadDailyDrinksFromSupabase();
    setSyncStatus('synced');
  } catch (e) {
    console.error('Load error:', e);
    setSyncStatus('error');
    alert('データの読み込みに失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

// ── Supabase: save categories ─────────────────────────────────────────────────

async function saveCategoriesToSupabase() {
  setSyncStatus('syncing');
  try {
    const uid = currentUser.id;
    // Upsert all categories
    const rows = categories.map((cat, i) => ({
      user_id:     uid,
      cat_id:      cat.id,
      name:        cat.name,
      color:       cat.color,
      type:        cat.type,
      hourly_wage: cat.hourlyWage ?? null,
      templates:   cat.templates  ?? [],
      sort_order:  i
    }));

    const { error } = await db
      .from('categories')
      .upsert(rows, { onConflict: 'user_id,cat_id' });

    if (error) throw error;

    // Delete removed categories
    const validIds = categories.map(c => c.id);
    await db.from('categories')
      .delete()
      .eq('user_id', uid)
      .not('cat_id', 'in', `(${validIds.join(',')})`);

    setSyncStatus('synced');
  } catch (e) {
    console.error('Save cats error:', e);
    setSyncStatus('error');
  }
}

// ── Supabase: add event ───────────────────────────────────────────────────────

// カラム名マッピング — Supabaseの実際のカラム名に合わせて自動検出する
let _evColMap = null;  // null = 未検出, object = 検出済み

async function detectEventColumns() {
  if (_evColMap) return _evColMap;
  // テーブルから1行取得してカラム名を調べる
  const { data } = await db.from('events').select('*').limit(1);
  if (data && data.length > 0) {
    const cols = Object.keys(data[0]);
    console.log('events カラム名:', cols);
    _evColMap = {
      timeEnd:         cols.find(c => /time.?end|endtime|end.?time/i.test(c)) ?? 'time_end',
      shiftStart:      cols.find(c => /shift.?start|start.?shift/i.test(c))  ?? 'shift_start',
      shiftEnd:        cols.find(c => /shift.?end|end.?shift/i.test(c))      ?? 'shift_end',
      breakMinutes:    cols.find(c => /break/i.test(c))                       ?? 'break_minutes',
      overtimeMinutes: cols.find(c => /overtime/i.test(c))                    ?? 'overtime_minutes',
      dateKey:         cols.find(c => /date.?key|key.?date/i.test(c))         ?? 'date_key',
      catId:           cols.find(c => /cat.?id|category.?id/i.test(c))        ?? 'cat_id',
      userId:          cols.find(c => /user.?id/i.test(c))                    ?? 'user_id',
    };
    // overtime_minutes カラムが存在するかチェック（マイグレーション未実行の環境向け）
    _evColMap._hasOvertime = cols.some(c => /overtime/i.test(c));
    _evColMap.reminderMinutes = cols.find(c => /reminder/i.test(c)) ?? 'reminder_minutes';
    _evColMap._hasReminder = cols.some(c => /reminder/i.test(c));
  } else {
    // テーブルが空の場合はデフォルトを使う
    _evColMap = {
      timeEnd: 'time_end', shiftStart: 'shift_start', shiftEnd: 'shift_end',
      breakMinutes: 'break_minutes', overtimeMinutes: 'overtime_minutes',
      dateKey: 'date_key', catId: 'cat_id', userId: 'user_id',
      _hasOvertime: true,
      reminderMinutes: 'reminder_minutes', _hasReminder: true
    };
  }
  return _evColMap;
}

async function addEventToSupabase(key, ev) {
  setSyncStatus('syncing');
  try {
    const m = await detectEventColumns();
    const row = {
      [m.userId]:       currentUser.id,
      [m.dateKey]:      key,
      [m.catId]:        ev.catId,
      title:            ev.title        ?? '',
      time:             ev.time         || null,
      [m.timeEnd]:      ev.timeEnd      || null,
      [m.shiftStart]:   ev.shiftStart   || null,
      [m.shiftEnd]:     ev.shiftEnd     || null,
      [m.breakMinutes]: ev.breakMinutes ?? 0
    };
    if (m._hasOvertime) row[m.overtimeMinutes] = ev.overtimeMinutes ?? 0;
    if (m._hasReminder) row[m.reminderMinutes] = ev.reminderMinutes ?? null;
    const { data, error } = await db.from('events').insert(row).select().single();
    if (error) throw error;
    ev._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Add event error:', e);
    setSyncStatus('error');
    alert('予定の保存に失敗しました。\n\nエラー: ' + (e.message || JSON.stringify(e)) + '\n\n実際のカラム名: ' + JSON.stringify(_evColMap));
  }
}

// ── Supabase: delete event ────────────────────────────────────────────────────

async function deleteEventFromSupabase(ev) {
  if (!ev._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('events').delete().eq('id', ev._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Delete event error:', e);
    setSyncStatus('error');
    alert('予定の削除に失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

// ── Supabase: update event ────────────────────────────────────────────────────

async function updateEventInSupabase(ev) {
  if (!ev._dbId) return;
  setSyncStatus('syncing');
  try {
    const m = await detectEventColumns();
    const payload = {
      [m.catId]:        ev.catId,
      title:            ev.title        ?? '',
      time:             ev.time         || null,
      [m.timeEnd]:      ev.timeEnd      || null,
      [m.shiftStart]:   ev.shiftStart   || null,
      [m.shiftEnd]:     ev.shiftEnd     || null,
      [m.breakMinutes]: ev.breakMinutes ?? 0
    };
    if (m._hasOvertime) payload[m.overtimeMinutes] = ev.overtimeMinutes ?? 0;
    if (m._hasReminder) payload[m.reminderMinutes] = ev.reminderMinutes ?? null;
    const { error } = await db.from('events').update(payload).eq('id', ev._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Update event error:', e);
    setSyncStatus('error');
    alert('予定の更新に失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

// ── Supabase: overtime cashouts ───────────────────────────────────────────────

async function loadOvertimeCashoutsFromSupabase() {
  if (!currentUser) return;
  try {
    const { data, error } = await db
      .from('overtime_cashouts')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });
    if (error) {
      // テーブル未作成（マイグレーション未実行）の場合は静かに無視
      if (error.code === '42P01' || /relation .* does not exist/i.test(error.message || '')) {
        console.warn('overtime_cashouts テーブルが未作成です。マイグレーションを実行してください。');
        overtimeCashouts = [];
        return;
      }
      throw error;
    }
    overtimeCashouts = (data || []).map(r => ({
      _dbId:     r.id,
      catId:     r.cat_id,
      minutes:   r.minutes,
      note:      r.note ?? '',
      dateKey:   r.date_key,
      createdAt: r.created_at
    }));
  } catch (e) {
    console.error('Load cashouts error:', e);
    overtimeCashouts = [];
  }
}

async function addOvertimeCashoutToSupabase(c) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('overtime_cashouts').insert({
      user_id:  currentUser.id,
      cat_id:   c.catId,
      minutes:  c.minutes,
      note:     c.note ?? '',
      date_key: c.dateKey
    }).select().single();
    if (error) throw error;
    c._dbId = data.id;
    c.createdAt = data.created_at;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Add cashout error:', e);
    setSyncStatus('error');
    alert('残業キャッシュアウトの保存に失敗しました。\n' + (e.message || JSON.stringify(e)));
    throw e;
  }
}

async function deleteOvertimeCashoutFromSupabase(c) {
  if (!c._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('overtime_cashouts').delete().eq('id', c._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Delete cashout error:', e);
    setSyncStatus('error');
  }
}

// ── Supabase: daily drinks ────────────────────────────────────────────────────

async function loadDailyDrinksFromSupabase() {
  if (!currentUser) return;
  try {
    const { data, error } = await db
      .from('daily_drinks')
      .select('date_key, count')
      .eq('user_id', currentUser.id);
    if (error) {
      if (error.code === '42P01' || /relation .* does not exist/i.test(error.message || '')) {
        console.warn('daily_drinks テーブルが未作成です。マイグレーションを実行してください。');
        dailyDrinks = {};
        return;
      }
      throw error;
    }
    dailyDrinks = {};
    (data || []).forEach(r => {
      if (r.count > 0) dailyDrinks[r.date_key] = r.count;
    });
  } catch (e) {
    console.error('Load drinks error:', e);
    dailyDrinks = {};
  }
}

async function setDrinkCount(key, count) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    if (count > 0) {
      const { error } = await db.from('daily_drinks').upsert(
        { user_id: currentUser.id, date_key: key, count, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,date_key' }
      );
      if (error) throw error;
    } else {
      const { error } = await db.from('daily_drinks')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('date_key', key);
      if (error) throw error;
    }
    setSyncStatus('synced');
  } catch (e) {
    console.error('Save drink count error:', e);
    setSyncStatus('error');
    throw e;  // 呼び元で rollback できるよう再 throw
  }
}

// ── Overtime aggregations ─────────────────────────────────────────────────────

// 全シフトの残業合計（カテゴリ別、全期間）
function totalOvertimeMinutesByCat(catId) {
  let total = 0;
  for (const key of Object.keys(events)) {
    for (const ev of events[key]) {
      if (ev.catId === catId && isShift(ev.catId)) {
        total += ev.overtimeMinutes ?? 0;
      }
    }
  }
  return total;
}

// 既にキャッシュアウト済みの残業合計（カテゴリ別）
function totalCashoutMinutesByCat(catId) {
  return overtimeCashouts.filter(c => c.catId === catId).reduce((s, c) => s + (c.minutes || 0), 0);
}

// 残業バンク残高 = 累積残業 - 累積キャッシュアウト
function getOvertimeBank(catId) {
  return Math.max(0, totalOvertimeMinutesByCat(catId) - totalCashoutMinutesByCat(catId));
}

// 指定月のシフトから集計した残業時間（カテゴリ別）
function monthlyOvertimeMinutesByCat(catId, year, month) {
  let total = 0;
  const dim = new Date(year, month+1, 0).getDate();
  for (let d = 1; d <= dim; d++) {
    const key = dateKey(year, month, d);
    for (const ev of (events[key] || [])) {
      if (ev.catId === catId && isShift(ev.catId)) {
        total += ev.overtimeMinutes ?? 0;
      }
    }
  }
  return total;
}

// 指定月にキャッシュアウトされた額（カテゴリ別）
function monthlyCashoutsByCat(catId, year, month) {
  return overtimeCashouts.filter(c => {
    if (c.catId !== catId) return false;
    const d = new Date(c.dateKey);
    return d.getFullYear() === year && d.getMonth() === month;
  });
}

// 指定月にキャッシュアウト分から発生した給料 (カテゴリ別)
function monthlyCashoutPayByCat(catId, year, month) {
  const wage = getCat(catId)?.hourlyWage ?? 0;
  const minutes = monthlyCashoutsByCat(catId, year, month).reduce((s, c) => s + c.minutes, 0);
  return Math.floor(minutes / 60 * wage);
}

// ── Supabase: move event to another date ──────────────────────────────────────

async function updateEventDateInSupabase(dbId, newKey) {
  if (!dbId) return;
  setSyncStatus('syncing');
  try {
    const m = await detectEventColumns();
    const { error } = await db.from('events').update({
      [m.dateKey]: newKey
    }).eq('id', dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch(e) {
    console.error('Move event error:', e);
    setSyncStatus('error');
    alert('予定の移動に失敗しました。\n' + (e.message || JSON.stringify(e)));
  }
}

async function moveEventToDate(dbId, srcKey, destKey) {
  if (!dbId || srcKey === destKey) return;
  const srcEvs = events[srcKey] || [];
  const idx = srcEvs.findIndex(ev => String(ev._dbId) === String(dbId));
  if (idx === -1) return;
  const ev = srcEvs.splice(idx, 1)[0];
  if (!srcEvs.length) delete events[srcKey]; else events[srcKey] = srcEvs;
  if (!events[destKey]) events[destKey] = [];
  events[destKey].push(ev);
  renderMain();
  renderMini();
  renderSalarySummary();
  await updateEventDateInSupabase(dbId, destKey);
}

// Obsidian はテーマを <body> の theme-dark / theme-light クラスで切り替える。
// index.html の <body class="theme-dark"> が初期ペイントのちらつきを防ぐので、
// ここと既定値 (isDark) が食い違うと一瞬反転して見える点に注意。
function applyTheme(dark) {
  document.body.classList.toggle('theme-dark', dark);
  document.body.classList.toggle('theme-light', !dark);
  // リボンのアイコンは「切り替えた先」を示す（ダーク中は sun＝明るくする）。
  document.querySelector('#js-theme-toggle .svg-icon use')
    ?.setAttribute('href', dark ? '#lucide-sun' : '#lucide-moon');
  // canvas は CSS 変数を追えないので、テーマの色を持っているのはここで捨てる。
  // theme-dark/theme-light を切り替えるのはこの関数だけなので、無効化もここだけ。
  _graphTheme = null;
  if (currentView === 'graph') renderGraphView();
}
function toggleTheme() {
  isDark = !isDark; applyTheme(isDark); saveLocalJSON('cal_dark', isDark);
}

// Obsidian はプラットフォームも <body> のクラスで示す（is-mobile / is-phone）。
// 幅の判定は isNarrowScreen() と同じ 720px に揃える。
// リボンの表示も Obsidian と同じ show-ribbon 機構で畳む
// （body:not(.show-ribbon) が --ribbon-width を 0 にする）。モバイルはリボンを
// 持たず、ハンバーガー＋ドロワーで代替する。
function applyPlatformClass() {
  const narrow = isNarrowScreen();
  document.body.classList.toggle('is-mobile', narrow);
  document.body.classList.toggle('is-phone', narrow);
  document.body.classList.toggle('show-ribbon', !narrow);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function showAuthScreen() {
  document.getElementById('js-auth-screen').style.display = '';
  document.getElementById('js-app').style.display = 'none';
}

async function showApp(user) {
  currentUser = user;
  document.getElementById('js-auth-screen').style.display = 'none';
  document.getElementById('js-app').style.display = '';
  document.getElementById('js-user-email').textContent = user.email ?? user.user_metadata?.full_name ?? '';

  initTaskPanel(user);
  initBudgetPanel(user);

  await loadFromSupabase();
  // 祝日データをフェッチ（今年・来年）してから再描画
  const _cy = new Date().getFullYear();
  Promise.all([fetchHolidays(_cy), fetchHolidays(_cy + 1)]).then(() => renderAll());
  renderAll();

  // 通知の初期化（許可取得 + 当日分チェック）
  initNotifications();
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function showAuthMsg(text, isError = true, raw = null) {
  const el = document.getElementById('js-auth-error');
  if (!el) return;
  let msg = text || '';
  if (isError) {
    const env = _envHints();
    if (env) msg += (msg ? '\n\n' : '') + env;
    const rawMsg = _fmtErr(raw);
    if (rawMsg) msg += (msg ? '\n\n' : '') + '詳細: ' + rawMsg;
  }
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
  el.style.color = isError ? '' : 'var(--color-positive)';
  el.style.background = isError ? '' : 'var(--color-positive-bg)';
  el.style.border = isError ? '' : '1px solid var(--color-positive-border)';
}



function setAuthLoading(loading) {
  const submitBtn  = document.getElementById('js-auth-submit');
  const googleBtn  = document.getElementById('js-auth-google');
  const loadEl     = document.getElementById('js-auth-loading');
  submitBtn.disabled = loading;
  googleBtn.disabled = loading;
  loadEl.style.display = loading ? '' : 'none';
}

function translateAuthError(msg) {
  if (!msg) return '不明なエラーが発生しました';
  if (msg.includes('Invalid login credentials'))   return 'メールアドレスまたはパスワードが正しくありません';
  if (msg.includes('Email not confirmed'))          return 'メールアドレスが確認されていません。確認メールのリンクをクリックしてください';
  if (msg.includes('User already registered'))      return 'このメールアドレスはすでに登録されています。ログインしてください';
  if (msg.includes('Password should be at least'))  return 'パスワードは6文字以上で設定してください';
  if (msg.includes('Unable to validate email'))     return '有効なメールアドレスを入力してください';
  if (msg.includes('Email rate limit exceeded'))    return 'しばらく時間をおいてから再度お試しください';
  if (msg.includes('network'))                      return 'ネットワークエラーが発生しました。接続を確認してください';
  return msg;
}

// Auth tab switch
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('is-active', b === btn));
    const isLogin = btn.dataset.tab === 'login';
    document.getElementById('js-auth-submit').textContent = isLogin ? 'ログイン' : '新規登録';
    document.getElementById('js-auth-password').autocomplete = isLogin ? 'current-password' : 'new-password';
    showAuthMsg('');
  });
});

// Enter key on inputs
['js-auth-email', 'js-auth-password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('js-auth-submit').click();
  });
});

// Email/password submit
document.getElementById('js-auth-submit').addEventListener('click', async () => {
  const email    = document.getElementById('js-auth-email').value.trim();
  const password = document.getElementById('js-auth-password').value;
  const isLogin  = document.querySelector('.auth-tab.is-active').dataset.tab === 'login';

  showAuthMsg('');

  if (!email)    { showAuthMsg('メールアドレスを入力してください'); return; }
  if (!password) { showAuthMsg('パスワードを入力してください'); return; }
  if (!isLogin && password.length < 6) { showAuthMsg('パスワードは6文字以上で設定してください'); return; }

  if(!ensureDb()) return;
  setAuthLoading(true);
  try {
    let result;
    if (isLogin) {
      result = await db.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      // onAuthStateChange → showApp() が自動で呼ばれる
    } else {
      result = await db.auth.signUp({ email, password });
      if (result.error) throw result.error;

      if (!result.data.session) {
        // メール確認が必要なケース
        showAuthMsg(
          '確認メールを送信しました📧\n' +
          email + ' の受信ボックスを確認し、メール内のリンクをクリックしてからログインしてください。\n' +
          '（迷惑メールフォルダも確認してください）',
          false
        );
      }
      // session ありなら onAuthStateChange が showApp() を呼ぶ
    }
  } catch (e) {
    showAuthMsg(translateAuthError(e?.message || String(e)), true, e);
  } finally {
    setAuthLoading(false);
  }
});

// Google OAuth — Supabase側でGoogleが有効かチェックしてからボタン表示
(async () => {
  try {
    const res  = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_KEY }
    });
    const json = await res.json();
    const googleEnabled = json?.external?.google === true;
    const googleBtn = document.getElementById('js-auth-google');
    const divider   = document.getElementById('js-auth-divider');
    if (!googleEnabled) {
      // Googleが無効なら非表示
      googleBtn.style.display = 'none';
      if (divider) divider.style.display = 'none';
    }
  } catch { /* ネットワーク失敗時はそのまま表示 */ }
})();

document.getElementById('js-auth-google').addEventListener('click', async () => {
  setAuthLoading(true);
  showAuthMsg('');
  try {
    // ── Electron デスクトップ版: PKCE + 規定ブラウザ + ループバック ──
    // Google は埋め込みブラウザでの OAuth を拒否するため、認可 URL を規定ブラウザで開き、
    // http://127.0.0.1:<port>/oauth-callback に戻ってきた code を交換する。
    if (window.electronOAuth) {
      const { data, error } = await db.auth.signInWithOAuth({
        provider: 'google',
        options: {
          skipBrowserRedirect: true,
          redirectTo: window.location.origin + '/oauth-callback',
          queryParams: { access_type: 'offline', prompt: 'consent' }
        }
      });
      if (error) throw error;
      if (!data?.url) throw new Error('認可URLを取得できませんでした');
      showAuthMsg('ブラウザでGoogleログインを続けてください…', false);
      const res = await window.electronOAuth.openExternalAuth(data.url);
      if (res?.error) {
        throw new Error(res.error === 'timeout'
          ? 'タイムアウトしました。もう一度お試しください。'
          : 'Googleログインがキャンセルまたは失敗しました');
      }
      if (!res?.code) throw new Error('認証コードを取得できませんでした');
      const { error: exErr } = await db.auth.exchangeCodeForSession(res.code);
      if (exErr) throw exErr;
      // onAuthStateChange (SIGNED_IN) → showApp() が発火する
      return;
    }

    // ── Web ブラウザ版（従来どおり）──
    const { error } = await db.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { access_type: 'offline', prompt: 'consent' }
      }
    });
    if (error) throw error;
    // ブラウザがGoogleにリダイレクトするのでローディングはそのまま
  } catch (e) {
    showAuthMsg(translateAuthError(e?.message || String(e)), true, e);
    setAuthLoading(false);
  }
});

// Logout
document.getElementById('js-logout').addEventListener('click', async () => {
  if(!ensureDb()) return;
  await db.auth.signOut();
  currentUser = null; categories = []; projects = []; events = {}; overtimeCashouts = []; dailyDrinks = {}; rebuildCatMap();
  showAuthScreen();
});

// Auth state listener
let _appInitialized = false;

if (db) {
  db.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      if (!_appInitialized || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        _appInitialized = true;
        showApp(session.user);
      }
    } else {
      _appInitialized = false;
      showAuthScreen();
    }
  });
} else {
  // SDK 読み込み失敗時は onAuthStateChange が登録されないため、
  // js-auth-screen / js-app とも display:none のまま固まってしまう。
  // フォールバックとしてログイン画面側にエラーを表示する。
  showAuthScreen();
  showAuthMsg('Supabase SDK の読み込みに失敗しています。ネットワーク/拡張機能/HTMLの<script>読み込み順を確認してください。', true);
}

// ── Salary summary ────────────────────────────────────────────────────────────

function renderSalarySummary() {
  const box     = document.getElementById('js-salary-summary');
  const summary = monthlySalary();
  const today   = new Date();
  const isCurrentMonth = curDate.getFullYear()===today.getFullYear() &&
                         curDate.getMonth()===today.getMonth();
  box.innerHTML = '';

  const shiftCategories = shiftCats();
  const active = shiftCategories.filter(c => summary[c.id]);
  const anyBankBalance = shiftCategories.some(c => getOvertimeBank(c.id) > 0);

  if (!active.length && !anyBankBalance) {
    box.innerHTML = '<div class="salary-empty">シフトの記録がありません</div>';
    return;
  }

  let total = 0;
  // 表示対象: 当月にシフトがあるか、バンクに残高があるカテゴリすべて
  const displayCats = shiftCategories.filter(c => summary[c.id] || getOvertimeBank(c.id) > 0);
  displayCats.forEach(cat => {
    const data = summary[cat.id] || {workMinutes:0, pay:0, cashoutPay:0};
    total += data.pay;
    const row = document.createElement('div');
    row.className = 'salary-job-row';
    row.innerHTML = `
      <span class="salary-job-dot" style="background:${cat.color}"></span>
      <span class="salary-job-name">${escHtml(cat.name)}</span>
      <span class="salary-job-hours">${fmtMin(data.workMinutes)}</span>
      <span class="salary-job-amount">${fmtYen(data.pay)}</span>`;
    box.appendChild(row);

    // バンク残高（ある場合のみ表示）
    const bank = getOvertimeBank(cat.id);
    const ovRow = document.createElement('div');
    ovRow.className = 'salary-overtime-row';
    const cashoutHHMM = data.cashoutPay > 0 ? ` <span style="opacity:.7">(振替済 ${fmtYen(data.cashoutPay)})</span>` : '';
    ovRow.innerHTML = `
      <span class="overtime-label"><svg class="svg-icon"><use href="#lucide-timer"/></svg> 残業バンク${cashoutHHMM}</span>
      <span class="overtime-balance${bank === 0 ? ' is-zero' : ''}">${formatMinToHHMM(bank)}</span>`;
    box.appendChild(ovRow);
  });

  box.insertAdjacentHTML('beforeend','<div class="salary-divider"></div>');

  if (isCurrentMonth) {
    const toDateSummary = monthlySalaryToDate();
    let totalToDate = 0;
    Object.values(toDateSummary).forEach(v => { totalToDate += v.pay; });

    const todayRow = document.createElement('div');
    todayRow.className = 'salary-today-row';
    todayRow.innerHTML = `<span class="salary-today-label">今日まで</span>
                          <span class="salary-today-amount">${fmtYen(totalToDate)}</span>`;
    box.appendChild(todayRow);
  }

  const tot = document.createElement('div');
  tot.className = 'salary-total-row';
  tot.style.marginTop = '3px';
  tot.innerHTML = `<span class="salary-total-label">${isCurrentMonth ? '今月' : '合計'}</span>
                   <span class="salary-total-amount">${fmtYen(total)}</span>`;
  box.appendChild(tot);

  // ── 残業バンク操作ボタン ──
  if (shiftCategories.length > 0) {
    const actions = document.createElement('div');
    actions.className = 'salary-overtime-actions';
    actions.innerHTML = `
      <button id="js-overtime-cashout-open" type="button" ${anyBankBalance ? '' : 'disabled'}><svg class="svg-icon"><use href="#lucide-timer"/></svg> 残業を振替</button>
      <button id="js-overtime-history-open" type="button"><svg class="svg-icon"><use href="#lucide-bar-chart-3"/></svg> 履歴</button>`;
    box.appendChild(actions);
    document.getElementById('js-overtime-cashout-open').addEventListener('click', openOvertimeCashoutModal);
    document.getElementById('js-overtime-history-open').addEventListener('click', openOvertimeHistoryModal);
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  const counts = catCounts();
  const list   = document.getElementById('js-category-list');
  list.innerHTML = '';

  categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-row';
    const tag = cat.type==='shift'
      ? ` <small style="font-size:9px;opacity:.5;font-weight:600"><svg class="svg-icon"><use href="#lucide-timer"/></svg> ${cat.hourlyWage?fmtYen(cat.hourlyWage)+'/h':''}</small>`
      : '';
    row.innerHTML = `
      <span class="cat-color-dot" style="background:${cat.color}"></span>
      <span class="cat-row-name">${escHtml(cat.name)}${tag}</span>
      <span class="cat-row-count">${counts[cat.id]||''}</span>
      <span class="cat-row-actions">
        <button class="cat-row-edit-btn" title="編集">•••</button>
      </span>`;
    row.querySelector('.cat-row-edit-btn').addEventListener('click', e => {
      e.stopPropagation(); openCatEditor();
    });
    list.appendChild(row);
  });

  renderSalarySummary();
  renderCleanCalendar();
}

// ── Mini calendar ─────────────────────────────────────────────────────────────

function renderMini() {
  const y=curDate.getFullYear(), m=curDate.getMonth(), today=new Date();
  document.getElementById('js-mini-month').textContent = `${MONTHS_INIT[m]} ${y}`;
  const grid=document.getElementById('js-mini-grid');
  grid.innerHTML='';
  const first=new Date(y,m,1).getDay(), dim=new Date(y,m+1,0).getDate(), prev=new Date(y,m,0).getDate();

  for (let i=first-1;i>=0;i--) grid.appendChild(mkMini(prev-i,true,false,false,false,false));
  for (let d=1;d<=dim;d++) {
    const dow=new Date(y,m,d).getDay();
    const k=dateKey(y,m,d);
    const isTd=y===today.getFullYear()&&m===today.getMonth()&&d===today.getDate();
    const hasGoalDone=(typeof currentUser!=='undefined'&&currentUser)?_isGoalAchieved(currentUser.id,k):false;
    const el=mkMini(d,false,isTd,!!(events[k]?.length),dow===0,dow===6,hasGoalDone);
    el.addEventListener('click',()=>openDayModal(y,m,d));
    grid.appendChild(el);
  }
  const rem=grid.children.length%7;
  if (rem) for (let d=1;d<=7-rem;d++) grid.appendChild(mkMini(d,true,false,false,false,false));
}

function mkMini(day,isOther,isToday,hasEv,isSun,isSat,hasGoalDone) {
  const el=document.createElement('div');
  el.className=['mini-day',isOther?'is-other':'',isToday?'is-today':'',
    hasEv?'has-events':'',isSun?'is-sun':'',isSat?'is-sat':'',
    hasGoalDone?'has-goal-done':''].filter(Boolean).join(' ');
  el.textContent=day;
  return el;
}

// ── Main calendar ─────────────────────────────────────────────────────────────

function renderMain() {
  const y=curDate.getFullYear(), m=curDate.getMonth(), today=new Date();
  // I3: 1描画につき1回だけ評価する。ピルごとに呼ぶと 1 描画で 100 回超の
  // matchMedia 評価＝レイアウトスラッシュになる。
  const narrow=isNarrowScreen();
  document.getElementById('js-topbar-title').textContent=`${MONTHS_INIT[m]} ${y}`;
  document.getElementById('js-topbar-sub').textContent='';

  const grid=document.getElementById('js-cal-grid');
  grid.innerHTML='';
  const first=new Date(y,m,1).getDay(), dim=new Date(y,m+1,0).getDate(), prev=new Date(y,m,0).getDate();

  for (let i=first-1;i>=0;i--) {
    const dt=new Date(y,m-1,prev-i);
    grid.appendChild(buildCell(dt.getFullYear(),dt.getMonth(),dt.getDate(),true,false,narrow));
  }
  for (let d=1;d<=dim;d++) {
    const isTd=y===today.getFullYear()&&m===today.getMonth()&&d===today.getDate();
    grid.appendChild(buildCell(y,m,d,false,isTd,narrow));
  }
  const rem=grid.children.length%7;
  if (rem) for (let d=1;d<=7-rem;d++) {
    const dt=new Date(y,m+1,d);
    grid.appendChild(buildCell(dt.getFullYear(),dt.getMonth(),d,true,false,narrow));
  }

  // グラフもここで追う。予定の4経路（追加・編集・削除・繰り返し）は renderAll()
  // を通るので勝手に更新されるが、タスクの変更と予定のドラッグ移動は
  // renderMain() を直に呼ぶ経路しか持たない。タスクはグラフのノードなので、
  // これが無いとタスクを足しても消してもグラフだけ古いまま残る。
  // 現在ビューがグラフのとき renderMain() は renderAll() から呼ばれないので、
  // 二重描画にはならない。
  if (currentView === 'graph') renderGraphView();
}

function sortEvs(arr) {
  return [...arr].sort((a,b)=>(a.shiftStart||a.time||'99:99').localeCompare(b.shiftStart||b.time||'99:99'));
}

// narrow は renderMain が1度だけ評価して渡す（I3）。単体で呼ばれた場合に備えて
// 省略時は自分で評価する。
function buildCell(y,m,d,isOther,isToday,narrow) {
  if (narrow === undefined) narrow = isNarrowScreen();
  const dow=new Date(y,m,d).getDay(), key=dateKey(y,m,d), dayEvs=sortEvs(events[key]||[]);
  const cell=document.createElement('div');
  cell.className=['day-cell',isOther?'is-other-month':'',isToday?'is-today':'',
    dow===0?'is-sun':'',dow===6?'is-sat':''].filter(Boolean).join(' ');
  cell.dataset.dateKey = key;
  cell.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='move'; cell.classList.add('is-drag-over'); });
  cell.addEventListener('dragleave', e => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('is-drag-over'); });
  cell.addEventListener('drop', async e => {
    e.preventDefault(); cell.classList.remove('is-drag-over');
    let data; try { data=JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    await moveEventToDate(data.dbId, data.srcKey, key);
  });

  const numEl=document.createElement('div');
  numEl.className='day-num'; numEl.textContent=d;
  const head=document.createElement('div');
  head.className='day-head';
  head.appendChild(numEl);
  // 予定時刻は各予定ピルの1段目に表示するため、日付番号の右の時計アイコンは廃止。
  cell.appendChild(head);

  const _hName = getHolidayName(key);
  if (_hName) {
    const hEl = document.createElement('div');
    hEl.className = 'day-holiday';
    hEl.textContent = _hName;
    cell.appendChild(hEl);
  }



  if (dayEvs.length) {
    const evList=document.createElement('div');
    evList.className='day-events';
    dayEvs.slice(0,3).forEach(ev=>{
      const cat=getCat(ev.catId)||{color:'#888'};
      const pill=document.createElement('div');
      pill.className='event-pill'+(isShift(ev.catId)?' is-shift':'');
      pill.style.background=cat.color;
      if (isShift(ev.catId)&&ev.shiftStart) {
        if (narrow) {
          // 2段表示：1段目に開始時刻、2段目にカテゴリ名
          pill.innerHTML=`<span class="event-pill-time">${ev.shiftStart}</span><span class="event-pill-name">${escHtml(cat.name)}</span>`;
        } else {
          pill.innerHTML=`<span class="event-pill-time">${ev.shiftStart}–${ev.shiftEnd}</span><span class="event-pill-name">${escHtml(cat.name)}</span>`;
        }
      } else {
        if (narrow) {
          // 2段表示：1段目に開始時刻、2段目に予定タイトル（終日は時刻なしで名前のみ）
          pill.innerHTML= ev.time
            ? `<span class="event-pill-time">${ev.time}</span><span class="event-pill-name">${renderInline(ev.title)}</span>`
            : `<span class="event-pill-name">${renderInline(ev.title)}</span>`;
        } else {
          const pillTime = ev.time
            ? (ev.timeEnd ? `${ev.time}–${ev.timeEnd}` : ev.time)
            : '';
          pill.innerHTML=pillTime
            ?`<span class="event-pill-time">${pillTime}</span><span class="event-pill-name">${renderInline(ev.title)}</span>`
            :`<span class="event-pill-dot"></span><span class="event-pill-name">${renderInline(ev.title)}</span>`;
        }
      }
      pill.addEventListener('click',e=>{e.stopPropagation();openDayModal(y,m,d);});
      if (ev._dbId) {
        pill.draggable = true;
        pill.addEventListener('dragstart', e => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', JSON.stringify({ dbId: ev._dbId, srcKey: key }));
          setTimeout(() => pill.classList.add('is-dragging'), 0);
        });
        pill.addEventListener('dragend', () => pill.classList.remove('is-dragging'));
      }
      evList.appendChild(pill);
    });
    if (dayEvs.length>3) {
      const more=document.createElement('div');
      more.className='more-badge'; more.textContent=`+${dayEvs.length-3} 件`;
      evList.appendChild(more);
    }
    cell.appendChild(evList);
  }
  // Tasks with due date on this day
  {
    const dayTasks = (_taskState?.tasks || [])
      .filter(t => !t.done && t.dueDate === key);
    if (dayTasks.length) {
      const taskList = document.createElement('div');
      taskList.className = 'day-tasks';
      const MAX = 2;
      dayTasks.slice(0, MAX).forEach(t => {
        const pill = document.createElement('div');
        pill.className = 'task-cal-pill is-' + (t.priority || 'medium');
        pill.title = t.title + (t.priority === 'high' ? '（重要）' : t.priority === 'low' ? '（低）' : '');
        pill.innerHTML =
          '<span class="task-cal-dot"></span>' +
          '<span class="task-cal-name">' + escHtml(t.title) + '</span>';
        taskList.appendChild(pill);
      });
      if (dayTasks.length > MAX) {
        const more = document.createElement('div');
        more.className = 'more-badge';
        more.textContent = '+' + (dayTasks.length - MAX) + ' 件';
        taskList.appendChild(more);
      }
      cell.appendChild(taskList);
    }
  }


  // 目標達成バッジ
  if ((typeof currentUser!=='undefined'&&currentUser)&&_isGoalAchieved(currentUser.id,key)) {
    cell.classList.add('has-goal-done');
    const badge=document.createElement('span');
    badge.className='goal-done-badge';
    badge.title='目標達成';
    numEl.appendChild(badge);
  }

  cell.addEventListener('click',()=>{
    openDayModal(y,m,d);
  });
  return cell;
}

// ── Day modal ─────────────────────────────────────────────────────────────────

function openDayModal(y,m,d) {
  selectedKey=dateKey(y,m,d);
  const dow=new Date(y,m,d).getDay();
  document.getElementById('js-day-modal-title').textContent=`${MONTHS_INIT[m]} ${d}, ${y}`;
  document.getElementById('js-day-modal-sub').textContent=DAYS_EN[dow];

  document.getElementById('js-day-drink-count').value = dailyDrinks[selectedKey] ?? 0;
  document.getElementById('js-day-drink-count').dispatchEvent(new Event('input', { bubbles: true }));

  document.getElementById('js-ev-title').value='';
  document.getElementById('js-ev-time-start').value='';
  document.getElementById('js-ev-time-end').value='';
  const _remSel=document.getElementById('js-ev-reminder');
  if (_remSel) _remSel.value='';
  if (!getCat(selectedCatId)) selectedCatId=normalCats()[0]?.id??categories[0]?.id;

  document.getElementById('js-shift-start').value='';
  document.getElementById('js-shift-end').value='';
  document.getElementById('js-shift-break').value='';
  updateWagePreview();

  renderExistingEvents();
  renderCatChips();
  renderTemplateChips();
  renderEventTemplateChips();
  updateShiftTabVisibility();
  switchTab(activeTab);
  openOverlay('js-day-overlay');
  setTimeout(()=>{
    (activeTab==='shift'
      ?document.getElementById('js-shift-start')
      :document.getElementById('js-ev-title'))?.focus();
  },80);
}

document.querySelectorAll('.form-tab').forEach(btn=>{
  btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  activeTab=tab;
  document.querySelectorAll('.form-tab').forEach(b=>b.classList.toggle('is-active',b.dataset.tab===tab));
  document.getElementById('js-tab-event').style.display=tab==='event'?'':'none';
  document.getElementById('js-tab-shift').style.display=tab==='shift'?'':'none';
}

function updateShiftTabVisibility() {
  const has=shiftCats().length>0;
  document.getElementById('js-no-shift-warning').style.display=has?'none':'';
  document.getElementById('js-add-shift-btn').style.display=has?'':'none';
  document.getElementById('js-wage-preview').style.display=has?'':'none';
}

document.getElementById('js-go-to-cat-editor').addEventListener('click',()=>{
  closeOverlay('js-day-overlay'); openCatEditor();
});

// ── Template chips ────────────────────────────────────────────────────────────

function renderTemplateChips() {
  const row=document.getElementById('js-template-row');
  const list=document.getElementById('js-template-chip-list');
  list.innerHTML='';
  const all=[];
  shiftCats().forEach(cat=>(cat.templates||[]).forEach(tpl=>all.push({cat,tpl})));
  if (!all.length){row.style.display='none';return;}
  row.style.display='';
  all.forEach(({cat,tpl})=>{
    const chip=document.createElement('button');
    chip.className='template-chip';
    const mock={shiftStart:tpl.start,shiftEnd:tpl.end,breakMinutes:tpl.breakMin,catId:cat.id};
    const {pay}=calcShift(mock);
    const payStr=cat.hourlyWage?`　${fmtYen(pay)}`:'';
    chip.innerHTML=`
      <span class="template-chip-dot" style="background:${cat.color}"></span>
      <span>${escHtml(tpl.label||`${tpl.start}–${tpl.end}`)}</span>
      <span style="opacity:.5;font-size:10px">${tpl.start}–${tpl.end}${payStr}</span>`;
    chip.addEventListener('click',()=>{
      document.getElementById('js-shift-start').value=tpl.start;
      document.getElementById('js-shift-end').value=tpl.end;
      document.getElementById('js-shift-break').value=tpl.breakMin??0;
      updateWagePreview();
      switchTab('shift');
    });
    list.appendChild(chip);
  });
}

// ── Event template chips (normal categories) ─────────────────────────────────

function renderEventTemplateChips() {
  const row=document.getElementById('js-ev-template-row');
  const list=document.getElementById('js-ev-template-chip-list');
  list.innerHTML='';
  const all=[];
  normalCats().forEach(cat=>(cat.templates||[]).forEach(tpl=>all.push({cat,tpl})));
  if (!all.length){row.style.display='none';return;}
  row.style.display='';
  all.forEach(({cat,tpl})=>{
    const chip=document.createElement('button');
    chip.className='template-chip';
    const timeStr=(tpl.start&&tpl.end)?`${tpl.start}–${tpl.end}`:(tpl.start||'');
    chip.innerHTML=`
      <span class="template-chip-dot" style="background:${cat.color}"></span>
      <span>${escHtml(tpl.title||tpl.label||'テンプレート')}</span>
      ${timeStr?`<span style="opacity:.5;font-size:10px">${timeStr}</span>`:''}`;
    chip.addEventListener('click',()=>{
      document.getElementById('js-ev-title').value=tpl.title||tpl.label||'';
      document.getElementById('js-ev-time-start').value=tpl.start||'';
      document.getElementById('js-ev-time-end').value=tpl.end||'';
      // テンプレートのカテゴリを選択状態にする
      selectedCatId=cat.id;
      renderCatChips();
      switchTab('event');
    });
    list.appendChild(chip);
  });
}

// ── Existing events list ──────────────────────────────────────────────────────

function renderExistingEvents() {
  const container=document.getElementById('js-existing-events');
  container.innerHTML='';
  const dayEvs=sortEvs(events[selectedKey]||[]);
  if (!dayEvs.length){container.innerHTML='<div class="empty-state">まだ予定はありません</div>';return;}

  dayEvs.forEach(ev=>{
    const cat=getCat(ev.catId)||{color:'#888',name:'?'};
    const row=document.createElement('div');
    row.className='event-list-row';
    let titleHtml,metaHtml;
    if (isShift(ev.catId)&&ev.shiftStart) {
      const {workMinutes,breakMinutes,pay}=calcShift(ev);
      const brk=breakMinutes>0?`休憩${breakMinutes}分　`:'';
      const ot = ev.overtimeMinutes ?? 0;
      const otTag = ot > 0 ? `<span style="color:var(--color-accent-orange);font-weight:600"><svg class="svg-icon"><use href="#lucide-timer"/></svg>+${formatMinToHHMM(ot)}</span>　` : '';
      titleHtml=`<span class="ev-cat-chip" style="background:${cat.color}">${escHtml(cat.name)}</span>`;
      metaHtml=`<span class="ev-shift-time">${ev.shiftStart} – ${ev.shiftEnd}</span>
                <span>${brk}${otTag}勤務 ${fmtMin(workMinutes)}</span>
                <span class="ev-shift-pay">${fmtYen(pay)}</span>`;
    } else {
      titleHtml=renderInline(ev.title);
      const tRange = ev.time
        ? (ev.timeEnd ? `${ev.time} – ${ev.timeEnd}` : ev.time)
        : '';
      metaHtml=(tRange?`<span>${tRange}</span>`:'')+
               `<span class="ev-cat-chip" style="background:${cat.color}">${escHtml(cat.name)}</span>`;
    }
    // ── DOM要素を個別生成（innerHTML経由のリスナーより確実） ──
    const dot = document.createElement('span');
    dot.className = 'ev-color-dot';
    dot.style.background = cat.color;

    const info = document.createElement('div');
    info.className = 'ev-info ev-info--tappable';
    info.innerHTML = `<div class="ev-title">${titleHtml}</div><div class="ev-meta">${metaHtml}</div>`;
    info.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });

    const editBtn = document.createElement('button');
    editBtn.className = 'ev-edit-btn';
    editBtn.title = '編集';
    editBtn.innerHTML = '<svg class=\"svg-icon\"><use href=\"#lucide-pencil\"/></svg>';
    editBtn.type = 'button';
    editBtn.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });

    const delBtn = document.createElement('button');
    delBtn.className = 'ev-delete-btn';
    delBtn.title = '削除';
    delBtn.innerHTML = '<svg class=\"svg-icon\"><use href=\"#lucide-x\"/></svg>';
    delBtn.type = 'button';
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      e.preventDefault();
      if (!(await appConfirm('この予定を削除しますか？', '削除'))) return;
      const arr = events[selectedKey];
      const idx = arr.indexOf(ev);
      if (idx !== -1) {
        await deleteEventFromSupabase(ev);
        arr.splice(idx, 1);
        if (!arr.length) delete events[selectedKey];
        renderExistingEvents();
        renderAll();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'ev-actions';
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    row.appendChild(dot);
    row.appendChild(info);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

// ── Edit event modal ──────────────────────────────────────────────────────────

let editingEv = null;  // reference to the event object being edited
let editingCatId = null;

// `key` ('YYYY-MM-DD') はこの予定が属する日。省略時は selectedKey を使う。
// 省略できるのは openDayModal 経由の呼び出しだけ（あれが selectedKey を立てる
// 唯一の場所 = 1552 行）。日/週ビューやグラフのように日モーダルを経由しない
// 導線は必ず渡すこと。渡さないと、アプリを開いてから一度も日付セルを押して
// いなければ selectedKey が null で落ち、押していれば「その古い日付」の
// モーダルが開く。
function openEditModal(ev, key) {
  if (key) selectedKey = key;
  if (!selectedKey) return;        // 呼び出し側の渡し忘れで落とさない
  editingEv    = ev;
  editingCatId = ev.catId;
  const isS    = isShift(ev.catId);

  // Header
  const [y,m,d] = selectedKey.split('-').map(Number);
  document.getElementById('js-edit-modal-title').textContent = isS ? 'シフトを編集' : '予定を編集';
  document.getElementById('js-edit-modal-sub').textContent =
    `${MONTHS_INIT[m-1]} ${d}, ${y} (${DAYS_EN[new Date(y,m-1,d).getDay()]})`;

  // Show the right form
  document.getElementById('js-edit-tab-event').style.display = isS ? 'none' : '';
  document.getElementById('js-edit-tab-shift').style.display = isS ? ''     : 'none';

  if (isS) {
    document.getElementById('js-edit-shift-start').value    = ev.shiftStart || '';
    document.getElementById('js-edit-shift-end').value      = ev.shiftEnd   || '';
    document.getElementById('js-edit-shift-break').value    = ev.breakMinutes ?? 0;
    document.getElementById('js-edit-shift-overtime').value = formatMinToHHMM(ev.overtimeMinutes ?? 0);
    updateEditWagePreview();
  } else {
    document.getElementById('js-edit-ev-title').value       = ev.title   || '';
    document.getElementById('js-edit-ev-time-start').value = ev.time    || '';
    document.getElementById('js-edit-ev-time-end').value   = ev.timeEnd || '';
    const remSel = document.getElementById('js-edit-ev-reminder');
    if (remSel) remSel.value = ev.reminderMinutes != null ? String(ev.reminderMinutes) : '';
    renderEditCatChips();
  }

  openOverlay('js-edit-overlay');
  setTimeout(()=>{
    (isS
      ? document.getElementById('js-edit-shift-start')
      : document.getElementById('js-edit-ev-title'))?.focus();
  }, 80);
}

// Update visual selection state of chips without re-rendering the entire list.
function applyChipSelection(listEl, selectedId) {
  listEl.querySelectorAll('.cat-chip').forEach(el => {
    // dataset.catId is a string; convert to number to match cat.id type.
    const rawId  = el.dataset.catId;
    const id     = isNaN(Number(rawId)) ? rawId : Number(rawId);
    const cat    = getCat(id);
    if (!cat) return;
    const isSel = String(id) === String(selectedId);
    el.classList.toggle('is-selected', isSel);
    el.style.background = isSel ? cat.color : '';
    const dot = el.querySelector('.cat-chip-dot');
    if (dot) dot.style.background = isSel ? 'rgba(255,255,255,.7)' : cat.color;
  });
}

function renderEditCatChips() {
  const list = document.getElementById('js-edit-cat-chip-list');
  list.innerHTML = '';
  normalCats().forEach(cat => {
    const sel = cat.id === editingCatId;
    const chip = document.createElement('div');
    chip.className = 'cat-chip' + (sel ? ' is-selected' : '');
    chip.dataset.catId = cat.id;
    if (sel) chip.style.background = cat.color;
    chip.innerHTML = `<span class="cat-chip-dot" style="background:${sel?'rgba(255,255,255,.7)':cat.color}"></span>${escHtml(cat.name)}`;
    chip.addEventListener('click', () => {
      editingCatId = cat.id;
      applyChipSelection(list, editingCatId);
    });
    list.appendChild(chip);
  });
}

function updateEditWagePreview() {
  const start = document.getElementById('js-edit-shift-start').value;
  const end   = document.getElementById('js-edit-shift-end').value;
  const brk   = parseInt(document.getElementById('js-edit-shift-break').value) || 0;
  const ot    = parseHHMMtoMin(document.getElementById('js-edit-shift-overtime').value);
  const cat   = getCat(editingEv?.catId) ?? shiftCats()[0];
  const hEl   = document.getElementById('js-edit-preview-hours');
  const bEl   = document.getElementById('js-edit-preview-break');
  const oEl   = document.getElementById('js-edit-preview-overtime');
  const pEl   = document.getElementById('js-edit-preview-pay');
  if (!start || !end || !cat) {
    hEl.textContent='—'; bEl.textContent='—'; if (oEl) oEl.textContent='—'; pEl.textContent='—';
    return;
  }
  const {totalMinutes,workMinutes,pay} = calcShift({shiftStart:start,shiftEnd:end,breakMinutes:brk,catId:cat.id});
  hEl.textContent = `${fmtMin(totalMinutes)}（実働 ${fmtMin(workMinutes)}）`;
  bEl.textContent = brk > 0 ? `${brk}分` : 'なし';
  if (oEl) oEl.textContent = ot > 0 ? formatMinToHHMM(ot) : 'なし';
  pEl.textContent = fmtYen(pay);
}

['js-edit-shift-start','js-edit-shift-end','js-edit-shift-break','js-edit-shift-overtime'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateEditWagePreview);
});

document.getElementById('js-edit-save-btn').addEventListener('click', async () => {
  if (!editingEv) return;
  const isS = isShift(editingEv.catId);

  if (isS) {
    const start = document.getElementById('js-edit-shift-start').value;
    const end   = document.getElementById('js-edit-shift-end').value;
    const brk   = parseInt(document.getElementById('js-edit-shift-break').value) || 0;
    const ot    = parseHHMMtoMin(document.getElementById('js-edit-shift-overtime').value);
    if (!start || !end) { document.getElementById('js-edit-shift-start').focus(); return; }
    editingEv.shiftStart      = start;
    editingEv.shiftEnd        = end;
    editingEv.breakMinutes    = brk;
    editingEv.overtimeMinutes = ot;
  } else {
    const title = document.getElementById('js-edit-ev-title').value.trim();
    if (!title) { document.getElementById('js-edit-ev-title').focus(); return; }
    editingEv.title   = title;
    editingEv.time    = document.getElementById('js-edit-ev-time-start').value;
    editingEv.timeEnd = document.getElementById('js-edit-ev-time-end').value;
    editingEv.catId   = editingCatId;
    const remSel = document.getElementById('js-edit-ev-reminder');
    editingEv.reminderMinutes = remSel?.value ? +remSel.value : null;
  }

  await updateEventInSupabase(editingEv);
  closeOverlay('js-edit-overlay');
  closeOverlay('js-day-overlay');  // day overlay も閉じる
  renderExistingEvents();
  renderAll();
});

function closeEditModal() {
  closeOverlay('js-edit-overlay');
  editingEv = null;
}

document.getElementById('js-edit-modal-close').addEventListener('click', closeEditModal);
document.getElementById('js-edit-cancel-btn').addEventListener('click',  closeEditModal);
document.getElementById('js-edit-overlay').addEventListener('click', e => {
  if (_isBackdropClick(e, 'js-edit-overlay')) closeEditModal();
});

// Also close edit modal on Escape (extend existing keydown handler below)

// ── Cat chips ─────────────────────────────────────────────────────────────────

function renderCatChips() {
  const list=document.getElementById('js-cat-chip-list');
  list.innerHTML='';
  normalCats().forEach(cat=>{
    const sel=cat.id===selectedCatId;
    const chip=document.createElement('div');
    chip.className='cat-chip'+(sel?' is-selected':'');
    chip.dataset.catId=cat.id;
    if (sel) chip.style.background=cat.color;
    chip.innerHTML=`<span class="cat-chip-dot" style="background:${sel?'rgba(255,255,255,.7)':cat.color}"></span>${escHtml(cat.name)}`;
    chip.addEventListener('click',()=>{
      selectedCatId=cat.id;
      applyChipSelection(list, selectedCatId);
    });
    list.appendChild(chip);
  });
}

// ── Add normal event ──────────────────────────────────────────────────────────

document.getElementById('js-add-event-btn').addEventListener('click',addEvent);
document.getElementById('js-ev-title').addEventListener('keydown',e=>{if(e.key==='Enter')addEvent();});

// 飲酒カウンター: 健康ナッジ用の警告しきい値
const DRINK_WARN_THRESHOLD = 3;

function showDrinkLimitWarning(targetValue) {
  return new Promise(resolve => {
    document.getElementById('js-drink-limit-val').textContent = targetValue;
    const cancelBtn  = document.getElementById('js-drink-limit-cancel');
    const confirmBtn = document.getElementById('js-drink-limit-confirm');
    const closeBtn   = document.getElementById('js-drink-limit-close');
    const onCancel  = () => cleanup(false);
    const onConfirm = () => cleanup(true);
    function cleanup(answer) {
      cancelBtn.removeEventListener('click',  onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      closeBtn.removeEventListener('click',   onCancel);
      closeOverlay('js-drink-limit-overlay');
      resolve(answer);
    }
    cancelBtn.addEventListener('click',  onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    closeBtn.addEventListener('click',   onCancel);   // ✕ は「やめる」扱い
    openOverlay('js-drink-limit-overlay');
    setTimeout(() => cancelBtn.focus(), 80);          // 初期フォーカスは安全側
  });
}

// 飲酒カウンター: optimistic update + 失敗時 rollback で Supabase に保存
document.getElementById('js-day-drink-count').addEventListener('change', async e => {
  let v = Math.max(0, Math.min(99, parseInt(e.target.value, 10) || 0));
  e.target.value = v;
  if (!selectedKey) return;

  const oldStored = dailyDrinks[selectedKey] ?? 0;

  // 3 を超える入力に対して毎回警告
  if (v > DRINK_WARN_THRESHOLD) {
    const proceed = await showDrinkLimitWarning(v);
    if (!proceed) {
      v = DRINK_WARN_THRESHOLD;
      e.target.value = v;
      e.target.dispatchEvent(new Event('input', { bubbles: true }));  // ステッパー disabled 同期
    }
  }

  const oldV = dailyDrinks[selectedKey];   // optimistic 用バックアップ
  if (v === 0) delete dailyDrinks[selectedKey];
  else         dailyDrinks[selectedKey] = v;
  renderAll();                              // 即時UI反映

  try {
    await setDrinkCount(selectedKey, v);
  } catch (err) {
    // Rollback
    if (oldV == null) delete dailyDrinks[selectedKey];
    else              dailyDrinks[selectedKey] = oldV;
    const inp = document.getElementById('js-day-drink-count');
    inp.value = oldV ?? 0;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    renderAll();
    alert('飲酒数の保存に失敗しました。\n' + (err.message || JSON.stringify(err)));
  }
});

// 飲酒カウンターの +/- ステッパー
(function initDrinkStepper() {
  const input = document.getElementById('js-day-drink-count');
  const dec   = document.getElementById('js-day-drink-dec');
  const inc   = document.getElementById('js-day-drink-inc');
  if (!input || !dec || !inc) return;

  function updateStepperState() {
    const v = parseInt(input.value, 10) || 0;
    dec.disabled = (v <= 0);
    inc.disabled = (v >= 99);
  }
  function bump(delta) {
    const cur = parseInt(input.value, 10) || 0;
    const next = Math.max(0, Math.min(99, cur + delta));
    if (next === cur) return;
    input.value = next;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    updateStepperState();
  }

  dec.addEventListener('click', () => bump(-1));
  inc.addEventListener('click', () => bump(+1));
  input.addEventListener('input', updateStepperState);
  updateStepperState();
})();

async function addEvent() {
  const title=document.getElementById('js-ev-title').value.trim();
  if (!title){document.getElementById('js-ev-title').focus();return;}
  const time=document.getElementById('js-ev-time-start').value;
  const timeEnd=document.getElementById('js-ev-time-end').value;
  const remSel=document.getElementById('js-ev-reminder');
  const reminderMinutes=remSel?.value?+remSel.value:null;
  const ev={title,time,timeEnd,catId:selectedCatId,reminderMinutes};
  if (!events[selectedKey]) events[selectedKey]=[];
  events[selectedKey].push(ev);
  await addEventToSupabase(selectedKey,ev);
  document.getElementById('js-ev-title').value='';
  document.getElementById('js-ev-time-start').value='';
  document.getElementById('js-ev-time-end').value='';
  if (remSel) remSel.value='';
  renderExistingEvents();
  renderAll();
}

// ── Shift wage preview ────────────────────────────────────────────────────────

['js-shift-start','js-shift-end','js-shift-break','js-shift-overtime'].forEach(id=>{
  document.getElementById(id).addEventListener('input',updateWagePreview);
});

function updateWagePreview() {
  const start=document.getElementById('js-shift-start').value;
  const end=document.getElementById('js-shift-end').value;
  const brk=parseInt(document.getElementById('js-shift-break').value)||0;
  const ot =parseHHMMtoMin(document.getElementById('js-shift-overtime').value);
  const cat=shiftCats()[0];
  const hEl=document.getElementById('js-preview-hours');
  const bEl=document.getElementById('js-preview-break');
  const oEl=document.getElementById('js-preview-overtime');
  const pEl=document.getElementById('js-preview-pay');
  if (!start||!end||!cat){hEl.textContent='—';bEl.textContent='—'; if(oEl)oEl.textContent='—'; pEl.textContent='—';return;}
  const {totalMinutes,workMinutes,pay}=calcShift({shiftStart:start,shiftEnd:end,breakMinutes:brk,catId:cat.id});
  hEl.textContent=`${fmtMin(totalMinutes)}（実働 ${fmtMin(workMinutes)}）`;
  bEl.textContent=brk>0?`${brk}分`:'なし';
  if(oEl) oEl.textContent = ot>0 ? formatMinToHHMM(ot) : 'なし';
  pEl.textContent=fmtYen(pay);
}

// ── Add shift ─────────────────────────────────────────────────────────────────

document.getElementById('js-add-shift-btn').addEventListener('click',addShift);

async function addShift() {
  const start=document.getElementById('js-shift-start').value;
  const end=document.getElementById('js-shift-end').value;
  const brk=parseInt(document.getElementById('js-shift-break').value)||0;
  const ot =parseHHMMtoMin(document.getElementById('js-shift-overtime').value);
  const cat=shiftCats()[0];
  if (!start||!end){document.getElementById('js-shift-start').focus();return;}
  if (!cat) return;
  const ev={title:'',catId:cat.id,shiftStart:start,shiftEnd:end,breakMinutes:brk,overtimeMinutes:ot};
  if (!events[selectedKey]) events[selectedKey]=[];
  events[selectedKey].push(ev);
  await addEventToSupabase(selectedKey,ev);
  document.getElementById('js-shift-start').value='';
  document.getElementById('js-shift-end').value='';
  document.getElementById('js-shift-break').value='';
  document.getElementById('js-shift-overtime').value='00:00';
  updateWagePreview();
  renderExistingEvents();
  renderAll();
}

// ── Repeat / copy to weekdays ─────────────────────────────────────────────────

// 基準日からその月末までで、選択曜日に該当する dateKey 群を返す
function _datesForWeekdaysInMonth(baseKey, dowSet, excludeBase) {
  const parts = baseKey.split('-').map(Number);   // [y, m(1-based), d]
  const by = parts[0], bm = parts[1], bd = parts[2];
  const lastDay = new Date(by, bm, 0).getDate();  // 当月末日
  const keys = [];
  for (let d = bd; d <= lastDay; d++) {
    const dow = new Date(by, bm - 1, d).getDay();
    if (!dowSet.has(dow)) continue;
    const key = dateKey(by, bm - 1, d);           // dateKey は 0-based 月
    if (excludeBase && key === baseKey) continue;
    keys.push(key);
  }
  return keys;
}

// 予定/シフトのクローン（_dbId は引き継がない）
function _cloneEv(src) {
  if (isShift(src.catId)) {
    return { title:'', catId:src.catId, shiftStart:src.shiftStart, shiftEnd:src.shiftEnd,
             breakMinutes:src.breakMinutes ?? 0, overtimeMinutes:src.overtimeMinutes ?? 0 };
  }
  return { title:src.title ?? '', time:src.time || '', timeEnd:src.timeEnd || '', catId:src.catId,
           reminderMinutes:src.reminderMinutes ?? null };
}

// 各日付に clone を作成して保存
async function _copyEventToDates(srcEv, dateKeys) {
  for (const key of dateKeys) {
    const clone = _cloneEv(srcEv);
    if (!events[key]) events[key] = [];
    events[key].push(clone);
    await addEventToSupabase(key, clone);          // detectEventColumns はキャッシュ済
  }
}

let _repeatSrcEv = null, _repeatBaseKey = null, _repeatExcludeBase = false;
const _repeatDows = new Set();

function _repeatSummary(ev) {
  const cat = getCat(ev.catId) || { name:'?' };
  if (isShift(ev.catId)) return `${cat.name}　${ev.shiftStart || ''}–${ev.shiftEnd || ''}`;
  const t = ev.time ? `　${ev.time}${ev.timeEnd ? '–' + ev.timeEnd : ''}` : '';
  return `${ev.title || ''}${t}`;
}

function openRepeatPicker(srcEv, opts) {
  _repeatSrcEv = srcEv;
  _repeatBaseKey = selectedKey;
  _repeatExcludeBase = !!(opts && opts.excludeBase);
  _repeatDows.clear();
  const p = selectedKey.split('-').map(Number);
  _repeatDows.add(new Date(p[0], p[1]-1, p[2]).getDay());   // 既定で基準日の曜日
  document.getElementById('js-repeat-modal-sub').textContent = _repeatSummary(srcEv);
  _renderRepeatDowChips();
  _updateRepeatCount();
  openOverlay('js-repeat-overlay');
}

function _renderRepeatDowChips() {
  const list = document.getElementById('js-repeat-dow-list');
  list.innerHTML = '';
  ['日','月','火','水','木','金','土'].forEach((label, dow) => {
    const chip = document.createElement('div');
    chip.className = 'dow-chip' + (_repeatDows.has(dow) ? ' is-selected' : '');
    chip.dataset.dow = dow;
    chip.textContent = label;
    chip.addEventListener('click', () => {
      if (_repeatDows.has(dow)) _repeatDows.delete(dow); else _repeatDows.add(dow);
      chip.classList.toggle('is-selected');
      _updateRepeatCount();
    });
    list.appendChild(chip);
  });
}

function _updateRepeatCount() {
  const n = _datesForWeekdaysInMonth(_repeatBaseKey, _repeatDows, _repeatExcludeBase).length;
  document.getElementById('js-repeat-count').textContent = `${n} 日に追加します`;
}

document.getElementById('js-repeat-confirm-btn').addEventListener('click', async () => {
  if (!_repeatSrcEv) return;
  const keys = _datesForWeekdaysInMonth(_repeatBaseKey, _repeatDows, _repeatExcludeBase);
  if (!keys.length) { alert('対象の曜日がありません。'); return; }
  await _copyEventToDates(_repeatSrcEv, keys);
  closeOverlay('js-repeat-overlay');
  closeOverlay('js-edit-overlay');          // 編集経由なら閉じる（未オープンなら no-op）
  renderExistingEvents();
  renderAll();
});

function closeRepeatPicker(){ closeOverlay('js-repeat-overlay'); _repeatSrcEv = null; }
document.getElementById('js-repeat-modal-close').addEventListener('click', closeRepeatPicker);
document.getElementById('js-repeat-cancel-btn').addEventListener('click', closeRepeatPicker);
document.getElementById('js-repeat-overlay').addEventListener('click', e => {
  if (_isBackdropClick(e, 'js-repeat-overlay')) closeRepeatPicker();
});

// 導線① 予定タブ：曜日を指定して追加
document.getElementById('js-ev-repeat-btn').addEventListener('click', () => {
  const title = document.getElementById('js-ev-title').value.trim();
  if (!title) { document.getElementById('js-ev-title').focus(); return; }
  const remSel = document.getElementById('js-ev-reminder');
  const ev = {
    title,
    time:    document.getElementById('js-ev-time-start').value,
    timeEnd: document.getElementById('js-ev-time-end').value,
    catId:   selectedCatId,
    reminderMinutes: remSel?.value ? +remSel.value : null
  };
  openRepeatPicker(ev, { excludeBase:false });
});

// 導線② シフトタブ：曜日を指定して追加
document.getElementById('js-shift-repeat-btn').addEventListener('click', () => {
  const start = document.getElementById('js-shift-start').value;
  const end   = document.getElementById('js-shift-end').value;
  const brk   = parseInt(document.getElementById('js-shift-break').value) || 0;
  const ot    = parseHHMMtoMin(document.getElementById('js-shift-overtime').value);
  const cat   = shiftCats()[0];
  if (!start || !end) { document.getElementById('js-shift-start').focus(); return; }
  if (!cat) return;
  const ev = { title:'', catId:cat.id, shiftStart:start, shiftEnd:end, breakMinutes:brk, overtimeMinutes:ot };
  openRepeatPicker(ev, { excludeBase:false });
});

// 導線③ 編集モーダル：他の日にコピー（フォームの現在値を元にする）
document.getElementById('js-edit-copy-btn').addEventListener('click', () => {
  if (!editingEv) return;
  let srcEv;
  if (isShift(editingEv.catId)) {
    const start = document.getElementById('js-edit-shift-start').value;
    const end   = document.getElementById('js-edit-shift-end').value;
    const brk   = parseInt(document.getElementById('js-edit-shift-break').value) || 0;
    const ot    = parseHHMMtoMin(document.getElementById('js-edit-shift-overtime').value);
    if (!start || !end) { document.getElementById('js-edit-shift-start').focus(); return; }
    srcEv = { title:'', catId:editingEv.catId, shiftStart:start, shiftEnd:end, breakMinutes:brk, overtimeMinutes:ot };
  } else {
    const title = document.getElementById('js-edit-ev-title').value.trim();
    if (!title) { document.getElementById('js-edit-ev-title').focus(); return; }
    const remSel = document.getElementById('js-edit-ev-reminder');
    srcEv = {
      title,
      time:    document.getElementById('js-edit-ev-time-start').value,
      timeEnd: document.getElementById('js-edit-ev-time-end').value,
      catId:   editingCatId,
      reminderMinutes: remSel?.value ? +remSel.value : null
    };
  }
  openRepeatPicker(srcEv, { excludeBase:true });
});

// ── Overtime cashout modal ────────────────────────────────────────────────────

let _overtimeCashoutCatId = null;
let _overtimeHistoryCatId = null;

function openOvertimeCashoutModal() {
  const cats = shiftCats().filter(c => getOvertimeBank(c.id) > 0);
  if (!cats.length) {
    alert('残業バンクに残高があるバイトがありません。');
    return;
  }
  _overtimeCashoutCatId = cats[0].id;
  document.getElementById('js-overtime-cashout-time').value = '00:00';
  document.getElementById('js-overtime-cashout-note').value = '';
  document.getElementById('js-overtime-cashout-warning').style.display = 'none';
  // 計上先の月を明示（curDate ベース、挙動は変えない）
  const sub = document.getElementById('js-overtime-cashout-sub');
  if (sub) sub.textContent = `${curDate.getFullYear()}年${curDate.getMonth()+1}月 の給料に振替えます`;
  renderOvertimeCashoutCatChips();
  updateOvertimeCashoutPreview();
  openOverlay('js-overtime-cashout-overlay');
  setTimeout(() => document.getElementById('js-overtime-cashout-time')?.focus(), 80);
}

function renderOvertimeCashoutCatChips() {
  const list = document.getElementById('js-overtime-cashout-cat-list');
  list.innerHTML = '';
  shiftCats().forEach(cat => {
    const bank = getOvertimeBank(cat.id);
    const sel = cat.id === _overtimeCashoutCatId;
    const chip = document.createElement('div');
    chip.className = 'cat-chip' + (sel ? ' is-selected' : '');
    chip.dataset.catId = cat.id;
    if (sel) chip.style.background = cat.color;
    chip.innerHTML = `<span class="cat-chip-dot" style="background:${sel?'rgba(255,255,255,.7)':cat.color}"></span>${escHtml(cat.name)} <span style="opacity:.6;font-size:10px;margin-left:4px">${formatMinToHHMM(bank)}</span>`;
    chip.addEventListener('click', () => {
      _overtimeCashoutCatId = cat.id;
      applyChipSelection(list, _overtimeCashoutCatId);
      updateOvertimeCashoutPreview();
    });
    list.appendChild(chip);
  });
}

function updateOvertimeCashoutPreview() {
  const cat = getCat(_overtimeCashoutCatId);
  if (!cat) return;
  const bank = getOvertimeBank(cat.id);
  const minutes = parseHHMMtoMin(document.getElementById('js-overtime-cashout-time').value);
  const wage = cat.hourlyWage ?? 0;
  const pay = Math.floor(minutes / 60 * wage);

  document.getElementById('js-overtime-cashout-balance').textContent = formatMinToHHMM(bank);
  document.getElementById('js-overtime-cashout-preview-amount').textContent = fmtYen(pay);

  const warn = document.getElementById('js-overtime-cashout-warning');
  const btn  = document.getElementById('js-overtime-cashout-confirm');
  if (minutes === 0) {
    warn.style.display = 'none';
    btn.disabled = true;
  } else if (minutes > bank) {
    warn.textContent = `バンク残高（${formatMinToHHMM(bank)}）を超えています。`;
    warn.style.display = '';
    btn.disabled = true;
  } else if (!wage) {
    warn.textContent = 'このカテゴリには時給が設定されていません。';
    warn.style.display = '';
    btn.disabled = true;
  } else {
    warn.style.display = 'none';
    btn.disabled = false;
  }
}

document.getElementById('js-overtime-cashout-time').addEventListener('input', updateOvertimeCashoutPreview);

document.getElementById('js-overtime-cashout-close').addEventListener('click', () => closeOverlay('js-overtime-cashout-overlay'));
document.getElementById('js-overtime-cashout-cancel').addEventListener('click', () => closeOverlay('js-overtime-cashout-overlay'));
document.getElementById('js-overtime-cashout-overlay').addEventListener('click', e => {
  if (e.target.id === 'js-overtime-cashout-overlay') closeOverlay('js-overtime-cashout-overlay');
});

document.getElementById('js-overtime-cashout-confirm').addEventListener('click', async () => {
  const cat = getCat(_overtimeCashoutCatId);
  if (!cat) return;
  const minutes = parseHHMMtoMin(document.getElementById('js-overtime-cashout-time').value);
  const bank = getOvertimeBank(cat.id);
  if (minutes <= 0 || minutes > bank) return;
  const note = document.getElementById('js-overtime-cashout-note').value.trim();

  // 表示中の月の1日を date_key とする（その月に計上）
  const y = curDate.getFullYear(), m = curDate.getMonth();
  const key = dateKey(y, m, 1);

  const cashout = { catId: cat.id, minutes, note, dateKey: key };
  try {
    await addOvertimeCashoutToSupabase(cashout);
    overtimeCashouts.unshift(cashout);
    closeOverlay('js-overtime-cashout-overlay');
    renderAll();
  } catch (_) { /* error already shown */ }
});

// ── Overtime history modal ────────────────────────────────────────────────────

function openOvertimeHistoryModal() {
  const cats = shiftCats();
  if (!cats.length) return;
  _overtimeHistoryCatId = cats[0].id;
  renderOvertimeHistoryTabs();
  renderOvertimeHistoryContent();
  openOverlay('js-overtime-history-overlay');
}

function renderOvertimeHistoryTabs() {
  const tabs = document.getElementById('js-overtime-history-tabs');
  tabs.innerHTML = '';
  shiftCats().forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'overtime-history-tab' + (cat.id === _overtimeHistoryCatId ? ' is-active' : '');
    btn.dataset.catId = cat.id;
    btn.innerHTML = `<span style="color:${cat.color}">●</span> ${escHtml(cat.name)}`;
    btn.addEventListener('click', () => {
      _overtimeHistoryCatId = cat.id;
      tabs.querySelectorAll('.overtime-history-tab').forEach(t => {
        t.classList.toggle('is-active', t.dataset.catId === String(cat.id));
      });
      renderOvertimeHistoryContent();
    });
    tabs.appendChild(btn);
  });
}

function renderOvertimeHistoryContent() {
  const cat = getCat(_overtimeHistoryCatId);
  const box = document.getElementById('js-overtime-history-content');
  box.innerHTML = '';
  if (!cat) return;

  const bank = getOvertimeBank(cat.id);
  const totalEarned = totalOvertimeMinutesByCat(cat.id);
  const totalCashedOut = totalCashoutMinutesByCat(cat.id);

  // バンク残高サマリー
  const summary = document.createElement('div');
  summary.style.cssText = 'display:flex;justify-content:space-around;padding:10px;background:var(--color-bg-input);border-radius:5px;margin-bottom:14px;font-size:12px';
  summary.innerHTML = `
    <div style="text-align:center"><div style="opacity:.6;font-size:10px">累計残業</div><div style="font-weight:700;font-size:14px">${formatMinToHHMM(totalEarned)}</div></div>
    <div style="text-align:center"><div style="opacity:.6;font-size:10px">振替済</div><div style="font-weight:700;font-size:14px;color:var(--color-positive)">${formatMinToHHMM(totalCashedOut)}</div></div>
    <div style="text-align:center"><div style="opacity:.6;font-size:10px">バンク残高</div><div style="font-weight:700;font-size:14px;color:var(--color-accent-orange)">${formatMinToHHMM(bank)}</div></div>`;
  box.appendChild(summary);

  // 月別残業ログ
  const monthLog = collectMonthlyOvertimeLog(cat.id);
  if (monthLog.length) {
    const section = document.createElement('div');
    section.className = 'overtime-history-section';
    section.innerHTML = '<div class="overtime-history-section-title">月別の残業</div>';
    monthLog.forEach(({year, month, minutes, count}) => {
      const row = document.createElement('div');
      row.className = 'overtime-history-row';
      row.innerHTML = `
        <span class="row-label">${year}年 ${month+1}月</span>
        <span class="row-meta">${count}件のシフト</span>
        <span class="row-amount">+${formatMinToHHMM(minutes)}</span>`;
      section.appendChild(row);
    });
    box.appendChild(section);
  }

  // キャッシュアウト履歴
  const section2 = document.createElement('div');
  section2.className = 'overtime-history-section';
  section2.innerHTML = '<div class="overtime-history-section-title">給料への振替履歴</div>';
  const cashouts = overtimeCashouts.filter(c => c.catId === cat.id);
  if (!cashouts.length) {
    section2.innerHTML += '<div class="overtime-history-empty">まだ振替えていません</div>';
  } else {
    cashouts.forEach(c => {
      const d = new Date(c.dateKey);
      const pay = Math.floor(c.minutes / 60 * (cat.hourlyWage ?? 0));
      const row = document.createElement('div');
      row.className = 'overtime-history-row';
      row.innerHTML = `
        <span class="row-label">${d.getFullYear()}年 ${d.getMonth()+1}月 ${escHtml(c.note || '')}</span>
        <span class="row-amount">${formatMinToHHMM(c.minutes)}</span>
        <span class="row-pay">${fmtYen(pay)}</span>
        <button class="row-undo" type="button">取消</button>`;
      row.querySelector('.row-undo').addEventListener('click', async () => {
        if (!(await appConfirm(`この振替（${formatMinToHHMM(c.minutes)} / ${fmtYen(pay)}）を取消してバンクに戻しますか？`, '取消'))) return;
        await deleteOvertimeCashoutFromSupabase(c);
        const idx = overtimeCashouts.indexOf(c);
        if (idx !== -1) overtimeCashouts.splice(idx, 1);
        renderOvertimeHistoryContent();
        renderAll();
      });
      section2.appendChild(row);
    });
  }
  box.appendChild(section2);
}

function collectMonthlyOvertimeLog(catId) {
  // 全期間の events を走査して年月別に集計
  const buckets = new Map();
  for (const key of Object.keys(events)) {
    const [y, m] = key.split('-').map(Number);
    if (isNaN(y) || isNaN(m)) continue;
    for (const ev of events[key]) {
      if (ev.catId !== catId || !isShift(ev.catId)) continue;
      const ot = ev.overtimeMinutes ?? 0;
      if (!ot) continue;
      const k = `${y}-${m}`;
      if (!buckets.has(k)) buckets.set(k, {year: y, month: m-1, minutes: 0, count: 0});
      buckets.get(k).minutes += ot;
      buckets.get(k).count += 1;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return b.month - a.month;
  });
}

document.getElementById('js-overtime-history-close').addEventListener('click', () => closeOverlay('js-overtime-history-overlay'));
document.getElementById('js-overtime-history-overlay').addEventListener('click', e => {
  if (e.target.id === 'js-overtime-history-overlay') closeOverlay('js-overtime-history-overlay');
});

// ── Category editor ───────────────────────────────────────────────────────────

// ── Settings modal (Obsidian: .modal.mod-settings) ───────────────────────────
// カテゴリ / 家計簿カテゴリ / JCB / Vault は独立モーダルから縦タブのペインへ
// 集約された。中身の DOM と id はそのままなので、各ペインの JS は無変更。
function openSettings(tab) {
  document.querySelectorAll('#js-settings-overlay .vertical-tab-nav-item').forEach(n =>
    n.classList.toggle('is-active', n.dataset.settingsTab === tab));
  document.querySelectorAll('#js-settings-overlay .vertical-tab-content').forEach(p =>
    p.style.display = p.dataset.settingsTab === tab ? '' : 'none');
  openOverlay('js-settings-overlay');
}
function closeSettings() {
  closeOverlay('js-settings-overlay');
  closeColorPopup();
}

document.querySelectorAll('#js-settings-overlay .vertical-tab-nav-item').forEach(nav => {
  const go = () => openSettings(nav.dataset.settingsTab);
  nav.addEventListener('click', go);
  nav.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
});
document.getElementById('js-settings-close')?.addEventListener('click', closeSettings);
document.addEventListener('click', e => {
  if (_isBackdropClick(e, 'js-settings-overlay')) closeSettings();
});

function openCatEditor() {
  editingCats=deepClone(categories);
  renderCatEditorList();
  openSettings('cat');
}

function renderCatEditorList() {
  const list=document.getElementById('js-cat-editor-list');
  list.innerHTML='';
  editingCats.forEach((cat,idx)=>{
    const isS=cat.type==='shift';
    const wrap=document.createElement('div');

    const row=document.createElement('div');
    row.className='cat-editor-row';
    row.innerHTML=`
      <button class="cat-color-swatch" style="background:${cat.color}" title="色を変更"></button>
      <input  class="cat-name-field" type="text" value="${escHtml(cat.name)}" placeholder="カテゴリ名" />
      <div class="cat-type-toggle">
        <button class="cat-type-btn ${!isS?'is-active':''}" data-type="normal">予定</button>
        <button class="cat-type-btn ${isS?'is-active':''}" data-type="shift">バイト</button>
      </div>
      <button class="cat-delete-btn" title="削除"><svg class="svg-icon"><use href="#lucide-trash-2"/></svg></button>`;

    const wageRow=document.createElement('div');
    wageRow.className='cat-wage-row'+(isS?' is-visible':'');
    wageRow.innerHTML=`
      <span class="cat-wage-label">時給</span>
      <input class="cat-wage-input" type="number" value="${cat.hourlyWage||''}" placeholder="1000" min="0" />
      <span class="cat-wage-unit">円 / h</span>`;

    // テンプレートセクション（shift・normalどちらも表示）
    const tplSection=document.createElement('div');
    tplSection.className='tpl-section is-visible';

    function rebuildTpls() {
      tplSection.innerHTML='';
      const tpls=cat.templates||[];
      if (tpls.length){
        const lbl=document.createElement('div');
        lbl.className='tpl-section-label';
        lbl.textContent=isS?'シフトテンプレート':'予定テンプレート';
        tplSection.appendChild(lbl);
      }
      tpls.forEach((tpl,ti)=>{
        const trow=document.createElement('div'); trow.className='tpl-row';
        if (isS) {
          // シフトテンプレート（従来通り：ラベル＋時刻＋休憩）
          trow.innerHTML=`
            <input class="tpl-input" type="text"   placeholder="名前"     value="${escHtml(tpl.label||'')}"  data-field="label" />
            <input class="tpl-input" type="time"   value="${tpl.start||''}" data-field="start" />
            <span  class="tpl-sep">〜</span>
            <input class="tpl-input" type="time"   value="${tpl.end||''}"   data-field="end"   />
            <input class="tpl-input tpl-break-input" type="number" value="${tpl.breakMin??''}" placeholder="休憩(分)" min="0" data-field="breakMin" />
            <button class="tpl-delete-btn" title="削除">✕</button>`;
        } else {
          // 予定テンプレート（タイトル＋開始/終了時刻）
          trow.innerHTML=`
            <input class="tpl-input tpl-title-input" type="text"  placeholder="タイトル" value="${escHtml(tpl.title||tpl.label||'')}" data-field="title" />
            <input class="tpl-input" type="time"  value="${tpl.start||''}" data-field="start" />
            <span  class="tpl-sep">〜</span>
            <input class="tpl-input" type="time"  value="${tpl.end||''}"   data-field="end"   />
            <button class="tpl-delete-btn" title="削除">✕</button>`;
        }
        trow.querySelectorAll('.tpl-input').forEach(inp=>{
          inp.addEventListener('input',e=>{
            const f=e.target.dataset.field;
            if (f==='breakMin') {
              editingCats[idx].templates[ti][f]=parseInt(e.target.value)||0;
            } else {
              editingCats[idx].templates[ti][f]=e.target.value;
              // normalの場合、titleをlabelにも同期（チップ表示用）
              if (f==='title') editingCats[idx].templates[ti].label=e.target.value;
            }
          });
        });
        trow.querySelector('.tpl-delete-btn').addEventListener('click',()=>{
          editingCats[idx].templates.splice(ti,1); rebuildTpls();
        });
        tplSection.appendChild(trow);
      });
      const addBtn=document.createElement('button');
      addBtn.className='add-tpl-btn';
      addBtn.textContent=isS?'＋ テンプレートを追加':'＋ 予定テンプレートを追加';
      addBtn.addEventListener('click',()=>{
        if (!editingCats[idx].templates) editingCats[idx].templates=[];
        if (isS) {
          editingCats[idx].templates.push({label:'',start:'',end:'',breakMin:0});
        } else {
          editingCats[idx].templates.push({label:'',title:'',start:'',end:''});
        }
        rebuildTpls();
        requestAnimationFrame(()=>{
          const fieldSel=isS?'.tpl-input[data-field="label"]':'.tpl-input[data-field="title"]';
          const ins=tplSection.querySelectorAll(fieldSel);
          ins[ins.length-1]?.focus();
        });
      });
      tplSection.appendChild(addBtn);
    }
    rebuildTpls();

    row.querySelector('.cat-color-swatch').addEventListener('click',e=>openColorPopup(e.currentTarget,idx));
    row.querySelector('.cat-name-field').addEventListener('input',e=>{editingCats[idx].name=e.target.value;});
    row.querySelectorAll('.cat-type-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        editingCats[idx].type=btn.dataset.type;
        if (btn.dataset.type!=='shift'){delete editingCats[idx].hourlyWage;}
        // テンプレートはタイプ切替時にクリアせず保持する
        renderCatEditorList();
      });
    });
    wageRow.querySelector('.cat-wage-input').addEventListener('input',e=>{
      editingCats[idx].hourlyWage=parseInt(e.target.value)||0;
    });
    row.querySelector('.cat-delete-btn').addEventListener('click',()=>{
      editingCats.splice(idx,1); renderCatEditorList();
    });

    wrap.appendChild(row); wrap.appendChild(wageRow); wrap.appendChild(tplSection);
    list.appendChild(wrap);
  });
}

document.getElementById('js-add-cat-row').addEventListener('click',()=>{
  const used=new Set(editingCats.map(c=>c.color));
  const color=PRESET_COLORS.find(c=>!used.has(c))??PRESET_COLORS[editingCats.length%PRESET_COLORS.length];
  const maxId=editingCats.reduce((mx,c)=>Math.max(mx,c.id),0);
  editingCats.push({id:maxId+1,name:'新カテゴリ',color,type:'normal'});
  renderCatEditorList();
  requestAnimationFrame(()=>{
    const ins=document.querySelectorAll('.cat-name-field');
    if (ins.length){ins[ins.length-1].focus();ins[ins.length-1].select();}
  });
});

document.getElementById('js-cat-save-btn').addEventListener('click',async()=>{
  categories=editingCats.filter(c=>c.name.trim());
  rebuildCatMap();
  const valid=new Set(categories.map(c=>c.id));
  // Remove events with deleted cat ids (from Supabase too) — parallelized
  const allToDelete=[];
  for (const key of Object.keys(events)) {
    const toDelete=events[key].filter(ev=>!valid.has(ev.catId));
    allToDelete.push(...toDelete);
    events[key]=events[key].filter(ev=>valid.has(ev.catId));
    if (!events[key].length) delete events[key];
  }
  await Promise.all(allToDelete.map(ev=>deleteEventFromSupabase(ev)));
  if (!getCat(selectedCatId)) selectedCatId=normalCats()[0]?.id??categories[0]?.id;
  await saveCategoriesToSupabase();
  closeSettings();
  renderAll();
});

// js-cat-modal-close は設定モーダルへの集約で消えた（ヘッダは1つに統合）。
document.getElementById('js-cat-cancel-btn')?.addEventListener('click', closeSettings);

// ── Color picker ──────────────────────────────────────────────────────────────

const colorPopup=document.getElementById('js-color-popup');

PRESET_COLORS.forEach(color=>{
  const sw=document.createElement('div');
  sw.className='color-swatch'; sw.style.background=color;
  sw.addEventListener('click',()=>{
    if (colorTargetIdx!==null){
      if (_colorMode==='budget_exp'){_budgetEditingExpCats[colorTargetIdx].color=color;renderBudgetCatEditorList();}
      else if (_colorMode==='budget_inc'){_budgetEditingIncCats[colorTargetIdx].color=color;renderBudgetCatEditorList();}
      else{editingCats[colorTargetIdx].color=color;renderCatEditorList();}
      closeColorPopup();
    }
  });
  document.getElementById('js-color-swatch-grid').appendChild(sw);
});

document.getElementById('js-custom-color-input').addEventListener('input',e=>{
  if (colorTargetIdx!==null){
    if (_colorMode==='budget_exp'){_budgetEditingExpCats[colorTargetIdx].color=e.target.value;renderBudgetCatEditorList();}
    else if (_colorMode==='budget_inc'){_budgetEditingIncCats[colorTargetIdx].color=e.target.value;renderBudgetCatEditorList();}
    else{editingCats[colorTargetIdx].color=e.target.value;renderCatEditorList();}
  }
});

function openColorPopup(el,idx,mode='calendar') {
  colorTargetIdx=idx;
  _colorMode=mode;
  const arr=mode==='budget_exp'?_budgetEditingExpCats:mode==='budget_inc'?_budgetEditingIncCats:editingCats;
  document.getElementById('js-custom-color-input').value=arr[idx].color;
  const rect=el.getBoundingClientRect(), popW=196;
  let left=rect.left;
  if (left+popW>window.innerWidth-10) left=window.innerWidth-popW-10;
  colorPopup.style.top=`${rect.bottom+6}px`;
  colorPopup.style.left=`${left}px`;
  colorPopup.classList.add('is-open');
}

function closeColorPopup(){colorPopup.classList.remove('is-open');colorTargetIdx=null;}

document.addEventListener('click',e=>{
  if (colorPopup.classList.contains('is-open')&&!colorPopup.contains(e.target)&&!e.target.classList.contains('cat-color-swatch')&&!e.target.classList.contains('bcat-color-swatch'))
    closeColorPopup();
});

// ── Overlay helpers ───────────────────────────────────────────────────────────

// Stack of focus-return targets, one per currently-open overlay.
const _overlayFocusStack = [];
const FOCUSABLE_SEL = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function _getTopOpenOverlay() {
  const overlays = document.querySelectorAll('.overlay.is-open');
  return overlays.length ? overlays[overlays.length - 1] : null;
}

// 背景クリック判定。Obsidian 構造では .modal-container の中に .modal-bg が
// 敷かれるので、背景を踏んだクリックの target は .modal-bg になり、
// 素朴な `e.target === overlay` では二度と真にならない。
function _isBackdropClick(e, overlayId) {
  const ov = document.getElementById(overlayId);
  if (!ov) return false;
  return e.target === ov || (e.target.classList.contains('modal-bg') && e.target.parentElement === ov);
}

function openOverlay(id){
  const el = document.getElementById(id);
  if (!el || el.classList.contains('is-open')) return;
  _overlayFocusStack.push(document.activeElement);
  el.classList.add('is-open');
}

function closeOverlay(id){
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('is-open')) return;
  el.classList.remove('is-open');
  const prev = _overlayFocusStack.pop();
  if (prev && typeof prev.focus === 'function') {
    try { prev.focus(); } catch (_) { /* element may be detached */ }
  }
}

// ── アプリ内ダイアログ（ネイティブ confirm/alert の代替）────────────────────
// 透過 + frameless の Electron ウィンドウではネイティブ confirm()/alert() を出すと
// ダイアログ後に入力を受け付けなくなる（要再起動）ことがあるため、HTML モーダルで代替する。
function appConfirm(message, okLabel){
  return new Promise(resolve=>{
    const ov = document.getElementById('js-confirm-overlay');
    const msg = document.getElementById('js-confirm-msg');
    const ok = document.getElementById('js-confirm-ok');
    const cancel = document.getElementById('js-confirm-cancel');
    if (!ov || !msg || !ok || !cancel){ resolve(true); return; }   // 要素が無ければ既定で許可
    msg.textContent = message;
    ok.textContent = okLabel || 'OK';
    function cleanup(v){
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      ov.removeEventListener('click', onBackdrop);
      closeOverlay('js-confirm-overlay');
      resolve(v);
    }
    const onOk = ()=>cleanup(true);
    const onCancel = ()=>cleanup(false);
    const onBackdrop = (e)=>{ if (e.target === ov || (e.target.classList.contains('modal-bg') && e.target.parentElement === ov)) cleanup(false); };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    ov.addEventListener('click', onBackdrop);
    openOverlay('js-confirm-overlay');
    setTimeout(()=>{ try { ok.focus(); } catch(_){} }, 50);
  });
}

let _appToastTimer = null;
function appNotice(message){
  const t = document.getElementById('js-app-toast');
  if (!t){ return; }
  t.textContent = String(message);
  t.classList.add('is-show');
  clearTimeout(_appToastTimer);
  _appToastTimer = setTimeout(()=>t.classList.remove('is-show'), 4500);
}

// ネイティブ alert を非ブロッキングのトーストに置き換え（同じ凍結対策）。
window.alert = function(message){ appNotice(message); };

document.getElementById('js-day-modal-close').addEventListener('click',()=>{
  closeOverlay('js-edit-overlay');
  closeOverlay('js-day-overlay');
});
document.getElementById('js-day-overlay').addEventListener('click',e=>{
  if (e.target===document.getElementById('js-day-overlay')){
    closeOverlay('js-edit-overlay');
    closeOverlay('js-day-overlay');
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────

// Shift the visible month, clamping to day 1 so month-end days never overflow
// into the wrong month (logic in lib/date-utils.js, tested in tests/).
function shiftMonth(delta){ curDate = shiftMonthDate(curDate, delta); }

document.getElementById('js-prev-month').addEventListener('click',()=>{shiftMonth(-1);renderAll();});
document.getElementById('js-next-month').addEventListener('click',()=>{shiftMonth(1);renderAll();});

// ── Swipe navigation (month view) ──────────────────────────────────────────────
(function() {
  const el = document.getElementById('js-month-view');
  const EDGE_ZONE = 22; // left-edge zone reserved for sidebar swipe
  let startX = 0, startY = 0, tracking = false, swiped = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = startX > EDGE_ZONE; // skip if starting from the sidebar edge zone
    swiped = false;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!tracking || swiped) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // 横方向が十分で、縦方向より大きいとき
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      tracking = false;
      e.preventDefault();
      if (dx < 0) {
        shiftMonth(1);
      } else {
        shiftMonth(-1);
      }
      renderAll();
    }
  }, { passive: false });
  el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

document.getElementById('js-today').addEventListener('click',()=>{curDate=new Date();renderAll();});
document.getElementById('js-mini-prev').addEventListener('click',()=>{shiftMonth(-1);renderAll();});
document.getElementById('js-mini-next').addEventListener('click',()=>{shiftMonth(1);renderAll();});
document.getElementById('js-open-cat-editor').addEventListener('click',openCatEditor);
document.getElementById('js-theme-toggle').addEventListener('click',toggleTheme);

// ── Budget category editor ─────────────────────────────────────────────────

let _budgetEditingExpCats = [];
let _budgetEditingIncCats = [];
let _budgetCatTab = 'expense'; // 'expense' | 'income'

function openBudgetCatEditor() {
  _budgetEditingExpCats = budgetExpenseCats.map(c=>({...c}));
  _budgetEditingIncCats = budgetIncomeCats.map(c=>({...c}));
  _budgetCatTab = 'expense';
  renderBudgetCatEditorList();
  document.querySelectorAll('.budget-cat-tab').forEach(b=>
    b.classList.toggle('is-active', b.dataset.bcatTab===_budgetCatTab));
  openSettings('bcat');
}

function renderBudgetCatEditorList() {
  const list = document.getElementById('js-budget-cat-editor-list');
  if (!list) return;
  const cats = _budgetCatTab==='expense' ? _budgetEditingExpCats : _budgetEditingIncCats;
  list.innerHTML = '';
  cats.forEach((cat,idx)=>{
    const row = document.createElement('div');
    row.className = 'cat-editor-row';
    row.innerHTML = `
      <button class="cat-color-swatch bcat-color-swatch" style="background:${cat.color}" title="色を変更"></button>
      <input class="bcat-icon-field" type="text" value="${escHtml(cat.icon)}" placeholder="🏷" maxlength="2" />
      <input class="cat-name-field" type="text" value="${escHtml(cat.name)}" placeholder="カテゴリ名" />
      <button class="cat-delete-btn" title="削除"><svg class="svg-icon"><use href="#lucide-trash-2"/></svg></button>`;
    row.querySelector('.bcat-color-swatch').addEventListener('click',e=>{
      openColorPopup(e.currentTarget, idx, _budgetCatTab==='expense'?'budget_exp':'budget_inc');
    });
    row.querySelector('.bcat-icon-field').addEventListener('input',e=>{
      (_budgetCatTab==='expense'?_budgetEditingExpCats:_budgetEditingIncCats)[idx].icon = e.target.value||'?';
    });
    row.querySelector('.cat-name-field').addEventListener('input',e=>{
      (_budgetCatTab==='expense'?_budgetEditingExpCats:_budgetEditingIncCats)[idx].name = e.target.value;
    });
    row.querySelector('.cat-delete-btn').addEventListener('click',()=>{
      if (_budgetCatTab==='expense') _budgetEditingExpCats.splice(idx,1);
      else _budgetEditingIncCats.splice(idx,1);
      renderBudgetCatEditorList();
    });
    list.appendChild(row);
  });
}

document.getElementById('js-add-budget-cat-row').addEventListener('click',()=>{
  const arr = _budgetCatTab==='expense' ? _budgetEditingExpCats : _budgetEditingIncCats;
  const used = new Set(arr.map(c=>c.color));
  const color = PRESET_COLORS.find(c=>!used.has(c))??PRESET_COLORS[arr.length%PRESET_COLORS.length];
  const prefix = _budgetCatTab==='expense'?'exp':'inc';
  arr.push({id:`${prefix}_${Date.now()}`, name:'新カテゴリ', icon:'🏷', color});
  renderBudgetCatEditorList();
  requestAnimationFrame(()=>{
    const fields = document.querySelectorAll('#js-budget-cat-editor-list .cat-name-field');
    fields[fields.length-1]?.focus();
    fields[fields.length-1]?.select();
  });
});

document.querySelectorAll('.budget-cat-tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    _budgetCatTab = btn.dataset.bcatTab;
    document.querySelectorAll('.budget-cat-tab').forEach(b=>b.classList.toggle('is-active',b===btn));
    renderBudgetCatEditorList();
  });
});

document.getElementById('js-budget-cat-save-btn').addEventListener('click',()=>{
  budgetExpenseCats = _budgetEditingExpCats.map(c=>({...c}));
  budgetIncomeCats  = _budgetEditingIncCats.map(c=>({...c}));
  _saveBudgetCats();
  _updateBudgetCatOptions();
  if (_budgetState) renderBudgetPanel();
  closeSettings();
});

// js-budget-cat-modal-close も同上。?. 無しだったので消し忘れると app.js が止まる。
document.getElementById('js-budget-cat-cancel-btn')?.addEventListener('click', closeSettings);
document.getElementById('js-open-budget-cat-editor').addEventListener('click',openBudgetCatEditor);

document.addEventListener('keydown',e=>{
  // Escapeキーはinput内でもモーダルを閉じられるようにする
  if (e.key==='Escape'){
    closeOverlay('js-day-overlay');closeSettings();closeEditModal();closeOverlay('js-receipt-overlay');closeOverlay('js-overtime-cashout-overlay');closeOverlay('js-overtime-history-overlay');closeRepeatPicker();closeOverlay('js-ios-guide-overlay');
    if (document.activeElement) document.activeElement.blur();
    return;
  }
  // Tab focus trap inside the topmost open modal
  if (e.key === 'Tab') {
    const overlay = _getTopOpenOverlay();
    if (overlay) {
      const focusables = Array.from(overlay.querySelectorAll(FOCUSABLE_SEL))
        .filter(el => el.offsetParent !== null);
      if (focusables.length) {
        const first = focusables[0];
        const last  = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault(); first.focus();
        } else if (!overlay.contains(active)) {
          e.preventDefault(); first.focus();
        }
      }
    }
    return;
  }
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key==='ArrowLeft'){shiftMonth(-1);renderAll();}
  if (e.key==='ArrowRight'){shiftMonth(1);renderAll();}
  if (e.key.toLowerCase()==='t'){curDate=new Date();renderAll();}
});

// ── XSS guard ─────────────────────────────────────────────────────────────────

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Status Bar ────────────────────────────────────────────────────────────────

const VIEW_LABELS = {
  month: 'Month', week: 'Week', day: 'Day',
  budget: '家計簿', goal: '目標', task: 'タスク', graph: 'グラフ',
};

function updateStatusBar() {
  const elView   = document.getElementById('js-status-view');
  const elDate   = document.getElementById('js-status-date');
  const elEvents = document.getElementById('js-status-events');
  if (!elView) return;

  elView.textContent = VIEW_LABELS[currentView] || currentView;

  const y = curDate.getFullYear(), m = curDate.getMonth();
  const monthStr = `${MONTHS_INIT[m]} ${y}`;
  elDate.textContent = monthStr;

  // Count events in current month
  const dim = new Date(y, m + 1, 0).getDate();
  let totalEv = 0;
  for (let d = 1; d <= dim; d++) {
    const k = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    totalEv += (events[k] || []).length;
  }
  elEvents.textContent = `${totalEv} 件のイベント`;
}

// ── Render all ────────────────────────────────────────────────────────────────

// 家計簿タブが表示中か。以前は .bp-tab.is-active を見ていたが、右スプリット
// 廃止でそのクラスが消えた。currentView が唯一の真実になる。
function isBudgetPanelVisible(){ return currentView === 'budget'; }

// サイドバー（ミニカレンダー・カテゴリ・給料サマリ）はタブと独立して常時見える
// のでゲートしない。メイン領域は表示中のビューだけ描く。
// 家計簿のゲートは元からある意図を引き継ぐ: 通常のカレンダー操作で 12ヶ月分の
// Supabase クエリを撃たないため。
function renderAll(){
  renderMini();
  renderSidebar();
  updateStatusBar();

  switch (currentView) {
    case 'month':  renderMain(); break;
    case 'week':   renderWeekView(); break;
    case 'day':    renderDayView(); break;
    case 'task':   if (typeof _taskState !== 'undefined' && _taskState) renderTaskPanel(); break;
    case 'goal':   renderGoalList(); break;
    case 'graph':  renderGraphView(); break;
    case 'budget':
      if (typeof _budgetState !== 'undefined' && _budgetState) {
        _syncBudgetMonth().then(function() { renderBudgetPanel(); });
      }
      break;
  }
  // 非表示のビューはここでは描かない。データ変更側が renderMain() 等を直接
  // 呼ぶ経路（10箇所以上）は残っているので、タブに戻ったとき内容は最新。
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// ── Ribbon (Obsidian: global actions only) ───────────────────────────────────
document.getElementById('js-ribbon-sidebar')?.addEventListener('click', () => {
  document.getElementById('js-sidebar-toggle')?.click();
});
document.getElementById('js-ribbon-today')?.addEventListener('click', () => {
  document.getElementById('js-today')?.click();
});
document.getElementById('js-ribbon-timer')?.addEventListener('click', () => {
  document.getElementById('js-mbb-timer')?.click();
});
// 設定の入口は2つ。モバイルではリボンが畳まれる（body:not(.show-ribbon)）ので、
// サイドバーのフッターにも歯車が要る。
document.getElementById('js-ribbon-settings')?.addEventListener('click', () => openSettings('cat'));
document.getElementById('js-sidebar-settings')?.addEventListener('click', () => openSettings('cat'));

applyTheme(isDark);
applyPlatformClass();
// MediaQueryList は参照を保持する。捨てると実装によっては GC され、
// change リスナーが黙って死ぬ。
const _narrowMQL = window.matchMedia('(max-width: 720px)');
_narrowMQL.addEventListener('change', applyPlatformClass);
// Auth state change will trigger showApp() → loadFromSupabase() → renderAll()

// ── Mobile sidebar hamburger toggle ──────────────────────────────────────────
(function initSidebarToggle() {
  const btn = document.getElementById('js-sidebar-toggle');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('js-sidebar-overlay');
  if (!btn || !sidebar) return;

  function open()  {
    sidebar.classList.add('is-open');
    if (overlay) overlay.classList.add('is-visible');
    btn.setAttribute('aria-expanded', 'true');
  }
  function close() {
    sidebar.classList.remove('is-open');
    if (overlay) overlay.classList.remove('is-visible');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => sidebar.classList.contains('is-open') ? close() : open());
  if (overlay) overlay.addEventListener('click', close);

  // Edge swipe: open from left edge, close by swiping left on sidebar (mobile only)
  const EDGE_ZONE = 22;          // pixels from left edge that can start the swipe
  const SWIPE_THRESHOLD = 50;    // horizontal distance needed
  const isMobile = () => window.matchMedia('(max-width: 720px)').matches;

  let startX = 0, startY = 0, tracking = false, fromEdge = false, fromSidebar = false;

  document.addEventListener('touchstart', e => {
    if (!isMobile()) return;
    // モーダル表示中はエッジスワイプを無効化（暴発防止）
    if (document.querySelector('.overlay.is-open')) { tracking = false; return; }
    // グラフの上では無効化。このリスナーは document に張ってあるので、
    // canvas の左端 22px からパンしようとするとサイドバーが開いてしまう。
    // （パネルのスワイプ移動 initPanelViewSwipe はビュー要素ごとに張るので、
    //   PANEL_ORDER にグラフを入れなければ何も付かない = そちらは競合しない）
    if (e.target.closest && e.target.closest('#js-graph-view')) { tracking = false; return; }
    const t = e.touches[0];
    const sidebarOpen = sidebar.classList.contains('is-open');
    fromEdge = !sidebarOpen && t.clientX <= EDGE_ZONE;
    fromSidebar = sidebarOpen && sidebar.contains(e.target);
    if (!fromEdge && !fromSidebar) { tracking = false; return; }
    startX = t.clientX;
    startY = t.clientY;
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
    tracking = false;
    if (fromEdge && dx > 0) open();
    else if (fromSidebar && dx < 0) close();
  }, { passive: true });

  document.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

// ── iOS Safari ピンチ/ダブルタップ拡大の完全抑止 ────────────────────────
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => {
  document.addEventListener(ev, e => e.preventDefault(), { passive: false });
});
let _lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - _lastTouchEnd <= 300) e.preventDefault();
  _lastTouchEnd = now;
}, { passive: false });

// ── Sidebar section toggle (Obsidian: .tree-item / .collapse-icon) ───────────
// Obsidian marks the collapsed state with .is-collapsed on the collapse-icon and
// rotates the chevron -90°; there is no .is-open in its vocabulary.
document.querySelectorAll('.sidebar-section-toggle').forEach(btn => {
  const toggle = () => {
    const body = btn.nextElementSibling;
    const chevron = btn.querySelector('.collapse-icon');
    if (!body) return;
    const isCollapsed = body.classList.toggle('is-collapsed');
    btn.closest('.tree-item')?.classList.toggle('is-collapsed', isCollapsed);
    chevron?.classList.toggle('is-collapsed', isCollapsed);
  };
  btn.addEventListener('click', toggle);
  // .tree-item-self is a div, not a button — restore keyboard activation.
  btn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
});

// ════════════════════════════════════════════════════════════
//  DAY VIEW
// ════════════════════════════════════════════════════════════

let dvDate = new Date();    // the date shown in day view

const HOUR_H = 64;          // px per hour slot
const DAY_START = 0;        // 0:00
const DAY_END   = 24;       // 24:00

// ── View tab switching ────────────────────────────────────

// 6つのビューはそれぞれ1つのリーフ内要素。tab / mobile-toolbar の data-view と
// この表のキーが唯一の対応表になる（以前は id 指定のリスナーと [data-view] の
// ループが二重管理だった）。
const VIEW_ELS = {
  month:  'js-month-view',
  week:   'js-week-view',
  day:    'js-day-view',
  budget: 'js-budget-view',
  goal:   'js-goal-view',
  task:   'js-task-view',
  graph:  'js-graph-view',
};

// opts.date: 日ビューを「その日」で開く。省略時は従来どおり curDate。
function switchView(view, opts) {
  if (!VIEW_ELS[view]) return;
  // グラフから離れるならフレームループを止める（停止経路 3）。
  // currentView を書き換える前に見る必要がある。
  if (currentView === 'graph' && view !== 'graph') _graphStopLoop();
  currentView = view;
  for (const [k, id] of Object.entries(VIEW_ELS)) {
    const el = document.getElementById(id);
    if (el) el.style.display = k === view ? '' : 'none';
  }
  document.querySelectorAll('.workspace-tab-header[data-view]').forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.mbb-btn[data-view]').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  updateStatusBar();
  // 開いたビューをその場で描く（非表示中は renderAll がゲートするため）。
  if (view === 'month') renderMain();
  if (view === 'day') {
    // 呼び出し側が日付を指定したときはそれを開く。無条件に curDate で上書き
    // していたので、週ビューの日付ヘッダを押しても常に今日が開いていた（実測）。
    // 呼ぶ前に dvDate へ代入しても switchView がここで捨てるため、渡す形にする。
    dvDate = opts && opts.date ? new Date(opts.date) : new Date(curDate);
    renderDayView();
  }
  if (view === 'week') {
    wvDate = new Date(curDate);
    renderWeekView();
  }
  if (view === 'budget') {
    // 家計簿の Supabase 取得はタブを開いたときだけ。以前は .bp-tab の click が
    // 唯一の呼び出し口で、タブ化で消える経路だった。
    if (_budgetState) _syncBudgetMonth().then(renderBudgetPanel);
  }
  if (view === 'task')  { if (_taskState) renderTaskPanel(); }
  if (view === 'goal')  { renderGoalList(); }
  // グラフは display:none の間 getBoundingClientRect が 0x0 を返すので、
  // 表示に切り替わったこの時点でしかキャンバスの寸法を確定できない。
  if (view === 'graph') { renderGraphView(); }
}

// タブとモバイルツールバーは同じ data-view を持つ。id 個別指定のリスナーは
// 廃止（HTML から id を消した瞬間に ?. 無しで TypeError になっていた）。
document.querySelectorAll('.workspace-tab-header[data-view], .mbb-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ── タイマー（カウントダウン / ポモドーロ）─────────────────────────────────
(function initTimer(){
  const overlay = document.getElementById('js-timer-overlay');
  if (!overlay) return;
  const $ = id => document.getElementById(id);
  const dispEl = $('js-timer-display');
  const phaseEl = $('js-timer-phase');
  const startBtn = $('js-timer-startpause');
  const cdSetup = $('js-timer-cd-setup');
  const pomoSetup = $('js-timer-pomo-setup');

  let mode = 'countdown';        // 'countdown' | 'pomodoro'
  let running = false;
  let remaining = 600;           // 残り秒
  let endAt = 0;                 // 終了予定時刻(ms)。ドリフトしないよう実時刻基準。
  let ticker = null;
  let pomoPhase = 'work';        // 'work' | 'break'
  let pomoCount = 0;             // 完了した作業セッション数
  let audioCtx = null;

  function fmt(sec){
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    const mm = String(m).padStart(2,'0'), ss = String(s).padStart(2,'0');
    return h>0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function cdSeconds(){
    const m = Math.max(0, parseInt($('js-timer-cd-min').value,10)||0);
    const s = Math.min(59, Math.max(0, parseInt($('js-timer-cd-sec').value,10)||0));
    return m*60+s;
  }
  function pomoWorkSec(){ return Math.max(1, parseInt($('js-timer-pomo-work').value,10)||25)*60; }
  function pomoBreakSec(){ return Math.max(1, parseInt($('js-timer-pomo-break').value,10)||5)*60; }

  function render(){
    dispEl.textContent = fmt(remaining);
    startBtn.textContent = running ? '一時停止' : '開始';
    if (mode === 'pomodoro') {
      phaseEl.textContent = (pomoPhase === 'work' ? '作業中' : '休憩中') + (pomoCount ? `（${pomoCount}）` : '');
    } else {
      phaseEl.textContent = '';
    }
  }
  function ensureAudio(){
    try { if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)(); } catch(e){}
  }
  function beep(){
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      let t = audioCtx.currentTime;
      for (let i=0;i<3;i++){
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type='sine'; o.frequency.value = 880;
        o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t+0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t+0.4);
        o.start(t); o.stop(t+0.42);
        t += 0.55;
      }
    } catch(e){}
  }
  function notify(title, body){
    try { if (typeof _showNotif === 'function') _showNotif(title, body, 'karenda-timer'); } catch(e){}
  }

  function stopTicker(){ if (ticker){ clearInterval(ticker); ticker=null; } }
  function tick(){
    remaining = Math.max(0, (endAt - Date.now())/1000);
    if (remaining <= 0) { onFinish(); return; }
    render();
  }
  function startCountingTo(sec){
    remaining = sec;
    endAt = Date.now() + sec*1000;
    running = true;
    stopTicker();
    ticker = setInterval(tick, 250);
    render();
  }

  function onFinish(){
    stopTicker();
    running = false;
    remaining = 0;
    beep();
    if (mode === 'countdown') {
      notify('⏰ タイマー終了', '設定した時間になりました');
      render();
    } else {
      // ポモドーロ：作業↔休憩を自動で切替えて継続
      if (pomoPhase === 'work') {
        pomoCount += 1;
        notify('⏰ 作業終了', `休憩 ${Math.round(pomoBreakSec()/60)} 分です`);
        pomoPhase = 'break';
        startCountingTo(pomoBreakSec());
      } else {
        notify('⏰ 休憩終了', `作業 ${Math.round(pomoWorkSec()/60)} 分を始めましょう`);
        pomoPhase = 'work';
        startCountingTo(pomoWorkSec());
      }
    }
  }

  function resetToSetup(){
    stopTicker();
    running = false;
    if (mode === 'countdown') { remaining = cdSeconds(); }
    else { pomoPhase='work'; pomoCount=0; remaining = pomoWorkSec(); }
    render();
  }

  function setMode(m){
    mode = m;
    document.querySelectorAll('.timer-tab').forEach(t=>t.classList.toggle('is-active', t.dataset.mode===m));
    cdSetup.style.display = m==='countdown' ? '' : 'none';
    pomoSetup.style.display = m==='pomodoro' ? '' : 'none';
    resetToSetup();
  }

  // 操作
  startBtn.addEventListener('click', ()=>{
    ensureAudio();
    if (typeof requestNotificationPermission === 'function') requestNotificationPermission();
    if (running) { stopTicker(); running=false; render(); return; }   // 一時停止
    if (remaining <= 0) resetToSetup();
    if (mode === 'countdown') { if (remaining<=0) remaining = cdSeconds(); }
    if (remaining <= 0) return;   // 0 では開始しない
    startCountingTo(remaining);
  });
  $('js-timer-reset').addEventListener('click', resetToSetup);
  document.querySelectorAll('.timer-tab').forEach(t=> t.addEventListener('click', ()=> setMode(t.dataset.mode)));
  document.querySelectorAll('#js-timer-cd-setup .timer-presets button').forEach(b=>{
    b.addEventListener('click', ()=>{
      $('js-timer-cd-min').value = b.dataset.min;
      $('js-timer-cd-sec').value = 0;
      if (!running) resetToSetup();
    });
  });
  // 設定値を変えたら（停止中のみ）表示へ反映
  ['js-timer-cd-min','js-timer-cd-sec','js-timer-pomo-work','js-timer-pomo-break'].forEach(id=>{
    $(id)?.addEventListener('input', ()=>{ if (!running) resetToSetup(); });
  });

  function openTimer(){ resetToSetup_ifNeeded(); openOverlay('js-timer-overlay'); render(); }
  function resetToSetup_ifNeeded(){ if (!running && remaining<=0) resetToSetup(); }
  $('js-mbb-timer')?.addEventListener('click', openTimer);
  $('js-timer-close')?.addEventListener('click', ()=> closeOverlay('js-timer-overlay'));  // 閉じてもタイマーは継続
  overlay.addEventListener('click', e=>{ if (e.target===overlay) closeOverlay('js-timer-overlay'); });

  resetToSetup();   // 初期表示（10:00）
})();

// ── サイドバー BGM（YouTube 埋め込み）─────────────────────────────────────
(function initBgm(){
  const btn = document.getElementById('js-bgm-toggle');
  const holder = document.getElementById('js-bgm-player');
  if (!btn || !holder) return;
  const VID = 'PB8ZrGinWi0';
  let playing = false;
  // ボタンは <svg>＋<span>。textContent 代入はアイコンを消すので個別に差し替える。
  const setBtn = (icon, label) => {
    btn.querySelector('.svg-icon use')?.setAttribute('href', `#lucide-${icon}`);
    const lbl = document.getElementById('js-bgm-label');
    if (lbl) lbl.textContent = label;
  };
  btn.addEventListener('click', ()=>{
    if (!playing){
      // クリック（ユーザー操作）を起点に iframe を生成して自動再生・ループ
      holder.hidden = false;
      holder.innerHTML =
        '<iframe src="https://www.youtube.com/embed/'+VID+'?autoplay=1&loop=1&playlist='+VID+'" '
        + 'title="BGM" frameborder="0" '
        + 'allow="autoplay; encrypted-media" allowfullscreen></iframe>';
      setBtn('pause', 'BGMを停止');
      playing = true;
    } else {
      // iframe を破棄して停止
      holder.innerHTML = '';
      holder.hidden = true;
      setBtn('music', 'BGMを再生');
      playing = false;
    }
  });
})();
document.getElementById('js-fab-add')?.addEventListener('click', () => {
  // 月/週ビューでは今日を、日ビューでは表示中の日を対象に
  const target = (currentView === 'day' && dvDate) ? dvDate : new Date();
  openDayModal(target.getFullYear(), target.getMonth(), target.getDate());
});
document.getElementById('js-topbar-title')?.addEventListener('click', () => {
  document.getElementById('js-today')?.click();
});

// ── Day view navigation ───────────────────────────────────

document.getElementById('js-dv-prev').addEventListener('click', () => {
  dvDate.setDate(dvDate.getDate() - 1); renderDayView();
});
document.getElementById('js-dv-next').addEventListener('click', () => {
  dvDate.setDate(dvDate.getDate() + 1); renderDayView();
});
document.getElementById('js-dv-today').addEventListener('click', () => {
  dvDate = new Date(); renderDayView();
});
document.getElementById('js-dv-add').addEventListener('click', () => {
  // open the existing day modal for the currently viewed day
  openDayModal(dvDate.getFullYear(), dvDate.getMonth(), dvDate.getDate());
});

// ── Swipe navigation (day view) ───────────────────────────────────────────────
(function() {
  const el = document.getElementById('js-day-view');
  const EDGE_ZONE = 22; // left-edge zone reserved for sidebar swipe
  let startX = 0, startY = 0, tracking = false, swiped = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = startX > EDGE_ZONE; // skip if starting from the sidebar edge zone
    swiped = false;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!tracking || swiped) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      tracking = false;
      e.preventDefault();
      if (dx < 0) {
        dvDate.setDate(dvDate.getDate() + 1);
      } else {
        dvDate.setDate(dvDate.getDate() - 1);
      }
      renderDayView();
    }
  }, { passive: false });
  el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

// ── Helpers ───────────────────────────────────────────────

// I8: "9" (no minutes) used to give h*60 + undefined = NaN, which is neither
// falsy-at-the-guard nor null, so callers treated it as a real time and laid the
// event out at top:NaNpx — it simply vanished. Validate the shape instead of
// trusting split(). Same regex as lib/md-daily.js parseTime, deliberately: the
// import path and the render path must agree on what a time is.
function timeStrToMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function minToY(min) {
  return ((min - DAY_START * 60) / 60) * HOUR_H;
}

function minToTimeStr(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ── Render day view ───────────────────────────────────────

function renderDayView() {
  const y = dvDate.getFullYear(), m = dvDate.getMonth(), d = dvDate.getDate();
  const dow = dvDate.getDay();
  const today = new Date();
  const isToday = y === today.getFullYear() && m === today.getMonth() && d === today.getDate();
  const key = dateKey(y, m, d);
  const DAYS = ['日','月','火','水','木','金','土'];

  // Header date
  const dateEl = document.getElementById('js-dv-date');
  const _dvHoliday = getHolidayName(key);
  dateEl.innerHTML = `
    <span class="dv-date-num ${isToday ? 'is-today' : ''} ${dow===0?'is-sun':dow===6?'is-sat':''}">${d}</span>
    <span class="dv-date-label">${MONTHS_INIT[m]} ${y} &nbsp;${DAYS_EN[dow]}</span>
    ${_dvHoliday ? `<span class="dv-holiday-badge">${escHtml(_dvHoliday)}</span>` : ''}`;

  // Time column
  const timeCol = document.getElementById('js-dv-time-col');
  timeCol.innerHTML = '';
  for (let h = DAY_START; h <= DAY_END; h++) {
    const el = document.createElement('div');
    el.className = 'dv-hour-label';
    el.style.top = `${(h - DAY_START) * HOUR_H}px`;
    el.textContent = h < 24 ? `${String(h).padStart(2,'0')}:00` : '';
    timeCol.appendChild(el);
  }

  // Events column
  const evCol = document.getElementById('js-dv-events-col');
  evCol.innerHTML = '';
  evCol.style.height = `${(DAY_END - DAY_START) * HOUR_H}px`;

  // Hour lines
  for (let h = DAY_START; h <= DAY_END; h++) {
    const line = document.createElement('div');
    line.className = 'dv-hour-line' + (h === 0 ? ' is-first' : '');
    line.style.top = `${(h - DAY_START) * HOUR_H}px`;
    evCol.appendChild(line);
  }

  // Half-hour lines
  for (let h = DAY_START; h < DAY_END; h++) {
    const line = document.createElement('div');
    line.className = 'dv-half-line';
    line.style.top = `${(h - DAY_START) * HOUR_H + HOUR_H / 2}px`;
    evCol.appendChild(line);
  }

  // Events
  const dayEvs = sortEvs(events[key] || []);
  const allDayEvs = [];
  const timedEvs  = [];

  dayEvs.forEach(ev => {
    const startMin = isShift(ev.catId)
      ? timeStrToMin(ev.shiftStart)
      : timeStrToMin(ev.time);
    if (startMin === null) {
      allDayEvs.push(ev);
    } else {
      timedEvs.push({ ev, startMin });
    }
  });

  // All-day events (no time)
  const allDayBar = document.getElementById('js-dv-allday') ||
    (() => { const el = document.createElement('div'); el.id='js-dv-allday'; return el; })();
  allDayBar.className = 'dv-allday-bar';
  allDayBar.innerHTML = '';
  if (allDayEvs.length) {
    allDayEvs.forEach(ev => {
      const cat = getCat(ev.catId) || { color: '#888', name: '?' };
      const chip = document.createElement('div');
      chip.className = 'dv-allday-chip';
      chip.style.background = cat.color;
      chip.textContent = ev.title || cat.name;
      chip.addEventListener('click', () => openEditModal(ev, formatYMD(dvDate)));
      allDayBar.appendChild(chip);
    });
    const body = document.querySelector('.day-view-body');
    body.insertAdjacentElement('beforebegin', allDayBar);
  } else {
    allDayBar.remove();
  }

  // Layout timed events (simple overlap detection)
  // Group overlapping events into columns
  const placed = timedEvs.map(item => {
    const cat = getCat(item.ev.catId) || { color: '#888', name: '?' };
    const endMin = isShift(item.ev.catId)
      ? timeStrToMin(item.ev.shiftEnd)
      : (timeStrToMin(item.ev.timeEnd) ?? item.startMin + 60);
    return { ...item, endMin, cat, col: 0, totalCols: 1 };
  });

  // Assign columns for overlapping events
  for (let i = 0; i < placed.length; i++) {
    const cols = []; // which cols are occupied by events overlapping with i
    for (let j = 0; j < i; j++) {
      if (placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) {
        cols.push(placed[j].col);
      }
    }
    let c = 0;
    while (cols.includes(c)) c++;
    placed[i].col = c;
  }
  // Count total cols per overlap group
  for (let i = 0; i < placed.length; i++) {
    let max = placed[i].col;
    for (let j = 0; j < placed.length; j++) {
      if (j !== i && placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) {
        max = Math.max(max, placed[j].col);
      }
    }
    placed[i].totalCols = max + 1;
  }

  placed.forEach(({ ev, startMin, endMin, cat, col, totalCols }) => {
    const durationMin = Math.max(endMin - startMin, 30); // min 30min height
    const top    = minToY(startMin);
    const height = (durationMin / 60) * HOUR_H;
    const width  = `calc((100% - 4px) / ${totalCols} - 3px)`;
    const left   = `calc((100% - 4px) / ${totalCols} * ${col} + ${col > 0 ? 3 : 0}px)`;

    const block = document.createElement('div');
    block.className = 'dv-event-block';
    block.style.cssText = `
      top:${top}px; height:${Math.max(height,22)}px;
      width:${width}; left:${left};
      background:${cat.color};`;

    const timeStr = isShift(ev.catId)
      ? `${ev.shiftStart} – ${ev.shiftEnd}`
      : (ev.timeEnd ? `${ev.time} – ${ev.timeEnd}` : minToTimeStr(startMin));

    const { pay, workMinutes } = isShift(ev.catId) ? calcShift(ev) : { pay:0, workMinutes:0 };
    const payLabel = isShift(ev.catId) && pay > 0
      ? `<span class="dv-block-pay">${fmtYen(pay)}</span>`
      : '';
    const titleText = isShift(ev.catId) ? cat.name : (ev.title || cat.name);

    block.innerHTML = `
      <span class="dv-block-time">${escHtml(timeStr)}</span>
      <span class="dv-block-title">${escHtml(titleText)}</span>
      ${payLabel}`;

    block.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev, formatYMD(dvDate)); });
    evCol.appendChild(block);
  });

  // Current time line
  const nowLine = document.getElementById('js-dv-now-line');
  if (isToday) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    nowLine.style.top = `${minToY(nowMin)}px`;
    nowLine.style.display = '';
  } else {
    nowLine.style.display = 'none';
  }

  // Scroll to 7:00 or first event on load
  setTimeout(() => {
    const body = document.querySelector('.day-view-body');
    if (!body) return;
    const firstMin = timedEvs[0]?.startMin ?? 7 * 60;
    const scrollTo = Math.max(0, minToY(firstMin) - 40);
    body.scrollTop = scrollTo;
  }, 50);
}

// Re-render day view is already handled inside renderAll() above.


// ════════════════════════════════════════════════════════════
//  WEEK VIEW
// ════════════════════════════════════════════════════════════

let wvDate = new Date();

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay()); // go to Sunday
  d.setHours(0, 0, 0, 0);
  return d;
}

function renderWeekView() {
  const weekStart = getWeekStart(wvDate);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Date range label
  const wEnd = new Date(weekStart); wEnd.setDate(wEnd.getDate() + 6);
  const rangeEl = document.getElementById('js-wv-range');
  if (weekStart.getMonth() === wEnd.getMonth()) {
    rangeEl.textContent = `${MONTHS_INIT[weekStart.getMonth()]} ${weekStart.getDate()} – ${wEnd.getDate()}, ${weekStart.getFullYear()}`;
  } else {
    rangeEl.textContent = `${MONTHS_INIT[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS_INIT[wEnd.getMonth()]} ${wEnd.getDate()}, ${wEnd.getFullYear()}`;
  }

  // Build 7 date objects (Sun–Sat)
  const days = Array.from({length: 7}, (_, i) => {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d;
  });

  // Ensure holidays are loaded for all years in this week
  [...new Set(days.map(d => d.getFullYear()))].forEach(y => {
    if (!_holidays[y]) fetchHolidays(y).then(() => { if (currentView === 'week') renderWeekView(); });
  });

  // ── Column headers ──────────────────────────────────────
  const headsEl = document.getElementById('js-wv-col-heads');
  headsEl.innerHTML = '';
  const gutter = document.createElement('div'); gutter.className = 'wv-gutter';
  headsEl.appendChild(gutter);

  days.forEach(d => {
    const dow = d.getDay();
    const isToday = d.getTime() === today.getTime();
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const holidayName = getHolidayName(key);
    const head = document.createElement('div');
    head.className = ['wv-col-head', isToday ? 'is-today' : '', dow===0 ? 'is-sun' : '', dow===6 ? 'is-sat' : ''].filter(Boolean).join(' ');
    head.innerHTML =
      `<span class="wv-head-dow">${DAYS_EN[dow]}</span>` +
      `<span class="wv-head-num${isToday ? ' is-today' : ''}">${d.getDate()}</span>` +
      (holidayName ? `<span class="wv-head-holiday">${escHtml(holidayName)}</span>` : '');
    head.addEventListener('click', () => switchView('day', { date: d }));
    headsEl.appendChild(head);
  });

  // ── All-day events row ──────────────────────────────────
  const alldayArea = document.getElementById('js-wv-allday-area');
  const alldayCols = document.getElementById('js-wv-allday-cols');
  alldayCols.innerHTML = '';
  let hasAnyAllday = false;
  days.forEach(d => {
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const allDayEvs = (events[key] || []).filter(ev => {
      const s = isShift(ev.catId) ? timeStrToMin(ev.shiftStart) : timeStrToMin(ev.time);
      return s === null;
    });
    const col = document.createElement('div');
    col.className = 'wv-allday-col';
    allDayEvs.forEach(ev => {
      const cat = getCat(ev.catId) || { color: '#888', name: '?' };
      const chip = document.createElement('div');
      chip.className = 'wv-allday-chip';
      chip.style.background = cat.color;
      chip.textContent = ev.title || cat.name;
      chip.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev, key); });
      col.appendChild(chip);
      hasAnyAllday = true;
    });
    alldayCols.appendChild(col);
  });
  alldayArea.style.display = hasAnyAllday ? '' : 'none';

  // ── Time column ─────────────────────────────────────────
  const timeCol = document.getElementById('js-wv-time-col');
  timeCol.innerHTML = '';
  for (let h = DAY_START; h <= DAY_END; h++) {
    const el = document.createElement('div');
    el.className = 'dv-hour-label';
    el.style.top = `${(h - DAY_START) * HOUR_H}px`;
    el.textContent = h < 24 ? `${String(h).padStart(2,'0')}:00` : '';
    timeCol.appendChild(el);
  }

  // ── Day columns (timed events) ──────────────────────────
  const daysEl = document.getElementById('js-wv-days');
  daysEl.innerHTML = '';
  daysEl.style.height = `${(DAY_END - DAY_START) * HOUR_H}px`;

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  days.forEach(d => {
    const dow = d.getDay();
    const isToday = d.getTime() === today.getTime();
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
    const dayEvs = sortEvs(events[key] || []);

    const col = document.createElement('div');
    col.className = ['wv-day-col', isToday ? 'is-today' : '', dow===0 ? 'is-sun' : '', dow===6 ? 'is-sat' : ''].filter(Boolean).join(' ');

    // Grid lines
    for (let h = DAY_START; h <= DAY_END; h++) {
      const line = document.createElement('div');
      line.className = 'dv-hour-line' + (h === 0 ? ' is-first' : '');
      line.style.top = `${(h - DAY_START) * HOUR_H}px`;
      col.appendChild(line);
    }
    for (let h = DAY_START; h < DAY_END; h++) {
      const line = document.createElement('div');
      line.className = 'dv-half-line';
      line.style.top = `${(h - DAY_START) * HOUR_H + HOUR_H / 2}px`;
      col.appendChild(line);
    }

    // Timed events with overlap layout
    const timedEvs = [];
    dayEvs.forEach(ev => {
      const startMin = isShift(ev.catId) ? timeStrToMin(ev.shiftStart) : timeStrToMin(ev.time);
      if (startMin !== null) timedEvs.push({ ev, startMin });
    });
    const placed = timedEvs.map(item => {
      const cat = getCat(item.ev.catId) || { color: '#888', name: '?' };
      const endMin = isShift(item.ev.catId)
        ? timeStrToMin(item.ev.shiftEnd)
        : (timeStrToMin(item.ev.timeEnd) ?? item.startMin + 60);
      return { ...item, endMin, cat, col: 0, totalCols: 1 };
    });
    for (let i = 0; i < placed.length; i++) {
      const cols = [];
      for (let j = 0; j < i; j++) {
        if (placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) cols.push(placed[j].col);
      }
      let c = 0; while (cols.includes(c)) c++;
      placed[i].col = c;
    }
    for (let i = 0; i < placed.length; i++) {
      let max = placed[i].col;
      for (let j = 0; j < placed.length; j++) {
        if (j !== i && placed[j].endMin > placed[i].startMin && placed[j].startMin < placed[i].endMin) max = Math.max(max, placed[j].col);
      }
      placed[i].totalCols = max + 1;
    }
    placed.forEach(({ ev, startMin, endMin, cat, col: evCol, totalCols }) => {
      const top    = minToY(startMin);
      const height = (Math.max(endMin - startMin, 30) / 60) * HOUR_H;
      const width  = `calc((100% - 2px) / ${totalCols} - 2px)`;
      const left   = `calc((100% - 2px) / ${totalCols} * ${evCol} + ${evCol > 0 ? 2 : 0}px)`;
      const block  = document.createElement('div');
      block.className = 'dv-event-block';
      block.style.cssText = `top:${top}px;height:${Math.max(height,22)}px;width:${width};left:${left};background:${cat.color};`;
      const timeStr   = isShift(ev.catId) ? `${ev.shiftStart}–${ev.shiftEnd}` : (ev.timeEnd ? `${ev.time}–${ev.timeEnd}` : minToTimeStr(startMin));
      const titleText = isShift(ev.catId) ? cat.name : (ev.title || cat.name);
      const { pay }   = isShift(ev.catId) ? calcShift(ev) : { pay: 0 };
      const payLabel  = isShift(ev.catId) && pay > 0 ? `<span class="dv-block-pay">${fmtYen(pay)}</span>` : '';
      block.innerHTML = `<span class="dv-block-time">${escHtml(timeStr)}</span><span class="dv-block-title">${escHtml(titleText)}</span>${payLabel}`;
      block.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev, key); });
      col.appendChild(block);
    });

    // Now-line for today
    if (isToday) {
      const nl = document.createElement('div');
      nl.className = 'dv-now-line'; nl.style.top = `${minToY(nowMin)}px`;
      col.appendChild(nl);
    }

    // Click to add event
    col.addEventListener('click', () => openDayModal(d.getFullYear(), d.getMonth(), d.getDate()));
    daysEl.appendChild(col);
  });

  // Scroll to 7:00
  setTimeout(() => {
    const scroll = document.getElementById('js-wv-scroll');
    if (scroll) scroll.scrollTop = Math.max(0, minToY(7 * 60) - 40);
  }, 50);
}

// ── Week view navigation ──────────────────────────────────

document.getElementById('js-wv-prev').addEventListener('click', () => {
  wvDate.setDate(wvDate.getDate() - 7); renderWeekView();
});
document.getElementById('js-wv-next').addEventListener('click', () => {
  wvDate.setDate(wvDate.getDate() + 7); renderWeekView();
});
document.getElementById('js-wv-today').addEventListener('click', () => {
  wvDate = new Date(); renderWeekView();
});
document.getElementById('js-wv-add').addEventListener('click', () => {
  openDayModal(wvDate.getFullYear(), wvDate.getMonth(), wvDate.getDate());
});

// ── Swipe navigation (week view) ──────────────────────────────────────────────
(function() {
  const el = document.getElementById('js-week-view');
  let startX = 0, startY = 0, tracking = false, swiped = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
    swiped = false;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (!tracking || swiped) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      tracking = false;
      e.preventDefault();
      if (dx < 0) {
        wvDate.setDate(wvDate.getDate() + 7);
      } else {
        wvDate.setDate(wvDate.getDate() - 7);
      }
      renderWeekView();
    }
  }, { passive: false });
  el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

// ── Swipe navigation (家計簿 / 目標 / タスク) ─────────────────────────────────
// 右スプリット時代にあった左右スワイプでのタブ移動を、タブ構成のまま取り戻す。
// 月/週/日の左右スワイプは「前後の期間へ」で、ビュー要素にスコープされている
// （#js-month-view など）。こちらも同じく3つのパネルビューにだけ付けるので、
// 同じ指の動きでも当たる相手が違い、競合しない。
// 上下の3段階スワイプ（peek/mid/expanded）は復活させない — 下シートそのものが
// 無くなったので掴む対象が存在しない。
(function initPanelViewSwipe() {
  const PANEL_ORDER = ['budget', 'goal', 'task'];
  const EDGE_ZONE = 22;   // 左端はサイドバーのエッジスワイプに譲る
  PANEL_ORDER.forEach(view => {
    const el = document.getElementById(VIEW_ELS[view]);
    if (!el) return;
    let startX = 0, startY = 0, tracking = false, swiped = false;
    el.addEventListener('touchstart', e => {
      if (document.querySelector('.overlay.is-open')) { tracking = false; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = startX > EDGE_ZONE;
      swiped = false;
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (!tracking || swiped) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swiped = true;                       // 1ジェスチャ＝1タブ移動
        tracking = false;
        e.preventDefault();
        const idx = PANEL_ORDER.indexOf(view);
        // 左スワイプ（dx<0）= 次のタブ、右スワイプ = 前のタブ。端では循環しない。
        const next = dx < 0 ? idx + 1 : idx - 1;
        if (next < 0 || next >= PANEL_ORDER.length) return;
        switchView(PANEL_ORDER[next]);
      }
    }, { passive: false });
    el.addEventListener('touchend', () => { tracking = false; }, { passive: true });
  });
})();


function _pad2(n){ return String(n).padStart(2,'0'); }

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function formatYMD(d){
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())}`;
}
function formatYM(d){
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}`;
}
function formatMD(d){
  return `${_pad2(d.getMonth()+1)}/${_pad2(d.getDate())}`;
}
function formatYMDSlash(d){
  return `${d.getFullYear()}/${_pad2(d.getMonth()+1)}/${_pad2(d.getDate())}`;
}

function getMonday(date = new Date()){
  const d = new Date(date);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0) ? -6 : (1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}

function getWeekKeyFromDate(date){
  return formatYMD(getMonday(date));
}

// ════════════════════════════════════════════════════════════
//  BOTTOM PANEL TABS
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
//  BOTTOM PANEL SWIPE (mobile)
// ════════════════════════════════════════════════════════════

/* ── Desktop: free-drag vertical resize ── */


// ════════════════════════════════════════════════════════════
//  CLEAN CALENDAR (ごみ収集カレンダー)
// ════════════════════════════════════════════════════════════

const CLEAN_SCHEDULE = {
  // key = JS dayOfWeek (0=Sun … 6=Sat)
  2: [{ type: 'もやすごみ', color: '#e06050' }, { type: '生ごみ', color: '#4caf50' }],
  3: [{ type: 'プラマークごみ', color: '#ff9800' }],
  4: [{ type: 'びん・カン', color: '#42a5f5' }],
  5: [{ type: 'もやすごみ', color: '#e06050' }, { type: '生ごみ', color: '#4caf50' }],
};

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function renderCleanCalendar() {
  const box = document.getElementById('js-clean-cal');
  if (!box) return;
  box.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let shown = 0;

  for (let i = 0; i < 7 && shown < 4; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    const items = CLEAN_SCHEDULE[dow];
    if (!items) continue;

    shown++;
    const row = document.createElement('div');
    row.className = 'clean-day' + (i === 0 ? ' is-today' : '');

    const label = i === 0 ? '今日' : i === 1 ? '明日' : `${d.getMonth() + 1}/${d.getDate()}(${DAY_LABELS[dow]})`;

    let typesHtml = items.map(t =>
      `<span class="clean-type"><span class="clean-type-dot" style="background:${t.color}"></span><span class="clean-type-name">${escHtml(t.type)}</span></span>`
    ).join('');

    row.innerHTML = `<span class="clean-day-label">${label}</span><span class="clean-types">${typesHtml}</span>`;
    box.appendChild(row);
  }

  if (!shown) {
    box.innerHTML = '<div class="clean-none">今週の収集はありません</div>';
  }
}

// ════════════════════════════════════════════════════════════
//  TASK MANAGEMENT
// ════════════════════════════════════════════════════════════

const TASK_STORAGE_KEY = 'tasks_v1';
const GOAL_STORAGE_KEY = 'daily_goal_v1';

let _taskState = null;

// ── Goal Panel (目標) helpers ──
// goals[userId][dateStr] = [{id, text, done}, ...]

function _loadGoal(userId) {
  try {
    const root = JSON.parse(localStorage.getItem(GOAL_STORAGE_KEY) || '{}');
    return root[userId] || {};
  } catch(_) { return {}; }
}
function _persistGoal(userId, goals) {
  try {
    const root = JSON.parse(localStorage.getItem(GOAL_STORAGE_KEY) || '{}');
    root[userId] = goals;
    localStorage.setItem(GOAL_STORAGE_KEY, JSON.stringify(root));
  } catch(_) {}
}

// 指定日に全ての目標（テキストあり）が達成済みか判定
function _isGoalAchieved(userId, dateStr) {
  try {
    const root = JSON.parse(localStorage.getItem(GOAL_STORAGE_KEY) || '{}');
    const ug = root[userId] || {};
    const tmpl = ug['_template'];
    const ds = ug[dateStr];
    if (!tmpl || !ds) return false;
    const hasAny = tmpl.main.text || tmpl.subs.some(s => s.text);
    if (!hasAny) return false;
    if (tmpl.main.text && !ds.main?.done) return false;
    for (const s of tmpl.subs) {
      if (s.text) {
        const st = ds.subs?.find(x => x.id === s.id);
        if (!st?.done) return false;
      }
    }
    return true;
  } catch(_) { return false; }
}

function _dateAddDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function _formatGoalDate(dateStr) {
  const today    = _todayStr();
  const tomorrow = _dateAddDays(today, 1);
  const [, m, d] = dateStr.split('-');
  const base = `${MONTHS_INIT[parseInt(m)-1]} ${parseInt(d)}`;
  if (dateStr === today)    return `Today (${base})`;
  if (dateStr === tomorrow) return `Tomorrow (${base})`;
  return base;
}

// 目標タブに切り替えたとき描き直せるよう、initGoalPanel 内のクロージャ
// renderGoalList への参照だけをモジュールスコープに引き上げる。task/budget が
// _taskState/_budgetState を持つのに goal だけ持たない非対称は、データ構造を
// 変えずに済ませるため今回は解消しない。パネル未初期化のときは何もしない。
let _renderGoalList = null;
function renderGoalList() { if (_renderGoalList) _renderGoalList(); }

function initGoalPanel(userId) {
  const listEl   = document.getElementById('js-goal-list');
  const display  = document.getElementById('js-goal-date-display');
  const formEl   = document.getElementById('js-goal-add-form');
  const inputEl  = document.getElementById('js-goal-input');
  const prevBtn  = document.getElementById('js-goal-prev');
  const nextBtn  = document.getElementById('js-goal-next');
  const todayBtn = document.getElementById('js-goal-today');
  if (!listEl || !display) return;

  // 下の renderGoalList（関数宣言なので巻き上げ済み）を外から呼べるようにする。
  _renderGoalList = renderGoalList;

  // デフォルトは明日（前日に翌日の目標を設定できる）
  let currentDate = _dateAddDays(_todayStr(), 1);
  const allGoals = _loadGoal(userId);

  // ── 旧形式（日付ごとにテキスト+done）→ 新形式（テンプレート分離）への移行 ──
  if (!allGoals['_template']) {
    const dateKeys = Object.keys(allGoals)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort().reverse();
    let src = null;
    for (const k of dateKeys) {
      const e = allGoals[k];
      if (e && !Array.isArray(e) && (e.main?.text || e.subs?.some(s => s.text))) {
        src = e; break;
      }
    }
    if (src) {
      allGoals['_template'] = {
        main: { text: src.main?.text || '' },
        subs: (src.subs || []).map(s => ({ id: s.id, text: s.text || '', required: !!s.required }))
      };
      for (const k of dateKeys) {
        const e = allGoals[k];
        if (e && !Array.isArray(e)) {
          allGoals[k] = {
            main: { done: !!e.main?.done },
            subs: (e.subs || []).map(s => ({ id: s.id, done: !!s.done }))
          };
        }
      }
    } else {
      allGoals['_template'] = {
        main: { text: '' },
        subs: [
          { id: 'sub-0', text: '', required: true },
          { id: 'sub-1', text: '', required: true },
        ]
      };
    }
    _persistGoal(userId, allGoals);
  }

  // テンプレートの required サブが2つ未満なら補完
  const tmpl = allGoals['_template'];
  if (!tmpl.subs) tmpl.subs = [];
  const _reqCount = tmpl.subs.filter(s => s.required).length;
  for (let i = _reqCount; i < 2; i++) {
    tmpl.subs.splice(i, 0, { id: `sub-${i}`, text: '', required: true });
  }

  // テンプレートテキスト + 日付ごとの done 状態をマージして返す
  function getData() {
    if (!allGoals[currentDate] || Array.isArray(allGoals[currentDate])) {
      allGoals[currentDate] = {
        main: { done: false },
        subs: tmpl.subs.map(s => ({ id: s.id, done: false }))
      };
    }
    const ds = allGoals[currentDate];
    if (!ds.subs) ds.subs = [];
    for (const ts of tmpl.subs) {
      if (!ds.subs.find(s => s.id === ts.id)) {
        ds.subs.push({ id: ts.id, done: false });
      }
    }
    return {
      main: { text: tmpl.main.text, done: !!ds.main?.done },
      subs: tmpl.subs.map(s => {
        const st = ds.subs.find(x => x.id === s.id);
        return { id: s.id, text: s.text, done: !!st?.done, required: s.required };
      })
    };
  }

  const SVG_CHECK = '<svg viewBox="0 0 12 9" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4L4.5 7.5L11 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function goalItemHtml(id, type, done, text, placeholder, deletable) {
    return `
      <div class="goal-item goal-item-${type} ${done ? 'is-done' : ''}" data-goal-id="${id}" data-goal-type="${type}">
        <button class="goal-check" type="button" aria-label="達成切替">${done ? SVG_CHECK : ''}</button>
        <span class="goal-badge is-${type}">${type === 'main' ? '最重要' : type === 'sub' ? 'サブ' : '+α'}</span>
        <span class="goal-item-text ${!text ? 'is-placeholder' : ''}">${text ? escapeHtml(text) : placeholder}</span>
        ${deletable ? '<button class="goal-del" type="button" aria-label="削除"><svg class="svg-icon"><use href="#lucide-x"/></svg></button>' : ''}
      </div>`;
  }

  function renderGoalList() {
    display.textContent = _formatGoalDate(currentDate);
    const { main, subs } = getData();
    const reqSubs   = subs.filter(s => s.required);
    const extraSubs = subs.filter(s => !s.required);

    listEl.innerHTML =
      goalItemHtml('main', 'main', main.done, main.text, '最重要の目標…', false) +
      reqSubs.map((s, i) => goalItemHtml(s.id, 'sub', s.done, s.text, `サブ目標 ${i + 1}…`, false)).join('') +
      extraSubs.map(s    => goalItemHtml(s.id, 'extra', s.done, s.text, '追加目標…', true)).join('');
  }

  // イベント委譲
  listEl.addEventListener('click', e => {
    const row = e.target.closest('[data-goal-id]');
    if (!row) return;
    const id   = row.dataset.goalId;
    const type = row.dataset.goalType;

    // 削除（+α のみ）— テンプレートと全日付ステートから削除
    if (e.target.closest('.goal-del')) {
      tmpl.subs = tmpl.subs.filter(s => s.id !== id);
      for (const k of Object.keys(allGoals)) {
        if (k !== '_template' && allGoals[k]?.subs) {
          allGoals[k].subs = allGoals[k].subs.filter(s => s.id !== id);
        }
      }
      _persistGoal(userId, allGoals); renderGoalList(); return;
    }

    // チェック切替 — 日付ステートのみ更新
    if (e.target.closest('.goal-check')) {
      if (!allGoals[currentDate] || Array.isArray(allGoals[currentDate])) {
        allGoals[currentDate] = { main: { done: false }, subs: tmpl.subs.map(s => ({ id: s.id, done: false })) };
      }
      const ds = allGoals[currentDate];
      if (!ds.subs) ds.subs = [];
      if (type === 'main') {
        if (!ds.main) ds.main = {};
        ds.main.done = !ds.main.done;
      } else {
        let subState = ds.subs.find(s => s.id === id);
        if (!subState) { subState = { id, done: false }; ds.subs.push(subState); }
        subState.done = !subState.done;
      }
      _persistGoal(userId, allGoals);
      renderGoalList();
      renderMini();
      if (typeof currentView !== 'undefined' && currentView === 'month') renderMain();
      return;
    }

    // テキストをクリックしてインライン編集 — テンプレートを更新
    if (e.target.closest('.goal-item-text')) {
      const merged = getData();
      const textEl = e.target.closest('.goal-item-text');
      const current = type === 'main' ? merged.main.text : (merged.subs.find(s => s.id === id)?.text || '');
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'goal-inline-input';
      inp.value = current;
      inp.maxLength = 100;
      textEl.replaceWith(inp);
      inp.focus(); inp.select();
      const commit = () => {
        const val = inp.value.trim();
        if (type === 'main') { tmpl.main.text = val; }
        else { const item = tmpl.subs.find(s => s.id === id); if (item) item.text = val; }
        _persistGoal(userId, allGoals); renderGoalList();
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter')  { ev.preventDefault(); inp.blur(); }
        if (ev.key === 'Escape') { renderGoalList(); }
      });
    }
  });

  // +α 目標を追加 — テンプレートに追加
  formEl.addEventListener('submit', e => {
    e.preventDefault();
    const text = (inputEl.value || '').trim();
    if (!text) return;
    tmpl.subs.push({ id: `g_${Date.now()}`, text, required: false });
    inputEl.value = '';
    _persistGoal(userId, allGoals); renderGoalList();
  });

  // チェックをリセット（テキストは保持）
  document.getElementById('js-goal-reset')?.addEventListener('click', () => {
    if (!allGoals[currentDate]) return;
    const ds = allGoals[currentDate];
    if (ds.main) ds.main.done = false;
    (ds.subs || []).forEach(s => { s.done = false; });
    _persistGoal(userId, allGoals);
    renderGoalList();
    renderMini();
    if (typeof currentView !== 'undefined' && currentView === 'month') renderMain();
  });

  prevBtn.addEventListener('click',  () => { currentDate = _dateAddDays(currentDate, -1); renderGoalList(); });
  nextBtn.addEventListener('click',  () => { currentDate = _dateAddDays(currentDate,  1); renderGoalList(); });
  todayBtn.addEventListener('click', () => { currentDate = _todayStr(); renderGoalList(); });

  renderGoalList();
}

function _readTaskRoot() {
  try { return JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || '{}'); }
  catch(_) { return {}; }
}
function _writeTaskRoot(root) {
  localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(root));
}

function loadTasks(userId) {
  const root = _readTaskRoot();
  const list = root[userId] || [];
  return Array.isArray(list) ? list.filter(t => t && typeof t.title === 'string') : [];
}

function saveTasks(userId, tasks) {
  const root = _readTaskRoot();
  root[userId] = tasks;
  _writeTaskRoot(root);
}

// ── Supabase Task CRUD ──

async function loadTasksFromSupabase(userId) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    setSyncStatus('synced');
    return (data || []).map(r => ({
      id: r.task_id, _dbId: r.id,
      title: r.title, done: r.done,
      dueDate: r.due_date || '', priority: r.priority || 'medium',
      createdAt: new Date(r.created_at).getTime()
    }));
  } catch (e) {
    console.error('Task load error:', e);
    setSyncStatus('error');
    return null;
  }
}

async function addTaskToSupabase(task) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('tasks').insert({
      user_id: currentUser.id, task_id: task.id,
      title: task.title, done: task.done,
      due_date: task.dueDate || '', priority: task.priority || 'medium'
    }).select().single();
    if (error) throw error;
    task._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) { console.error('Task add error:', e); setSyncStatus('error'); }
}

async function updateTaskInSupabase(task) {
  if (!currentUser || !task._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('tasks').update({
      done: task.done,
      title: task.title,
      due_date: task.dueDate || '',
      priority: task.priority || 'medium'
    }).eq('id', task._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) { console.error('Task update error:', e); setSyncStatus('error'); }
}

async function deleteTaskFromSupabase(taskId) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('tasks').delete()
      .eq('user_id', currentUser.id).eq('task_id', taskId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) { console.error('Task delete error:', e); setSyncStatus('error'); }
}

// ── projects（作業テーマ）──────────────────────────────────────────────────
// タスクを束ねる軸。名前はそのまま Obsidian のノート名として使う。
// 失敗時に null を返すのは loadTasksFromSupabase と同じ約束（空配列と区別する）。

async function loadProjectsFromSupabase(userId) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    setSyncStatus('synced');
    return (data || []).map(r => ({
      id: r.project_id, _dbId: r.id,
      name: r.name, color: r.color || '#7c6cf5',
      archived: !!r.archived,
      createdAt: new Date(r.created_at).getTime(),
    }));
  } catch (e) {
    // テーブル未作成（42P01）でもアプリ全体は動き続けてほしい。
    console.error('Project load error:', e);
    setSyncStatus('error');
    return null;
  }
}

async function addProjectToSupabase(project) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('projects').insert({
      user_id: currentUser.id, project_id: project.id,
      name: project.name, color: project.color, archived: !!project.archived,
    }).select().single();
    if (error) throw error;
    project._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) { console.error('Project add error:', e); setSyncStatus('error'); }
}

async function updateProjectInSupabase(project) {
  if (!currentUser || !project._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('projects').update({
      name: project.name, color: project.color, archived: !!project.archived,
    }).eq('id', project._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) { console.error('Project update error:', e); setSyncStatus('error'); }
}

// アーカイブ済みは選択肢に出さない。削除は用意しない（設計どおり）。
function activeProjects() {
  return projects.filter(p => !p.archived);
}

function projectById(id) {
  if (!id) return null;
  return projects.find(p => p.id === id) || null;
}

async function initTaskPanel(user) {
  const listEl     = document.getElementById('js-task-list');
  const formEl     = document.getElementById('js-task-add-form');
  const inputEl    = document.getElementById('js-task-input');
  const dateEl     = document.getElementById('js-task-date');
  const priorityEl = document.getElementById('js-task-priority');
  const progressEl = document.getElementById('js-task-progress');

  if (!listEl || !formEl || !inputEl) return;

  const userId = user?.id || 'anon';
  // プロジェクトはタスクより先に用意する（描画時に名前を引くため）。
  if (userId !== 'anon') {
    projects = await loadProjectsFromSupabase(userId) ?? [];
  } else {
    projects = [];
  }
  let tasks;
  if (userId !== 'anon') {
    tasks = await loadTasksFromSupabase(userId) ?? loadTasks(userId);
  } else {
    tasks = loadTasks(userId);
  }

  _taskState = {
    userId, tasks, filter: 'all',
    els: { listEl, formEl, inputEl, dateEl, priorityEl, progressEl }
  };

  renderTaskPanel();
  renderMain(); // タスクの期限をカレンダーに反映
  initGoalPanel(userId);

  // Add task
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!_taskState) return;
    const title = (inputEl.value || '').trim();
    if (!title) return;
    const id = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const dueDate  = dateEl?.value || '';
    const priority = priorityEl?.value || 'medium';
    const task = { id, title, dueDate, priority, done: false, createdAt: Date.now() };
    _taskState.tasks.unshift(task);
    inputEl.value = '';
    if (dateEl) dateEl.value = '';
    if (priorityEl) priorityEl.value = 'medium';
    _persistTasks();
    renderTaskPanel();
    if (dueDate) renderMain(); // 期限ありの場合のみカレンダー再描画
    await addTaskToSupabase(task);
  });

  // Toggle / Delete
  listEl.addEventListener('click', async (e) => {
    if (!_taskState) return;
    const row = e.target.closest?.('[data-task-id]');
    if (!row) return;
    const id = row.getAttribute('data-task-id');
    if (e.target.closest?.('.task-del')) {
      const removed = _taskState.tasks.find(t => t.id === id);
      _taskState.tasks = _taskState.tasks.filter(t => t.id !== id);
      _persistTasks();
      renderTaskPanel();
      if (removed?.dueDate) renderMain();
      await deleteTaskFromSupabase(id);
      return;
    }
    // 編集ボタン → インライン編集フォームを開く
    if (e.target.closest?.('.task-edit-btn')) {
      const t = _taskState.tasks.find(t => t.id === id);
      if (!t) return;
      _openTaskEditForm(row, t);
      return;
    }
    // 保存ボタン
    if (e.target.closest?.('.task-edit-save')) {
      const t = _taskState.tasks.find(t => t.id === id);
      if (!t) return;
      const newTitle = row.querySelector('.task-edit-title')?.value.trim();
      if (!newTitle) { row.querySelector('.task-edit-title')?.focus(); return; }
      const oldDueDate = t.dueDate;
      t.title    = newTitle;
      t.dueDate  = row.querySelector('.task-edit-date')?.value || '';
      t.priority = row.querySelector('.task-edit-priority')?.value || 'medium';
      _persistTasks();
      renderTaskPanel();
      if (oldDueDate || t.dueDate) renderMain();
      await updateTaskInSupabase(t);
      return;
    }
    // キャンセルボタン
    if (e.target.closest?.('.task-edit-cancel')) {
      renderTaskPanel();
      return;
    }
    const t = _taskState.tasks.find(t => t.id === id);
    if (!t) return;
    // 編集中の行はチェック操作を無視
    if (row.classList.contains('is-editing')) return;
    t.done = !t.done;
    _persistTasks();
    renderTaskPanel();
    if (t.dueDate) renderMain(); // 期限ありのタスクのみカレンダー再描画
    await updateTaskInSupabase(t);
  });

  // Filter buttons
  document.querySelectorAll('.task-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_taskState) return;
      _taskState.filter = btn.dataset.filter;
      document.querySelectorAll('.task-filter').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      renderTaskPanel();
    });
  });
}

function _persistTasks() {
  if (!_taskState) return;
  saveTasks(_taskState.userId, _taskState.tasks);
}

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())}`;
}

function renderTaskPanel() {
  if (!_taskState) return;
  const { tasks, filter, els } = _taskState;

  // Sort: undone first (high > medium > low, then by due date), done last
  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pOrder = { high: 0, medium: 1, low: 2 };
    const pa = pOrder[a.priority] ?? 1;
    const pb = pOrder[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.createdAt - a.createdAt;
  });

  const filtered = sorted.filter(t => {
    if (filter === 'active') return !t.done;
    if (filter === 'done')   return t.done;
    return true;
  });

  // Progress
  const done  = tasks.filter(t => t.done).length;
  const total = tasks.length;
  const pText = total === 0 ? '0/0' : `${done}/${total}`;
  els.progressEl.textContent = (total > 0 && done === total) ? `<svg class="svg-icon"><use href="#lucide-party-popper"/></svg> ${pText}` : pText;

  const today = _todayStr();

  if (filtered.length === 0) {
    const emptyMsg = filter === 'done'
      ? '完了したタスクはありません'
      : filter === 'active'
        ? 'すべてのタスクが完了しています！'
        : 'タスクを追加して、期限と優先度で管理できます';
    els.listEl.innerHTML = `<div class="task-empty">${emptyMsg}</div>`;
    return;
  }

  els.listEl.innerHTML = filtered.map(t => {
    const pClass = `is-${t.priority || 'medium'}`;
    const pLabel = t.priority === 'high' ? '高' : t.priority === 'low' ? '低' : '中';

    let dueMeta = '';
    if (t.dueDate) {
      const isPast  = !t.done && t.dueDate < today;
      const isToday = t.dueDate === today;
      const dueClass = isPast ? 'is-past' : isToday ? 'is-today' : '';
      const parts = t.dueDate.split('-');
      const dueLabel = isToday ? '今日' : isPast ? `${parts[1]}/${parts[2]} (期限切れ)` : `${parts[1]}/${parts[2]}`;
      dueMeta = `<span class="task-due ${dueClass}">${dueLabel}</span>`;
    }

    return `
      <div class="task-item ${t.done ? 'done' : ''}" data-task-id="${t.id}">
        <span class="task-priority-dot ${pClass}"></span>
        <div class="task-check"></div>
        <div class="task-body">
          <div class="task-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
          <div class="task-meta">
            ${dueMeta}
            <span class="task-priority-label ${pClass}">${pLabel}</span>
          </div>
        </div>
        <button class="task-edit-btn" type="button" title="編集" aria-label="編集"><svg class="svg-icon"><use href="#lucide-pencil"/></svg></button>
        <button class="task-del" type="button" title="削除" aria-label="削除"><svg class="svg-icon"><use href="#lucide-x"/></svg></button>
      </div>`;
  }).join('');
}

// タスク行をインライン編集フォームに置き換える
function _openTaskEditForm(row, task) {
  row.classList.add('is-editing');
  const pOpts = ['high','medium','low'].map(v =>
    `<option value="${v}" ${(task.priority||'medium')===v?'selected':''}>${v==='high'?'高':v==='low'?'低':'中'}</option>`
  ).join('');
  row.innerHTML =
    `<div class="task-edit-form">` +
    `<input class="task-edit-title" type="text" value="${escapeHtml(task.title)}" placeholder="タスク名" maxlength="100">` +
    `<div class="task-edit-row">` +
    `<input class="task-edit-date" type="date" value="${task.dueDate||''}">` +
    `<select class="task-edit-priority">${pOpts}</select>` +
    `</div>` +
    `<div class="task-edit-actions">` +
    `<button class="task-edit-save" type="button">保存</button>` +
    `<button class="task-edit-cancel" type="button">キャンセル</button>` +
    `</div></div>`;
  const titleInput = row.querySelector('.task-edit-title');
  titleInput?.focus();
  titleInput?.select();
  // Enter キーで保存
  titleInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); row.querySelector('.task-edit-save')?.click(); }
    if (e.key === 'Escape') row.querySelector('.task-edit-cancel')?.click();
  });
}


// ════════════════════════════════════════════════════════════
//  BUDGET (家計簿)
// ════════════════════════════════════════════════════════════

// (BUDGET_STORAGE_KEY removed — data lives in Supabase budget_entries table)

const _BUDGET_EXP_CATS_DEFAULT = [
  { id:'food',       name:'食費',   icon:'🍙', color:'#e67700' },
  { id:'transport',  name:'交通費', icon:'🚃', color:'#1971c2' },
  { id:'housing',    name:'住居費', icon:'🏠', color:'#6741d9' },
  { id:'utility',    name:'光熱費', icon:'💡', color:'#f76707' },
  { id:'telecom',    name:'通信費', icon:'📱', color:'#3b5bdb' },
  { id:'entertain',  name:'娯楽費', icon:'🎮', color:'#c2255c' },
  { id:'medical',    name:'医療費', icon:'🏥', color:'#e03131' },
  { id:'clothing',   name:'衣服費', icon:'👕', color:'#9c36b5' },
  { id:'daily',      name:'日用品', icon:'🧴', color:'#0c8599' },
  { id:'education',  name:'教育費', icon:'📚', color:'#087f5b' },
  { id:'alcohol',    name:'酒',     icon:'🍶', color:'#a61e4d' },
  { id:'other_exp',  name:'その他', icon:'📦', color:'#888' },
];

const _BUDGET_SUBSCRIPTION_CAT = {
  id: 'subscription', name: 'サブスク・月額', icon: '🔁', color: '#7c3aed'
};

const _BUDGET_INC_CATS_DEFAULT = [
  { id:'salary',     name:'給料',   icon:'💰', color:'#2f9e44' },
  { id:'bonus',      name:'賞与',   icon:'🎁', color:'#74b816' },
  { id:'sidejob',    name:'副業',   icon:'💼', color:'#0c8599' },
  { id:'other_inc',  name:'その他', icon:'📥', color:'#888' },
];

function _loadBudgetCats(key, defaults) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : defaults.map(c => ({...c}));
  } catch { return defaults.map(c => ({...c})); }
}

function _saveBudgetCats() {
  localStorage.setItem('kuro_budget_exp_cats', JSON.stringify(budgetExpenseCats));
  localStorage.setItem('kuro_budget_inc_cats', JSON.stringify(budgetIncomeCats));
}

let budgetExpenseCats = _loadBudgetCats('kuro_budget_exp_cats', _BUDGET_EXP_CATS_DEFAULT);
let budgetIncomeCats  = _loadBudgetCats('kuro_budget_inc_cats', _BUDGET_INC_CATS_DEFAULT);

// 月額支払いは通常の支出と区別する専用カテゴリへまとめる。
(function seedSubscriptionCategory() {
  try {
    if (budgetExpenseCats.some(c => c.id === _BUDGET_SUBSCRIPTION_CAT.id)) return;
    const category = { ..._BUDGET_SUBSCRIPTION_CAT };
    const at = budgetExpenseCats.findIndex(c => c.id === 'other_exp');
    if (at >= 0) budgetExpenseCats.splice(at, 0, category);
    else budgetExpenseCats.push(category);
    _saveBudgetCats();
  } catch (_) { /* localStorage が使えない場合はデフォルトを変更しない */ }
})();

// 既存ユーザー（localStorage にカテゴリ保存済み）にも「酒」を一度だけ追加する。
// フラグで一回きりにするので、後からユーザーが削除しても復活しない。
(function seedAlcoholCat() {
  try {
    if (localStorage.getItem('kuro_budget_seed_alcohol')) return;
    if (!budgetExpenseCats.some(c => c.id === 'alcohol')) {
      const alcoholCat = { id:'alcohol', name:'酒', icon:'🍶', color:'#a61e4d' };
      const at = budgetExpenseCats.findIndex(c => c.id === 'other_exp');  // 「その他」の前に挿入
      if (at >= 0) budgetExpenseCats.splice(at, 0, alcoholCat);
      else budgetExpenseCats.push(alcoholCat);
      _saveBudgetCats();
    }
    localStorage.setItem('kuro_budget_seed_alcohol', '1');
  } catch (_) { /* localStorage 不可環境では既定配列に含まれるので無視 */ }
})();

let _budgetState = null;

// ── Supabase budget CRUD ──

async function loadBudgetFromSupabase(userId, monthKey) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db
      .from('budget_entries')
      .select('*')
      .eq('user_id', userId)
      .eq('month_key', monthKey)
      .order('date', { ascending: false });
    if (error) throw error;
    setSyncStatus('synced');
    return (data || []).map(r => ({
      id:        r.entry_id,
      _dbId:     r.id,
      type:      r.type,
      catId:     r.cat_id,
      amount:    r.amount,
      memo:      r.memo || '',
      date:      r.date,
      source:    r.source || null,
      createdAt: new Date(r.created_at).getTime()
    }));
  } catch (e) {
    console.error('Budget load error:', e);
    setSyncStatus('error');
    return [];
  }
}

async function loadBudgetMonthsFromSupabase(userId, monthKeys) {
  if (!db || !userId || userId === 'anon') return [];
  if (!monthKeys || monthKeys.length === 0) return [];
  setSyncStatus('syncing');
  try {
    const { data, error } = await db
      .from('budget_entries')
      .select('*')
      .eq('user_id', userId)
      .in('month_key', monthKeys);
    if (error) throw error;
    setSyncStatus('synced');
    return (data || []).map(r => ({
      id:        r.entry_id,
      _dbId:     r.id,
      type:      r.type,
      catId:     r.cat_id,
      amount:    r.amount,
      memo:      r.memo || '',
      date:      r.date,
      monthKey:  r.month_key,
      createdAt: new Date(r.created_at).getTime()
    }));
  } catch (e) {
    console.error('Budget months load error:', e);
    setSyncStatus('error');
    return [];
  }
}

async function addBudgetToSupabase(entry) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('budget_entries').insert({
      user_id:   currentUser.id,
      month_key: monthKeyFromDate(entry.date) || _budgetMonthKey(),
      entry_id:  entry.id,
      type:      entry.type,
      cat_id:    entry.catId,
      amount:    entry.amount,
      memo:      entry.memo || '',
      date:      entry.date
    }).select().single();
    if (error) throw error;
    entry._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Budget add error:', e);
    setSyncStatus('error');
  }
}

async function updateBudgetToSupabase(entry) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('budget_entries')
      .update({
        type:      entry.type,
        cat_id:    entry.catId,
        amount:    entry.amount,
        memo:      entry.memo || '',
        date:      entry.date,
        month_key: monthKeyFromDate(entry.date) || _budgetMonthKey()
      })
      .eq('user_id', currentUser.id)
      .eq('entry_id', entry.id);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Budget update error:', e);
    setSyncStatus('error');
  }
}

async function deleteBudgetFromSupabase(entryId) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('budget_entries')
      .delete()
      .eq('user_id', currentUser.id)
      .eq('entry_id', entryId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Budget delete error:', e);
    setSyncStatus('error');
  }
}

// ── Monthly recurring budget entries (subscriptions / fixed payments) ──
async function loadRecurringBudgetFromSupabase(userId) {
  if (!db || !userId || userId === 'anon') return [];
  try {
    const { data, error } = await db
      .from('recurring_budget_entries')
      .select('*')
      .eq('user_id', userId)
      .eq('active', true)
      .order('day_of_month', { ascending: true });
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.recurring_id, _dbId: r.id, type: r.type, catId: r.cat_id,
      amount: r.amount, memo: r.memo || '', dayOfMonth: r.day_of_month,
      startDate: r.start_date, endDate: r.end_date || null
    }));
  } catch (e) {
    console.error('Recurring budget load error:', e);
    return [];
  }
}

async function addRecurringBudgetToSupabase(entry) {
  if (!currentUser) return false;
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('recurring_budget_entries').insert({
      user_id: currentUser.id, recurring_id: entry.id, type: entry.type,
      cat_id: entry.catId, amount: entry.amount, memo: entry.memo || '',
      day_of_month: entry.dayOfMonth, start_date: entry.startDate
    }).select().single();
    if (error) throw error;
    entry._dbId = data.id;
    setSyncStatus('synced');
    return true;
  } catch (e) {
    console.error('Recurring budget add error:', e);
    setSyncStatus('error');
    return false;
  }
}

async function deleteRecurringBudgetFromSupabase(recurringId) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('recurring_budget_entries')
      .delete().eq('user_id', currentUser.id).eq('recurring_id', recurringId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Recurring budget delete error:', e);
    setSyncStatus('error');
  }
}

function _recurringEntryForMonth(recurring, monthKey) {
  var monthStart = monthKey + '-01';
  var parts = monthKey.split('-');
  var days = new Date(+parts[0], +parts[1], 0).getDate();
  var date = monthKey + '-' + _pad2(Math.min(recurring.dayOfMonth, days));
  if (recurring.startDate > date || (recurring.endDate && recurring.endDate < monthStart)) return null;
  return {
    id: '_recurring_' + recurring.id + '_' + monthKey,
    recurringId: recurring.id,
    type: recurring.type,
    catId: recurring.catId,
    amount: recurring.amount,
    memo: recurring.memo,
    date: date,
    createdAt: 0,
    _isRecurring: true
  };
}

function _budgetMonthKey() {
  const y = curDate.getFullYear();
  const m = curDate.getMonth();
  return `${y}-${_pad2(m + 1)}`;
}

async function _fetchPrevMonthData(userId, y, m, depth) {
  if (depth == null) depth = 12;                       // 最大12ヶ月遡る（1年分）
  const empty = { balance: 0, expCatSums: {}, incCatSums: {}, totalIncome: 0, totalExpense: 0, shiftPay: 0, manualIncome: 0, priorCarryover: 0 };
  if (!userId || userId === 'anon' || depth <= 0) return empty;
  // 対象月キー（古い順）を作る
  const monthKeys = [];
  let curY = y, curM = m - 1;
  if (curM === 0) { curM = 12; curY--; }
  for (let i = 0; i < depth; i++) {
    monthKeys.unshift(`${curY}-${_pad2(curM)}`);
    curM--;
    if (curM === 0) { curM = 12; curY--; }
  }
  let allEntries = [];
  try {
    allEntries = await loadBudgetMonthsFromSupabase(userId, monthKeys);
  } catch (e) {
    return empty;
  }
  const byMonth = {};
  monthKeys.forEach(k => { byMonth[k] = []; });
  allEntries.forEach(en => { if (byMonth[en.monthKey]) byMonth[en.monthKey].push(en); });
  const recurring = await loadRecurringBudgetFromSupabase(userId);
  recurring.forEach(re => monthKeys.forEach(key => {
    const generated = _recurringEntryForMonth(re, key);
    if (generated) byMonth[key].push(generated);
  }));
  // 古い月から複利的に積み上げ
  let priorCarryover = 0;
  let last = empty;
  for (let i = 0; i < monthKeys.length; i++) {
    const key = monthKeys[i];
    const parts = key.split('-');
    const py = +parts[0], pm = +parts[1];
    const shift = _collectShiftsForMonth(py, pm);
    const shiftPay = shift.totalShiftPay;
    let manualIncome = 0, totalExpense = 0;
    const expCatSums = {}, incCatSums = {};
    byMonth[key].forEach(en => {
      if (en.type === 'income') {
        manualIncome += en.amount;
        incCatSums[en.catId] = (incCatSums[en.catId] || 0) + en.amount;
      } else {
        totalExpense += en.amount;
        expCatSums[en.catId] = (expCatSums[en.catId] || 0) + en.amount;
      }
    });
    const totalIncome = shiftPay + manualIncome + priorCarryover;
    const balance = totalIncome - totalExpense;
    last = { balance, expCatSums, incCatSums, totalIncome, totalExpense, shiftPay, manualIncome, priorCarryover };
    priorCarryover = balance;
  }
  return last;
}

async function _syncBudgetMonth() {
  if (!_budgetState) return;
  const mk = _budgetMonthKey();
  if (_budgetState.monthKey !== mk) {
    _budgetState.monthKey = mk;
    _budgetState.entries = await loadBudgetFromSupabase(_budgetState.userId, mk);
  }
  _budgetState.recurring = await loadRecurringBudgetFromSupabase(_budgetState.userId);
  // 常に prevMonthData を再フェッチ（一括取得 1 query でコスト一定、過去月編集の即時反映を保証）
  const parts0 = mk.split('-');
  const pmd = await _fetchPrevMonthData(_budgetState.userId, +parts0[0], +parts0[1]);
  _budgetState.prevMonthBalance = pmd.balance;
  _budgetState.prevMonthData = pmd;
}

function getBudgetCat(catId) {
  return budgetExpenseCats.find(c => c.id === catId)
      || budgetIncomeCats.find(c => c.id === catId)
      || { id: catId, name: catId, icon: '?', color: '#888' };
}

async function initBudgetPanel(user) {
  const listEl    = document.getElementById('js-budget-list');
  const formEl    = document.getElementById('js-budget-form');
  const amountEl  = document.getElementById('js-budget-amount');
  const memoEl    = document.getElementById('js-budget-memo');
  const typeEl    = document.getElementById('js-budget-type');
  const catEl     = document.getElementById('js-budget-cat');
  const dateEl    = document.getElementById('js-budget-date');
  const repeatEl  = document.getElementById('js-budget-repeat-monthly');
  const summaryEl = document.getElementById('js-budget-summary');

  if (!listEl || !formEl) return;

  const userId = user?.id || 'anon';
  const mk = _budgetMonthKey();
  const mkParts = mk.split('-');
  const prevMonthData = await _fetchPrevMonthData(userId, +mkParts[0], +mkParts[1]);

  _budgetState = {
    userId,
    monthKey: mk,
    entries: await loadBudgetFromSupabase(userId, mk),
    prevMonthBalance: prevMonthData.balance,
    prevMonthData,
    filter: 'all', // 'all' | 'expense' | 'income'
    recurring: await loadRecurringBudgetFromSupabase(userId),
    els: { listEl, formEl, amountEl, memoEl, typeEl, catEl, dateEl, repeatEl, summaryEl }
  };

  // Populate category dropdown
  _updateBudgetCatOptions();

  // Default date = today
  if (dateEl) {
    const td = new Date();
    dateEl.value = `${td.getFullYear()}-${_pad2(td.getMonth()+1)}-${_pad2(td.getDate())}`;
  }

  renderBudgetPanel();

  // Type toggle → update cat options
  typeEl?.addEventListener('change', () => _updateBudgetCatOptions());
  repeatEl?.addEventListener('change', () => _syncBudgetRepeatControls());

  // Submit
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!_budgetState) return;
    const amount = parseInt(amountEl.value) || 0;
    if (amount <= 0) { amountEl.focus(); return; }
    const memo = (memoEl?.value || '').trim();
    const date = dateEl?.value || _todayStr();
    const repeatsMonthly = !!repeatEl?.checked;
    const type = repeatsMonthly ? 'expense' : (typeEl?.value || 'expense');
    const catId = repeatsMonthly ? _BUDGET_SUBSCRIPTION_CAT.id
      : (catEl?.value || (type === 'expense' ? 'food' : 'salary'));

    // 編集モード：既存エントリを更新
    if (_budgetEditingId) {
      const entry = _budgetState.entries.find(en => en.id === _budgetEditingId);
      _exitBudgetEditMode();
      if (entry) {
        entry.type = type; entry.catId = catId; entry.amount = amount;
        entry.memo = memo; entry.date = date;
        renderBudgetPanel();
        await updateBudgetToSupabase(entry);
      } else {
        renderBudgetPanel();
      }
      return;
    }

    if (repeatsMonthly) {
      const id = `rb_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const dayOfMonth = Math.max(1, Math.min(31, +(date.slice(8, 10)) || 1));
      const recurring = { id, type, catId, amount, memo, dayOfMonth, startDate: date };
      _budgetState.recurring.push(recurring);
      amountEl.value = '';
      memoEl.value = '';
      repeatEl.checked = false;
      renderBudgetPanel();
      await addRecurringBudgetToSupabase(recurring);
      return;
    }

    const id = `b_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const entry = { id, type, catId, amount, memo, date, createdAt: Date.now() };
    _budgetState.entries.push(entry);
    amountEl.value = '';
    memoEl.value = '';
    renderBudgetPanel();
    await addBudgetToSupabase(entry);
  });

  // Cancel edit
  document.getElementById('js-budget-cancel-edit')?.addEventListener('click', () => {
    _exitBudgetEditMode();
    renderBudgetPanel();
  });

  // Tap row to edit / delete button
  listEl.addEventListener('click', async (e) => {
    if (!_budgetState) return;
    const delBtn = e.target.closest?.('.budget-entry-del');
    if (delBtn) {
      const row = delBtn.closest('[data-budget-id]');
      if (!row) return;
      const id = row.getAttribute('data-budget-id');
      if (id === _budgetEditingId) _exitBudgetEditMode();
      const recurring = _budgetState.recurring.find(re => ('_recurring_' + re.id + '_' + _budgetState.monthKey) === id);
      if (recurring) {
        _budgetState.recurring = _budgetState.recurring.filter(re => re.id !== recurring.id);
        renderBudgetPanel();
        await deleteRecurringBudgetFromSupabase(recurring.id);
        return;
      }
      _budgetState.entries = _budgetState.entries.filter(en => en.id !== id);
      renderBudgetPanel();
      await deleteBudgetFromSupabase(id);
      return;
    }
    // 手動エントリ行のタップで編集モードへ（自動エントリは対象外）
    const row = e.target.closest?.('.budget-entry');
    if (!row || row.classList.contains('is-auto')) return;
    const id = row.getAttribute('data-budget-id');
    const entry = _budgetState.entries.find(en => en.id === id);
    if (entry) _enterBudgetEditMode(entry);
  });

  // Filter tabs
  document.querySelectorAll('.budget-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_budgetState) return;
      _budgetState.filter = btn.dataset.filter;
      document.querySelectorAll('.budget-filter').forEach(b =>
        b.classList.toggle('is-active', b === btn));
      renderBudgetPanel();
    });
  });
}

function _updateBudgetCatOptions() {
  if (!_budgetState) return;
  const catEl  = _budgetState.els.catEl;
  const typeEl = _budgetState.els.typeEl;
  if (!catEl || !typeEl) return;
  const type = typeEl.value;
  const cats = type === 'income' ? budgetIncomeCats : budgetExpenseCats;
  catEl.innerHTML = cats.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
}

function _syncBudgetRepeatControls() {
  if (!_budgetState) return;
  const { repeatEl, typeEl, catEl } = _budgetState.els;
  const repeating = !!repeatEl?.checked;
  if (typeEl) {
    if (repeating) typeEl.value = 'expense';
    typeEl.disabled = repeating;
  }
  _updateBudgetCatOptions();
  if (catEl) {
    if (repeating) catEl.value = _BUDGET_SUBSCRIPTION_CAT.id;
    catEl.disabled = repeating;
  }
}

// ── Budget entry edit mode ────────────────────────────────────────────────────

let _budgetEditingId = null;

function _enterBudgetEditMode(entry) {
  if (!_budgetState) return;
  _budgetEditingId = entry.id;
  const els = _budgetState.els;
  if (els.repeatEl) els.repeatEl.checked = false;
  if (els.typeEl) els.typeEl.disabled = false;
  if (els.catEl) els.catEl.disabled = false;
  if (els.typeEl) els.typeEl.value = entry.type;
  _updateBudgetCatOptions();
  if (els.catEl)    els.catEl.value    = entry.catId;
  if (els.amountEl) els.amountEl.value = entry.amount;
  if (els.dateEl && entry.date) els.dateEl.value = entry.date;
  if (els.memoEl)   els.memoEl.value   = entry.memo || '';
  const submitBtn = document.getElementById('js-budget-submit-btn');
  const cancelBtn = document.getElementById('js-budget-cancel-edit');
  if (submitBtn) submitBtn.textContent = '保存';
  if (cancelBtn) cancelBtn.style.display = '';
  renderBudgetPanel();                       // is-editing ハイライト反映
  els.amountEl?.focus();
}

function _exitBudgetEditMode() {
  _budgetEditingId = null;
  const els = _budgetState?.els;
  if (els) {
    if (els.amountEl) els.amountEl.value = '';
    if (els.memoEl)   els.memoEl.value   = '';
    if (els.repeatEl) els.repeatEl.checked = false;
    if (els.typeEl) els.typeEl.disabled = false;
    if (els.catEl) els.catEl.disabled = false;
  }
  const submitBtn = document.getElementById('js-budget-submit-btn');
  const cancelBtn = document.getElementById('js-budget-cancel-edit');
  if (submitBtn) submitBtn.textContent = '追加';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

function _collectShiftsForMonth(y, m) {
  // y, m are 1-based. Collect shifts EARNED in (y, m) itself (発生主義).
  var monthDate = new Date(y, m - 1, 1);
  var pY = monthDate.getFullYear(), pM = monthDate.getMonth(); // 0-based month
  var dim = new Date(pY, pM + 1, 0).getDate();
  var shiftEntries = [];
  var totalShiftPay = 0;
  var perCat = {}; // catId -> { workMinutes, pay }

  for (var d = 1; d <= dim; d++) {
    var key = dateKey(pY, pM, d);
    var dayEvs = events[key] || [];
    for (var i = 0; i < dayEvs.length; i++) {
      var ev = dayEvs[i];
      if (!isShift(ev.catId)) continue;
      var sc = calcShift(ev);
      if (sc.pay <= 0) continue;
      var sCat = getCat(ev.catId);
      totalShiftPay += sc.pay;
      if (!perCat[ev.catId]) perCat[ev.catId] = { workMinutes: 0, pay: 0 };
      perCat[ev.catId].workMinutes += sc.workMinutes;
      perCat[ev.catId].pay += sc.pay;
      shiftEntries.push({
        id: '_shift_' + key + '_' + (ev._dbId || Math.random()),
        type: 'income',
        catId: '_shift',
        amount: sc.pay,
        memo: (sCat ? sCat.name : 'バイト') + '\u3000' + ev.shiftStart + '\u2013' + ev.shiftEnd + '\uFF08' + fmtMin(sc.workMinutes) + '\uFF09',
        date: key,
        createdAt: 0,
        _isShift: true
      });
    }
  }
  return { shiftEntries: shiftEntries, totalShiftPay: totalShiftPay, perCat: perCat,
           year: pY, month: pM };
}

function renderBudgetPanel() {
  if (!_budgetState) return;
  var bs = _budgetState;
  var entries = bs.entries, filter = bs.filter, monthKey = bs.monthKey, els = bs.els;

  var parts0 = monthKey.split('-');
  var y = +parts0[0], m = +parts0[1]; // 1-based

  var monthLabel = document.getElementById('js-budget-month-label');
  if (monthLabel) monthLabel.textContent = MONTHS_INIT[m - 1] + ' ' + y;

  // ── Carryover from previous month（黒字・赤字どちらも反映、シフト給与は前月 balance に内包） ──
  var prevDataLocal      = bs.prevMonthData || { shiftPay: 0, manualIncome: 0, totalExpense: 0, priorCarryover: 0 };
  var prevShiftPay       = prevDataLocal.shiftPay || 0;
  var prevManualBal      = (prevDataLocal.manualIncome || 0) - (prevDataLocal.totalExpense || 0);
  var prevPriorCarryover = prevDataLocal.priorCarryover || 0;      // \u524D\u3005\u6708\u4EE5\u524D\u306E\u7D2F\u7A4D\u7E70\u8D8A
  var prevMonthBalance   = prevShiftPay + prevManualBal + prevPriorCarryover;  // \u4E92\u63DB: \u5408\u8A08\u306F _fetchPrevMonthData.balance \u3068\u4E00\u81F4
  var pmY = m === 1 ? y - 1 : y, pmM = m === 1 ? 12 : m - 1;
  var carryoverEntries = [];
  if (prevShiftPay > 0) {
    carryoverEntries.push({
      id: '_carryover_shift',
      type: 'income',
      catId: '_carryover',
      amount: prevShiftPay,
      memo: pmY + '\u5E74' + pmM + '\u6708\u306E\u30D0\u30A4\u30C8\u4EE3',
      date: monthKey + '-01',
      _isCarryover: true,
      _carryoverKind: 'shift'
    });
  }
  if (prevManualBal !== 0) {
    carryoverEntries.push({
      id: '_carryover_manual',
      type: 'income',
      catId: '_carryover',
      amount: prevManualBal,                                       // \u7B26\u53F7\u4ED8\u304D
      memo: pmY + '\u5E74' + pmM + '\u6708\u306E\u624B\u52D5\u53CE\u652F',
      date: monthKey + '-01',
      _isCarryover: true,
      _carryoverKind: 'manual'
    });
  }
  if (prevPriorCarryover !== 0) {
    carryoverEntries.push({
      id: '_carryover_prior',
      type: 'income',
      catId: '_carryover',
      amount: prevPriorCarryover,                                  // 符号付き
      memo: pmY + '年' + pmM + '月以前からの繰越',
      date: monthKey + '-01',
      _isCarryover: true,
      _carryoverKind: 'prior'
    });
  }

  // ── Merge manual entries + monthly recurring entries + carryover ──
  var recurringEntries = (bs.recurring || []).map(function(re) {
    return _recurringEntryForMonth(re, monthKey);
  }).filter(Boolean);
  var allEntries = entries.slice().concat(recurringEntries, carryoverEntries);

  var sorted = allEntries.slice().sort(function(a, b) {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  var filtered = sorted.filter(function(en) {
    if (filter === 'expense') return en.type === 'expense';
    if (filter === 'income')  return en.type === 'income';
    return true;
  });

  // Summary
  var totalIncome  = prevMonthBalance;   // シフト分は前月の balance に内包済み、繰越で反映
  var totalExpense = 0;
  var catSums = {};

  entries.concat(recurringEntries).forEach(function(en) {
    if (en.type === 'income') {
      totalIncome += en.amount;
    } else {
      totalExpense += en.amount;
      if (!catSums[en.catId]) catSums[en.catId] = 0;
      catSums[en.catId] += en.amount;
    }
  });

  var balance = totalIncome - totalExpense;
  var prevData = bs.prevMonthData || { expCatSums: {}, incCatSums: {}, totalIncome: 0, totalExpense: 0, balance: 0 };
  var hasPrev = prevData.totalIncome > 0 || prevData.totalExpense > 0;

  // Helper: render a vs-先月 diff badge
  function _vsBadge(cur, prev, goodDir) {
    // goodDir: 'up' means increase is good (income), 'down' means decrease is good (expense)
    if (!hasPrev) return '';
    var d = cur - prev;
    if (d === 0) return '<span class="budget-vs-badge">\u2014</span>';
    var arrow = d > 0 ? '\u25B2' : '\u25BC';
    var cls = (d > 0) === (goodDir === 'up') ? 'is-good' : 'is-bad';
    return '<span class="budget-vs-badge ' + cls + '">' + arrow + fmtYen(Math.abs(d)) + '</span>';
  }

  if (els.summaryEl) {
    var topCats = Object.entries(catSums)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 5);

    var catBreakdown = '';
    if (topCats.length) {
      catBreakdown = '<div class="budget-cat-breakdown">';
      for (var ci = 0; ci < topCats.length; ci++) {
        var catId = topCats[ci][0], sum = topCats[ci][1];
        var bcat = getBudgetCat(catId);
        var pct = totalExpense > 0 ? Math.round(sum / totalExpense * 100) : 0;
        var prevCatSum = prevData.expCatSums[catId] || 0;
        var catDiff = sum - prevCatSum;
        var catDiffHtml;
        if (!hasPrev || prevCatSum === 0) {
          catDiffHtml = '<span class="budget-cat-diff is-new">NEW</span>';
        } else {
          var catArrow = catDiff > 0 ? '\u25B2' : '\u25BC';
          var catCls = catDiff > 0 ? 'is-bad' : 'is-good'; // expense: up=bad, down=good
          catDiffHtml = '<span class="budget-cat-diff ' + catCls + '">' + catArrow + fmtYen(Math.abs(catDiff)) + '</span>';
        }
        catBreakdown +=
          '<div class="budget-cat-row">' +
          '<span class="budget-cat-icon">' + bcat.icon + '</span>' +
          '<span class="budget-cat-name">' + bcat.name + '</span>' +
          '<span class="budget-cat-bar-wrap"><span class="budget-cat-bar" style="width:' + pct + '%;background:' + bcat.color + '"></span></span>' +
          '<span class="budget-cat-amount">' + fmtYen(sum) + '</span>' +
          catDiffHtml + '</div>';
      }
      catBreakdown += '</div>';
    }

    // \u30B7\u30D5\u30C8\u7D66\u4E0E\u306F \u30B5\u30E9\u30EA\u30FC\u30B5\u30DE\u30EA\u30FC\uFF08\u30B5\u30A4\u30C9\u30D0\u30FC\uFF09\u3067\u8868\u793A\u3059\u308B\u305F\u3081\u5BB6\u8A08\u7C3F\u30D1\u30CD\u30EB\u306B\u306F\u51FA\u3055\u306A\u3044
    var shiftDetail = '';

    // \u6B8B\u696D\u30D0\u30F3\u30AF\u60C5\u5831\u30AB\u30FC\u30C9\uFF08\u5BB6\u8A08\u6587\u8108\u3067\u898B\u3048\u308B\u5316\uFF09
    var overtimeCard = '';
    var sCats = shiftCats();
    var totalBankMin = 0;
    var totalCashoutYen = 0;
    sCats.forEach(function(sc) {
      totalBankMin += getOvertimeBank(sc.id);
      totalCashoutYen += monthlyCashoutPayByCat(sc.id, y, m - 1); // m \u306F 1-based\u3001\u95A2\u6570\u306F 0-based \u6708
    });
    if (totalBankMin > 0 || totalCashoutYen > 0) {
      overtimeCard =
        '<div class="budget-overtime-card">' +
        '<div class="budget-overtime-info">' +
        '<span class="budget-overtime-icon">\u23F1</span>' +
        '<span class="budget-overtime-label">\u6B8B\u696D\u30D0\u30F3\u30AF</span>' +
        '<span class="budget-overtime-bank">' + formatMinToHHMM(totalBankMin) + '</span>' +
        '<span class="budget-overtime-sep">|</span>' +
        '<span class="budget-overtime-cashout-label">\u632F\u66FF\u6E08</span>' +
        '<span class="budget-overtime-cashout">' + fmtYen(totalCashoutYen) + '</span>' +
        '</div>' +
        '<div class="budget-overtime-actions">' +
        '<button type="button" id="js-budget-overtime-cashout-open"' + (totalBankMin > 0 ? '' : ' disabled') + '>\u23F1 \u632F\u66FF</button>' +
        '<button type="button" id="js-budget-overtime-history-open">\uD83D\uDCCA \u5C65\u6B74</button>' +
        '</div>' +
        '</div>';
    }

    els.summaryEl.innerHTML =
      '<div class="budget-summary-grid">' +
      '<div class="budget-summary-card is-income"><div class="budget-summary-label">\u53CE\u5165</div><div class="budget-summary-value">' + fmtYen(totalIncome) + '</div>' + _vsBadge(totalIncome, prevData.totalIncome, 'up') + '</div>' +
      '<div class="budget-summary-card is-expense"><div class="budget-summary-label">\u652F\u51FA</div><div class="budget-summary-value">' + fmtYen(totalExpense) + '</div>' + _vsBadge(totalExpense, prevData.totalExpense, 'down') + '</div>' +
      '<div class="budget-summary-card is-balance ' + (balance >= 0 ? 'is-positive' : 'is-negative') + '"><div class="budget-summary-label">\u53CE\u652F</div><div class="budget-summary-value">' + (balance >= 0 ? '+' : '') + fmtYen(balance) + '</div>' + _vsBadge(balance, prevData.balance, 'up') + '</div>' +
      '</div>' + overtimeCard + shiftDetail + catBreakdown;

    // \u6B8B\u696D\u30D0\u30F3\u30AF\u30AB\u30FC\u30C9\u5185\u306E\u30DC\u30BF\u30F3\u306B\u65E2\u5B58\u30E2\u30FC\u30C0\u30EB\u95A2\u6570\u3092\u7D10\u4ED8\u3051
    var cBtn = document.getElementById('js-budget-overtime-cashout-open');
    var hBtn = document.getElementById('js-budget-overtime-history-open');
    if (cBtn) cBtn.addEventListener('click', openOvertimeCashoutModal);
    if (hBtn) hBtn.addEventListener('click', openOvertimeHistoryModal);
  }

  // Render list
  if (filtered.length === 0) {
    var emptyMsg = filter === 'income' ? '\u53CE\u5165\u306E\u8A18\u9332\u306F\u3042\u308A\u307E\u305B\u3093'
                 : filter === 'expense' ? '\u652F\u51FA\u306E\u8A18\u9332\u306F\u3042\u308A\u307E\u305B\u3093'
                 : '\u8A18\u9332\u3092\u8FFD\u52A0\u3057\u3066\u5BB6\u8A08\u3092\u7BA1\u7406\u3057\u307E\u3057\u3087\u3046';
    els.listEl.innerHTML = '<div class="budget-empty">' + emptyMsg + '</div>';
    return;
  }

  // Group by date
  var groups = {};
  filtered.forEach(function(en) {
    if (!groups[en.date]) groups[en.date] = [];
    groups[en.date].push(en);
  });

  var DOWS = ['\u65E5','\u6708','\u706B','\u6C34','\u6728','\u91D1','\u571F'];
  var html = '';
  var gKeys = Object.keys(groups).sort(function(a, b) { return b.localeCompare(a); });
  for (var gi = 0; gi < gKeys.length; gi++) {
    var gDate = gKeys[gi], gItems = groups[gDate];
    var gParts = gDate.split('-');
    var gd = new Date(+gParts[0], +gParts[1] - 1, +gParts[2]);
    var gdow = DOWS[gd.getDay()];
    var dayTotal = 0;
    for (var di2 = 0; di2 < gItems.length; di2++) {
      dayTotal += gItems[di2].type === 'expense' ? -gItems[di2].amount : gItems[di2].amount;
    }

    html += '<div class="budget-date-group"><div class="budget-date-header">' +
      '<span class="budget-date-label">' + (+gParts[1]) + '/' + (+gParts[2]) + '\uFF08' + gdow + '\uFF09</span>' +
      '<span class="budget-date-total ' + (dayTotal >= 0 ? 'is-pos' : 'is-neg') + '">' + (dayTotal >= 0 ? '+' : '') + fmtYen(dayTotal) + '</span></div>';

    for (var ii = 0; ii < gItems.length; ii++) {
      var gen = gItems[ii];
      var isShiftEntry = gen._isShift;
      var isCarryover = gen._isCarryover;
      var isRecurring = gen._isRecurring;
      var isAuto = isShiftEntry || isCarryover || isRecurring;
      var isInc = gen.type === 'income';
      var gIcon, gCatName;
      if (isShiftEntry) {
        gIcon = '\u23F1'; gCatName = '\u30D0\u30A4\u30C8';
      } else if (isCarryover) {
        gIcon = '\u21A9'; gCatName = '\u5148\u6708\u7E70\u8D8A';
      } else {
        var gCat = getBudgetCat(gen.catId);
        gIcon = gCat.icon; gCatName = gCat.name;
      }
      var autoBadge = isShiftEntry ? '\u81EA\u52D5' : isCarryover ? '\u7E70\u8D8A' : isRecurring ? '\u6708\u984D' : '';
      // \u7E70\u8D8A\u306F\u7B26\u53F7\u4ED8\u304D\uFF1A\u8CA0\u306E\u7E70\u8D8A\u306F\u8D64\u5B57\u30B9\u30BF\u30A4\u30EB\u3067\u300C\u2212\u00A5X\u300D\u3068\u8868\u793A
      var displaySign, amountCls;
      if (isCarryover) {
        displaySign = gen.amount >= 0 ? '+' : '\u2212';
        amountCls   = gen.amount >= 0 ? 'is-income' : 'is-expense';
      } else {
        displaySign = isInc ? '+' : '-';
        amountCls   = isInc ? 'is-income' : 'is-expense';
      }
      html += '<div class="budget-entry ' + (isInc ? 'is-income' : 'is-expense') + (isAuto ? ' is-auto' : '') + (gen.id === _budgetEditingId ? ' is-editing' : '') + '" data-budget-id="' + gen.id + '">' +
        '<span class="budget-entry-icon' + (isAuto ? ' is-shift-icon' : '') + '">' + gIcon + '</span>' +
        '<div class="budget-entry-body"><span class="budget-entry-cat">' + gCatName + (isAuto ? '<span class="budget-auto-badge">' + autoBadge + '</span>' : '') + (gen.source === 'jcb' ? '<span class="budget-jcb-badge" title="JCBメールから自動取込"><svg class="svg-icon"><use href="#lucide-credit-card"/></svg></span>' : '') + '</span>' +
        (gen.memo ? '<span class="budget-entry-memo">' + escapeHtml(gen.memo) + '</span>' : '') +
        '</div>' +
        '<span class="budget-entry-amount ' + amountCls + '">' + displaySign + fmtYen(Math.abs(gen.amount)) + '</span>' +
        ((isShiftEntry || isCarryover) ? '' : '<button class="budget-entry-del" type="button" title="' + (isRecurring ? '\u6708\u984D\u9805\u76EE\u3092\u524A\u9664' : '\u524A\u9664') + '" aria-label="\u524A\u9664">\u2715</button>') +
        '</div>';
    }
    html += '</div>';
  }

  els.listEl.innerHTML = html;
}


// ════════════════════════════════════════════════════════════
//  RECEIPT SCANNING (レシート読取)
// ════════════════════════════════════════════════════════════

let _receiptBase64 = null;
let _receiptMediaType = null;
let _receiptParsed = null;

// ── Anthropic API key handling REMOVED for security ──
// Older versions stored a user-supplied Anthropic API key in localStorage and
// called the Anthropic API directly from the browser
// ('anthropic-dangerous-direct-browser-access'), which exposed the key to any XSS.
// The key, its ⚙ settings modal, and the direct call have been removed; the
// on-device receipt scanner is disabled until reimplemented via a server proxy.
// Purge any key persisted by older versions:
try { localStorage.removeItem('kuro_claude_key'); } catch (e) {}

// ── Receipt modal ──

function openReceiptModal() {
  // Disabled: receipt AI scanning required a client-side Anthropic API key,
  // which was removed for security. Reimplement behind a server proxy to restore.
  appNotice('レシートのAI解析は無効化されています（APIキーのクライアント保存を廃止しました）。');
}

function _showReceiptStep(step) {
  document.getElementById('js-receipt-step-upload').style.display  = step === 'upload'  ? '' : 'none';
  document.getElementById('js-receipt-step-loading').style.display = step === 'loading' ? '' : 'none';
  document.getElementById('js-receipt-step-result').style.display  = step === 'result'  ? '' : 'none';
  document.getElementById('js-receipt-step-error').style.display   = step === 'error'   ? '' : 'none';
}

document.getElementById('js-receipt-btn').addEventListener('click', openReceiptModal);

// ── JCB メール自動取込 設定モーダル ──
document.getElementById('js-jcb-btn')?.addEventListener('click', function() {
  var uid = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : '';
  var el = document.getElementById('js-jcb-userid');
  if (el) el.value = uid || '(ログインすると表示されます)';
  openSettings('jcb');
});

document.getElementById('js-jcb-ok')?.addEventListener('click', closeSettings);

document.getElementById('js-receipt-modal-close').addEventListener('click', function() {
  closeOverlay('js-receipt-overlay');
});
document.getElementById('js-receipt-overlay').addEventListener('click', function(e) {
  if (_isBackdropClick(e, 'js-receipt-overlay')) closeOverlay('js-receipt-overlay');
});

// ── File input / drop zone ──

var receiptFileInput = document.getElementById('js-receipt-file');
var receiptDropZone  = document.getElementById('js-receipt-drop');

receiptDropZone.addEventListener('click', function() {
  receiptFileInput.click();
});

receiptFileInput.addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (file) _handleReceiptFile(file);
  receiptFileInput.value = '';
});

// Drag and drop
receiptDropZone.addEventListener('dragover', function(e) {
  e.preventDefault();
  receiptDropZone.classList.add('is-dragover');
});
receiptDropZone.addEventListener('dragleave', function() {
  receiptDropZone.classList.remove('is-dragover');
});
receiptDropZone.addEventListener('drop', function(e) {
  e.preventDefault();
  receiptDropZone.classList.remove('is-dragover');
  var file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) _handleReceiptFile(file);
});

function _handleReceiptFile(file) {
  if (!file.type.startsWith('image/')) return;

  // Determine media type
  _receiptMediaType = file.type;

  var reader = new FileReader();
  reader.onload = function(e) {
    var dataUrl = e.target.result;
    _receiptBase64 = dataUrl.split(',')[1];

    // Show preview
    document.getElementById('js-receipt-preview-img').src = dataUrl;
    document.getElementById('js-receipt-preview').style.display = '';
    document.getElementById('js-receipt-drop').style.display = 'none';
    document.getElementById('js-receipt-analyze').style.display = '';
  };
  reader.readAsDataURL(file);
}

document.getElementById('js-receipt-clear').addEventListener('click', function() {
  _receiptBase64 = null;
  document.getElementById('js-receipt-preview').style.display = 'none';
  document.getElementById('js-receipt-drop').style.display = '';
  document.getElementById('js-receipt-analyze').style.display = 'none';
});

// ── Analyze receipt (Claude Haiku API) ──

document.getElementById('js-receipt-analyze').addEventListener('click', async function() {
  // Disabled for security: the client-side Anthropic API key was removed, so no
  // receipt image is sent anywhere. The legacy code below is unreachable.
  appNotice('レシートのAI解析は無効化されています（APIキーのクライアント保存を廃止しました）。');
  return;
  // --- legacy (unreachable) ---
  if (!_receiptBase64) return;

  _showReceiptStep('loading');

  // カテゴリ一覧をプロンプトに動的反映
  var catList = budgetExpenseCats.map(function(c) { return '- ' + c.id + ': ' + c.name; }).join('\n');

  try {
    var response = await fetch('about:blank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: _receiptMediaType || 'image/jpeg',
                data: _receiptBase64
              }
            },
            {
              type: 'text',
              text: 'このレシートの内容を解析して、以下のJSON形式だけを返してください。JSON以外は絶対に出力しないでください。\n\n```\n{\n  "store": "店舗名",\n  "date": "YYYY-MM-DD",\n  "items": [\n    { "name": "商品名", "amount": 金額(整数), "category": "カテゴリID" }\n  ],\n  "total": 合計金額(整数)\n}\n```\n\ncategoryは以下から最も適切なものを選んでください:\n' + catList + '\n\n日付が読み取れない場合は "date": null としてください。金額は税込の数値（整数）にしてください。'
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      var errBody = await response.text();
      var apiMsg = '';
      try { apiMsg = JSON.parse(errBody)?.error?.message || ''; } catch {}
      throw new Error('API error ' + response.status + ': ' + (apiMsg || errBody));
    }

    var data = await response.json();
    var text = '';
    for (var i = 0; i < data.content.length; i++) {
      if (data.content[i].type === 'text') text += data.content[i].text;
    }
    if (!text) throw new Error('レスポンスが空でした。もう一度試してください。');

    var jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    _receiptParsed = JSON.parse(jsonStr);

    _renderReceiptResult();
    _showReceiptStep('result');

  } catch (err) {
    console.error('Receipt scan error:', err);
    var errMsg = err.message || 'エラーが発生しました。';
    if (errMsg.includes('401')) {
      errMsg = 'APIキーが無効です。⚙ボタンからAnthropicのAPIキーを設定してください。';
    } else if (errMsg.includes('credit balance') || errMsg.includes('too low')) {
      errMsg = 'APIのクレジット残高が不足しています。console.anthropic.com でクレジットを追加してください。';
    } else if (errMsg.includes('400')) {
      errMsg = 'リクエストエラー（400）: ' + errMsg.replace(/^API error \d+: /, '');
    } else if (errMsg.includes('429')) {
      errMsg = 'レート制限に達しました。少し待ってから再試行してください。';
    } else if (errMsg.includes('529') || errMsg.includes('overloaded')) {
      errMsg = 'APIが混雑しています。しばらく待ってから再試行してください。';
    } else if (errMsg.includes('Failed to fetch') || errMsg.includes('network')) {
      errMsg = 'ネットワークエラーです。接続を確認してください。';
    }
    document.getElementById('js-receipt-error-msg').textContent = errMsg;
    _showReceiptStep('error');
  }
});

// ── Render results ──

function _renderReceiptResult() {
  if (!_receiptParsed) return;
  var p = _receiptParsed;

  document.getElementById('js-receipt-store').textContent = p.store || '(店舗名不明)';
  document.getElementById('js-receipt-date').textContent = p.date || '(日付不明)';

  var items = p.items || [];
  var listEl = document.getElementById('js-receipt-items');
  listEl.innerHTML = '';

  items.forEach(function(item, idx) {
    var cat = getBudgetCat(item.category || 'other_exp');
    var row = document.createElement('div');
    row.className = 'receipt-item-row';
    row.setAttribute('data-idx', idx);
    row.innerHTML =
      '<span class="receipt-item-icon">' + cat.icon + '</span>' +
      '<div class="receipt-item-body">' +
        '<input class="receipt-item-name-input" type="text" value="' + escHtml(item.name) + '" data-field="name" />' +
        '<select class="receipt-item-cat-select" data-field="category">' +
          budgetExpenseCats.map(function(c) {
            return '<option value="' + c.id + '"' + (c.id === item.category ? ' selected' : '') + '>' + c.icon + ' ' + c.name + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      '<input class="receipt-item-amount-input" type="number" value="' + (item.amount || 0) + '" data-field="amount" min="0" />' +
      '<button class="receipt-item-del" type="button" title="除外">\u2715</button>';

    // Edit handlers
    row.querySelector('[data-field="name"]').addEventListener('input', function(e) {
      _receiptParsed.items[idx].name = e.target.value;
    });
    row.querySelector('[data-field="category"]').addEventListener('change', function(e) {
      _receiptParsed.items[idx].category = e.target.value;
      var newCat = getBudgetCat(e.target.value);
      row.querySelector('.receipt-item-icon').textContent = newCat.icon;
    });
    row.querySelector('[data-field="amount"]').addEventListener('input', function(e) {
      _receiptParsed.items[idx].amount = parseInt(e.target.value) || 0;
      _updateReceiptTotal();
    });
    row.querySelector('.receipt-item-del').addEventListener('click', function() {
      _receiptParsed.items.splice(idx, 1);
      _renderReceiptResult();
    });

    listEl.appendChild(row);
  });

  _updateReceiptTotal();
}

function _updateReceiptTotal() {
  if (!_receiptParsed) return;
  var total = 0;
  (_receiptParsed.items || []).forEach(function(it) { total += (it.amount || 0); });
  _receiptParsed.total = total;
  document.getElementById('js-receipt-total').textContent = fmtYen(total);
}

// ── Save results to budget ──

document.getElementById('js-receipt-save').addEventListener('click', async function() {
  if (!_receiptParsed || !_budgetState) return;
  var p = _receiptParsed;
  var date = p.date || _todayStr();
  var store = p.store || '';

  var newEntries = [];
  (p.items || []).forEach(function(item) {
    if (!item.amount || item.amount <= 0) return;
    var id = 'b_' + Date.now() + '_' + Math.random().toString(16).slice(2);
    var entry = {
      id: id,
      type: 'expense',
      catId: item.category || 'other_exp',
      amount: item.amount,
      memo: (store ? store + ' - ' : '') + (item.name || ''),
      date: date,
      createdAt: Date.now()
    };
    _budgetState.entries.push(entry);
    newEntries.push(entry);
  });

  renderBudgetPanel();
  closeOverlay('js-receipt-overlay');
  for (var i = 0; i < newEntries.length; i++) {
    await addBudgetToSupabase(newEntries[i]);
  }
});

// ── Retry / error retry ──

document.getElementById('js-receipt-retry').addEventListener('click', function() {
  _receiptBase64 = null;
  _receiptParsed = null;
  _showReceiptStep('upload');
  document.getElementById('js-receipt-preview').style.display = 'none';
  document.getElementById('js-receipt-drop').style.display = '';
  document.getElementById('js-receipt-analyze').style.display = 'none';
});

document.getElementById('js-receipt-error-retry').addEventListener('click', function() {
  _showReceiptStep('upload');
});


// ════════════════════════════════════════════════════════════
//  DAILY PLAN MODAL (明日のタスク計画)
// ════════════════════════════════════════════════════════════

function _tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${_pad2(d.getMonth()+1)}-${_pad2(d.getDate())}`;
}

function openDailyPlanModal() {
  const tomorrow = _tomorrowStr();
  const dateEl = document.getElementById('js-daily-plan-date');
  dateEl.value = tomorrow;
  _updateDailyPlanLabel();

  document.getElementById('js-daily-plan-main').value = '';
  document.getElementById('js-daily-plan-sub1').value = '';
  document.getElementById('js-daily-plan-sub2').value = '';

  openOverlay('js-daily-plan-overlay');
  setTimeout(() => document.getElementById('js-daily-plan-main').focus(), 80);
}

function _updateDailyPlanLabel() {
  const val = document.getElementById('js-daily-plan-date').value;
  if (!val) return;
  const d = new Date(val + 'T00:00:00');
  const label = document.getElementById('js-daily-plan-date-label');
  label.textContent = `${MONTHS_INIT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} (${DAYS_EN[d.getDay()]})`;
}

document.getElementById('js-daily-plan-date').addEventListener('change', _updateDailyPlanLabel);

document.getElementById('js-daily-plan-btn').addEventListener('click', openDailyPlanModal);

document.getElementById('js-daily-plan-close').addEventListener('click', () => closeOverlay('js-daily-plan-overlay'));
document.getElementById('js-daily-plan-cancel').addEventListener('click', () => closeOverlay('js-daily-plan-overlay'));
document.getElementById('js-daily-plan-overlay').addEventListener('click', e => {
  if (_isBackdropClick(e, 'js-daily-plan-overlay')) closeOverlay('js-daily-plan-overlay');
});

document.getElementById('js-daily-plan-save').addEventListener('click', async () => {
  if (!_taskState) return;

  const dueDate = document.getElementById('js-daily-plan-date').value;
  const mainTitle = document.getElementById('js-daily-plan-main').value.trim();
  const sub1Title = document.getElementById('js-daily-plan-sub1').value.trim();
  const sub2Title = document.getElementById('js-daily-plan-sub2').value.trim();

  if (!mainTitle) {
    document.getElementById('js-daily-plan-main').focus();
    return;
  }

  const newTasks = [];

  // Main task (high priority)
  newTasks.push({ priority: 'high', title: mainTitle });
  if (sub1Title) newTasks.push({ priority: 'medium', title: sub1Title });
  if (sub2Title) newTasks.push({ priority: 'medium', title: sub2Title });

  for (const spec of newTasks) {
    const id = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task = { id, title: spec.title, dueDate, priority: spec.priority, done: false, createdAt: Date.now() };
    _taskState.tasks.unshift(task);
    _persistTasks();
    await addTaskToSupabase(task);
  }

  renderTaskPanel();
  renderMain();
  closeOverlay('js-daily-plan-overlay');
});

// ════════════════════════════════════════════════════════════
//  OBSIDIAN VAULT (File System Access)
// ════════════════════════════════════════════════════════════
//
// Supabase stays the source of truth. This writes the same data out as Markdown
// a vault can read, and reads hand-edits back in.
//
// Availability: showDirectoryPicker exists on Electron and Chrome/Edge desktop
// but not on iOS Safari or Firefox, so the whole entry point is feature-gated.
// An iOS vault lives in iCloud, where picking a local folder has no meaning.
//
// Verified inside desktop/shell.html's same-origin iframe: the API is reachable
// with the existing allow list and 127.0.0.1 is a secure context; only the user
// gesture is needed, which the button supplies.

const VAULT_DIR = 'karenda';
let _vaultHandle = null;

function _vaultLog(msg, isError) {
  const el = document.getElementById('js-vault-log');
  if (!el) return;
  const line = document.createElement('div');
  line.className = 'vault-log-line' + (isError ? ' is-error' : '');
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function _vaultSetPath(name) {
  const el = document.getElementById('js-vault-path');
  if (el) el.textContent = name || '未選択';
}

// Ensure we have a handle AND live permission. Both the picker and the
// permission re-prompt need a user gesture, so only call this from a click.
async function _vaultReady() {
  if (!vaultFs.isSupported()) { appNotice('この環境ではフォルダを開けません。'); return null; }
  if (!_vaultHandle) _vaultHandle = await vaultFs.getSavedVault();
  if (!_vaultHandle) { appNotice('先に Vault フォルダを選択してください。'); return null; }
  const state = await vaultFs.checkPermission(_vaultHandle, true);
  if (state !== 'granted') { appNotice('フォルダへのアクセスが許可されませんでした。'); return null; }
  return _vaultHandle;
}

async function vaultExport() {
  const root = await _vaultReady();
  if (!root) return;

  const y = curDate.getFullYear(), m = curDate.getMonth();
  const monthLabel = `${y}-${String(m + 1).padStart(2, '0')}`;
  const ok = await appConfirm(
    `${monthLabel} の予定と、家計簿・タスク・目標を「${root.name}/${VAULT_DIR}」に書き出します。\n同名のファイルは上書きされます。`,
    '書き出す'
  );
  if (!ok) return;

  try {
    const base = await vaultFs.dir(root, VAULT_DIR, true);
    const catName = id => getCat(id)?.name || '';
    let n = 0;

    // Daily notes for the displayed month
    const daily = await vaultFs.dir(base, 'daily', true);
    const dim = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      const key = dateKey(y, m, d);
      const evs = events[key];
      if (!evs || !evs.length) continue;
      await vaultFs.writeFile(daily, `${key}.md`, mdDaily.toDailyNote(key, evs, catName));
      n++;
    }
    _vaultLog(`デイリーノート ${n} 件を書き出しました`);

    // Budget entries
    if (_budgetState && _budgetState.entries && _budgetState.entries.length) {
      const bd = await vaultFs.dir(base, 'budget', true);
      let bn = 0;
      for (const e of _budgetState.entries) {
        const cn = getBudgetCat(e.catId)?.name || '';
        const fname = mdNote.safeFileName(`${e.date} ${cn} ${e.id}`) + '.md';
        await vaultFs.writeFile(bd, fname, mdNote.budgetToNote(e, cn));
        bn++;
      }
      _vaultLog(`家計簿 ${bn} 件を書き出しました`);
    }

    // Tasks
    if (_taskState && _taskState.tasks && _taskState.tasks.length) {
      const td = await vaultFs.dir(base, 'tasks', true);
      let tn = 0;
      for (const t of _taskState.tasks) {
        const fname = mdNote.safeFileName(`${t.title || 'task'} ${t.id}`) + '.md';
        await vaultFs.writeFile(td, fname, mdNote.taskToNote(t));
        tn++;
      }
      _vaultLog(`タスク ${tn} 件を書き出しました`);
    }

    // Goals — localStorage only, so this is the only way they leave the device.
    if (currentUser) {
      const goals = _loadGoal(currentUser.id) || {};
      const keys = Object.keys(goals);
      if (keys.length) {
        const gd = await vaultFs.dir(base, 'goals', true);
        let gn = 0;
        for (const dk of keys) {
          const list = Array.isArray(goals[dk]) ? goals[dk] : (goals[dk] && goals[dk].subs) || [];
          for (const g of list) {
            if (!g || !g.id) continue;
            const fname = mdNote.safeFileName(`${dk} ${g.id}`) + '.md';
            await vaultFs.writeFile(gd, fname, mdNote.goalToNote(g, dk));
            gn++;
          }
        }
        if (gn) _vaultLog(`目標 ${gn} 件を書き出しました`);
      }
    }

    appNotice('Vault に書き出しました。');
  } catch (e) {
    console.error('vault export error:', e);
    _vaultLog('書き出しに失敗: ' + (e.message || e), true);
    appNotice('書き出しに失敗しました。');
  }
}

async function vaultImport() {
  const root = await _vaultReady();
  if (!root) return;

  const y = curDate.getFullYear(), m = curDate.getMonth();
  const monthLabel = `${y}-${String(m + 1).padStart(2, '0')}`;
  const ok = await appConfirm(
    `「${root.name}/${VAULT_DIR}/daily」から ${monthLabel} の予定を読み込み、この月の予定を置き換えます。\nこの操作は元に戻せません。`,
    '読み込む'
  );
  if (!ok) return;

  try {
    const base = await vaultFs.dir(root, VAULT_DIR, false);
    const daily = await vaultFs.dir(base, 'daily', false);
    const names = (await vaultFs.listMarkdown(daily)).filter(n => n.startsWith(monthLabel));
    if (!names.length) {
      _vaultLog(`${monthLabel} のデイリーノートが見つかりません`, true);
      appNotice('対象のノートがありません。');
      return;
    }

    // Resolve a #tag back to a category; never invent one.
    const catIdByTag = tag => {
      if (!tag) return null;
      const c = categories.find(c => String(c.name).replace(/\s+/g, '_') === tag);
      return c ? c.id : null;
    };

    let added = 0, unknown = 0;
    for (const name of names) {
      const text = await vaultFs.readFile(daily, name);
      if (text == null) continue;
      const key = mdDaily.dateKeyFromNote(text) || name.replace(/\.md$/i, '');
      const parsed = mdDaily.fromDailyNote(text, catIdByTag);

      // Replace the day: delete what is there, then insert what the note says.
      for (const old of (events[key] || [])) {
        if (old._dbId) await deleteEventFromSupabase(old);
      }
      events[key] = [];
      for (const ev of parsed) {
        if (ev.catId == null) {
          unknown++;
          ev.catId = selectedCatId ?? categories[0]?.id;
          if (ev.catId == null) continue;   // no categories at all — skip
        }
        const clean = {
          catId: ev.catId, title: ev.title, time: ev.time, timeEnd: ev.timeEnd,
          shiftStart: ev.shiftStart, shiftEnd: ev.shiftEnd,
          breakMinutes: ev.breakMinutes, overtimeMinutes: ev.overtimeMinutes,
          reminderMinutes: ev.reminderMinutes,
        };
        events[key].push(clean);
        await addEventToSupabase(key, clean);
        added++;
      }
      _vaultLog(`${name}: ${parsed.length} 件`);
    }

    renderAll();
    if (unknown) appNotice(`${added} 件を読み込みました（未知のカテゴリ ${unknown} 件は既定カテゴリにしました）。`);
    else appNotice(`${added} 件を読み込みました。`);
  } catch (e) {
    console.error('vault import error:', e);
    _vaultLog('読み込みに失敗: ' + (e.message || e), true);
    appNotice('読み込みに失敗しました。');
  }
}

(function initVault() {
  const ribbonBtn = document.getElementById('js-ribbon-vault');
  // Feature-gate the whole entry point (iOS Safari / Firefox have no picker).
  if (!vaultFs.isSupported()) { if (ribbonBtn) ribbonBtn.remove(); return; }
  if (ribbonBtn) ribbonBtn.hidden = false;

  ribbonBtn?.addEventListener('click', async () => {
    openSettings('vault');
    const saved = await vaultFs.getSavedVault();
    if (saved) { _vaultHandle = saved; _vaultSetPath(saved.name); }
  });

  document.getElementById('js-vault-pick')?.addEventListener('click', async () => {
    try {
      const h = await vaultFs.pickVault();     // needs the user gesture we are in
      _vaultHandle = h;
      _vaultSetPath(h.name);
      _vaultLog(`Vault を「${h.name}」に設定しました`);
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // user closed the picker
      console.error('vault pick error:', e);
      appNotice('フォルダを選択できませんでした。');
    }
  });

  document.getElementById('js-vault-export')?.addEventListener('click', vaultExport);
  document.getElementById('js-vault-import')?.addEventListener('click', vaultImport);
})();

// ════════════════════════════════════════════════════════════
//  GRAPH VIEW (Obsidian のグラフビュー相当)
// ════════════════════════════════════════════════════════════
//
// 日付を中心に、予定・タスク・カテゴリが繋がる力学グラフ。
// モデル（何がノードで何が繋がるか）は lib/graph-model.js、力学は
// lib/graph-force.js。どちらも純粋関数で node --test の対象。ここに残るのは
// canvas・寸法・テーマの読み取りといった副作用だけ。

function graphTheme() {
  if (_graphTheme) return _graphTheme;
  const cs = getComputedStyle(document.body);
  const t = k => cs.getPropertyValue(k).trim();   // 先頭に空白が付くので trim 必須
  _graphTheme = {
    line:    t('--graph-line'),
    node:    t('--graph-node'),
    focused: t('--graph-node-focused'),
    attach:  t('--graph-node-attachment'),
    today:   t('--graph-node-today'),
    text:    t('--graph-text'),
    faint:   t('--text-faint'),
  };
  return _graphTheme;
}

// ノードの色。モデルは CSS を知らないので、色を持たないノード（日付・タスク・
// catId が壊れた予定）はここでテーマから決める。
function graphNodeColor(n, th) {
  if (n.color) return n.color;
  // pinned は「今日の日付ノード」を意味する（モデルが today にだけ立てる）。
  // 日付ノードは color を持たないので上の分岐とは衝突しないが、順序で意図を示す。
  if (n.pinned) return th.today;
  if (n.kind === 'task') return th.attach;
  return th.node;
}

function _graphCanvas() { return document.getElementById('js-graph-canvas'); }

// キャンバスを CSS ピクセルで扱えるようにする（以降 ctx は CSS px で描ける）。
// display:none の間は 0x0 が返るので、呼べるのは表示後だけ。
function _graphResize() {
  const cv = _graphCanvas();
  if (!cv) return null;
  const wrap = cv.parentElement;
  const r = wrap.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;   // まだ非表示
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width), h = Math.round(r.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function _graphDraw() {
  const s = _graphResize();
  if (!s || !_graphData) return;
  const { ctx, w, h } = s;
  const th = graphTheme();
  const cam = _graphCam;
  const nodes = _graphData.nodes, edges = _graphData.edges;

  ctx.clearRect(0, 0, w, h);

  const sx = n => n.x * cam.zoom + cam.tx;
  const sy = n => n.y * cam.zoom + cam.ty;

  // ホバー中は、その点と隣接だけを残して他を沈める（Obsidian と同じ）。
  // focus が null のときは全部が主役。
  const focus = _graphHover && _graphData.adj.has(_graphHover)
    ? new Set([_graphHover, ..._graphData.adj.get(_graphHover)])
    : null;
  const DIM = 0.25;
  const lit = id => !focus || focus.has(id);

  // エッジ。色は1種類なので、明るい束と沈めた束の2パスで済む。stroke は2回。
  const byId = new Map(nodes.map(n => [n.id, n]));
  const strokeEdges = want => {
    ctx.beginPath();
    let any = false;
    for (const e of edges) {
      // 線が主役なのは両端が focus のときだけ。片端だけの線を明るくすると
      // 隣接の隣接まで繋がって見え、減光の意味が消える。
      const on = !focus || (focus.has(e.source) && focus.has(e.target));
      if (on !== want) continue;
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b) continue;
      ctx.moveTo(sx(a), sy(a));
      ctx.lineTo(sx(b), sy(b));
      any = true;
    }
    if (any) ctx.stroke();
  };
  ctx.strokeStyle = th.line;
  ctx.lineWidth = Math.max(0.5, 1 * cam.zoom);
  ctx.globalAlpha = 0.6 * DIM; strokeEdges(false);
  ctx.globalAlpha = 0.6;       strokeEdges(true);

  // ノード
  for (const n of nodes) {
    ctx.globalAlpha = lit(n.id) ? 1 : DIM;
    ctx.fillStyle = n.id === _graphHover ? th.focused : graphNodeColor(n, th);
    ctx.beginPath();
    ctx.arc(sx(n), sy(n), Math.max(1, n.r * cam.zoom), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // ラベル。ズームが浅いと潰れるので出さない（Obsidian の text fade と同じ考え）。
  // ただしホバー中の点とその隣接だけは、ズームに関係なく必ず読ませる —
  // 引いた状態で「この日に何がぶら下がっているか」を見るのがこのビューの用途で、
  // そこで名前が消えていては用を成さない。
  const fade = cam.zoom < 0.55 ? 0 : cam.zoom > 0.9 ? 1 : (cam.zoom - 0.55) / 0.35;
  if (fade > 0 || focus) {
    ctx.fillStyle = th.text;
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const n of nodes) {
      const forced = focus && focus.has(n.id);
      const a = forced ? 1 : (focus ? fade * DIM : fade);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      const label = n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label;
      ctx.fillText(label, sx(n), sy(n) + n.r * cam.zoom + 3);
    }
    ctx.globalAlpha = 1;
  }
}

// グラフを組み直す。月が変わったときだけレイアウトを取り直す。
// ── frame loop ───────────────────────────────────────────────────────────────
// このアプリで唯一の継続的な rAF。回りっぱなしは PWA のバッテリーを直接削るので、
// 止まる経路を4つ持つ:
//   1. alpha が収束したら自分で止まる（最後のフレームは canvas に残る）
//   2. タブが裏に回ったら止まる（visibilitychange）
//   3. グラフ以外のビューへ移ったら止まる（switchView から）
//   4. 収束後のホバー等は単発フレームを1枚だけ予約する（ループは回さない）
function _graphStopLoop() {
  if (_graphRaf != null) { cancelAnimationFrame(_graphRaf); _graphRaf = null; }
}

// 予約されるフレームはこの1種類だけ。「ループの1コマ」と「単発の描き直し」を
// 別の関数に分けると、_graphRaf を奪い合って事故る: 単発が予約済みのときに
// リヒートが来ると _graphStartLoop が「もう予約がある」と諦め、単発は1枚描いて
// 終わるのでループが二度と回らず、alpha だけ上がってレイアウトが凍る。
// 分岐を予約時ではなく実行時に置けば、フレームは自分が走る瞬間の状態を見て
// 続けるか止まるかを決められる。
function _graphFrame() {
  _graphRaf = null;
  if (currentView !== 'graph' || document.hidden) return;    // 経路 2・3
  const running = _graphSim && !graphForce.isSettled(_graphSim);
  if (running) graphForce.tick(_graphSim);
  _graphDraw();
  if (running && !graphForce.isSettled(_graphSim)) {
    _graphRaf = requestAnimationFrame(_graphFrame);           // 続ける
  }
  // 収束済み = 経路 4（1枚描いて終わり）／収束した = 経路 1
}

function _graphStartLoop() {
  if (_graphRaf != null) return;                              // 二重起動しない
  if (currentView !== 'graph' || document.hidden) return;
  _graphRaf = requestAnimationFrame(_graphFrame);
}

// 収束後に1枚だけ描き直す（ホバー・パン・ズーム用）。alpha を上げないので
// _graphFrame は running=false で走り、1枚描いて止まる。
function requestGraphRedraw() { _graphStartLoop(); }

// ドラッグ・データ変更・リサイズ・月移動でレイアウトを温め直す。
function _graphReheat(to) {
  if (!_graphSim) return;
  graphForce.reheat(_graphSim, to);
  _graphStartLoop();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) _graphStopLoop();                      // 経路 2
  else if (currentView === 'graph' && _graphSim && !graphForce.isSettled(_graphSim)) _graphStartLoop();
});

// サイドバー開閉・画面回転・ツールバーの出入りでキャンバスの寸法が変わる。
// display:none の間は 0x0 が来るので、そのときは何もしない。
(function initGraphResizeObserver() {
  const view = document.getElementById('js-graph-view');
  if (!view || typeof ResizeObserver === 'undefined') return;
  let last = { w: 0, h: 0 };
  new ResizeObserver(entries => {
    const r = entries[0].contentRect;
    if (r.width === 0 || r.height === 0) return;              // 非表示
    if (Math.round(r.width) === last.w && Math.round(r.height) === last.h) return;
    last = { w: Math.round(r.width), h: Math.round(r.height) };
    if (currentView !== 'graph') return;
    requestGraphRedraw();
  }).observe(view);
})();

function renderGraphView() {
  const view = document.getElementById('js-graph-view');
  if (!view) return;

  // グラフは月ではなく「今日から7日間」を描く（ユーザー要望「その日から7日以内の
  // 予定だけを表示して」）。起点は今日に固定なので、月を送ってもグラフは変わらない
  // ——意図した挙動で、curDate には依存しない。
  const start = _todayStrLocal();
  const windowChanged = _graphWindow !== start || !_graphData;

  // 作り直す前に今の座標を控える。データが変わるたびに buildGraph が新しい
  // ノードを作り、createSim の initLayout が x/y を上書きするので、そのままだと
  // 予定のタイトルを1文字直しただけでグラフ全体が別の配置に飛ぶ。
  const prev = new Map((_graphSim ? _graphSim.nodes : []).map(n => [n.id, n]));

  _graphData = graphModel.buildGraph({
    start: start,
    days: 7,
    events: events,
    categories: categories,
    tasks: (typeof _taskState !== 'undefined' && _taskState) ? _taskState.tasks : [],
    // 今日の予定・タスクを今日の日付ノードに引き寄せる。モデルは壁時計を読まない
    // ので（読むとテストが時計依存になる）、呼ぶ側が今日を渡す。
    today: start,
  });
  _graphWindow = start;
  _graphSim = graphForce.createSim(_graphData);
  _graphHover = null;                 // 古い id は消えているかもしれない
  _graphDrag = null;

  if (!windowChanged) {
    // 見覚えのある点は元の場所に戻す。新顔だけが phyllotaxis の初期位置から
    // 動き出し、リヒートで周りが少しずれて馴染む。
    for (const n of _graphSim.nodes) {
      const p = prev.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; }
    }
  }

  const s = _graphResize();
  if (windowChanged) {
    // 新しい窓（＝日付が変わった／初回）は落ち着いた状態から見せたい（ノードが
    // 飛び回るのを見せない）。190ノードでも実測 16ms なので、同期で収束させて
    // から1枚描く。
    graphForce.settle(_graphSim);
    if (s) {
      // 今日（pinned）を画面のちょうど中央に置く。力学は今日を原点に held する
      // が、周りの塊が非対称だと外接矩形の中心は原点からずれるので、中心を明示
      // して渡す。今日が無い窓（あり得ないが）は従来どおり全体を中央に。
      const today = _graphData.nodes.find(n => n.pinned);
      _graphCam = graphForce.fitToView(
        _graphData.nodes, s.w, s.h, undefined,
        today ? { x: today.x, y: today.y } : undefined
      );
    }
    _graphDraw();
  } else {
    // 同じ窓の中の変更（予定を編集した等）は、その場から動かして馴染ませる。
    _graphReheat(0.3);
    _graphDraw();
  }
}

// ── interaction ──────────────────────────────────────────────────────────────
// Pointer Events で統一する（このアプリで初）。iOS のピンチを gesturestart で
// 取れないのは、アプリ全体が拡大抑止のために preventDefault しているため
// （initPinchGuard）。なのでアクティブなポインタを自分で Map に持ち、
// 2点になったら距離比でズームする。canvas の touch-action:none が前提で、
// これが無いとブラウザがスクロールと判断した時点で pointermove が来なくなる。

// ノードを開く。Obsidian のグラフと同じで、点はその対象への入口。
function openGraphNode(n) {
  if (!n) return;
  if (n.kind === 'date') {
    const [y, m, d] = n.key.split('-').map(Number);
    switchView('day', { date: new Date(y, m - 1, d) });
  } else if (n.kind === 'event') {
    openEditModal(n.ref, n.key);          // G0 で日付を引数で渡せるようにした
  } else if (n.kind === 'task') {
    switchView('task');
  } else if (n.kind === 'cat') {
    openSettings('cat');
  }
}

(function initGraphInteraction() {
  const cv = _graphCanvas();
  if (!cv) return;

  // 6px 未満の移動はクリック。マウスの慣習は5px、指のぶれは8px 前後なので
  // その間。既存のスワイプ閾値50px（サイドバー・パネル移動）とは無関係。
  const CLICK_SLOP = 6;
  const HIT_SLOP = 6;                     // 指で小さい点を掴めるようにする余白

  let mode = null;                        // 'node' | 'pan' | 'pinch' | null
  let downX = 0, downY = 0, moved = 0;
  let panFrom = null, pinchFrom = null;

  const local = e => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nodeAt = p => {
    if (!_graphData) return null;
    const w = graphForce.screenToWorld(_graphCam, p.x, p.y);
    // 当たり判定の余白は world 単位。引くほど点は小さく見えるので、
    // 見た目6px 相当になるようズームで割る。
    return graphModel.hitTest(_graphData.nodes, w.x, w.y, HIT_SLOP / _graphCam.zoom);
  };
  const setHover = id => {
    if (id === _graphHover) return;
    _graphHover = id;
    cv.style.cursor = id ? 'pointer' : '';
    requestGraphRedraw();
  };
  const dropDrag = () => {
    if (!_graphDrag) return;
    _graphDrag.fixed = false;             // 物理に返す
    _graphDrag = null;
    _graphReheat(0.3);
  };

  cv.addEventListener('pointerdown', e => {
    if (currentView !== 'graph') return;
    _graphPointers.set(e.pointerId, local(e));
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}

    if (_graphPointers.size === 2) {
      const [a, b] = [..._graphPointers.values()];
      pinchFrom = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: _graphCam.zoom };
      dropDrag();                         // 2本目が乗ったらドラッグは畳む
      mode = 'pinch';
      return;
    }
    if (_graphPointers.size > 2) return;

    const p = local(e);
    downX = p.x; downY = p.y; moved = 0;
    const n = nodeAt(p);
    if (n) {
      _graphDrag = n;
      n.fixed = true;
      setHover(n.id);                     // 指では pointermove が無いので掴んだ時に光らせる
      mode = 'node';
      _graphReheat(0.3);
    } else {
      mode = 'pan';
      panFrom = { x: p.x, y: p.y, tx: _graphCam.tx, ty: _graphCam.ty };
    }
  });

  cv.addEventListener('pointermove', e => {
    const p = local(e);
    if (_graphPointers.has(e.pointerId)) _graphPointers.set(e.pointerId, p);

    if (mode === 'pinch') {
      if (_graphPointers.size < 2 || !pinchFrom || pinchFrom.dist <= 0) return;
      const [a, b] = [..._graphPointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const want = graphForce.clampZoom(pinchFrom.zoom * (d / pinchFrom.dist));
      _graphCam = graphForce.zoomAt(_graphCam, mid.x, mid.y, want / _graphCam.zoom);
      requestGraphRedraw();
      return;
    }

    if (mode !== null) moved = Math.max(moved, Math.hypot(p.x - downX, p.y - downY));

    if (mode === 'node' && _graphDrag) {
      const w = graphForce.screenToWorld(_graphCam, p.x, p.y);
      _graphDrag.x = w.x; _graphDrag.y = w.y;
      _graphDrag.vx = 0; _graphDrag.vy = 0;
      _graphReheat(0.3);                  // 掴んでいる間は周りが追従し続ける
    } else if (mode === 'pan' && panFrom) {
      _graphCam = { zoom: _graphCam.zoom, tx: panFrom.tx + (p.x - panFrom.x), ty: panFrom.ty + (p.y - panFrom.y) };
      requestGraphRedraw();
    } else if (mode === null) {
      setHover(nodeAt(p)?.id ?? null);
    }
  });

  const release = e => {
    _graphPointers.delete(e.pointerId);
    try { if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId); } catch (_) {}
  };

  cv.addEventListener('pointerup', e => {
    const wasMode = mode;
    const hit = _graphDrag;
    const wasClick = moved < CLICK_SLOP;
    release(e);
    dropDrag();
    if (_graphPointers.size === 0) { mode = null; panFrom = null; pinchFrom = null; }
    else if (mode === 'pinch') return;    // まだ指が残っている

    // 指はホバーを残さない（マウスは動かせば pointermove が消してくれる）
    if (e.pointerType !== 'mouse') setHover(null);

    if (!wasClick || wasMode === 'pinch') return;
    if (wasMode === 'node' && hit) openGraphNode(hit);
  });

  cv.addEventListener('pointercancel', e => {
    release(e);
    dropDrag();
    if (_graphPointers.size === 0) { mode = null; panFrom = null; pinchFrom = null; }
  });

  cv.addEventListener('pointerleave', () => { if (mode === null) setHover(null); });

  // ホイールズーム。カーソルの下の点を動かさない。passive:false でないと
  // preventDefault が効かず、ページごとスクロールする。
  cv.addEventListener('wheel', e => {
    if (currentView !== 'graph') return;
    e.preventDefault();
    const p = local(e);
    _graphCam = graphForce.zoomAt(_graphCam, p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    requestGraphRedraw();
  }, { passive: false });
})();
