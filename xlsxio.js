'use strict';
// Excel import/export in the browser (ExcelJS is shipped with the page and loaded only when needed).
(function () {
  const C = window.CRM;
  let loading = null;
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Cannot load ' + src)); document.head.appendChild(s); });
  async function lib() { if (window.ExcelJS) return; if (!loading) loading = loadScript('vendor/jszip.min.js').then(() => loadScript('vendor/exceljs.min.js')); await loading; if (!window.ExcelJS) throw new Error('ExcelJS missing'); }
  function cellValue(cell) {
    let v = cell.value; if (v === null || v === undefined) return { v: null, link: null };
    let link = null;
    if (typeof v === 'object' && !(v instanceof Date)) {
      if (v.hyperlink) { link = v.hyperlink; v = v.text !== undefined ? v.text : v.hyperlink; if (typeof v === 'object' && v && v.richText) v = v.richText.map(t => t.text).join(''); }
      else if (v.richText) v = v.richText.map(t => t.text).join('');
      else if (v.formula !== undefined || v.sharedFormula !== undefined) v = v.result === undefined ? null : v.result;
      else if (v.error) v = null;
      else if (v.text !== undefined) v = v.text;
    }
    if (v && typeof v === 'object' && !(v instanceof Date) && v.result !== undefined) v = v.result;
    return { v, link };
  }
  const isoUTC = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  const toText = v => (v === null || v === undefined ? '' : v instanceof Date ? isoUTC(v) : String(v).trim());

  async function loadWorkbook(buf) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); return wb; } catch (e) {
      // files saved by some tools carry comment parts ExcelJS cannot read: retry without them
      const zip = await JSZip.loadAsync(buf);
      for (const name of Object.keys(zip.files)) {
        if (/^xl\/worksheets\/_rels\/.*\.rels$/.test(name)) { let x = await zip.file(name).async('string'); x = x.replace(/<Relationship\b[^>]*\/(comments|vmlDrawing)"[^>]*\/>/g, ''); zip.file(name, x); }
      }
      const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(await zip.generateAsync({ type: 'arraybuffer' })); return wb2;
    }
  }
  async function parse(buf) {
    await lib();
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('Master') || wb.worksheets[0];
    if (!ws) throw new Error('NO_SHEETS');
    const cols = {}; ws.getRow(1).eachCell((cell, n) => { const h = toText(cellValue(cell).v); if (C.BY_HEADER[h]) cols[n] = C.BY_HEADER[h]; });
    if (!Object.values(cols).some(f => f.k === 'company')) throw new Error('NOT_MASTER');
    const rows = [];
    ws.eachRow((row, rn) => {
      if (rn === 1) return; const r = {};
      Object.entries(cols).forEach(([n, f]) => {
        const { v, link } = cellValue(row.getCell(+n)); if (v === null || v === '') return;
        if (f.t === 'bool') { const s = String(v).trim().toLowerCase(); r[f.k] = v === true || s === 'true' || s === '1' || s === 'да' || s === 'yes'; }
        else if (f.t === 'num') { const n2 = Number(v); r[f.k] = isNaN(n2) ? toText(v) : n2; }
        else if (f.t === 'date') { const t = toText(v); r[f.k] = /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t; }
        else if (f.t === 'link') r[f.k] = link || toText(v);
        else r[f.k] = toText(v);
      });
      if (r.id || r.company) rows.push(r);
    });
    const acts = {}; const as = wb.getWorksheet('Activity log');
    if (as) {
      const ac = {}; as.getRow(1).eachCell((cell, n) => { ac[toText(cellValue(cell).v)] = n; });
      as.eachRow((row, rn) => {
        if (rn === 1) return; const g = h => (ac[h] ? toText(cellValue(row.getCell(ac[h])).v) : '');
        const id = g('ID'); if (!id) return;
        const typeRu = g('Type'); const type = (C.ACTIVITY_TYPES.find(t => t[1] === typeRu || t[0] === typeRu) || ['note'])[0];
        (acts[id] = acts[id] || []).push({ id: g('Activity ID') || ('imp' + rn), ts: g('Date/time'), type, text: g('Text') });
      });
    }
    rows.forEach(r => { if (r.id && acts[r.id]) r.activities = acts[r.id]; });
    return { rows, sheet: ws.name };
  }
  async function write(companies) {
    await lib();
    const wb = new ExcelJS.Workbook(); wb.creator = 'Arahet CRM'; wb.created = new Date();
    const ws = wb.addWorksheet('Master', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
    const widths = { id: 8, company: 34, hast: 11, rel: 26, status: 18, type: 16, owner: 30, address: 40, companyOrig: 30, segment: 30, employees: 16, approach: 36, email: 30, phone: 24, map: 14, website: 28, hr: 40, machines: 28, legalName: 34, why: 40, notes: 50, contractLines: 60, statusNote: 46, dup: 50, myNotes: 50, refs: 40 };
    ws.columns = C.FIELDS.map(f => ({ header: f.h, key: f.k, width: widths[f.k] || 18 }));
    const hdr = ws.getRow(1); hdr.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } }; hdr.alignment = { vertical: 'middle', wrapText: true }; hdr.height = 32;
    const mapIdx = C.FIELDS.findIndex(f => f.k === 'map') + 1, webIdx = C.FIELDS.findIndex(f => f.k === 'website') + 1;
    companies.forEach(c => {
      const row = {};
      C.FIELDS.forEach(f => {
        let v = c[f.k];
        if (f.k === 'rel') v = C.relOf(c.status); else if (f.t === 'bool') v = !!c.hast;
        else if (f.t === 'date') v = C.isISO(v) ? new Date(v + 'T00:00:00Z') : (v || null);
        else if (f.t === 'link') v = null; else if (v === undefined || v === '') v = null;
        row[f.k] = v;
      });
      const r = ws.addRow(row); r.font = { name: 'Arial', size: 10 };
      const mc = r.getCell(mapIdx), wc = r.getCell(webIdx);
      if (c.map) { mc.value = { text: 'Open map', hyperlink: c.map }; mc.font = { name: 'Arial', size: 10, color: { argb: 'FF0563C1' }, underline: true }; }
      if (c.website) { const first = String(c.website).split(' | ')[0]; const url = /^https?:\/\//.test(first) ? first : (/^www\./.test(first) ? 'https://' + first : null); wc.value = url ? { text: String(c.website), hyperlink: url } : String(c.website); if (url) wc.font = { name: 'Arial', size: 10, color: { argb: 'FF0563C1' }, underline: true }; }
      C.FIELDS.forEach((f, i) => { if (f.t === 'date') r.getCell(i + 1).numFmt = 'yyyy-mm-dd'; });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: C.FIELDS.length } };
    const as = wb.addWorksheet('Activity log', { views: [{ state: 'frozen', ySplit: 1 }] });
    as.columns = [{ header: 'ID', key: 'id', width: 9 }, { header: 'Company', key: 'company', width: 34 }, { header: 'Date/time', key: 'ts', width: 20 }, { header: 'Type', key: 'type', width: 14 }, { header: 'Text', key: 'text', width: 90 }, { header: 'Activity ID', key: 'aid', width: 16 }];
    as.getRow(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }; as.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    companies.forEach(c => (c.activities || []).forEach(a => { const r = as.addRow({ id: c.id, company: c.company, ts: a.ts, type: C.ACTIVITY_RU[a.type] || a.type, text: a.text, aid: a.id }); r.font = { name: 'Arial', size: 10 }; }));
    as.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
    return await wb.xlsx.writeBuffer();
  }
  window.XLSXIO = { parse, write };
})();
