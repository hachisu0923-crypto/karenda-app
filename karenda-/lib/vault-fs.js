'use strict';
// File System Access wrapper: pick an Obsidian vault folder once, remember it,
// and read/write .md files in it afterwards.
//
// Loaded in the browser as a classic <script>. Unlike the other lib/* modules
// this one is NOT pure — it touches showDirectoryPicker and IndexedDB — so it
// has no node --test counterpart; the serialisers it feeds are tested instead.
//
// Availability:
//   Electron  — works. Verified in desktop/shell.html's same-origin iframe:
//               the API is reachable with the existing allow list, 127.0.0.1 is
//               a secure context, and only a user gesture is required.
//   Chrome/Edge desktop — works.
//   iOS Safari / Firefox — showDirectoryPicker does not exist. Callers must
//               feature-detect with isSupported() and hide the UI; an iOS vault
//               lives in iCloud, where "pick a local folder" has no meaning.
//
// The directory handle is stored in IndexedDB (it is a structured-cloneable
// object; localStorage cannot hold it).
(function (root) {

  var DB_NAME = 'karenda-vault';
  var STORE = 'handles';
  var KEY = 'vaultDir';

  function isSupported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function idbSet(key, val) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDel(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // Must be called from a click — the picker needs a user gesture.
  function pickVault() {
    if (!isSupported()) return Promise.reject(new Error('unsupported'));
    return window.showDirectoryPicker({ id: 'karenda-vault', mode: 'readwrite' })
      .then(function (handle) {
        return idbSet(KEY, handle).then(function () { return handle; });
      });
  }

  function getSavedVault() {
    if (!isSupported()) return Promise.resolve(null);
    return idbGet(KEY).catch(function () { return null; });
  }

  function forgetVault() { return idbDel(KEY); }

  // Permission does not survive a restart; it has to be re-requested, and that
  // request also needs a user gesture. Returns 'granted' | 'prompt' | 'denied'.
  function checkPermission(handle, request) {
    if (!handle || !handle.queryPermission) return Promise.resolve('denied');
    var opts = { mode: 'readwrite' };
    return handle.queryPermission(opts).then(function (state) {
      if (state === 'granted' || !request) return state;
      return handle.requestPermission(opts);
    });
  }

  // Ensure a directory exists under `dir`, creating it if asked.
  function dir(handle, name, create) {
    return handle.getDirectoryHandle(name, { create: !!create });
  }

  function writeFile(dirHandle, fileName, text) {
    return dirHandle.getFileHandle(fileName, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return w.write(text).then(function () { return w.close(); }); });
  }

  function readFile(dirHandle, fileName) {
    return dirHandle.getFileHandle(fileName, { create: false })
      .then(function (fh) { return fh.getFile(); })
      .then(function (f) { return f.text(); })
      .catch(function () { return null; });   // missing file is not an error here
  }

  // List *.md names directly under dirHandle.
  function listMarkdown(dirHandle) {
    var out = [];
    return (async function () {
      for await (var entry of dirHandle.values()) {
        if (entry.kind === 'file' && /\.md$/i.test(entry.name)) out.push(entry.name);
      }
      return out.sort();
    })();
  }

  var api = {
    isSupported: isSupported,
    pickVault: pickVault,
    getSavedVault: getSavedVault,
    forgetVault: forgetVault,
    checkPermission: checkPermission,
    dir: dir,
    writeFile: writeFile,
    readFile: readFile,
    listMarkdown: listMarkdown,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.vaultFs = api;

})(typeof window !== 'undefined' ? window : globalThis);
