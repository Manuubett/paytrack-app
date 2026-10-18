// PAYTRACK BACKEND — Daraja STK Push + Firebase (Firestore)
//
//   npm i express firebase-admin
//   env: FIREBASE_SERVICE_ACCOUNT            (the service account JSON, or the same JSON in base64)
//        DARAJA_CONSUMER_KEY DARAJA_CONSUMER_SECRET DARAJA_SHORTCODE DARAJA_PASSKEY
//        DARAJA_CALLBACK_BASE_URL DARAJA_ENV [DARAJA_TRANSACTION_TYPE] [DARAJA_TILL_NUMBER]
//        [ADMIN_TOKEN] [TRIAL_DAYS] [PORT]
//
// Firestore collections:
//   devices/{deviceId}   one document per phone: trial, paid-until, phone, model, last seen
//   payments/{checkoutId} one document per M-PESA prompt
//   stats/totals         running revenue counter

const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");
const path = require("path");

// Env var names match your existing Render setup (instasend-backend)
const env = process.env;
const IS_PROD = /^(prod|production|live)$/i.test(env.DARAJA_ENV || "");
const BASE = IS_PROD ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

const KEY = env.DARAJA_CONSUMER_KEY;
const SECRET = env.DARAJA_CONSUMER_SECRET;
const SHORTCODE = env.DARAJA_SHORTCODE;        // used for the STK password
const PASSKEY = env.DARAJA_PASSKEY;
const TXN_TYPE = env.DARAJA_TRANSACTION_TYPE || "CustomerPayBillOnline";
// Paybill: money goes to the shortcode. Till (Buy Goods): PartyB is the till number.
const PARTY_B = TXN_TYPE === "CustomerBuyGoodsOnline"
  ? (env.DARAJA_TILL_NUMBER || SHORTCODE)
  : SHORTCODE;
const CALLBACK_URL =
  (env.DARAJA_CALLBACK_BASE_URL || "").replace(/\/+$/, "") + "/api/mpesa/callback";

const missing = ["DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE",
  "DARAJA_PASSKEY", "DARAJA_CALLBACK_BASE_URL", "FIREBASE_SERVICE_ACCOUNT"].filter(k => !env[k]);
if (missing.length) {
  console.error("Missing env vars: " + missing.join(", "));
  process.exit(1);
}
console.log(`Daraja: ${IS_PROD ? "PRODUCTION" : "sandbox"} | ${TXN_TYPE} | callback ${CALLBACK_URL}`);

const PRICE = 50;
const DAY_MS = 864e5;
const PERIOD_DAYS = 30;
const parsedTrial = parseInt(env.TRIAL_DAYS, 10);
// Free trial length in days. Blank or invalid values fall back to 14; 0 turns trials off.
const TRIAL_DAYS = Number.isFinite(parsedTrial) && parsedTrial >= 0 ? parsedTrial : 14;
console.log(`Trial: ${TRIAL_DAYS} day(s)`);

/* ---------- firebase ---------- */

let serviceAccount;
try {
  const raw = env.FIREBASE_SERVICE_ACCOUNT.trim();
  serviceAccount = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
} catch (e) {
  console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 of the JSON).");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const FieldValue = admin.firestore.FieldValue;
console.log(`Firebase project: ${serviceAccount.project_id}`);

const DEV = db.collection("devices");
const PAY = db.collection("payments");
const STATS = db.collection("stats");

/* ---------- helpers ---------- */

const normalizePhone = p =>
  "254" + String(p).replace(/\D/g, "").replace(/^(254|0)/, "");

const timestamp = () =>
  new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const validDeviceId = id => /^[A-Za-z0-9_-]{8,64}$/.test(String(id));
const validCheckoutId = id => /^[A-Za-z0-9_-]{6,100}$/.test(String(id));
const maskPhone = p => String(p).replace(/^(\d{5})\d+(\d{3})$/, "$1****$2");
const fail = (res, e) => { console.error(e && e.message); res.status(500).json({ error: "Server error" }); };

const trialEndsOf = d => (d && d.trialStartedAt ? d.trialStartedAt + TRIAL_DAYS * DAY_MS : 0);

