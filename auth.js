/**
 * Ads Adjust Record — ตัวตรวจรหัสผ่านฝั่งเซิร์ฟเวอร์
 * ═══════════════════════════════════════════════════
 *
 * ทำไมต้องตรวจฝั่งเซิร์ฟเวอร์
 *   ถ้าเช็กรหัสด้วย JavaScript ในเบราว์เซอร์ ใครก็เปิด DevTools แล้วข้ามได้ใน 10 วินาที
 *   หน้าจอกรอกรหัสแบบนั้น "ดูเหมือนล็อก" แต่ไม่ได้ล็อกอะไรเลย
 *   ไฟล์นี้จึงตรวจที่เซิร์ฟเวอร์: ไม่ผ่าน = /api/sheet ไม่ยอมคุยด้วยตั้งแต่แรก
 *   ต่อให้แก้โค้ดหน้าเว็บยังไงก็ไม่ได้ข้อมูล เพราะข้อมูลไม่เคยถูกส่งมา
 *
 * เก็บสถานะล็อกอินยังไง
 *   คุกกี้ที่ "เซ็นชื่อ" ไว้ — ข้างในมีแค่วันหมดอายุ ไม่มีรหัสผ่าน
 *   ลายเซ็นคำนวณจากรหัสผ่าน ปลอมไม่ได้ถ้าไม่รู้รหัส
 *   ผลพลอยได้ที่ดี: เปลี่ยนรหัสเมื่อไหร่ คุกกี้เก่าใช้ไม่ได้ทันทีทุกเครื่อง
 *
 * ตัวแปรที่ต้องตั้งใน Cloudflare
 *   APP_PASSWORD  รหัสสำหรับเข้าเว็บ  ← กด Encrypt
 *                 ไม่ตั้ง = ไม่ล็อก (ใช้งานเหมือนเดิมทุกอย่าง)
 */

export const COOKIE_NAME = 'aar_session';

/** คุกกี้อยู่ได้กี่วันก่อนต้องกรอกใหม่ */
const SESSION_DAYS = 30;

const enc = new TextEncoder();

const clean = v => String(v ?? '').trim();

/** เว็บนี้เปิดระบบล็อกไว้หรือเปล่า */
export function passwordOf(env) {
  return clean(env.APP_PASSWORD);
}

/**
 * เทียบสองสตริงแบบใช้เวลาเท่ากันเสมอ
 *
 * ถ้าใช้ === ธรรมดา JavaScript จะหยุดเทียบทันทีที่เจอตัวอักษรต่างกัน
 * เวลาที่ใช้จึงบอกใบ้ได้ว่า "เดาถูกกี่ตัวแรก" — เดารหัสทีละตัวได้เลย
 * ตัวนี้ไล่ครบทุกตัวเสมอ ไม่ว่าจะต่างตั้งแต่ตัวแรกหรือตัวสุดท้าย
 */
function safeEqual(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  // ความยาวต่างกันก็ยังต้องวนให้ครบ ไม่งั้นความยาวรั่วออกไปทางเวลาแทน
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** สร้างค่าคุกกี้: "วันหมดอายุ.ลายเซ็น" */
export async function makeSession(password) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  return `${exp}.${await hmac(password, String(exp))}`;
}

/** คุกกี้นี้ของจริงและยังไม่หมดอายุไหม */
export async function validSession(value, password) {
  const raw = clean(value);
  const dot = raw.indexOf('.');
  if (dot < 1) return false;
  const exp = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(password, exp));
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/**
 * HttpOnly  = JavaScript อ่านไม่ได้ สคริปต์แปลกปลอมขโมยไปไม่ได้
 * Secure    = ส่งเฉพาะ https
 * SameSite  = เว็บอื่นยิงข้ามมาแอบใช้สิทธิ์เราไม่ได้
 */
export function sessionCookie(value, maxAgeSec) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearCookie() {
  return sessionCookie('', 0);
}

/**
 * คำขอนี้ผ่านด่านหรือยัง
 * ไม่ได้ตั้ง APP_PASSWORD → ผ่านหมด (ระบบล็อกปิดอยู่)
 */
export async function isAuthed(request, env) {
  const pw = passwordOf(env);
  if (!pw) return true;
  return validSession(readCookie(request, COOKIE_NAME), pw);
}

export function isValidPassword(input, expected) {
  return safeEqual(clean(input), expected);
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;
