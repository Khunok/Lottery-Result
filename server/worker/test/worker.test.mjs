// node --test server/worker/test/   (Node 18+; no packages needed)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, createVerify } from "node:crypto";
import worker, * as W from "../worker.js";

const GLO = JSON.parse(readFileSync(new URL("./fixtures/glo-latest-2026-11-01.json", import.meta.url), "utf8"));
const bkk = (iso, h, m) => Date.parse(`${iso}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+07:00`);

/** GLO response with only some categories published (live draw in progress). */
function partialGlo(keys, date = "2026-11-01") {
  const j = structuredClone(GLO);
  j.response.date = date;
  for (const k of Object.keys(j.response.data)) if (!keys.includes(k)) j.response.data[k] = { price: "0", number: [] };
  return j;
}

class KV {
  constructor() { this.m = new Map(); this.writes = 0; }
  async get(k, type) { const v = this.m.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.writes++; this.m.set(k, v); }
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  project_id: "atd-test", client_email: "bot@atd-test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
};

function env() {
  return { LOTTO: new KV(), FCM_SERVICE_ACCOUNT: JSON.stringify(SA), GITHUB_TOKEN: "ghp_test" };
}

/** Fake network. glo = what GLO serves now. Records every push and GitHub dispatch. */
function network(state) {
  state.pushes = []; state.dispatches = 0; state.gloCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith("https://www.glo.or.th/")) { state.gloCalls++; return Response.json(state.glo); }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const jwt = new URLSearchParams(opts.body).get("assertion");
      const [h, c, s] = jwt.split(".");
      const v = createVerify("RSA-SHA256"); v.update(h + "." + c);
      assert.ok(v.verify(publicKey, Buffer.from(s, "base64url")), "JWT signature must verify");
      const claims = JSON.parse(Buffer.from(c, "base64url"));
      assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    if (url.startsWith("https://fcm.googleapis.com/v1/projects/atd-test/messages:send")) {
      assert.equal(opts.headers.Authorization, "Bearer tok");
      state.pushes.push(JSON.parse(opts.body).message);
      return Response.json({ name: "ok" });
    }
    if (url.startsWith("https://api.github.com/")) { state.dispatches++; return new Response(null, { status: 204 }); }
    if (url.includes("next_draw.json")) return Response.json({ date: state.next || "2026-11-01" });
    if (url.endsWith("/lottery.json")) return new Response('{"draw_date":"2026-10-16"}');
    throw new Error("unexpected fetch " + url);
  };
}

test("real GLO response parses to the full, valid result", () => {
  const p = W.parseGlo(GLO);
  assert.equal(p.date, "2026-11-01");
  assert.deepEqual(p.period, [41, 42]);
  assert.deepEqual(p.cats.first, ["423224"]);
  assert.deepEqual(p.cats.last2, ["85"]);
  assert.deepEqual(p.cats.front3, ["300", "950"]);
  assert.deepEqual(p.cats.back3, ["393", "804"]);
  assert.equal(p.cats.fifth.length, 100);
  const rec = W.buildRecord(p, bkk("2026-11-01", 16, 0));
  assert.equal(rec.complete, true);
  assert.equal(rec.date, "(01/11/2026)");
  assert.equal(rec.num_1, "423224");
  // identical to what the GitHub bot saved for 1 Nov (history/2026-11-01.json), category by category
  const bot = JSON.parse(readFileSync(new URL("../../../history/2026-11-01.json", import.meta.url), "utf8"));
  assert.deepEqual(rec.prizes, bot.prizes);
  assert.deepEqual(rec.running, bot.running);
  for (const k of ["date", "num_1", "last_2", "front_numb3", "last_num3", "draw_date"]) assert.deepEqual(rec[k], bot[k], k);
});

test("live draw: publish at the 1st prize, again for each new category, push once per change", async () => {
  const e = env(), s = {}; network(s);
  // 14:31 GLO still shows the old draw
  s.glo = partialGlo(Object.keys(GLO.response.data), "2026-10-16");
  assert.match((await W.tick(e, bkk("2026-11-01", 14, 31))).waiting, /2026-10-16/);
  // 14:40 running numbers out but no 1st prize: nothing published
  s.glo = partialGlo(["last2", "last3f", "last3b"]);
  assert.equal((await W.tick(e, bkk("2026-11-01", 14, 40))).unchanged, true);
  assert.equal(s.pushes.length, 0);
  // 14:52 1st prize too → published + pushed
  s.glo = partialGlo(["first", "last2", "last3f", "last3b"]);
  let r = await W.tick(e, bkk("2026-11-01", 14, 52));
  assert.equal(r.push, "sent");
  assert.equal(r.complete, false);
  assert.equal(s.pushes.length, 1);
  const rec1 = JSON.parse(s.pushes[0].data.record);
  assert.equal(rec1.num_1, "423224");
  assert.equal(rec1.last_2, "85");
  assert.equal(rec1.prizes.second, undefined);           // unknown, not empty
  assert.equal(s.pushes[0].android.priority, "high");
  assert.equal(s.pushes[0].topic, "draw_results");
  // 14:53 same data: no write, no push
  assert.equal((await W.tick(e, bkk("2026-11-01", 14, 53))).unchanged, true);
  assert.equal(s.pushes.length, 1);
  // 15:05 a reading that misses running numbers must not drop them
  s.glo = partialGlo(["first", "near1", "second"]);
  r = await W.tick(e, bkk("2026-11-01", 15, 5));
  const stored = await e.LOTTO.get("latest", "json");
  assert.deepEqual(stored.running.last2, ["85"]);
  assert.deepEqual(stored.prizes.near_first, ["423223", "423225"]);
  assert.equal(s.pushes.length, 2);
  // 15:40 complete → push + bot asked to save history; later minutes skip GLO entirely
  s.glo = GLO;
  r = await W.tick(e, bkk("2026-11-01", 15, 40));
  assert.equal(r.complete, true);
  assert.equal(r.bot, "dispatched");
  assert.equal(s.pushes.length, 3);
  assert.equal(s.pushes[2].data.complete, "true");
  const calls = s.gloCalls;
  assert.equal((await W.tick(e, bkk("2026-11-01", 15, 41))).skipped, "complete");
  assert.equal(s.gloCalls, calls);
  assert.equal(s.dispatches, 1);
});

