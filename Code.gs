/**
 * Ads Adjust Record — Backend (Google Apps Script)
 * ------------------------------------------------
 * ใช้ Google Sheet เป็นฐานข้อมูล และเปิดเป็น Web App ให้หน้าเว็บ (GitHub Pages) เรียกใช้
 *
 * วิธีติดตั้งอย่างย่อ (รายละเอียดเต็มอยู่ใน README.md)
 *   1. เปิด Google Sheet ที่จะใช้เก็บข้อมูล
 *   2. เมนู Extensions → Apps Script → วางไฟล์นี้ทับ Code.gs
 *   3. แก้ API_TOKEN ด้านล่างให้เป็นรหัสลับของตัวเอง
 *   4. รันฟังก์ชัน setup() หนึ่งครั้ง (สร้างชีตและหัวตารางให้อัตโนมัติ)
 *   5. Deploy → New deployment → Web app
 *        Execute as: Me
 *        Who has access: Anyone
 *      แล้วคัดลอก URL ที่ลงท้ายด้วย /exec ไปใส่ในหน้าตั้งค่าของเว็บแอป
 *
 * หมายเหตุ: ทุกครั้งที่แก้ไฟล์นี้ ต้อง Deploy → Manage deployments → Edit → New version
 */

// ─────────────────────────────────────────────────────────────
// ตั้งค่า
// ─────────────────────────────────────────────────────────────

/** รหัสลับ — ต้องตรงกับที่กรอกในหน้าตั้งค่าของเว็บแอป เปลี่ยนเป็นข้อความสุ่มยาว ๆ ของตัวเอง */
var API_TOKEN = 'CHANGE-ME-เปลี่ยนรหัสนี้ก่อนใช้งาน';

var SHEET_RECORDS = 'RECORDS';
var SHEET_CAMPAIGNS = 'CAMPAIGNS';
var SHEET_PRODUCTS = 'PRODUCTS';
var API_VERSION = '1.1.0';

/** หัวตารางของชีต RECORDS — ลำดับเปลี่ยนได้ โค้ดอ่านจากชื่อหัวคอลัมน์ ไม่ได้อ่านจากตำแหน่ง */
var RECORD_HEADERS = [
  'id',
  'created_at',
  'updated_at',
  'date',
  'product_group',
  'product',
  'channel',
  'campaign',
  'ad_group',
  'tags',
  'change_detail',
  'reason',
  'expected',
  'result_note',
  'status',

  'before_start',
  'before_end',
  'before_impressions',
  'before_clicks',
  'before_ctr',
  'before_cpc',
  'before_cost',
  'before_conversions',
  'before_cvr',
  'before_cpa',
  'before_impr_share',
  'before_lost_rank',
  'before_lost_budget',
  'before_max_cpc',

  'after_start',
  'after_end',
  'after_impressions',
  'after_clicks',
  'after_ctr',
  'after_cpc',
  'after_cost',
  'after_conversions',
  'after_cvr',
  'after_cpa',
  'after_impr_share',
  'after_lost_rank',
  'after_lost_budget',
  'after_max_cpc'
];

var CAMPAIGN_HEADERS = ['name', 'product', 'channel', 'note', 'active'];
var PRODUCT_HEADERS = ['product_group', 'product', 'note', 'active'];

/** หมวดหมู่ตั้งต้น — กลุ่มสินค้า → สินค้า (แก้ได้ในชีต PRODUCTS หรือในหน้าตั้งค่าของเว็บแอป) */
var DEFAULT_PRODUCTS = [
  ['มือถือ', 'iPhone'],
  ['มือถือ', 'SmartPhone'],
  ['แท็บเล็ต', 'iPad'],
  ['คอมพิวเตอร์', 'MacBook'],
  ['คอมพิวเตอร์', 'iMac'],
  ['คอมพิวเตอร์', 'Notebook'],
  ['คอมพิวเตอร์', 'Computer'],
  ['จอภาพ', 'Monitor'],
  ['นาฬิกา', 'Apple Watch'],
  ['นาฬิกา', 'SportWatch'],
  ['อุปกรณ์เสียง', 'AirPods'],
  ['อุปกรณ์เสียง', 'Headphone'],
  ['อุปกรณ์เสียง', 'Speaker'],
  ['เกม', 'Nintendo'],
  ['เกม', 'PlayStation'],
  ['เกม', 'เครื่องเกมอื่น ๆ']
];

// ─────────────────────────────────────────────────────────────
// ติดตั้งครั้งแรก
// ─────────────────────────────────────────────────────────────

