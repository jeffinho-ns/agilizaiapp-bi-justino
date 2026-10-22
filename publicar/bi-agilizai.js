(function () {
  var BAR_ID = 'biAgilizaiBar';
  var INTERVAL_MS = 60000;
  var started = false;

  function apiBase() {
    var host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:3001';
    return 'https://api.agilizaiapp.com.br';
  }

  function ensureBar() {
    var bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'box-sizing:border-box',
      'flex:1 0 100%',
      'width:100%',
      'margin:0 0 12px',
      'padding:7px 12px',
      'border-radius:8px',
      'background:#14110e',
      'border:1px solid #332b24',
      'color:#a39686',
      'font:500 12px/1.4 "Plus Jakarta Sans",Arial,sans-serif',
      'letter-spacing:.01em'
    ].join(';');
    var header = document.querySelector('header');
    var parent = header || document.body;
    if (!parent) return null;
    parent.insertBefore(bar, parent.firstChild);
    return bar;
  }

  function show(text) {
    try {
      var bar = ensureBar();
      if (bar) bar.textContent = text;
    } catch (e) {}
  }

  function asCount(value) {
    if (typeof value === 'boolean' || value == null) return null;
    var n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!isFinite(n) || n < 0) return null;
    return String(Math.round(n));
  }

  function refresh() {
    var url = apiBase() + '/api/bi/justino/resumo';
    fetch(url, { method: 'GET', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('status');
        return res.json();
      })
      .then(function (data) {
        var reservations = data && data.reservations;
        var total = asCount(reservations && reservations.total);
        var people = asCount(reservations && reservations.people);
        if (total == null || people == null) throw new Error('shape');
        show('Agilizai · reservas de hoje: ' + total + ' · ' + people + ' pessoas');
      })
      .catch(function () {
        show('Agilizai · reservas indisponíveis agora');
      });
  }

  function start() {
    if (started) return;
    started = true;
    try {
      show('Agilizai · reservas de hoje: …');
      refresh();
      setInterval(function () {
        try { refresh(); } catch (e) { show('Agilizai · reservas indisponíveis agora'); }
      }, INTERVAL_MS);
    } catch (e) {
      show('Agilizai · reservas indisponíveis agora');
    }
  }

  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) {}
})();
