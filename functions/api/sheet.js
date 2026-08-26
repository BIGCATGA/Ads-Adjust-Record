/**
 * Ads Adjust Record — ตัวกลางฝั่งเซิร์ฟเวอร์ (Cloudflare Pages Function)
 * ═══════════════════════════════════════════════════════════════════
 *
 * ทำไมต้องมีไฟล์นี้
 *   เว็บ static ล้วน ๆ เก็บความลับไม่ได้ — อะไรที่เบราว์เซอร์ใช้ยิง API
 *   คนเปิดเว็บย่อมอ่านได้หมด ไฟล์นี้จึงรับคำขอจากเบราว์เซอร์ก่อน
 *   แล้วค่อยเติม token ฝั่งเซิร์ฟเวอร์ส่งต่อไป Apps Script
 *   → token ไม่เคยเดินทางมาถึงเบราว์เซอร์เลย เปิด DevTools ก็ไม่เห็น
 *
 * ที่อยู่ไฟล์ (ห้ามเปลี่ยน Cloudflare ใช้ชื่อโฟลเดอร์เป็น route)
 *   functions/api/sheet.js   →  เว็บเรียกที่ /api/sheet
 *
 * ตัวแปรที่ต้องตั้งใน Cloudflare
 *   Settings → Environment variables → Add
 *     SHEET_URL   = URL ที่ลงท้ายด้วย /exec ของ Apps Script
 *     API_TOKEN   = รหัสเดียวกับใน Code.gs   ← กด Encrypt ด้วย
 *
 * หมายเหตุสำคัญ
 *   ไฟล์นี้ซ่อน token ได้ แต่ "ไม่ได้" กันคนนอกใช้เว็บ
 *   ใครเข้าเว็บได้ก็ยิงผ่านตัวกลางนี้ได้ ถ้าต้องการกันคนนอกจริง ๆ
 *   ต้องเปิด Cloudflare Access (Zero Trust) ครอบหน้าเว็บอีกชั้น — ฟรีถึง 50 คน
 */

const ALLOWED_ACTIONS = new Set([
  'list', 'metrics', 'leads', 'ping',
  'create', 'update', 'delete', 'bulkCreate',
  'saveProducts', 'saveCampaign', 'upsertMetrics', 'upsertLeads'
]);

/** ตอบกลับเป็น JSON พร้อมกันไม่ให้ CDN เก็บแคชข้อมูลของบัญชีไว้ */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

/**
 * ตัดช่องว่าง/บรรทัดใหม่ที่ติดมาตอน copy-paste ออก
 *
 * ฝั่ง Apps Script trim ให้อยู่แล้ว ถ้าฝั่งนี้ไม่ trim ด้วย
 * ช่องว่างท้ายค่าตัวเดียวจะทำให้รหัส "ไม่ตรงกัน" ทั้งที่ตาดูเหมือนกันเป๊ะ
 * — หาสาเหตุยากมากเพราะมองไม่เห็น
 */
const clean = v => String(v ?? '').trim();

export async function onRequestPost({ request, env }) {
  const sheetUrl = clean(env.SHEET_URL);
  const token = clean(env.API_TOKEN);

  if (!sheetUrl || !token) {
    return json({
      ok: false,
      error: 'ยังไม่ได้ตั้ง SHEET_URL หรือ API_TOKEN ใน Cloudflare — ' +
             'ไปที่ Settings → Environment variables แล้วเพิ่มทั้งสองตัว'
    }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'รูปแบบคำขอไม่ถูกต้อง (ไม่ใช่ JSON)' }, 400);
  }

  const action = String(payload?.action || '');
  if (!ALLOWED_ACTIONS.has(action)) {
    // กันไม่ให้ยิง action แปลก ๆ ทะลุไปถึง Apps Script
    return json({ ok: false, error: `ไม่รู้จักคำสั่ง "${action}"` }, 400);
  }

  // token ใส่ตรงนี้ ฝั่งเซิร์ฟเวอร์ — ที่เบราว์เซอร์ส่งมาถูกทิ้งเสมอ
  const { token: _ignored, ...rest } = payload;
  const body = JSON.stringify({ ...rest, action, token });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const res = await fetch(sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
      signal: ctrl.signal
    });

    const text = await res.text();
    if (!res.ok) {
      return json({ ok: false, error: `Apps Script ตอบรหัส HTTP ${res.status}` }, 502);
    }
    // ส่งต่อตามที่ Apps Script ตอบมา แต่บังคับ header ของเราเอง
    try {
      return json(JSON.parse(text));
    } catch {
      // ปกติเจอตอนที่ deployment ตั้งสิทธิ์ผิด แล้ว Google เด้งหน้า login มาแทน
      return json({
        ok: false,
        error: 'Apps Script ตอบกลับมาไม่ใช่ JSON — ตรวจว่า Deploy เป็น ' +
               'Execute as: Me และ Who has access: Anyone'
      }, 502);
    }
  } catch (err) {
    const msg = err?.name === 'AbortError'
      ? 'Apps Script ไม่ตอบภายใน 55 วินาที'
      : 'ต่อไป Apps Script ไม่ได้';
    return json({ ok: false, error: msg }, 504);
  } finally {
    clearTimeout(timer);
  }
}

/** GET ไว้เช็กว่าตัวกลางติดตั้งแล้วจริง — ไม่แตะชีต ไม่เปิดเผยอะไร */
export async function onRequestGet({ env }) {
  const url = clean(env.SHEET_URL);
  const token = clean(env.API_TOKEN);
  return json({
    ok: true,
    proxy: 'ads-adjust-record',
    configured: !!(url && token),
    // ช่วยไล่หาปัญหา "รหัสไม่ตรง" โดยไม่เปิดเผยตัวรหัส
    // ยาวกี่ตัว + ขึ้นต้นและลงท้ายด้วยอะไร พอให้เทียบกับที่ตั้งในชีตได้ด้วยตาเปล่า
    tokenLength: token.length,
    tokenHint: token.length >= 4 ? token.slice(0, 2) + '…' + token.slice(-2) : ''
  });
}