/** รันครั้งเดียวหลังวางโค้ด — สร้างชีตและหัวตารางให้ครบ */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var rec = ss.getSheetByName(SHEET_RECORDS) || ss.insertSheet(SHEET_RECORDS);
  ensureHeaders_(rec, RECORD_HEADERS);
  rec.setFrozenRows(1);

  var prod = ss.getSheetByName(SHEET_PRODUCTS) || ss.insertSheet(SHEET_PRODUCTS);
  ensureHeaders_(prod, PRODUCT_HEADERS);
  prod.setFrozenRows(1);
  if (prod.getLastRow() < 2) {
    var rows = DEFAULT_PRODUCTS.map(function (p) { return [p[0], p[1], '', true]; });
    prod.getRange(2, 1, rows.length, 4).setValues(rows);
    prod.setColumnWidth(1, 150);
    prod.setColumnWidth(2, 150);
  }

  var camp = ss.getSheetByName(SHEET_CAMPAIGNS) || ss.insertSheet(SHEET_CAMPAIGNS);
  ensureHeaders_(camp, CAMPAIGN_HEADERS);
  camp.setFrozenRows(1);
  if (camp.getLastRow() < 2) {
    camp.getRange(2, 1, 1, 5).setValues([['15Search-Speaker', 'Speaker', 'Search', '', true]]);
  }
  applyCampaignValidation_();

  Logger.log('setup เรียบร้อย — ชีต RECORDS, CAMPAIGNS และ PRODUCTS พร้อมใช้งาน');
  return 'ok';
}

/** ใส่ dropdown ให้คอลัมน์ product/channel ในชีต CAMPAIGNS เพื่อกันพิมพ์ผิด */
function applyCampaignValidation_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var camp = ss.getSheetByName(SHEET_CAMPAIGNS);
  var prod = ss.getSheetByName(SHEET_PRODUCTS);
  if (!camp || !prod) return;
  var map = headerMap_(camp);
  var lastRow = Math.max(camp.getMaxRows(), 200);

  if (map.product !== undefined && prod.getLastRow() > 1) {
    var pMap = headerMap_(prod);
    var range = prod.getRange(2, pMap.product + 1, prod.getMaxRows() - 1, 1);
    camp.getRange(2, map.product + 1, lastRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInRange(range, true).setAllowInvalid(true).build());
  }
  if (map.channel !== undefined) {
    camp.getRange(2, map.channel + 1, lastRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['Search', 'Shopping', 'Performance Max', 'Display', 'Video', 'Demand Gen', 'App'], true)
        .setAllowInvalid(true).build());
  }
}

/** เติมหัวคอลัมน์ที่ยังไม่มี โดยไม่ลบของเดิม (ปลอดภัยเมื่อเวอร์ชันใหม่เพิ่มคอลัมน์) */
function ensureHeaders_(sheet, headers) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) {
    return String(v || '').trim();
  });
  var missing = headers.filter(function (h) {
    return existing.indexOf(h) === -1;
  });
  if (existing.length === 1 && existing[0] === '') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  sheet
    .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
    .setFontWeight('bold')
    .setBackground('#f0efec');
}

// ─────────────────────────────────────────────────────────────
// Web App entry points
// ─────────────────────────────────────────────────────────────

function doGet(e) {
  return handle_(e, (e && e.parameter) || {});
}

function doPost(e) {
  var body = {};
  try {
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return json_({ ok: false, error: 'อ่าน JSON ไม่สำเร็จ: ' + err });
  }
  var params = {};
  var key;
  for (key in (e && e.parameter) || {}) params[key] = e.parameter[key];
  for (key in body) params[key] = body[key];
  return handle_(e, params);
}

function handle_(e, p) {
  try {
    var action = String(p.action || 'list');

    if (action === 'ping') {
      return json_({ ok: true, version: API_VERSION, tokenOk: p.token === API_TOKEN });
    }

    if (p.token !== API_TOKEN) {
      return json_({ ok: false, error: 'token ไม่ถูกต้อง — ตรวจรหัสในหน้าตั้งค่าให้ตรงกับ Code.gs' });
    }

    switch (action) {
      case 'list':
        return json_({
          ok: true,
          records: listRecords_(),
          campaigns: listCampaigns_(),
          products: listProducts_(),
          version: API_VERSION
        });
      case 'saveProducts':
        return json_({ ok: true, saved: saveProducts_(p.products || []) });
      case 'saveCampaign':
        return json_({ ok: true, campaign: saveCampaign_(p.campaign || {}) });
      case 'create':
        return json_({ ok: true, record: createRecord_(p.record || {}) });
      case 'update':
        return json_({ ok: true, record: updateRecord_(p.record || {}) });
      case 'delete':
        return json_({ ok: true, deleted: deleteRecord_(String(p.id || '')) });
      case 'bulkCreate':
        return json_({ ok: true, created: bulkCreate_(p.records || []) });
      default:
        return json_({ ok: false, error: 'ไม่รู้จัก action: ' + action });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
// Data access
// ─────────────────────────────────────────────────────────────

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('ไม่พบชีตชื่อ "' + name + '" — กรุณารันฟังก์ชัน setup() ก่อน');
  return sh;
}

function headerMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var row = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < row.length; i++) {
    var key = String(row[i] || '').trim();
    if (key) map[key] = i;
  }
  return map;
}