function planOf(d, now) {
  const paidUntil = (d && d.paidUntil) || 0;
  const trialEnds = trialEndsOf(d);
  const expiresAt = Math.max(paidUntil, trialEnds);
  return {
    paidUntil, trialEnds, expiresAt,
    plan: paidUntil > now ? "paid" : trialEnds > now ? "trial" : "expired"
  };
}

// Small in-memory cache so the admin pages don't read Firestore on every refresh
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.clear();
  return value;
}

/* ---------- daraja ---------- */

let tokenCache = { value: null, exp: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(`${KEY}:${SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) {
    throw new Error("Daraja auth failed (HTTP " + r.status + "). Check the consumer key and secret, and that DARAJA_ENV matches them.");
  }
  tokenCache = { value: d.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return d.access_token;
}

// Ask Daraja whether this prompt really succeeded. This is the source of truth:
// the callback and the app's polling only trigger this check, they are never trusted alone.
async function stkQuery(checkoutId) {
  try {
    const ts = timestamp();
    const r = await fetch(`${BASE}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: Buffer.from(SHORTCODE + PASSKEY + ts).toString("base64"),
        Timestamp: ts,
        CheckoutRequestID: checkoutId
      })
    });
    const d = await r.json().catch(() => ({}));
    if (d.ResultCode !== undefined && d.ResultCode !== null) {
      if (String(d.ResultCode) === "0") return { state: "paid" };
      return { state: "failed", reason: d.ResultDesc || ("Code " + d.ResultCode) };
    }
    return { state: "pending" };          // still being processed, or Daraja had a hiccup
  } catch (e) {
    console.error("stkQuery:", e.message);
    return { state: "pending" };
  }
}

/* ---------- payments ---------- */

// Mark paid and extend the subscription, once only (the transaction checks the status)
const creditPayment = (checkoutId, receiptText) => db.runTransaction(async tx => {
  const pRef = PAY.doc(checkoutId);
  const pSnap = await tx.get(pRef);
  if (!pSnap.exists || pSnap.data().status !== "pending") return false;

  const p = pSnap.data();
  const dRef = DEV.doc(p.deviceId);
  const dSnap = await tx.get(dRef);
  const prev = dSnap.exists ? dSnap.data() : {};

  const now = Date.now();
  const trialEnds = trialEndsOf(prev);
  // Paying during a trial adds 30 days after the trial ends (nothing is lost)
  const paidUntil = Math.max(now, prev.paidUntil || 0, trialEnds) + PERIOD_DAYS * DAY_MS;

  tx.update(pRef, { status: "paid", receipt: receiptText || null, amount: PRICE, paidAt: now });
  tx.set(dRef, {
    paidUntil,
    expiresAt: Math.max(paidUntil, trialEnds),
    lastPaidAt: now,
    paidCount: (prev.paidCount || 0) + 1,
    phone: p.phone,
    firstSeen: prev.firstSeen || now,
    lastSeen: prev.lastSeen || now,
    trialStartedAt: prev.trialStartedAt === undefined ? 0 : prev.trialStartedAt
  }, { merge: true });
  tx.set(STATS.doc("totals"), {
    revenue: FieldValue.increment(PRICE),
    count: FieldValue.increment(1)
  }, { merge: true });
  return true;
});

const failPayment = (checkoutId, reason) => db.runTransaction(async tx => {
  const ref = PAY.doc(checkoutId);
  const snap = await tx.get(ref);
  if (snap.exists && snap.data().status === "pending") {
    tx.update(ref, { status: "failed", reason: String(reason || "Payment not completed").slice(0, 200) });
  }
});

const lastQuery = new Map();

