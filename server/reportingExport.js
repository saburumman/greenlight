// Excel and CSV writers for the Reporting module (REPORTING_SPEC.md §6).
//
// Both take the report JSON from reportingEngine.buildReport(), so a number in
// the workbook is the number on screen is the number in the CSV.
//
// Excel: real types (hours 0.0, percentages as fractions shown 0.0%, dates and
// timestamps as Excel dates in Asia/Amman wall-clock time), native Excel
// Tables with filter buttons and a frozen header on the big sheets, issue keys
// that link back to Jira. The Charts sheet carries the chart images (PNG,
// drawn by public/reportingCharts.js) next to their data tables.
// CSV: UTF-8 with BOM (so Excel reads Arabic names correctly), one file per
// sheet, ISO dates, no thousands separators.

const ExcelJS = require("exceljs");
const { ammanWall, ammanYmd, fmtAmmanDateTime } = require("./reportingEngine");
const Charts = require("../public/reportingCharts");

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const FMT = { hours: "0.0", days: "0.0", pct: "0.0%", int: "0", date: "yyyy-mm-dd", datetime: "yyyy-mm-dd hh:mm" };
const BAND_FILL = { over: "FFFBE3E3", under: "FFE3EEFB", on: "FFEDEDEA", none: "FFF3F3F0" };
const FORECAST_FILL = { "On track": "FFE4F6EC", "At risk": "FFFDF1DC", Slipped: "FFFCE8E8" };
const HEADER_FILL = "FF1F3A5F";

// ---------- value conversion ----------
function ymdToDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
function dateOnly(v) { // "2026-09-30" or an ISO instant -> Date at 00:00 (Amman calendar day)
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return ymdToDate(v);
  return ymdToDate(ammanYmd(v));
}
const isNum = (v) => v !== null && v !== undefined && v !== "" && isFinite(Number(v));

// -> value for an Excel cell
function excelValue(type, v, site) {
  if (v === null || v === undefined || v === "") return null;
  switch (type) {
    case "int": return isNum(v) ? Math.round(Number(v)) : null;
    case "hours": case "days": return isNum(v) ? Number(v) : null;
    case "pct": return isNum(v) ? Number(v) / 100 : null;
    case "date": return dateOnly(v);
    case "datetime": return ammanWall(v);
    case "key": {
      const s = String(v);
      return site && KEY_RE.test(s) ? { text: s, hyperlink: site.replace(/\/+$/, "") + "/browse/" + s } : s;
    }
    default: return typeof v === "number" ? v : String(v);
  }
}

// -> text for a CSV cell
function csvValue(type, v) {
  if (v === null || v === undefined || v === "") return "";
  switch (type) {
    case "int": return isNum(v) ? String(Math.round(Number(v))) : "";
    case "hours": case "days": case "pct": return isNum(v) ? String(Math.round(Number(v) * 100) / 100) : "";
    case "date": { const d = dateOnly(v); return d ? d.toISOString().slice(0, 10) : ""; }
    case "datetime": { const d = ammanWall(v); return d ? d.toISOString().slice(0, 16).replace("T", " ") : ""; }
    default: return String(v);
  }
}

