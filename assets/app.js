/* =============================================================
   Ads Adjust Record — application logic
   ไม่มี dependency ภายนอก ทำงานได้แม้เปิดไฟล์ตรง ๆ
   ============================================================= */
'use strict';

/* ─────────────────────────────────────────────────────────────
   1. ค่าคงที่
   ───────────────────────────────────────────────────────────── */

const APP_VERSION = '1.17.0';
const LS_CONFIG = 'aar.config.v1';

/* ═══════════════════════════════════════════════════════════════
   การเชื่อมต่อ

   เว็บนี้ยิงผ่าน "ตัวกลาง" ที่ /api/sheet ซึ่งเป็น Cloudflare Pages Function
   token กับ URL ของชีตเก็บเป็น environment variable ฝั่งเซิร์ฟเวอร์
   ไม่มีความลับอยู่ในไฟล์นี้เลย — เปิด DevTools ดูก็ไม่เจอ

   ตัวกลางอยู่ที่ cloudflare/functions/api/sheet.js (ดูขั้นตอนตั้งใน README)

   ถ้ายังไม่ได้ย้ายไป Cloudflare: ไปหน้าตั้งค่า กรอก URL /exec กับ token เอง
   ค่าที่กรอกจะเก็บอยู่ในเบราว์เซอร์เครื่องนี้เท่านั้น ไม่ขึ้น repo
   ═══════════════════════════════════════════════════════════════ */
const PROXY_PATH = '/api/sheet';
const DEFAULT_CONFIG = {
  url: PROXY_PATH,
  token: ''          // ตัวกลางเติมให้ฝั่งเซิร์ฟเวอร์ ไม่ต้องมีตรงนี้
};

/** URL นี้เป็นตัวกลางของเราเองหรือเปล่า (เส้นทางแบบ relative) */
const isProxyUrl = u => String(u || '').startsWith('/');
const LS_CACHE = 'aar.records.v1';

/** ตัวชี้วัดทั้งหมด
 *  better : 'up' = สูงกว่าดี, 'down' = ต่ำกว่าดี, 'neutral' = ไม่ตัดสิน
 *  volume : true  = ค่าสะสม (ยิ่งช่วงยาวยิ่งเยอะ) ต้องหารด้วยจำนวนวันก่อนเทียบ
 */
/*  tier : 'primary' = ช่องที่ต้องกรอกเอง (4 ช่องนี้พอ ที่เหลือคำนวณได้)
 *         'calc'    = ระบบคำนวณให้จาก 4 ช่องบน — ซ่อนไว้ในแถบสรุป กดแก้เองได้
 *         'extra'   = ช่องเสริม พับเก็บไว้ */
const METRICS = [
  { key: 'impressions',  label: 'Impressions',       short: 'Impr',   unit: '',  better: 'up',      volume: true,  dec: 0, tier: 'primary' },
  { key: 'ctr',          label: 'CTR',               short: 'CTR',    unit: '%', better: 'up',      volume: false, dec: 2, tier: 'primary' },
  { key: 'cpc',          label: 'CPC',               short: 'CPC',    unit: '฿', better: 'down',    volume: false, dec: 2, tier: 'primary' },
  { key: 'conversions',  label: 'Conversions',       short: 'Conv',   unit: '',  better: 'up',      volume: true,  dec: 2, tier: 'primary' },

  { key: 'clicks',       label: 'Clicks',            short: 'Clicks', unit: '',  better: 'up',      volume: true,  dec: 0, tier: 'calc' },
  { key: 'cost',         label: 'Cost รวม',          short: 'Cost',   unit: '฿', better: 'neutral', volume: true,  dec: 2, tier: 'calc' },
  { key: 'cvr',          label: 'Conversion Rate',   short: 'CVR',    unit: '%', better: 'up',      volume: false, dec: 2, tier: 'calc' },
  { key: 'cpa',          label: 'Cost/Conversion',   short: 'CPA',    unit: '฿', better: 'down',    volume: false, dec: 2, tier: 'calc' },

  { key: 'impr_share',   label: 'Impression Share',  short: 'IS',     unit: '%', better: 'up',      volume: false, dec: 2, tier: 'extra' },
  { key: 'lost_rank',    label: 'Lost IS (rank)',    short: 'Lost·R', unit: '%', better: 'down',    volume: false, dec: 2, tier: 'extra' },
  { key: 'lost_budget',  label: 'Lost IS (budget)',  short: 'Lost·B', unit: '%', better: 'down',    volume: false, dec: 2, tier: 'extra' },
  { key: 'max_cpc',      label: 'Max CPC Bid',       short: 'MaxCPC', unit: '฿', better: 'neutral', volume: false, dec: 2, tier: 'extra' }
];
const METRICS_BY_TIER = t => METRICS.filter(m => m.tier === t);
const METRIC_BY_KEY = Object.fromEntries(METRICS.map(m => [m.key, m]));

/** ตัวชี้วัดที่ใช้ตัดสินว่าการปรับ "ได้ผล" หรือไม่ พร้อมน้ำหนัก */
const VERDICT_WEIGHTS = { cpa: 3, conversions: 2.5, cvr: 2, ctr: 1, impr_share: 1, cpc: 0.5 };

/** หมวดหมู่ตั้งต้น — กลุ่มสินค้า → สินค้า (ถ้าเชื่อม Google Sheet จะใช้ของในชีต PRODUCTS แทน) */
const DEFAULT_TAXONOMY = [
  ['มือถือ',        ['iPhone', 'SmartPhone']],
  ['แท็บเล็ต',      ['iPad']],
  ['คอมพิวเตอร์',   ['MacBook', 'iMac', 'Notebook', 'Computer']],
  ['จอภาพ',         ['Monitor']],
  ['นาฬิกา',        ['Apple Watch', 'SportWatch']],
  ['อุปกรณ์เสียง',  ['AirPods', 'Headphone', 'Speaker']],
  ['เกม',           ['Nintendo', 'PlayStation', 'เครื่องเกมอื่น ๆ']]
];

/** คำพ้องสำหรับเดาสินค้าจากชื่อแคมเปญ — key คือชื่อสินค้าจริง */
const PRODUCT_ALIASES = {
  'iPhone': ['iphone', 'ไอโฟน'],
  'iPad': ['ipad', 'ไอแพด'],
  'MacBook': ['macbook', 'mbp', 'mba', 'แมคบุ๊ค'],
  'iMac': ['imac'],
  'Notebook': ['notebook', 'laptop', 'โน้ตบุ๊ค', 'โน๊ตบุ๊ค'],
  'Computer': ['computer', 'desktop', 'pc', 'คอม'],
  'Monitor': ['monitor', 'จอ'],
  'Apple Watch': ['applewatch', 'apple watch', 'awatch'],
  'SportWatch': ['sportwatch', 'sport watch', 'smartwatch', 'garmin'],
  'AirPods': ['airpods', 'airpod'],
  'Headphone': ['headphone', 'headset', 'หูฟัง'],
  'Speaker': ['speaker', 'ลำโพง'],
  'Nintendo': ['nintendo', 'switch'],
  'PlayStation': ['playstation', 'ps5', 'ps4', 'เพลย์'],
  'SmartPhone': ['smartphone', 'android', 'samsung', 'xiaomi', 'oppo', 'vivo', 'มือถือ'],
  'เครื่องเกมอื่น ๆ': ['xbox', 'steamdeck', 'steam deck', 'rog ally']
};

/** ประเภทการปรับที่เลือกได้เร็ว ๆ */
const TAGS = [
  'เพิ่ม Keywords', 'ลบ Keywords', 'ปรับ Match Type', 'เพิ่ม Negative Keywords',
  'ปรับ Bid / Max CPC', 'ปรับงบประมาณ', 'แก้ Headline / Description', 'เพิ่ม/ลบ Ad',
  'ปรับ Ad Group', 'ปรับ Audience', 'ปรับ Location / Schedule', 'ปรับ Landing Page',
  'เปลี่ยน Bid Strategy', 'เปิด/ปิดแคมเปญ', 'อื่น ๆ'
];

/**
 * ช่องกรอกที่โผล่ขึ้นมาเมื่อกดชิปแต่ละประเภท
 * fields: ช่องที่ต้องกรอก · text(v): ประกอบเป็นข้อความ "สิ่งที่ปรับ" ให้อัตโนมัติ
 * ประเภทที่ไม่มีในนี้ = ใช้ช่องรายละเอียดอิสระอย่างเดียวเหมือนเดิม
 */
const MATCH_TYPES = ['Broad', 'Phrase', 'Exact'];
const BID_STRATEGIES = ['Maximize conversions', 'Maximize conversion value', 'Target CPA',
  'Target ROAS', 'Maximize clicks', 'Manual CPC', 'Enhanced CPC', 'Target impression share'];

const TAG_FORMS = {
  'ปรับงบประมาณ': {
    setting: 'budget',                       // ซิงก์กับหน้า "งบ & Bid" ให้ด้วย
    fields: [
      { key: 'from', label: 'งบเดิม', unit: 'บาท/วัน', type: 'number', step: '1', fillFrom: 'budget' },
      { key: 'to', label: 'งบใหม่', unit: 'บาท/วัน', type: 'number', step: '1', required: true }
    ],
    text: v => v.to ? `ปรับงบ ${v.from ? v.from + ' → ' : '→ '}${v.to} บาท/วัน` : ''
  },
  'ปรับ Bid / Max CPC': {
    setting: 'bid',
    fields: [
      { key: 'from', label: 'Bid เดิม', unit: 'บาท', type: 'number', step: '0.01', fillFrom: 'bid' },
      { key: 'to', label: 'Bid ใหม่', unit: 'บาท', type: 'number', step: '0.01', required: true }
    ],
    text: v => v.to ? `ปรับ Max CPC ${v.from ? v.from + ' → ' : '→ '}${v.to} บาท` : ''
  },
  'เพิ่ม Keywords': {
    fields: [{ key: 'list', label: 'คำที่เพิ่ม', unit: 'บรรทัดละคำ', type: 'lines',
               placeholder: 'ซื้อ ลำโพง bose\nลำโพง bose ราคา' }],
    text: v => lineList(v.list, 'เพิ่ม Keywords')
  },
  'ลบ Keywords': {
    fields: [{ key: 'list', label: 'คำที่ลบ', unit: 'บรรทัดละคำ', type: 'lines' }],
    text: v => lineList(v.list, 'ลบ Keywords')
  },
  'เพิ่ม Negative Keywords': {
    fields: [{ key: 'list', label: 'คำที่กัน', unit: 'บรรทัดละคำ', type: 'lines',
               placeholder: 'ซ่อม\nมือสอง\nราคาถูก' }],
    text: v => lineList(v.list, 'เพิ่ม Negative')
  },
  'ปรับ Match Type': {
    fields: [
      { key: 'kw', label: 'คำที่ปรับ', type: 'text', placeholder: 'เช่น ลำโพง bose' },
      { key: 'from', label: 'จาก', type: 'select', options: MATCH_TYPES },
      { key: 'to', label: 'เป็น', type: 'select', options: MATCH_TYPES, required: true }
    ],
    text: v => v.to ? `ปรับ Match Type${v.kw ? ` "${v.kw}"` : ''} ${v.from ? v.from + ' → ' : '→ '}${v.to}` : ''
  },
  'เปลี่ยน Bid Strategy': {
    fields: [
      { key: 'from', label: 'จาก', type: 'select', options: BID_STRATEGIES },
      { key: 'to', label: 'เป็น', type: 'select', options: BID_STRATEGIES, required: true },
      { key: 'target', label: 'ค่าเป้าหมาย', unit: 'ไม่บังคับ', type: 'text', placeholder: 'เช่น tCPA 120 บาท' }
    ],
    text: v => v.to
      ? `เปลี่ยน Bid Strategy ${v.from ? v.from + ' → ' : '→ '}${v.to}${v.target ? ` (${v.target})` : ''}` : ''
  },
  'เปิด/ปิดแคมเปญ': {
    fields: [{ key: 'state', label: 'สถานะใหม่', type: 'select', options: ['เปิด', 'ปิด'], required: true }],
    text: v => v.state ? `${v.state}แคมเปญ` : ''
  },
  'แก้ Headline / Description': {
    fields: [
      { key: 'part', label: 'แก้ส่วนไหน', type: 'select', options: ['Headline', 'Description', 'ทั้งสองอย่าง'] },
      { key: 'from', label: 'ข้อความเดิม', type: 'text' },
      { key: 'to', label: 'ข้อความใหม่', type: 'text', required: true }
    ],
    text: v => v.to ? `แก้ ${v.part || 'ข้อความโฆษณา'}: ${v.from ? `"${v.from}" → ` : ''}"${v.to}"` : ''
  },
  'ปรับ Landing Page': {
    fields: [{ key: 'url', label: 'URL ใหม่', type: 'text', placeholder: 'https://…', required: true }],
    text: v => v.url ? `เปลี่ยน Landing Page → ${v.url}` : ''
  },
  'ปรับ Location / Schedule': {
    fields: [{ key: 'detail', label: 'ปรับอะไร', type: 'text',
               placeholder: 'เช่น เพิ่ม กรุงเทพ +20% / ปิดโฆษณา 00:00-06:00', required: true }],
    text: v => v.detail ? `ปรับ Location/Schedule: ${v.detail}` : ''
  }
};

/** "เพิ่ม Negative 3 คำ: ซ่อม, มือสอง, ราคาถูก" */
function lineList(raw, verb) {
  const items = String(raw || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean);
  if (!items.length) return '';
  const shown = items.slice(0, 8).map(x => `"${x}"`).join(', ');
  const more = items.length > 8 ? ` +อีก ${items.length - 8} คำ` : '';
  return `${verb} ${items.length} คำ: ${shown}${more}`;
}

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

/* ─────────────────────────────────────────────────────────────
   2. Utilities
   ───────────────────────────────────────────────────────────── */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/** ชื่อประเภท → id ที่ใช้ใน DOM ได้ (ไทย/ช่องว่าง/สแลช ใช้ตรง ๆ ไม่ได้) */