// Verify one pending payment with Daraja and settle it. Returns the payment's status.
async function settleCheckout(checkoutId, cb, force) {
  const ref = PAY.doc(checkoutId);
  const snap = await ref.get();
  if (!snap.exists) return "unknown";
  if (snap.data().status !== "pending") return snap.data().status;

  const now = Date.now();
  if (!force && now - (lastQuery.get(checkoutId) || 0) < 8000) return "pending";
  lastQuery.set(checkoutId, now);
  if (lastQuery.size > 2000) lastQuery.clear();

  const v = await stkQuery(checkoutId);

  if (v.state === "paid") {
    // Receipt text from the callback is only a label (never used to decide anything)
    const items = (cb && cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const rec = items.find(i => i.Name === "MpesaReceiptNumber");
    const receipt = rec && /^[A-Z0-9]{8,12}$/.test(String(rec.Value)) ? String(rec.Value) : null;
    await creditPayment(checkoutId, receipt);
    return "paid";
  }
  if (v.state === "failed") {
    await failPayment(checkoutId, v.reason);
    return "failed";
  }
  return "pending";
}

/* ---------- app ---------- */

const app = express();
app.set("trust proxy", 1);   // Render sits behind a proxy; needed for req.ip
app.use(express.json());

// CORS: the Capacitor Android WebView runs at https://localhost, so calls to
// this server are cross-origin and need these headers.
const ALLOWED_ORIGINS = new Set([
  "https://localhost",      // Capacitor Android default (androidScheme: https)
  "http://localhost",
  "capacitor://localhost"
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Abuse guard: max 3 prompts per device in 5 minutes
const payAttempts = new Map();
function tooManyPrompts(deviceId) {
  const now = Date.now();
  if (payAttempts.size > 5000) payAttempts.clear();
  const recent = (payAttempts.get(deviceId) || []).filter(t => now - t < 5 * 60 * 1000);
  const blocked = recent.length >= 3;
  if (!blocked) recent.push(now);
  payAttempts.set(deviceId, recent);
  return blocked;
}

// 1) Start a payment
app.post("/api/pay", async (req, res) => {
  try {
    const { deviceId, phone } = req.body || {};
    if (!validDeviceId(deviceId) || !phone)
      return res.status(400).json({ error: "Missing data" });

    const msisdn = normalizePhone(phone);
    if (!/^254[71]\d{8}$/.test(msisdn))
      return res.status(400).json({ error: "Invalid phone number" });

    if (tooManyPrompts(deviceId))
      return res.status(429).json({ error: "Please wait a few minutes and try again" });

    const ts = timestamp();
    const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: Buffer.from(SHORTCODE + PASSKEY + ts).toString("base64"),
        Timestamp: ts,
        TransactionType: TXN_TYPE,
        Amount: PRICE,
        PartyA: msisdn,
        PartyB: PARTY_B,
        PhoneNumber: msisdn,
        CallBackURL: CALLBACK_URL,
        AccountReference: "PayTrack",
        TransactionDesc: "PayTrack monthly"
      })
    });
    const d = await r.json().catch(() => ({}));
    if (d.ResponseCode !== "0")
      return res.status(400).json({ error: d.errorMessage || d.ResponseDescription || "Request rejected" });

    await PAY.doc(d.CheckoutRequestID).set({
      deviceId, phone: msisdn, status: "pending", reason: null,
      receipt: null, amount: null, createdAt: Date.now()
    });
    res.json({ checkoutId: d.CheckoutRequestID });

  } catch (e) {
    console.error("pay:", e.message);
    res.status(500).json({ error: "Could not start payment" });
  }
});

// 2) Safaricom callback: acknowledge, then verify with Daraja before crediting anything
app.post("/api/mpesa/callback", (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  const cb = req.body && req.body.Body && req.body.Body.stkCallback;
  if (!cb || !validCheckoutId(cb.CheckoutRequestID)) return;

  settleCheckout(String(cb.CheckoutRequestID), cb, true)
    .catch(e => console.error("callback:", e.message));
});

// 3) Poll one payment (also re-checks with Daraja if the callback has not arrived)
app.get("/api/pay/:checkoutId", async (req, res) => {
  try {
    const id = req.params.checkoutId;
    if (!validCheckoutId(id)) return res.json({ status: "unknown", reason: null });

    let snap = await PAY.doc(id).get();
    if (!snap.exists) return res.json({ status: "unknown", reason: null });
    let p = snap.data();

    if (p.status === "pending" && Date.now() - p.createdAt > 15000) {
      const now = await settleCheckout(id).catch(() => "pending");
      if (now !== "pending") p = (await PAY.doc(id).get()).data();
    }
    res.json({ status: p.status, reason: p.reason || null });
  } catch (e) { fail(res, e); }
});