// ---------- CSV ----------
function csvCell(s, type) {
  s = String(s);
  // spreadsheet formula injection: text that starts like a formula is neutralised
  if ((type === "text" || type === "key" || type === undefined) && /^[=+@\t\r]/.test(s)) s = "'" + s;
  else if ((type === "text" || type === "key") && /^-/.test(s) && !isNum(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csvRow = (cells) => cells.join(",");

// One CSV per sheet. Sheets with several blocks stack them with a title row
// and a blank line between; single-table sheets are plain header + rows.
function buildCsv(report, sheetId) {
  const sheet = report.sheets.find((s) => s.id === sheetId);
  if (!sheet) return null;
  const lines = [];
  const multi = sheet.blocks.length > 1;
  if (sheet.charts) {
    report.charts.forEach((c, k) => {
      if (k) lines.push("");
      lines.push(csvRow([csvCell(c.title)]));
      const t = Charts.table(c);
      lines.push(csvRow(t.columns.map((h) => csvCell(h, "text"))));
      t.rows.forEach((r) => lines.push(csvRow(r.map((x) => csvCell(x === null || x === undefined ? "" : x, typeof x === "number" ? "int" : "text")))));
    });
  }
  sheet.blocks.forEach((b, bi) => {
    if (bi) lines.push("");
    if (multi) lines.push(csvRow([csvCell(b.title, "text")]));
    if (b.kind === "kv") {
      lines.push(csvRow(b.columns.map((c) => csvCell(c.header, "text"))));
      b.rows.forEach((r) => lines.push(csvRow(b.columns.map((c) => (c.key === "value" ? csvCell(csvValue(r.valueType || "text", r.value), r.valueType || "text") : csvCell(r[c.key] === null || r[c.key] === undefined ? "" : String(r[c.key]), "text"))))));
    } else {
      lines.push(csvRow(b.columns.map((c) => csvCell(c.header, "text"))));
      b.rows.forEach((r) => lines.push(csvRow(b.columns.map((c) => csvCell(csvValue(c.type, r[c.key]), c.type)))));
    }
  });
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function safeName(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, ""); }
function fileStamp(report) { return ammanYmd(report.meta.generatedAt); }
function csvFileName(report, sheet) { return "SANAD_" + safeName(sheet.name) + "_" + fileStamp(report) + ".csv"; }
function xlsxFileName(report) { return "SANAD_PMO_Delivery_Report_" + fileStamp(report) + ".xlsx"; }

// ---------- chart PNGs ----------
let _resvg;
function loadResvg() {
  if (_resvg !== undefined) return _resvg;
  try { _resvg = require("@resvg/resvg-js").Resvg; } catch (_) { _resvg = null; }
  return _resvg;
}
const path = require("path");
const FONT_DIR = path.join(__dirname, "fonts");
const CHART_W = 900, CHART_H = 480;

function chartPng(spec) {
  const Resvg = loadResvg();
  if (!Resvg) return null;
  const svg = Charts.render(spec, { theme: "light", titleInside: true, width: CHART_W, height: CHART_H });
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: CHART_W * 2 },
    font: { fontFiles: [path.join(FONT_DIR, "DejaVuSans.ttf"), path.join(FONT_DIR, "DejaVuSans-Bold.ttf")], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
  });
  return Buffer.from(r.render().asPng());
}

// ---------- Excel ----------
const colLetter = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function styleHeader(cell) {
  cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  cell.alignment = { vertical: "middle", wrapText: true };
}
const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

function bandFill(v) {
  if (!v) return null;
  if (/^Over/.test(v)) return BAND_FILL.over;
  if (/^Under/.test(v)) return BAND_FILL.under;
  if (/^On target/.test(v)) return BAND_FILL.on;
  if (v === "Unestimated") return BAND_FILL.none;
  return null;
}

let tableSeq = 0;
function tableName(sheetId, blockId) { return ("T_" + sheetId + "_" + blockId).replace(/[^A-Za-z0-9_]/g, "_") + "_" + (++tableSeq); }

// Writes one table block at (row, col). Returns the next free row.
function writeTable(ws, block, row, col, opts) {
  const o = opts || {};
  const cols = block.columns;
  const seen = new Set();
  const headers = cols.map((c) => { let h = String(c.header); while (seen.has(h.toLowerCase())) h += " "; seen.add(h.toLowerCase()); return h; });
  const rowsData = block.rows.map((r) => cols.map((c) => excelValue(c.type, r[c.key], o.site)));
  if (!block.rows.length) {
    headers.forEach((h, i) => { const hc = ws.getCell(row, col + i); hc.value = h; styleHeader(hc); });
    const c = ws.getCell(row + 1, col);
    c.value = "No rows in this scope."; c.font = { italic: true, color: { argb: "FF6F6E69" } };
    return row + 3;
  }
  ws.addTable({
    name: tableName(o.sheetId || "S", block.id), ref: colLetter(col) + row, headerRow: true, totalsRow: false,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: headers.map((h) => ({ name: h, filterButton: true })), rows: rowsData,
  });
  headers.forEach((h, i) => { const hc = ws.getCell(row, col + i); hc.alignment = { vertical: "middle", wrapText: true }; });
  // number formats + colour cues
  const bandIdx = cols.findIndex((c) => c.key === block.colorBy);
  const fcIdx = cols.findIndex((c) => c.key === "forecast");
  block.rows.forEach((r, ri) => {
    cols.forEach((c, ci) => {
      const cell = ws.getCell(row + 1 + ri, col + ci);
      if (FMT[c.type]) cell.numFmt = FMT[c.type];
      if (c.type === "key" && cell.value && typeof cell.value === "object") cell.font = { color: { argb: "FF0563C1" }, underline: true };
    });
    if (bandIdx >= 0) {
      const f = bandFill(r[block.colorBy]);
      if (f) cols.forEach((c, ci) => { if (["variance_h", "variance_pct", block.colorBy].includes(c.key)) ws.getCell(row + 1 + ri, col + ci).fill = solid(f); });
      if (r[block.colorBy] === "Unestimated") cols.forEach((c, ci) => { ws.getCell(row + 1 + ri, col + ci).font = { color: { argb: "FF77766F" } }; });
    }
    if (fcIdx >= 0 && FORECAST_FILL[r.forecast]) ws.getCell(row + 1 + ri, col + fcIdx).fill = solid(FORECAST_FILL[r.forecast]);
  });
  return row + 1 + block.rows.length + 2;
}

function writeKv(ws, block, row, col, opts) {
  const cols = block.columns;
  cols.forEach((c, i) => { const h = ws.getCell(row, col + i); h.value = c.header; styleHeader(h); });
  block.rows.forEach((r, ri) => {
    cols.forEach((c, ci) => {
      const cell = ws.getCell(row + 1 + ri, col + ci);
      if (c.key === "value") {
        const t = r.valueType || "text";
        cell.value = excelValue(t, r.value, null);
        if (FMT[t]) cell.numFmt = FMT[t];
        cell.alignment = { vertical: "top", wrapText: true, horizontal: t === "text" ? "left" : "right" };
      } else {
        const v = r[c.key];
        cell.value = v === null || v === undefined ? null : String(v);
        cell.alignment = { vertical: "top", wrapText: true };
        if (c.key === "note") cell.font = { color: { argb: "FF52514E" } };
      }
      cell.border = { bottom: { style: "hair", color: { argb: "FFC9C8C2" } } };
    });
  });
  return row + 1 + block.rows.length + 2;
}

function noteRow(ws, text, row, spanCols, widthChars) {
  ws.mergeCells(row, 1, row, Math.max(1, spanCols));
  const c = ws.getCell(row, 1);
  c.value = text; c.alignment = { wrapText: true, vertical: "top" }; c.font = { color: { argb: "FF52514E" }, size: 10 };
  ws.getRow(row).height = Math.min(120, 14 * Math.max(1, Math.ceil(String(text).length / Math.max(40, widthChars))));
}

function widths(ws, blocks) {
  const w = [];
  blocks.forEach((b) => b.columns.forEach((c, i) => { w[i] = Math.max(w[i] || 0, Math.min(60, c.width || Math.max(10, String(c.header).length + 2))); }));
  w.forEach((x, i) => { ws.getColumn(i + 1).width = x; });
  return w;
}

async function buildWorkbook(report, options) {
  const o = options || {};
  const site = report.meta.jiraSiteUrl || "";
  tableSeq = 0;
  const wb = new ExcelJS.Workbook();
  wb.creator = report.meta.generatedBy || "Greenlight Reporting";
  wb.title = report.meta.title;
  wb.created = new Date(report.meta.generatedAt);
  wb.modified = new Date(report.meta.generatedAt);

  for (const sheet of report.sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31), { views: [{ showGridLines: !!sheet.raw }] });
    if (!sheet.raw) ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    // ---- charts sheet
    if (sheet.charts) {
      ws.views = [{ showGridLines: false }];
      ws.getCell(1, 1).value = sheet.title; ws.getCell(1, 1).font = { bold: true, size: 14 };
      ws.getCell(2, 1).value = report.caption; ws.getCell(2, 1).font = { italic: true, color: { argb: "FF6F6E69" }, size: 10 };
      ws.getColumn(1).width = 3;
      for (let c = 2; c <= 14; c++) ws.getColumn(c).width = 9.5;
      const STEP = 28; // rows per chart
      let drawn = 0, missing = false;
      for (let k = 0; k < report.charts.length; k++) {
        const spec = report.charts[k];
        const top = 4 + k * STEP;
        ws.getCell(top, 2).value = "Chart " + (k + 1) + " of " + report.charts.length + " — " + spec.title;
        ws.getCell(top, 2).font = { bold: true, color: { argb: "FF1F3A5F" } };
        let png = null;
        try { png = (o.chartPng || chartPng)(spec); } catch (e) { png = null; }
        if (png) {
          const id = wb.addImage({ buffer: png, extension: "png" });
          ws.addImage(id, { tl: { col: 1, row: top }, ext: { width: CHART_W, height: CHART_H }, editAs: "oneCell" });
          drawn++;
        } else missing = true;
        // the numbers behind the chart, to the right — editable, and usable for a native Excel chart
        const t = Charts.table(spec);
        const rows = t.rows.slice(0, 200).map((r) => r.map((x) => (x === undefined ? null : x)));
        const block = { id: spec.id, columns: t.columns.map((h, i) => ({ header: h, key: String(i), type: "text" })), rows: rows.map((r) => Object.fromEntries(r.map((x, i) => [String(i), x]))) };
        ws.getCell(top, 18).value = spec.title + " — data"; ws.getCell(top, 18).font = { bold: true };
        writeTable(ws, block, top + 1, 18, { sheetId: "chart", site: null });
        ws.getColumn(18).width = 26; for (let c = 19; c < 18 + t.columns.length; c++) ws.getColumn(c).width = 16;
      }
      if (missing) { ws.getCell(3, 2).value = "Chart images could not be drawn on the server; the data behind every chart is in the tables to the right."; ws.getCell(3, 2).font = { color: { argb: "FFB42323" } }; }
      continue;
    }

    // ---- raw pivot sheets: table from A1, nothing above it
    if (sheet.raw) {
      const b = sheet.blocks[0];
      widths(ws, [b]);
      writeTable(ws, b, 1, 1, { sheetId: sheet.id, site });
      ws.views = [{ state: "frozen", ySplit: 1, showGridLines: true }];
      continue;
    }

    // ---- ordinary sheets
    let row = 1;
    ws.getCell(row, 1).value = sheet.title; ws.getCell(row, 1).font = { bold: true, size: 14, color: { argb: "FF1F3A5F" } };
    row++;
    ws.getCell(row, 1).value = report.caption; ws.getCell(row, 1).font = { italic: true, color: { argb: "FF6F6E69" }, size: 10 };
    row += 2;
    const w = widths(ws, sheet.blocks);
    const totalChars = w.reduce((s, x) => s + x, 0);
    const span = Math.max(2, Math.min(sheet.blocks[0].columns.length, 8));
    const spanChars = w.slice(0, span).reduce((s, x) => s + x, 0);
    const single = sheet.blocks.length === 1 && sheet.blocks[0].kind === "table";
    let headerRow = null;
    sheet.blocks.forEach((b) => {
      ws.getCell(row, 1).value = b.title; ws.getCell(row, 1).font = { bold: true, size: 12 };
      row++;
      if (b.note) { noteRow(ws, b.note, row, span, spanChars); row++; }
      if (b.kind === "kv") row = writeKv(ws, b, row, 1, { site });
      else { if (single) headerRow = row; row = writeTable(ws, b, row, 1, { sheetId: sheet.id, site }); }
    });
    if (single && headerRow && sheet.blocks[0].rows.length) ws.views = [{ state: "frozen", ySplit: headerRow, xSplit: sheet.id === "register" || sheet.id === "variance_tickets" ? 1 : 0, showGridLines: false }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildWorkbook, buildCsv, csvFileName, xlsxFileName, chartPng, excelValue, csvValue, loadResvg, FONT_DIR };