const slug = s => 'x' + [...String(s)].map(c => c.charCodeAt(0).toString(36)).join('');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[฿,\s]/g, '').replace(/THB/gi, '').replace(/%/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function fmt(v, dec = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('th-TH', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtMetric(key, v) {
  const m = METRIC_BY_KEY[key];
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const dec = m ? m.dec : 2;
  const s = fmt(v, dec);
  if (!m) return s;
  if (m.unit === '฿') return '฿' + s;
  if (m.unit === '%') return s + '%';
  return s;
}

const todayISO = () => new Date().toLocaleDateString('sv-SE');

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('sv-SE');
}

function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);           // M/D/YYYY (แบบไฟล์เดิม)
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

const toISO = d => (d ? d.toLocaleDateString('sv-SE') : '');

function daysBetween(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return null;
  const n = Math.round((db - da) / 86400000) + 1;   // นับแบบรวมวันแรกและวันสุดท้าย
  return n > 0 ? n : null;
}

function thaiDate(iso) {
  const d = parseDate(iso);
  if (!d) return iso || '—';
  const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function relativeDay(iso) {
  const d = parseDate(iso);
  if (!d) return '';
  const diff = Math.round((new Date(todayISO()) - d) / 86400000);
  if (diff === 0) return 'วันนี้';
  if (diff === 1) return 'เมื่อวาน';
  if (diff === 2) return 'เมื่อวานซืน';
  if (diff < 0) return `อีก ${-diff} วัน`;
  if (diff < 30) return `${diff} วันก่อน`;
  if (diff < 365) return `${Math.round(diff / 30)} เดือนก่อน`;
  return `${Math.round(diff / 365)} ปีก่อน`;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** toast ที่มีปุ่มให้กด — ใช้กับ "ลบแล้ว · เลิกทำ" */
function toastAction(msg, label, fn, ms = 7000) {
  const t = $('#toast');
  t.textContent = '';
  t.append(el('span', {}, msg));
  t.append(el('button', {
    type: 'button', class: 'toast-btn',
    onclick: () => { clearTimeout(toastTimer); t.classList.remove('show'); fn(); }
  }, label));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob(['﻿', content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ─────────────────────────────────────────────────────────────
   2b. หมวดหมู่สินค้า (กลุ่ม → สินค้า → แคมเปญ)
   ───────────────────────────────────────────────────────────── */

const Taxonomy = {
  /** [{product_group, product}] — แหล่งความจริงเดียวของหมวดหมู่ */
  list: [],

  loadDefaults() {
    this.list = DEFAULT_TAXONOMY.flatMap(([group, products]) =>
      products.map(product => ({ product_group: group, product })));
  },

  set(list) {
    const clean = (list || [])
      .map(p => ({
        product_group: String(p.product_group || '').trim() || 'อื่น ๆ',
        product: String(p.product || '').trim()
      }))
      .filter(p => p.product);
    this.list = clean.length ? clean : this.list;
  },

  /** กลุ่มของสินค้าหนึ่งตัว — ถ้าไม่รู้จักจะได้ 'อื่น ๆ' */
  groupOf(product) {
    const key = String(product || '').trim().toLowerCase();
    if (!key) return '';
    const hit = this.list.find(p => p.product.toLowerCase() === key);
    return hit ? hit.product_group : 'อื่น ๆ';
  },

  /** ชื่อกลุ่มทั้งหมด เรียงตามลำดับที่กำหนดไว้ */
  groups() {
    const seen = [];
    for (const p of this.list) if (!seen.includes(p.product_group)) seen.push(p.product_group);
    return seen;
  },

  products(group) {
    return this.list.filter(p => !group || p.product_group === group).map(p => p.product);
  },

  /** แปลงเป็นข้อความสำหรับกล่องแก้ไข: "กลุ่ม: สินค้า1, สินค้า2" */
  toText() {
    return this.groups()
      .map(g => `${g}: ${this.products(g).join(', ')}`)
      .join('\n');
  },

  /** อ่านกลับจากข้อความ — คืน null ถ้ารูปแบบผิด */
  fromText(text) {
    const out = [];
    for (const rawLine of String(text || '').split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const idx = line.indexOf(':');
      if (idx < 1) return { error: `บรรทัด "${line}" ไม่มีเครื่องหมาย : คั่นระหว่างกลุ่มกับสินค้า` };
      const group = line.slice(0, idx).trim();
      const products = line.slice(idx + 1).split(',').map(s => s.trim()).filter(Boolean);
      if (!group) return { error: 'มีบรรทัดที่ชื่อกลุ่มว่าง' };
      if (!products.length) return { error: `กลุ่ม "${group}" ยังไม่มีสินค้า` };
      for (const product of products) out.push({ product_group: group, product });
    }
    if (!out.length) return { error: 'ยังไม่มีข้อมูลหมวดหมู่' };
    const lower = out.map(p => p.product.toLowerCase());
    const dupIdx = lower.findIndex((v, i) => lower.indexOf(v) !== i);
    if (dupIdx >= 0) return { error: `สินค้า "${out[dupIdx].product}" ซ้ำมากกว่าหนึ่งกลุ่ม` };
    return { list: out };
  }
};

/** เดาสินค้าจากชื่อแคมเปญ เช่น "15Search-Speaker" → Speaker */
function guessFromCampaignName(name) {
  const squashed = String(name || '').toLowerCase().replace(/[\s_\-–]/g, '');
  let best = null;
  for (const [canonical, words] of Object.entries(PRODUCT_ALIASES)) {
    for (const w of words) {
      const key = w.replace(/\s/g, '');
      if (squashed.indexOf(key) === -1) continue;
      // คำที่ยาวกว่าชนะ (ให้ "applewatch" ชนะ "watch")
      if (!best || key.length > best.len) best = { value: canonical, len: key.length };
    }
  }
  const product = best ? best.value : '';
  const known = Taxonomy.products();
  return { product: known.some(p => p.toLowerCase() === product.toLowerCase()) ? product : '' };
}

/* ─────────────────────────────────────────────────────────────
   3. เครื่องคำนวณตัวชี้วัด
   ───────────────────────────────────────────────────────────── */

/** เติมค่าที่เว้นว่างจากความสัมพันธ์ทางคณิตศาสตร์ของ Google Ads
 *  คืน { values, derived:Set } — derived คือ key ที่ระบบคำนวณให้ ไม่ได้กรอกเอง */
function solveBlock(raw) {
  const v = {};
  for (const m of METRICS) v[m.key] = num(raw[m.key]);
  const given = new Set(METRICS.filter(m => v[m.key] !== null).map(m => m.key));
  const set = (k, val) => {
    if (v[k] === null && Number.isFinite(val) && val >= 0) v[k] = val;
  };
  const ok = x => x !== null && Number.isFinite(x);

  for (let pass = 0; pass < 4; pass++) {
    // clicks ↔ impressions ↔ ctr
    if (ok(v.impressions) && ok(v.ctr)) set('clicks', v.impressions * v.ctr / 100);
    if (ok(v.clicks) && ok(v.impressions) && v.impressions > 0) set('ctr', v.clicks / v.impressions * 100);
    if (ok(v.clicks) && ok(v.ctr) && v.ctr > 0) set('impressions', v.clicks / (v.ctr / 100));
    // cost ↔ clicks ↔ cpc
    if (ok(v.clicks) && ok(v.cpc)) set('cost', v.clicks * v.cpc);
    if (ok(v.cost) && ok(v.clicks) && v.clicks > 0) set('cpc', v.cost / v.clicks);
    if (ok(v.cost) && ok(v.cpc) && v.cpc > 0) set('clicks', v.cost / v.cpc);
    // conversions ↔ clicks ↔ cvr
    if (ok(v.clicks) && ok(v.cvr)) set('conversions', v.clicks * v.cvr / 100);
    if (ok(v.conversions) && ok(v.clicks) && v.clicks > 0) set('cvr', v.conversions / v.clicks * 100);
    if (ok(v.conversions) && ok(v.cvr) && v.cvr > 0) set('clicks', v.conversions / (v.cvr / 100));
    // cpa ↔ cost ↔ conversions
    if (ok(v.cost) && ok(v.conversions) && v.conversions > 0) set('cpa', v.cost / v.conversions);
    if (ok(v.cpa) && ok(v.conversions)) set('cost', v.cpa * v.conversions);
    if (ok(v.cost) && ok(v.cpa) && v.cpa > 0) set('conversions', v.cost / v.cpa);
    // impression share ↔ lost
    if (ok(v.impr_share) && ok(v.lost_rank)) set('lost_budget', Math.max(0, 100 - v.impr_share - v.lost_rank));
    if (ok(v.impr_share) && ok(v.lost_budget)) set('lost_rank', Math.max(0, 100 - v.impr_share - v.lost_budget));
    if (ok(v.lost_rank) && ok(v.lost_budget)) set('impr_share', Math.max(0, 100 - v.lost_rank - v.lost_budget));
  }

  const derived = new Set(METRICS.filter(m => v[m.key] !== null && !given.has(m.key)).map(m => m.key));
  return { values: v, derived };
}

/** ดึงบล็อกตัวเลข (before / after) ออกจาก record */
function block(rec, side) {
  const out = {};
  for (const m of METRICS) out[m.key] = rec[`${side}_${m.key}`];
  out._start = rec[`${side}_start`] || '';
  out._end = rec[`${side}_end`] || '';
  out._days = daysBetween(out._start, out._end);
  return out;
}

function hasNumbers(b) {
  return METRICS.some(m => num(b[m.key]) !== null);
}

/** เทียบสองบล็อก คืนผลรายตัวชี้วัด + คำตัดสินรวม */
function compareBlocks(beforeRaw, afterRaw, mode = 'auto') {
  const B = solveBlock(beforeRaw).values;
  const A = solveBlock(afterRaw).values;
  const bDays = beforeRaw._days, aDays = afterRaw._days;

  let perDay = false;
  if (mode === 'perday') perDay = !!(bDays && aDays);
  else if (mode === 'auto') {
    perDay = !!(bDays && aDays && Math.abs(bDays - aDays) / Math.max(bDays, aDays) > 0.1);
  }

  const rows = [];
  for (const m of METRICS) {
    let b = B[m.key], a = A[m.key];
    if (b === null && a === null) continue;
    const norm = perDay && m.volume;
    if (norm) {
      b = b !== null && bDays ? b / bDays : null;
      a = a !== null && aDays ? a / aDays : null;
    }
    let deltaPct = null, dir = 'flat', good = null;
    if (b !== null && a !== null && b !== 0) {
      deltaPct = (a - b) / Math.abs(b) * 100;
      if (Math.abs(deltaPct) < 0.5) dir = 'flat';
      else dir = deltaPct > 0 ? 'up' : 'down';
      if (m.better !== 'neutral' && dir !== 'flat') {
        good = (m.better === 'up') === (dir === 'up');
      }
    }
    rows.push({ key: m.key, metric: m, before: b, after: a, deltaPct, dir, good, perDay: norm });
  }

  // คำตัดสินรวม
  let score = 0, weightSum = 0;
  for (const r of rows) {
    const w = VERDICT_WEIGHTS[r.key];
    if (!w || r.deltaPct === null || r.metric.better === 'neutral') continue;
    const signed = r.deltaPct * (r.metric.better === 'down' ? -1 : 1);
    score += w * Math.max(-1, Math.min(1, signed / 20));
    weightSum += w;
  }
  const norm = weightSum ? score / weightSum : null;
  let verdict = 'pending';
  if (norm !== null) verdict = norm > 0.08 ? 'up' : norm < -0.08 ? 'down' : 'flat';

  return { rows, verdict, score: norm, perDay, bDays, aDays };
}

const VERDICT_TEXT = {
  up: { label: 'ดีขึ้น', icon: '▲' },
  down: { label: 'แย่ลง', icon: '▼' },
  flat: { label: 'ทรงตัว', icon: '＝' },
  pending: { label: 'รอผล', icon: '⋯' }
};

/* ─────────────────────────────────────────────────────────────
   4. ชั้นเก็บข้อมูล (Google Sheet + สำรองในเครื่อง)
   ───────────────────────────────────────────────────────────── */

const Store = {
  config: { url: '', token: '' },
  records: [],
  campaigns: [],
  metrics: [],
  leads: [],
  rev: 0,                 // เพิ่มทุกครั้งที่ข้อมูลเปลี่ยน ใช้ล้างแคชรอบวัดผล
  online: false,
  status: 'local',        // local | connecting | online | error
  lastError: '',
  lastSyncAt: '',

  usingDefault: true,      // true = ใช้ค่าที่ฝังมาในโค้ด ไม่ใช่ค่าที่ผู้ใช้กรอกเอง

  loadConfig() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_CONFIG) || '{}'); }
    catch { /* ไม่เป็นไร */ }

    if (saved.offline) {                       // ผู้ใช้เลือกใช้แบบออฟไลน์ไว้เอง
      this.config = { url: '', token: '' };
      this.usingDefault = false;
    } else if (saved.url && !isProxyUrl(saved.url)) {   // ผู้ใช้กรอกค่าของตัวเองไว้ — ใช้ของเขา
      this.config = { url: saved.url, token: saved.token || '' };
      this.usingDefault = false;
    } else {                                   // ไม่มีอะไรเก็บไว้ — ใช้ค่าที่ฝังในโค้ด ต่อได้ทันที
      this.config = { ...DEFAULT_CONFIG };
      this.usingDefault = true;
    }
  },

  saveConfig() {
    localStorage.setItem(LS_CONFIG, JSON.stringify(this.config));
    this.usingDefault = false;
  },

  /** กลับไปใช้ค่าที่ฝังในโค้ด (ลบค่าที่ผู้ใช้กรอกทับไว้) */
  useDefaultConfig() {
    localStorage.removeItem(LS_CONFIG);
    this.config = { ...DEFAULT_CONFIG };
    this.usingDefault = true;
  },

  /** เลือกไม่ต่อชีต เก็บข้อมูลในเครื่องอย่างเดียว */
  goOffline() {
    localStorage.setItem(LS_CONFIG, JSON.stringify({ offline: true }));
    this.config = { url: '', token: '' };
    this.usingDefault = false;
  },

  get configured() {
    const u = this.config.url || '';
    return isProxyUrl(u) || /\/(exec|dev)\b/.test(u);
  },

  /** URL แบบ /dev ใช้ได้เฉพาะเจ้าของสคริปต์ที่ล็อกอินอยู่ — คนอื่นเปิดจะไม่ผ่าน */
  get isDevUrl() {
    return /\/dev\b/.test(this.config.url || '');
  },

  loadCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_CACHE) || '{}');
      this.records = Array.isArray(raw.records) ? raw.records : [];
      this.rev++;
      this.campaigns = Array.isArray(raw.campaigns) ? raw.campaigns : [];
      this.metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
      this.leads = Array.isArray(raw.leads) ? raw.leads : [];
      if (Array.isArray(raw.products) && raw.products.length) Taxonomy.set(raw.products);
    } catch {
      this.records = [];
      this.campaigns = [];
      this.metrics = [];
      this.leads = [];
    }
  },
  saveCache() {
    try {
      localStorage.setItem(LS_CACHE, JSON.stringify({
        records: this.records, campaigns: this.campaigns, products: Taxonomy.list,
        metrics: this.metrics, leads: this.leads, savedAt: new Date().toISOString()
      }));
    } catch (e) {
      toast('พื้นที่เก็บในเบราว์เซอร์เต็ม — แนะนำให้เชื่อม Google Sheet');
    }
  },

  /** ข้อมูลแคมเปญหนึ่งรายการ (สินค้า/ช่องทาง) */
  campaign(name) {
    return this.campaigns.find(c => c.name === String(name || '').trim()) || null;
  },

  /** ตั้งงบ/bid ของแคมเปญ — เก็บที่ชีต CAMPAIGNS ไม่สร้างบันทึกในไทม์ไลน์ */
  async saveCampaignSettings(name, { budget, bid }) {
    name = String(name || '').trim();
    if (!name) return;
    const patch = {
      name,
      budget: budget === '' || budget === null || budget === undefined ? '' : String(budget),
      bid: bid === '' || bid === null || bid === undefined ? '' : String(bid),
      settings_updated: todayISO(),
      active: true
    };
    const i = this.campaigns.findIndex(c => c.name === name);
    if (i >= 0) this.campaigns[i] = { ...this.campaigns[i], ...patch };
    else this.campaigns.push({ ...patch, product: '', note: '' });
    this.rev++;
    if (this.online) await this.call('saveCampaign', { campaign: patch });
    this.saveCache();
  },

  async saveCampaignMeta(name, product) {
    name = String(name || '').trim();
    if (!name) return;
    const payload = { name, product: product || '', active: true };
    const i = this.campaigns.findIndex(c => c.name === name);
    if (i >= 0) this.campaigns[i] = { ...this.campaigns[i], ...payload };
    else this.campaigns.push({ ...payload, note: '' });
    if (this.online) await this.call('saveCampaign', { campaign: payload });
    this.saveCache();
  },

  async saveProducts(list) {
    Taxonomy.set(list);
    if (this.online) await this.call('saveProducts', { products: Taxonomy.list });
    this.saveCache();
  },

  /** ยิงคำสั่งเดียว ไม่ retry — ใช้ภายใน call() */
  async callOnce(action, payload, timeoutMs) {
    // ผ่านตัวกลาง = ไม่ต้องแนบ token ฝั่งเซิร์ฟเวอร์เติมให้เอง
    const body = isProxyUrl(this.config.url)
      ? JSON.stringify({ action, ...payload })
      : JSON.stringify({ action, token: this.config.token, ...payload });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(this.config.url, {
        method: 'POST',
        // text/plain เพื่อเลี่ยง CORS preflight ที่ Apps Script ไม่รองรับ
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow',
        signal: ctrl.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`Google ไม่ตอบภายใน ${Math.round(timeoutMs / 1000)} วินาที`);
        e.retryable = true;
        throw e;
      }
      // fetch ล้มเหลวก่อนได้ response = เน็ตหลุด หรือ URL ผิด/ถูกบล็อก
      const e = new Error('ต่อเน็ตไปหา Google ไม่ได้ (ตรวจอินเทอร์เน็ต หรือ URL อาจไม่ถูกต้อง)');
      e.retryable = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // 404 ที่ตัวกลาง = ยังไม่ได้ deploy function ตัวนี้ (มักเพราะยังอยู่บน GitHub Pages)
      if (isProxyUrl(this.config.url) && res.status === 404) {
        const e = new Error('ยังไม่พบตัวกลางที่ /api/sheet — เว็บนี้ยังไม่ได้อยู่บน Cloudflare Pages ' +
          'หรือยังไม่ได้อัปโฟลเดอร์ functions/ ขึ้นไป');
        e.proxyMissing = true;
        throw e;
      }
      const e = new Error(`เซิร์ฟเวอร์ตอบกลับรหัส HTTP ${res.status}`);
      e.retryable = res.status >= 500;
      throw e;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // ถ้าได้ HTML กลับมา แปลว่า Deploy ไม่ได้เปิดเป็น Anyone (Google เด้งหน้า login)
      const looksLikeLogin = /accounts\.google|ServiceLogin|<html/i.test(text);
      throw new Error(looksLikeLogin
        ? 'Google ส่งหน้า login กลับมาแทนข้อมูล — แปลว่า Deploy ยังไม่ได้ตั้ง "Who has access: Anyone"'
        : 'ตอบกลับไม่ใช่ JSON: ' + text.slice(0, 120));
    }
    if (!data.ok) throw new Error(data.error || 'เกิดข้อผิดพลาดฝั่ง Apps Script');
    return data;
  },

  /** ยิงคำสั่งพร้อม retry — Apps Script ที่ไม่ได้ใช้งานสักพักจะตอบช้าในครั้งแรก (cold start) */
  async call(action, payload = {}, { retries = 2, timeoutMs = 25000 } = {}) {
    if (!this.configured) throw new Error('ยังไม่ได้ตั้งค่า Web App URL');
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.callOnce(action, payload, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (!err.retryable || attempt === retries) break;
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  },

  async sync() {
    if (!this.configured) {
      this.online = false;
      this.status = 'local';
      this.loadCache();
      return { mode: 'local' };
    }
    this.status = 'connecting';
    updateConnBadge();
    try {
      const data = await this.call('list');
      // โหลดหมวดหมู่และแคมเปญก่อน เพราะ record อ้างอิงข้อมูลสองอย่างนี้
      if (Array.isArray(data.products) && data.products.length) Taxonomy.set(data.products);
      this.campaigns = mergeCampaigns(this.campaigns, data.campaigns || []);
      if (Array.isArray(data.metrics)) this.metrics = data.metrics;
      if (Array.isArray(data.leads)) this.leads = data.leads;
      this.serverVersion = String(data.version || '');
      this.records = (data.records || []).map(normalizeRecord);
      this.rev++;
      this.online = true;
      this.status = 'online';
      this.lastError = '';
      this.lastSyncAt = new Date().toISOString();
      this.saveCache();
      return { mode: 'sheet' };
    } catch (err) {
      this.online = false;
      this.status = 'error';
      this.lastError = String(err.message || err);
      this.loadCache();
      return { mode: 'error', error: this.lastError };
    }
  },

  /** เวอร์ชัน Code.gs ที่ deploy อยู่จริง — ใช้เตือนเมื่อยังไม่ได้อัปเดต */
  serverVersion: '',

  /** ตัวเลขรายวันจาก Google Ads (ชีต METRICS) — ว่างถ้ายังไม่ได้ตั้งสคริปต์ */
  metrics: [],

  newId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  async create(rec) {
    rec.id = rec.id || this.newId();
    rec.created_at = rec.created_at || new Date().toISOString();
    rec.updated_at = new Date().toISOString();
    if (this.online) await this.call('create', { record: rec });
    this.records.push(rec);
    this.touchCampaign(rec);
    this.rev++;
    this.saveCache();
    return rec;
  },

  async update(rec) {
    rec.updated_at = new Date().toISOString();
    if (this.online) await this.call('update', { record: rec });
    const i = this.records.findIndex(r => r.id === rec.id);
    if (i >= 0) this.records[i] = { ...this.records[i], ...rec };
    else this.records.push(rec);
    this.touchCampaign(rec);
    this.rev++;
    this.saveCache();
    return rec;
  },

  async remove(id) {
    if (this.online) await this.call('delete', { id });
    this.records = this.records.filter(r => r.id !== id);
    this.rev++;
    this.saveCache();
  },

  async bulkCreate(list) {
    list.forEach(r => {
      r.id = r.id || this.newId();
      r.created_at = r.created_at || new Date().toISOString();
      r.updated_at = new Date().toISOString();
      this.touchCampaign(r);
    });
    if (this.online) await this.call('bulkCreate', { records: list });
    this.records.push(...list);
    this.rev++;
    this.saveCache();
    return list.length;
  },

  touchCampaign(rec) {
    const name = String((rec && rec.campaign) || '').trim();
    if (!name) return;
    const existing = this.campaigns.find(c => c.name === name);
    if (!existing) {
      this.campaigns.push({
        name, product: rec.product || '', note: '', active: true
      });
      return;
    }
    // เติมให้เฉพาะช่องที่ยังว่าง — ไม่ทับของที่ตั้งไว้แล้ว
    if (!existing.product && rec.product) existing.product = rec.product;
  },

  /** บันทึกทั้งหมด เรียงจากใหม่ → เก่า */
  sorted() {
    return [...this.records].sort((a, b) => {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      return d !== 0 ? d : String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  },

  /** บันทึกล่าสุดของแคมเปญที่ระบุ (ก่อนวันที่ที่กำหนด) */
  latestFor(campaign, beforeDate, excludeId) {
    return this.sorted().find(r =>
      r.campaign === campaign &&
      r.id !== excludeId &&
      (!beforeDate || String(r.date || '') <= String(beforeDate)));
  },

  /** จุดวัดผลล่าสุด — ข้ามบันทึกที่ไม่มีตัวเลข ไม่ว่าจะห่างกี่วัน */
  latestMeasured(campaign, beforeDate, excludeId) {
    return this.sorted().find(r =>
      r.campaign === campaign &&
      r.id !== excludeId &&
      isMeasured(r) &&
      (!beforeDate || String(r.date || '') <= String(beforeDate)));
  },

  /** บันทึกการปรับที่เกิดหลังจุดวัดผลล่าสุด (ยังไม่ได้วัด) */
  adjustmentsSince(campaign, sinceDate, beforeDate, excludeId) {
    return this.sorted().filter(r =>
      r.campaign === campaign &&
      r.id !== excludeId &&
      hasAdjustment(r) &&
      String(r.date || '') >= String(sinceDate || '') &&
      (!beforeDate || String(r.date || '') <= String(beforeDate)));
  },

  /** บันทึกถัดไปของแคมเปญเดียวกัน (ใหม่กว่า) */
  nextFor(rec) {
    const list = this.sorted().filter(r => r.campaign === rec.campaign && r.id !== rec.id);
    const newer = list.filter(r => String(r.date || '') >= String(rec.date || ''));
    return newer.length ? newer[newer.length - 1] : null;
  }
};

/* ตัวอ่านหมวดหมู่ของบันทึก — ถ้าบันทึกไม่ได้ระบุไว้ จะย้อนไปดูที่แคมเปญ
   ทำแบบนี้เพื่อให้บันทึกเก่า (ก่อนมีระบบหมวดหมู่) ใช้งานได้ทันทีเมื่อตั้งค่าแคมเปญแล้ว */
function recProduct(rec) {
  return String(rec.product || '').trim() || Store.campaign(rec.campaign)?.product || '';
}
function recGroup(rec) {
  const p = recProduct(rec);
  return p ? Taxonomy.groupOf(p) : String(rec.product_group || '').trim();
}

/** "1.3.0" >= "1.3.0" */
function versionAtLeast(have, want) {
  const a = String(have || '').split('.').map(n => parseInt(n, 10) || 0);
  const b = String(want || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

/** ชีตยังไม่รู้จักคอลัมน์ที่เวอร์ชันนี้ต้องใช้หรือเปล่า
 *  1.3.0 = budget/bid · 1.5.0 = ชีต METRICS · 1.6.0 = cpc_ceiling + auto_key
 *  1.7.0 = ชีต LEADS (GA4) + อ่าน API_TOKEN จาก Script Properties */
const SHEET_MIN_VERSION = '1.7.0';
function sheetNeedsUpgrade() {
  if (!Store.online || !Store.serverVersion) return false;
  return !versionAtLeast(Store.serverVersion, SHEET_MIN_VERSION);
}

/**
 * รวมรายการแคมเปญจากชีตกับที่มีอยู่ในเครื่อง
 * ค่าจากชีตชนะเสมอ "ยกเว้น" ช่องที่ชีตไม่มีค่ามาให้ — ช่องนั้นเก็บของเดิมไว้
 * (กันงบ/bid หายตอนชีตยังไม่มีคอลัมน์เหล่านี้)
 */
const KEEP_IF_MISSING = ['budget', 'bid', 'settings_updated'];
function mergeCampaigns(local, remote) {
  const byName = new Map((local || []).map(c => [String(c.name || '').trim(), c]));
  return (remote || []).map(rc => {
    const prev = byName.get(String(rc.name || '').trim());
    if (!prev) return rc;
    const out = { ...rc };
    for (const k of KEEP_IF_MISSING) {
      const incoming = rc[k];
      const missing = incoming === undefined || incoming === null || String(incoming).trim() === '';
      if (missing && prev[k] !== undefined && String(prev[k]).trim() !== '') out[k] = prev[k];
    }
    return out;
  });
}

function normalizeRecord(raw) {
  const r = { ...raw };
  if (r.date) r.date = toISO(parseDate(r.date)) || String(r.date);
  for (const side of ['before', 'after']) {
    for (const suf of ['start', 'end']) {
      const k = `${side}_${suf}`;
      if (r[k]) r[k] = toISO(parseDate(r[k])) || String(r[k]);
    }
  }
  return r;
}

/* ─────────────────────────────────────────────────────────────
   5. แท็บ
   ───────────────────────────────────────────────────────────── */

const PANELS = ['new', 'timeline', 'dashboard', 'trend', 'spend', 'budget', 'leads', 'data'];

function showTab(name) {
  for (const p of PANELS) {
    const tab = $(`#tab-${p}`);
    tab.setAttribute('aria-selected', String(p === name));
    // roving tabindex: Tab เข้ามาที่เมนูครั้งเดียว แล้วใช้ลูกศรเลื่อนต่อ (มาตรฐาน tablist)
    tab.tabIndex = p === name ? 0 : -1;
    $(`#panel-${p}`).hidden = p !== name;
  }
  location.hash = name;
  if (name === 'timeline') { renderInbox(); renderTimeline(); }
  if (name === 'dashboard') renderDashboard();
  if (name === 'trend') renderTrend();
  if (name === 'spend') renderSpendPage();
  if (name === 'budget') renderBudgetPage();
  if (name === 'leads') renderLeadPage();
  if (name === 'data') { renderTaxonomyEditor(); renderConnStatusBox(); }
}

/* ─────────────────────────────────────────────────────────────
   6. ฟอร์มบันทึก
   ───────────────────────────────────────────────────────────── */

const Form = {
  selectedTags: new Set(),
  editingId: null,
  productTouched: false,
  lastCampaign: '',
  baseline: null,

  init() {
    // แท็ก
    const wrap = $('#tagChips');
    wrap.innerHTML = '';
    for (const t of TAGS) {
      wrap.append(el('button', {
        type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-tag': t, text: t,
        onclick: e => {
          const on = e.currentTarget.getAttribute('aria-pressed') === 'true';
          e.currentTarget.setAttribute('aria-pressed', String(!on));
          if (on) this.selectedTags.delete(t); else this.selectedTags.add(t);
          this.renderTagForms();
          if (!on && TAG_FORMS[t]) {
            setTimeout(() => $(`#tagform-${slug(t)} input, #tagform-${slug(t)} textarea,
              #tagform-${slug(t)} select`)?.focus(), 60);
          }
        }
      }));
    }

    buildMetricFields($('#beforeFields'), 'before', () => this.onMetricInput('before'));
    buildMetricFields($('#afterFields'), 'after', () => this.onMetricInput('after'));

    this.buildTaxonomySelects();

    $('#f_change_detail').addEventListener('input', e => {
      // พิมพ์เองเมื่อไหร่ ระบบเลิกเขียนทับทันที
      if (e.isTrusted) { delete e.target.dataset.auto; e.target.classList.remove('is-auto'); }
    });

    $('#f_date').value = todayISO();
    $('#f_campaign').addEventListener('input', () => this.onCampaignInput());
    $('#f_campaign').addEventListener('change', () => { this.onCampaignInput(); this.refreshBaseline(); });
    $('#f_product').addEventListener('change', () => {
      this.productTouched = true;              // ผู้ใช้เลือกเอง — ห้ามระบบทับ
      $('#badge_product_auto').hidden = true;
      this.syncGroupView();
      this.refreshCampaignList();
    });
    $('#f_date').addEventListener('change', () => {
      // วันสิ้นสุดที่ระบบเติมให้ ต้องขยับตามวันที่ปรับ
      const end = $('#before_end');
      if (end && end.dataset.autoDate === '1') end.value = $('#f_date').value;
      this.refreshBaseline();
    });
    $('#resetBtn').addEventListener('click', () => this.reset());
    $('#deleteBtn').addEventListener('click', () => this.remove());
    $('#saveAddBtn').addEventListener('click', () => this.save(true));
    $('#recordForm').addEventListener('submit', e => { e.preventDefault(); this.save(); });
    this.initDetailSuggest();
  },

  onMetricInput(side) {
    applyDerived(side === 'before' ? $('#beforeFields') : $('#afterFields'), side,
      side === 'before' ? $('#beforeDerived') : $('#afterDerived'));
    renderAdsPull(side, $('#f_campaign')?.value.trim() || '');
    if (side === 'before') this.updateComparison();
  },

  /** สร้าง dropdown สินค้า (จัดกลุ่มด้วย optgroup) และช่องทาง */
  buildTaxonomySelects() {
    const ps = $('#f_product');
    const keep = ps.value;
    ps.innerHTML = '';
    ps.append(el('option', { value: '' }, '— ยังไม่ระบุ —'));
    for (const g of Taxonomy.groups()) {
      const og = el('optgroup', { label: g });
      for (const p of Taxonomy.products(g)) og.append(el('option', { value: p }, p));
      ps.append(og);
    }
    if (keep) ps.value = keep;
    this.syncGroupView();
  },

  syncGroupView() {
    const p = $('#f_product').value;
    $('#f_group_view').textContent = p ? Taxonomy.groupOf(p) : '—';
  },

  /** พิมพ์/เลือกแคมเปญแล้วเติมสินค้า+ช่องทางให้ — ถ้าแคมเปญใหม่ก็เดาจากชื่อ */
  onCampaignInput() {
    const name = $('#f_campaign').value.trim();
    const hint = $('#campaignHint');
    // เปลี่ยนไปแคมเปญอื่น = ค่าที่ค้างอยู่เป็นของแคมเปญเก่า ให้ระบบเติมใหม่ได้
    if (name !== this.lastCampaign) {
      this.lastCampaign = name;
      this.productTouched = false;
    }
    if (!name) { hint.textContent = ''; return; }

    const known = Store.campaign(name);
    if (known && known.product) {
      if (!this.productTouched) $('#f_product').value = known.product;
      $('#badge_product_auto').hidden = true;
      hint.textContent = `แคมเปญนี้ตั้งไว้แล้วว่าเป็นสินค้า ${known.product}`;
      this.syncGroupView();
      return;
    }

    const guess = guessFromCampaignName(name);
    if (!this.productTouched) {
      $('#f_product').value = guess.product || '';
      $('#badge_product_auto').hidden = !guess.product;
    }
    this.syncGroupView();
    hint.textContent = known
      ? 'แคมเปญนี้ยังไม่ได้ตั้งสินค้า — เลือกครั้งนี้แล้วระบบจะจำไว้ให้'
      : guess.product
        ? `แคมเปญใหม่ — เดาจากชื่อได้ว่าเป็น ${guess.product} (แก้ทับได้)`
        : 'แคมเปญใหม่ — เลือกสินค้าด้วย ระบบจะจำไว้ใช้ครั้งต่อไป';
  },

  /**
   * แคมเปญที่แตะบ่อยสุดช่วง 14 วัน — กดชิปแทนการพิมพ์ชื่อยาวๆ
   * เรียงตามจำนวนครั้ง แล้วค่อยตามด้วยความสดใหม่ สูงสุด 6 ตัว
   */
  renderRecentChips() {
    const wrap = $('#recentCampaigns');
    const box = $('#recentChips');
    const since = isoOffset(-14);
    const tally = new Map();
    for (const r of Store.sorted()) {
      if (!r.campaign || r.date < since) continue;
      const cur = tally.get(r.campaign) || { n: 0, last: r.date };
      cur.n++;
      if (r.date > cur.last) cur.last = r.date;
      tally.set(r.campaign, cur);
    }
    const top = [...tally.entries()]
      .sort((a, b) => b[1].n - a[1].n || (a[1].last < b[1].last ? 1 : -1))
      .slice(0, 6);

    wrap.hidden = top.length < 2;   // มีอันเดียวก็ไม่ต้องมีชิปให้เลือก
    if (wrap.hidden) return;

    const active = $('#f_campaign').value.trim();
    box.innerHTML = '';
    for (const [name, info] of top) {
      const btn = el('button', {
        type: 'button', class: 'chip chip-campaign',
        'aria-pressed': String(name === active),
        title: `${name} — ปรับ ${info.n} ครั้งใน 14 วัน`,
        onclick: () => {
          $('#f_campaign').value = name;
          this.onCampaignInput();
          this.refreshBaseline();
          this.renderRecentChips();
          $('#f_change_detail').focus();
        }
      }, name);
      btn.append(el('small', {}, String(info.n)));
      box.append(btn);
    }
  },

  /** วาด/ลบกล่องช่องกรอกของแต่ละประเภทที่เลือกไว้ โดยไม่ล้างค่าที่พิมพ์ไปแล้ว */
  renderTagForms() {
    const host = $('#tagForms');
    if (!host) return;
    const want = TAGS.filter(t => this.selectedTags.has(t) && TAG_FORMS[t]);

    // ลบกล่องของประเภทที่ยกเลิกไป
    for (const box of $$('#tagForms .tagform')) {
      if (!want.includes(box.dataset.tag)) box.remove();
    }
    // เพิ่มกล่องใหม่ เรียงตามลำดับชิป
    for (const t of want) {
      if ($(`#tagform-${slug(t)}`)) continue;
      host.append(this.buildTagForm(t));
    }
    host.hidden = want.length === 0;
    this.composeDetail();
  },

  buildTagForm(tag) {
    const spec = TAG_FORMS[tag];
    const box = el('div', { class: 'tagform', id: `tagform-${slug(tag)}`, 'data-tag': tag });
    box.append(el('div', { class: 'tagform-head' },
      el('b', {}, tag),
      el('button', {
        type: 'button', class: 'tf-close', 'aria-label': `เอา ${tag} ออก`,
        onclick: () => {
          this.selectedTags.delete(tag);
          const chip = $$('#tagChips .chip').find(c => c.dataset.tag === tag);
          chip?.setAttribute('aria-pressed', 'false');
          this.renderTagForms();
        }
      }, '✕')));

    const row = el('div', { class: 'tagform-row' });
    for (const f of spec.fields) {
      const id = `tf_${slug(tag)}_${f.key}`;
      let input;
      if (f.type === 'select') {
        input = el('select', { id, onchange: () => this.composeDetail() },
          el('option', { value: '' }, '— เลือก —'),
          f.options.map(o => el('option', { value: o }, o)));
      } else if (f.type === 'lines') {
        input = el('textarea', { id, rows: 3, placeholder: f.placeholder || '',
          oninput: () => this.composeDetail() });
      } else {
        input = el('input', { type: f.type === 'number' ? 'number' : 'text', id,
          step: f.step || null, inputmode: f.type === 'number' ? 'decimal' : null,
          placeholder: f.placeholder || '', oninput: () => this.composeDetail() });
      }
      // เติมค่าเดิมจากที่ตั้งไว้ในแคมเปญ (งบ/bid) ให้อัตโนมัติ
      if (f.fillFrom) {
        const prev = latestSetting($('#f_campaign').value.trim(), f.fillFrom);
        if (prev) { input.value = prev.value; input.dataset.auto = '1'; }
      }
      row.append(el('label', { class: `field${f.type === 'lines' ? ' grow-all' : ''}` },
        el('span', { class: 'field-label' }, f.label,
          f.unit ? el('span', { class: 'field-unit' }, f.unit) : null),
        input));
    }
    box.append(row);
    return box;
  },

  /** อ่านค่าที่กรอกในกล่องประเภทหนึ่ง */
  readTagForm(tag) {
    const out = {};
    for (const f of (TAG_FORMS[tag]?.fields || [])) {
      out[f.key] = ($(`#tf_${slug(tag)}_${f.key}`)?.value || '').trim();
    }
    return out;
  },

  /**
   * ประกอบข้อความ "รายละเอียดสิ่งที่ปรับ" จากกล่องต่าง ๆ ให้อัตโนมัติ
   * ถ้าผู้ใช้พิมพ์เองไปแล้ว จะไม่ทับให้ (ดูที่ dataset.auto)
   */
  composeDetail() {
    const box = $('#f_change_detail');
    if (!box) return;
    if (box.value.trim() && box.dataset.auto !== '1') return;   // ข้อความที่พิมพ์เอง ห้ามแตะ

    // เรียงตามลำดับกล่องบนหน้าจอ ประโยคจะได้ตรงกับที่เห็น
    const parts = $$('#tagForms .tagform')
      .map(b => b.dataset.tag)
      .filter(t => TAG_FORMS[t])
      .map(t => TAG_FORMS[t].text(this.readTagForm(t)))
      .filter(Boolean);

    if (!parts.length) {
      if (box.dataset.auto === '1') { box.value = ''; delete box.dataset.auto; box.classList.remove('is-auto'); }
      return;
    }
    box.value = parts.join(' · ');
    box.dataset.auto = '1';
    box.classList.add('is-auto');
  },

  /** งบ/bid ที่กรอกในกล่องประเภท — เอาไปอัปเดตค่าปัจจุบันของแคมเปญด้วย */
  tagFormSettings() {
    const out = {};
    for (const [tag, spec] of Object.entries(TAG_FORMS)) {
      if (!spec.setting || !this.selectedTags.has(tag)) continue;
      const v = this.readTagForm(tag).to;
      if (v !== '' && num(v) !== null) out[spec.setting] = v;
    }
    return out;
  },

  refreshCampaignList() {
    const dl = $('#campaignList');
    dl.innerHTML = '';
    const product = $('#f_product').value;
    // ถ้าเลือกสินค้าไว้แล้ว ให้เสนอเฉพาะแคมเปญของสินค้านั้นก่อน แล้วค่อยตามด้วยที่เหลือ
    const mine = Store.campaigns.filter(c => product && c.product === product);
    const rest = Store.campaigns.filter(c => !mine.includes(c));
    for (const c of [...mine, ...rest]) {
      dl.append(el('option', { value: c.name }, c.product || ''));
    }
    // ถ้ายังไม่ได้เลือกแคมเปญ ให้เดาเป็นแคมเปญที่เพิ่งบันทึกล่าสุด
    const field = $('#f_campaign');
    if (!field.value) {
      const last = Store.sorted()[0];
      field.value = last?.campaign || Store.campaigns[0]?.name || '';
      if (field.value) { this.onCampaignInput(); this.refreshBaseline(); }
    }
    this.renderRecentChips();
  },

  /** หาบันทึกก่อนหน้าของแคมเปญเดียวกัน แล้วใช้ตัวเลขของมันเป็นฐานเปรียบเทียบ
   *  ไม่ก๊อปตัวเลขลงช่อง — แค่เอามาโชว์และคำนวณ % ให้ตอนพิมพ์ */
  refreshBaseline() {
    const campaign = $('#f_campaign').value.trim();
    this.baseline = null;

    if (campaign) {
      // ข้ามบันทึกที่ไม่มีตัวเลขไปหาจุดวัดผลจริง ไม่ว่าจะห่างกี่วัน
      const prev = Store.latestMeasured(campaign, $('#f_date').value, this.editingId);
      if (prev) {
        const since = Store.adjustmentsSince(campaign, prev.date, $('#f_date').value, this.editingId);
        this.baseline = {
          record: prev,
          block: block(prev, 'before'),
          adjustments: since,
          label: since.length > 1
            ? `ผลรวมของการปรับ ${since.length} ครั้งในรอบนี้`
            : 'ผลของการปรับในรอบนี้'
        };
      }
    }

    // ค่า "เดิม" ในกล่องงบ/bid ผูกกับแคมเปญ เปลี่ยนแคมเปญต้องเติมใหม่
    for (const [tag, spec] of Object.entries(TAG_FORMS)) {
      if (!spec.setting || !this.selectedTags.has(tag)) continue;
      const input = $(`#tf_${slug(tag)}_from`);
      if (!input || (input.value && input.dataset.auto !== '1')) continue;
      const prev = latestSetting(campaign, spec.setting);
      input.value = prev ? prev.value : '';
      if (prev) input.dataset.auto = '1'; else delete input.dataset.auto;
    }

    this.fillDefaultDates();
    this.renderBaselineStrip();
    this.updateComparison();
    for (const side of ['before', 'after']) renderAdsPull(side, campaign);

    const sum = $('#numbersSummary');
    if (sum) {
      const n = this.baseline?.adjustments?.length || 0;
      sum.textContent = n
        ? `ใส่ตัวเลขวัดผล — ปิดรอบที่ปรับไปแล้ว ${n} ครั้ง`
        : 'ใส่ตัวเลขวัดผลรอบนี้';
    }
  },

  /** ช่วงวันที่: เริ่ม = วันที่บันทึกครั้งก่อน · สิ้นสุด = วันที่ปรับครั้งนี้ */
  fillDefaultDates() {
    const start = $('#before_start'), end = $('#before_end');
    if (!start || !end) return;
    if (!start.value && this.baseline) {
      const prev = this.baseline.record;
      start.value = prev.after_end || prev.before_end || prev.date || '';
      if (start.value) start.dataset.autoDate = '1';
    }
    if (!end.value) {
      end.value = $('#f_date').value || todayISO();
      end.dataset.autoDate = '1';
    }
  },

  /** แถบอ้างอิงตัวเลขครั้งก่อน */
  renderBaselineStrip() {
    const host = $('#baselineStrip');
    if (!host) return;
    host.innerHTML = '';
    const campaign = $('#f_campaign').value.trim();
    if (!campaign) return;

    if (!this.baseline) {
      host.append(el('div', { class: 'baseline-strip is-empty' },
        el('span', { class: 'icon' }, '🌱'),
        el('span', {}, 'บันทึกแรกของแคมเปญนี้ — กรอกตัวเลขไว้เป็นฐาน ครั้งหน้าระบบจะเทียบให้อัตโนมัติ')));
      return;
    }

    const b = solveBlock(this.baseline.block).values;
    const prev = this.baseline.record;
    const strip = el('div', { class: 'baseline-strip' },
      el('span', { class: 'bl-head' },
        el('b', {}, 'วัดผลล่าสุด'), ' ', thaiDate(prev.date)));

    for (const key of ['impressions', 'ctr', 'cpc', 'conversions', 'cpa']) {
      if (b[key] === null) continue;
      strip.append(el('span', { class: 'calc-item' },
        el('span', { class: 'k' }, METRIC_BY_KEY[key].short),
        el('span', { class: 'v' }, fmtMetric(key, b[key]))));
    }

    strip.append(el('button', {
      type: 'button', class: 'link', style: 'margin-left:auto',
      title: 'ใส่ตัวเลขชุดเดิมลงช่อง เผื่ออยากแก้ทีละตัว',
      onclick: () => this.copyBaselineIntoFields()
    }, 'คัดลอกมาแก้'));

    const since = this.baseline.adjustments || [];
    if (since.length) {
      strip.append(el('div', { class: 'bl-detail' },
        el('b', {}, `ตั้งแต่นั้นปรับไปแล้ว ${since.length} ครั้ง: `),
        since.slice(0, 4).map(r => String(r.change_detail).replace(/\s+/g, ' ').slice(0, 40)).join(' · ') +
        (since.length > 4 ? ` · +อีก ${since.length - 4}` : '')));
    } else {
      strip.append(el('div', { class: 'bl-detail' }, 'ยังไม่มีการปรับหลังจากวัดผลครั้งนั้น'));
    }
    host.append(strip);
  },

  copyBaselineIntoFields() {
    if (!this.baseline) return;
    const b = solveBlock(this.baseline.block).values;
    clearAutoFlags('before');
    for (const m of METRICS) {
      $(`#before_${m.key}`).value = b[m.key] === null ? '' : round(b[m.key], m.dec);
    }
    this.onMetricInput('before');
    toast('คัดลอกตัวเลขครั้งก่อนมาแล้ว — แก้ทับได้เลย');
  },

  /** คำนวณ % เทียบกับ baseline แล้วเติมข้าง ๆ ทุกช่อง + สรุปรวมท้ายกล่อง */
  updateComparison() {
    const clear = () => {
      for (const m of METRICS) {
        const span = $(`#d_before_${m.key}`);
        if (span) { span.textContent = ''; span.className = 'delta-inline'; }
      }
      $('#livePreview').innerHTML = '';
    };

    const cur = readBlock('before');
    if (!this.baseline || !hasNumbers(cur)) { clear(); return; }

    const cmp = compareBlocks(this.baseline.block, cur, 'auto');

    for (const m of METRICS) {
      const span = $(`#d_before_${m.key}`);
      if (!span) continue;
      const row = cmp.rows.find(r => r.key === m.key);
      if (!row || row.deltaPct === null) { span.textContent = ''; span.className = 'delta-inline'; continue; }
      const cls = row.good === null ? 'delta-flat' : row.good ? 'delta-up' : 'delta-down';
      const arrow = row.dir === 'up' ? '▲' : row.dir === 'down' ? '▼' : '＝';
      span.className = `delta-inline ${cls}`;
      span.textContent = `${arrow}${fmt(Math.abs(row.deltaPct), 1)}%`;
      span.title = `ครั้งก่อน ${fmtMetric(m.key, row.before)}` + (row.perDay ? ' (ต่อวัน)' : '');
    }

    const host = $('#livePreview');
    host.innerHTML = '';
    const since = this.baseline.adjustments || [];
    host.append(el('div', { class: 'verdict-panel' },
      el('div', { class: 'card-head', style: 'margin-bottom:12px' },
        el('h3', {}, this.baseline.label),
        verdictBadge(cmp.verdict)),
      since.length > 1 ? el('p', { class: 'card-note', style: 'margin-bottom:12px' },
        `รอบนี้มีการปรับ ${since.length} ครั้ง — ตัวเลขที่เปลี่ยนคือผลรวมของทั้งหมด ` +
        'แยกไม่ได้ว่าครั้งไหนทำให้ดีขึ้น') : null,
      cmp.perDay ? el('p', { class: 'card-note', style: 'margin-bottom:12px' },
        `ช่วงก่อน ${cmp.bDays} วัน · ช่วงนี้ ${cmp.aDays} วัน — ตัวเลขสะสมถูกแปลงเป็นค่าเฉลี่ยต่อวันก่อนเทียบ`) : null,
      deltaTiles(cmp)));
  },

  /**
   * เปิดฟอร์มเป็น "ร่างใหม่" ที่เติมค่าให้บางส่วน — ไม่ใช่การแก้บันทึกเดิม
   * ใช้ตอนยืนยันสิ่งที่ Google Ads บอกมา
   */
  draft(ch) {
    this.load({ id: '', date: ch.date, campaign: ch.campaign, tags: ch.tag });
    this.editingId = null;
    $('#f_id').value = '';
    $('#formTitle').textContent = 'บันทึกการปรับใหม่';
    $('#formHint').textContent = 'เติมจาก Google Ads ให้แล้ว — ตรวจดูแล้วใส่เหตุผลด้วย';
    $('#deleteBtn').hidden = true;
    this.autoKey = ch.key || '';

    // ใส่ค่า "จาก → เป็น" ลงฟอร์มย่อยของแท็ก แล้วให้ระบบประกอบข้อความเอง
    const put = (key, v) => {
      const inp = $(`#tf_${slug(ch.tag)}_${key}`);
      if (!inp || v === null || v === undefined || v === '') return;
      inp.value = v;
    };
    put('from', ch.formFrom);
    put('to', ch.formTo);
    this.composeDetail();
    // เผื่อแท็กนั้นไม่มีฟอร์มย่อย จะได้ไม่เหลือช่องว่างเปล่า
    if (!$('#f_change_detail').value.trim()) $('#f_change_detail').value = ch.detail;

    setTimeout(() => $('#f_reason')?.focus(), 150);
  },

  load(rec) {
    this.editingId = rec ? rec.id : null;
    this.autoKey = rec?.auto_key || '';
    $('#f_id').value = rec ? rec.id : '';
    $('#formTitle').textContent = rec ? 'แก้ไขบันทึก' : 'บันทึกการปรับใหม่';
    $('#formHint').textContent = rec ? `แก้ไขบันทึกวันที่ ${thaiDate(rec.date)}` : '';
    $('#deleteBtn').hidden = !rec;

    $('#f_date').value = rec?.date || todayISO();
    $('#f_campaign').value = rec?.campaign || '';
    $('#f_ad_group').value = rec?.ad_group || '';
    $('#badge_product_auto').hidden = true;
    $('#f_product').value = rec ? recProduct(rec) : '';
    // ค่าที่โหลดมาจากบันทึกถือว่าตั้งใจไว้แล้ว ระบบไม่ควรเดาทับ
    this.productTouched = !!(rec && recProduct(rec));
    this.lastCampaign = rec?.campaign || '';
    this.syncGroupView();
    $('#campaignHint').textContent = '';
    $('#f_change_detail').value = rec?.change_detail || '';
    $('#f_reason').value = rec?.reason || '';
    $('#f_expected').value = rec?.expected || '';
    $('#f_result_note').value = rec?.result_note || '';

    this.selectedTags = new Set(String(rec?.tags || '').split('|').map(s => s.trim()).filter(Boolean));
    $$('#tagChips .chip').forEach(c =>
      c.setAttribute('aria-pressed', String(this.selectedTags.has(c.dataset.tag))));
    // บันทึกเก่ามีข้อความอยู่แล้ว ถือว่าเป็นของผู้ใช้ ห้ามเขียนทับ
    delete $('#f_change_detail').dataset.auto;
    $('#f_change_detail').classList.remove('is-auto');
    $$('#tagForms .tagform').forEach(b => b.remove());
    this.renderTagForms();

    for (const side of ['before', 'after']) {
      clearAutoFlags(side);
      $(`#${side}_start`).value = rec?.[`${side}_start`] || '';
      $(`#${side}_end`).value = rec?.[`${side}_end`] || '';
      for (const m of METRICS) {
        const v = rec ? num(rec[`${side}_${m.key}`]) : null;
        $(`#${side}_${m.key}`).value = v === null ? '' : round(v, m.dec);
      }
      this.onMetricInput(side);
    }
    // เปิดกล่องตัวเลขเฉพาะตอนแก้บันทึกที่มีตัวเลขอยู่แล้ว
    const box = $('#numbersBox');
    if (box) box.open = !!(rec && isMeasured(rec));

    this.refreshBaseline();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  reset() {
    this.load(null);
    for (const side of ['before', 'after']) {
      clearAutoFlags(side);
      $(`#${side}_start`).value = '';
      $(`#${side}_end`).value = '';
      delete $(`#${side}_start`).dataset.autoDate;
      delete $(`#${side}_end`).dataset.autoDate;
      for (const m of METRICS) $(`#${side}_${m.key}`).value = '';
      this.onMetricInput(side);
    }
    if ($('#afterCard')) $('#afterCard').hidden = true;
    if ($('#numbersBox')) $('#numbersBox').open = false;
    $('#f_product').value = '';
    $('#f_campaign').value = '';
    this.productTouched = false;
    this.lastCampaign = '';
    this.syncGroupView();
    this.refreshCampaignList();
  },

  collect() {
    const rec = {
      id: $('#f_id').value || Store.newId(),
      date: $('#f_date').value,
      product: $('#f_product').value,
      product_group: $('#f_product').value ? Taxonomy.groupOf($('#f_product').value) : '',
      campaign: $('#f_campaign').value.trim(),
      ad_group: $('#f_ad_group').value.trim(),
      tags: [...this.selectedTags].join(' | '),
      change_detail: $('#f_change_detail').value.trim(),
      reason: $('#f_reason').value.trim(),
      expected: $('#f_expected').value.trim(),
      result_note: $('#f_result_note').value.trim(),
      status: hasNumbers(readBlock('after')) ? 'มีผลแล้ว' : 'รอผล',
      // ติดรหัสไว้ถ้าบันทึกนี้มาจากการยืนยันสิ่งที่ Google Ads บอก — กันเสนอซ้ำ
      auto_key: this.autoKey || ''
    };
    for (const side of ['before', 'after']) {
      rec[`${side}_start`] = $(`#${side}_start`).value;
      rec[`${side}_end`] = $(`#${side}_end`).value;
      const solved = solveBlock(readBlock(side)).values;
      for (const m of METRICS) {
        rec[`${side}_${m.key}`] = solved[m.key] === null ? '' : round(solved[m.key], m.dec);
      }
    }
    return rec;
  },

  /** ข้อความ "สิ่งที่ปรับ" ที่เคยพิมพ์ — ใช้เติมอัตโนมัติ */
  detailHistory() {
    const seen = new Map();
    for (const r of Store.sorted()) {
      const t = String(r.change_detail || '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (!seen.has(key)) seen.set(key, t);
    }
    return [...seen.values()];
  },

  initDetailSuggest() {
    const input = $('#f_change_detail');
    const box = $('#detailSuggest');
    let items = [], active = -1;

    const close = () => { box.hidden = true; active = -1; };
    const pick = text => { input.value = text; close(); input.focus(); };

    const refresh = () => {
      const q = input.value.trim().toLowerCase();
      // เสนอเฉพาะตอนพิมพ์บรรทัดเดียวสั้น ๆ ไม่ไปกวนตอนพิมพ์ข้อความยาว
      if (q.length < 2 || input.value.includes('\n')) { close(); return; }
      items = this.detailHistory()
        .filter(t => t.toLowerCase().includes(q) && t.toLowerCase() !== q)
        .slice(0, 6);
      if (!items.length) { close(); return; }
      box.innerHTML = '';
      items.forEach((t, i) => box.append(el('button', {
        type: 'button', class: i === active ? 'active' : '',
        onmousedown: e => { e.preventDefault(); pick(t); }
      }, t)));
      box.hidden = false;
    };

    input.addEventListener('input', refresh);
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', e => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        [...box.children].forEach((c, i) => c.classList.toggle('active', i === active));
      } else if (e.key === 'Tab' || (e.key === 'Enter' && active >= 0)) {
        if (active < 0) active = 0;
        e.preventDefault();
        pick(items[active]);
      } else if (e.key === 'Escape') {
        close();
      }
    });
  },

  async save(keepGoing = false) {
    const rec = this.collect();
    if (!rec.campaign) { toast('กรุณาระบุแคมเปญ'); return; }
    if (!rec.change_detail) { toast('กรุณาระบุรายละเอียดสิ่งที่ปรับ'); return; }

    const btn = $('#saveBtn');
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    $('#saveAddBtn').disabled = true;
    btn.textContent = 'กำลังบันทึก…';
    try {
      const isEdit = !!this.editingId;
      if (isEdit) await Store.update(rec);
      else await Store.create(rec);

      // งบ/bid ที่กรอกในกล่อง "ปรับงบประมาณ"/"ปรับ Bid" = ค่าใหม่ของแคมเปญ
      const settings = this.tagFormSettings();
      if (Object.keys(settings).length) {
        const cur = Store.campaign(rec.campaign) || {};
        await Store.saveCampaignSettings(rec.campaign, {
          budget: settings.budget ?? (cur.budget ?? ''),
          bid: settings.bid ?? (cur.bid ?? '')
        });
      }

      // จำสินค้าไว้ที่แคมเปญ ครั้งหน้าจะได้ไม่ต้องเลือกอีก
      const meta = Store.campaign(rec.campaign);
      if (rec.product && (!meta || !meta.product)) {
        await Store.saveCampaignMeta(rec.campaign, rec.product);
      }

      // ถ้าเป็นบันทึกใหม่ ให้เติม "ผลหลังปรับ" ย้อนกลับไปที่บันทึกก่อนหน้าที่ยังว่างอยู่
      if (!isEdit && hasNumbers(readBlock('before'))) {
        const prev = Store.latestFor(rec.campaign, rec.date, rec.id);
        if (prev && !hasNumbers(block(prev, 'after'))) {
          const patch = { ...prev };
          for (const m of METRICS) patch[`after_${m.key}`] = rec[`before_${m.key}`];
          patch.after_start = rec.before_start;
          patch.after_end = rec.before_end;
          patch.status = 'มีผลแล้ว';
          await Store.update(patch);
          toast(`บันทึกแล้ว — และเติมผลหลังปรับให้บันทึกวันที่ ${thaiDate(prev.date)} ด้วย`, 4200);
        } else {
          toast(Store.online ? 'บันทึกลง Google Sheet แล้ว' : 'บันทึกในเครื่องแล้ว');
        }
      } else {
        toast(Store.online ? 'บันทึกลง Google Sheet แล้ว' : 'บันทึกในเครื่องแล้ว');
      }

      this.refreshCampaignList();
      refreshAll();
      if (keepGoing) this.continueEntry(rec);
      else this.reset();
    } catch (err) {
      toast('บันทึกไม่สำเร็จ: ' + (err.message || err), 5000);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      $('#saveAddBtn').disabled = false;
      btn.textContent = 'บันทึก';
    }
  },

  /** บันทึกแล้วจดต่อ — คงวันที่/แคมเปญ/สินค้า และเลื่อนตัวเลขหลังปรับมาเป็นก่อนปรับ
   *  ล้างเฉพาะข้อความ แล้วเด้งเคอร์เซอร์กลับไปช่องรายละเอียดทันที */
  continueEntry(prev) {
    this.editingId = null;
    $('#f_id').value = '';
    $('#formTitle').textContent = 'บันทึกการปรับใหม่';
    $('#formHint').textContent = `จดต่อในแคมเปญ ${prev.campaign}`;
    $('#deleteBtn').hidden = true;
    if ($('#afterCard')) $('#afterCard').hidden = true;

    for (const key of ['#f_change_detail', '#f_reason', '#f_expected', '#f_result_note']) $(key).value = '';
    this.selectedTags.clear();
    $$('#tagChips .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    $$('#tagForms .tagform').forEach(b => b.remove());
    this.renderTagForms();
    delete $('#f_change_detail').dataset.auto;
    $('#f_change_detail').classList.remove('is-auto');

    // ล้างตัวเลขให้หมด แล้วให้บันทึกที่เพิ่งเซฟกลายเป็นฐานเปรียบเทียบอันใหม่
    for (const side of ['before', 'after']) {
      clearAutoFlags(side);
      for (const m of METRICS) $(`#${side}_${m.key}`).value = '';
      $(`#${side}_start`).value = '';
      $(`#${side}_end`).value = '';
      delete $(`#${side}_start`).dataset.autoDate;
      delete $(`#${side}_end`).dataset.autoDate;
      this.onMetricInput(side);
    }
    this.refreshBaseline();

    const detail = $('#f_change_detail');
    detail.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => detail.focus(), 250);
  },

  async remove() {
    if (!this.editingId) return;
    if (!confirm('ลบบันทึกนี้ถาวร?')) return;
    try {
      await Store.remove(this.editingId);
      toast('ลบแล้ว');
      this.reset();
      refreshAll();
    } catch (err) {
      toast('ลบไม่สำเร็จ: ' + (err.message || err), 5000);
    }
  }
};

function round(v, dec) {
  if (v === null || !Number.isFinite(v)) return '';
  const p = Math.pow(10, dec);
  return Math.round(v * p) / p;
}

function metricInput(side, m, onInput) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' },
      m.label,
      m.unit ? el('span', { class: 'field-unit', text: m.unit }) : null,
      el('span', { class: 'auto-badge', id: `badge_${side}_${m.key}`, hidden: true, text: 'คำนวณให้' }),
      el('span', { class: 'delta-inline', id: `d_${side}_${m.key}` })),
    el('input', {
      type: 'number', step: 'any', min: '0', id: `${side}_${m.key}`,
      placeholder: '—', inputmode: 'decimal',
      // พอผู้ใช้พิมพ์เอง ช่องนี้เลิกเป็น "ค่าที่ระบบเติม" ทันที
      oninput: e => { delete e.target.dataset.auto; e.target.classList.remove('is-auto'); onInput(); }
    }));
}