// 4) Is this device allowed in? (starts the free trial the first time it is seen)
app.get("/api/status/:deviceId", async (req, res) => {
  try {
    const id = req.params.deviceId;
    if (!validDeviceId(id)) return res.status(400).json({ error: "Bad device id" });

    const ref = DEV.doc(id);
    const load = () => db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? snap.data() : {};
      if (prev.trialStartedAt !== undefined) return prev;

      const now = Date.now();
      const base = {
        trialStartedAt: TRIAL_DAYS > 0 ? now : 0,
        paidUntil: prev.paidUntil || 0,
        firstSeen: prev.firstSeen || now,
        lastSeen: prev.lastSeen || now
      };
      base.expiresAt = Math.max(base.paidUntil, base.trialStartedAt ? base.trialStartedAt + TRIAL_DAYS * DAY_MS : 0);
      tx.set(ref, base, { merge: true });
      return { ...prev, ...base };
    });

    let d = await load();
    let a = planOf(d, Date.now());

    // Not active: maybe they paid and the callback never arrived. Ask Daraja about pending prompts.
    if (a.plan === "expired") {
      const pend = await PAY.where("deviceId", "==", id).where("status", "==", "pending").limit(3).get();
      if (!pend.empty) {
        await Promise.all(pend.docs.map(x => settleCheckout(x.id).catch(() => "pending")));
        d = (await ref.get()).data() || d;
        a = planOf(d, Date.now());
      }
    }

    res.json({
      active: a.expiresAt > Date.now(),
      expiresAt: a.expiresAt,
      plan: a.plan === "expired" ? "none" : a.plan,
      trialUsed: TRIAL_DAYS > 0
    });
  } catch (e) { fail(res, e); }
});