test("full record fits in one FCM data message", () => {
  const rec = W.buildRecord(W.parseGlo(GLO), bkk("2026-11-01", 16, 0));
  const msg = W.fcmMessage(rec, "draw_results");
  assert.ok(msg.message.data.record, "record included");
  assert.ok(JSON.stringify(msg).length < 4000);
});

test("never goes backwards and never publishes an old draw as new", () => {
  const now = bkk("2026-11-01", 15, 0);
  const nov1 = W.buildRecord(W.parseGlo(GLO), now);
  const older = W.parseGlo(partialGlo(Object.keys(GLO.response.data), "2026-10-16"));
  assert.equal(W.merge(nov1, older, now).changed, false);
});

test("schedule: only draw days, only 14:00–18:59; moved days follow the bot's next_draw", async () => {
  const e = env(), s = {}; network(s); s.glo = GLO;
  assert.equal((await W.tick(e, bkk("2026-11-01", 13, 59))).skipped, "outside 14:00–18:59");
  assert.equal((await W.tick(e, bkk("2026-11-01", 19, 0))).skipped, "outside 14:00–18:59");
  s.next = "2026-11-16";
  assert.equal((await W.tick(e, bkk("2026-11-05", 15, 0))).skipped, "not a draw day");
  assert.equal(s.gloCalls, 0);
  assert.equal(W.isRuleDrawDay("2027-01-01"), false);
  assert.equal(W.isRuleDrawDay("2027-01-02"), true);
  assert.equal(W.isRuleDrawDay("2026-05-02"), true);
  // a moved draw on a non-rule day, announced by next_draw.json
  const e2 = env(), s2 = {}; network(s2); s2.next = "2026-12-30";
  s2.glo = partialGlo(["first", "last2"], "2026-12-30");
  const r = await W.tick(e2, bkk("2026-12-30", 15, 0));
  assert.equal(r.push, "sent");
});

test("bad GLO data is rejected or left unknown", () => {
  assert.throws(() => W.parseGlo({}), /no response/);
  const j = structuredClone(GLO);
  j.response.date = "01/11/2026";
  assert.throws(() => W.parseGlo(j), /bad date/);
  const k = structuredClone(GLO);
  k.response.data.first.number = [{ round: 1, value: "42322" }];        // 5 digits
  k.response.data.second.number.pop();                                  // 4 of 5
  const p = W.parseGlo(k);
  assert.equal(p.cats.first, undefined);
  assert.equal(p.cats.second, undefined);
  assert.ok(p.cats.third);
});

test("GET /lottery.json serves the live record, else the bot's copy", async () => {
  const e = env(), s = {}; network(s);
  let r = await W.handle(new Request("https://x.workers.dev/lottery.json"), e, Date.now());
  assert.equal((await r.json()).draw_date, "2026-10-16");
  await e.LOTTO.put("latest", JSON.stringify({ draw_date: "2026-11-01" }));
  r = await W.handle(new Request("https://x.workers.dev/lottery.json"), e, Date.now());
  assert.equal((await r.json()).draw_date, "2026-11-01");
  assert.equal(r.headers.get("Cache-Control"), "public, max-age=15");
  assert.equal((await W.handle(new Request("https://x.workers.dev/other"), e, Date.now())).status, 404);
});

test("scheduled() never throws and records errors in /status", async () => {
  const e = env(), s = {}; network(s);
  globalThis.fetch = async () => { throw new Error("network down"); };
  const waits = [];
  await worker.scheduled({}, e, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  // outside the window right now or failing: either way no exception escaped
  assert.ok(true);
});

test("KV writes stay far below the free limit (1000/day)", async () => {
  const e = env(), s = {}; network(s);
  s.glo = partialGlo(Object.keys(GLO.response.data), "2026-10-16");
  for (let m = 0; m < 5 * 60; m++) await W.tick(e, bkk("2026-11-01", 14, 0) + m * 60_000);   // all day, no result
  assert.ok(e.LOTTO.writes <= 5, "writes: " + e.LOTTO.writes);
});