/** กล่องกรอกตัวเลขหนึ่งชุด — ช่องหลัก 4 ช่อง / แถบผลคำนวณ / ช่องเสริมพับไว้ */
function buildMetricFields(host, side, onInput) {
  host.innerHTML = '';
  host.className = 'metric-block';

  // แถวช่วงวันที่ + ปุ่มวางตัวเลข
  const dates = el('div', { class: 'metric-dates' },
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'ช่วงข้อมูล — เริ่ม'),
      el('input', { type: 'date', id: `${side}_start`, oninput: onInput })),
    el('label', { class: 'field' },
      el('span', { class: 'field-label' }, 'ช่วงข้อมูล — สิ้นสุด'),
      el('input', { type: 'date', id: `${side}_end`, oninput: onInput })),
    el('div', { class: 'field' },
      el('span', { class: 'field-label' }, ' '),
      el('button', {
        type: 'button', class: 'btn btn-sm', style: 'width:100%',
        onclick: () => openPasteModal(side, onInput)
      }, '📋 วางตัวเลขจาก Google Ads')));

  // 4 ช่องที่ต้องกรอกเอง
  const primary = el('div', { class: 'metric-primary' });
  for (const m of METRICS_BY_TIER('primary')) primary.append(metricInput(side, m, onInput));

  // แถบผลคำนวณ — คลิก "แก้เอง" เพื่อเปลี่ยนเป็นช่องกรอก
  const strip = el('div', { class: 'calc-strip', id: `strip_${side}` });
  const calcFields = el('div', { class: 'metric-primary', id: `calcFields_${side}`, hidden: true });
  for (const m of METRICS_BY_TIER('calc')) calcFields.append(metricInput(side, m, onInput));

  // ช่องเสริม
  const extra = el('div', { class: 'metric-primary' });
  for (const m of METRICS_BY_TIER('extra')) extra.append(metricInput(side, m, onInput));
  const extraWrap = el('details', { class: 'more', id: `extra_${side}` },
    el('summary', {}, 'ช่องเสริม — Impression Share, Lost IS, Max CPC'),
    el('div', { class: 'more-body' }, extra));

  // แถบ "ดึงจาก Google Ads" — เติมเองตอนมีข้อมูลของช่วงนี้จริง
  const pull = el('div', { class: 'ads-pull', id: `adsPull_${side}` });

  host.append(dates, pull, primary, strip, calcFields, extraWrap);
}

/**
 * เอายอดรวมจากชีต METRICS ใส่ช่องกรอกของฝั่งหนึ่ง
 * ค่าที่เติมด้วยวิธีนี้ถือเป็น "ค่าที่ผู้ใช้ยืนยัน" (ไม่ติด data-auto)
 * เพราะเป็นตัวเลขจริงจาก Google ไม่ใช่ค่าที่ระบบคำนวณเดาเอง — พิมพ์ทับได้ตามปกติ
 */
function fillFromAds(side, sum) {
  clearAutoFlags(side);
  const put = (key, v) => {
    const input = $(`#${side}_${key}`);
    if (!input) return;
    input.value = v === null || v === undefined ? '' : v;
    input.classList.add('from-ads');
  };
  put('impressions', sum.impressions);
  put('clicks', sum.clicks);
  put('cost', sum.cost);
  put('conversions', sum.conversions);
  put('ctr', sum.ctr);
  put('cpc', sum.cpc);
  if (sum.impr_share !== null) put('impr_share', sum.impr_share);
}

/** แถบ "มีตัวเลขจาก Google Ads ของช่วงนี้" เหนือช่องกรอก */
function renderAdsPull(side, campaign) {
  const host = $(`#adsPull_${side}`);
  if (!host) return;
  const sig = `${campaign}|${$(`#${side}_start`)?.value || ''}|${$(`#${side}_end`)?.value || ''}|${Store.rev}`;
  if (host.dataset.sig === sig) return;         // ไม่ต้องวาดซ้ำระหว่างพิมพ์
  host.dataset.sig = sig;
  host.innerHTML = '';

  if (!hasAdsData() || !campaign) return;
  const from = $(`#${side}_start`)?.value, to = $(`#${side}_end`)?.value;
  if (!from || !to) return;

  const sum = sumAdsRange(campaign, from, to);
  const upTo = adsDataUpTo();
  if (!sum) {
    host.append(el('div', { class: 'banner' },
      el('span', { class: 'icon' }, '☁️'),
      el('span', {}, `ไม่มีตัวเลขจาก Google Ads ของช่วงนี้ — ข้อมูลที่ดึงมาแล้วถึง ${thaiDate(upTo)}`)));
    return;
  }

  host.append(el('div', { class: 'banner good' },
    el('span', { class: 'icon' }, '☁️'),
    el('span', {},
      el('b', {}, `Google Ads มีตัวเลขของช่วงนี้ครบ ${sum.days} วัน `),
      `(Impr ${fmt(sum.impressions, 0)} · Clicks ${fmt(sum.clicks, 0)} · Cost ${fmt(sum.cost, 2)} ฿ · Conv ${fmt(sum.conversions, 2)})`,
      to > upTo ? el('div', { class: 'card-note', style: 'margin-top:6px' },
        `ข้อมูลมีถึง ${thaiDate(upTo)} — วันหลังจากนั้นยังไม่ถูกดึงมา ตัวเลขจะไม่ครบช่วง`) : null,
      el('div', { style: 'margin-top:9px' },
        el('button', {
          type: 'button', class: 'btn btn-sm btn-primary', id: `pullBtn_${side}`,
          onclick: () => {
            fillFromAds(side, sum);
            host.dataset.sig = '';
            Form.onMetricInput(side);
            toast(`เติมตัวเลข ${sum.days} วันจาก Google Ads แล้ว — ตรวจดูก่อนบันทึก`, 3600);
          }
        }, 'เติมตัวเลขให้เลย')))));
}

/** สลับแถบผลคำนวณเป็นช่องกรอกเอง (เผื่อบางครั้งมีแต่ Cost ไม่มี CPC) */
function toggleCalcFields(side) {
  const fields = $(`#calcFields_${side}`);
  fields.hidden = !fields.hidden;
  const strip = $(`#strip_${side}`);
  const link = strip.querySelector('.link');
  if (link) link.textContent = fields.hidden ? 'แก้เอง' : 'ซ่อนช่องคำนวณ';
}

/** ล้างสถานะ "ค่าที่ระบบเติม" ทั้งฝั่ง (ใช้ตอนโหลดข้อมูลเข้าฟอร์ม)
 *  ต้องล้างค่าในช่องที่ระบบเติมไว้ด้วย ไม่งั้นรอบถัดไปจะนับเป็นค่าที่ผู้ใช้กรอกเอง
 *  แล้วไม่ยอมคำนวณใหม่ */
function clearAutoFlags(side) {
  for (const m of METRICS) {
    const input = $(`#${side}_${m.key}`);
    if (!input) continue;
    if (input.dataset.auto === '1') input.value = '';
    delete input.dataset.auto;
    input.classList.remove('is-auto');
    const badge = $(`#badge_${side}_${m.key}`);
    if (badge) badge.hidden = true;
  }
}

function readBlock(side) {
  const out = {};
  for (const m of METRICS) {
    const input = $(`#${side}_${m.key}`);
    // ค่าที่ระบบเติมเองไม่นับเป็น "ค่าที่ผู้ใช้กรอก" จะได้คำนวณใหม่ทุกครั้งที่ค่าต้นทางเปลี่ยน
    out[m.key] = input.dataset.auto === '1' ? '' : input.value;
  }
  out._start = $(`#${side}_start`).value;
  out._end = $(`#${side}_end`).value;
  out._days = daysBetween(out._start, out._end);
  return out;
}

/** เติมค่าที่คำนวณได้ลงช่องที่ผู้ใช้เว้นว่าง พร้อมทำเครื่องหมายว่าเป็นค่าที่ระบบเติม */
function applyDerived(host, side, noteHost) {
  const raw = readBlock(side);
  const { values, derived } = solveBlock(raw);
  for (const m of METRICS) {
    const input = $(`#${side}_${m.key}`);
    const badge = $(`#badge_${side}_${m.key}`);
    if (derived.has(m.key)) {
      input.value = round(values[m.key], m.dec);
      input.dataset.auto = '1';
      input.classList.add('is-auto');
      badge.hidden = false;
    } else {
      if (input.dataset.auto === '1') input.value = '';   // ค่าต้นทางหายไป ค่าที่เคยคำนวณก็ต้องหายด้วย
      delete input.dataset.auto;
      input.classList.remove('is-auto');
      badge.hidden = true;
    }
  }
  // แถบสรุปผลคำนวณ
  const strip = $(`#strip_${side}`);
  if (strip) {
    const fieldsShown = $(`#calcFields_${side}`) && !$(`#calcFields_${side}`).hidden;
    strip.innerHTML = '';
    const any = METRICS_BY_TIER('calc').some(m => values[m.key] !== null);
    if (!any) {
      strip.append(el('span', { class: 'card-note' },
        'กรอก Impressions + CTR + CPC + Conversions แล้ว Clicks · Cost · CVR · CPA จะคำนวณให้เอง'));
    } else {
      for (const m of METRICS_BY_TIER('calc')) {
        strip.append(el('span', { class: 'calc-item' },
          el('span', { class: 'k' }, m.short),
          el('span', { class: 'v' }, fmtMetric(m.key, values[m.key]))));
      }
    }
    strip.append(el('button', {
      type: 'button', class: 'link', onclick: () => toggleCalcFields(side)
    }, fieldsShown ? 'ซ่อนช่องคำนวณ' : 'แก้เอง'));
  }

  const days = raw._days;
  const parts = [];
  if (days) parts.push(`ช่วงนี้ยาว <b>${days} วัน</b>`);
  if (days && values.cost !== null) parts.push(`Cost เฉลี่ย <b>฿${fmt(values.cost / days, 2)}/วัน</b>`);
  if (days && values.conversions !== null) parts.push(`Conversion เฉลี่ย <b>${fmt(values.conversions / days, 2)}/วัน</b>`);
  if (noteHost) {
    noteHost.innerHTML = parts.join(' · ') ||
      'ใส่ช่วงวันที่ด้วย ระบบจะได้เทียบก่อน/หลังแบบต่อวันให้ถูกต้อง';
  }
}

/* ─────────────────────────────────────────────────────────────
   6b. วางตัวเลขจาก Google Ads
   ───────────────────────────────────────────────────────────── */

let pasteTarget = null;

function openPasteModal(side, onInput) {
  pasteTarget = { side, onInput };
  $('#pasteText').value = '';
  $('#pasteResult').innerHTML = '';
  $('#pasteModal').showModal();
  setTimeout(() => $('#pasteText').focus(), 50);
}

function previewPaste() {
  const box = $('#pasteResult');
  const parsed = parsePerformanceText($('#pasteText').value, new Date().getFullYear());
  const found = METRICS.filter(m => parsed[m.key] !== undefined && parsed[m.key] !== null);
  box.innerHTML = '';
  if (!found.length) {
    box.append(el('div', { class: 'banner warn' }, el('span', { class: 'icon' }, '⚠️'),
      'ยังหาตัวเลขไม่เจอ — ต้องมีรูปแบบ "ชื่อ = ค่า" เช่น CTR = 22.88%'));
    return null;
  }
  box.append(el('div', { class: 'banner good' },
    el('span', { class: 'icon' }, '✅'),
    el('span', {}, 'อ่านได้ ' + found.map(m => `${m.short} ${fmtMetric(m.key, parsed[m.key])}`).join(' · ') +
      (parsed._start ? ` · ช่วง ${thaiDate(parsed._start)} – ${thaiDate(parsed._end)}` : ''))));
  return parsed;
}

function applyPaste() {
  if (!pasteTarget) return;
  const { side, onInput } = pasteTarget;
  const parsed = parsePerformanceText($('#pasteText').value, new Date().getFullYear());
  const found = METRICS.filter(m => parsed[m.key] !== undefined && parsed[m.key] !== null);
  if (!found.length) { toast('ยังหาตัวเลขไม่เจอ'); return; }

  clearAutoFlags(side);
  for (const m of found) $(`#${side}_${m.key}`).value = round(parsed[m.key], m.dec);
  if (parsed._start) $(`#${side}_start`).value = parsed._start;
  if (parsed._end) $(`#${side}_end`).value = parsed._end;
  // ถ้าวางค่าที่ตกอยู่ในกลุ่ม "คำนวณให้" ให้เปิดช่องนั้นให้เห็นด้วย
  if (found.some(m => m.tier === 'calc') && $(`#calcFields_${side}`)?.hidden) toggleCalcFields(side);
  if (found.some(m => m.tier === 'extra')) $(`#extra_${side}`)?.setAttribute('open', '');

  onInput();
  $('#pasteModal').close();
  toast(`ใส่ตัวเลขให้ ${found.length} ช่องแล้ว`);
  pasteTarget = null;
}

/* ─────────────────────────────────────────────────────────────
   7. ส่วนแสดงผลร่วม
   ───────────────────────────────────────────────────────────── */

function verdictBadge(verdict, extra = '') {
  const v = VERDICT_TEXT[verdict] || VERDICT_TEXT.pending;
  return el('span', { class: `verdict ${verdict}` }, `${v.icon} ${v.label}${extra ? ' · ' + extra : ''}`);
}

function deltaTiles(cmp, keys = ['cpa', 'conversions', 'cvr', 'ctr', 'cpc', 'impr_share']) {
  const wrap = el('div', { class: 'tiles' });
  for (const key of keys) {
    const r = cmp.rows.find(x => x.key === key);
    if (!r) continue;
    const cls = r.good === null ? 'delta-flat' : r.good ? 'delta-up' : 'delta-down';
    const arrow = r.dir === 'up' ? '▲' : r.dir === 'down' ? '▼' : '＝';
    wrap.append(el('div', { class: 'tile' },
      el('div', { class: 'tile-label' }, r.metric.label + (r.perDay ? ' (ต่อวัน)' : '')),
      el('div', { class: 'tile-value' }, fmtMetric(key, r.after)),
      el('div', { class: 'tile-sub' }, 'ก่อนปรับ ' + fmtMetric(key, r.before)),
      el('div', { class: `tile-delta ${cls}` },
        r.deltaPct === null ? '—' : `${arrow} ${fmt(Math.abs(r.deltaPct), 1)}%`)));
  }
  return wrap;
}

function deltaTable(cmp) {
  const tbl = el('table', { class: 'data' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, 'ตัวชี้วัด'), el('th', {}, 'ก่อนปรับ'), el('th', {}, 'หลังปรับ'),
    el('th', {}, 'เปลี่ยนแปลง'), el('th', {}, 'ผล'))));
  const tb = el('tbody');
  for (const r of cmp.rows) {
    const cls = r.good === null ? 'delta-flat' : r.good ? 'delta-up' : 'delta-down';
    const arrow = r.dir === 'up' ? '▲' : r.dir === 'down' ? '▼' : '＝';
    tb.append(el('tr', {},
      el('td', {}, r.metric.label + (r.perDay ? ' (ต่อวัน)' : '')),
      el('td', {}, fmtMetric(r.key, r.before)),
      el('td', {}, fmtMetric(r.key, r.after)),
      el('td', { class: cls }, r.deltaPct === null ? '—' : `${arrow} ${fmt(Math.abs(r.deltaPct), 1)}%`),
      el('td', { class: cls },
        r.good === null ? (r.metric.better === 'neutral' ? 'ไม่ตัดสิน' : '—') : r.good ? 'ดีขึ้น' : 'แย่ลง')));
  }
  tbl.append(tb);
  return el('div', { class: 'table-wrap' }, tbl);
}

/* ─────────────────────────────────────────────────────────────
   8. ไทม์ไลน์
   ───────────────────────────────────────────────────────────── */

const RANGE_PRESETS = [
  { id: 'today',  label: 'วันนี้',        from: () => todayISO(),     to: () => todayISO() },
  { id: 'yest',   label: 'เมื่อวาน',      from: () => isoOffset(-1),  to: () => isoOffset(-1) },
  { id: '7',      label: '7 วัน',         from: () => isoOffset(-6),  to: () => todayISO() },
  { id: '30',     label: '30 วัน',        from: () => isoOffset(-29), to: () => todayISO() },
  { id: '90',     label: '90 วัน',        from: () => isoOffset(-89), to: () => todayISO() },
  { id: 'all',    label: 'ทั้งหมด',       from: () => '',             to: () => '' }
];

let activePreset = 'all';

function initTimelineControls() {
  const host = $('#rangePresets');
  host.innerHTML = '';
  for (const p of RANGE_PRESETS) {
    host.append(el('button', {
      type: 'button', class: 'chip', 'data-preset': p.id,
      'aria-pressed': String(p.id === activePreset), text: p.label,
      onclick: () => {
        activePreset = p.id;
        $('#flt_from').value = p.from();
        $('#flt_to').value = p.to();
        $$('#rangePresets .chip').forEach(c =>
          c.setAttribute('aria-pressed', String(c.dataset.preset === p.id)));
        renderTimeline();
      }
    }));
  }
  for (const id of ['#flt_from', '#flt_to', '#flt_group', '#flt_product', '#flt_campaign', '#flt_q']) {
    $(id).addEventListener('input', () => {
      if (id === '#flt_from' || id === '#flt_to') {
        activePreset = '';
        $$('#rangePresets .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      }
      // เลือกกลุ่มแล้วให้ตัวกรองที่แคบกว่ารีเซ็ตถ้าไม่เข้าพวกกัน
      if (id === '#flt_group') { $('#flt_product').value = ''; $('#flt_campaign').value = ''; }
      if (id === '#flt_product') $('#flt_campaign').value = '';
      renderTimeline();
    });
  }
  $('#clearFilters').addEventListener('click', () => {
    $('#flt_from').value = ''; $('#flt_to').value = '';
    $('#flt_group').value = ''; $('#flt_product').value = '';
    $('#flt_campaign').value = ''; $('#flt_q').value = '';
    activePreset = 'all';
    $$('#rangePresets .chip').forEach(c =>
      c.setAttribute('aria-pressed', String(c.dataset.preset === 'all')));
    renderTimeline();
  });
}

function filteredRecords() {
  const from = $('#flt_from').value, to = $('#flt_to').value;
  const group = $('#flt_group').value;
  const product = $('#flt_product').value;
  const camp = $('#flt_campaign').value;
  const q = $('#flt_q').value.trim().toLowerCase();
  return Store.sorted().filter(r => {
    if (from && String(r.date || '') < from) return false;
    if (to && String(r.date || '') > to) return false;
    if (group && recGroup(r) !== group) return false;
    if (product && recProduct(r) !== product) return false;
    if (camp && r.campaign !== camp) return false;
    if (q) {
      const hay = [r.campaign, r.ad_group, r.tags, r.change_detail, r.reason, r.expected,
        r.result_note, recProduct(r), recGroup(r)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** สีประจำกลุ่มสินค้า — บันทึกของสินค้าในกลุ่มเดียวกันจะได้สีเดียวกันทุกหน้า */
function groupColor(group) {
  const groups = Taxonomy.groups();
  const idx = groups.indexOf(group);
  return cssVar(SERIES_VARS[(idx < 0 ? groups.length : idx) % SERIES_VARS.length]);
}

function campaignColor(name) {
  const meta = Store.campaigns.find(c => c.name === name);
  const group = meta?.product ? Taxonomy.groupOf(meta.product) : '';
  if (group) return groupColor(group);
  const names = Store.campaigns.map(c => c.name);
  const idx = Math.max(0, names.indexOf(name));
  return cssVar(SERIES_VARS[idx % SERIES_VARS.length]);
}

function renderTimeline() {
  syncCampaignSelects();
  const list = filteredRecords();
  $('#timelineCount').textContent = `${list.length} บันทึก`;

  // จอเล็กพับตัวกรองไว้ — ต้องบอกให้เห็นว่ายังกรองอะไรค้างอยู่กี่ช่อง
  const active = ['#flt_from', '#flt_to', '#flt_group', '#flt_product', '#flt_campaign', '#flt_q']
    .filter(sel => $(sel).value.trim()).length;
  const badge = $('#filterBadge');
  badge.hidden = active === 0;
  badge.textContent = `${active}`;

  // สรุปรวมแบบบรรทัดเดียว (การ์ดสีบนแดชบอร์ดสรุปภาพใหญ่ไปแล้ว)
  const bar = $('#timelineTiles');
  bar.innerHTML = '';
  const withResult = list.map(r => ({ r, cmp: recCompare(r) })).filter(x => x.cmp);
  const good = withResult.filter(x => x.cmp.verdict === 'up').length;
  const bad = withResult.filter(x => x.cmp.verdict === 'down').length;
  const pending = list.length - withResult.length;
  const campaigns = new Set(list.map(r => r.campaign)).size;

  bar.append(
    el('span', { class: 'sb-main' }, `${list.length} บันทึก`),
    el('span', { class: 'sb-item delta-up' }, `▲ ดีขึ้น ${good}`),
    el('span', { class: 'sb-item delta-down' }, `▼ แย่ลง ${bad}`),
    el('span', { class: 'sb-item delta-flat' }, `⋯ รอผล ${pending}`),
    el('span', { class: 'sb-item delta-flat' }, `${campaigns} แคมเปญ`));

  const host = $('#timelineList');
  host.innerHTML = '';
  if (!list.length) {
    host.append(el('div', { class: 'empty' },
      el('strong', {}, 'ยังไม่มีบันทึกในช่วงนี้'),
      'ลองขยายช่วงเวลา หรือไปที่แท็บ "บันทึกใหม่" เพื่อเริ่มบันทึกครั้งแรก'));
    return;
  }

  for (const rec of list) {
    const cmp = recCompare(rec);
    const card = el('div', { class: 'rec' });
    card.style.borderLeftColor = campaignColor(rec.campaign);

    const crumb = [recGroup(rec), recProduct(rec)].filter(Boolean).join(' › ');

    card.append(el('div', { class: 'rec-head' },
      el('span', { class: 'rec-date' }, thaiDate(rec.date)),
      crumb ? el('span', { class: 'rec-crumb' }, crumb) : null,
      el('span', { class: 'rec-campaign' }, rec.campaign || '—'),
      rec.ad_group ? el('span', { class: 'rec-campaign' }, rec.ad_group) : null,
      cmp ? verdictBadge(cmp.verdict) : verdictBadge('pending'),
      isMeasured(rec) ? el('span', { class: 'tag' }, '📊 มีตัวเลข') : null,
      el('span', { class: 'rec-ago' }, relativeDay(rec.date))));

    if (rec.change_detail) card.append(el('div', { class: 'rec-body' }, rec.change_detail));

    const tags = String(rec.tags || '').split('|').map(s => s.trim()).filter(Boolean);
    if (tags.length) {
      const tw = el('div', { class: 'rec-tags' });
      tags.forEach(t => tw.append(el('span', { class: 'tag' }, t)));
      card.append(tw);
    }

    if (rec.reason) card.append(el('div', { class: 'rec-meta', html: '<b>เหตุผล:</b> ' + esc(rec.reason) }));
    if (rec.expected) card.append(el('div', { class: 'rec-meta', html: '<b>คาดหวัง:</b> ' + esc(rec.expected) }));
    if (rec.result_note) card.append(el('div', { class: 'rec-meta', html: '<b>ผลจริง:</b> ' + esc(rec.result_note) }));

    const round = roundOf(rec);
    if (round && !round.orphan) {
      const n = round.adjustments.length;
      card.append(el('div', { class: 'rec-meta' },
        el('b', {}, roundLabel(round)),
        n > 1 ? ` · ผลรวมของการปรับ ${n} ครั้งในรอบนี้` : ''));
    }

    if (cmp) {
      const key = cmp.rows.filter(r => ['cpa', 'conversions', 'cvr', 'ctr'].includes(r.key) && r.deltaPct !== null);
      if (key.length) {
        card.append(el('div', { class: 'rec-meta', html: key.map(r => {
          const cls = r.good === null ? 'delta-flat' : r.good ? 'delta-up' : 'delta-down';
          const arrow = r.dir === 'up' ? '▲' : r.dir === 'down' ? '▼' : '＝';
          return `${esc(r.metric.label)} <span class="${cls}">${arrow} ${fmt(Math.abs(r.deltaPct), 1)}%</span>`;
        }).join(' &nbsp;·&nbsp; ') }));
      }
    }

    const actions = el('div', { class: 'rec-actions' },
      el('button', { class: 'btn btn-sm', text: '✎ แก้ไข', onclick: () => { Form.load(rec); showTab('new'); } }));
    // บันทึกที่มีตัวเลขอยู่แล้ว — เปิดดูเป็นป๊อปอัพ ไม่ต้องออกจากไทม์ไลน์
    if (isMeasured(rec)) {
      actions.append(el('button', {
        class: 'btn btn-sm', text: '📊 ดูตัวเลข',
        title: 'ดูตัวเลขวัดผลและผลเทียบของบันทึกนี้',
        onclick: () => openRecordNumbers(rec)
      }));
    }
    if (round && round.open) {
      actions.append(el('button', {
        class: 'btn btn-sm btn-primary', text: '＋ ใส่ตัวเลขวัดผล',
        title: 'ใส่ตัวเลขเพื่อปิดรอบนี้ — เปิดเป็นป๊อปอัพ ไม่ต้องออกจากหน้านี้',
        onclick: () => Measure.open(rec.campaign)
      }));
    }
    actions.append(el('button', {
      class: 'btn btn-sm btn-danger', text: '🗑 ลบ',
      title: 'ลบบันทึกนี้ — กด "เลิกทำ" ในแถบด้านล่างเพื่อเอากลับได้',
      onclick: () => deleteRecord(rec)
    }));
    actions.append(el('button', { class: 'btn btn-sm', text: '⧉ ทำซ้ำ', onclick: () => {
      const copy = { ...rec, id: '', date: todayISO(), result_note: '' };
      for (const m of METRICS) { copy[`after_${m.key}`] = ''; }
      copy.after_start = ''; copy.after_end = '';
      Form.load(copy); $('#f_id').value = ''; Form.editingId = null;
      $('#formTitle').textContent = 'บันทึกการปรับใหม่ (ทำซ้ำ)';
      $('#deleteBtn').hidden = true;
      showTab('new');
    } }));
    card.append(actions);
    host.append(card);
  }
}

/**
 * ลบบันทึก แล้วเปิดทางให้กด "เลิกทำ" ได้ 8 วินาที
 * เอากลับด้วย id เดิม ทุกอย่างที่อ้างถึงบันทึกนี้จึงกลับมาเหมือนเดิม
 */
async function deleteRecord(rec) {
  const backup = { ...rec };
  try {
    await Store.remove(rec.id);
    refreshAll();
    const what = String(rec.change_detail || '').trim().slice(0, 40) || 'บันทึกที่ไม่มีข้อความ';
    toastAction(`ลบ "${what}" แล้ว`, 'เลิกทำ', async () => {
      try {
        await Store.create(backup);
        refreshAll();
        toast('เอากลับมาแล้ว');
      } catch (err) {
        toast('เอากลับไม่สำเร็จ: ' + (err.message || err), 5000);
      }
    }, 8000);
  } catch (err) {
    toast('ลบไม่สำเร็จ: ' + (err.message || err), 5000);
  }
}

/* ─────────────────────────────────────────────────────────────
   8b. รอบวัดผล (measurement round)

   ปรับทุกวันแต่วัดผลเป็นครั้ง ๆ — ระบบจึงจับ "ช่วงระหว่างการวัดผลสองครั้ง"
   เป็นหนึ่งรอบ แล้วยกผลของรอบนั้นให้การปรับทุกครั้งที่เกิดในรอบร่วมกัน
   (แยกไม่ได้ว่าครั้งไหนทำ — พูดตรง ๆ ดีกว่าเดาให้ผิด)
   ───────────────────────────────────────────────────────────── */

/** บันทึกที่ "มีตัวเลข" = จุดวัดผล */
function isMeasured(rec) {
  return hasNumbers(block(rec, 'before'));
}
function hasAdjustment(rec) {
  return !!String(rec.change_detail || '').trim();
}

let _roundIndex = null, _roundRev = -1;

function roundIndex() {
  if (_roundIndex && _roundRev === Store.rev) return _roundIndex;
  const byCampaign = new Map();
  for (const rec of Store.records) {
    const c = rec.campaign || '(ไม่ระบุ)';
    if (!byCampaign.has(c)) byCampaign.set(c, []);
    byCampaign.get(c).push(rec);
  }

  const rounds = [];
  const ofRecord = new Map();
  for (const [campaign, list] of byCampaign) {
    const all = [...list].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const measured = all.filter(isMeasured);

    const push = (from, to) => {
      const inRound = all.filter(r =>
        String(r.date || '') >= String(from.date || '') &&
        (!to || String(r.date || '') < String(to.date || '')) &&
        hasAdjustment(r));
      const round = { campaign, from, to, adjustments: inRound, open: !to };
      rounds.push(round);
      for (const r of inRound) ofRecord.set(r.id, round);
      return round;
    };

    for (let i = 0; i < measured.length - 1; i++) push(measured[i], measured[i + 1]);
    if (measured.length) push(measured[measured.length - 1], null);

    // บันทึกที่เกิดก่อนการวัดผลครั้งแรก — ยังไม่มีฐานให้เทียบ
    const firstDate = measured.length ? String(measured[0].date || '') : null;
    for (const r of all) {
      if (!hasAdjustment(r) || ofRecord.has(r.id)) continue;
      if (firstDate === null || String(r.date || '') < firstDate) {
        const round = { campaign, from: null, to: measured[0] || null, adjustments: [r], open: false, orphan: true };
        rounds.push(round);
        ofRecord.set(r.id, round);
      }
    }
  }

  _roundIndex = { rounds, ofRecord };
  _roundRev = Store.rev;
  return _roundIndex;
}

function roundOf(rec) {
  return roundIndex().ofRecord.get(rec.id) || null;
}

function roundCompare(round, mode = 'auto') {
  if (!round || !round.from || !round.to) return null;
  const b = block(round.from, 'before');
  const a = block(round.to, 'before');
  if (!hasNumbers(b) || !hasNumbers(a)) return null;
  return compareBlocks(b, a, mode);
}

function roundLabel(round) {
  if (!round) return '';
  if (round.orphan) return 'ก่อนเริ่มวัดผล';
  const from = thaiDate(round.from.date);
  return round.open ? `รอบตั้งแต่ ${from} — ยังไม่ได้วัดผล`
                    : `รอบ ${from} – ${thaiDate(round.to.date)}`;
}

/** เทียบผลของบันทึกหนึ่ง = ผลของรอบวัดผลที่บันทึกนั้นอยู่ */
function recCompare(rec, mode = 'auto') {
  return roundCompare(roundOf(rec), mode);
}

/* ─────────────────────────────────────────────────────────────
   9. แดชบอร์ด
   ───────────────────────────────────────────────────────────── */

function renderDashboard() {
  const mode = $('#dashMode')?.value || 'auto';
  renderStatCards();
  renderDaily();
  renderTagAnalysis();
  renderRoundList(mode);
  renderProductComparison();
}

/* ─────────────────────────────────────────────────────────────
   9b. แถบทักทาย + การ์ดสถิติสี
   ───────────────────────────────────────────────────────────── */

const STAT_ICONS = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  up:   '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
  down: '<path d="M23 18l-9.5-9.5-5 5L1 6"/><path d="M17 18h6v-6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'
};

/** วงแหวนเปอร์เซ็นต์บนการ์ดสถิติ — pct = 0-100 (null = ไม่วาด) */
function statRing(pct) {
  if (pct === null || !Number.isFinite(pct)) return null;
  const p = Math.max(0, Math.min(100, pct));
  const r = 21, circ = 2 * Math.PI * r;
  const span = el('span', { class: 'sc-ring' });
  span.innerHTML =
    `<svg viewBox="0 0 52 52" role="img" aria-label="${Math.round(p)} เปอร์เซ็นต์">` +
    `<circle cx="26" cy="26" r="${r}"></circle>` +
    `<circle cx="26" cy="26" r="${r}" stroke-dasharray="${circ.toFixed(1)}" ` +
    `stroke-dashoffset="${(circ * (1 - p / 100)).toFixed(1)}"></circle>` +
    `<text x="26" y="26">${Math.round(p)}%</text></svg>`;
  return span;
}

/** ตัวเลขบนการ์ดสถิติ — ย่อขนาดเองถ้ายาวเกินจนจะตกบรรทัด */
function statValue(value, unit) {
  const text = String(value);
  const len = text.length + (unit ? unit.length : 0);
  const cls = 'sc-value' + (len > 13 ? ' is-xlong' : len > 9 ? ' is-long' : '');
  return el('div', { class: cls }, text, unit ? el('small', {}, unit) : null);
}

function svgIcon(name) {
  const span = el('span', { class: 'sc-icon' });
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${STAT_ICONS[name] || ''}</svg>`;
  return span;
}

function updateGreeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'สวัสดีตอนเช้า' : h < 17 ? 'สวัสดีตอนบ่าย' : 'สวัสดีตอนเย็น';
  $('#greetTitle').textContent = part;

  const today = Store.records.filter(r => String(r.date || '') === todayISO()).length;
  const pending = Store.records.filter(r => !recCompare(r)).length;
  const bits = [];
  bits.push(today ? `วันนี้บันทึกไปแล้ว ${today} รายการ` : 'วันนี้ยังไม่ได้บันทึกอะไร');
  if (pending) bits.push(`มี ${pending} การปรับที่ยังรอผล`);
  $('#greetSub').textContent = bits.join(' · ');
}

/** เดือนนี้เทียบเดือนก่อน — ใช้บอก % ใต้ตัวเลขในการ์ด */
function monthBuckets() {
  const now = new Date(todayISO());
  const thisKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  const pick = key => Store.records.filter(r => String(r.date || '').startsWith(key));
  return { now: pick(thisKey), prev: pick(prevKey) };
}

function renderStatCards() {
  const host = $('#statRow');
  if (!host) return;
  host.innerHTML = '';

  const { now, prev } = monthBuckets();
  const judged = list => list.map(r => recCompare(r)).filter(Boolean);
  const count = (list, verdict) => judged(list).filter(c => c.verdict === verdict).length;

  const pct = (a, b) => {
    if (!b) return a ? null : 0;
    return (a - b) / b * 100;
  };
  const subOf = (a, b) => {
    const d = pct(a, b);
    if (d === null) return 'เดือนก่อนยังไม่มีข้อมูล';
    if (Math.abs(d) < 0.5) return 'เท่าเดือนก่อน';
    return `${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d), 1)}% จากเดือนก่อน`;
  };

  const nowUp = count(now, 'up'), nowDown = count(now, 'down');
  const nowJudged = judged(now).length;
  const pendingNow = now.length - nowJudged;

  const ratio = n => (nowJudged ? n / nowJudged * 100 : null);
  const cards = [
    { cls: 'c3', icon: 'edit', label: 'การปรับเดือนนี้', value: now.length, active: true,
      sub: subOf(now.length, prev.length) },
    { cls: 'c4', icon: 'up', label: 'ได้ผล ดีขึ้น', value: nowUp, ring: ratio(nowUp),
      sub: nowJudged ? `${Math.round(nowUp / nowJudged * 100)}% ของที่รู้ผลแล้ว` : 'ยังไม่มีที่รู้ผล' },
    { cls: 'c2', icon: 'down', label: 'แย่ลง', value: nowDown, ring: ratio(nowDown),
      sub: nowJudged ? `${Math.round(nowDown / nowJudged * 100)}% ของที่รู้ผลแล้ว` : 'ยังไม่มีที่รู้ผล' },
    { cls: 'c1', icon: 'clock', label: 'รอผล', value: pendingNow,
      ring: now.length ? pendingNow / now.length * 100 : null,
      sub: pendingNow ? 'ยังไม่มีตัวเลขรอบถัดไป' : 'รู้ผลครบแล้ว' }
  ];

  for (const c of cards) {
    host.append(el('div', { class: `stat-card ${c.cls}${c.active ? ' is-active' : ''}` },
      el('div', { class: 'sc-body' },
        el('div', { class: 'sc-label' }, c.label),
        statValue(String(c.value), ' รายการ'),
        el('div', { class: 'sc-sub' }, c.sub)),
      (c.ring !== undefined && c.ring !== null) ? statRing(c.ring) : svgIcon(c.icon)));
  }
}

/** เมนูซ้ายบนจอเล็ก */
function initSidebar() {
  const close = () => {
    document.body.classList.remove('nav-open');
    $('#navScrim').hidden = true;
    $('#navToggle').setAttribute('aria-expanded', 'false');
    $('#navToggle').setAttribute('aria-label', 'เปิดเมนู');
  };
  const open = () => {
    document.body.classList.add('nav-open');
    $('#navScrim').hidden = false;
  };
  $('#navToggle').addEventListener('click', () => {
    const isOpen = document.body.classList.contains('nav-open');
    isOpen ? close() : open();
    $('#navToggle').setAttribute('aria-expanded', String(!isOpen));
    $('#navToggle').setAttribute('aria-label', isOpen ? 'เปิดเมนู' : 'ปิดเมนู');
    if (!isOpen) setTimeout(() => $(`#tab-${PANELS.find(p => !$(`#panel-${p}`).hidden)}`)?.focus(), 260);
  });
  $('#navScrim').addEventListener('click', close);
  for (const p of PANELS) $(`#tab-${p}`).addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) close();
  });

  // ช่องค้นหาบนแถบบน — ส่งต่อไปที่ตัวกรองข้อความของไทม์ไลน์
  const gs = $('#globalSearch');
  if (gs) {
    let t = null;
    const run = () => {
      $('#flt_q').value = gs.value;
      if ($('#panel-timeline').hidden) showTab('timeline'); else renderTimeline();
    };
    gs.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 260); });
    gs.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); run(); }
      if (e.key === 'Escape') { gs.value = ''; clearTimeout(t); run(); gs.blur(); }
    });
  }

  $('#quickNew').addEventListener('click', () => { Form.reset(); showTab('new'); });
  $('#quickToday').addEventListener('click', () => {
    $('#dailyDate').value = todayISO();
    showTab('dashboard');
  });
}

/* ─────────────────────────────────────────────────────────────
   10a. สรุปรายวัน — "วันนี้แก้อะไรไปบ้าง"
   ───────────────────────────────────────────────────────────── */