function listRecords_() {
  var sh = sheet_(SHEET_RECORDS);
  if (sh.getLastRow() < 2) return [];
  var map = headerMap_(sh);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var rec = {};
    var empty = true;
    for (var k in map) {
      var v = row[map[k]];
      if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (v !== '' && v !== null && v !== undefined) empty = false;
      rec[k] = v === null || v === undefined ? '' : v;
    }
    if (!empty && rec.id) out.push(rec);
  }
  return out;
}

function listCampaigns_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_CAMPAIGNS);
  if (!sh || sh.getLastRow() < 2) return [];
  var map = headerMap_(sh);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var name = String(values[r][map.name] || '').trim();
    if (!name) continue;
    out.push({
      name: name,
      product: map.product === undefined ? '' : String(values[r][map.product] || '').trim(),
      channel: map.channel === undefined ? '' : String(values[r][map.channel] || '').trim(),
      note: map.note === undefined ? '' : String(values[r][map.note] || ''),
      active: map.active === undefined ? true : values[r][map.active] !== false
    });
  }
  return out;
}

function listProducts_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_PRODUCTS);
  if (!sh || sh.getLastRow() < 2) return [];
  var map = headerMap_(sh);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var product = String(values[r][map.product] || '').trim();
    if (!product) continue;
    out.push({
      product_group: String(values[r][map.product_group] || '').trim() || 'อื่น ๆ',
      product: product,
      note: map.note === undefined ? '' : String(values[r][map.note] || ''),
      active: map.active === undefined ? true : values[r][map.active] !== false
    });
  }
  return out;
}

/** เขียนทับตาราง PRODUCTS ทั้งหมดด้วยรายการที่ส่งมา (ใช้จากหน้าตั้งค่าของเว็บแอป) */
function saveProducts_(list) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_PRODUCTS) || ss.insertSheet(SHEET_PRODUCTS);
  ensureHeaders_(sh, PRODUCT_HEADERS);
  var map = headerMap_(sh);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
    if (!list.length) return 0;
    var width = sh.getLastColumn();
    var rows = list.map(function (p) {
      var row = new Array(width).fill('');
      row[map.product_group] = String(p.product_group || 'อื่น ๆ');
      row[map.product] = String(p.product || '');
      if (map.note !== undefined) row[map.note] = String(p.note || '');
      if (map.active !== undefined) row[map.active] = p.active !== false;
      return row;
    });
    sh.getRange(2, 1, rows.length, width).setValues(rows);
    applyCampaignValidation_();
  } finally {
    lock.releaseLock();
  }
  return list.length;
}

/** สร้างหรืออัปเดตแคมเปญหนึ่งรายการ (ชื่อ + สินค้า + ช่องทาง) */
function saveCampaign_(c) {
  var name = String(c.name || '').trim();
  if (!name) throw new Error('ต้องระบุชื่อแคมเปญ');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_CAMPAIGNS) || ss.insertSheet(SHEET_CAMPAIGNS);
  ensureHeaders_(sh, CAMPAIGN_HEADERS);
  var map = headerMap_(sh);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rowIndex = -1;
    if (sh.getLastRow() > 1) {
      var names = sh.getRange(2, map.name + 1, sh.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < names.length; i++) {
        if (String(names[i][0]).trim() === name) { rowIndex = i + 2; break; }
      }
    }
    var width = sh.getLastColumn();
    var row = rowIndex > 0
      ? sh.getRange(rowIndex, 1, 1, width).getValues()[0]
      : new Array(width).fill('');
    row[map.name] = name;
    if (map.product !== undefined && c.product !== undefined) row[map.product] = String(c.product || '');
    if (map.channel !== undefined && c.channel !== undefined) row[map.channel] = String(c.channel || '');
    if (map.note !== undefined && c.note !== undefined) row[map.note] = String(c.note || '');
    if (map.active !== undefined) row[map.active] = c.active !== false;
    if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, width).setValues([row]);
    else sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  return c;
}

function rowFromRecord_(sheet, rec) {
  var map = headerMap_(sheet);
  var width = Math.max(sheet.getLastColumn(), RECORD_HEADERS.length);
  var row = new Array(width).fill('');
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) {
      var v = rec[k];
      row[map[k]] = v === null || v === undefined ? '' : v;
    }
  }
  return row;
}

