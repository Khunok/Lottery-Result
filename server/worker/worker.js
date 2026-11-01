/**
 * A Thousand Dreams — live Thai Government Lottery results (Cloudflare Worker, no dependencies).
 *
 * Every minute from 14:00 to 18:59 Thailand time on draw days, it reads the official GLO API.
 * As soon as the 1st prize is out it publishes what is available, and again whenever another prize
 * category becomes complete:
 *   - stores the record in KV (served at GET /lottery.json, same format as the GitHub bot's lottery.json)
 *   - sends ONE Firebase data message per change to the topic (default "draw_results"); the app validates
 *     it, shows it at once and posts its own notification (once per draw, only for users who turned it on)
 *   - when the result is complete, asks the GitHub bot to save it to history (optional GITHUB_TOKEN)
 * The GitHub bot stays the record keeper and the backup.
 *
 * Bindings (see SETUP in README.md):
 *   KV namespace  LOTTO
 *   secret        FCM_SERVICE_ACCOUNT  (the Firebase service-account JSON, whole file)
 *   secret        GITHUB_TOKEN         (optional; fine-grained, this repo only, "Actions: read and write")
 *   variable      FCM_TOPIC            (optional; default "draw_results")
 * Cron trigger:   "* 7-11 * * *"        (UTC = 14:00–18:59 Thailand time, every minute)
 */

const GLO_LATEST = "https://www.glo.or.th/api/lottery/getLatestLottery";
const GITHUB_RAW = "https://raw.githubusercontent.com/Khunok/Lottery-Result/main/";
const GITHUB_REPO = "Khunok/Lottery-Result";

// how many numbers each category has, and how many digits
export const SHAPE = {
  first: [1, 6], near_first: [2, 6], second: [5, 6], third: [10, 6], fourth: [50, 6], fifth: [100, 6],
  front3: [2, 3], back3: [2, 3], last2: [1, 2],
};
const GLO_KEY = {
  first: "first", near_first: "near1", second: "second", third: "third", fourth: "fourth", fifth: "fifth",
  front3: "last3f", back3: "last3b", last2: "last2",
};
const PRIZES = ["first", "near_first", "second", "third", "fourth", "fifth"];
const RUNNING = ["front3", "back3", "last2"];
const MOVES = { "01-01": "01-02", "01-16": "01-17", "05-01": "05-02" };

// ---------------------------------------------------------------- dates (Thailand = UTC+7, no DST)

export function bangkokDate(nowMs) {
  return new Date(nowMs + 7 * 3600_000).toISOString().slice(0, 10);
}