/** เวลาจาก created_at (ISO) → "14:32" — บันทึกเก่าที่ไม่มีเวลาจะได้ "—" */
function recTime(rec) {
  const iso = rec.created_at;
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function initDailyCard() {
  $('#dailyDate').value = todayISO();
  const shift = days => {
    const d = parseDate($('#dailyDate').value) || new Date();
    d.setDate(d.getDate() + days);
    $('#dailyDate').value = toISO(d);
    renderDaily();
  };
  $('#dailyPrev').addEventListener('click', () => shift(-1));
  $('#dailyNext').addEventListener('click', () => shift(1));
  $('#dailyToday').addEventListener('click', () => { $('#dailyDate').value = todayISO(); renderDaily(); });
  $('#dailyDate').addEventListener('change', renderDaily);
  $('#dailyCopy').addEventListener('click', copyDailySummary);
}

function dailyRecords() {
  const day = $('#dailyDate').value;
  return Store.records
    .filter(r => String(r.date || '') === day)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function renderDaily() {
  const day = $('#dailyDate').value;
  const list = dailyRecords();
  const isToday = day === todayISO();

  $('#dailyCount').textContent = list.length
    ? `${thaiDate(day)} · ${list.length} รายการ`
    : thaiDate(day);
  $('#dailyToday').disabled = isToday;
  // กันเลื่อนไปวันอนาคตไกลเกินจำเป็น
  $('#dailyNext').disabled = day >= todayISO();

  const tb = $('#dailyTable tbody');
  tb.innerHTML = '';

  if (!list.length) {
    tb.append(el('tr', {}, el('td', { colspan: '7', style: 'text-align:left;padding:0' },
      el('div', { class: 'empty', style: 'border:0;background:none;padding:32px 12px' },
        el('strong', {}, isToday ? 'วันนี้ยังไม่ได้บันทึกอะไร' : 'วันนี้ไม่มีบันทึก'),
        isToday ? 'ไปที่แท็บ "บันทึกใหม่" เพื่อจดการปรับครั้งแรกของวัน' : 'ลองเลื่อนไปดูวันอื่น'))));
    return;
  }

  for (const rec of list) {
    const cmp = recCompare(rec);
    const tags = String(rec.tags || '').split('|').map(s => s.trim()).filter(Boolean);
    const detail = (rec.change_detail || '').replace(/\s+/g, ' ');

    const tr = el('tr', {},
      el('td', { class: 'w-time' }, recTime(rec) || '—'),
      el('td', {},
        el('div', { class: 'cell-strong' }, rec.campaign || '—'),
        rec.ad_group ? el('div', { class: 'cell-sub' }, rec.ad_group) : null),
      el('td', { style: 'text-align:left' },
        el('div', {}, recProduct(rec) || '—'),
        recGroup(rec) ? el('div', { class: 'cell-sub' }, recGroup(rec)) : null),
      el('td', { style: 'text-align:left' },
        tags.length
          ? el('div', { class: 'rec-tags', style: 'margin:0' },
              tags.slice(0, 2).map(t => el('span', { class: 'tag' }, t)),
              tags.length > 2 ? el('span', { class: 'tag' }, `+${tags.length - 2}`) : null)
          : el('span', { class: 'cell-sub' }, '—')),
      el('td', { class: 'w-wide', title: detail }, detail.slice(0, 110) + (detail.length > 110 ? '…' : '')),
      el('td', {}, cmp ? verdictBadge(cmp.verdict) : verdictBadge('pending')),
      el('td', {},
        el('button', {
          class: 'btn btn-sm btn-ghost', type: 'button',
          onclick: () => { Form.load(rec); showTab('new'); }
        }, 'แก้ไข')));
    tb.append(tr);
  }
}

/** คัดลอกสรุปเป็นข้อความล้วน ไว้แปะส่ง LINE / รายงานทีม */
async function copyDailySummary() {
  const day = $('#dailyDate').value;
  const list = dailyRecords();
  if (!list.length) { toast('วันนี้ไม่มีบันทึกให้คัดลอก'); return; }

  const lines = [`สรุปการปรับ Google Ads — ${thaiDate(day)} (${list.length} รายการ)`, ''];
  for (const rec of list) {
    const time = recTime(rec);
    const head = [time, recProduct(rec), rec.campaign].filter(Boolean).join(' · ');
    lines.push(`• ${head}`);
    const detail = (rec.change_detail || '').replace(/\s+/g, ' ').trim();
    if (detail) lines.push(`  ${detail}`);
    if (rec.reason) lines.push(`  เหตุผล: ${String(rec.reason).replace(/\s+/g, ' ').trim()}`);
    const cmp = recCompare(rec);
    if (cmp) {
      const cpa = cmp.rows.find(r => r.key === 'cpa');
      if (cpa && cpa.deltaPct !== null) {
        lines.push(`  ผล: ${VERDICT_TEXT[cmp.verdict].label} · CPA ${cpa.deltaPct > 0 ? '+' : ''}${fmt(cpa.deltaPct, 1)}%`);
      }
    }
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('คัดลอกสรุปแล้ว — วางในแชตได้เลย');
  } catch {
    // บางเบราว์เซอร์บล็อก clipboard เมื่อไม่ได้เปิดผ่าน https
    const ta = el('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('คัดลอกสรุปแล้ว'); }
    catch { toast('คัดลอกไม่ได้ — ลองเปิดเว็บผ่าน https'); }
    ta.remove();
  }
}

/* ─────────────────────────────────────────────────────────────
   10a2. ประเภทการปรับไหนเวิร์ก + รายการรอบวัดผล
   ───────────────────────────────────────────────────────────── */

function closedRounds() {
  return roundIndex().rounds.filter(r => r.from && r.to && !r.orphan);
}

/** รวมผลรายประเภทการปรับ จากทุกรอบที่ปิดแล้ว
 *  รอบหนึ่งมีหลายประเภทปนกัน — ค่าที่ได้จึงเป็นความสัมพันธ์ ไม่ใช่เหตุ-ผล */
function tagStats(metricKey) {
  const m = METRIC_BY_KEY[metricKey];
  const byTag = new Map();

  for (const round of closedRounds()) {
    const cmp = roundCompare(round);
    if (!cmp) continue;
    const row = cmp.rows.find(r => r.key === metricKey);
    if (!row || row.deltaPct === null) continue;

    const tags = new Set();
    for (const rec of round.adjustments) {
      for (const t of String(rec.tags || '').split('|').map(x => x.trim()).filter(Boolean)) tags.add(t);
    }
    if (!tags.size) tags.add('(ไม่ระบุประเภท)');

    for (const t of tags) {
      if (!byTag.has(t)) byTag.set(t, { tag: t, deltas: [], good: 0, rounds: 0, mixedWith: new Set() });
      const e = byTag.get(t);
      e.deltas.push(row.deltaPct);
      e.rounds++;
      const better = m.better === 'down' ? row.deltaPct < 0 : row.deltaPct > 0;
      if (better) e.good++;
      for (const other of tags) if (other !== t) e.mixedWith.add(other);
    }
  }

  return [...byTag.values()].map(e => {
    const avg = e.deltas.reduce((a, b) => a + b, 0) / e.deltas.length;
    return { ...e, avg, mixed: e.mixedWith.size };
  }).sort((a, b) => (m.better === 'down' ? a.avg - b.avg : b.avg - a.avg));
}

function renderTagAnalysis() {
  const sel = $('#tagMetric');
  if (!sel) return;
  if (!sel.options.length) {
    for (const m of METRICS.filter(x => x.better !== 'neutral')) {
      sel.append(el('option', { value: m.key }, m.label));
    }
    sel.value = 'cpa';
  }
  const metricKey = sel.value || 'cpa';
  const m = METRIC_BY_KEY[metricKey];
  const host = $('#tagAnalysis');
  host.innerHTML = '';

  const stats = tagStats(metricKey);
  const totalRounds = closedRounds().filter(r => roundCompare(r)).length;

  if (!stats.length) {
    host.append(el('div', { class: 'empty' },
      el('strong', {}, 'ยังวิเคราะห์ไม่ได้'),
      'ต้องมีรอบวัดผลที่ปิดแล้วอย่างน้อย 1 รอบ — คือมีบันทึกที่ใส่ตัวเลขสองครั้งขึ้นไปในแคมเปญเดียวกัน'));
    return;
  }

  host.append(el('div', { class: 'banner' },
    el('span', { class: 'icon' }, 'ℹ️'),
    el('span', {}, `จาก ${totalRounds} รอบวัดผลที่ปิดแล้ว · ` +
      `${m.label} ${m.better === 'down' ? 'ยิ่งลดยิ่งดี' : 'ยิ่งเพิ่มยิ่งดี'} · ` +
      'ยิ่งจำนวนรอบเยอะ ตัวเลขยิ่งน่าเชื่อ')));

  const tbl = el('table', { class: 'data' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, 'ประเภทการปรับ'),
    el('th', {}, 'จำนวนรอบ'),
    el('th', {}, `${m.short} เปลี่ยนเฉลี่ย`),
    el('th', {}, 'รอบที่ดีขึ้น'),
    el('th', {}, 'ปนกับประเภทอื่น'))));
  const tb = el('tbody');
  for (const e of stats) {
    const better = m.better === 'down' ? e.avg < 0 : e.avg > 0;
    const cls = Math.abs(e.avg) < 0.5 ? 'delta-flat' : better ? 'delta-up' : 'delta-down';
    const arrow = e.avg > 0 ? '▲' : e.avg < 0 ? '▼' : '＝';
    tb.append(el('tr', {},
      el('td', {}, e.tag),
      el('td', {}, String(e.rounds) + (e.rounds < 3 ? ' ⚠️' : '')),
      el('td', { class: cls }, `${arrow} ${fmt(Math.abs(e.avg), 1)}%`),
      el('td', {}, `${e.good}/${e.rounds}`),
      el('td', { class: 'cell-sub' }, e.mixed ? `${e.mixed} ประเภท` : 'เดี่ยว ๆ')));
  }
  tbl.append(tb);
  host.append(el('div', { class: 'table-wrap' }, tbl));

  if (stats.some(e => e.rounds < 3)) {
    host.append(el('p', { class: 'card-note', style: 'margin-top:10px' },
      '⚠️ = มีข้อมูลน้อยกว่า 3 รอบ ยังสรุปอะไรไม่ได้ · ' +
      'คอลัมน์ "ปนกับประเภทอื่น" บอกว่ารอบเหล่านั้นมีการปรับแบบอื่นร่วมด้วยกี่แบบ ยิ่งเยอะยิ่งแยกผลยาก'));
  }
}

function renderRoundList(mode = 'auto') {
  const sel = $('#roundCampaign');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, 'ทุกแคมเปญ'));
  for (const c of Store.campaigns) sel.append(el('option', { value: c.name }, c.name));
  sel.value = Store.campaigns.some(c => c.name === cur) ? cur : '';

  const host = $('#roundList');
  host.innerHTML = '';
  let rounds = roundIndex().rounds.filter(r => !r.orphan && (!sel.value || r.campaign === sel.value));
  rounds = rounds.sort((a, b) =>
    String(b.from?.date || '').localeCompare(String(a.from?.date || ''))).slice(0, 20);

  if (!rounds.length) {
    host.append(el('div', { class: 'empty' },
      el('strong', {}, 'ยังไม่มีรอบวัดผล'),
      'บันทึกพร้อมตัวเลขอย่างน้อยหนึ่งครั้งเพื่อเริ่มรอบแรก'));
    return;
  }

  const firstClosed = rounds.findIndex(r => !r.open && roundCompare(r, mode));

  rounds.forEach((round, idx) => {
    const cmp = roundCompare(round, mode);
    const box = el('details', { class: 'round' + (round.open ? ' is-open' : '') });
    if (idx === firstClosed) box.open = true;   // กางรอบล่าสุดที่มีผลไว้ให้เลย

    box.append(el('summary', { class: 'round-head' },
      el('span', { class: 'r-title' }, roundLabel(round)),
      el('span', { class: 'rec-campaign' }, round.campaign),
      el('span', { class: 'r-meta' }, `ปรับ ${round.adjustments.length} ครั้ง`),
      cmp ? verdictBadge(cmp.verdict) : verdictBadge('pending')));

    const body = el('div', { class: 'round-body' });

    if (cmp) {
      if (cmp.perDay) {
        body.append(el('p', { class: 'card-note', style: 'margin-bottom:12px' },
          `ช่วงก่อน ${cmp.bDays} วัน · ช่วงนี้ ${cmp.aDays} วัน — ตัวเลขสะสมถูกแปลงเป็นค่าเฉลี่ยต่อวันก่อนเทียบ`));
      }
      body.append(deltaTiles(cmp));
      body.append(el('div', { style: 'margin-top:14px' }, deltaTable(cmp)));
    } else if (round.open) {
      body.append(el('div', { class: 'banner warn' },
        el('span', { class: 'icon' }, '⏳'),
        el('span', {}, 'รอบนี้ยังไม่ได้ปิด — ',
          el('button', {
            class: 'link', type: 'button',
            onclick: e => { e.preventDefault(); Measure.open(round.campaign); }
          }, 'บันทึกตัวเลขวัดผลตอนนี้'))));
    }

    const adjs = el('div', { class: 'round-adjs' });
    for (const rec of round.adjustments) {
      const tags = String(rec.tags || '').split('|').map(x => x.trim()).filter(Boolean);
      adjs.append(el('div', { class: 'adj' },
        el('b', {}, thaiDate(rec.date) + ' — '),
        String(rec.change_detail || '').replace(/\s+/g, ' ').slice(0, 160),
        tags.length ? el('span', { class: 'cell-sub' }, '  · ' + tags.join(', ')) : null,
        el('button', {
          class: 'link', type: 'button', style: 'margin-left:8px',
          onclick: e => { e.preventDefault(); Form.load(rec); showTab('new'); }
        }, 'แก้')));
    }
    body.append(el('div', { class: 'section-label', style: 'margin:16px 0 6px' },
      `การปรับในรอบนี้ (${round.adjustments.length})`), adjs);

    box.append(body);
    host.append(box);
  });
}

/** เปิดฟอร์มเต็มพร้อมกล่องตัวเลข — ใช้ตอนอยากแก้ทุกช่อง ไม่ใช่แค่ใส่ตัวเลข */
function startMeasurement(campaign) {
  Form.reset();
  $('#f_campaign').value = campaign;
  Form.onCampaignInput();
  Form.refreshBaseline();
  const box = $('#numbersBox');
  if (box) box.open = true;
  showTab('new');
  setTimeout(() => $('#before_impressions')?.focus(), 200);
}

/* ─────────────────────────────────────────────────────────────
   10a-2. ป๊อปอัพใส่ตัวเลขวัดผล — ไม่ต้องออกจากหน้าที่ดูอยู่
   ───────────────────────────────────────────────────────────── */

const Measure = {
  campaign: '',
  baseline: null,
  built: false,

  build() {
    if (this.built) return;
    buildMetricFields($('#measFields'), 'meas', () => this.onInput());
    $('#measSave').addEventListener('click', e => { e.preventDefault(); this.save(); });
    $('#measCancel').addEventListener('click', e => { e.preventDefault(); $('#measureModal').close(); });
    $('#measFull').addEventListener('click', e => {
      e.preventDefault();
      const c = this.campaign;
      $('#measureModal').close();
      startMeasurement(c);
    });
    for (const id of ['#meas_start', '#meas_end']) {
      $(id)?.addEventListener('change', () => this.renderPull());
    }
    // Ctrl+Enter ในป๊อปอัพ = บันทึก เหมือนฟอร์มหลัก
    $('#measureModal').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.save(); }
    });
    this.built = true;
  },

  open(campaign) {
    this.build();
    this.campaign = campaign;
    $('#measCampaignView').textContent = campaign;
    $('#meas_date').value = todayISO();
    $('#meas_note').value = '';

    clearAutoFlags('meas');
    for (const m of METRICS) $('#meas_' + m.key).value = '';
    $('#meas_start').value = '';
    $('#meas_end').value = '';

    // ตัวเลขครั้งก่อนของแคมเปญนี้ = ฐานเปรียบเทียบ และเป็นวันเริ่มช่วงใหม่
    const prev = Store.latestMeasured(campaign, $('#meas_date').value, null);
    this.baseline = prev ? { record: prev, block: block(prev, 'before') } : null;

    const adj = prev
      ? Store.adjustmentsSince(campaign, prev.date, $('#meas_date').value, null)
      : [];
    $('#measSub').textContent = prev
      ? `เทียบกับตัวเลขครั้งก่อนวันที่ ${thaiDate(prev.date)}` +
        (adj.length ? ` · ระหว่างนั้นปรับไป ${adj.length} ครั้ง` : ' · ระหว่างนั้นยังไม่มีการปรับ')
      : 'ยังไม่มีตัวเลขครั้งก่อนของแคมเปญนี้ — ครั้งนี้จะเป็นค่าตั้งต้น';

    $('#meas_start').value = prev?.before_end || prev?.date || '';
    $('#meas_end').value = $('#meas_date').value;

    this.renderBaseline();
    this.renderPull();
    this.onInput();
    $('#measureModal').showModal();
    setTimeout(() => $('#meas_impressions')?.focus(), 120);
  },

  /** แถบ "ดึงตัวเลขจาก Google Ads" — โผล่เฉพาะตอนมีข้อมูลของแคมเปญนี้จริง */
  renderPull() {
    const host = $('#measPull');
    if (!host) return;
    host.innerHTML = '';
    if (!hasAdsData()) return;

    const from = $('#meas_start').value, to = $('#meas_end').value;
    const sum = sumAdsRange(this.campaign, from, to);
    const upTo = adsDataUpTo();

    if (!sum) {
      host.append(el('div', { class: 'banner' },
        el('span', { class: 'icon' }, '☁️'),
        el('span', {}, `ยังไม่มีตัวเลขจาก Google Ads ของช่วงนี้ — ข้อมูลที่ดึงมาแล้วถึงวันที่ ${thaiDate(upTo)}`)));
      return;
    }

    const short = to > upTo;
    host.append(el('div', { class: 'banner good' },
      el('span', { class: 'icon' }, '☁️'),
      el('span', {},
        el('b', {}, `มีตัวเลขจาก Google Ads ${sum.days} วัน `),
        `(Impr ${fmt(sum.impressions, 0)} · Clicks ${fmt(sum.clicks, 0)} · Cost ${fmt(sum.cost, 2)} ฿ · Conv ${fmt(sum.conversions, 2)})`,
        short ? el('div', { class: 'card-note', style: 'margin-top:6px' },
          `ข้อมูลมีถึง ${thaiDate(upTo)} — วันหลังจากนั้นยังไม่ถูกดึงมา ตัวเลขจะไม่ครบช่วง`) : null,
        el('div', { style: 'margin-top:9px' },
          el('button', {
            class: 'btn btn-sm btn-primary', type: 'button', id: 'measPullBtn',
            onclick: () => this.applyAds(sum)
          }, 'เติมตัวเลขให้เลย')))));
  },

  /** เอายอดรวมจาก Google Ads ใส่ช่องกรอก */
  applyAds(sum) {
    fillFromAds('meas', sum);
    this.onInput();
    toast(`เติมตัวเลข ${sum.days} วันจาก Google Ads แล้ว — ตรวจดูก่อนกดบันทึก`, 3800);
  },

  renderBaseline() {
    const host = $('#measBaseline');
    host.innerHTML = '';
    if (!this.baseline) return;
    const b = solveBlock(this.baseline.block).values;
    const strip = el('div', { class: 'baseline-strip' },
      el('span', { class: 'bl-label' }, `ครั้งก่อน ${thaiDate(this.baseline.record.date)}`));
    for (const m of METRICS_BY_TIER('primary')) {
      if (b[m.key] === null) continue;
      strip.append(el('span', { class: 'bl-item' },
        el('b', {}, m.short), ' ', fmtMetric(m.key, b[m.key])));
    }
    host.append(strip);
  },

  onInput() {
    applyDerived($('#measFields'), 'meas', $('#measDerived'));
    const host = $('#measPreview');
    host.innerHTML = '';
    if (!this.baseline) return;
    const cur = readBlock('meas');
    if (!hasNumbers(cur)) return;
    const cmp = compareBlocks(this.baseline.block, cur, 'auto');
    if (!cmp) return;
    const cpaRow = cmp.rows.find(r => r.key === 'cpa');
    const noise = noiseVerdict(this.campaign, cpaRow ? cpaRow.deltaPct : null);
    host.append(el('div', { class: 'verdict-panel' },
      el('div', { class: 'card-head', style: 'margin-bottom:12px' },
        el('h3', {}, 'เทียบกับตัวเลขครั้งก่อน'),
        verdictBadge(cmp.verdict)),
      deltaTiles(cmp),
      confidenceNote(this.baseline.block, cur),
      noise ? el('div', { class: `conf-note ${noise.beyond ? 'conf-high' : 'conf-mid'}` },
        el('b', {}, noise.beyond ? 'เกินกรอบความแกว่งปกติ' : 'ยังอยู่ในกรอบความแกว่งปกติ'),
        ' ' + noise.text) : null));
  },

  async save() {
    const cur = readBlock('meas');
    if (!hasNumbers(cur)) { toast('ยังไม่ได้กรอกตัวเลข'); return; }

    const rec = {
      id: Store.newId(),
      date: $('#meas_date').value || todayISO(),
      campaign: this.campaign,
      product: Store.campaign(this.campaign)?.product || '',
      product_group: '',
      ad_group: '',
      tags: '',
      change_detail: '',          // บันทึกวัดผลล้วน ไม่นับเป็น "การปรับ" ในรอบ
      reason: '',
      expected: '',
      result_note: $('#meas_note').value.trim(),
      budget: '',
      bid: '',
      status: 'มีผลแล้ว'
    };
    rec.product_group = rec.product ? Taxonomy.groupOf(rec.product) : '';

    const solved = solveBlock(cur).values;
    rec.before_start = cur._start;
    rec.before_end = cur._end;
    for (const m of METRICS) {
      rec[`before_${m.key}`] = solved[m.key] === null ? '' : round(solved[m.key], m.dec);
    }
    for (const m of METRICS) rec[`after_${m.key}`] = '';
    rec.after_start = '';
    rec.after_end = '';

    const btn = $('#measSave');
    btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = 'กำลังบันทึก…';
    try {
      await Store.create(rec);
      // เติมผลหลังปรับย้อนกลับไปที่บันทึกก่อนหน้า เพื่อให้ชีตอ่านง่ายเหมือนเดิม
      const prev = Store.latestFor(rec.campaign, rec.date, rec.id);
      if (prev && !hasNumbers(block(prev, 'after'))) {
        const patch = { ...prev };
        for (const m of METRICS) patch[`after_${m.key}`] = rec[`before_${m.key}`];
        patch.after_start = rec.before_start;
        patch.after_end = rec.before_end;
        patch.status = 'มีผลแล้ว';
        await Store.update(patch);
      }
      $('#measureModal').close();
      toast(Store.online ? 'บันทึกตัวเลขลง Google Sheet แล้ว' : 'บันทึกตัวเลขในเครื่องแล้ว');
      Form.refreshBaseline();
      refreshAll();
    } catch (err) {
      toast('บันทึกไม่สำเร็จ: ' + (err.message || err), 5000);
    } finally {
      btn.disabled = false; btn.classList.remove('is-busy'); btn.textContent = 'บันทึกตัวเลข';
    }
  }
};

/* ─────────────────────────────────────────────────────────────
   10a-3. ป๊อปอัพดูตัวเลขของบันทึกที่วัดผลไว้แล้ว
   ───────────────────────────────────────────────────────────── */

function openRecordNumbers(rec) {
  const host = $('#viewBody');
  host.innerHTML = '';
  const b = solveBlock(block(rec, 'before')).values;
  const days = daysBetween(rec.before_start, rec.before_end);

  host.append(el('h2', {}, 'ตัวเลขวัดผล'));
  host.append(el('p', { class: 'card-note' },
    `${rec.campaign} · บันทึกวันที่ ${thaiDate(rec.date)}` +
    (rec.before_start && rec.before_end
      ? ` · ช่วงข้อมูล ${thaiDate(rec.before_start)} – ${thaiDate(rec.before_end)}${days ? ` (${days} วัน)` : ''}`
      : '')));

  // ตารางค่าทุกตัวชี้วัดที่มี
  const rows = METRICS.filter(m => b[m.key] !== null);
  const table = el('table', { class: 'data', style: 'margin-top:14px' },
    el('thead', {}, el('tr', {}, el('th', {}, 'ตัวชี้วัด'), el('th', { class: 'num' }, 'ค่า'))),
    el('tbody', {}, rows.map(m => el('tr', {},
      el('td', {}, m.label),
      el('td', { class: 'num val-strong' }, fmtMetric(m.key, b[m.key]))))));
  host.append(el('div', { class: 'table-wrap' }, table));

  // ผลของรอบที่บันทึกนี้ปิด — ถ้ามีรอบก่อนหน้าให้เทียบ
  const rnd = roundOf(rec);
  const cmp = rnd ? roundCompare(rnd, 'auto') : null;
  if (cmp) {
    host.append(el('div', { class: 'section-label', style: 'margin-top:20px' }, 'เทียบกับรอบก่อนหน้า'));
    const cpaRow = cmp.rows.find(r => r.key === 'cpa');
    const noise = noiseVerdict(rec.campaign, cpaRow ? cpaRow.deltaPct : null);
    host.append(el('div', { class: 'verdict-panel' },
      el('div', { class: 'card-head', style: 'margin-bottom:12px' },
        el('h3', {}, 'ผลรวมของรอบนี้'),
        verdictBadge(cmp.verdict)),
      deltaTiles(cmp),
      confidenceNote(block(rnd.from, 'before'), block(rnd.to, 'before')),
      noise ? el('div', { class: `conf-note ${noise.beyond ? 'conf-high' : 'conf-mid'}` },
        el('b', {}, noise.beyond ? 'เกินกรอบความแกว่งปกติ' : 'ยังอยู่ในกรอบความแกว่งปกติ'),
        ' ' + noise.text) : null));
    host.append(deltaTable(cmp));
    if (rnd.adjustments?.length) {
      host.append(el('div', { class: 'section-label', style: 'margin-top:18px' },
        `การปรับในรอบนี้ ${rnd.adjustments.length} ครั้ง`));
      host.append(el('div', { class: 'round-adjs' }, rnd.adjustments.map(a =>
        el('div', { class: 'adj' }, el('b', {}, thaiDate(a.date)), ' ' + a.change_detail))));
    }
  } else {
    host.append(el('p', { class: 'card-note', style: 'margin-top:16px' },
      'ยังไม่มีตัวเลขครั้งก่อนของแคมเปญนี้ให้เทียบ — ตัวเลขชุดนี้เป็นค่าตั้งต้น'));
  }

  host.append(el('div', { class: 'btn-row' },
    el('button', {
      class: 'btn', onclick: () => { $('#viewModal').close(); Form.load(rec); showTab('new'); }
    }, 'แก้ไขบันทึกนี้'),
    el('button', {
      class: 'btn btn-ghost', onclick: () => $('#viewModal').close()
    }, 'ปิด')));

  $('#viewModal').showModal();
}

/* ─────────────────────────────────────────────────────────────
   10a-4. จับการเปลี่ยนแปลงจาก Google Ads เอง

   หัวใจของเรื่องนี้: ชีต METRICS เก็บ "งบ / กลยุทธ์ / เพดาน bid / เป้า CPA"
   ของทุกวันอยู่แล้ว การเทียบวันต่อวันจึงบอกได้เลยว่าวันไหนมีการปรับ
   ไม่ต้องพึ่ง change history ของ Google (ซึ่งย้อนได้แค่ 30 วัน)

   สิ่งที่จับได้: งบ · กลยุทธ์ bid · เพดาน CPC · Max CPC · เป้า CPA · เป้า ROAS
   สิ่งที่จับไม่ได้: keyword, ข้อความโฆษณา, negative, audience — ต้องจดเอง
   ───────────────────────────────────────────────────────────── */

const LS_DISMISS = 'aar.dismissed.v1';

const WATCHED_FIELDS = [
  { key: 'budget', label: 'งบต่อวัน', tag: 'ปรับงบประมาณ', kind: 'money', dec: 0,
    minPct: 1, setting: 'budget' },
  { key: 'bid_strategy', label: 'กลยุทธ์ Bid', tag: 'เปลี่ยน Bid Strategy', kind: 'text' },
  { key: 'cpc_ceiling', label: 'เพดาน CPC', tag: 'ปรับ Bid / Max CPC', kind: 'money', dec: 2,
    minPct: 1, setting: 'bid' },
  { key: 'max_cpc', label: 'Max CPC', tag: 'ปรับ Bid / Max CPC', kind: 'money', dec: 2,
    minPct: 1, setting: 'bid' },
  { key: 'target_cpa', label: 'เป้า CPA', tag: 'ปรับ Bid / Max CPC', kind: 'money', dec: 2, minPct: 1 },
  { key: 'target_roas', label: 'เป้า ROAS', tag: 'ปรับ Bid / Max CPC', kind: 'ratio', dec: 2, minPct: 1 }
];
const WATCHED_BY_KEY = Object.fromEntries(WATCHED_FIELDS.map(f => [f.key, f]));

function fieldValueText(f, v) {
  if (v === '' || v === null || v === undefined) return '—';
  if (f.kind === 'text') return BID_STRATEGY_TH[v] || String(v);
  if (f.kind === 'ratio') return fmt(num(v) * 100, 0) + '%';
  return fmt(num(v), f.dec) + ' ฿';
}

/**
 * ไล่ดูตัวเลขรายวันของแต่ละแคมเปญ แล้วคืนรายการวันที่ค่าตั้งเปลี่ยน
 * ข้ามวันแรกที่แคมเปญโผล่มา (นั่นคือ "ค่าเริ่มต้น" ไม่ใช่การปรับ)
 */
function adsChangeLog(days = 120) {
  if (!hasAdsData()) return [];
  const cutoff = isoOffset(-days);

  const byCampaign = new Map();
  for (const m of Store.metrics || []) {
    const name = String(m.campaign || '').trim();
    const d = String(m.date || '');
    if (!name || !d) continue;
    if (!byCampaign.has(name)) byCampaign.set(name, []);
    byCampaign.get(name).push(m);
  }

  const out = [];
  for (const [campaign, rowsRaw] of byCampaign) {
    const rows = rowsRaw.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      for (const f of WATCHED_FIELDS) {
        const a = prev[f.key], b = cur[f.key];
        const aEmpty = a === '' || a === null || a === undefined;
        const bEmpty = b === '' || b === null || b === undefined;
        if (aEmpty && bEmpty) continue;
        if (aEmpty) continue;                     // เพิ่งเริ่มมีค่า = ตั้งครั้งแรก ไม่ใช่การปรับ

        let changed;
        if (f.kind === 'text') {
          changed = String(a) !== String(b);
        } else {
          const na = num(a), nb = num(b);
          if (na === null && nb === null) continue;
          if (na === null || nb === null) changed = true;
          else changed = na !== 0
            ? Math.abs(nb - na) / Math.abs(na) * 100 >= (f.minPct || 1)
            : nb !== 0;
        }
        if (!changed) continue;
        if (String(cur.date) < cutoff) continue;

        out.push({
          key: `${campaign}|${cur.date}|${f.key}`,
          campaign, date: String(cur.date), field: f.key, label: f.label,
          from: a, to: b,
          fromText: fieldValueText(f, a),
          toText: fieldValueText(f, b),
          tag: f.tag,
          setting: f.setting || '',
          // ค่าที่จะเอาไปใส่ในฟอร์มย่อยของแท็ก (ช่อง "จาก" / "เป็น")
          formFrom: f.kind === 'text' ? (BID_STRATEGY_TH[a] || String(a)) : num(a),
          formTo: f.kind === 'text' ? (BID_STRATEGY_TH[b] || String(b)) : num(b),
          detail: `${f.label} ${fieldValueText(f, a)} → ${fieldValueText(f, b)}`
        });
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.campaign.localeCompare(b.campaign));
}

function dismissedKeys() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_DISMISS) || '[]')); }
  catch { return new Set(); }
}

function dismissChange(key) {
  const s = dismissedKeys();
  s.add(key);
  // เก็บแค่ 500 อันล่าสุดพอ ไม่งั้นโตไม่มีที่สิ้นสุด
  try { localStorage.setItem(LS_DISMISS, JSON.stringify([...s].slice(-500))); } catch { /* เต็มก็ช่างมัน */ }
}

function undismissChange(key) {
  const s = dismissedKeys();
  s.delete(key);
  try { localStorage.setItem(LS_DISMISS, JSON.stringify([...s])); } catch { /* ไม่เป็นไร */ }
}

/**
 * ยืนยันไปแล้วหรือยัง
 * ตรวจสองทาง — auto_key ที่บันทึกไว้ตรง ๆ (แม่นสุด) กับการเดาจากบันทึกที่จดเอง
 * (แคมเปญเดียวกัน วันเดียวกัน และข้อความพูดถึงเรื่องเดียวกัน)
 */
function changeCovered(ch) {
  for (const r of Store.records) {
    if (String(r.auto_key || '') === ch.key) return 'confirmed';
  }
  const f = WATCHED_BY_KEY[ch.field];
  for (const r of Store.records) {
    if (r.campaign !== ch.campaign) continue;
    if (Math.abs(daysBetween(r.date, ch.date)) > 1) continue;
    const text = `${r.change_detail || ''} ${r.tags || ''}`;
    if (ch.field === 'budget' && /งบ|budget/i.test(text)) return 'manual';
    if (ch.field !== 'budget' && f && /bid|บิด|ประมูล|เพดาน|กลยุทธ|CPA|ROAS/i.test(text)) return 'manual';
  }
  return '';
}

/** การเปลี่ยนแปลงที่ยังไม่ได้จดและยังไม่ได้ปัดทิ้ง */
function pendingAdsChanges() {
  const dismissed = dismissedKeys();
  return adsChangeLog().filter(ch => !dismissed.has(ch.key) && !changeCovered(ch));
}

/* ─────────────────────────────────────────────────────────────
   10a-4b. บันทึกที่ถึงกำหนดวัดผลแล้ว

   "ถึงกำหนด" ไม่ได้แปลว่าครบ N วัน แต่แปลว่า "มีข้อมูลพอจะสรุปได้แล้ว"
   ระบบจึงเช็กจำนวน conversion จริงในชีต ไม่ใช่นับวันอย่างเดียว
   ───────────────────────────────────────────────────────────── */

const MEASURE_MIN_DAYS = 7;

function dueMeasurements() {
  const today = todayISO();
  const upTo = adsDataUpTo();
  const seen = new Set();
  const out = [];

  for (const rec of Store.sorted()) {
    const campaign = rec.campaign;
    if (!campaign || seen.has(campaign)) continue;
    if (!hasAdjustment(rec)) continue;            // ดูเฉพาะแคมเปญที่การปรับล่าสุดยังไม่ถูกวัด
    seen.add(campaign);

    const prev = Store.latestMeasured(campaign, today, null);
    // ถ้าตัวเลขล่าสุดใหม่กว่าการปรับล่าสุด = วัดไปแล้ว
    if (prev && String(prev.date) >= String(rec.date)) continue;

    const from = prev?.before_end || prev?.date || rec.date;
    const waited = daysBetween(from, today);
    if (waited < MEASURE_MIN_DAYS) continue;

    const adj = Store.adjustmentsSince(campaign, from, today, null);
    const sum = upTo ? sumAdsRange(campaign, from, upTo) : null;
    const conv = sum ? sum.conversions : null;
    const ready = conv !== null && conv >= CONF_CONV_MIN;

    out.push({
      campaign, from, waited, adjustments: adj.length, conv, ready,
      lastAdjust: rec.date,
      note: conv === null
        ? 'ยังไม่มีตัวเลขจาก Google Ads ของช่วงนี้ — กรอกเองได้'
        : ready
          ? `มี conversion ${fmt(conv, 2)} ครั้งในช่วงนี้ — พอสรุปได้แล้ว`
          : `มี conversion แค่ ${fmt(conv, 2)} ครั้ง — รออีกหน่อยจะสรุปได้แม่นกว่า`
    });
  }
  return out.sort((a, b) => (b.ready - a.ready) || (b.waited - a.waited));
}

/* ─────────────────────────────────────────────────────────────
   10a-4c. กล่องงานที่รอ (บนหน้าไทม์ไลน์)
   ───────────────────────────────────────────────────────────── */

function inboxCount() {
  try { return pendingAdsChanges().length + dueMeasurements().filter(d => d.ready).length; }
  catch { return 0; }
}

function updateInboxBadge() {
  const badge = $('#inboxBadge');
  if (!badge) return;
  const n = inboxCount();
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n;
  badge.title = `มี ${n} รายการรอจัดการในไทม์ไลน์`;
}

function renderInbox() {
  updateInboxBadge();
  const host = $('#inbox');
  if (!host) return;
  host.innerHTML = '';
  if (!hasAdsData()) return;

  const changes = pendingAdsChanges();
  const due = dueMeasurements();

  if (!changes.length && !due.length) return;

  // ── การเปลี่ยนแปลงที่ Google Ads บอกมา แต่ยังไม่ได้จด
  if (changes.length) {
    const list = el('div', { class: 'inbox-list' });
    for (const ch of changes.slice(0, 12)) {
      list.append(el('div', { class: 'inbox-item', 'data-key': ch.key },
        el('div', { class: 'ib-main' },
          el('div', { class: 'ib-title' },
            el('b', {}, ch.campaign),
            el('span', { class: 'ib-date' }, `${thaiDate(ch.date)} · ${relativeDay(ch.date)}`)),
          el('div', { class: 'ib-detail' },
            ch.label + ' ',
            el('span', { class: 'ib-from' }, ch.fromText),
            el('span', { class: 'ib-arrow' }, ' → '),
            el('span', { class: 'ib-to' }, ch.toText))),
        el('div', { class: 'ib-actions' },
          el('button', {
            class: 'btn btn-sm btn-primary', onclick: () => confirmAdsChange(ch)
          }, 'ยืนยัน + ใส่เหตุผล'),
          el('button', {
            class: 'btn btn-sm btn-ghost', title: 'ซ่อนรายการนี้ไว้ในเครื่องนี้',
            onclick: () => {
              dismissChange(ch.key);
              renderInbox();
              toastAction('ซ่อนแล้ว', 'เลิกทำ', () => { undismissChange(ch.key); renderInbox(); });
            }
          }, 'ไม่ใช่การปรับ'))));
    }

    host.append(el('div', { class: 'card inbox-card' },
      el('div', { class: 'card-head' },
        el('h2', {}, 'Google Ads บอกว่ามีการปรับ ', el('span', { class: 'pill-count' }, String(changes.length))),
        el('span', { class: 'card-note' },
          'เทียบตัวเลขรายวันแล้วเจอค่าที่เปลี่ยน — กดยืนยันเพื่อจดลงไทม์ไลน์พร้อมเหตุผล')),
      list,
      changes.length > 12
        ? el('p', { class: 'card-note', style: 'margin-top:10px' },
            `แสดง 12 รายการแรกจาก ${changes.length} — จัดการแล้วรายการถัดไปจะขึ้นมาเอง`)
        : null,
      el('p', { class: 'card-note', style: 'margin-top:10px' },
        'จับได้เฉพาะงบ · กลยุทธ์ bid · เพดาน CPC · เป้า CPA/ROAS · ' +
        'ส่วน keyword, ข้อความโฆษณา, negative ยังต้องจดเอง')));
  }

  // ── บันทึกที่ถึงกำหนดวัดผล
  if (due.length) {
    const list = el('div', { class: 'inbox-list' });
    for (const d of due) {
      list.append(el('div', { class: `inbox-item${d.ready ? ' is-ready' : ''}` },
        el('div', { class: 'ib-main' },
          el('div', { class: 'ib-title' },
            el('b', {}, d.campaign),
            el('span', { class: 'ib-date' },
              `ปรับล่าสุด ${thaiDate(d.lastAdjust)} · ผ่านมา ${d.waited} วัน` +
              (d.adjustments > 1 ? ` · ปรับไป ${d.adjustments} ครั้ง` : ''))),
          el('div', { class: 'ib-detail' }, d.note)),
        el('div', { class: 'ib-actions' },
          el('button', {
            class: `btn btn-sm${d.ready ? ' btn-primary' : ''}`,
            onclick: () => Measure.open(d.campaign)
          }, 'ใส่ตัวเลขวัดผล'))));
    }
    host.append(el('div', { class: 'card inbox-card' },
      el('div', { class: 'card-head' },
        el('h2', {}, 'ถึงกำหนดวัดผล ',
          el('span', { class: 'pill-count' }, String(due.filter(x => x.ready).length))),
        el('span', { class: 'card-note' },
          `แคมเปญที่ปรับไปแล้วเกิน ${MEASURE_MIN_DAYS} วันแต่ยังไม่ได้ใส่ตัวเลข`)),
      list));
  }
}