function createRecord_(rec) {
  var sh = sheet_(SHEET_RECORDS);
  var now = new Date().toISOString();
  rec.id = rec.id || newId_();
  rec.created_at = rec.created_at || now;
  rec.updated_at = now;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var row = rowFromRecord_(sh, rec);
    sh.appendRow(row);
    touchCampaign_(rec);
  } finally {
    lock.releaseLock();
  }
  return rec;
}

function bulkCreate_(records) {
  if (!records.length) return 0;
  var sh = sheet_(SHEET_RECORDS);
  var now = new Date().toISOString();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var rows = records.map(function (rec) {
      rec.id = rec.id || newId_();
      rec.created_at = rec.created_at || now;
      rec.updated_at = now;
      return rowFromRecord_(sh, rec);
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    // เพิ่มแคมเปญใหม่ทีเดียวตอนท้าย (เร็วกว่าเรียกทีละแถว)
    var known = listCampaigns_().map(function (c) { return c.name; });
    var fresh = [];
    records.forEach(function (rec) {
      var name = String(rec.campaign || '').trim();
      if (!name || known.indexOf(name) !== -1) return;
      var already = false;
      fresh.forEach(function (f) { if (f.name === name) already = true; });
      if (!already) fresh.push({ name: name, product: rec.product || '', channel: rec.channel || '' });
    });
    if (fresh.length) {
      var camp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CAMPAIGNS);
      if (camp) {
        var cMap = headerMap_(camp);
        var cWidth = camp.getLastColumn();
        var cRows = fresh.map(function (f) {
          var row = new Array(cWidth).fill('');
          row[cMap.name] = f.name;
          if (cMap.product !== undefined) row[cMap.product] = f.product;
          if (cMap.channel !== undefined) row[cMap.channel] = f.channel;
          if (cMap.active !== undefined) row[cMap.active] = true;
          return row;
        });
        camp.getRange(camp.getLastRow() + 1, 1, cRows.length, cWidth).setValues(cRows);
      }
    }
  } finally {
    lock.releaseLock();
  }
  return records.length;
}

function findRowById_(sheet, id) {
  var map = headerMap_(sheet);
  if (sheet.getLastRow() < 2) return -1;
  var ids = sheet.getRange(2, map.id + 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function updateRecord_(rec) {
  var sh = sheet_(SHEET_RECORDS);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rowIndex = findRowById_(sh, rec.id);
    if (rowIndex < 0) throw new Error('ไม่พบบันทึก id: ' + rec.id);
    var map = headerMap_(sh);
    var width = sh.getLastColumn();
    var current = sh.getRange(rowIndex, 1, 1, width).getValues()[0];
    rec.updated_at = new Date().toISOString();
    for (var k in map) {
      if (k === 'created_at') continue;
      if (Object.prototype.hasOwnProperty.call(rec, k)) {
        var v = rec[k];
        current[map[k]] = v === null || v === undefined ? '' : v;
      }
    }
    sh.getRange(rowIndex, 1, 1, width).setValues([current]);
    touchCampaign_(rec);
  } finally {
    lock.releaseLock();
  }
  return rec;
}

function deleteRecord_(id) {
  var sh = sheet_(SHEET_RECORDS);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var rowIndex = findRowById_(sh, id);
    if (rowIndex < 0) return false;
    sh.deleteRow(rowIndex);
  } finally {
    lock.releaseLock();
  }
  return true;
}

/** เพิ่ม/อัปเดตแคมเปญในชีต CAMPAIGNS อัตโนมัติ เพื่อให้ dropdown มีให้เลือกครั้งต่อไป
 *  ถ้ามีอยู่แล้วและยังไม่ได้ระบุสินค้า/ช่องทาง จะเติมให้จากบันทึกนี้ (ไม่ทับของเดิมที่กรอกไว้) */
function touchCampaign_(rec) {
  var name = String((rec && rec.campaign) || '').trim();
  if (!name) return;
  var existing = null;
  var all = listCampaigns_();
  for (var i = 0; i < all.length; i++) if (all[i].name === name) { existing = all[i]; break; }

  if (!existing) {
    saveCampaign_({ name: name, product: (rec && rec.product) || '', channel: (rec && rec.channel) || '', active: true });
    return;
  }
  var patch = { name: name, active: existing.active };
  var changed = false;
  if (!existing.product && rec && rec.product) { patch.product = rec.product; changed = true; }
  if (!existing.channel && rec && rec.channel) { patch.channel = rec.channel; changed = true; }
  if (changed) saveCampaign_(patch);
}

function newId_() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