export function bangkokMinutes(nowMs) {
  const d = new Date(nowMs + 7 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function isRuleDrawDay(iso) {
  const md = iso.slice(5);
  if (Object.values(MOVES).includes(md)) return true;
  if (MOVES[md]) return false;
  return md.endsWith("-01") || md.endsWith("-16");
}

// ---------------------------------------------------------------- parsing + validation

/** GLO response → { date, period, cats: {category: [numbers]} } with only COMPLETE, valid categories. */
export function parseGlo(json) {
  const r = json && json.response;
  if (!r || typeof r !== "object" || !r.data) throw new Error("GLO: no response.data");
  const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
  if (!date) throw new Error("GLO: bad date");
  const cats = {};
  for (const [cat, [count, digits]] of Object.entries(SHAPE)) {
    const block = r.data[GLO_KEY[cat]];
    const raw = block && Array.isArray(block.number) ? block.number : [];
    // same order as the API (and as the GitHub bot saves it)
    const nums = raw.map((n) => String(n && typeof n === "object" ? n.value : n).trim());
    if (nums.length !== count) continue;                                     // not complete yet
    if (!nums.every((n) => new RegExp(`^\\d{${digits}}$`).test(n))) continue; // bad numbers: leave unknown
    if (digits === 6 && new Set(nums).size !== nums.length) continue;        // duplicate 6-digit prize
    cats[cat] = nums;
  }
  const period = Array.isArray(r.period) ? r.period.filter((p) => Number.isInteger(p)) : [];
  return { date, period, cats };
}

/** Record in the GitHub bot's lottery.json format; only categories that are complete. */
export function buildRecord(parsed, nowMs) {
  const { date, period, cats } = parsed;
  const [y, m, d] = date.split("-");
  const rec = { date: `(${d}/${m}/${y})` };
  if (cats.first) rec.num_1 = cats.first[0];
  if (cats.last2) rec.last_2 = cats.last2[0];
  if (cats.front3) rec.front_numb3 = cats.front3;
  if (cats.back3) rec.last_num3 = cats.back3;
  rec.draw_date = date;
  rec.prizes = {};
  for (const k of PRIZES) if (cats[k]) rec.prizes[k] = cats[k];
  rec.running = {};
  for (const k of RUNNING) if (cats[k]) rec.running[k] = cats[k];
  rec.complete = Object.keys(SHAPE).every((k) => cats[k]);
  if (period.length) rec.period = period;
  rec.source = "glo-live";
  rec.updated_at = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return rec;
}

function catsOf(rec) {
  const out = {};
  for (const k of PRIZES) if (rec.prizes && rec.prizes[k]) out[k] = rec.prizes[k];
  for (const k of RUNNING) if (rec.running && rec.running[k]) out[k] = rec.running[k];
  return out;
}

/**
 * Merge a new reading into the stored record. Never goes backwards: an older draw is ignored, and a
 * category already published for the same draw is never dropped (a later reading that lacks it keeps it).
 * Returns { record, changed, corrected }.
 */
export function merge(stored, fresh, nowMs) {
  if (stored && stored.draw_date && fresh.date < stored.draw_date) return { record: stored, changed: false };
  const same = stored && stored.draw_date === fresh.date;
  const cats = same ? { ...catsOf(stored) } : {};
  let changed = !same, corrected = false;
  for (const [k, v] of Object.entries(fresh.cats)) {
    const old = cats[k];
    if (!old) { cats[k] = v; changed = true; }
    else if (old.join() !== v.join()) { cats[k] = v; changed = true; corrected = true; }   // GLO corrected a number
  }
  if (!cats.first) return { record: stored, changed: false };   // nothing is published before the 1st prize
  const period = fresh.period && fresh.period.length ? fresh.period : (same && stored.period) || [];
  if (!changed) return { record: stored, changed: false };
  return { record: buildRecord({ date: fresh.date, period, cats }, nowMs), changed: true, corrected };
}

// ---------------------------------------------------------------- Firebase Cloud Messaging (HTTP v1)

function pemToPkcs8(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signJwt(sa, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email, sub: sa.client_email, aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging", iat, exp: iat + 3600,
  };
  const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return input + "." + b64url(sig);
}

async function accessToken(env, sa, nowMs) {
  const cached = await env.LOTTO.get("fcm_token", "json");
  if (cached && cached.exp > nowMs + 60_000) return cached.token;
  const jwt = await signJwt(sa, nowMs);
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
  });
  if (!res.ok) throw new Error("FCM token: HTTP " + res.status);
  const j = await res.json();
  await env.LOTTO.put("fcm_token", JSON.stringify({ token: j.access_token, exp: nowMs + (j.expires_in || 3600) * 1000 }),
    { expirationTtl: 3600 });
  return j.access_token;
}

/** One data message to the topic. The app decides what to show; the payload carries the record if it fits. */
export function fcmMessage(record, topic) {
  const json = JSON.stringify(record);
  const data = { type: "result", draw_date: record.draw_date, complete: String(!!record.complete) };
  if (json.length <= 3500) data.record = json;          // FCM data limit is 4 KB; else the app downloads it
  return {
    message: {
      topic,
      data,
      android: { priority: "high", collapse_key: "draw-" + record.draw_date, ttl: "21600s" },
    },
  };
}