/** เอาการเปลี่ยนแปลงที่ Ads บอกมา ไปเปิดเป็นร่างบันทึกใหม่ให้ใส่เหตุผล */
function confirmAdsChange(ch) {
  showTab('new');
  Form.draft(ch);
  toast('เติมรายละเอียดจาก Google Ads ให้แล้ว — เหลือใส่เหตุผลกับผลที่คาดหวัง', 4200);
}

/* ─────────────────────────────────────────────────────────────
   10a-5. หน้า "ตัวเลขรายวัน" — Cost / Impr / Clicks / Conversions
   ข้อมูลมาจากชีต METRICS ที่ Google Ads Script ส่งมาให้ทุกวัน
   ───────────────────────────────────────────────────────────── */

const SPEND_PRESETS = [
  { key: '7', label: '7 วัน', days: 7 },
  { key: '14', label: '14 วัน', days: 14 },
  { key: '30', label: '30 วัน', days: 30 },
  { key: '90', label: '90 วัน', days: 90 },
  { key: 'all', label: 'ทั้งหมด', days: 0 }
];

/** รวมยอดของชุดแถว แล้วคำนวณอัตราส่วนใหม่จากยอดรวม (ไม่ใช่เฉลี่ยของเฉลี่ย) */
function spendTotals(rows) {
  let impressions = 0, clicks = 0, cost = 0, conversions = 0, convValue = 0;
  for (const m of rows) {
    impressions += num(m.impressions) || 0;
    clicks += num(m.clicks) || 0;
    cost += num(m.cost) || 0;
    conversions += num(m.conversions) || 0;
    convValue += num(m.conv_value) || 0;
  }
  return {
    impressions, clicks,
    cost: round(cost, 2),
    conversions: round(conversions, 2),
    conv_value: round(convValue, 2),
    ctr: impressions ? round(clicks / impressions * 100, 2) : null,
    cpc: clicks ? round(cost / clicks, 2) : null,
    cvr: clicks ? round(conversions / clicks * 100, 2) : null,
    cpa: conversions ? round(cost / conversions, 2) : null
  };
}

/** แถว METRICS ที่อยู่ในช่วง + ตรงแคมเปญที่เลือก */
function spendRows() {
  const from = $('#spend_from').value, to = $('#spend_to').value;
  const camp = $('#spendCampaign').value;
  return (Store.metrics || []).filter(m => {
    const d = String(m.date || '');
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (camp && String(m.campaign || '').trim() !== camp) return false;
    return true;
  });
}

/** ยุบเป็นรายวัน (รวมทุกแคมเปญในวันนั้น) */
function spendByDay(rows) {
  const byDate = new Map();
  for (const m of rows) {
    const d = String(m.date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(m);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))          // ใหม่อยู่บน
    .map(([date, list]) => ({ date, ...spendTotals(list) }));
}

function spendByCampaign(rows) {
  const byName = new Map();
  for (const m of rows) {
    const n = String(m.campaign || '').trim();
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(m);
  }
  return [...byName.entries()]
    .map(([campaign, list]) => ({ campaign, ...spendTotals(list) }))
    .sort((a, b) => b.cost - a.cost);
}

function setSpendRange(days) {
  const upTo = adsDataUpTo() || todayISO();
  $('#spend_to').value = upTo;
  if (!days) {
    let first = upTo;
    for (const m of Store.metrics || []) {
      const d = String(m.date || '');
      if (d && d < first) first = d;
    }
    $('#spend_from').value = first;
  } else {
    const d = new Date(upTo);
    d.setDate(d.getDate() - (days - 1));
    $('#spend_from').value = d.toLocaleDateString('sv-SE');
  }
}

function initSpendPage() {
  const presets = $('#spendPresets');
  presets.innerHTML = '';
  for (const p of SPEND_PRESETS) {
    presets.append(el('button', {
      type: 'button', class: 'chip', 'data-preset': p.key,
      'aria-pressed': String(p.key === '30'),
      onclick: () => {
        $$('#spendPresets .chip').forEach(c =>
          c.setAttribute('aria-pressed', String(c.dataset.preset === p.key)));
        setSpendRange(p.days);
        renderSpendPage();
      }
    }, p.label));
  }
  for (const id of ['#spend_from', '#spend_to', '#spendCampaign', '#spendMetric']) {
    $(id).addEventListener('change', () => {
      if (id === '#spend_from' || id === '#spend_to') {
        $$('#spendPresets .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      }
      renderSpendPage();
    });
  }
  $('#spendCopyDay').addEventListener('click', () => copySpend('day'));
  $('#spendCopyCd').addEventListener('click', () => copySpend('campaignDay'));
  $('#spendCdExpand').addEventListener('click', e => {
    const boxes = $$('#spendCdList .cd-day');
    const openAll = boxes.some(b => !b.open);
    boxes.forEach(b => { b.open = openAll; });
    e.currentTarget.textContent = openAll ? 'พับทุกวัน' : 'กางทุกวัน';
  });
  $('#spendCopyCamp').addEventListener('click', () => copySpend('campaign'));
  window.addEventListener('resize', () => {
    if (!$('#panel-spend').hidden) drawSpendBars();
  });
}

function renderSpendPage() {
  const warn = $('#spendWarn');
  warn.innerHTML = '';

  if (!hasAdsData()) {
    warn.append(el('div', { class: 'banner warn' },
      el('span', { class: 'icon' }, '☁️'),
      el('span', {},
        el('b', {}, 'ยังไม่มีตัวเลขจาก Google Ads '),
        'หน้านี้จะมีข้อมูลเมื่อตั้ง Google Ads Script (ไฟล์ DailyMetrics.js) ให้รันวันละครั้งแล้ว — ดูขั้นตอนใน README')));
    $('#spendStats').innerHTML = '';
    $('#spendCampTable').querySelector('tbody').innerHTML = '';
    $('#spendCampTable').querySelector('tfoot').innerHTML = '';
    $('#spendDayTable').querySelector('tbody').innerHTML = '';
    $('#spendDayTable').querySelector('tfoot').innerHTML = '';
    $('#spendChart').innerHTML = '';
    $('#spendCdList').innerHTML = '';
    if ($('#benchList')) $('#benchList').innerHTML = '';
    if ($('#dowHint')) $('#dowHint').innerHTML = '';
    if ($('#dowTable')) $('#dowTable').querySelector('tbody').innerHTML = '';
    return;
  }

  // ตั้งช่วงเริ่มต้นครั้งแรกที่เข้ามา
  if (!$('#spend_from').value || !$('#spend_to').value) setSpendRange(30);
  fillSelect($('#spendCampaign'), adsCampaignNames().sort(), 'ทุกแคมเปญ (ยอดรวม)');

  const upTo = adsDataUpTo();
  warn.append(el('div', { class: 'banner good' },
    el('span', { class: 'icon' }, '☁️'),
    el('span', {}, `ตัวเลขจาก Google Ads · ข้อมูลล่าสุดถึงวันที่ ${thaiDate(upTo)} (${relativeDay(upTo)})`)));

  const rows = spendRows();
  const days = spendByDay(rows);
  const camps = spendByCampaign(rows);
  const total = spendTotals(rows);
  const only = $('#spendCampaign').value;

  // ── การ์ดสรุป
  const stats = $('#spendStats');
  stats.innerHTML = '';
  const cards = [
    { cls: 'c3', icon: 'edit', label: 'Cost รวม', value: fmt(total.cost, 2), unit: ' ฿',
      active: true, sub: days.length ? `เฉลี่ย ${fmt(total.cost / days.length, 2)} ฿/วัน` : '—' },
    { cls: 'c1', icon: 'clock', label: 'Impressions', value: fmt(total.impressions, 0), unit: '',
      sub: `Clicks ${fmt(total.clicks, 0)} · CTR ${total.ctr === null ? '—' : fmt(total.ctr, 2) + '%'}` },
    { cls: 'c4', icon: 'up', label: 'Conversions', value: fmt(total.conversions, 2), unit: '',
      sub: total.cvr === null ? 'ยังไม่มีคลิก' : `CVR ${fmt(total.cvr, 2)}%` },
    { cls: 'c2', icon: 'down', label: 'CPA', value: total.cpa === null ? '—' : fmt(total.cpa, 2),
      unit: total.cpa === null ? '' : ' ฿',
      sub: total.cpc === null ? '—' : `CPC เฉลี่ย ${fmt(total.cpc, 2)} ฿` }
  ];
  for (const c of cards) {
    stats.append(el('div', { class: `stat-card ${c.cls}${c.active ? ' is-active' : ''}` },
      el('div', { class: 'sc-body' },
        el('div', { class: 'sc-label' }, c.label),
        statValue(c.value, c.unit),
        el('div', { class: 'sc-sub' }, c.sub)),
      svgIcon(c.icon)));
  }

  const metric = $('#spendMetric').value;
  const METRIC_LABEL = { cost: 'Cost', impressions: 'Impressions', clicks: 'Clicks', conversions: 'Conversions' };
  renderCampaignDay();
  renderBenchmark();
  renderWeekdayTable();
  $('#spendChartTitle').textContent = `${METRIC_LABEL[metric]} รายวัน`;
  $('#spendChartNote').textContent = only
    ? `${only} · ${days.length} วัน`
    : `รวมทุกแคมเปญ · ${days.length} วัน · ${camps.length} แคมเปญ`;
  drawSpendBars();

  // ── ตารางรายแคมเปญ
  const cTb = $('#spendCampTable').querySelector('tbody');
  const cTf = $('#spendCampTable').querySelector('tfoot');
  cTb.innerHTML = ''; cTf.innerHTML = '';
  if (!camps.length) {
    cTb.append(el('tr', {}, el('td', { colspan: '9' },
      el('div', { class: 'empty' }, el('strong', {}, 'ไม่มีข้อมูลในช่วงนี้'), 'ลองขยายช่วงเวลา'))));
  } else {
    for (const c of camps) {
      cTb.append(el('tr', {},
        el('td', { class: 'table-left' }, el('b', {}, c.campaign)),
        el('td', { class: 'num' }, fmt(c.impressions, 0)),
        el('td', { class: 'num' }, fmt(c.clicks, 0)),
        el('td', { class: 'num val-strong' }, fmt(c.cost, 2)),
        el('td', { class: 'num' }, fmt(c.conversions, 2)),
        el('td', { class: 'num' }, c.ctr === null ? '—' : fmt(c.ctr, 2) + '%'),
        el('td', { class: 'num' }, c.cpc === null ? '—' : fmt(c.cpc, 2)),
        el('td', { class: 'num' }, c.cpa === null ? '—' : fmt(c.cpa, 2)),
        el('td', { class: 'num' }, total.cost ? fmt(c.cost / total.cost * 100, 1) + '%' : '—')));
    }
    cTf.append(el('tr', { class: 'row-total' },
      el('td', { class: 'table-left' }, 'รวมทั้งหมด'),
      el('td', { class: 'num' }, fmt(total.impressions, 0)),
      el('td', { class: 'num' }, fmt(total.clicks, 0)),
      el('td', { class: 'num' }, fmt(total.cost, 2)),
      el('td', { class: 'num' }, fmt(total.conversions, 2)),
      el('td', { class: 'num' }, total.ctr === null ? '—' : fmt(total.ctr, 2) + '%'),
      el('td', { class: 'num' }, total.cpc === null ? '—' : fmt(total.cpc, 2)),
      el('td', { class: 'num' }, total.cpa === null ? '—' : fmt(total.cpa, 2)),
      el('td', { class: 'num' }, '100%')));
  }

  // ── ตารางรายวัน
  const dTb = $('#spendDayTable').querySelector('tbody');
  const dTf = $('#spendDayTable').querySelector('tfoot');
  dTb.innerHTML = ''; dTf.innerHTML = '';
  $('#spendDayNote').textContent = only ? only : 'รวมทุกแคมเปญ';
  if (!days.length) {
    dTb.append(el('tr', {}, el('td', { colspan: '8' },
      el('div', { class: 'empty' }, el('strong', {}, 'ไม่มีข้อมูลในช่วงนี้'), 'ลองขยายช่วงเวลา'))));
  } else {
    for (const dRow of days) {
      dTb.append(el('tr', {},
        el('td', { class: 'table-left' }, thaiDate(dRow.date),
          el('span', { class: 'card-note', style: 'margin-left:8px' }, relativeDay(dRow.date))),
        el('td', { class: 'num' }, fmt(dRow.impressions, 0)),
        el('td', { class: 'num' }, fmt(dRow.clicks, 0)),
        el('td', { class: 'num val-strong' }, fmt(dRow.cost, 2)),
        el('td', { class: 'num' }, fmt(dRow.conversions, 2)),
        el('td', { class: 'num' }, dRow.ctr === null ? '—' : fmt(dRow.ctr, 2) + '%'),
        el('td', { class: 'num' }, dRow.cpc === null ? '—' : fmt(dRow.cpc, 2)),
        el('td', { class: 'num' }, dRow.cpa === null ? '—' : fmt(dRow.cpa, 2))));
    }
    dTf.append(el('tr', { class: 'row-total' },
      el('td', { class: 'table-left' }, `รวม ${days.length} วัน`),
      el('td', { class: 'num' }, fmt(total.impressions, 0)),
      el('td', { class: 'num' }, fmt(total.clicks, 0)),
      el('td', { class: 'num' }, fmt(total.cost, 2)),
      el('td', { class: 'num' }, fmt(total.conversions, 2)),
      el('td', { class: 'num' }, total.ctr === null ? '—' : fmt(total.ctr, 2) + '%'),
      el('td', { class: 'num' }, total.cpc === null ? '—' : fmt(total.cpc, 2)),
      el('td', { class: 'num' }, total.cpa === null ? '—' : fmt(total.cpa, 2))));
  }
}

/**
 * ตารางรายแคมเปญแยกตามวัน — วันละหนึ่งกล่องพับได้
 * ยุบเป็น <details> เพราะ 18 แคมเปญ × 30 วัน = 540 แถว ถ้ากางหมดจะอ่านไม่ไหว
 */
function renderCampaignDay() {
  const host = $('#spendCdList');
  if (!host) return;
  host.innerHTML = '';

  const rows = spendRows();
  if (!rows.length) {
    host.append(el('div', { class: 'empty' },
      el('strong', {}, 'ไม่มีข้อมูลในช่วงนี้'), 'ลองขยายช่วงเวลา'));
    return;
  }

  const byDate = new Map();
  for (const m of rows) {
    const d = String(m.date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(m);
  }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));   // ใหม่อยู่บน

  dates.forEach((date, i) => {
    const list = byDate.get(date);
    const dayTotal = spendTotals(list);
    const camps = list
      .map(m => ({ campaign: String(m.campaign || '').trim(), ...spendTotals([m]) }))
      .sort((a, b) => b.cost - a.cost);

    const box = el('details', { class: 'cd-day', open: i === 0 || null });
    box.append(el('summary', {},
      el('span', { class: 'cd-date' }, thaiDate(date)),
      el('span', { class: 'cd-rel' }, relativeDay(date)),
      el('span', { class: 'cd-sum' },
        `Cost ${fmt(dayTotal.cost, 2)} ฿ · Impr ${fmt(dayTotal.impressions, 0)} · ` +
        `Clicks ${fmt(dayTotal.clicks, 0)} · Conv ${fmt(dayTotal.conversions, 2)}`),
      el('span', { class: 'cd-count' }, `${camps.length} แคมเปญ`)));

    const tb = el('tbody');
    for (const c of camps) {
      tb.append(el('tr', {},
        el('td', { class: 'table-left' }, c.campaign),
        el('td', { class: 'num' }, fmt(c.impressions, 0)),
        el('td', { class: 'num' }, fmt(c.clicks, 0)),
        el('td', { class: 'num val-strong' }, fmt(c.cost, 2)),
        el('td', { class: 'num' }, fmt(c.conversions, 2)),
        el('td', { class: 'num' }, c.ctr === null ? '—' : fmt(c.ctr, 2) + '%'),
        el('td', { class: 'num' }, c.cpc === null ? '—' : fmt(c.cpc, 2)),
        el('td', { class: 'num' }, c.cpa === null ? '—' : fmt(c.cpa, 2))));
    }

    box.append(el('div', { class: 'table-wrap' },
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'table-left' }, 'แคมเปญ'),
          el('th', { class: 'num' }, 'Impr'), el('th', { class: 'num' }, 'Clicks'),
          el('th', { class: 'num' }, 'Cost'), el('th', { class: 'num' }, 'Conv'),
          el('th', { class: 'num' }, 'CTR'), el('th', { class: 'num' }, 'CPC'),
          el('th', { class: 'num' }, 'CPA'))),
        tb,
        el('tfoot', {}, el('tr', { class: 'row-total' },
          el('td', { class: 'table-left' }, `รวมวันนี้`),
          el('td', { class: 'num' }, fmt(dayTotal.impressions, 0)),
          el('td', { class: 'num' }, fmt(dayTotal.clicks, 0)),
          el('td', { class: 'num' }, fmt(dayTotal.cost, 2)),
          el('td', { class: 'num' }, fmt(dayTotal.conversions, 2)),
          el('td', { class: 'num' }, dayTotal.ctr === null ? '—' : fmt(dayTotal.ctr, 2) + '%'),
          el('td', { class: 'num' }, dayTotal.cpc === null ? '—' : fmt(dayTotal.cpc, 2)),
          el('td', { class: 'num' }, dayTotal.cpa === null ? '—' : fmt(dayTotal.cpa, 2)))))));

    host.append(box);
  });
}

/** กราฟแท่งรายวัน — แท่งเดียวต่อวัน ตัวชี้วัดตามที่เลือก */
function drawSpendBars() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#spendChart');
  const shell = $('#spendShell');
  const tooltip = $('#spendTooltip');
  if (!svg || !shell) return;
  svg.innerHTML = '';
  tooltip.hidden = true;

  const mk = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const metric = $('#spendMetric').value;
  const dec = metric === 'cost' ? 2 : metric === 'conversions' ? 2 : 0;
  const days = spendByDay(spendRows()).slice().reverse();   // เก่า → ใหม่ ตามแกนเวลา
  const width = Math.max(320, shell.clientWidth || 720);

  if (!days.length) {
    svg.setAttribute('width', width);
    svg.setAttribute('height', 90);
    svg.setAttribute('viewBox', `0 0 ${width} 90`);
    svg.append(mk('text', { x: width / 2, y: 48, 'text-anchor': 'middle' }, 'ไม่มีข้อมูลในช่วงนี้'));
    return;
  }

  const M = { top: 14, right: 16, bottom: 34, left: 62 };
  const height = 260;
  const W = width - M.left - M.right;
  const H = height - M.top - M.bottom;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const vals = days.map(d => Number(d[metric]) || 0);
  const max = Math.max(...vals, 1);
  const ticks = niceTicks(0, max, 4);
  const top = ticks[ticks.length - 1] || max;
  const y = v => M.top + H - (v / top) * H;

  for (const t of ticks) {
    svg.append(mk('line', {
      x1: M.left, x2: M.left + W, y1: y(t), y2: y(t),
      stroke: cssVar('--gridline'), 'stroke-width': 1
    }));
    svg.append(mk('text', {
      x: M.left - 9, y: y(t) + 4, 'text-anchor': 'end',
      fill: cssVar('--text-muted'), 'font-size': 11
    }, fmt(t, t >= 1000 ? 0 : dec)));
  }

  const slot = W / days.length;
  const bw = Math.max(2, Math.min(34, slot * 0.68));
  const accent = cssVar('--accent');

  days.forEach((d, i) => {
    const v = Number(d[metric]) || 0;
    const cx = M.left + slot * i + slot / 2;
    const h = Math.max(v > 0 ? 1.5 : 0, M.top + H - y(v));
    const bar = mk('rect', {
      x: cx - bw / 2, y: y(v), width: bw, height: h,
      rx: Math.min(4, bw / 2), fill: accent, opacity: 0.88
    });
    bar.addEventListener('mouseenter', e => {
      bar.setAttribute('opacity', '1');
      tooltip.hidden = false;
      tooltip.innerHTML =
        `<b>${esc(thaiDate(d.date))}</b><br>` +
        `Impr ${esc(fmt(d.impressions, 0))} · Clicks ${esc(fmt(d.clicks, 0))}<br>` +
        `Cost ${esc(fmt(d.cost, 2))} ฿ · Conv ${esc(fmt(d.conversions, 2))}<br>` +
        `CTR ${d.ctr === null ? '—' : esc(fmt(d.ctr, 2)) + '%'} · ` +
        `CPC ${d.cpc === null ? '—' : esc(fmt(d.cpc, 2))} · ` +
        `CPA ${d.cpa === null ? '—' : esc(fmt(d.cpa, 2))}`;
      const r = shell.getBoundingClientRect();
      tooltip.style.left = Math.min(Math.max(e.clientX - r.left + 12, 8), r.width - 210) + 'px';
      tooltip.style.top = Math.max(e.clientY - r.top - 10, 8) + 'px';
    });
    bar.addEventListener('mouseleave', () => {
      bar.setAttribute('opacity', '0.88');
      tooltip.hidden = true;
    });
    svg.append(bar);

    // ป้ายวันที่ — เว้นระยะไม่ให้ตัวหนังสือทับกัน
    const every = Math.max(1, Math.ceil(days.length / (W / 58)));
    if (i % every === 0 || i === days.length - 1) {
      const dt = parseDate(d.date);
      svg.append(mk('text', {
        x: cx, y: height - 12, 'text-anchor': 'middle',
        fill: cssVar('--text-muted'), 'font-size': 11
      }, dt ? `${dt.getDate()}/${dt.getMonth() + 1}` : d.date));
    }
  });

  svg.append(mk('line', {
    x1: M.left, x2: M.left + W, y1: M.top + H, y2: M.top + H,
    stroke: cssVar('--baseline'), 'stroke-width': 1
  }));
}

/* ─────────────────────────────────────────────────────────────
   10a-9. เทียบกันในกลุ่มสินค้าเดียวกัน

   ทำไมถึงมีความหมาย: แคมเปญที่ขาย MacBook เหมือนกันสองตัว ควรมี CPA
   อยู่ระดับใกล้เคียงกัน ถ้าตัวหนึ่งแพงกว่าอีกตัวเท่าตัว นั่นคือจุดที่ควรไปดู
   เทียบข้ามกลุ่ม (MacBook กับ Speaker) ไม่มีความหมาย เพราะราคาของต่างกันอยู่แล้ว
   ───────────────────────────────────────────────────────────── */

const BENCH_METRICS = {
  cpa: { label: 'CPA', better: 'down', dec: 2, unit: ' ฿' },
  cpc: { label: 'CPC', better: 'down', dec: 2, unit: ' ฿' },
  ctr: { label: 'CTR', better: 'up', dec: 2, unit: '%' },
  cvr: { label: 'CVR', better: 'up', dec: 2, unit: '%' }
};

/** จัดแคมเปญเข้ากลุ่มสินค้า แล้วคำนวณค่ากลางของแต่ละกลุ่ม */
function groupBenchmark(metricKey = 'cpa') {
  const from = $('#spend_from')?.value, to = $('#spend_to')?.value;
  if (!from || !to) return [];

  const byGroup = new Map();
  for (const name of adsCampaignNames()) {
    const recs = Store.sorted().filter(r => r.campaign === name);
    const product = recs.length ? recProduct(recs[0]) : (Store.campaign(name)?.product || '');
    const group = product ? Taxonomy.groupOf(product) : '';
    if (!group) continue;                     // ยังไม่ได้ผูกสินค้า = เทียบกับใครไม่ได้

    const sum = sumAdsRange(name, from, to);
    if (!sum) continue;
    const v = sum[metricKey];
    if (v === null || !isFinite(v)) continue;

    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ campaign: name, product, value: v, sum });
  }

  const out = [];
  for (const [group, items] of byGroup) {
    if (items.length < 2) continue;           // มีตัวเดียวก็ไม่มีอะไรให้เทียบ
    // ใช้ค่ากลาง (median) ไม่ใช่ค่าเฉลี่ย — ตัวโดดตัวเดียวไม่ควรลากเส้นฐาน
    const sorted = items.map(i => i.value).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const better = BENCH_METRICS[metricKey].better;
    out.push({
      group, median,
      items: items.map(i => ({
        ...i,
        pct: median ? round((i.value - median) / median * 100, 1) : 0,
        worse: better === 'down' ? i.value > median : i.value < median
      })).sort((a, b) => better === 'down' ? b.value - a.value : a.value - b.value)
    });
  }
  return out.sort((a, b) => b.items.length - a.items.length);
}

function renderBenchmark() {
  const host = $('#benchList');
  const sel = $('#benchMetric');
  if (!host || !sel) return;
  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => renderBenchmark());
  }
  const key = sel.value || 'cpa';
  const spec = BENCH_METRICS[key];
  host.innerHTML = '';

  const groups = groupBenchmark(key);
  if (!groups.length) {
    host.append(el('div', { class: 'empty' },
      el('strong', {}, 'ยังเทียบไม่ได้'),
      'ต้องมีอย่างน้อย 2 แคมเปญที่ผูกสินค้าอยู่ในกลุ่มเดียวกัน และมีตัวเลขในช่วงที่เลือก — ' +
      'ผูกสินค้าให้แคมเปญได้ที่หน้า "บันทึกใหม่" หรือหน้าตั้งค่า'));
    return;
  }

  for (const g of groups) {
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'table-left' }, 'แคมเปญ'),
        el('th', { class: 'table-left' }, 'สินค้า'),
        el('th', { class: 'num' }, spec.label),
        el('th', { class: 'num' }, 'ต่างจากค่ากลาง'),
        el('th', { class: 'num' }, 'Cost'),
        el('th', { class: 'num' }, 'Conv'))),
      el('tbody', {}, g.items.map(i => {
        const off = Math.abs(i.pct);
        // ห่างจากค่ากลางเกิน 25% ถือว่าน่าไปดู
        const flag = off >= 25 && i.worse;
        return el('tr', { class: flag ? 'row-warn' : '' },
          el('td', { class: 'table-left' }, el('b', {}, i.campaign)),
          el('td', { class: 'table-left cell-sub' }, i.product),
          el('td', { class: 'num val-strong' }, fmt(i.value, spec.dec) + spec.unit),
          el('td', { class: 'num ' + (off < 5 ? 'delta-flat' : i.worse ? 'delta-down' : 'delta-up') },
            (i.pct > 0 ? '+' : '') + fmt(i.pct, 0) + '%',
            flag ? el('span', { title: 'ห่างจากค่ากลางของกลุ่มมาก — น่าเข้าไปดู' }, ' ⚠') : null),
          el('td', { class: 'num' }, fmt(i.sum.cost, 0)),
          el('td', { class: 'num' }, fmt(i.sum.conversions, 2)));
      })));

    host.append(el('div', { class: 'bench-group' },
      el('div', { class: 'section-label' },
        `${g.group} · ${g.items.length} แคมเปญ · ` +
        (g.items.length === 2 ? 'จุดกึ่งกลางของสองตัว ' : `ค่ากลาง ${spec.label} `) +
        `${fmt(g.median, spec.dec)}${spec.unit}`),
      el('div', { class: 'table-wrap' }, tbl)));
  }
  host.append(el('p', { class: 'card-note', style: 'margin-top:10px' },
    'ใช้ค่ากลาง (median) เป็นเส้นฐาน ไม่ใช่ค่าเฉลี่ย — แคมเปญที่โดดไปตัวเดียวจะได้ไม่ลากเส้นฐานตามไปด้วย · ' +
    '⚠ = ห่างจากค่ากลางเกิน 25% ในทางที่แย่กว่า'));
}

/* ─────────────────────────────────────────────────────────────
   10a-10. วันไหนของสัปดาห์แพงกว่ากัน
   ───────────────────────────────────────────────────────────── */

const WEEKDAY_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

function weekdayStats(rows) {
  const buckets = WEEKDAY_TH.map((name, i) => ({
    i, name, days: new Set(), impressions: 0, clicks: 0, cost: 0, conversions: 0
  }));
  for (const m of rows) {
    const d = parseDate(m.date);
    if (!d) continue;
    const b = buckets[d.getDay()];
    b.days.add(String(m.date));
    b.impressions += num(m.impressions) || 0;
    b.clicks += num(m.clicks) || 0;
    b.cost += num(m.cost) || 0;
    b.conversions += num(m.conversions) || 0;
  }
  return buckets.filter(b => b.days.size).map(b => ({
    ...b,
    dayCount: b.days.size,
    ctr: b.impressions ? round(b.clicks / b.impressions * 100, 2) : null,
    cpc: b.clicks ? round(b.cost / b.clicks, 2) : null,
    cvr: b.clicks ? round(b.conversions / b.clicks * 100, 2) : null,
    cpa: b.conversions ? round(b.cost / b.conversions, 2) : null
  }));
}

