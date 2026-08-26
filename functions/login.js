/**
 * Ads Adjust Record — เข้าสู่ระบบ / ออกจากระบบ
 * ═══════════════════════════════════════════════
 *
 * ที่อยู่ไฟล์ (ห้ามเปลี่ยน Cloudflare ใช้ชื่อโฟลเดอร์เป็น route)
 *   functions/api/login.js   →  เว็บเรียกที่ /api/login
 *
 *   GET     บอกว่าเว็บนี้ล็อกอยู่ไหม และตอนนี้เข้าระบบแล้วหรือยัง
 *   POST    ส่งรหัสมาตรวจ ถูกแล้วออกคุกกี้ให้
 *   DELETE  ออกจากระบบ (ลบคุกกี้)
 *
 * ตัวแปรที่ต้องตั้งใน Cloudflare
 *   APP_PASSWORD = รหัสสำหรับเข้าเว็บ  ← กด Encrypt ด้วย
 *   ไม่ตั้งตัวนี้ = ไม่ล็อก ใครมีลิงก์ก็เข้าได้ (เหมือนเดิมทุกอย่าง)
 */

import {
  passwordOf, isValidPassword, makeSession, isAuthed,
  sessionCookie, clearCookie, SESSION_MAX_AGE
} from '../_lib/auth.js';

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra
    }
  });
}

/**
 * หน่วงเท่ากันทุกครั้ง ทั้งตอนถูกและตอนผิด
 *
 * สองเหตุผล
 *   1. เดารหัสมั่วทีละครั้งช้าลงมาก — ลองหมื่นครั้งกินเวลาเป็นชั่วโมง
 *   2. ถ้าหน่วงเฉพาะตอนผิด ความเร็วในการตอบจะกลายเป็นตัวบอกเองว่ารหัสถูกหรือไม่
 */
const GUARD_MS = 600;
const guard = () => new Promise(r => setTimeout(r, GUARD_MS));

export async function onRequestGet({ request, env }) {
  const pw = passwordOf(env);
  return json({
    ok: true,
    // ต้องกรอกรหัสไหม — หน้าเว็บใช้ค่านี้ตัดสินว่าจะโชว์หน้าล็อกอินหรือเปล่า
    required: !!pw,
    authed: await isAuthed(request, env)
  });
}

export async function onRequestPost({ request, env }) {
  const pw = passwordOf(env);
  if (!pw) {
    return json({ ok: true, required: false, authed: true });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    await guard();
    return json({ ok: false, error: 'รูปแบบคำขอไม่ถูกต้อง' }, 400);
  }

  await guard();

  if (!isValidPassword(body?.password, pw)) {
    // ไม่บอกว่าผิดตรงไหน ยาวไปสั้นไป หรือใกล้เคียงแค่ไหน
    return json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' }, 401);
  }

  const value = await makeSession(pw);
  return json({ ok: true, authed: true }, 200, {
    'Set-Cookie': sessionCookie(value, SESSION_MAX_AGE)
  });
}

export async function onRequestDelete() {
  return json({ ok: true, authed: false }, 200, { 'Set-Cookie': clearCookie() });
}
