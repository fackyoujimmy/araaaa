'use strict';
// Storage layer: shared database (artifact db capability) + local mirror for offline work.
// Data model in the db:  chunks/cNNN = { orgs: { M0001: { field: value, ..., acts: { aID: {ts,type,text} } } } }  (20 orgs per doc)
//                        meta/settings = custom statuses etc.     data/users/<uid>/prefs = the viewer's own UI preferences
// Every edit is a per-field patch (nested merge), so two people editing different fields of one organization never overwrite each other.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CRMSTORE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CHUNK = 20;
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return v === undefined ? 'u' : JSON.stringify(v);
  }
  const eq = (a, b) => stable(a) === stable(b);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const SKIP = new Set(['activities', 'rel', 'acts', 'id']);
  const actCmp = (a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  // ---- organization <-> canonical (db) form ----
  function canonOrg(c) {
    const o = {};
    for (const k of Object.keys(c)) {
      if (k[0] === '_' || SKIP.has(k)) continue;
      const v = c[k]; if (v === undefined || v === null || v === '') continue; o[k] = v;
    }
    const acts = {}; let n = 0;
    for (const a of c.activities || []) { if (!a || !a.id) continue; acts[a.id] = { ts: a.ts || '', type: a.type || 'note', text: a.text || '' }; if (a.by) acts[a.id].by = String(a.by); n++; }
    if (n) o.acts = acts;
    return o;
  }
  function normRemote(o) { const r = clone(o) || {}; delete r.id; if (r.acts && !Object.keys(r.acts).length) delete r.acts; return r; }
  function orgFromCanon(id, o) {
    const c = { id };
    for (const k of Object.keys(o)) if (k !== 'acts') c[k] = clone(o[k]);
    c.activities = Object.keys(o.acts || {}).map(i => Object.assign({ id: i }, o.acts[i])).sort(actCmp);
    return c;
  }
  function applyCanonInto(c, canon) {
    for (const k of Object.keys(c)) { if (k === 'id' || k === 'activities') continue; if (k[0] === '_' || !(k in canon) || k === 'acts') delete c[k]; }
    for (const k of Object.keys(canon)) if (k !== 'acts') c[k] = clone(canon[k]);
    c.activities = Object.keys(canon.acts || {}).map(i => Object.assign({ id: i }, canon.acts[i])).sort(actCmp);
  }
  const chunkOf = id => { const m = /^M(\d+)$/.exec(id || ''); return m ? 'c' + String(Math.floor((parseInt(m[1], 10) - 1) / CHUNK)).padStart(3, '0') : 'c999'; };

  // ---- pure helpers: three-way merge and patch ----
  function merge3(b, r, l, stat) {
    if (eq(l, b)) return clone(r);
    if (eq(r, b) || eq(r, l)) return clone(l);
    if (isObj(l) && isObj(r) && (isObj(b) || b === undefined)) {
      const out = {};
      for (const k of new Set([...Object.keys(b || {}), ...Object.keys(r), ...Object.keys(l)])) { const v = merge3(b && b[k], r[k], l[k], stat); if (v !== undefined) out[k] = v; }
      return Object.keys(out).length ? out : undefined;
    }
    if (stat) stat.conflicts++;
    return clone(l);
  }
  function patchDeep(base, cur) {
    base = base || {}; const p = {}; let n = 0;
    for (const k of new Set([...Object.keys(base), ...Object.keys(cur)])) {
      const b = base[k], c = cur[k];
      if (isObj(b) && isObj(c)) { const sub = patchDeep(b, c); if (sub) { p[k] = sub; n++; } }
      else if (!eq(b, c)) { p[k] = c === undefined ? { __delete__: true } : clone(c); n++; }
    }
    return n ? p : null;
  }

  // ---- settings <-> canonical ----
  const hex = s => { let o = 'n'; const u = unescape(encodeURIComponent(s)); for (let i = 0; i < u.length; i++) o += u.charCodeAt(i).toString(16).padStart(2, '0'); return o; };
  function canonSettings(s) {
    const o = {};
    ['customMail', 'customCall', 'team'].forEach(k => { const m = {}; (s[k] || []).forEach((n, i) => { m[hex(n)] = { n, o: i + 1 }; }); if (Object.keys(m).length) o[k] = m; });
    if (s.lastCampaign) o.lastCampaign = s.lastCampaign;
    if (s.about) o.about = s.about;
    return o;
  }
  function settingsFromCanon(o) {
    const out = { customMail: [], customCall: [], team: [], lastCampaign: '', about: '' };
    ['customMail', 'customCall', 'team'].forEach(k => { out[k] = Object.values((o && o[k]) || {}).filter(x => x && x.n).sort((a, b) => a.o - b.o || (a.n < b.n ? -1 : 1)).map(x => x.n); });
    out.lastCampaign = (o && o.lastCampaign) || ''; out.about = (o && o.about) || '';
    return out;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

  function createStore(env) {
    const C = env.C; const mirror = env.mirror || null; const debounce = env.debounce == null ? 500 : env.debounce;
    const st = { mode: 'connecting', conn: 'connecting', canWrite: true, isOwner: false, uid: null, remoteEmpty: false, persist: !!mirror, pending: 0, total: 0, last: '', err: '', synced: false };
    const companies = [], byId = new Map();
    const settings = { customMail: [], customCall: [], team: [], lastCampaign: '', about: '' };
    let shadow = new Map(), shadowSettings = {}, chunkDocs = new Set(), db = null, claude = null, flushing = false, again = false, flushTimer = null, mirrorTimer = null, retryTimer = null, retries = 0, unsub = [];
    const listeners = {};
    const on = (e, f) => { (listeners[e] = listeners[e] || []).push(f); };
    const emit = (e, a) => (listeners[e] || []).forEach(f => { try { f(a); } catch (x) { if (typeof console !== 'undefined') console.error(x); } });
    const nowIso = () => new Date().toISOString();

    // ----- local bookkeeping -----
    function reindex() { byId.clear(); companies.forEach(c => { if (!Array.isArray(c.activities)) c.activities = []; byId.set(c.id, c); }); }
    function add(c) { if (!Array.isArray(c.activities)) c.activities = []; companies.push(c); byId.set(c.id, c); }
    function remove(id) { const c = byId.get(id); if (!c) return; byId.delete(id); const i = companies.indexOf(c); if (i >= 0) companies.splice(i, 1); }
    function diffs() {
      const out = []; // {id, cur|null, base|undefined}
      for (const c of companies) { const cur = canonOrg(c), base = shadow.get(c.id); if (!base || !eq(cur, base)) out.push({ id: c.id, cur, base }); }
      for (const id of shadow.keys()) if (!byId.has(id)) out.push({ id, cur: null, base: shadow.get(id) });
      return out;
    }
    const settingsDirty = () => !eq(canonSettings(settings), shadowSettings);

    // ----- mirror (offline copy) -----
    function persistNow() {
      if (!mirror) return Promise.resolve();
      const dirty = {}, del = [];
      for (const d of diffs()) { if (d.cur) dirty[d.id] = d.cur; else del.push(d.id); }
      return Promise.resolve(mirror.save({ v: 1, savedAt: nowIso(), shadow: Object.fromEntries(shadow), dirty, deleted: del, settings: canonSettings(settings), shadowSettings, chunkDocs: [...chunkDocs] })).then(() => { st.persist = true; }, () => { st.persist = false; });
    }
    function persistSoon() { if (!mirror) return; clearTimeout(mirrorTimer); mirrorTimer = setTimeout(persistNow, 1200); }
    async function restoreMirror() {
      if (!mirror) return false;
      let m = null; try { m = await mirror.load(); } catch (e) { m = null; }
      if (!m || m.v !== 1 || !m.shadow) return false;
      shadow = new Map(Object.entries(m.shadow)); shadowSettings = m.shadowSettings || {}; chunkDocs = new Set(m.chunkDocs || []);
      companies.length = 0; byId.clear();
      for (const [id, o] of shadow) add(orgFromCanon(id, o));
      for (const id of m.deleted || []) remove(id);
      for (const [id, o] of Object.entries(m.dirty || {})) { const ex = byId.get(id); if (ex) applyCanonInto(ex, o); else add(orgFromCanon(id, o)); }
      Object.assign(settings, settingsFromCanon(m.settings || {}));
      return companies.length > 0;
    }

    // ----- writing -----
    function computePlan() {
      const byChunk = new Map(); let n = 0;
      for (const d of diffs()) {
        const ch = chunkOf(d.id); let g = byChunk.get(ch); if (!g) { g = { id: ch, patch: {}, full: {}, items: [] }; byChunk.set(ch, g); }
        if (d.cur) { const p = d.base ? patchDeep(d.base, d.cur) : clone(d.cur); if (!p) continue; g.patch[d.id] = p; g.full[d.id] = clone(d.cur); g.items.push({ id: d.id, cur: d.cur }); }
        else { g.patch[d.id] = { __delete__: true }; g.items.push({ id: d.id, cur: null }); }
        n++;
      }
      return { chunks: [...byChunk.values()].filter(g => g.items.length), n };
    }
    const errCode = e => (e && (e.code || e.message)) || String(e);
    async function writeChunk(g) {
      // Always try the merge-update first: it never touches other organizations in the document. Only when the document does not exist yet (invalid_argument) is it created.
      const ref = db.doc('chunks/' + g.id);
      const onlyDeletes = g.items.every(i => !i.cur);
      try { await ref.update({ orgs: g.patch }); chunkDocs.add(g.id); return; }
      catch (e) { if (errCode(e) !== 'invalid_argument') throw e; chunkDocs.delete(g.id); }
      if (onlyDeletes) return;
      await ref.set({ orgs: g.full }); chunkDocs.add(g.id);
    }
    async function flush() {
      clearTimeout(flushTimer);
      if (flushing) { again = true; return; }
      flushing = true;
      try {
        do {
          again = false;
          const plan = computePlan(); const sDirty = settingsDirty();
          st.pending = plan.n + (sDirty ? 1 : 0);
          if (!st.pending) { if (st.conn === 'saving') st.conn = 'ok'; break; }
          if (st.mode === 'db' && !st.synced) { st.conn = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'connecting'; emit('status'); break; } // wait for the first confirmed read
          if (st.mode !== 'db') { // local mode: commit to the mirror only
            for (const g of plan.chunks) for (const it of g.items) { if (it.cur) shadow.set(it.id, clone(it.cur)); else shadow.delete(it.id); }
            shadowSettings = canonSettings(settings); st.pending = 0; st.last = nowIso(); st.conn = 'local'; emit('status'); break;
          }
          if (!st.canWrite) { st.conn = 'readonly'; emit('status'); break; }
          st.conn = 'saving'; st.total = plan.chunks.length; emit('status');
          let failed = null;
          for (const g of plan.chunks) {
            let tries = 0;
            for (;;) {
              try { await writeChunk(g); break; }
              catch (e) { const c = errCode(e); if (c === 'resource_exhausted' && ++tries < 6) { await sleep(1500 * tries); continue; } failed = e; break; }
            }
            if (failed) break;
            for (const it of g.items) { if (it.cur) shadow.set(it.id, it.cur); else shadow.delete(it.id); }
            st.pending = Math.max(0, st.pending - g.items.length); emit('status');
            if (plan.chunks.length > 3) await sleep(120);
          }
          if (!failed && settingsDirty()) {
            try { await writeSettings(); } catch (e) { failed = e; }
          }
          if (failed) { retries++; st.err = (failed && failed.message) || errCode(failed); st.conn = (typeof navigator !== 'undefined' && navigator.onLine === false) || errCode(failed) === 'unavailable' ? 'offline' : 'error'; emit('status'); scheduleRetry(); break; }
          retries = 0; st.err = ''; st.last = nowIso(); st.pending = diffs().length; st.conn = st.pending ? 'saving' : 'ok';
          if (st.pending) again = true;
          emit('status');
        } while (again);
      } finally { flushing = false; persistSoon(); emit('status'); }
    }
    async function writeSettings() {
      const cur = canonSettings(settings); const ref = db.doc('meta/settings');
      const p = patchDeep(shadowSettings, cur); if (!p) return;
      try { await ref.update(p); }
      catch (e) { if (errCode(e) !== 'invalid_argument') throw e; await ref.set(cur); }
      shadowSettings = cur;
    }
    function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(() => flush(), Math.min(60000, 4000 * Math.pow(2, Math.min(retries, 4)))); }
    function schedule() { clearTimeout(flushTimer); st.pending = Math.max(st.pending, 1); if (st.conn === 'ok') st.conn = 'saving'; emit('status'); flushTimer = setTimeout(flush, debounce); persistSoon(); }

    // ----- remote -> local -----
    function applyRemote(remote, authoritative) {
      let changed = false; const stat = { conflicts: 0 };
      for (const [id, rc] of remote) {
        const base = shadow.get(id); if (base && eq(base, rc)) continue;
        const local = byId.get(id);
        if (!local) {
          if (!base) { add(orgFromCanon(id, rc)); shadow.set(id, rc); changed = true; }
          else { // we deleted it locally (pending); keep the deletion, the flush will delete it remotely too
            shadow.set(id, rc);
          }
          continue;
        }
        if (!base && local.createdAt !== rc.createdAt && (local.createdAt || rc.createdAt)) { // two people created the same id at once
          const taken = new Set([...byId.keys(), ...remote.keys()]); let mx = 0; taken.forEach(k => { const m = /^M(\d+)$/.exec(k); if (m) mx = Math.max(mx, +m[1]); });
          const nid = 'M' + String(mx + 1).padStart(4, '0'); byId.delete(id); local.id = nid; byId.set(nid, local);
          add(orgFromCanon(id, rc)); shadow.set(id, rc); emit('reid', { from: id, to: nid }); changed = true; continue;
        }
        const lc = canonOrg(local); const merged = merge3(base, rc, lc, stat) || {};
        if (!eq(merged, lc)) { applyCanonInto(local, merged); changed = true; }
        shadow.set(id, rc);
      }
      if (authoritative) {
        for (const id of [...shadow.keys()]) {
          if (remote.has(id)) continue;
          const local = byId.get(id);
          if (local && eq(canonOrg(local), shadow.get(id))) { remove(id); changed = true; }
          shadow.delete(id); // a locally edited org stays and is re-created by the next flush
        }
      }
      return { changed, conflicts: stat.conflicts };
    }
    function onChunks(qs) {
      const fromCache = !!(qs.metadata && qs.metadata.fromCache);
      const remote = new Map(); chunkDocs = new Set();
      qs.docs.forEach(d => { if (!d.exists) return; chunkDocs.add(d.id); const o = (d.data() || {}).orgs || {}; for (const id of Object.keys(o)) if (isObj(o[id])) remote.set(id, normRemote(o[id])); });
      if (fromCache && remote.size === 0 && companies.length) return; // nothing learned yet
      const first = !fromCache && !st.synced;
      const r = applyRemote(remote, !fromCache);
      if (!fromCache) { st.synced = true; st.remoteEmpty = remote.size === 0; if (st.conn !== 'saving' && st.conn !== 'readonly') { st.conn = 'ok'; st.err = ''; } if (!st.last) st.last = nowIso(); }
      emit('status'); if (r.changed || first) emit('data', r);
      if (r.changed) persistSoon();
      if (!fromCache && st.canWrite && (diffs().length || settingsDirty())) schedule(); // pending local edits (made offline) go out now
    }
    function onSettings(snap) {
      if (!snap.exists) { shadowSettings = {}; return; }
      const rc = clone(snap.data()) || {}; delete rc.v;
      const lc = canonSettings(settings); const merged = merge3(shadowSettings, rc, lc, null) || {};
      shadowSettings = rc;
      if (!eq(merged, lc)) { Object.assign(settings, settingsFromCanon(merged)); emit('settings'); persistSoon(); }
    }

    // ----- connect -----
    async function connect() {
      claude = env.getClaude ? env.getClaude() : null;
      for (let w = 0; !claude && w < (env.claudeWait === undefined ? 30 : env.claudeWait); w++) { await sleep(100); claude = env.getClaude ? env.getClaude() : null; } // the host may attach it a moment after the page starts
      db = null;
      if (claude && typeof claude.use === 'function') { try { db = await withTimeout(Promise.resolve(claude.use('db')), env.dbTimeout || 12000); } catch (e) { db = null; } }
      if (!db) { st.mode = 'local'; st.conn = 'local'; emit('status'); return false; }
      st.mode = 'db'; st.conn = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'connecting'; emit('status');
      try {
        const user = await withTimeout(Promise.resolve(claude.use('user')), 5000);
        if (user) { try { st.uid = await user.id(); } catch (e) { /* none */ } try { st.isOwner = !!(await user.isOwner()); } catch (e) { /* none */ } try { st.canWrite = (await user.can('data.write')) !== false; } catch (e) { /* none */ } }
      } catch (e) { /* identity is optional */ }
      const err = e => { st.err = (e && e.message) || errCode(e); st.conn = errCode(e) === 'revoked' ? 'error' : 'offline'; emit('status'); };
      unsub.push(db.collection('chunks').onSnapshot(onChunks, err));
      unsub.push(db.doc('meta/settings').onSnapshot(onSettings, err));
      setTimeout(() => { if (!st.synced && st.mode === 'db' && st.conn === 'connecting') { st.conn = 'offline'; emit('status'); } }, env.firstSnapshotTimeout || 10000);
      return true;
    }
    async function load() {
      const had = await restoreMirror();
      const ok = connect(); // not awaited by the caller: the UI starts with the local copy
      return { hadLocal: had, connecting: ok };
    }

    // ----- viewer preferences -----
    async function prefsRef() { return db && st.uid ? db.doc('data/users/' + st.uid + '/prefs') : null; }
    async function readPrefs() { const r = await prefsRef(); if (!r) return null; try { const s = await r.get(); return s.exists ? s.data() : null; } catch (e) { return null; } }
    async function writePrefs(p) { const r = await prefsRef(); if (!r) return false; try { await r.set(p); return true; } catch (e) { return false; } }

    function stop() { unsub.forEach(f => { try { f(); } catch (e) { /* ignore */ } }); unsub = []; clearTimeout(flushTimer); clearTimeout(mirrorTimer); clearTimeout(retryTimer); }
    return { st, companies, byId, settings, add, remove, reindex, schedule, flush, load, connect, persistNow, readPrefs, writePrefs, on, stop, diffs, restoreMirror, _applyRemote: applyRemote };
  }

  // ---- offline mirror in IndexedDB (falls back to localStorage, then to nothing) ----
  function makeMirror(scope, name) {
    const key = 'mirror'; const lsKey = (!name || name === 'arahet-crm') ? 'arahet.mirror' : 'arahet.mirror.' + name; // a separate copy for every database
    const idb = () => new Promise((res, rej) => {
      let rq; try { rq = scope.indexedDB.open(name || 'arahet-crm', 1); } catch (e) { return rej(e); }
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
    return {
      async load() {
        try { const d = await idb(); return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
        catch (e) { try { const s = scope.localStorage.getItem(lsKey); return s ? JSON.parse(s) : null; } catch (e2) { return null; } }
      },
      async save(obj) {
        try { const d = await idb(); await new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(obj, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return; } catch (e) { /* fall through */ }
        scope.localStorage.setItem(lsKey, JSON.stringify(obj));
      },
    };
  }

  return { createStore, makeMirror, canonOrg, orgFromCanon, applyCanonInto, normRemote, merge3, patchDeep, canonSettings, settingsFromCanon, chunkOf, stable, eq, CHUNK };
});