function renderWeekdayTable() {
  const tbl = $('#dowTable');
  if (!tbl) return;
  const tb = tbl.querySelector('tbody');
  tb.innerHTML = '';

  const hint = $('#dowHint');
  if (hint) hint.innerHTML = '';
  const rows = weekdayStats(spendRows());
  const withCpa = rows.filter(r => r.cpa !== null);
  // เส้นฐานคำนวณจากยอดรวมทั้งช่วง ไม่ใช่เฉลี่ยของ CPA รายวัน
  const totCost = rows.reduce((s, r) => s + r.cost, 0);
  const totConv = rows.reduce((s, r) => s + r.conversions, 0);
  const baseCpa = totConv ? totCost / totConv : null;

  $('#dowNote').textContent = baseCpa === null
    ? 'ยังไม่มี conversion พอจะเทียบ CPA'
    : `CPA เฉลี่ยทั้งช่วง ${fmt(baseCpa, 2)} ฿ · เทียบแต่ละวันกับค่านี้`;

  if (!rows.length) {
    tb.append(el('tr', {}, el('td', { colspan: '8' },
      el('div', { class: 'empty' }, el('strong', {}, 'ยังไม่มีข้อมูล'),
        'เลือกช่วงเวลาที่มีตัวเลขจาก Google Ads'))));
    return;
  }

  for (const r of rows) {
    const diff = baseCpa && r.cpa !== null ? (r.cpa - baseCpa) / baseCpa * 100 : null;
    // CPA ต่ำกว่าค่าเฉลี่ย = ดี
    const cls = diff === null ? '' : Math.abs(diff) < 5 ? 'delta-flat' : diff < 0 ? 'delta-up' : 'delta-down';
    tb.append(el('tr', { class: diff !== null && diff >= 25 ? 'row-warn' : '' },
      el('td', { class: 'table-left' }, el('b', {}, r.name)),
      el('td', { class: 'num' }, String(r.dayCount)),
      el('td', { class: 'num' }, fmt(r.cost, 0)),
      el('td', { class: 'num' }, fmt(r.clicks, 0)),
      el('td', { class: 'num' }, fmt(r.conversions, 2)),
      el('td', { class: 'num val-strong' }, r.cpa === null ? '—' : fmt(r.cpa, 2)),
      el('td', { class: 'num' }, r.cvr === null ? '—' : fmt(r.cvr, 2) + '%'),
      el('td', { class: 'num ' + cls }, diff === null ? '—' : (diff > 0 ? '+' : '') + fmt(diff, 0) + '%')));
  }

  if (withCpa.length >= 5) {
    const worst = withCpa.slice().sort((a, b) => b.cpa - a.cpa)[0];
    const best = withCpa.slice().sort((a, b) => a.cpa - b.cpa)[0];
    if (hint && best.cpa > 0 && worst.cpa / best.cpa >= 1.3) {
      hint.append(el('p', { class: 'card-note', style: 'margin-top:10px' },
        `วัน${worst.name} CPA แพงกว่าวัน${best.name} อยู่ ${fmt((worst.cpa / best.cpa - 1) * 100, 0)}% — ` +
        'ถ้าช่องว่างนี้ยังอยู่หลายสัปดาห์ ลองปรับตารางเวลาแสดงโฆษณาดู'));
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   10a-11. หน้า "ที่มา Lead" — Key events จาก GA4

   ตอบคำถามว่า "ลูกค้าที่ทักมา มาจากทางไหน และทักมาทางไหน"
     แถว = ที่มาของทราฟฟิก (Organic Search / Paid Search / …)
     คอลัมน์ = ประเภทที่ติดต่อเข้ามา (Add Line / click_facebook / Call Us)

   ที่ต้องระวังและเขียนกำกับไว้ในหน้า:
   ตัวเลข GA4 กับ Conversions ของ Google Ads ไม่มีวันตรงกัน เพราะนับคนละแบบ
   จึงแยกคนละหน้า ไม่เอามาบวกกัน และให้ใช้ GA4 ดู "สัดส่วน" เป็นหลัก
   ───────────────────────────────────────────────────────────── */

const LEAD_PRESETS = [
  { key: '7', label: '7 วัน', days: 7 },
  { key: '14', label: '14 วัน', days: 14 },
  { key: '30', label: '30 วัน', days: 30 },
  { key: '90', label: '90 วัน', days: 90 },
  { key: 'all', label: 'ทั้งหมด', days: 0 }
];

/** ชื่อช่องทางของ GA4 เป็นภาษาอังกฤษ — แปลเฉพาะตัวที่เจอบ่อย */
const CHANNEL_TH = {
  'Organic Search': 'Organic Search (SEO)',
  'Paid Search': 'Paid Search (SEM)',
  'Paid Social': 'Paid Social',
  'Organic Social': 'Organic Social',
  'Direct': 'Direct (พิมพ์ URL เอง)',
  'Referral': 'Referral (เว็บอื่นส่งมา)',
  'Email': 'Email',
  'Display': 'Display',
  'Unassigned': 'ระบุที่มาไม่ได้'
};
const channelLabel = c => CHANNEL_TH[c] || c || 'ไม่ระบุ';

function hasLeadData() { return Array.isArray(Store.leads) && Store.leads.length > 0; }

function leadDataUpTo() {
  let latest = '';
  for (const l of Store.leads || []) {
    const d = String(l.date || '');
    if (d > latest) latest = d;
  }
  return latest;
}

function leadRows() {
  const from = $('#lead_from')?.value, to = $('#lead_to')?.value;
  const ch = $('#leadChannel')?.value || '';
  return (Store.leads || []).filter(l => {
    const d = String(l.date || '');
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (ch && String(l.channel || '') !== ch) return false;
    return true;
  });
}

const leadCount = l => num(l.key_events) || 0;

/** รายชื่อประเภท event เรียงตามจำนวนมากไปน้อย */
function leadEventNames(rows) {
  const tally = new Map();
  for (const l of rows) {
    const n = String(l.event_name || '').trim();
    if (!n) continue;
    tally.set(n, (tally.get(n) || 0) + leadCount(l));
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

/** ตารางไขว้ ช่องทาง × ประเภท */
function leadPivot(rows) {
  const events = leadEventNames(rows);
  const byChannel = new Map();
  for (const l of rows) {
    const c = String(l.channel || '') || 'ไม่ระบุ';
    if (!byChannel.has(c)) byChannel.set(c, { channel: c, total: 0, cells: {} });
    const e = byChannel.get(c);
    const name = String(l.event_name || '').trim();
    const v = leadCount(l);
    e.cells[name] = (e.cells[name] || 0) + v;
    e.total += v;
  }
  const list = [...byChannel.values()].sort((a, b) => b.total - a.total);
  const totals = { total: 0, cells: {} };
  for (const r of list) {
    totals.total += r.total;
    for (const e of events) totals.cells[e] = (totals.cells[e] || 0) + (r.cells[e] || 0);
  }
  return { events, rows: list, totals };
}

function leadByDay(rows) {
  const byDate = new Map();
  for (const l of rows) {
    const d = String(l.date);
    if (!byDate.has(d)) byDate.set(d, { date: d, total: 0, cells: {} });
    const e = byDate.get(d);
    const name = String(l.event_name || '').trim();
    const v = leadCount(l);
    e.cells[name] = (e.cells[name] || 0) + v;
    e.total += v;
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * ต้นทุนต่อ lead รายแคมเปญ — จับคู่ชื่อแคมเปญของ GA4 กับ Cost จากชีต METRICS
 * จะมีข้อมูลก็ต่อเมื่อ GA4 ผูกกับ Google Ads และเปิด auto-tagging ไว้
 */
function leadByCampaign(rows) {
  const from = $('#lead_from')?.value, to = $('#lead_to')?.value;
  const byName = new Map();
  for (const l of rows) {
    const n = String(l.campaign || '').trim();
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, { campaign: n, leads: 0, byEvent: {} });
    const e = byName.get(n);
    const v = leadCount(l);
    e.leads += v;
    const name = String(l.event_name || '').trim();
    e.byEvent[name] = (e.byEvent[name] || 0) + v;
  }

  const out = [];
  for (const e of byName.values()) {
    const spend = sumAdsRange(e.campaign, from, to);
    const recs = Store.sorted().filter(r => r.campaign === e.campaign);
    out.push({
      ...e,
      product: recs.length ? recProduct(recs[0]) : (Store.campaign(e.campaign)?.product || ''),
      cost: spend ? spend.cost : null,
      cpl: spend && e.leads ? round(spend.cost / e.leads, 2) : null,
      matched: !!spend
    });
  }
  return out.sort((a, b) => b.leads - a.leads);
}

function setLeadRange(days) {
  const upTo = leadDataUpTo() || todayISO();
  $('#lead_to').value = upTo;
  if (!days) {
    let first = upTo;
    for (const l of Store.leads || []) {
      const d = String(l.date || '');
      if (d && d < first) first = d;
    }
    $('#lead_from').value = first;
  } else {
    const d = new Date(upTo);
    d.setDate(d.getDate() - (days - 1));
    $('#lead_from').value = d.toLocaleDateString('sv-SE');
  }
}

function initLeadPage() {
  const presets = $('#leadPresets');
  if (!presets) return;
  presets.innerHTML = '';
  for (const p of LEAD_PRESETS) {
    presets.append(el('button', {
      type: 'button', class: 'chip', 'data-preset': p.key,
      'aria-pressed': String(p.key === '30'),
      onclick: () => {
        $$('#leadPresets .chip').forEach(c =>
          c.setAttribute('aria-pressed', String(c.dataset.preset === p.key)));
        setLeadRange(p.days);
        renderLeadPage();
      }
    }, p.label));
  }
  for (const id of ['#lead_from', '#lead_to', '#leadChannel']) {
    $(id)?.addEventListener('change', () => {
      if (id !== '#leadChannel') {
        $$('#leadPresets .chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      }
      renderLeadPage();
    });
  }
  $('#leadCopyPivot')?.addEventListener('click', () => copyLeads('pivot'));
  $('#leadCopyCamp')?.addEventListener('click', () => copyLeads('campaign'));
  $('#leadCopyDay')?.addEventListener('click', () => copyLeads('day'));
  setLeadRange(30);
}

function renderLeadPage() {
  const warn = $('#leadWarn');
  if (!warn) return;
  warn.innerHTML = '';

  const clear = () => {
    $('#leadStats').innerHTML = '';
    for (const id of ['#leadPivotTable', '#leadCampTable', '#leadDayTable']) {
      const t = $(id);
      if (!t) continue;
      t.querySelector('thead tr').innerHTML = '';
      t.querySelector('tbody').innerHTML = '';
      if (t.querySelector('tfoot')) t.querySelector('tfoot').innerHTML = '';
    }
  };

  if (!hasLeadData()) {
    warn.append(el('div', { class: 'banner warn' },
      el('span', { class: 'icon' }, '📊'),
      el('span', {},
        el('b', {}, 'ยังไม่มีข้อมูลจาก Google Analytics '),
        'หน้านี้จะมีข้อมูลเมื่อเพิ่มไฟล์ ', el('code', {}, 'GA4Leads.gs'),
        ' เข้าไปใน Apps Script แล้วตั้งให้รันวันละครั้ง — ดูขั้นตอนใน README',
        el('div', { class: 'card-note', style: 'margin-top:6px' },
          'สรุปสั้น ๆ: เปิด Services → เพิ่ม Google Analytics Data API → ใส่ Property ID → รัน setupLeads แล้ว pullLeads'))));
    clear();
    return;
  }

  // ตัวเลือกช่องทาง
  const sel = $('#leadChannel');
  const keep = sel.value;
  const channels = [...new Set((Store.leads || []).map(l => String(l.channel || '')).filter(Boolean))].sort();
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, 'ทุกช่องทาง'));
  for (const c of channels) sel.append(el('option', { value: c }, channelLabel(c)));
  sel.value = channels.includes(keep) ? keep : '';

  const rows = leadRows();
  const pivot = leadPivot(rows);
  const upTo = leadDataUpTo();

  warn.append(el('div', { class: 'banner good' },
    el('span', { class: 'icon' }, '📊'),
    el('span', {}, 'ข้อมูลจาก Google Analytics · ล่าสุดถึงวันที่ ', el('b', {}, thaiDate(upTo)),
      ' · นับจาก Key events ที่ตั้งไว้ใน GA4')));

  // ── การ์ดสรุป
  const days = new Set(rows.map(r => String(r.date))).size;
  const paid = pivot.rows.find(r => r.channel === 'Paid Search');
  const organic = pivot.rows.find(r => r.channel === 'Organic Search');
  const topEvent = pivot.events[0];
  const stats = $('#leadStats');
  stats.innerHTML = '';
  const cards = [
    { cls: 'c3', icon: 'up', label: 'Lead ทั้งหมด', value: fmt(pivot.totals.total, 0), unit: '',
      active: true, sub: days ? `${days} วัน · เฉลี่ย ${fmt(pivot.totals.total / days, 1)}/วัน` : '' },
    { cls: 'c1', icon: 'edit', label: 'จาก Paid Search (SEM)', value: fmt(paid?.total || 0, 0), unit: '',
      ring: pivot.totals.total ? (paid?.total || 0) / pivot.totals.total * 100 : null,
      sub: pivot.totals.total ? `${fmt((paid?.total || 0) / pivot.totals.total * 100, 0)}% ของทั้งหมด` : '' },
    { cls: 'c4', icon: 'up', label: 'จาก Organic Search (SEO)', value: fmt(organic?.total || 0, 0), unit: '',
      ring: pivot.totals.total ? (organic?.total || 0) / pivot.totals.total * 100 : null,
      sub: pivot.totals.total ? `${fmt((organic?.total || 0) / pivot.totals.total * 100, 0)}% ของทั้งหมด` : '' },
    { cls: 'c1', icon: 'clock', label: 'ประเภทที่มามากสุด', value: topEvent || '—', unit: '',
      sub: topEvent ? `${fmt(pivot.totals.cells[topEvent] || 0, 0)} ครั้ง` : '' }
  ];
  for (const c of cards) {
    stats.append(el('div', { class: `stat-card ${c.cls}${c.active ? ' is-active' : ''}` },
      el('div', { class: 'sc-body' },
        el('div', { class: 'sc-label' }, c.label),
        statValue(c.value, c.unit),
        el('div', { class: 'sc-sub' }, c.sub)),
      (c.ring !== undefined && c.ring !== null) ? statRing(c.ring) : svgIcon(c.icon)));
  }

  renderLeadPivot(pivot);
  renderLeadCampaigns(rows);
  renderLeadDays(rows, pivot.events);
}

function renderLeadPivot(pivot) {
  const tbl = $('#leadPivotTable');
  const head = tbl.querySelector('thead tr');
  const tb = tbl.querySelector('tbody');
  const tf = tbl.querySelector('tfoot');
  head.innerHTML = ''; tb.innerHTML = ''; tf.innerHTML = '';

  head.append(el('th', {}, 'ช่องทาง'));
  for (const e of pivot.events) head.append(el('th', { class: 'num as-is' }, e));
  head.append(el('th', { class: 'num' }, 'รวม'));
  head.append(el('th', { class: 'num' }, '% ของทั้งหมด'));

  if (!pivot.rows.length) {
    tb.append(el('tr', {}, el('td', { colspan: String(pivot.events.length + 3) },
      el('div', { class: 'empty' }, el('strong', {}, 'ไม่มีข้อมูลในช่วงนี้'),
        'ลองขยายช่วงเวลา หรือเอาตัวกรองช่องทางออก'))));
    return;
  }

  for (const r of pivot.rows) {
    const pct = pivot.totals.total ? r.total / pivot.totals.total * 100 : 0;
    tb.append(el('tr', {},
      el('td', {}, el('b', {}, channelLabel(r.channel))),
      ...pivot.events.map(e => el('td', { class: 'num' + ((r.cells[e] || 0) ? '' : ' val-none') },
        (r.cells[e] || 0) ? fmt(r.cells[e], 0) : '—')),
      el('td', { class: 'num val-strong' }, fmt(r.total, 0)),
      el('td', { class: 'num cell-sub' }, fmt(pct, 1) + '%')));
  }

  tf.append(el('tr', { class: 'row-total' },
    el('td', {}, 'รวมทุกช่องทาง'),
    ...pivot.events.map(e => el('td', { class: 'num' }, fmt(pivot.totals.cells[e] || 0, 0))),
    el('td', { class: 'num val-strong' }, fmt(pivot.totals.total, 0)),
    el('td', { class: 'num' }, '100%')));
}

function renderLeadCampaigns(rows) {
  const tbl = $('#leadCampTable');
  const tb = tbl.querySelector('tbody');
  const tf = tbl.querySelector('tfoot');
  tb.innerHTML = ''; tf.innerHTML = '';

  const list = leadByCampaign(rows);
  const note = $('#leadCostNote');

  if (!list.length) {
    note.textContent = 'GA4 ยังไม่ได้ส่งชื่อแคมเปญมา';
    tb.append(el('tr', {}, el('td', { colspan: '6' },
      el('div', { class: 'empty' },
        el('strong', {}, 'ยังแยกรายแคมเปญไม่ได้'),
        'GA4 จะส่งชื่อแคมเปญมาก็ต่อเมื่อลิงก์บัญชี Google Ads เข้ากับ GA4 และเปิด auto-tagging ไว้ ' +
        '(GA4 → Admin → Product links → Google Ads links) · ' +
        'ถ้าลิงก์แล้วแต่ยังไม่ขึ้น ให้รอ 24–48 ชม. แล้วรัน pullLeads อีกครั้ง'))));
    return;
  }

  const unmatched = list.filter(r => !r.matched).length;
  note.textContent = unmatched
    ? `จับคู่ Cost ได้ ${list.length - unmatched} จาก ${list.length} แคมเปญ — ที่เหลือชื่อไม่ตรงกับในชีต METRICS`
    : 'จับคู่ชื่อแคมเปญของ GA4 กับ Cost จาก Google Ads ครบทุกตัว';

  let sumCost = 0, sumLeads = 0;
  for (const r of list) {
    if (r.cost !== null) sumCost += r.cost;
    sumLeads += r.leads;
    const top = Object.entries(r.byEvent).sort((a, b) => b[1] - a[1]).slice(0, 3);
    tb.append(el('tr', {},
      el('td', {}, el('b', {}, r.campaign)),
      el('td', {}, r.product || '—'),
      r.cost === null
        ? el('td', { class: 'num val-none', title: 'ไม่มีแคมเปญชื่อนี้ในชีต METRICS' }, '—')
        : el('td', { class: 'num' }, fmt(r.cost, 0)),
      el('td', { class: 'num val-strong' }, fmt(r.leads, 0)),
      r.cpl === null
        ? el('td', { class: 'num val-none' }, '—')
        : el('td', { class: 'num val-strong' }, fmt(r.cpl, 2) + ' ฿'),
      el('td', { class: 'cell-sub' },
        top.map(([n, v]) => `${n} ${fmt(v, 0)}`).join(' · ') || '—')));
  }

  tf.append(el('tr', { class: 'row-total' },
    el('td', {}, 'รวม'),
    el('td', {}, ''),
    el('td', { class: 'num' }, fmt(sumCost, 0)),
    el('td', { class: 'num val-strong' }, fmt(sumLeads, 0)),
    // ค่าเฉลี่ยคิดจากยอดรวม ไม่ใช่เฉลี่ยของ CPL รายแคมเปญ
    el('td', { class: 'num val-strong' }, sumLeads ? fmt(sumCost / sumLeads, 2) + ' ฿' : '—'),
    el('td', {}, '')));
}

function renderLeadDays(rows, events) {
  const tbl = $('#leadDayTable');
  const head = tbl.querySelector('thead tr');
  const tb = tbl.querySelector('tbody');
  const tf = tbl.querySelector('tfoot');
  head.innerHTML = ''; tb.innerHTML = ''; tf.innerHTML = '';

  head.append(el('th', { class: 'table-left' }, 'วันที่'));
  for (const e of events) head.append(el('th', { class: 'num as-is' }, e));
  head.append(el('th', { class: 'num' }, 'รวม'));

  const days = leadByDay(rows);
  $('#leadDayNote').textContent = days.length ? `${days.length} วัน · ใหม่อยู่บน` : '';

  for (const d of days) {
    tb.append(el('tr', {},
      el('td', { class: 'table-left' }, thaiDate(d.date),
        el('span', { class: 'cell-sub' }, ' ' + relativeDay(d.date))),
      ...events.map(e => el('td', { class: 'num' + ((d.cells[e] || 0) ? '' : ' val-none') },
        (d.cells[e] || 0) ? fmt(d.cells[e], 0) : '—')),
      el('td', { class: 'num val-strong' }, fmt(d.total, 0))));
  }

  const tot = { total: 0, cells: {} };
  for (const d of days) {
    tot.total += d.total;
    for (const e of events) tot.cells[e] = (tot.cells[e] || 0) + (d.cells[e] || 0);
  }
  tf.append(el('tr', { class: 'row-total' },
    el('td', { class: 'table-left' }, `รวม ${days.length} วัน`),
    ...events.map(e => el('td', { class: 'num' }, fmt(tot.cells[e] || 0, 0))),
    el('td', { class: 'num val-strong' }, fmt(tot.total, 0))));
}

function copyLeads(kind) {
  const rows = leadRows();
  const pivot = leadPivot(rows);
  let text = '';

  if (kind === 'pivot') {
    text = ['ช่องทาง', ...pivot.events, 'รวม'].join('\t') + '\n' +
      pivot.rows.map(r => [channelLabel(r.channel),
        ...pivot.events.map(e => r.cells[e] || 0), r.total].join('\t')).join('\n') +
      '\n' + ['รวมทุกช่องทาง', ...pivot.events.map(e => pivot.totals.cells[e] || 0),
        pivot.totals.total].join('\t');
  } else if (kind === 'campaign') {
    const list = leadByCampaign(rows);
    text = ['แคมเปญ', 'สินค้า', 'Cost', 'Lead', 'Cost/Lead'].join('\t') + '\n' +
      list.map(r => [r.campaign, r.product, r.cost ?? '', r.leads, r.cpl ?? ''].join('\t')).join('\n');
  } else {
    const days = leadByDay(rows);
    text = ['วันที่', ...pivot.events, 'รวม'].join('\t') + '\n' +
      days.map(d => [d.date, ...pivot.events.map(e => d.cells[e] || 0), d.total].join('\t')).join('\n');
  }

  navigator.clipboard.writeText(text)
    .then(() => toast('คัดลอกแล้ว — วางในชีตได้เลย'))
    .catch(() => toast('คัดลอกไม่สำเร็จ'));
}

function copySpend(kind) {
  const rows = spendRows();
  const total = spendTotals(rows);
  const lines = [];
  if (kind === 'campaignDay') {
    lines.push('วันที่\tแคมเปญ\tImpr\tClicks\tCost\tConv\tCTR\tCPC\tCPA');
    const sorted = rows.slice().sort((a, b) =>
      String(b.date).localeCompare(String(a.date)) ||
      (num(b.cost) || 0) - (num(a.cost) || 0));
    for (const m of sorted) {
      const t = spendTotals([m]);
      lines.push([m.date, m.campaign, t.impressions, t.clicks, t.cost, t.conversions,
        t.ctr ?? '', t.cpc ?? '', t.cpa ?? ''].join('\t'));
    }
  } else if (kind === 'day') {
    lines.push('วันที่\tImpr\tClicks\tCost\tConv\tCTR\tCPC\tCPA');
    for (const d of spendByDay(rows)) {
      lines.push([d.date, d.impressions, d.clicks, d.cost, d.conversions,
        d.ctr ?? '', d.cpc ?? '', d.cpa ?? ''].join('\t'));
    }
  } else {
    lines.push('แคมเปญ\tImpr\tClicks\tCost\tConv\tCTR\tCPC\tCPA');
    for (const c of spendByCampaign(rows)) {
      lines.push([c.campaign, c.impressions, c.clicks, c.cost, c.conversions,
        c.ctr ?? '', c.cpc ?? '', c.cpa ?? ''].join('\t'));
    }
  }
  lines.push(['รวม', total.impressions, total.clicks, total.cost, total.conversions,
    total.ctr ?? '', total.cpc ?? '', total.cpa ?? ''].join('\t'));

  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => toast('คัดลอกแล้ว วางในชีตได้เลย'))
    .catch(() => toast('คัดลอกไม่สำเร็จ'));
}

/* ─────────────────────────────────────────────────────────────
   10a-4. หน้า งบ & Bid ปัจจุบัน
   ───────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────
   ตัวเลขรายวันจาก Google Ads (ชีต METRICS)
   ───────────────────────────────────────────────────────────── */

const BID_STRATEGY_TH = {
  MANUAL_CPC: 'Manual CPC',
  ENHANCED_CPC: 'Enhanced CPC',
  TARGET_CPA: 'Target CPA',
  TARGET_ROAS: 'Target ROAS',
  TARGET_SPEND: 'Maximize clicks',
  MAXIMIZE_CONVERSIONS: 'Maximize conversions',
  MAXIMIZE_CONVERSION_VALUE: 'Maximize conversion value',
  TARGET_IMPRESSION_SHARE: 'Target impression share'
};

/** ป้ายกลยุทธ์ + ค่าเป้าหมาย เช่น "Target CPA · ฿250" */
function strategyLabel(row) {
  if (!row) return '';
  const name = BID_STRATEGY_TH[row.bid_strategy] || String(row.bid_strategy || '');
  const cpa = num(row.target_cpa), roas = num(row.target_roas);
  if (cpa !== null) return `${name} · ฿${fmt(cpa, 2)}`;
  if (roas !== null) return `${name} · ${fmt(roas * 100, 0)}%`;
  return name;
}

/** แคมเปญนี้ bid เองหรือเปล่า — ถ้าไม่ Max CPC จะไม่มีความหมาย */
function isManualBidding(row) {
  return !!row && /^(MANUAL_CPC|ENHANCED_CPC|MANUAL_CPM|MANUAL_CPV)$/.test(String(row.bid_strategy || ''));
}

/** กลยุทธ์ที่ "ตั้งเพดาน CPC ได้" — Google คุม bid ให้ แต่เราสั่งห้ามเกินได้ */
function hasCpcCeiling(row) {
  return !!row && /^(TARGET_SPEND|TARGET_IMPRESSION_SHARE|PERCENT_CPC)$/.test(String(row.bid_strategy || ''));
}

/**
 * "ค่าที่ตั้งไว้" ของแคมเปญ — ความหมายเปลี่ยนตามกลยุทธ์ bid
 *
 * ที่ต้องทำแบบนี้เพราะ ad_group.cpc_bid_micros มีความหมายเฉพาะแคมเปญที่ bid เอง
 * แคมเปญ smart bidding จะได้ค่า default ของ Google ติดมา (0.01 / 0.10 เท่ากันหมด)
 * ซึ่งไม่ใช่ค่าที่ใครตั้ง เอามาโชว์ก็หลอกตาเปล่า ๆ
 *
 * @param ads    แถวล่าสุดจากชีต METRICS
 * @param manual ค่าที่ผู้ใช้กรอกเอง (จาก latestSetting) — ใช้เมื่อ Ads ไม่มีข้อมูล
 */
function bidSetting(ads, manual) {
  const mv = manual ? num(manual.value) : null;

  if (!ads) {
    return mv === null
      ? { kind: 'none', label: '', text: '—', title: 'ยังไม่มีข้อมูลจาก Google Ads และยังไม่เคยกรอกเอง' }
      : { kind: 'manual', label: 'Max CPC', value: mv, text: fmt(mv, 2) + ' ฿', title: 'ค่าที่กรอกเอง' };
  }

  if (isManualBidding(ads)) {
    const v = num(ads.max_cpc);
    if (v !== null) {
      return { kind: 'manual', label: 'Max CPC', value: v, text: fmt(v, 2) + ' ฿', fromAds: true,
        title: 'แคมเปญนี้ตั้ง bid เอง — นี่คือ Max CPC สูงสุดของ ad group' };
    }
    return mv === null
      ? { kind: 'none', label: 'Max CPC', text: '—', title: 'ยังไม่ได้ตั้ง Max CPC' }
      : { kind: 'manual', label: 'Max CPC', value: mv, text: fmt(mv, 2) + ' ฿', title: 'ค่าที่กรอกเอง' };
  }

  if (hasCpcCeiling(ads)) {
    const v = num(ads.cpc_ceiling);
    if (v !== null) {
      return { kind: 'ceiling', label: 'เพดาน CPC', value: v, text: fmt(v, 2) + ' ฿', fromAds: true,
        title: 'Google คุม bid ให้ แต่ห้ามประมูลเกินค่านี้' };
    }
    if (mv !== null) {
      return { kind: 'ceiling', label: 'เพดาน CPC', value: mv, text: fmt(mv, 2) + ' ฿',
        title: 'ค่าที่กรอกเอง — Google Ads ไม่ได้ส่งเพดานมา' };
    }
    return { kind: 'uncapped', label: 'เพดาน CPC', text: 'ไม่จำกัด',
      title: 'แคมเปญนี้ไม่ได้ตั้งเพดาน CPC ไว้ — Google ประมูลได้เต็มที่ตามที่เห็นสมควร' };
  }

  const cpa = num(ads.target_cpa);
  if (cpa !== null) {
    return { kind: 'tcpa', label: 'เป้า CPA', value: cpa, text: fmt(cpa, 2) + ' ฿', fromAds: true,
      title: 'Google เล็งให้ได้ conversion ที่ราคาประมาณนี้' };
  }
  const roas = num(ads.target_roas);
  if (roas !== null) {
    return { kind: 'troas', label: 'เป้า ROAS', value: roas, text: fmt(roas * 100, 0) + '%', fromAds: true,
      title: 'Google เล็งให้ได้มูลค่าคืนกลับตามสัดส่วนนี้' };
  }
  return { kind: 'auto', label: '', text: 'Google คุมเอง',
    title: 'แคมเปญนี้ไม่มีค่า bid ให้ตั้ง — Google ตัดสินใจให้ทั้งหมด' };
}

/* ─────────────────────────────────────────────────────────────
   10a-6. ความน่าเชื่อของผลวัด

   ปัญหาที่แก้: ถ้าช่วงหลังปรับมี conversion แค่ 3 ครั้ง แล้ว CPA ดีขึ้น 20%
   นั่นไม่ได้แปลว่าการปรับได้ผล — มันคือความบังเอิญที่เกิดได้เอง
   ระบบจึงต้องบอกตรง ๆ ว่า "ยังตัดสินไม่ได้" แทนที่จะขึ้นลูกศรเขียวให้เข้าใจผิด

   เกณฑ์ที่ใช้ (ตัวเลขกลม ๆ ที่ใช้กันทั่วไปในวงการ ไม่ใช่การทดสอบทางสถิติเต็มรูป)
     conversion  < 10  ต่อฝั่ง = ตัดสินไม่ได้เลย
     conversion  < 25  ต่อฝั่ง = พอเห็นทิศทาง แต่ยังไม่ควรฟันธง
     clicks      < 100 ต่อฝั่ง = อัตราส่วน (CTR/CVR) ยังแกว่งมาก
   ───────────────────────────────────────────────────────────── */

const CONF_CONV_MIN = 10;
const CONF_CONV_GOOD = 25;
const CONF_CLICK_MIN = 100;

const CONF_TEXT = {
  high:   { label: 'ข้อมูลพอ', cls: 'conf-high' },
  medium: { label: 'ข้อมูลพอประมาณ', cls: 'conf-mid' },
  low:    { label: 'ข้อมูลยังน้อย', cls: 'conf-low' },
  none:   { label: 'ยังไม่มีข้อมูลพอ', cls: 'conf-low' }
};

/**
 * ประเมินว่าผลเทียบนี้เชื่อได้แค่ไหน
 * คืน { level, conv, clicks, need, reason } — need = ยังขาด conversion อีกกี่ครั้ง
 */
function blockConfidence(beforeRaw, afterRaw) {
  const B = solveBlock(beforeRaw).values;
  const A = solveBlock(afterRaw).values;

  const convs = [B.conversions, A.conversions].map(v => (v === null ? null : Number(v)));
  const clicks = [B.clicks, A.clicks].map(v => (v === null ? null : Number(v)));

  if (convs.some(v => v === null)) {
    return { level: 'none', conv: null, clicks: null, need: null,
      reason: 'ยังไม่ได้กรอก Conversions ทั้งสองฝั่ง จึงตัดสินเรื่อง CPA/CVR ไม่ได้' };
  }

  const minConv = Math.min(...convs);
  const minClick = clicks.some(v => v === null) ? null : Math.min(...clicks);

  if (minConv < CONF_CONV_MIN) {
    // ใช้อัตราต่อวันประเมินว่าต้องรออีกกี่วัน
    const perDay = afterRaw._days ? (A.conversions || 0) / afterRaw._days : 0;
    const need = CONF_CONV_MIN - minConv;
    return {
      level: 'low', conv: minConv, clicks: minClick, need,
      waitDays: perDay > 0 ? Math.ceil(need / perDay) : null,
      reason: `ฝั่งที่น้อยที่สุดมี conversion แค่ ${fmt(minConv, 2)} ครั้ง — ` +
        `ต่ำกว่า ${CONF_CONV_MIN} ครั้ง ความต่างที่เห็นอาจเป็นความบังเอิญล้วน ๆ`
    };
  }
  if (minConv < CONF_CONV_GOOD) {
    return { level: 'medium', conv: minConv, clicks: minClick, need: CONF_CONV_GOOD - minConv,
      reason: `มี conversion ${fmt(minConv, 2)} ครั้ง — พอเห็นทิศทาง แต่ยังไม่ควรฟันธง ` +
        `(ประมาณ ${CONF_CONV_GOOD} ครั้งขึ้นไปถึงจะมั่นใจได้)` };
  }
  if (minClick !== null && minClick < CONF_CLICK_MIN) {
    return { level: 'medium', conv: minConv, clicks: minClick, need: 0,
      reason: `conversion พอแล้ว แต่คลิกยังน้อย (${fmt(minClick, 0)}) — CTR กับ CVR ยังแกว่งได้อีก` };
  }
  return { level: 'high', conv: minConv, clicks: minClick, need: 0, reason: '' };
}

/** แถบเตือนใต้คำตัดสิน — โผล่เฉพาะตอนข้อมูลยังไม่พอ */
function confidenceNote(beforeRaw, afterRaw) {
  const c = blockConfidence(beforeRaw, afterRaw);
  if (c.level === 'high') return null;
  const wait = c.waitDays
    ? ` · ถ้าอัตราปัจจุบันคงที่ อีกประมาณ ${c.waitDays} วันจะมีข้อมูลพอ`
    : '';
  return el('div', { class: `conf-note ${CONF_TEXT[c.level].cls}` },
    el('b', {}, CONF_TEXT[c.level].label),
    ' ' + c.reason + wait);
}

/* ─────────────────────────────────────────────────────────────
   10a-7. ความผันผวนปกติของแคมเปญเอง

   ปัญหาที่แก้: แคมเปญที่ CPA แกว่าง ±15% อยู่ทุกอาทิตย์โดยไม่ต้องทำอะไร
   ถ้าปรับแล้วดีขึ้น 8% นั่นยังอยู่ในกรอบความมั่วของมันเอง ไม่ใช่ผลงาน
   ───────────────────────────────────────────────────────────── */

/**
 * กรอบความแกว่งรายสัปดาห์ของแคมเปญ วัดจากข้อมูลจริงในชีต METRICS
 * เทียบเป็นก้อนละ 7 วันเพราะรายวันแกว่งเกินจนไม่มีความหมาย
 * คืน { pct, weeks } — pct = ค่าเบี่ยงเบนเฉลี่ยของ CPA ระหว่างสัปดาห์ (%)
 */
function weeklyNoise(campaign, metricKey = 'cpa', weeks = 8) {
  if (!hasAdsData()) return null;
  const upTo = adsDataUpTo();
  if (!upTo) return null;

  const vals = [];
  for (let w = 0; w < weeks; w++) {
    const to = toISO(new Date(parseDate(upTo).getTime() - w * 7 * 864e5));
    const from = toISO(new Date(parseDate(to).getTime() - 6 * 864e5));
    const s = sumAdsRange(campaign, from, to);
    if (!s || s.days < 5) continue;
    const v = s[metricKey];
    if (v === null || !isFinite(v) || v <= 0) continue;
    vals.push(v);
  }
  if (vals.length < 3) return null;

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (!mean) return null;
  // ค่าเบี่ยงเบนสัมบูรณ์เฉลี่ย — ทนต่อค่าโดดกว่าส่วนเบี่ยงเบนมาตรฐาน
  const mad = vals.reduce((a, b) => a + Math.abs(b - mean), 0) / vals.length;
  const pct = round(mad / mean * 100, 1);
  // แกว่งต่ำกว่า 1% = ข้อมูลนิ่งจนผิดธรรมชาติ (มักเจอตอนข้อมูลทดสอบ)
  // เอามาเป็นเส้นฐานจะทำให้ทุกความเปลี่ยนแปลงดู "เกินกรอบ" ไปหมด จึงไม่ใช้ดีกว่า
  if (pct < 1) return null;
  return { pct, weeks: vals.length, mean: round(mean, 2), metricKey };
}

/** ผลที่วัดได้ ใหญ่กว่าความมั่วปกติของแคมเปญไหม */
function noiseVerdict(campaign, deltaPct, metricKey = 'cpa') {
  const n = weeklyNoise(campaign, metricKey);
  if (!n || deltaPct === null) return null;
  const size = Math.abs(deltaPct);
  return {
    ...n,
    beyond: size > n.pct,
    text: size > n.pct
      ? `เปลี่ยน ${fmt(size, 1)}% ซึ่งมากกว่าที่แคมเปญนี้แกว่งเองปกติ (±${fmt(n.pct, 1)}%) — น่าจะเป็นผลจริง`
      : `เปลี่ยนแค่ ${fmt(size, 1)}% แต่แคมเปญนี้แกว่งเองอยู่แล้ว ±${fmt(n.pct, 1)}% ต่อสัปดาห์ — ยังแยกไม่ออกว่าเป็นผลของการปรับ`
  };
}

/* ─────────────────────────────────────────────────────────────
   10a-8. งบตัน / งบเหลือ

   ใช้จริงยังไง: แคมเปญที่ใช้งบเต็มทุกวัน = ถูกงบบีบอยู่ เพิ่มงบคือคันโยกที่ถูกตัว
   ส่วนแคมเปญที่ใช้ไม่ถึงครึ่ง เพิ่มงบไปก็ไม่มีอะไรเกิดขึ้น ต้องไปแก้ที่อื่นแทน
   ───────────────────────────────────────────────────────────── */

const PACE_CAPPED = 92;      // ใช้งบเกิน 92% ของงบต่อวัน = ตัน
const PACE_IDLE = 60;        // ใช้ไม่ถึง 60% = งบเหลือ

function budgetPacing(campaign, days = 14) {
  if (!hasAdsData()) return null;
  const upTo = adsDataUpTo();
  if (!upTo) return null;
  const from = toISO(new Date(parseDate(upTo).getTime() - (days - 1) * 864e5));

  let spend = 0, budgetSum = 0, n = 0, full = 0;
  for (const m of Store.metrics || []) {
    if (String(m.campaign || '').trim() !== campaign) continue;
    const d = String(m.date || '');
    if (d < from || d > upTo) continue;
    const b = num(m.budget), c = num(m.cost);
    if (b === null || b <= 0 || c === null) continue;
    spend += c; budgetSum += b; n++;
    if (c / b >= PACE_CAPPED / 100) full++;
  }
  if (!n) return null;

  const pct = round(spend / budgetSum * 100, 1);
  const level = pct >= PACE_CAPPED ? 'capped' : pct <= PACE_IDLE ? 'idle' : 'ok';
  return {
    pct, days: n, fullDays: full, level,
    avgSpend: round(spend / n, 2),
    avgBudget: round(budgetSum / n, 2),
    text: level === 'capped'
      ? `ใช้งบเกือบเต็มทุกวัน (${fmt(pct, 0)}% · เต็ม ${full}/${n} วัน) — ถูกงบบีบอยู่ เพิ่มงบน่าจะได้ผลตรงที่สุด`
      : level === 'idle'
        ? `ใช้งบแค่ ${fmt(pct, 0)}% ของที่ตั้งไว้ — เพิ่มงบไปก็ไม่ช่วย ปัญหาอยู่ที่อื่น (bid ต่ำ / คนค้นน้อย / โฆษณาไม่ผ่าน)`
        : `ใช้งบ ${fmt(pct, 0)}% ของที่ตั้งไว้ — กำลังพอดี`
  };
}

function hasAdsData() { return Array.isArray(Store.metrics) && Store.metrics.length > 0; }

/** วันล่าสุดที่มีข้อมูล — ใช้บอกความสดของข้อมูล */
function adsDataUpTo() {
  let latest = '';
  for (const m of Store.metrics || []) {
    const d = String(m.date || '');
    if (d > latest) latest = d;
  }
  return latest;
}

/** แถวล่าสุดของแคมเปญหนึ่ง (งบ/สถานะ/bid strategy ปัจจุบัน) */
function latestAdsRow(campaign) {
  let best = null;
  for (const m of Store.metrics || []) {
    if (String(m.campaign || '').trim() !== campaign) continue;
    if (!best || String(m.date) > String(best.date)) best = m;
  }
  return best;
}

function adsCampaignNames() {
  const set = new Set();
  for (const m of Store.metrics || []) {
    const n = String(m.campaign || '').trim();
    if (n) set.add(n);
  }
  return [...set];
}

/**
 * รวมตัวเลขของแคมเปญหนึ่งในช่วงวันที่ (รวมวันแรกและวันสุดท้าย)
 * ยอดสะสมบวกตรง ๆ ส่วนอัตราส่วนคำนวณใหม่จากยอดรวม ไม่ใช่เอาค่าเฉลี่ยมาเฉลี่ยซ้ำ
 */
function sumAdsRange(campaign, from, to) {
  if (!from || !to) return null;
  let impressions = 0, clicks = 0, cost = 0, conversions = 0, convValue = 0;
  let isSum = 0, isDays = 0, days = 0;

  for (const m of Store.metrics || []) {
    if (String(m.campaign || '').trim() !== campaign) continue;
    const d = String(m.date || '');
    if (d < from || d > to) continue;
    days++;
    impressions += num(m.impressions) || 0;
    clicks += num(m.clicks) || 0;
    cost += num(m.cost) || 0;
    conversions += num(m.conversions) || 0;
    convValue += num(m.conv_value) || 0;
    const is = num(m.impr_share);
    if (is !== null) { isSum += is; isDays++; }
  }
  if (!days) return null;

  return {
    days, impressions, clicks,
    cost: round(cost, 2),
    conversions: round(conversions, 2),
    conv_value: round(convValue, 2),
    ctr: impressions ? round(clicks / impressions * 100, 2) : null,
    cpc: clicks ? round(cost / clicks, 2) : null,
    cvr: clicks ? round(conversions / clicks * 100, 2) : null,
    cpa: conversions ? round(cost / conversions, 2) : null,
    impr_share: isDays ? round(isSum / isDays, 2) : null
  };
}

/**
 * ค่างบ/bid ที่ตั้งไว้ตอนนี้ของแคมเปญ
 * ที่อยู่จริงคือชีต CAMPAIGNS — ส่วนการไล่ดูบันทึกเก่าเก็บไว้เผื่อข้อมูลที่บันทึกไว้
 * ตอนเวอร์ชันก่อน (ตอนนั้นค่าถูกเก็บติดไปกับบันทึกรายวัน)
 */
function latestSetting(campaign, key) {
  // งบมาจาก Google Ads ตรง ๆ ถือว่าแม่นกว่าที่กรอกมือเสมอ
  const ads = latestAdsRow(campaign);
  if (ads) {
    // max_cpc เชื่อได้เฉพาะแคมเปญที่ bid เอง — สคริปต์รุ่นเก่าเคยส่งค่า default
    // ของ Google (0.01 / 0.10) ติดมาด้วย จึงต้องกรองซ้ำอีกชั้นตรงนี้
    const skipBid = key === 'bid' && !isManualBidding(ads);
    const fromAds = skipBid ? null : num(ads[key === 'bid' ? 'max_cpc' : key]);
    if (fromAds !== null) return { value: fromAds, date: String(ads.date || ''), fromAds: true };
  }

  const meta = Store.campaign(campaign);
  const v = meta ? num(meta[key]) : null;
  if (v !== null) return { value: v, date: meta.settings_updated || '', legacy: false };

  for (const r of Store.sorted()) {           // sorted() = ใหม่ก่อนเก่า
    if (r.campaign !== campaign) continue;
    const old = num(r[key]);
    if (old !== null) return { value: old, date: r.date, legacy: true };
  }
  return null;
}

function budgetRows() {
  const names = new Set(Store.records.map(r => r.campaign).filter(Boolean));
  for (const c of Store.campaigns) if (c.name) names.add(c.name);
  for (const n of adsCampaignNames()) names.add(n);      // แคมเปญที่ยังไม่เคยจดก็ต้องเห็น

  const out = [];
  for (const name of names) {
    const recs = Store.sorted().filter(r => r.campaign === name);
    const ads = latestAdsRow(name);
    // CPC จริง: ใช้ของ 7 วันล่าสุดจาก Google Ads ถ้ามี ไม่งั้นย้อนไปดูตัวเลขที่จดไว้
    let cpc = null;
    if (ads) {
      const week = sumAdsRange(name, isoOffset(-7), adsDataUpTo());
      cpc = week ? week.cpc : num(ads.avg_cpc);
    }
    if (cpc === null) {
      const measured = recs.find(r => isMeasured(r));
      cpc = measured ? num(solveBlock(block(measured, 'before')).values.cpc) : null;
    }
    out.push({
      campaign: name,
      product: recs.length ? recProduct(recs[0]) : (Store.campaign(name)?.product || ''),
      group: recs.length ? recGroup(recs[0]) : '',
      budget: latestSetting(name, 'budget'),
      bid: latestSetting(name, 'bid'),
      status: ads ? String(ads.status || '') : '',
      strategy: ads ? String(ads.bid_strategy || '') : '',
      ads,
      cpc,
      lastTouch: recs[0]?.date || ''
    });
  }
  return out.sort((a, b) => (b.lastTouch || '').localeCompare(a.lastTouch || ''));
}

function renderBudgetWarning() {
  const host = $('#budgetWarn');
  if (!host) return;
  host.innerHTML = '';

  if (sheetNeedsUpgrade()) {
    host.append(el('div', { class: 'banner bad' },
      el('span', { class: 'icon' }, '⚠️'),
      el('span', {},
        el('b', {}, 'ชีตยังเป็น Code.gs เวอร์ชันเก่า '),
        `(ที่ deploy อยู่คือ ${Store.serverVersion} · ต้องการ 1.3.0 ขึ้นไป) `,
        'ชีตยังไม่มีคอลัมน์ ', el('code', {}, 'budget'), ' / ', el('code', {}, 'bid'),
        ' ค่าที่ตั้งตอนนี้จึง ', el('b', {}, 'เก็บอยู่ในเบราว์เซอร์เครื่องนี้เท่านั้น'),
        ' — เปิดจากเครื่องอื่นจะไม่เห็น',
        el('div', { style: 'margin-top:8px' },
          'วิธีแก้: เปิด Apps Script > วาง Code.gs ใหม่ทับ > Deploy › Manage deployments › ✏️ › New version › Deploy'))));
  }

  if (hasAdsData()) {
    const upTo = adsDataUpTo();
    const lag = daysBetween(upTo, todayISO());
    const behind = lag !== null && lag > 2;      // daysBetween นับรวมวันแรก/วันสุดท้าย
    host.append(el('div', { class: `banner ${behind ? 'warn' : 'good'}` },
      el('span', { class: 'icon' }, '☁️'),
      el('span', {},
        el('b', {}, 'ต่อกับ Google Ads แล้ว '),
        `— ตัวเลขงบ สถานะ และ CPC ดึงมาเอง ข้อมูลล่าสุดถึงวันที่ ${thaiDate(upTo)} (${relativeDay(upTo)})`,
        behind ? el('div', { class: 'card-note', style: 'margin-top:6px' },
          'ข้อมูลไม่อัปเดตมา 2 วันแล้ว — ลองเช็กที่ Google Ads > Tools > Bulk actions > Scripts ว่าสคริปต์รันผ่านไหม') : null)));
  }

  // มีค่าที่ยังค้างอยู่ในบันทึกเก่า ยังไม่ได้ย้ายมาเก็บกับแคมเปญ
  const legacy = budgetRows().filter(r =>
    (r.budget && r.budget.legacy) || (r.bid && r.bid.legacy));
  if (legacy.length) {
    host.append(el('div', { class: 'banner warn' },
      el('span', { class: 'icon' }, '📦'),
      el('span', {},
        `มี ${legacy.length} แคมเปญที่ค่างบ/bid ยังอ่านมาจากบันทึกเก่าอยู่ ย้ายมาเก็บกับแคมเปญให้เรียบร้อยได้เลย`,
        el('div', { style: 'margin-top:8px' },
          el('button', { class: 'btn btn-sm btn-primary', id: 'migrateLegacy' },
            'ย้ายค่าทั้งหมดมาเก็บกับแคมเปญ')))));
    $('#migrateLegacy').addEventListener('click', migrateLegacySettings);
  }
}

/** ย้ายงบ/bid ที่ยังอ่านจากบันทึกเก่า มาเก็บกับแคมเปญให้ครบทีเดียว */
async function migrateLegacySettings() {
  const rows = budgetRows().filter(r =>
    (r.budget && r.budget.legacy) || (r.bid && r.bid.legacy));
  if (!rows.length) return;
  const btn = $('#migrateLegacy');
  btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = 'กำลังย้าย…';
  let done = 0;
  try {
    for (const r of rows) {
      await Store.saveCampaignSettings(r.campaign, {
        budget: r.budget ? r.budget.value : '',
        bid: r.bid ? r.bid.value : ''
      });
      done++;
    }
    toast(`ย้ายค่าให้ ${done} แคมเปญแล้ว`, 3800);
  } catch (err) {
    toast(`ย้ายได้ ${done} แคมเปญแล้วเจอปัญหา: ${err.message || err}`, 6000);
  } finally {
    refreshAll();
  }
}

function renderBudgetPage() {
  renderBudgetWarning();
  renderCleanupCard();
  const all = budgetRows();
  const group = $('#budgetGroup').value;
  const q = $('#budgetSearch').value.trim().toLowerCase();
  const rows = all.filter(r =>
    (!group || r.group === group) &&
    (!q || r.campaign.toLowerCase().includes(q) || String(r.product).toLowerCase().includes(q)));

  // การ์ดสรุปด้านบน
  const withBudget = all.filter(r => r.budget);
  const totalBudget = withBudget.reduce((s, r) => s + r.budget.value, 0);
  const missing = all.filter(r => !r.budget || !r.bid).length;
  const stats = $('#budgetStats');
  stats.innerHTML = '';
  const cards = [
    { cls: 'c3', icon: 'edit', label: 'งบรวมต่อวัน', value: fmt(totalBudget, 0), unit: ' ฿',
      active: true, sub: `จาก ${withBudget.length} แคมเปญที่บันทึกงบไว้` },
    { cls: 'c4', icon: 'up', label: 'งบรวมต่อเดือน', value: fmt(totalBudget * 30.4, 0), unit: ' ฿',
      sub: 'ประมาณจากงบต่อวัน × 30.4' },
    { cls: 'c1', icon: 'clock', label: 'บันทึกค่าไว้แล้ว', value: String(withBudget.length), unit: '',
      ring: all.length ? withBudget.length / all.length * 100 : null,
      sub: `จากทั้งหมด ${all.length} แคมเปญ` },
    { cls: missing ? 'c2' : 'c4', icon: missing ? 'down' : 'up',
      label: 'ยังไม่ได้บันทึกค่า', value: String(missing), unit: '',
      sub: missing ? 'แคมเปญที่ขาดงบหรือ bid' : 'บันทึกครบทุกแคมเปญ' }
  ];
  for (const c of cards) {
    stats.append(el('div', { class: `stat-card ${c.cls}${c.active ? ' is-active' : ''}` },
      el('div', { class: 'sc-body' },
        el('div', { class: 'sc-label' }, c.label),
        statValue(c.value, c.unit),
        el('div', { class: 'sc-sub' }, c.sub)),
      (c.ring !== undefined && c.ring !== null) ? statRing(c.ring) : svgIcon(c.icon)));
  }

  const tbody = $('#budgetTable').querySelector('tbody');
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.append(el('tr', {}, el('td', { colspan: '9' },
      el('div', { class: 'empty' },
        el('strong', {}, 'ยังไม่มีข้อมูลงบและ bid'),
        'กรอกช่อง "งบต่อวัน" และ "Max CPC bid" ในหน้าบันทึกใหม่ตอนที่เปลี่ยนค่า แล้วหน้านี้จะดึงค่าล่าสุดมาแสดงให้เอง'))));
    return;
  }

  const today = todayISO();
  for (const r of rows) {
    const auto = !!(r.budget?.fromAds || r.bid?.fromAds);
    const oldest = [r.budget?.date, r.bid?.date].filter(Boolean).sort()[0];
    const age = oldest ? daysBetween(oldest, today) : null;
    const stale = !auto && age !== null && age > 30;

    const set = bidSetting(r.ads, r.bid);
    // เตือนเฉพาะตอนที่ค่าที่ตั้งเป็น "เพดาน" จริง ๆ — เป้า CPA/ROAS เทียบกับ CPC ไม่ได้
    const capLike = set.kind === 'manual' || set.kind === 'ceiling';
    const overBid = capLike && set.value && r.cpc !== null && r.cpc > set.value * 1.05;
    const pace = budgetPacing(r.campaign);

    const when = setting => {
      if (!setting) return el('td', { class: 'val-none' }, 'ยังไม่เคยตั้ง');
      if (!setting.date) return el('td', { class: 'val-none' }, 'ไม่ทราบวันที่');
      if (setting.fromAds) {
        return el('td', {}, el('span', {
          class: 'src-ads', title: `ดึงจาก Google Ads ข้อมูลถึง ${thaiDate(setting.date)}`
        }, 'จาก Google Ads'));
      }
      return el('td', {}, el('span', {
        class: `stale${stale ? ' is-old' : ''}`,
        title: setting.legacy ? 'ค่านี้มาจากบันทึกเก่า — กด "ตั้งค่า" หนึ่งครั้งเพื่อย้ายมาเก็บกับแคมเปญ' : ''
      }, `${thaiDate(setting.date)} · ${relativeDay(setting.date)}${setting.legacy ? ' (จากบันทึกเก่า)' : ''}`));
    };

    tbody.append(el('tr', { class: stale ? 'row-warn' : '' },
      el('td', {}, el('b', {}, r.campaign)),
      el('td', {}, r.product || '—'),
      r.budget
        ? el('td', { class: 'num val-strong' }, fmt(r.budget.value, 0) + ' ฿')
        : el('td', { class: 'num val-none' }, '—'),
      pace
        ? el('td', {}, el('span', { class: `pace pace-${pace.level}`, title: pace.text },
            `${fmt(pace.pct, 0)}%`,
            el('span', { class: 'pace-tag' },
              pace.level === 'capped' ? ' ตัน' : pace.level === 'idle' ? ' เหลือ' : ' พอดี')))
        : el('td', { class: 'val-none' }, '—'),
      el('td', {}, r.strategy
        ? el('span', { class: 'src-ads' }, strategyLabel(r.ads))
        : el('span', { class: 'val-none' }, '—')),
      el('td', {
        class: 'num' + (set.kind === 'none' || set.kind === 'auto' || set.kind === 'uncapped'
          ? ' val-none' : ' val-strong'),
        title: set.title
      },
        set.text,
        set.label ? el('span', { class: 'cell-sub' }, set.label) : null),
      r.cpc === null
        ? el('td', { class: 'num val-none' }, '—')
        : el('td', { class: 'num' + (overBid ? ' delta-down' : '') },
            fmt(r.cpc, 2) + ' ฿',
            overBid ? el('span', { title: `CPC จริงสูงกว่า${set.label}ที่ตั้งไว้` }, ' ⚠') : null),
      when(r.budget),
      el('td', {},
        el('button', {
          class: 'btn btn-sm', onclick: () => Settings.open(r)
        }, 'ตั้งค่า'))));
  }
}

/**
 * แก้งบ/bid ของแคมเปญ — เก็บกับตัวแคมเปญเท่านั้น ไม่แตะไทม์ไลน์
 * ถ้าอยากให้ไทม์ไลน์จำด้วย มีปุ่ม "จดลงไทม์ไลน์ด้วย" ให้กดแยก
 */
const Settings = {
  campaign: '',
  built: false,

  build() {
    if (this.built) return;
    $('#setSave').addEventListener('click', e => { e.preventDefault(); this.save(); });
    $('#setCancel').addEventListener('click', e => { e.preventDefault(); $('#settingsModal').close(); });
    $('#setLog').addEventListener('click', e => { e.preventDefault(); this.save(true); });
    $('#settingsModal').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.save(); }
    });
    this.built = true;
  },

  open(row) {
    this.build();
    this.campaign = row.campaign;
    $('#setSub').textContent = row.campaign + (row.product ? ` · ${row.product}` : '');
    $('#set_budget').value = row.budget ? row.budget.value : '';
    $('#set_bid').value = row.bid ? row.bid.value : '';
    $('#settingsModal').showModal();
    setTimeout(() => $('#set_budget')?.focus(), 120);
  },

  /** alsoLog = เปิดฟอร์มบันทึกให้ต่อ เผื่ออยากจดว่าวันนี้ปรับงบ */
  async save(alsoLog = false) {
    const budget = $('#set_budget').value.trim();
    const bid = $('#set_bid').value.trim();
    const btn = alsoLog ? $('#setLog') : $('#setSave');
    btn.disabled = true; btn.classList.add('is-busy');
    try {
      await Store.saveCampaignSettings(this.campaign, { budget, bid });
      $('#settingsModal').close();
      toast(Store.online ? 'บันทึกค่าลง Google Sheet แล้ว' : 'บันทึกค่าในเครื่องแล้ว');
      refreshAll();
      if (alsoLog) {
        Form.reset();
        $('#f_campaign').value = this.campaign;
        Form.onCampaignInput();
        Form.refreshBaseline();
        const bits = [];
        if (budget) bits.push(`งบ → ${budget} บาท/วัน`);
        if (bid) bits.push(`Max CPC → ${bid} บาท`);
        $('#f_change_detail').value = bits.join(' · ');
        Form.selectedTags = new Set(['ปรับงบประมาณ']);
        $$('#tagChips .chip').forEach(c =>
          c.setAttribute('aria-pressed', String(Form.selectedTags.has(c.dataset.tag))));
        showTab('new');
        setTimeout(() => $('#f_change_detail')?.focus(), 200);
      }
    } catch (err) {
      toast('บันทึกไม่สำเร็จ: ' + (err.message || err), 5000);
    } finally {
      btn.disabled = false; btn.classList.remove('is-busy');
    }
  }
};

/* ── เก็บกวาดบันทึกที่เวอร์ชันก่อนสร้างไว้ตอนกด "อัปเดตค่า" ────── */

/** บันทึกที่เข้าข่าย: มีงบ/bid ติดอยู่ และไม่มีตัวเลขวัดผล */
function legacySettingRecords() {
  return Store.sorted().filter(r => {
    const hasSetting = num(r.budget) !== null || num(r.bid) !== null;
    if (!hasSetting) return false;
    if (isMeasured(r)) return false;                  // มีตัวเลขวัดผล = ของจริง อย่าแตะ
    const t = String(r.change_detail || '').trim();
    return t === '' || t === 'ปรับงบ / bid' || /^งบ →|^Max CPC →/.test(t);
  });
}

function renderCleanupCard() {
  const card = $('#budgetCleanup');
  if (!card) return;
  const list = legacySettingRecords();
  card.hidden = list.length === 0;
  if (card.hidden) return;

  const tbody = $('#cleanupTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of list) {
    const cb = el('input', { type: 'checkbox', checked: true, 'data-id': r.id,
      'aria-label': `เลือกบันทึกวันที่ ${thaiDate(r.date)}` });
    tbody.append(el('tr', {},
      el('td', {}, cb),
      el('td', {}, thaiDate(r.date)),
      el('td', {}, r.campaign || '—'),
      el('td', {}, String(r.change_detail || '').trim() || el('i', { class: 'val-none' }, 'ไม่มีข้อความ')),
      el('td', {}, num(r.budget) !== null ? fmt(num(r.budget), 0) + ' ฿' : '—'),
      el('td', {}, num(r.bid) !== null ? fmt(num(r.bid), 2) + ' ฿' : '—')));
  }
  $('#cleanupCount').textContent = `พบ ${list.length} รายการ`;
}

async function runCleanup() {
  const ids = $$('#cleanupTable input[type="checkbox"]:checked').map(c => c.dataset.id);
  if (!ids.length) { toast('ยังไม่ได้เลือกรายการ'); return; }
  if (!confirm(`ย้ายค่างบ/bid ไปเก็บกับแคมเปญ แล้วลบ ${ids.length} บันทึกนี้ถาวร?`)) return;

  const btn = $('#cleanupRun');
  btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = 'กำลังย้ายและลบ…';
  let moved = 0, removed = 0;
  try {
    // ย้ายค่าก่อน: ของบันทึกที่ใหม่สุดของแต่ละแคมเปญเท่านั้น จะได้ไม่ทับด้วยค่าเก่า
    const byCampaign = new Map();
    for (const r of Store.sorted()) {              // ใหม่ → เก่า
      if (!ids.includes(r.id) || !r.campaign) continue;
      if (!byCampaign.has(r.campaign)) byCampaign.set(r.campaign, r);
    }
    for (const [name, rec] of byCampaign) {
      const meta = Store.campaign(name);
      const budget = num(meta?.budget) !== null ? meta.budget : (num(rec.budget) !== null ? rec.budget : '');
      const bid = num(meta?.bid) !== null ? meta.bid : (num(rec.bid) !== null ? rec.bid : '');
      if (budget === '' && bid === '') continue;
      await Store.saveCampaignSettings(name, { budget, bid });
      moved++;
    }
    for (const id of ids) { await Store.remove(id); removed++; }
    toast(`ย้ายค่าให้ ${moved} แคมเปญ และลบ ${removed} บันทึกแล้ว`, 4200);
    refreshAll();
  } catch (err) {
    toast(`ลบได้ ${removed} รายการแล้วเจอปัญหา: ${err.message || err}`, 6000);
    refreshAll();
  } finally {
    btn.disabled = false; btn.classList.remove('is-busy'); btn.textContent = 'ย้ายค่าแล้วลบที่เลือก';
  }
}

function initBudgetPage() {
  $('#budgetGroup').addEventListener('change', renderBudgetPage);
  $('#cleanupRun').addEventListener('click', runCleanup);
  $('#cleanupNone').addEventListener('click', () =>
    $$('#cleanupTable input[type="checkbox"]').forEach(c => { c.checked = false; }));
  $('#budgetSearch').addEventListener('input', renderBudgetPage);
  $('#budgetCopy').addEventListener('click', () => {
    const rows = budgetRows();
    const lines = ['แคมเปญ\tสินค้า\tงบ/วัน\tMax CPC\tตั้งเมื่อ'];
    for (const r of rows) {
      lines.push([
        r.campaign, r.product || '',
        r.budget ? r.budget.value : '',
        r.bid ? r.bid.value : '',
        r.budget?.date || r.bid?.date || ''
      ].join('\t'));
    }
    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => toast('คัดลอกตารางแล้ว วางในชีตได้เลย'))
      .catch(() => toast('คัดลอกไม่สำเร็จ'));
  });
}

