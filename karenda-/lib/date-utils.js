'use strict';
// Pure, side-effect-free date helpers shared by the web app and the Node tests.
// Loaded in the browser as a classic <script> (attaches to window) and required
// by tests/date-utils.test.js in Node (module.exports). No DOM / Supabase deps.
(function (root) {

  // Shift `date` by `delta` whole months, clamped to the 1st of the month so a
  // month-end day can never overflow into the wrong month.
  // (e.g. setMonth on Jan 31 + 1 would yield "Feb 31" -> rolls to Mar; this
  //  forces day=1 first, so the result is February as the user expects.)
  function shiftMonthDate(date, delta) {
    return new Date(date.getFullYear(), date.getMonth() + delta, 1);
  }

  // 'YYYY-MM-DD' (or 'YYYY-MM-DDT...') -> 'YYYY-MM'. Blank/invalid -> '' so the
  // caller can fall back. Used to file a budget entry under its OWN month.
  function monthKeyFromDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    return dateStr.slice(0, 7);
  }

  var api = { shiftMonthDate: shiftMonthDate, monthKeyFromDate: monthKeyFromDate };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node (tests)
  } else {
    root.shiftMonthDate = shiftMonthDate;     // browser global
    root.monthKeyFromDate = monthKeyFromDate;
  }

})(typeof window !== 'undefined' ? window : globalThis);