async function sendPush(env, record, nowMs) {
  if (!env.FCM_SERVICE_ACCOUNT) return "no FCM secret";
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const token = await accessToken(env, sa, nowMs);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(fcmMessage(record, env.FCM_TOPIC || "draw_results")),
  });
  if (!res.ok) throw new Error("FCM send: HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  return "sent";
}

async function askBotToSave(env) {
  if (!env.GITHUB_TOKEN) return "no GitHub token";
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/update-lottery.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN, Accept: "application/vnd.github+json",
      "User-Agent": "a-thousand-dreams-worker", "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { dry_run: false, watch: true } }),
  });
  return res.ok ? "dispatched" : "GitHub HTTP " + res.status;
}

// ---------------------------------------------------------------- the minute job

async function nextDrawFromBot(env, nowMs) {
  const c = await env.LOTTO.get("next_draw", "json");
  if (c && c.at > nowMs - 3 * 3600_000) return c.date;
  try {
    const r = await fetch(GITHUB_RAW + "next_draw.json?t=" + Math.floor(nowMs / 60_000));
    const date = r.ok ? (await r.json()).date : null;
    const ok = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    await env.LOTTO.put("next_draw", JSON.stringify({ date: ok, at: nowMs }));
    return ok;
  } catch (e) {
    return c ? c.date : null;
  }
}

export async function tick(env, nowMs) {
  const today = bangkokDate(nowMs);
  const mins = bangkokMinutes(nowMs);
  if (mins < 14 * 60 || mins >= 19 * 60) return { skipped: "outside 14:00–18:59" };
  const stored = await env.LOTTO.get("latest", "json");
  if (stored && stored.draw_date === today && stored.complete) return { skipped: "complete" };
  const next = await nextDrawFromBot(env, nowMs);
  if (!(isRuleDrawDay(today) || next === today)) return { skipped: "not a draw day" };

  const res = await fetch(GLO_LATEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "A-Thousand-Dreams/1.0" },
    body: "{}",
  });
  if (!res.ok) throw new Error("GLO HTTP " + res.status);
  const parsed = parseGlo(await res.json());
  if (parsed.date !== today) return { waiting: "GLO still shows " + parsed.date };

  const m = merge(stored, parsed, nowMs);
  if (!m.changed) return { unchanged: true };
  await env.LOTTO.put("latest", JSON.stringify(m.record));
  const out = { saved: Object.keys(catsOf(m.record)).length + " categories", complete: m.record.complete };
  try { out.push = await sendPush(env, m.record, nowMs); } catch (e) { out.push = "failed: " + e.message; }
  if (m.record.complete) {
    try { out.bot = await askBotToSave(env); } catch (e) { out.bot = "failed: " + e.message; }
  }
  return out;
}

// ---------------------------------------------------------------- HTTP

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=15",
};

export async function handle(request, env, nowMs) {
  const url = new URL(request.url);
  if (url.pathname === "/lottery.json") {
    const live = await env.LOTTO.get("latest");
    if (live) return new Response(live, { headers: HEADERS });
    const r = await fetch(GITHUB_RAW + "lottery.json");   // nothing live yet: the bot's copy
    return new Response(await r.text(), { status: r.status, headers: HEADERS });
  }
  if (url.pathname === "/status") {
    const s = (await env.LOTTO.get("status")) || "{}";
    return new Response(s, { headers: { ...HEADERS, "Cache-Control": "no-store" } });
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env) {
    return handle(request, env, Date.now());
  },
  async scheduled(event, env, ctx) {
    const now = Date.now();
    let result;
    try { result = await tick(env, now); } catch (e) { result = { error: String(e.message || e) }; }
    // keep a small status for /status (only when something happened, to save KV writes)
    if (!result.skipped && !result.unchanged) {
      ctx.waitUntil(env.LOTTO.put("status", JSON.stringify({ at: new Date(now).toISOString(), ...result })));
    }
  },
};