/* ─────────────────────────────────────────────────────────────
   10b. เปรียบเทียบรายสินค้า
   ───────────────────────────────────────────────────────────── */

/** สรุปหนึ่งแถวต่อสินค้า: ค่าล่าสุด + จำนวนครั้งที่ปรับ + สัดส่วนที่ได้ผล */
function productSummary() {
  const byProduct = new Map();
  for (const rec of Store.records) {
    const product = recProduct(rec);
    if (!product) continue;
    if (!byProduct.has(product)) {
      byProduct.set(product, {
        product,
        group: recGroup(rec),
        campaigns: new Set(),
        adjustments: 0,
        better: 0,
        judged: 0,
        latest: null,
        latestEnd: ''
      });
    }
    const row = byProduct.get(product);
    row.adjustments++;
    if (rec.campaign) row.campaigns.add(rec.campaign);
    const cmp = recCompare(rec);
    if (cmp && cmp.verdict !== 'pending') {
      row.judged++;
      if (cmp.verdict === 'up') row.better++;
    }
    // ค่าล่าสุด = บล็อกที่มีวันสิ้นสุดใหม่ที่สุดของสินค้านี้
    for (const side of ['before', 'after']) {
      const b = block(rec, side);
      if (!hasNumbers(b)) continue;
      const end = b._end || (side === 'before' ? rec.date : '');
      if (!end) continue;
      if (!row.latestEnd || end > row.latestEnd) {
        row.latestEnd = end;
        row.latest = solveBlock(b).values;
      }
    }
  }
  return [...byProduct.values()].map(r => ({ ...r, campaigns: r.campaigns.size }));
}

function renderProductComparison() {
  const sel = $('#prodMetric');
  if (!sel.options.length) {
    for (const m of METRICS) sel.append(el('option', { value: m.key }, m.label));
    sel.value = 'cpa';
  }
  const metricKey = sel.value || 'cpa';
  const metric = METRIC_BY_KEY[metricKey];
  const groupFilter = $('#prodGroupFilter').value;

  let rows = productSummary().filter(r => !groupFilter || r.group === groupFilter);

  // ตาราง (เป็นทั้งข้อมูลสำรองของกราฟ และที่อ่านค่าแม่นยำ)
  const tb = $('#prodTable tbody');
  tb.innerHTML = '';
  const sorted = [...rows].sort((a, b) => {
    const av = a.latest?.[metricKey], bv = b.latest?.[metricKey];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return metric.better === 'down' ? av - bv : bv - av;
  });
  for (const r of sorted) {
    tb.append(el('tr', {},
      el('td', {}, r.product),
      el('td', { style: 'text-align:left' }, r.group || '—'),
      el('td', {}, String(r.campaigns)),
      el('td', {}, String(r.adjustments)),
      el('td', {}, r.judged ? `${r.better}/${r.judged}` : '—'),
      el('td', {}, fmtMetric('cpa', r.latest?.cpa ?? null)),
      el('td', {}, fmtMetric('cvr', r.latest?.cvr ?? null)),
      el('td', {}, fmtMetric('ctr', r.latest?.ctr ?? null)),
      el('td', {}, fmtMetric('impr_share', r.latest?.impr_share ?? null))));
  }

  drawProductBars(sorted.filter(r => Number.isFinite(r.latest?.[metricKey])), metricKey);
}

/** กราฟแท่งแนวนอนเทียบสินค้า — วัดเดียว หลายหมวด จึงใช้สีเดียว ไม่ใช่สีแยกรายสินค้า */
function drawProductBars(rows, metricKey) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('#prodChart');
  const shell = $('#prodShell');
  const tooltip = $('#prodTooltip');
  svg.innerHTML = '';
  tooltip.hidden = true;

  const width = Math.max(320, shell.clientWidth || 720);
  const mk = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };

  if (!rows.length) {
    svg.setAttribute('width', width);
    svg.setAttribute('height', 90);
    svg.setAttribute('viewBox', `0 0 ${width} 90`);
    svg.append(mk('text', { x: width / 2, y: 48, 'text-anchor': 'middle' },
      'ยังไม่มีข้อมูลของตัวชี้วัดนี้ — บันทึกที่มีตัวเลขและระบุสินค้าไว้จะขึ้นที่นี่'));
    return;
  }

  const rowH = 30, gap = 8;
  const M = { top: 10, right: 70, bottom: 30, left: 132 };
  const H = rows.length * (rowH + gap) - gap;
  const height = M.top + H + M.bottom;
  const W = width - M.left - M.right;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const max = Math.max(...rows.map(r => r.latest[metricKey]));
  const ticks = niceTicks(0, max, 4);
  const hi = ticks[ticks.length - 1] || 1;
  const X = v => (v / hi) * W;
  const fill = cssVar('--series-1');

  for (const t of ticks) {
    svg.append(mk('line', { class: 'grid-line', x1: M.left + X(t), x2: M.left + X(t), y1: M.top, y2: M.top + H }));
    svg.append(mk('text', { x: M.left + X(t), y: M.top + H + 18, 'text-anchor': 'middle' }, fmtMetric(metricKey, t)));
  }

  rows.forEach((r, i) => {
    const y = M.top + i * (rowH + gap);
    const w = Math.max(2, X(r.latest[metricKey]));
    // ปลายแท่งมนด้านนอก ชิดเส้นฐานด้านใน
    svg.append(mk('path', {
      d: `M${M.left},${y} H${M.left + w - 4} a4,4 0 0 1 4,4 V${y + rowH - 4} a4,4 0 0 1 -4,4 H${M.left} Z`,
      fill
    }));
    svg.append(mk('text', {
      class: 'axis-label', x: M.left - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end'
    }, r.product));
    svg.append(mk('text', {
      class: 'point-label', x: M.left + w + 8, y: y + rowH / 2 + 4
    }, fmtMetric(metricKey, r.latest[metricKey])));

    const hit = mk('rect', { class: 'hit', x: 0, y, width, height: rowH });
    hit.addEventListener('mousemove', ev => {
      const rect = svg.getBoundingClientRect();
      tooltip.innerHTML = '';
      tooltip.append(el('div', { class: 'tt-title' }, `${r.product}${r.group ? ' · ' + r.group : ''}`));
      for (const [name, val] of [
        [METRIC_BY_KEY[metricKey].label, fmtMetric(metricKey, r.latest[metricKey])],
        ['ข้อมูลถึงวันที่', thaiDate(r.latestEnd)],
        ['แคมเปญ', String(r.campaigns)],
        ['ครั้งที่ปรับ', String(r.adjustments)],
        ['ได้ผล', r.judged ? `${r.better}/${r.judged}` : '—']
      ]) {
        tooltip.append(el('div', { class: 'tt-row' }, el('span', { class: 'name' }, name), val));
      }
      tooltip.hidden = false;
      tooltip.style.left = Math.min(ev.clientX - rect.left + 14, width - tooltip.offsetWidth - 4) + 'px';
      tooltip.style.top = (y + rowH) + 'px';
    });
    hit.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    svg.append(hit);
  });
}

/* ─────────────────────────────────────────────────────────────
   11. กราฟเทรนด์
   ───────────────────────────────────────────────────────────── */

/** แปลงบันทึกเป็นชุดจุดตามเวลา — แต่ละ "ช่วงวัดผล" คือหนึ่งจุด */
function buildSeries(records) {
  const byCampaign = new Map();
  for (const rec of records) {
    const camp = rec.campaign || '(ไม่ระบุ)';
    if (!byCampaign.has(camp)) byCampaign.set(camp, new Map());
    const bucket = byCampaign.get(camp);
    const add = (side, fallbackDate) => {
      const b = block(rec, side);
      if (!hasNumbers(b)) return;
      const x = b._end || fallbackDate;
      if (!x) return;
      const key = `${b._start}|${x}`;
      if (bucket.has(key)) return;
      bucket.set(key, { x, start: b._start, end: x, days: b._days, values: solveBlock(b).values });
    };
    add('before', rec.date);
    add('after', '');
  }
  const out = [];
  for (const [camp, bucket] of byCampaign) {
    const points = [...bucket.values()].sort((p, q) => String(p.x).localeCompare(String(q.x)));
    if (points.length) out.push({ campaign: camp, points });
  }
  return out;
}

function initTrendControls() {
  const sel = $('#trendMetric');
  sel.innerHTML = '';
  for (const m of METRICS) sel.append(el('option', { value: m.key }, m.label));
  sel.value = 'cpa';
  for (const id of ['#trendMetric', '#trendGroup', '#trendProduct',
    '#trendCampaign', '#trend_from', '#trend_to']) {
    $(id).addEventListener('input', () => {
      if (id === '#trendGroup') { $('#trendProduct').value = ''; $('#trendCampaign').value = ''; }
      if (id === '#trendProduct') $('#trendCampaign').value = '';
      renderTrend();
    });
  }
  for (const id of ['#trendMarkers', '#trendTable']) {
    $(id).addEventListener('click', e => {
      const on = e.currentTarget.getAttribute('aria-pressed') === 'true';
      e.currentTarget.setAttribute('aria-pressed', String(!on));
      renderTrend();
    });
  }
  window.addEventListener('resize', () => {
    if (!$('#panel-trend').hidden) renderTrend();
  });
}

function renderTrend() {
  syncCampaignSelects();
  const metricKey = $('#trendMetric').value || 'cpa';
  const metric = METRIC_BY_KEY[metricKey];
  const campFilter = $('#trendCampaign').value;
  const groupFilter = $('#trendGroup').value;
  const productFilter = $('#trendProduct').value;
  const from = $('#trend_from').value, to = $('#trend_to').value;
  const showMarkers = $('#trendMarkers').getAttribute('aria-pressed') === 'true';
  const showTable = $('#trendTable').getAttribute('aria-pressed') === 'true';

  const scope = [groupFilter, productFilter, campFilter].filter(Boolean).join(' › ');
  $('#trendTitle').textContent = `เทรนด์ ${metric.label}` +
    (scope ? ` · ${scope}` : '') +
    (metric.better === 'down' ? ' — ยิ่งต่ำยิ่งดี' : metric.better === 'up' ? ' — ยิ่งสูงยิ่งดี' : '');

  let records = Store.records.filter(r =>
    (!campFilter || r.campaign === campFilter) &&
    (!groupFilter || recGroup(r) === groupFilter) &&
    (!productFilter || recProduct(r) === productFilter));
  let series = buildSeries(records)
    .map(s => ({
      ...s,
      points: s.points.filter(p =>
        p.values[metricKey] !== null &&
        (!from || p.x >= from) && (!to || p.x <= to))
    }))
    .filter(s => s.points.length);

  const droppedSeries = Math.max(0, series.length - 6);
  if (droppedSeries) series = series.slice(0, 6);

  const adjustments = records
    .filter(r => r.date && (!from || r.date >= from) && (!to || r.date <= to))
    .filter(r => !campFilter || r.campaign === campFilter)
    .map(r => ({ date: r.date, campaign: r.campaign, detail: r.change_detail }));

  drawLineChart({
    svg: $('#trendChart'),
    shell: $('#trendShell'),
    tooltip: $('#trendTooltip'),
    legend: $('#trendLegend'),
    series, metricKey, adjustments: showMarkers ? adjustments : []
  });

  // ตารางข้อมูล (ทางเลือกสำรองสำหรับการอ่านค่าแม่นยำ / เข้าถึงได้)
  const tw = $('#trendTableWrap');
  tw.hidden = !showTable;
  if (showTable) {
    const tbl = el('table', { class: 'data' });
    tbl.append(el('thead', {}, el('tr', {},
      el('th', {}, 'ช่วงข้อมูล'), el('th', {}, 'แคมเปญ'), el('th', {}, 'จำนวนวัน'), el('th', {}, metric.label))));
    const tb = el('tbody');
    const rows = series.flatMap(s => s.points.map(p => ({ s, p })))
      .sort((a, b) => String(b.p.x).localeCompare(String(a.p.x)));
    for (const { s, p } of rows) {
      tb.append(el('tr', {},
        el('td', {}, p.start ? `${thaiDate(p.start)} – ${thaiDate(p.end)}` : thaiDate(p.end)),
        el('td', { style: 'text-align:left' }, s.campaign),
        el('td', {}, p.days ? String(p.days) : '—'),
        el('td', {}, fmtMetric(metricKey, p.values[metricKey]))));
    }
    tbl.append(tb);
    tw.innerHTML = '';
    tw.append(tbl);
  }

  if (droppedSeries) {
    $('#trendLegend').append(el('span', { class: 'legend-item' },
      `⚠️ แสดง 6 แคมเปญแรกจากทั้งหมด ${series.length + droppedSeries} — กรองด้วยกลุ่ม/สินค้าเพื่อดูที่เหลือ`));
  }

  renderSparklines(records, campFilter);
}

function niceTicks(min, max, count = 5) {
  if (min === max) { min = Math.min(0, min); max = max || 1; }
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function drawLineChart({ svg, shell, tooltip, legend, series, metricKey, adjustments }) {
  const NS = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '';
  legend.innerHTML = '';
  tooltip.hidden = true;

  const width = Math.max(320, shell.clientWidth || 720);
  const height = 320;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  if (!series.length) {
    svg.append(mk('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' },
      'ยังไม่มีข้อมูลพอสำหรับตัวชี้วัดนี้'));
    return;
  }

  const M = { top: 18, right: 20, bottom: 46, left: 62 };
  const W = width - M.left - M.right;
  const H = height - M.top - M.bottom;

  const allX = [...new Set(series.flatMap(s => s.points.map(p => p.x)))].sort();
  const xTimes = allX.map(x => parseDate(x).getTime());
  const adjTimes = adjustments.map(a => parseDate(a.date)?.getTime()).filter(Boolean);
  const tMin = Math.min(...xTimes, ...(adjTimes.length ? adjTimes : [Infinity]));
  const tMax = Math.max(...xTimes, ...(adjTimes.length ? adjTimes : [-Infinity]));
  const tSpan = tMax - tMin || 86400000;

  const vals = series.flatMap(s => s.points.map(p => p.values[metricKey]));
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  const ticks = niceTicks(Math.min(0, vMin), vMax, 5);
  const yLo = ticks[0], yHi = ticks[ticks.length - 1];

  const X = t => M.left + (t - tMin) / tSpan * W;
  const Y = v => M.top + H - (v - yLo) / (yHi - yLo || 1) * H;

  function mk(tag, attrs = {}, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // เส้นกริดแนวนอน + ป้ายแกน Y
  for (const t of ticks) {
    svg.append(mk('line', { class: 'grid-line', x1: M.left, x2: M.left + W, y1: Y(t), y2: Y(t) }));
    svg.append(mk('text', { x: M.left - 8, y: Y(t) + 4, 'text-anchor': 'end' }, fmtMetric(metricKey, t)));
  }
  svg.append(mk('line', { class: 'axis-line', x1: M.left, x2: M.left + W, y1: M.top + H, y2: M.top + H }));

  // ป้ายแกน X
  const labelCount = Math.min(allX.length, Math.max(2, Math.floor(W / 92)));
  const step = Math.max(1, Math.ceil(allX.length / labelCount));
  allX.forEach((x, i) => {
    if (i % step !== 0 && i !== allX.length - 1) return;
    const d = parseDate(x);
    svg.append(mk('text', {
      x: X(d.getTime()), y: M.top + H + 18, 'text-anchor': 'middle'
    }, `${d.getDate()}/${d.getMonth() + 1}`));
  });

  // เส้นประวันที่ปรับ
  const seenAdj = new Set();
  for (const a of adjustments) {
    const t = parseDate(a.date)?.getTime();
    if (!t || seenAdj.has(a.date)) continue;
    seenAdj.add(a.date);
    svg.append(mk('line', { class: 'adj-line', x1: X(t), x2: X(t), y1: M.top, y2: M.top + H }));
    svg.append(mk('text', { class: 'adj-label', x: X(t), y: M.top - 5, 'text-anchor': 'middle' }, '⚙'));
  }

  // เส้นข้อมูล
  const colors = series.map((_, i) => cssVar(SERIES_VARS[i % SERIES_VARS.length]));
  series.forEach((s, i) => {
    const pts = s.points.map(p => ({ ...p, t: parseDate(p.x).getTime(), v: p.values[metricKey] }));
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    svg.append(mk('path', { class: 'series-line', d, stroke: colors[i] }));
    for (const p of pts) {
      svg.append(mk('circle', { class: 'series-dot', cx: X(p.t), cy: Y(p.v), r: 4.5, fill: colors[i] }));
    }
    // ป้ายค่าโดยตรงที่จุดแรกและจุดสุดท้าย (ทำให้ระบุเส้นได้โดยไม่พึ่งสีอย่างเดียว)
    const last = pts[pts.length - 1];
    if (last) {
      svg.append(mk('text', {
        class: 'point-label', x: X(last.t) - 8, y: Y(last.v) - 10, 'text-anchor': 'end'
      }, fmtMetric(metricKey, last.v)));
    }
  });

  // Legend
  series.forEach((s, i) => {
    const sw = el('span', { class: 'legend-swatch' });
    sw.style.background = colors[i];
    legend.append(el('span', { class: 'legend-item' }, sw, s.campaign));
  });
  if (adjustments.length) {
    legend.append(el('span', { class: 'legend-item' }, '⚙ เส้นประ = วันที่มีการปรับ'));
  }

  // Hover crosshair + tooltip
  const cross = mk('line', { class: 'adj-line', x1: 0, x2: 0, y1: M.top, y2: M.top + H, opacity: 0 });
  svg.append(cross);
  const overlay = mk('rect', { class: 'hit', x: M.left, y: M.top, width: W, height: H });
  svg.append(overlay);

  const flat = series.flatMap((s, i) => s.points.map(p => ({
    campaign: s.campaign, color: colors[i], t: parseDate(p.x).getTime(),
    v: p.values[metricKey], start: p.start, end: p.end, days: p.days
  })));

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const t = tMin + (px - M.left) / W * tSpan;
    let best = null;
    for (const p of flat) {
      const dist = Math.abs(p.t - t);
      if (!best || dist < best.dist) best = { dist, p };
    }
    if (!best) return;
    const groupT = best.p.t;
    const group = flat.filter(p => p.t === groupT);
    cross.setAttribute('x1', X(groupT));
    cross.setAttribute('x2', X(groupT));
    cross.setAttribute('opacity', 1);

    tooltip.innerHTML = '';
    const g0 = group[0];
    tooltip.append(el('div', { class: 'tt-title' },
      g0.start ? `${thaiDate(g0.start)} – ${thaiDate(g0.end)}` : thaiDate(g0.end)));
    if (g0.days) tooltip.append(el('div', { class: 'tt-row' }, el('span', { class: 'name' }, 'จำนวนวัน'), String(g0.days)));
    for (const p of group) {
      const sw = el('span', { class: 'legend-swatch' });
      sw.style.background = p.color;
      tooltip.append(el('div', { class: 'tt-row' }, sw,
        el('span', { class: 'name' }, p.campaign), fmtMetric(metricKey, p.v)));
    }
    tooltip.hidden = false;
    const tx = Math.min(Math.max(X(groupT) + 14, 4), width - tooltip.offsetWidth - 4);
    tooltip.style.left = tx + 'px';
    tooltip.style.top = (M.top + 6) + 'px';
  }

  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('touchmove', onMove, { passive: true });
  overlay.addEventListener('mouseleave', () => { tooltip.hidden = true; cross.setAttribute('opacity', 0); });
}

function renderSparklines(records, campFilter) {
  const host = $('#sparkGrid');
  host.innerHTML = '';
  const note = $('#sparkNote');
  // เลือกแคมเปญที่มีช่วงข้อมูลมากที่สุดในขอบเขตที่กรองอยู่ (ข้อมูลเยอะสุด = เทรนด์อ่านได้จริง)
  const candidates = buildSeries(records).sort((a, b) => b.points.length - a.points.length);
  const target = campFilter
    ? candidates.find(s => s.campaign === campFilter) || candidates[0]
    : candidates[0];

  if (!target || target.points.length < 2) {
    note.textContent = '';
    host.append(el('div', { class: 'empty' }, 'ต้องมีอย่างน้อย 2 ช่วงข้อมูลของแคมเปญเดียวกันจึงจะวาดเทรนด์ได้'));
    return;
  }
  const meta = Store.campaign(target.campaign);
  const label = [meta?.product, target.campaign].filter(Boolean).join(' · ');
  note.textContent = `${label} · ${target.points.length} ช่วงข้อมูล` +
    (candidates.length > 1 ? ` (แคมเปญที่มีข้อมูลมากที่สุดจาก ${candidates.length})` : '');

  const NS = 'http://www.w3.org/2000/svg';
  const keys = ['cpa', 'conversions', 'cvr', 'ctr', 'cpc', 'impr_share', 'impressions', 'cost'];
  for (const key of keys) {
    const m = METRIC_BY_KEY[key];
    const pts = target.points.map(p => p.values[key]).filter(v => v !== null);
    if (pts.length < 2) continue;
    const first = pts[0], last = pts[pts.length - 1];
    const delta = first ? (last - first) / Math.abs(first) * 100 : null;
    const good = m.better === 'neutral' || delta === null ? null
      : (m.better === 'up') === (delta > 0);
    const cls = good === null ? 'delta-flat' : good ? 'delta-up' : 'delta-down';

    const w = 240, h = 42;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const lo = Math.min(...pts), hi = Math.max(...pts);
    const X = i => (i / (pts.length - 1)) * (w - 6) + 3;
    const Y = v => h - 5 - ((v - lo) / ((hi - lo) || 1)) * (h - 12);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', pts.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', cssVar('--series-1'));
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', X(pts.length - 1));
    dot.setAttribute('cy', Y(last));
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', cssVar('--series-1'));
    svg.append(dot);

    host.append(el('div', { class: 'spark-card' },
      el('div', { class: 'tile-label' }, m.label),
      el('div', { class: 'tile-value', style: 'font-size:1.15rem' }, fmtMetric(key, last)),
      el('div', { class: `tile-delta ${cls}` },
        delta === null ? '—' : `${delta > 0 ? '▲' : delta < 0 ? '▼' : '＝'} ${fmt(Math.abs(delta), 1)}% เทียบช่วงแรก`),
      svg));
  }
}

/* ─────────────────────────────────────────────────────────────
   12. นำเข้าข้อมูล
   ───────────────────────────────────────────────────────────── */

