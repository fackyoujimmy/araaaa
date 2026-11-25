'use strict';
// Standalone edition: the page runs on an ordinary web host, without Claude. This file stands in for the few things the
// Claude page runtime used to provide: saving files, "install as app", and the offline service worker.
// Data lives in this browser (IndexedDB) unless a shared database (Supabase) is connected in Settings; the Claude helper is not available here.
(function () {
  if (window.claude) return; // opened inside Claude: nothing to do
  window.__STANDALONE = true;
  document.documentElement.classList.add('sa');
  let deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', function () { deferred = null; });
  const isInstalled = function () { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; };
  const downloads = {
    save: async function (req) {
      const filename = (req && req.filename) || 'file'; const data = req && req.data;
      const type = /\.json$/i.test(filename) ? 'application/json' : /\.xlsx$/i.test(filename) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream';
      const blob = data instanceof Blob ? data : new Blob([data], { type: type });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return { status: 'saved' };
    },
  };
  const desktop = {
    install: {
      state: async function () { return isInstalled() ? 'installed' : deferred ? 'available' : 'unavailable'; },
      request: async function () {
        if (!deferred) return 'unavailable';
        deferred.prompt(); const r = await deferred.userChoice; deferred = null; return r && r.outcome === 'accepted' ? 'installed' : 'dismissed';
      },
    },
  };
  // Shared database (Supabase), switched on in Settings. The connection details live in this browser only.
  let sb = null, cfg = null;
  try { cfg = JSON.parse(localStorage.getItem('arahet.shared') || 'null'); } catch (e) { cfg = null; }
  if (cfg && window.SBDB && SBDB.normUrl(cfg.url) && !SBDB.keyProblem(cfg.key) && String(cfg.code || '').length >= 10) {
    let poll = 0; try { poll = +localStorage.getItem('arahet.poll') || 0; } catch (e) { poll = 0; } // hidden option, used by the tests
    sb = SBDB.create(cfg, poll ? { pollMs: poll, hiddenMs: poll * 3 } : {}); window.__SB = sb; window.__SB_CFG = { url: SBDB.normUrl(cfg.url), key: SBDB.cleanKey(cfg.key), code: String(cfg.code) };
  }
  try { // invitation link: .../#join=...  (address and public key; the access code is told separately)
    if (/^#join=/.test(location.hash) && window.SBDB) { const j = SBDB.parseJoin(location.hash); if (j) window.__JOIN = j; history.replaceState(null, '', location.pathname + location.search); }
  } catch (e) { /* ignore */ }
  window.claude = { use: async function (name) { return name === 'downloads' ? downloads : name === 'desktop' ? desktop : name === 'db' && sb ? sb.db : null; } };
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is optional */ }); });
  }
})();
