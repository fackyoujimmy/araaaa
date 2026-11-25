'use strict';
// Shared between main process, renderer and tests (UMD).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CRM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // key, Excel header (same as Master sheet), type
  const FIELDS = [
    ['id', 'ID'], ['company', 'Company (without legal form)'], ['hast', 'Hastavac', 'bool'], ['rel', 'Relationship', 'derived'], ['status', 'Status'], ['type', 'Type (contract)'],
    ['owner', 'Owner / CEO / contact person'], ['address', 'Address'], ['companyOrig', 'Company (original, Armenian)'], ['segment', 'Segment'], ['employees', 'Employees'],
    ['approach', 'Who to approach (prospect list)'], ['email', 'E-mail'], ['phone', 'Phone'], ['map', 'Yandex Maps', 'link'], ['website', 'Website', 'link'], ['hr', 'HR / careers / public entry'],
    ['firstContract', 'First contract date', 'date'], ['termination', 'Termination date', 'date'], ['machines', 'Coffee machine(s) (BTC_Sector)'], ['legalName', 'Full / legal name'],
    ['why', 'Why included (RU, as in source)'], ['notes', 'Notes (RU, as in source)'], ['queue', 'Queue'], ['contracts', 'Contracts', 'num'], ['contractNo', 'Contract No.'],
    ['taxId', 'Tax ID (BTC_Sector)'], ['contractLines', 'Contract lines (details)'], ['statusSource', 'Status source'], ['statusNote', 'Status note'], ['listedBy', 'Listed by user (24.11.2026)'],
    ['stReg', 'Status per register'], ['stBtc', 'Status per BTC_Sector'], ['stContracts', 'Status from contracts (final)'], ['stProspect', 'Prospect-list status'], ['offer', 'Offer format'],
    ['headsType', 'Employees: figure type'], ['dup', 'Possible duplicate (not merged)'], ['matchBasis', 'Match basis (register ↔ prospect list)'], ['prospectName', 'Name in prospect list'],
    ['addrProspect', 'Address per prospect list (if matched)'], ['dataSource', 'Data source (prospect list)'], ['sourceType', 'Source type'], ['responsible', 'Responsible'],
    ['nextContact', 'Next contact', 'date'], ['qualification', 'Qualification result'], ['addressOrig', 'Address (original / as published)'], ['refs', 'Source references'],
    ['myNotes', 'My notes'],
    ['mailStatus', 'Mailing status'], ['mailDate', 'Mailing date', 'date'], ['mailCampaign', 'Mailing campaign'], ['callStatus', 'Call status'], ['callDate', 'Call date', 'date'],
  ].map(([k, h, t]) => ({ k, h, t: t || 'text' }));
  const BY_HEADER = {}; FIELDS.forEach(f => { BY_HEADER[f.h] = f; });

  const STATUSES = [
    ['Active client', 'Работаем'], ['Not working', 'Работали раньше'], ['To confirm', 'Проверить: клиент сейчас или раньше?'], ['Important', 'Важно'], ['Contract', 'Договор'],
    ['Pilot', 'Пилот'], ['Offer', 'Предложение'], ['Tasting', 'Дегустация'], ['Meeting scheduled', 'Назначена встреча'], ['Contacted', 'Связались'], ['Needs contact', 'Нужен контакт'],
    ['In progress', 'В работе'], ['Qualified', 'Квалифицирован'], ['Call back', 'Перезвонить'], ['Later', 'Позже'], ['Not qualified', 'Не квалифицирован'], ['Not a fit', 'Не подходит'], ['Declined', 'Отказ'],
  ];
  const STATUS_RU = Object.fromEntries(STATUSES);
  const REL = [
    ['Working with', 'Работаем'], ['Worked before', 'Работали раньше'], ['Client now or before (to confirm)', 'Проверить'], ['Can work with (prospect)', 'Можем работать'], ['Not a fit', 'Не подходит'],
  ];
  const REL_RU = Object.fromEntries(REL);
  const REL_TO_STATUS = { 'Working with': 'Active client', 'Worked before': 'Not working', 'Client now or before (to confirm)': 'To confirm', 'Not a fit': 'Not a fit' };
  const PROSPECT_STATUSES = new Set(['Important', 'Contract', 'Pilot', 'Offer', 'Tasting', 'Meeting scheduled', 'Contacted', 'Needs contact', 'In progress', 'Qualified', 'Call back', 'Later', 'Not qualified']);
  const MAIL_STATUSES = ['Queued', 'Sent', 'Replied', 'Interested', 'Bounced', 'No e-mail', 'Declined'];
  const CALL_STATUSES = ['To call', 'Reached', 'No answer', 'Call back', 'Meeting set', 'Declined', 'Wrong number'];
  const CALL_QUEUE = ['To call', 'Call back', 'No answer'];
  const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  function emailsOf(c) { const m = String(c && c.email || '').match(EMAIL_RE); return m ? [...new Set(m.map(x => x.toLowerCase()))] : []; }
  const ACTIVITY_TYPES = [['call', 'Звонок'], ['meeting', 'Встреча'], ['email', 'E-mail'], ['tasting', 'Дегустация'], ['note', 'Заметка'], ['status', 'Статус']];
  const ACTIVITY_RU = Object.fromEntries(ACTIVITY_TYPES);

  function relOf(status) {
    if (status === 'Active client') return 'Working with';
    if (status === 'Not working') return 'Worked before';
    if (status === 'To confirm') return 'Client now or before (to confirm)';
    if (status === 'Not a fit' || status === 'Declined') return 'Not a fit';
    return 'Can work with (prospect)';
  }
  // Status that a Relationship value implies; for prospects keep the current prospect stage.
  function statusFromRel(rel, currentStatus, prospectStatus) {
    if (rel === 'Can work with (prospect)') {
      if (PROSPECT_STATUSES.has(currentStatus)) return currentStatus;
      return PROSPECT_STATUSES.has(prospectStatus) ? prospectStatus : 'Not qualified';
    }
    return REL_TO_STATUS[rel] || currentStatus;
  }
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const todayISO = () => iso(new Date());
  function addDaysISO(base, n) { const d = new Date(base + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); }
  const isISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const norm = s => String(s == null ? '' : s).toLowerCase();

  // ---- filtering / sorting (pure) ----
  function searchText(c) {
    return norm([c.id, c.company, c.owner, c.approach, c.email, c.phone, c.address, c.website, c.segment, c.legalName, c.companyOrig, c.prospectName, c.notes, c.why, c.myNotes, c.taxId, c.contractNo, c.responsible, c.mailCampaign].join(' \u0001 '));
  }
  function applyFilters(list, f) {
    const q = norm(f.q).trim();
    const terms = q ? q.split(/\s+/) : [];
    return list.filter(c => {
      if (terms.length) { const t = c._s || (c._s = searchText(c)); for (const w of terms) if (t.indexOf(w) < 0) return false; }
      if (f.rel && f.rel.length && f.rel.indexOf(relOf(c.status)) < 0) return false;
      if (f.status && c.status !== f.status) return false;
      if (f.type) { const ts = String(c.type || '').split(/;\s*/); if (f.type === '__none__' ? String(c.type || '') !== '' : ts.indexOf(f.type) < 0) return false; }
      if (f.segment && c.segment !== f.segment) return false;
      if (f.hast === 'yes' && !c.hast) return false;
      if (f.hast === 'no' && c.hast) return false;
      if (f.responsible && (c.responsible || '') !== (f.responsible === '__none__' ? '' : f.responsible)) return false;
      if (f.hasNext && !c.nextContact) return false;
      if (f.dup && !c.dup) return false;
      if (f.mail) { const m = c.mailStatus || ''; if (f.mail === '__none__' ? m !== '' : f.mail === '__notmailed__' ? (m !== '' || !emailsOf(c).length) : m !== f.mail) return false; }
      if (f.call) { const m = c.callStatus || ''; if (f.call === '__none__' ? m !== '' : m !== f.call) return false; }
      if (f.hasEmail && !emailsOf(c).length) return false;
      if (f.custom) for (const k of Object.keys(f.custom)) {
        const cf = f.custom[k], val = norm(c[k]);
        if (cf.op === 'empty') { if (val !== '') return false; }
        else if (cf.op === 'notempty') { if (val === '') return false; }
        else if (cf.v && val.indexOf(norm(cf.v)) < 0) return false;
      }
      return true;
    });
  }
  function sortList(list, key, dir) {
    const m = dir === 'desc' ? -1 : 1;
    const val = c => key === 'rel' ? relOf(c.status) : (key === 'employees' ? empNum(c.employees) : (c[key] == null ? '' : c[key]));
    return list.slice().sort((a, b) => {
      let x = val(a), y = val(b);
      const ex = x === '' || x === null || x === undefined, ey = y === '' || y === null || y === undefined;
      if (ex && ey) return a.id < b.id ? -1 : 1; if (ex) return 1; if (ey) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
      const r = String(x).localeCompare(String(y), 'ru', { numeric: true, sensitivity: 'base' });
      return r ? r * m : (a.id < b.id ? -1 : 1);
    });
  }
  function empNum(v) { const m = String(v == null ? '' : v).replace(/\s/g, '').match(/\d+/); return m ? parseInt(m[0], 10) : ''; }
  function remindersGroups(list, today) {
    const g = { overdue: [], today: [], soon: [], later: [] };
    const week = addDaysISO(today, 7);
    list.forEach(c => { const d = c.nextContact; if (!isISO(d)) return; (d < today ? g.overdue : d === today ? g.today : d <= week ? g.soon : g.later).push(c); });
    Object.values(g).forEach(a => a.sort((x, y) => (x.nextContact < y.nextContact ? -1 : x.nextContact > y.nextContact ? 1 : x.company.localeCompare(y.company))));
    return g;
  }
  function nextId(list) {
    let mx = 0; list.forEach(c => { const m = /^M(\d+)$/.exec(c.id || ''); if (m) mx = Math.max(mx, parseInt(m[1], 10)); });
    return 'M' + String(mx + 1).padStart(4, '0');
  }
  // Merge rows from an Excel file into the list. Returns summary. Non-empty cells in the file win; empty cells never clear data.
  function mergeImport(list, rows) {
    const byId = new Map(list.map(c => [c.id, c])); const byName = new Map(list.map(c => [norm(c.company).trim(), c]));
    const sum = { updated: 0, added: 0, relApplied: 0, unchanged: 0 };
    rows.forEach(r => {
      if (!r.company && !r.id) return;
      let c = (r.id && byId.get(r.id)) || (r.company && byName.get(norm(r.company).trim()));
      const isNew = !c;
      if (isNew) { c = { id: nextId(list), company: r.company || '', status: 'Not qualified', activities: [], createdAt: new Date().toISOString() }; list.push(c); byId.set(c.id, c); sum.added++; }
      let changed = false;
      FIELDS.forEach(f => {
        if (f.k === 'id' || f.k === 'rel' || f.k === 'status') return;
        const v = r[f.k];
        if (v === undefined || v === null || v === '') return;
        if (f.t === 'bool') { if (c.hast !== !!v) { c.hast = !!v; changed = true; } return; }
        if (c[f.k] !== v) { c[f.k] = v; changed = true; }
      });
      // Status: the file's Status, unless its own Relationship column disagrees with it (then the Relationship is the decision).
      let ns = r.status || c.status, byRel = false;
      if (r.rel && r.rel !== relOf(ns)) { ns = statusFromRel(r.rel, ns, c.stProspect || r.stProspect); byRel = true; }
      if (ns !== c.status) { if (byRel) sum.relApplied++; c.status = ns; changed = true; }
      if (Array.isArray(r.activities) && r.activities.length) {
        c.activities = c.activities || []; const seen = new Set(c.activities.map(a => a.id));
        r.activities.forEach(a => { if (!seen.has(a.id)) { c.activities.push(a); changed = true; } });
        c.activities.sort((x, y) => (x.ts < y.ts ? 1 : -1));
      }
      delete c._s;
      if (isNew) return; if (changed) { c.updatedAt = new Date().toISOString(); sum.updated++; } else sum.unchanged++;
    });
    return sum;
  }
  // Merge organizations from a JSON backup (the data file of the old desktop app, or this app's own backup). Newer record wins field by field, blanks are filled, activities are united.
  function mergeBackup(list, incoming) {
    const byId = new Map(list.map(c => [c.id, c])); const byName = new Map(list.map(c => [norm(c.company).trim(), c]));
    const sum = { updated: 0, added: 0, unchanged: 0 };
    incoming.forEach(r => {
      if (!r || !r.company) return;
      const c = byId.get(r.id) || byName.get(norm(r.company).trim());
      if (!c) {
        const nc = JSON.parse(JSON.stringify(r)); nc.activities = Array.isArray(nc.activities) ? nc.activities : []; Object.keys(nc).forEach(k => { if (k[0] === '_') delete nc[k]; });
        if (!nc.id || byId.has(nc.id)) nc.id = nextId(list);
        list.push(nc); byId.set(nc.id, nc); byName.set(norm(nc.company).trim(), nc); sum.added++; return;
      }
      let changed = false; const newer = (r.updatedAt || '') > (c.updatedAt || '');
      for (const k of Object.keys(r)) {
        if (k === 'id' || k === 'activities' || k[0] === '_' || k === 'updatedAt') continue;
        const v = r[k]; if (v === undefined || v === null || v === '') continue;
        if ((newer || c[k] === undefined || c[k] === '' || c[k] === null) && JSON.stringify(c[k]) !== JSON.stringify(v)) { c[k] = v; changed = true; }
      }
      c.activities = Array.isArray(c.activities) ? c.activities : [];
      const seen = new Set(c.activities.map(a => a.id));
      (r.activities || []).forEach(a => { if (a && a.id && !seen.has(a.id)) { c.activities.push(a); seen.add(a.id); changed = true; } });
      if (changed) { c.activities.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0)); delete c._s; c.updatedAt = newer ? r.updatedAt : new Date().toISOString(); sum.updated++; } else sum.unchanged++;
    });
    return sum;
  }
  return { mergeBackup, FIELDS, BY_HEADER, STATUSES, STATUS_RU, REL, REL_RU, REL_TO_STATUS, PROSPECT_STATUSES, ACTIVITY_TYPES, ACTIVITY_RU, MAIL_STATUSES, CALL_STATUSES, CALL_QUEUE, emailsOf, relOf, statusFromRel, iso, todayISO, addDaysISO, isISO, applyFilters, sortList, remindersGroups, nextId, mergeImport, empNum };
});
