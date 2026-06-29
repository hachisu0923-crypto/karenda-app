// Bootstrap script — moved out of an inline <script> in index.html so that a
// strict Content-Security-Policy can forbid inline scripts (script-src 'self').

// Service Worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(function (err) {
    console.warn('SW registration failed:', err);
  });
}

// Copy-friendly readonly fields: select-all on click.
// (Replaces inline onclick="this.select()" which a strict CSP would block.)
['js-jcb-userid', 'js-jcb-url'].forEach(function (id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener('click', function () { this.select(); });
});
