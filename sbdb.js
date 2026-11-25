'use strict';
// Shared database for the standalone edition.
// A Firestore-like `db` (the same small interface the store already uses with the Claude page runtime) on top of the
// RPC functions from supabase-setup.sql. There is no push channel: the page asks a tiny "has anything changed?" function
// every few seconds and downloads only the documents that did.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SBDB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const hasDelete = v => isObj(v) && (v.__delete__ === true || Object.values(v).some(hasDelete));
  const err = (code, message, reason) => Object.assign(new Error(message || code), { code, reason: reason || code });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- what the person typed -> something we can use ----
  function normUrl(raw) {
    let s = String(raw || '').trim().replace(/^["'<]+|["'>]+$/g, ''); if (!s) return '';
    if (/^[a-z]{20}$/.test(s)) return 'https://' + s + '.supabase.co'; // a bare project reference
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let u; try { u = new URL(s); } catch (e) { return ''; }
    const m = /^\/dashboard\/project\/([a-z0-9]{10,30})/i.exec(u.pathname); // the address of the dashboard page, copied by mistake
    if (/(^|\.)supabase\.com$/i.test(u.hostname) && m) return 'https://' + m[1].toLowerCase() + '.supabase.co';
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !local) return '';
    return u.origin;
  }
  function cleanKey(raw) { return String(raw || '').replace(/["'\s]+/g, ''); }
  // The browser may only ever hold the public key. A secret key pasted here would be shown to everybody who opens the page.
  function keyProblem(raw) {
    const k = cleanKey(raw); if (!k) return 'empty'; if (k.length < 20) return 'short';
    if (/^sb_secret_/i.test(k)) return 'secret';
    if (/^eyJ/.test(k)) {
      const parts = k.split('.'); if (parts.length !== 3) return 'format';
      try { const p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))); if (p && p.role === 'service_role') return 'secret'; } catch (e) { return 'format'; }
    } else if (!/^sb_publishable_/i.test(k)) return 'format';
    return '';
  }
  // The invitation link never carries the access code. Only the owner's personal link (withCode = true) does, so that opening it needs one click.
  function makeJoin(cfg, withCode) { const o = { u: normUrl(cfg.url), k: cleanKey(cfg.key) }; if (withCode && cfg.code) o.c = String(cfg.code); const j = JSON.stringify(o); return btoa(j).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function parseJoin(str) {
    try { const s = String(str || '').replace(/^#?join=/, '').replace(/-/g, '+').replace(/_/g, '/'); const o = JSON.parse(atob(s + '='.repeat((4 - s.length % 4) % 4))); const url = normUrl(o.u), key = cleanKey(o.k); if (!(url && key) || keyProblem(key)) return null; const r = { url, key }; const c = String(o.c || ''); if (/^[A-Za-z0-9_-]{10,}$/.test(c)) r.code = c; return r; } catch (e) { return null; }
  }

  function create(cfg, env) {
    env = env || {};
    const base = normUrl(cfg.url), key = cleanKey(cfg.key), code = String(cfg.code || '');
    const fetchFn = env.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const pollMs = env.pollMs || 10000, hiddenMs = env.hiddenMs || 60000, timeoutMs = env.timeoutMs || 30000, batch = env.batch || 25;
    const headers = { 'Content-Type': 'application/json', apikey: key };
    if (/^eyJ/.test(key)) headers.Authorization = 'Bearer ' + key; // the new publishable keys are not JWTs and go in `apikey` only
    const stats = { rpc: 0, fn: {} };

    async function rpc(fn, args) {
      if (!base || !fetchFn) throw err('unavailable', 'Не задан адрес сервера', 'bad_url');
      stats.rpc++; stats.fn[fn] = (stats.fn[fn] || 0) + 1;
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; const to = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs);
      let res, text;
      try { res = await fetchFn(base + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(Object.assign({ p_code: code }, args || {})), signal: ctl ? ctl.signal : undefined }); text = await res.text(); }
      catch (e) { throw err('unavailable', 'Нет связи с сервером', 'network'); }
      finally { clearTimeout(to); }
      let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
      if (!res.ok) {
        const msg = (body && (body.message || body.error)) || '';
        if ((body && body.code === 'PGRST202') || /could not find the function/i.test(msg)) throw err('revoked', 'В базе не выполнен SQL-скрипт: функции crm_… не найдены', 'setup_missing');
        if (res.status === 401 || res.status === 403) throw err('revoked', 'Ключ не принят сервером', 'bad_key');
        if (res.status === 404) throw err('unavailable', 'Адрес не найден (проверьте Project URL)', 'bad_url');
        if (res.status === 429) throw err('resource_exhausted', 'Сервер просит подождать', 'busy');
        if (res.status >= 500) throw err('unavailable', 'Сервер временно недоступен (' + res.status + ')', 'server');
        throw err('bad_request', msg || ('Ошибка ' + res.status), 'bad_request');
      }
      if (body && typeof body === 'object' && body.error) {
        if (body.error === 'forbidden') throw err('revoked', 'Неверный код доступа', 'forbidden');
        if (body.error === 'missing') throw err('invalid_argument', 'missing', 'missing');
        throw err('bad_request', String(body.error), 'bad_request');
      }
      return body || {};
    }

    // ---- cache of the documents that someone is watching, and the polling loop ----
    const cache = new Map();            // path -> { data, version }
    const subs = new Set();
    let timer = null, running = false, again = false, lastSig = '', down = false, recovering = false, lastErr = '', stopped = false;
    let writeSeq = 0, inflight = 0;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const direct = (coll, p) => p.startsWith(coll + '/') && p.indexOf('/', coll.length + 1) < 0;
    const snapDoc = (path, ent) => ({ id: path.split('/').pop(), exists: !!ent, data: () => (ent ? clone(ent.data) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
    const snapColl = coll => {
      const docs = [...cache.keys()].filter(p => direct(coll, p)).sort().map(p => snapDoc(p, cache.get(p)));
      return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] };
    };
    const subSnap = s => (s.kind === 'doc' ? snapDoc(s.path, cache.get(s.path)) : snapColl(s.path));
    const subMatch = (s, p) => (s.kind === 'doc' ? s.path === p : direct(s.path, p));
    const safe = (f, a) => { try { f(a); } catch (e) { /* a faulty listener must not stop the sync */ } };

    function schedule(ms) {
      clearTimeout(timer); timer = null; if (stopped || !subs.size) return;
      const d = ms !== undefined ? ms : down ? (lastErr === 'revoked' ? 30000 : Math.min(30000, pollMs * 3)) : hidden() ? hiddenMs : pollMs;
      timer = setTimeout(sync, d); if (env.unref && timer && timer.unref) timer.unref();
    }
    async function sync() {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false; if (stopped || !subs.size) break;
          if (inflight) break; // our own write is on its way; the loop is started again when it ends
          const seq0 = writeSeq;
          const ping = await rpc('crm_ping'); const sig = ping.docs + ':' + ping.tick;
          const fresh = [...subs].some(s => !s.ready);
          if (sig === lastSig && !recovering && !fresh) { down = false; lastErr = ''; continue; }
          const vers = (await rpc('crm_versions')).v || {};
          const wanted = Object.keys(vers).filter(p => [...subs].some(s => subMatch(s, p)));
          const need = wanted.filter(p => !cache.has(p) || cache.get(p).version !== vers[p]);
          const got = new Map();
          for (let i = 0; i < need.length; i += batch) { const r = await rpc('crm_get_many', { p_paths: need.slice(i, i + batch) }); (r.docs || []).forEach(d => got.set(d.path, { data: d.data, version: d.version })); }
          if (writeSeq !== seq0 || inflight) { again = true; continue; } // something of ours was written while we were reading: this picture may be stale, take another
          const changed = [];
          for (const [p, e] of got) { cache.set(p, e); changed.push(p); }
          for (const p of need) if (!got.has(p) && cache.has(p)) { cache.delete(p); changed.push(p); }
          for (const p of [...cache.keys()]) if (!(p in vers) && [...subs].some(s => subMatch(s, p))) { cache.delete(p); changed.push(p); }
          lastSig = sig; const all = recovering; recovering = false; down = false; lastErr = '';
          for (const s of [...subs]) if (!s.ready || all || changed.some(p => subMatch(s, p))) { s.ready = true; safe(s.next, subSnap(s)); }
        } while (again);
      } catch (e) {
        const key2 = e.code + ':' + e.reason; down = true; recovering = true; lastErr = e.code;
        if (key2 !== lastErrKey) { lastErrKey = key2; for (const s of [...subs]) if (s.error) safe(s.error, e); }
      } finally { running = false; if (!down) lastErrKey = ''; schedule(); }
    }
    let lastErrKey = '';
    function kick(ms) { if (stopped || !subs.size) return; clearTimeout(timer); timer = setTimeout(sync, ms === undefined ? 250 : ms); if (env.unref && timer && timer.unref) timer.unref(); }
    function subscribe(kind, path, next, error) {
      const s = { kind, path, next, error, ready: false }; subs.add(s); kick(0);
      return () => { subs.delete(s); if (!subs.size) { clearTimeout(timer); timer = null; } };
    }
    async function write(fn) {
      inflight++; writeSeq++;
      try { return await fn(); } finally { inflight--; writeSeq++; if (!inflight) kick(300); }
    }

    // ---- the db surface ----
    function docRef(path) {
      if (path.split('/').length % 2) throw new TypeError('document path needs an even number of segments');
      return {
        id: path.split('/').pop(), path,
        async get() { const r = await rpc('crm_get_many', { p_paths: [path] }); const d = (r.docs || [])[0]; return snapDoc(path, d ? { data: d.data, version: d.version } : null); },
        async set(data) { if (!isObj(data)) throw err('invalid_argument', 'data must be an object'); if (hasDelete(data)) throw err('invalid_argument', '__delete__ in set'); await write(() => rpc('crm_set', { p_path: path, p_data: data })); },
        async update(patch) { if (!isObj(patch)) throw err('invalid_argument', 'patch must be an object'); await write(() => rpc('crm_patch', { p_path: path, p_patch: patch })); },
        async delete() { throw err('invalid_argument', 'delete is not supported'); },
        onSnapshot(next, error) { return subscribe('doc', path, next, error); },
        collection(sub) { return collRef(path + '/' + sub); },
      };
    }
    function collRef(path) {
      if (path.split('/').length % 2 === 0) throw new TypeError('collection path needs an odd number of segments');
      return {
        path,
        doc(id) { return docRef(path + '/' + (id || Math.random().toString(36).slice(2))); },
        async get() { const r = await rpc('crm_get_all', { p_prefix: path + '/' }); const docs = (r.docs || []).filter(d => direct(path, d.path)).sort((a, b) => (a.path < b.path ? -1 : 1)).map(d => snapDoc(d.path, { data: d.data, version: d.version })); return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } }; },
        onSnapshot(next, error) { return subscribe('coll', path, next, error); },
      };
    }
    const db = { doc: docRef, collection: collRef };
    const claude = { use: async name => (name === 'db' ? db : null) };

    const onVis = () => { if (!hidden()) kick(50); }, onNet = () => kick(50);
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVis);
    if (typeof window !== 'undefined' && window.addEventListener) { window.addEventListener('online', onNet); window.addEventListener('focus', onNet); }
    function stop() {
      stopped = true; clearTimeout(timer); subs.clear();
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVis);
      if (typeof window !== 'undefined' && window.removeEventListener) { window.removeEventListener('online', onNet); window.removeEventListener('focus', onNet); }
    }
    return { db, claude, stop, kick, stats, ping: () => rpc('crm_ping') };
  }

  // One-off connection check for the "connect" window: resolves { docs, tick } or throws an error with .reason
  async function check(cfg, env) {
    const bad = keyProblem(cfg.key); if (bad) throw err('revoked', 'Ключ не подходит', 'key_' + bad);
    if (!normUrl(cfg.url)) throw err('unavailable', 'Адрес не распознан', 'bad_url');
    if (String(cfg.code || '').length < 10) throw err('revoked', 'Код доступа слишком короткий', 'code_short');
    const c = create(cfg, Object.assign({}, env, { timeoutMs: (env && env.timeoutMs) || 15000 })); try { const r = await c.ping(); return { docs: r.docs, tick: r.tick }; } finally { c.stop(); }
  }
  return { create, check, normUrl, cleanKey, keyProblem, makeJoin, parseJoin };
});