// 5) The app reports basic device info once a day (model only; no name, IMEI or number)
app.post("/api/device", async (req, res) => {
  try {
    const b = req.body || {};
    if (!validDeviceId(b.deviceId)) return res.status(400).json({ error: "Bad device id" });
    const clip = (v, n) => String(v || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
    const now = Date.now();
    await DEV.doc(b.deviceId).set({
      manufacturer: clip(b.manufacturer, 40),
      model: clip(b.model, 60),
      os: clip(b.os, 40),
      appVersion: clip(b.appVersion, 20),
      lastSeen: now
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

/* ---------- admin ---------- */

const ADMIN_TOKEN = env.ADMIN_TOKEN || "";
const EAT = 3 * 3600 * 1000;                 // Kenya is UTC+3
const authFails = new Map();                 // ip -> { n, reset }

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "Admin is off. Set ADMIN_TOKEN." });
  const f = authFails.get(req.ip);
  if (f && f.n >= 10 && Date.now() < f.reset)
    return res.status(429).json({ error: "Too many attempts. Try again later." });

  const hash = s => crypto.createHash("sha256").update(String(s)).digest();
  if (!crypto.timingSafeEqual(hash(req.get("x-admin-token") || ""), hash(ADMIN_TOKEN))) {
    const cur = f && Date.now() < f.reset ? f : { n: 0, reset: Date.now() + 10 * 60 * 1000 };
    cur.n++;
    authFails.set(req.ip, cur);
    return res.status(401).json({ error: "Wrong token" });
  }
  authFails.delete(req.ip);
  next();
}

const eatDayStart = now => Math.floor((now + EAT) / DAY_MS) * DAY_MS - EAT;
const eatMonthStart = now => {
  const d = new Date(now + EAT);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - EAT;
};
const countOf = async query => (await query.count().get()).data().count;

// Payments from the last ~month, read once and shared by the summary and the list
const recentPayments = () => cached("recentPayments", 2 * 60 * 1000, async () => {
  const now = Date.now();
  const since = Math.min(eatMonthStart(now), eatDayStart(now) - 29 * DAY_MS);
  const snap = await PAY.where("createdAt", ">=", since).orderBy("createdAt", "desc").limit(3000).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
});

app.get("/admin", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/api/admin/summary", adminAuth, async (req, res) => {
  try {
    res.json(await cached("summary", 2 * 60 * 1000, async () => {
      const now = Date.now();
      const dayStart = eatDayStart(now);
      const monthStart = eatMonthStart(now);
      const soon = now + 5 * DAY_MS;
      const pays = await recentPayments();
      const paid = pays.filter(p => p.status === "paid");

      const sum = since => {
        const rows = paid.filter(p => p.createdAt >= since);
        return { amount: rows.reduce((s, p) => s + (p.amount || 0), 0), count: rows.length };
      };

      const totals = (await STATS.doc("totals").get()).data() || {};

      const since30 = dayStart - 29 * DAY_MS;
      const series = [];
      for (let i = 0; i < 30; i++) {
        const t = since30 + i * DAY_MS;
        const rows = paid.filter(p => p.createdAt >= t && p.createdAt < t + DAY_MS);
        series.push({
          day: new Date(t + EAT).toISOString().slice(0, 10),
          amount: rows.reduce((s, p) => s + (p.amount || 0), 0),
          count: rows.length
        });
      }

      const last30 = { paid: 0, failed: 0, pending: 0 };
      pays.filter(p => p.createdAt >= since30).forEach(p => { if (last30[p.status] !== undefined) last30[p.status]++; });

      const expiringSnap = await DEV.where("paidUntil", ">", now).where("paidUntil", "<=", soon)
        .orderBy("paidUntil").limit(10).get();

      return {
        revenue: {
          today: sum(dayStart), week: sum(dayStart - 6 * DAY_MS), month: sum(monthStart),
          all: { amount: totals.revenue || 0, count: totals.count || 0 }
        },
        subscribers: {
          active: await countOf(DEV.where("paidUntil", ">", now)),
          expiringSoon: await countOf(DEV.where("paidUntil", ">", now).where("paidUntil", "<=", soon)),
          lapsed: await countOf(DEV.where("paidUntil", ">", 0).where("paidUntil", "<=", now))
        },
        last30,
        stuckPending: pays.filter(p => p.status === "pending" && p.createdAt < now - 5 * 60 * 1000).length,
        expiring: expiringSnap.docs.map(d => ({
          expiresAt: d.data().paidUntil,
          phone: d.data().phone ? maskPhone(d.data().phone) : null
        })),
        series,
        price: PRICE,
        serverTime: now
      };
    }));
  } catch (e) { fail(res, e); }
});

app.get("/api/admin/payments", adminAuth, async (req, res) => {
  try {
    const st = ["paid", "pending", "failed"].includes(req.query.status) ? req.query.status : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = (await recentPayments()).filter(p => !st || p.status === st).slice(0, limit);
    res.json(rows.map(r => ({
      id: r.id.slice(-8),
      phone: maskPhone(r.phone),
      status: r.status,
      reason: r.reason || null,
      receipt: r.receipt || null,
      amount: r.amount || null,
      at: r.createdAt
    })));
  } catch (e) { fail(res, e); }
});

app.get("/api/admin/devices", adminAuth, async (req, res) => {
  try {
    const full = req.query.full === "1";
    const rawSearch = String(req.query.q || "").trim();
    const search = rawSearch.toLowerCase();
    const digits = search.replace(/\D/g, "").replace(/^0/, "254");
    const phoneSearch = /^[\d\s+]+$/.test(rawSearch) && digits.length >= 9;
    const planFilter = ["paid", "trial", "expired"].includes(req.query.plan) ? req.query.plan : "";

    res.json(await cached(`devices:${planFilter}:${rawSearch}:${full}`, 60 * 1000, async () => {
      const now = Date.now();

      const counts = await cached("deviceCounts", 2 * 60 * 1000, async () => {
        const total = await countOf(DEV);
        const active = await countOf(DEV.where("expiresAt", ">", now));
        const paid = await countOf(DEV.where("paidUntil", ">", now));
        return { total, counts: { paid, trial: Math.max(0, active - paid), expired: Math.max(0, total - active) } };
      });

      let docs;
      if (phoneSearch) {
        docs = (await DEV.where("phone", "==", digits).limit(20).get()).docs;
      } else if (validDeviceId(rawSearch) && (await DEV.doc(rawSearch).get()).exists) {
        docs = [await DEV.doc(rawSearch).get()];
      } else {
        let query;
        if (planFilter === "paid") query = DEV.where("paidUntil", ">", now).orderBy("paidUntil", "desc");
        else if (planFilter === "expired") query = DEV.where("expiresAt", "<=", now).orderBy("expiresAt", "desc");
        else if (planFilter === "trial") query = DEV.where("expiresAt", ">", now).orderBy("expiresAt", "desc");
        else query = DEV.orderBy("lastSeen", "desc");
        docs = (await query.limit(300).get()).docs;
      }

      const cap = w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : "");
      let list = docs.map(snap => {
        const r = snap.data();
        const a = planOf(r, now);
        return {
          plan: a.plan,
          device: [cap(r.manufacturer), r.model].filter(Boolean).join(" "),
          os: r.os || "",
          appVersion: r.appVersion || "",
          phone: r.phone ? (full ? r.phone : maskPhone(r.phone)) : "",
          expiresAt: a.expiresAt,
          daysLeft: Math.max(0, Math.ceil((a.expiresAt - now) / DAY_MS)),
          lastPaid: r.lastPaidAt || 0,
          paidCount: r.paidCount || 0,
          firstSeen: r.firstSeen || r.trialStartedAt || 0,
          lastSeen: r.lastSeen || 0,
          idTail: snap.id.slice(-6),
          _id: snap.id
        };
      });

      if (planFilter) list = list.filter(x => x.plan === planFilter);
      if (search && !phoneSearch) {
        list = list.filter(x => (x.device + " " + x._id).toLowerCase().includes(search));
      }

      return { total: counts.total, counts: counts.counts, devices: list.slice(0, 200).map(({ _id, ...rest }) => rest) };
    }));
  } catch (e) { fail(res, e); }
});

// Re-check every payment that has been pending for over a minute (missed callbacks)
app.post("/api/admin/recheck", adminAuth, async (req, res) => {
  try {
    const snap = await PAY.where("status", "==", "pending").limit(30).get();
    let settled = 0;
    for (const d of snap.docs) {
      if (Date.now() - d.data().createdAt < 60 * 1000) continue;
      const st = await settleCheckout(d.id, null, true).catch(() => "pending");
      if (st !== "pending") settled++;
    }
    cache.clear();
    res.json({ checked: snap.size, settled });
  } catch (e) { fail(res, e); }
});

/* ---------- payment test page + diagnostics ---------- */

app.get("/paytest", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "pay-test.html"));
});