/** parser CSV/TSV ที่รองรับ field ครอบด้วย " และมีขึ้นบรรทัดใหม่ข้างใน */
function parseDelimited(text, delim) {
  if (!delim) delim = (text.split('\n')[0].split('\t').length > text.split('\n')[0].split(',').length) ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ข้าม */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** อ่านช่วงวันที่แบบไทย เช่น "3 มิ.ย - 7 ก.ค" — ปีเดาจากวันที่ของบันทึก */
function parseThaiRange(text, refYear) {
  const t = String(text || '');
  const MON = '(ม\\.?ค\\.?|ก\\.?พ\\.?|มี\\.?ค\\.?|เม\\.?ย\\.?|พ\\.?ค\\.?|มิ\\.?ย\\.?|ก\\.?ค\\.?|ส\\.?ค\\.?|ก\\.?ย\\.?|ต\\.?ค\\.?|พ\\.?ย\\.?|ธ\\.?ค\\.?)';
  const re = new RegExp(`(\\d{1,2})\\s*${MON}\\s*[-–—]\\s*(\\d{1,2})\\s*${MON}`);
  const m = t.match(re);
  if (!m) return null;
  const monIdx = s => {
    const norm = String(s).replace(/\./g, '');
    return THAI_MONTHS.findIndex(x => x.replace(/\./g, '') === norm);
  };
  const m1 = monIdx(m[2]), m2 = monIdx(m[4]);
  if (m1 < 0 || m2 < 0) return null;
  const year = refYear || new Date().getFullYear();
  let start = new Date(year, m1, +m[1]);
  let end = new Date(year, m2, +m[3]);
  if (start > end) start = new Date(year - 1, m1, +m[1]);
  return { start: toISO(start), end: toISO(end) };
}

/** ดึงตัวเลขตัวชี้วัดออกจากข้อความบล็อก Performance แบบที่จดไว้เดิม */
function parsePerformanceText(text, refYear) {
  const t = String(text || '');
  const out = {};
  const grab = (re) => {
    const m = t.match(re);
    return m ? num(m[1]) : null;
  };
  // ต้องมี = หรือ : คั่น เพื่อไม่ให้ "Impression Share" ถูกอ่านเป็น "Impression"
  out.impressions  = grab(/impressions?\s*[=:]\s*([\d,\.]+)/i);
  out.clicks       = grab(/clicks?\s*[=:]\s*([\d,\.]+)/i);
  out.ctr          = grab(/ctr\s*[=:]\s*([\d,\.]+)\s*%?/i);
  out.cpc          = grab(/(?<!max\s)(?<!maximum\s)cpc\s*[=:]\s*(?:THB|฿)?\s*([\d,\.]+)/i);
  out.conversions  = grab(/conversions?\s*[=:]\s*([\d,\.]+)/i);
  out.cvr          = grab(/conversion\s*rate\s*[=:]\s*([\d,\.]+)\s*%?/i);
  out.cpa          = grab(/cost\s*[\/ ]\s*conversion\s*[=:]\s*(?:THB|฿)?\s*([\d,\.]+)/i);
  out.impr_share   = grab(/impression\s*share\s*[=:]\s*([\d,\.]+)\s*%?/i);
  out.lost_rank    = grab(/lost\s*is\s*\(?\s*rank\s*\)?\s*[=:]\s*([\d,\.]+)\s*%?/i);
  out.lost_budget  = grab(/lost\s*is\s*\(?\s*budget\s*\)?\s*[=:]\s*([\d,\.]+)\s*%?/i);
  out.max_cpc      = grab(/max(?:imum)?\s*cpc[^=\n]*[=:]\s*(?:THB|฿)?\s*([\d,\.]+)/i);

  // Cost รวม — รูปแบบ "(3 มิ.ย - 7 ก.ค = 5,562.90 THB)" หรือ "Cost รวม = 1,234"
  let cost = grab(/[=:]\s*(?:THB|฿)?\s*([\d,]+\.?\d*)\s*(?:THB|บาท)?\s*\)/i);
  if (cost === null) cost = grab(/cost\s*(?:รวม|total)?\s*[=:]\s*(?:THB|฿)?\s*([\d,]+\.?\d*)/i);
  out.cost = cost;

  const range = parseThaiRange(t, refYear);
  if (range) { out._start = range.start; out._end = range.end; }

  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

let importStaged = [];

function initImport() {
  $('#importFileBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    $('#importFileName').textContent = f.name;
    $('#importText').value = await f.text();
    doParseImport();
  });
  $('#importParse').addEventListener('click', doParseImport);
  $('#importCommit').addEventListener('click', doCommitImport);
}

function doParseImport() {
  const text = $('#importText').value;
  const host = $('#importResult');
  host.innerHTML = '';
  importStaged = [];
  $('#importCommit').disabled = true;
  if (!text.trim()) { host.append(el('div', { class: 'banner warn' }, 'ยังไม่มีข้อมูลให้วิเคราะห์')); return; }

  const rows = parseDelimited(text);
  if (rows.length < 2) { host.append(el('div', { class: 'banner bad' }, 'อ่านข้อมูลไม่ได้ — ตรวจว่ามีอย่างน้อย 2 บรรทัด')); return; }

  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const looksLikeExport = header.includes('id') && header.includes('campaign');

  const staged = [];
  if (looksLikeExport) {
    // ไฟล์ที่ export จากแอปนี้เอง
    for (const r of rows.slice(1)) {
      const rec = {};
      header.forEach((h, i) => { rec[rows[0][i].trim()] = r[i] ?? ''; });
      rec.id = '';
      staged.push(normalizeRecord(rec));
    }
  } else {
    // ตารางบันทึกแบบเดิม: วันที่ | แคมเปญ | สิ่งที่ปรับ | ผลก่อนปรับ | เหตุผล | คาดหวัง | ผลหลังปรับ
    for (const r of rows.slice(1)) {
      const [date, campaign, change, beforeTxt, reason, expected, afterTxt] = r;
      if (!String(date || '').trim() && !String(campaign || '').trim()) continue;
      const campName = String(campaign || '').trim().replace(/\s+/g, ' ');
      const known = Store.campaign(campName);
      const guess = guessFromCampaignName(campName);
      const product = known?.product || guess.product || '';
      const rec = {
        id: '',
        date: toISO(parseDate(date)) || String(date || '').trim(),
        product,
        product_group: product ? Taxonomy.groupOf(product) : '',
        campaign: campName,
        ad_group: '',
        tags: guessTags(change),
        change_detail: String(change || '').trim(),
        reason: String(reason || '').trim(),
        expected: String(expected || '').trim(),
        result_note: '',
        status: ''
      };
      const refYear = (parseDate(rec.date) || new Date()).getFullYear();
      const b = parsePerformanceText(beforeTxt, refYear);
      const a = parsePerformanceText(afterTxt, refYear);
      // เติมค่าที่คำนวณได้ (clicks, cost ฯลฯ) ตั้งแต่ตอนนำเข้า
      const bs = Object.keys(b).length ? solveBlock(b).values : {};
      const as = Object.keys(a).length ? solveBlock(a).values : {};
      for (const m of METRICS) {
        rec[`before_${m.key}`] = bs[m.key] === null || bs[m.key] === undefined ? '' : round(bs[m.key], m.dec);
        rec[`after_${m.key}`] = as[m.key] === null || as[m.key] === undefined ? '' : round(as[m.key], m.dec);
      }
      rec.before_start = b._start || ''; rec.before_end = b._end || '';
      rec.after_start = a._start || ''; rec.after_end = a._end || '';
      rec.status = hasNumbers(block(rec, 'after')) ? 'มีผลแล้ว' : 'รอผล';
      staged.push(rec);
    }
  }

  importStaged = staged.filter(r => r.campaign || r.change_detail);
  if (!importStaged.length) {
    host.append(el('div', { class: 'banner bad' }, 'ไม่พบแถวที่นำเข้าได้'));
    return;
  }

  const tbl = el('table', { class: 'data' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, 'วันที่'), el('th', {}, 'แคมเปญ'), el('th', {}, 'สินค้า'), el('th', {}, 'สิ่งที่ปรับ'),
    el('th', {}, 'ก่อน: Impr / CPA'), el('th', {}, 'หลัง: Impr / CPA'))));
  const tb = el('tbody');
  for (const r of importStaged) {
    tb.append(el('tr', {},
      el('td', {}, r.date ? thaiDate(r.date) : el('span', { class: 'delta-down' }, 'อ่านวันที่ไม่ได้')),
      el('td', { style: 'text-align:left' }, r.campaign || '—'),
      el('td', { style: 'text-align:left' },
        r.product || el('span', { class: 'delta-flat' }, 'ยังไม่ระบุ')),
      el('td', { style: 'text-align:left;max-width:240px' }, (r.change_detail || '').replace(/\s+/g, ' ').slice(0, 80)),
      el('td', {}, `${fmtMetric('impressions', num(r.before_impressions))} / ${fmtMetric('cpa', num(r.before_cpa))}`),
      el('td', {}, `${fmtMetric('impressions', num(r.after_impressions))} / ${fmtMetric('cpa', num(r.after_cpa))}`)));
  }
  tbl.append(tb);

  const badDates = importStaged.filter(r => !parseDate(r.date)).length;
  host.append(
    el('div', { class: badDates ? 'banner warn' : 'banner' },
      el('span', { class: 'icon' }, badDates ? '⚠️' : '✅'),
      el('span', {}, `อ่านได้ ${importStaged.length} แถว` +
        (badDates ? ` — มี ${badDates} แถวที่อ่านวันที่ไม่ได้ ระบบจะเก็บข้อความเดิมไว้ แก้ทีหลังได้` : ''))),
    el('div', { class: 'table-wrap' }, tbl));
  $('#importCommit').disabled = false;
}

function guessTags(text) {
  const t = String(text || '').toLowerCase();
  const hits = new Set();
  const removing = /ลบ|เอาออก|remove|pause|หยุด/.test(t);
  if (/negative/.test(t)) hits.add('เพิ่ม Negative Keywords');
  if (/keyword|คีย์เวิร์ด/.test(t.replace(/negative\s*keywords?/g, ''))) {
    hits.add(removing ? 'ลบ Keywords' : 'เพิ่ม Keywords');
  }
  if (/match\s*type/.test(t)) hits.add('ปรับ Match Type');
  if (/headline|description|ข้อความโฆษณา/.test(t)) hits.add('แก้ Headline / Description');
  if (/\bbid\b|max cpc|bid limit/.test(t)) hits.add('ปรับ Bid / Max CPC');
  if (/bid strategy|กลยุทธ์/.test(t)) hits.add('เปลี่ยน Bid Strategy');
  if (/budget|งบ|cost\s*(จาก|เป็น)/.test(t)) hits.add('ปรับงบประมาณ');
  if (/ad ?group/.test(t)) hits.add('ปรับ Ad Group');
  if (/audience|กลุ่มเป้าหมาย/.test(t)) hits.add('ปรับ Audience');
  if (/landing|หน้าเว็บ/.test(t)) hits.add('ปรับ Landing Page');
  if (/schedule|location|พื้นที่|เวลา/.test(t)) hits.add('ปรับ Location / Schedule');
  return [...hits].join(' | ');
}

async function doCommitImport() {
  if (!importStaged.length) return;
  const btn = $('#importCommit');
  btn.disabled = true;
  btn.textContent = 'กำลังนำเข้า…';
  try {
    const n = await Store.bulkCreate(importStaged.map(r => ({ ...r, id: '' })));
    toast(`นำเข้า ${n} บันทึกแล้ว`);
    importStaged = [];
    $('#importResult').innerHTML = '';
    $('#importText').value = '';
    $('#importFileName').textContent = '';
    refreshAll();
  } catch (err) {
    toast('นำเข้าไม่สำเร็จ: ' + (err.message || err), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'นำเข้าทั้งหมด';
  }
}

/* ─────────────────────────────────────────────────────────────
   13. ตั้งค่า / สำรองข้อมูล
   ───────────────────────────────────────────────────────────── */

const SETUP_STEPS_HTML = `
<ol style="padding-left:1.2em;line-height:1.8">
  <li>สร้าง Google Sheet ใหม่ ตั้งชื่ออะไรก็ได้ เช่น <code>Ads Adjust Record DB</code></li>
  <li>เมนู <b>Extensions → Apps Script</b></li>
  <li>ลบโค้ดเดิมทิ้ง แล้ววางเนื้อหาไฟล์ <code>apps-script/Code.gs</code> ลงไป</li>
  <li>แก้บรรทัด <code>var API_TOKEN = '...'</code> ให้เป็นรหัสลับของตัวเอง</li>
  <li>เลือกฟังก์ชัน <code>setup</code> แล้วกด <b>Run</b> หนึ่งครั้ง (อนุญาตสิทธิ์ตามที่ขอ) — ชีต RECORDS และ CAMPAIGNS จะถูกสร้างให้</li>
  <li>กด <b>Deploy → New deployment → เลือก Web app</b><br>
      • Execute as: <b>Me</b><br>
      • Who has access: <b>Anyone</b></li>
  <li>คัดลอก URL ที่ลงท้ายด้วย <code>/exec</code> มาวางในช่องด้านบน พร้อมรหัสลับเดียวกัน แล้วกดบันทึก</li>
</ol>
<p class="card-note">ถ้าแก้ไข Code.gs ภายหลัง ต้องไป <b>Deploy → Manage deployments → ✏️ → Version: New version</b> ทุกครั้ง URL เดิมถึงจะได้โค้ดใหม่</p>`;

/** dropdown สินค้าแบบจัดกลุ่ม ใช้ซ้ำหลายที่ */
function productSelect(value, onChange) {
  const sel = el('select', onChange ? { onchange: onChange } : {});
  sel.append(el('option', { value: '' }, '— ยังไม่ระบุ —'));
  for (const g of Taxonomy.groups()) {
    const og = el('optgroup', { label: g });
    for (const p of Taxonomy.products(g)) og.append(el('option', { value: p }, p));
    sel.append(og);
  }
  sel.value = value || '';
  return sel;
}

/** แถบ "เพิ่มแคมเปญ" เหนือตาราง — ตั้งค่าแคมเปญล่วงหน้าได้โดยไม่ต้องบันทึกการปรับก่อน */
function renderCampaignAdder() {
  const tableWrap = $('#campaignTable').closest('.table-wrap');
  let host = $('#campaignAdder');
  if (!host) {
    host = el('div', { id: 'campaignAdder' });
    host.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 12px';
    tableWrap.parentNode.insertBefore(host, tableWrap);
  }
  host.innerHTML = '';

  const nameInput = el('input', {
    type: 'text', placeholder: 'ชื่อแคมเปญ เช่น 25Search-iPhone', style: 'min-width:190px'
  });
  let touchedProduct = false;
  const prodSel = productSelect('', () => { touchedProduct = true; });

  // พิมพ์ชื่อแล้วเดาสินค้าให้ทันที
  // เขียนทับทุกครั้ง (รวมทั้งกรณีเดาไม่ออก = ล้างค่า) กันค่าของแคมเปญก่อนหน้าค้าง
  nameInput.addEventListener('input', () => {
    if (!touchedProduct) prodSel.value = guessFromCampaignName(nameInput.value).product || '';
  });

  const add = async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('ใส่ชื่อแคมเปญก่อน'); nameInput.focus(); return; }
    if (Store.campaign(name)) { toast(`มีแคมเปญ "${name}" อยู่แล้ว — แก้ในตารางด้านล่างได้เลย`, 4000); return; }
    try {
      await Store.saveCampaignMeta(name, prodSel.value);
      toast(`เพิ่ม ${name} แล้ว`);
      nameInput.value = '';
      touchedProduct = false;
      refreshAll();
      renderTaxonomyEditor();
      $('#campaignAdder input')?.focus();
    } catch (err) {
      toast('เพิ่มไม่สำเร็จ: ' + (err.message || err), 5000);
    }
  };
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  host.append(
    nameInput, prodSel,
    el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: add }, '＋ เพิ่มแคมเปญ')
  );
}

/** กล่องบอกว่าตอนนี้ต่อชีตไหนอยู่ และต่อด้วยค่าจากไหน */
function upgradeBanner() {
  if (!sheetNeedsUpgrade()) return null;
  return el('div', { class: 'banner bad' },
    el('span', { class: 'icon' }, '⚠️'),
    el('span', {},
      el('b', {}, 'Code.gs ในชีตเป็นเวอร์ชันเก่า '),
      `(${Store.serverVersion}) `,
      'ทำให้งบ/bid ที่ตั้งไว้ไม่ถูกเขียนลงชีต — วาง Code.gs ใหม่ทับแล้ว Deploy › Manage deployments › ✏️ › New version'));
}

function renderConnStatusBox() {
  const box = $('#connSource');
  if (!box) return;
  box.innerHTML = '';

  if (!Store.online && /api\/sheet/.test(Store.lastError || '')) {
    box.append(el('div', { class: 'banner bad' },
      el('span', { class: 'icon' }, '🔌'),
      el('span', {},
        el('b', {}, 'ยังไม่พบตัวกลาง /api/sheet '),
        'เวอร์ชันนี้ไม่เก็บรหัสไว้ในโค้ดแล้ว จึงต้องมีตัวกลางฝั่งเซิร์ฟเวอร์',
        el('div', { style: 'margin-top:8px' },
          'ทางเลือก 1 — ย้ายไป Cloudflare Pages แล้วอัปโฟลเดอร์ ', el('code', {}, 'functions/'),
          ' ขึ้นไปด้วย (ดูขั้นตอนใน README)'),
        el('div', { style: 'margin-top:4px' },
          'ทางเลือก 2 — ใช้ไปก่อน: กรอก URL ', el('code', {}, '/exec'),
          ' กับ token ในช่องด้านล่าง ค่าจะเก็บในเบราว์เซอร์เครื่องนี้เท่านั้น ไม่ขึ้น repo'))));
  }

  const up = upgradeBanner();
  if (up) box.append(up);

  if (!Store.configured) {
    box.append(el('div', { class: 'banner warn' },
      el('span', { class: 'icon' }, '💾'),
      el('span', {}, el('b', {}, 'โหมดออฟไลน์ '),
        'ข้อมูลเก็บในเบราว์เซอร์เครื่องนี้เท่านั้น — กด "ใช้ชีตเริ่มต้น" เพื่อกลับไปต่อชีตของทีม')));
    return;
  }

  if (Store.isDevUrl) {
    box.append(el('div', { class: 'banner bad' },
      el('span', { class: 'icon' }, '⚠️'),
      el('span', {}, el('b', {}, 'URL นี้ลงท้ายด้วย /dev '),
        'ซึ่งเป็นเวอร์ชันทดสอบ — ใช้ได้เฉพาะเจ้าของสคริปต์ที่ล็อกอิน Google อยู่ ' +
        'คนอื่นเปิดลิงก์จะต่อไม่ได้ ให้ไป Apps Script → Deploy → Manage deployments แล้วคัดลอก URL ที่ลงท้าย /exec มาใช้แทน')));
  }

  box.append(el('div', { class: 'banner' },
    el('span', { class: 'icon' }, Store.usingDefault ? '🔗' : '✏️'),
    el('span', {},
      el('b', {}, Store.usingDefault ? 'ใช้ชีตเริ่มต้นที่ฝังมากับเว็บ ' : 'ใช้ค่าที่กรอกเองในเครื่องนี้ '),
      Store.usingDefault
        ? 'ใครเปิดลิงก์นี้ก็เห็นข้อมูลชุดเดียวกันทันที ไม่ต้องกรอกอะไร'
        : 'ค่านี้ทับค่าเริ่มต้นเฉพาะเบราว์เซอร์นี้ — กด "ใช้ชีตเริ่มต้น" เพื่อยกเลิก')));

  // ถ้ากรอกค่าเองแล้วต่อติด เสนอวิธีฝังค่านี้ให้ทุกคนที่เปิดลิงก์
  if (!Store.usingDefault && Store.online && Store.config.url !== DEFAULT_CONFIG.url) {
    const snippet =
      `const DEFAULT_CONFIG = {\n` +
      `  url: '${Store.config.url}',\n` +
      `  token: '${Store.config.token}'\n` +
      `};`;
    box.append(el('div', { class: 'banner good' },
      el('span', { class: 'icon' }, '📌'),
      el('span', {},
        el('b', {}, 'อยากให้ทุกคนที่เปิดลิงก์ใช้ชีตนี้? '),
        'เอาโค้ดข้างล่างไปวางทับบล็อก DEFAULT_CONFIG ที่หัวไฟล์ ',
        el('code', {}, 'assets/app.js'), ' บน GitHub',
        el('pre', {
          style: 'margin:10px 0 0;padding:11px 13px;background:var(--surface-1);' +
                 'border:1px solid var(--border);border-radius:8px;overflow:auto;' +
                 'font-size:0.78rem;line-height:1.6;white-space:pre'
        }, snippet),
        el('div', { style: 'margin-top:8px' },
          el('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: async e => {
              try {
                await navigator.clipboard.writeText(snippet);
                toast('คัดลอกโค้ดแล้ว');
              } catch { toast('คัดลอกไม่ได้ — เลือกข้อความแล้วกด Ctrl+C แทน'); }
            }
          }, 'คัดลอกโค้ด')))));
  }
}

function renderTaxonomyEditor() {
  $('#taxonomyText').value = Taxonomy.toText();
  renderCampaignAdder();

  const tb = $('#campaignTable tbody');
  tb.innerHTML = '';
  if (!Store.campaigns.length) {
    tb.append(el('tr', {}, el('td', { colspan: '2', style: 'text-align:left' },
      'ยังไม่มีแคมเปญ — บันทึกครั้งแรกแล้วชื่อจะมาอยู่ที่นี่เอง')));
    return;
  }
  for (const c of [...Store.campaigns].sort((a, b) => a.name.localeCompare(b.name))) {
    const productSel = productSelect(c.product, async e => {
      try {
        await Store.saveCampaignMeta(c.name, e.target.value);
        toast(`ตั้ง ${c.name} เป็น ${e.target.value || 'ไม่ระบุสินค้า'} แล้ว`);
        refreshAll();
      } catch (err) { toast('บันทึกไม่สำเร็จ: ' + (err.message || err), 5000); }
    });

    tb.append(el('tr', {},
      el('td', { style: 'text-align:left' }, c.name),
      el('td', { style: 'text-align:left' }, productSel)));
  }
}

function initSettings() {
  $('#setupSteps').innerHTML = SETUP_STEPS_HTML;

  $('#taxonomySave').addEventListener('click', async () => {
    const box = $('#taxonomyResult');
    const parsed = Taxonomy.fromText($('#taxonomyText').value);
    box.innerHTML = '';
    if (parsed.error) {
      box.append(el('div', { class: 'banner bad' }, el('span', { class: 'icon' }, '⚠️'), parsed.error));
      return;
    }
    // เตือนถ้าลบสินค้าที่ยังมีบันทึกอ้างอยู่
    const names = parsed.list.map(p => p.product.toLowerCase());
    const orphaned = [...new Set(Store.records.map(recProduct).filter(Boolean))]
      .filter(p => !names.includes(p.toLowerCase()));
    try {
      await Store.saveProducts(parsed.list);
      Form.buildTaxonomySelects();
      refreshAll();
      renderTaxonomyEditor();
      box.innerHTML = '';
      box.append(el('div', { class: orphaned.length ? 'banner warn' : 'banner' },
        el('span', { class: 'icon' }, orphaned.length ? '⚠️' : '✅'),
        el('span', {}, `บันทึกหมวดหมู่แล้ว — ${parsed.list.length} สินค้า ใน ${new Set(parsed.list.map(p => p.product_group)).size} กลุ่ม` +
          (orphaned.length ? ` · สินค้าที่ยังมีบันทึกอ้างอยู่แต่ถูกลบออก: ${orphaned.join(', ')} (บันทึกเดิมจะไปอยู่กลุ่ม "อื่น ๆ")` : ''))));
    } catch (err) {
      box.append(el('div', { class: 'banner bad' }, 'บันทึกไม่สำเร็จ: ' + (err.message || err)));
    }
  });

  $('#taxonomyReset').addEventListener('click', () => {
    const before = Taxonomy.list;
    Taxonomy.loadDefaults();
    $('#taxonomyText').value = Taxonomy.toText();
    Taxonomy.list = before;   // ยังไม่บันทึกจนกว่าจะกดปุ่มบันทึก
    toast('ใส่ค่าตั้งต้นให้แล้ว — กด "บันทึกหมวดหมู่" เพื่อยืนยัน');
  });
  $('#cfg_url').value = Store.config.url || '';
  $('#cfg_token').value = Store.config.token || '';

  $('#cfgSave').addEventListener('click', async () => {
    Store.config.url = $('#cfg_url').value.trim();
    Store.config.token = $('#cfg_token').value.trim();
    Store.saveConfig();
    const box = $('#cfgResult');
    box.innerHTML = '';
    box.append(el('div', { class: 'banner' }, 'กำลังทดสอบ…'));
    const res = await Store.sync();
    box.innerHTML = '';
    if (res.mode === 'sheet') {
      box.append(el('div', { class: 'banner' }, el('span', { class: 'icon' }, '✅'),
        el('span', {}, `เชื่อมต่อสำเร็จ — พบ ${Store.records.length} บันทึกในชีต`)));
    } else {
      box.append(el('div', { class: 'banner bad' }, el('span', { class: 'icon' }, '⚠️'),
        el('span', { html: `เชื่อมต่อไม่สำเร็จ: ${esc(res.error || 'ไม่ทราบสาเหตุ')}<br>
          <span class="card-note">ตรวจ 3 อย่าง: URL ลงท้าย /exec · Deploy แบบ "Anyone" · รหัสลับตรงกับ Code.gs</span>` })));
    }
    refreshAll();
    renderConnStatusBox();
  });

  $('#cfgDefault').addEventListener('click', async () => {
    Store.useDefaultConfig();
    $('#cfg_url').value = Store.config.url;
    $('#cfg_token').value = Store.config.token;
    await Store.sync();
    toast('กลับมาใช้ชีตเริ่มต้นแล้ว');
    refreshAll();
    renderConnStatusBox();
  });

  $('#cfgClear').addEventListener('click', () => {
    Store.goOffline();
    $('#cfg_url').value = ''; $('#cfg_token').value = '';
    Store.online = false;
    Store.status = 'local';
    toast('ใช้แบบออฟไลน์แล้ว — ข้อมูลเก็บในเครื่องนี้');
    refreshAll();
    renderConnStatusBox();
  });

  $('#exportJson').addEventListener('click', () => {
    download(`ads-adjust-record-${todayISO()}.json`,
      JSON.stringify({ version: APP_VERSION, exportedAt: new Date().toISOString(), records: Store.records }, null, 2),
      'application/json');
  });

  $('#exportCsv').addEventListener('click', () => {
    const cols = ['id', 'date', 'product_group', 'product', 'campaign', 'ad_group',
      'tags', 'change_detail', 'reason', 'expected', 'result_note', 'status',
      ...['before', 'after'].flatMap(s => [`${s}_start`, `${s}_end`, ...METRICS.map(m => `${s}_${m.key}`)])];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(',')];
    for (const r of Store.sorted()) lines.push(cols.map(c => q(r[c])).join(','));
    download(`ads-adjust-record-${todayISO()}.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
  });

  $('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
  $('#restoreFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = (data.records || []).map(normalizeRecord);
      if (!list.length) { toast('ไม่พบบันทึกในไฟล์'); return; }
      if (!confirm(`นำเข้า ${list.length} บันทึกจากไฟล์สำรอง?`)) return;
      await Store.bulkCreate(list.map(r => ({ ...r, id: '' })));
      toast(`กู้คืน ${list.length} บันทึกแล้ว`);
      refreshAll();
    } catch (err) {
      toast('อ่านไฟล์ไม่สำเร็จ: ' + err.message, 5000);
    }
  });

  $('#wipeLocal').addEventListener('click', () => {
    if (!confirm('ล้างข้อมูลที่เก็บในเบราว์เซอร์เครื่องนี้?\n(ข้อมูลใน Google Sheet จะไม่ถูกลบ)')) return;
    localStorage.removeItem(LS_CACHE);
    if (!Store.online) { Store.records = []; Store.campaigns = []; }
    toast('ล้างข้อมูลในเครื่องแล้ว');
    refreshAll();
  });
}

/* ─────────────────────────────────────────────────────────────
   14. ประสานงานทั้งหน้า
   ───────────────────────────────────────────────────────────── */

/** เติมตัวเลือกให้ select โดยรักษาค่าเดิมไว้ถ้ายังเลือกได้ */
function fillSelect(sel, values, allLabel) {
  const cur = sel.value;
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, allLabel));
  for (const v of values) sel.append(el('option', { value: v }, v));
  sel.value = values.includes(cur) ? cur : '';
}

/** เติม dropdown หมวดหมู่ทุกหน้า แบบไล่ลำดับ กลุ่ม → สินค้า → ช่องทาง → แคมเปญ */
function syncCampaignSelects() {
  const sets = [
    { group: '#flt_group', product: '#flt_product', campaign: '#flt_campaign', all: 'ทั้งหมด' },
    { group: '#trendGroup', product: '#trendProduct', campaign: '#trendCampaign', all: 'ทั้งหมด' }
  ];

  const campaignsOf = (group, product) => Store.campaigns.filter(c => {
    const g = c.product ? Taxonomy.groupOf(c.product) : '';
    if (group && g !== group) return false;
    if (product && c.product !== product) return false;
    return true;
  }).map(c => c.name);

  for (const s of sets) {
    if (!$(s.group)) continue;
    fillSelect($(s.group), Taxonomy.groups(), s.all);
    const g = $(s.group).value;
    fillSelect($(s.product), Taxonomy.products(g), s.all);
    fillSelect($(s.campaign), campaignsOf(g, $(s.product).value),
      s.campaign === '#trendCampaign' ? 'ทั้งหมด (สูงสุด 6)' : s.all);
  }

  if ($('#prodGroupFilter')) fillSelect($('#prodGroupFilter'), Taxonomy.groups(), 'ทุกกลุ่ม');
  if ($('#budgetGroup')) fillSelect($('#budgetGroup'), Taxonomy.groups(), 'ทุกกลุ่ม');
}

function updateConnBadge() {
  const pill = $('#connStatus'), text = $('#connText');
  const banner = $('#setupBanner');
  pill.className = 'status-pill';
  banner.innerHTML = '';

  if (Store.status === 'connecting') {
    pill.classList.add('is-connecting');
    text.textContent = 'กำลังเชื่อมต่อ Google Sheet…';
    banner.append(el('div', { class: 'banner' },
      el('span', { class: 'icon' }, '⏳'),
      el('span', {}, 'กำลังดึงข้อมูลจาก Google Sheet — ครั้งแรกของวันอาจใช้เวลาสัก 5–15 วินาที')));
    return;
  }

  if (Store.online) {
    pill.classList.add('is-online');
    text.textContent = `Google Sheet · ${Store.records.length} บันทึก`;
  } else if (Store.configured) {
    pill.classList.add('is-error');
    text.textContent = 'เชื่อมชีตไม่ได้';
  } else {
    pill.classList.add('is-local');
    text.textContent = `เก็บในเครื่อง · ${Store.records.length} บันทึก`;
  }

  if (!Store.configured) {
    banner.append(el('div', { class: 'banner warn' },
      el('span', { class: 'icon' }, '💾'),
      el('span', {}, 'ตอนนี้ข้อมูลถูกเก็บไว้ในเบราว์เซอร์เครื่องนี้เท่านั้น — ',
        el('a', { href: '#data', onclick: e => { e.preventDefault(); showTab('data'); } }, 'เชื่อมต่อ Google Sheet'),
        ' เพื่อให้เปิดจากมือถือ/เครื่องอื่นได้ และไม่หายเวลาล้างแคช')));
  } else if (!Store.online && Store.isDevUrl) {
    banner.append(el('div', { class: 'banner bad' },
      el('span', { class: 'icon' }, '⚠️'),
      el('span', {},
        el('b', {}, 'ต่อชีตไม่ได้เพราะ URL ลงท้าย /dev '),
        'ซึ่งเป็นเวอร์ชันทดสอบของ Apps Script ใช้ได้เฉพาะเจ้าของสคริปต์ — ต้องเปลี่ยนเป็น URL ที่ลงท้าย /exec',
        el('div', { class: 'card-note', style: 'margin-top:8px' }, Store.lastError))));
  } else if (!Store.online) {
    banner.append(el('div', { class: 'banner bad' },
      el('span', { class: 'icon' }, '⚠️'),
      el('span', {},
        el('b', {}, 'ต่อ Google Sheet ไม่ได้ '),
        el('span', {}, Store.lastError),
        el('div', { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' },
          el('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: async () => { await Store.sync(); refreshAll(); }
          }, 'ลองเชื่อมต่อใหม่'),
          el('button', {
            class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: () => showTab('data')
          }, 'ไปหน้าตั้งค่า')),
        el('div', { class: 'card-note', style: 'margin-top:8px' },
          'ระหว่างนี้บันทึกได้ตามปกติ ข้อมูลเก็บในเครื่องไว้ก่อน แล้วกด "ลองเชื่อมต่อใหม่" เพื่อส่งขึ้นชีต'))));
  }

  $('#storageInfo').textContent = (Store.online
    ? `โหมดปัจจุบัน: Google Sheet (มีสำเนาสำรองในเบราว์เซอร์)` +
      (Store.lastSyncAt ? ` · ซิงก์ล่าสุด ${new Date(Store.lastSyncAt).toLocaleTimeString('th-TH')}` : '')
    : 'โหมดปัจจุบัน: เก็บในเบราว์เซอร์เครื่องนี้')
    + ` · เวอร์ชัน ${APP_VERSION}`;
}

function refreshAll() {
  updateConnBadge();
  updateGreeting();
  updateInboxBadge();
  Form.buildTaxonomySelects();
  Form.refreshCampaignList();
  syncCampaignSelects();
  if (!$('#panel-data').hidden) { renderTaxonomyEditor(); renderConnStatusBox(); }
  if (!$('#panel-timeline').hidden) { renderInbox(); renderTimeline(); }
  if (!$('#panel-dashboard').hidden) renderDashboard();
  if (!$('#panel-trend').hidden) renderTrend();
  if (!$('#panel-spend').hidden) renderSpendPage();
  if (!$('#panel-budget').hidden) renderBudgetPage();
  if (!$('#panel-leads').hidden) renderLeadPage();
}

/** ลูกศรขึ้น/ลงเลื่อนเมนูซ้าย — พฤติกรรมมาตรฐานของ role="tablist" */
function initTablistKeys() {
  const tabs = PANELS.map(p => $(`#tab-${p}`));
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('keydown', e => {
      const map = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      let next = null;
      if (map[e.key]) next = (i + map[e.key] + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      showTab(PANELS[next]);
      tabs[next].focus();
    });
  }
}

function initHelp() {
  const dlg = $('#helpModal');
  const open = () => { if (!dlg.open) dlg.showModal(); };
  $('#helpBtn').addEventListener('click', open);
  $('#helpClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  return { open, toggle: () => (dlg.open ? dlg.close() : dlg.showModal()) };
}

function initShortcuts(help) {
  document.addEventListener('keydown', e => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
      || e.target.isContentEditable;

    // Ctrl/Cmd + Enter = บันทึก (ใช้ได้แม้เคอร์เซอร์อยู่ในช่องข้อความ)
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('#panel-new').hidden) {
      e.preventDefault();
      Form.save(e.shiftKey);   // เพิ่ม Shift = บันทึกแล้วจดต่อ
      return;
    }
    if (inField) return;

    // / = กระโดดไปช่องค้นหาในไทม์ไลน์
    if (e.key === '/') {
      e.preventDefault();
      $('#globalSearch')?.focus();
      return;
    }
    // ? = คู่มือปุ่มลัด
    if (e.key === '?') { e.preventDefault(); help.toggle(); return; }
    // n = บันทึกใหม่ · t = สรุปวันนี้
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault(); Form.reset(); showTab('new');
      setTimeout(() => $('#f_campaign')?.focus(), 80);
      return;
    }
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault(); $('#dailyDate').value = todayISO(); showTab('dashboard'); return;
    }
    // ตัวเลข = สลับแท็บ ตามลำดับใน PANELS
    const idx = PANELS.map((_, i) => String(i + 1)).indexOf(e.key);
    if (idx >= 0) { e.preventDefault(); showTab(PANELS[idx]); }
  });
}

function initTheme() {
  const saved = localStorage.getItem('aar.theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('aar.theme', next);
    toast(next === 'dark' ? 'โหมดมืด' : next === 'light' ? 'โหมดสว่าง' : 'ตามระบบ');
    if (!$('#panel-trend').hidden) renderTrend();
  });
}

async function boot() {
  initTheme();
  Taxonomy.loadDefaults();
  Store.loadConfig();
  Store.loadCache();

  for (const p of PANELS) $(`#tab-${p}`).addEventListener('click', () => showTab(p));

  Form.init();
  initTimelineControls();
  initTrendControls();
  initImport();
  initSettings();
  initDailyCard();
  initSpendPage();
  initLeadPage();
  initBudgetPage();
  initSidebar();
  initTablistKeys();
  initShortcuts(initHelp());

  // modal วางตัวเลข
  $('#pasteText').addEventListener('input', previewPaste);
  $('#pasteApply').addEventListener('click', applyPaste);
  $('#pasteCancel').addEventListener('click', () => { $('#pasteModal').close(); pasteTarget = null; });

  $('#refreshBtn').addEventListener('click', async () => {
    const btn = $('#refreshBtn');
    btn.disabled = true;
    btn.classList.add('is-spinning');
    try {
      await Store.sync();
      Form.renderRecentChips();
      refreshAll();
      toast('โหลดข้อมูลใหม่แล้ว');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-spinning');
    }
  });

  $('#dashMode').addEventListener('change', renderDashboard);
  $('#prodMetric').addEventListener('change', renderProductComparison);
  $('#tagMetric').addEventListener('change', renderTagAnalysis);
  $('#roundCampaign').addEventListener('change', () => renderRoundList($('#dashMode').value));
  $('#prodGroupFilter').addEventListener('change', renderProductComparison);
  window.addEventListener('resize', () => {
    if (!$('#panel-dashboard').hidden) renderProductComparison();
  });

  // เปิดหน้าให้ใช้งานได้ทันทีจากข้อมูลที่แคชไว้ ไม่ต้องรอ Google ตอบ
  // (ครั้งแรกของวัน Apps Script อาจ cold start หลายวินาที)
  Form.refreshCampaignList();
  Form.reset();
  refreshAll();

  const hash = location.hash.replace('#', '');
  showTab(PANELS.includes(hash) ? hash : 'new');

  // ดึงข้อมูลจริงตามมาทีหลัง — อัปเดตรายการโดยไม่ล้างสิ่งที่ผู้ใช้กำลังพิมพ์อยู่
  await Store.sync();
  Form.refreshCampaignList();
  Form.buildTaxonomySelects();
  Form.refreshBaseline();
  refreshAll();
}

document.addEventListener('DOMContentLoaded', boot);