app.get("/api/admin/diagnose", adminAuth, async (req, res) => {
  const keep3 = v => String(v || "").replace(/.(?=.{3})/g, "•");
  const out = {
    mode: IS_PROD ? "PRODUCTION" : "sandbox",
    transactionType: TXN_TYPE,
    shortcode: keep3(SHORTCODE),
    partyB: keep3(PARTY_B),
    callbackUrl: CALLBACK_URL,
    trialDays: TRIAL_DAYS,
    price: PRICE
  };

  // 1) can we read and write Firestore?
  try {
    await STATS.doc("healthcheck").set({ at: Date.now() });
    await STATS.doc("healthcheck").get();
    out.firestore = { ok: true, project: serviceAccount.project_id };
  } catch (e) {
    out.firestore = { ok: false, project: serviceAccount.project_id, error: e.message };
  }

  // 2) can we get a Daraja access token?
  try {
    tokenCache = { value: null, exp: 0 };
    await getToken();
    out.darajaAuth = { ok: true };
  } catch (e) {
    out.darajaAuth = { ok: false, error: e.message };
  }

  // 3) does the public callback URL reach this server?
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: ctl.signal
    });
    clearTimeout(timer);
    const d = await r.json().catch(() => ({}));
    out.callbackReachable = { ok: r.ok && d.ResultCode === 0, status: r.status };
  } catch (e) {
    out.callbackReachable = { ok: false, error: e.name === "AbortError" ? "Timed out" : e.message };
  }

  // 4) the last few payment attempts
  try {
    const snap = await PAY.orderBy("createdAt", "desc").limit(5).get();
    out.recent = snap.docs.map(d => {
      const x = d.data();
      return { status: x.status, reason: x.reason, amount: x.amount, created_at: x.createdAt };
    });
  } catch (e) { out.recent = []; }

  res.json(out);
});

app.listen(process.env.PORT || 3000, () => console.log("PayTrack backend up"));