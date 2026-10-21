// PAYTRACK PAYMENTS — one server for many apps (Daraja STK Push + Firebase Firestore)
//
//   npm i express firebase-admin
//   env: FIREBASE_SERVICE_ACCOUNT            (the service account JSON, or the same JSON in base64)
//        DARAJA_CONSUMER_KEY DARAJA_CONSUMER_SECRET DARAJA_SHORTCODE DARAJA_PASSKEY
//        DARAJA_CALLBACK_BASE_URL DARAJA_ENV [DARAJA_TRANSACTION_TYPE] [DARAJA_TILL_NUMBER]
//        [ADMIN_TOKEN] [TRIAL_DAYS] [PORT]
//
// Many apps share this server and one till. Each app has its own price, trial and
// subscription length (edit them in the admin page). An app sends its ID with each
// request (?app=schoolfees); requests without one count as "paytrack".
//
// Firestore collections:
//   apps/{appId}                  config: name, price, periodDays, trialDays, active, revenue counters
//   apps/{appId}/devices/{deviceId}  one document per phone per app: trial, paid-until, phone, model
//   payments/{checkoutId}         one document per M-PESA prompt (includes appId and price)
//   stats/healthcheck             used by the diagnostics only

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

const DAY_MS = 864e5;
const DEFAULT_APP = "paytrack";
const parsedTrial = parseInt(env.TRIAL_DAYS, 10);
// Only used once, to create the first app ("paytrack"). After that, edit trials per app in the admin page.
const TRIAL_DAYS = Number.isFinite(parsedTrial) && parsedTrial >= 0 ? parsedTrial : 14;
console.log(`Default app: ${DEFAULT_APP} (first-time trial ${TRIAL_DAYS} day(s))`);

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

const APPS = db.collection("apps");
const devCol = appId => APPS.doc(appId).collection("devices");
const PAY = db.collection("payments");
const STATS = db.collection("stats");

/* ---------- helpers ---------- */

const normalizePhone = p =>
  "254" + String(p).replace(/\D/g, "").replace(/^(254|0)/, "");

const timestamp = () =>
  new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const validDeviceId = id => /^[A-Za-z0-9_-]{8,64}$/.test(String(id));
const validCheckoutId = id => /^[A-Za-z0-9_-]{6,100}$/.test(String(id));
const validAppId = id => /^[a-z0-9][a-z0-9-]{1,29}$/.test(String(id));
const maskPhone = p => String(p).replace(/^(\d{5})\d+(\d{3})$/, "$1****$2");
const fail = (res, e) => { console.error(e && e.message); res.status(500).json({ error: "Server error" }); };

// A device's access in one app. The trial end is stored when the trial starts,
// so changing an app's trial length later never affects phones already started.
function planOf(d, now) {
  const paidUntil = (d && d.paidUntil) || 0;
  const trialEnds = (d && d.trialEndsAt) || 0;
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
  if (cache.size > 300) cache.clear();
  return value;
}

/* ---------- apps (price, trial and period per app) ---------- */

function normalizeApp(id, d) {
  const trial = Number(d.trialDays);
  return {
    id,
    name: d.name || id,
    price: Number(d.price) || 0,
    periodDays: Number(d.periodDays) || 30,
    trialDays: Number.isFinite(trial) && trial >= 0 ? trial : 0,
    active: d.active !== false
  };
}

const listApps = () => cached("apps", 30 * 1000, async () => {
  const snap = await APPS.get();
  return snap.docs
    .map(d => ({ ...normalizeApp(d.id, d.data()), revenue: d.data().revenue || 0, paidCount: d.data().paidCount || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

async function getApp(appId) {
  return (await listApps()).find(a => a.id === appId) || null;
}

// Which app is this request for? Missing means the original PayTrack app.
async function resolveApp(raw) {
  const id = raw ? String(raw).toLowerCase() : DEFAULT_APP;
  if (!validAppId(id)) return { code: 400, msg: "Bad app id" };
  const cfg = await getApp(id);
  if (!cfg) return { code: 404, msg: "Unknown app" };
  if (!cfg.active) return { code: 403, msg: "This app is switched off" };
  return { cfg };
}

// Create the first app once
(async () => {
  try {
    const snap = await APPS.doc(DEFAULT_APP).get();
    if (!snap.exists) {
      await APPS.doc(DEFAULT_APP).set({
        name: "PayTrack", price: 50, periodDays: 30, trialDays: TRIAL_DAYS,
        active: true, createdAt: Date.now(), revenue: 0, paidCount: 0
      });
      console.log("Created app: paytrack (KSh 50, 30 days)");
    }
  } catch (e) { console.error("Could not create the default app:", e.message); }
})();

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

// Mark paid and extend the subscription, once only (the transaction checks the status).
// The price and period come from the payment record, i.e. what the customer was asked to pay.
const creditPayment = (checkoutId, receiptText) => db.runTransaction(async tx => {
  const pRef = PAY.doc(checkoutId);
  const pSnap = await tx.get(pRef);
  if (!pSnap.exists || pSnap.data().status !== "pending") return false;

  const p = pSnap.data();
  const appId = p.appId || DEFAULT_APP;
  const dRef = devCol(appId).doc(p.deviceId);
  const dSnap = await tx.get(dRef);
  const prev = dSnap.exists ? dSnap.data() : {};

  const now = Date.now();
  const trialEnds = prev.trialEndsAt || 0;
  // Paying during a trial adds the days after the trial ends (nothing is lost)
  const paidUntil = Math.max(now, prev.paidUntil || 0, trialEnds) + (p.periodDays || 30) * DAY_MS;

  tx.update(pRef, { status: "paid", receipt: receiptText || null, amount: p.price, paidAt: now });
  tx.set(dRef, {
    paidUntil,
    expiresAt: Math.max(paidUntil, trialEnds),
    lastPaidAt: now,
    paidCount: (prev.paidCount || 0) + 1,
    phone: p.phone,
    trialStartedAt: prev.trialStartedAt === undefined ? 0 : prev.trialStartedAt,
    trialEndsAt: trialEnds,
    firstSeen: prev.firstSeen || now,
    lastSeen: prev.lastSeen || now
  }, { merge: true });
  tx.set(APPS.doc(appId), {
    revenue: FieldValue.increment(p.price),
    paidCount: FieldValue.increment(1)
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

// Abuse guard: max 3 prompts per device (per app) in 5 minutes
const payAttempts = new Map();
function tooManyPrompts(key) {
  const now = Date.now();
  if (payAttempts.size > 5000) payAttempts.clear();
  const recent = (payAttempts.get(key) || []).filter(t => now - t < 5 * 60 * 1000);
  const blocked = recent.length >= 3;
  if (!blocked) recent.push(now);
  payAttempts.set(key, recent);
  return blocked;
}

// 1) Start a payment (the amount comes from the app's settings, never from the phone)
app.post("/api/pay", async (req, res) => {
  try {
    const { deviceId, phone } = req.body || {};
    if (!validDeviceId(deviceId) || !phone)
      return res.status(400).json({ error: "Missing data" });

    const ra = await resolveApp(req.body.appId);
    if (!ra.cfg) return res.status(ra.code).json({ error: ra.msg });
    const cfg = ra.cfg;

    const msisdn = normalizePhone(phone);
    if (!/^254[71]\d{8}$/.test(msisdn))
      return res.status(400).json({ error: "Invalid phone number" });

    if (tooManyPrompts(cfg.id + ":" + deviceId))
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
        Amount: cfg.price,
        PartyA: msisdn,
        PartyB: PARTY_B,
        PhoneNumber: msisdn,
        CallBackURL: CALLBACK_URL,
        AccountReference: cfg.name.slice(0, 12),     // Daraja allows 12 characters
        TransactionDesc: "Subscription"              // and 13 here
      })
    });
    const d = await r.json().catch(() => ({}));
    if (d.ResponseCode !== "0")
      return res.status(400).json({ error: d.errorMessage || d.ResponseDescription || "Request rejected" });

    await PAY.doc(d.CheckoutRequestID).set({
      appId: cfg.id, deviceId, phone: msisdn,
      price: cfg.price, periodDays: cfg.periodDays,
      status: "pending", reason: null, receipt: null, amount: null,
      createdAt: Date.now()
    });
    res.json({ checkoutId: d.CheckoutRequestID, amount: cfg.price });

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

    const snap = await PAY.doc(id).get();
    if (!snap.exists) return res.json({ status: "unknown", reason: null });
    let p = snap.data();

    if (p.status === "pending" && Date.now() - p.createdAt > 15000) {
      const now = await settleCheckout(id).catch(() => "pending");
      if (now !== "pending") p = (await PAY.doc(id).get()).data();
    }
    res.json({ status: p.status, reason: p.reason || null });
  } catch (e) { fail(res, e); }
});

// 4) Is this device allowed in this app? (starts that app's free trial the first time)
app.get("/api/status/:deviceId", async (req, res) => {
  try {
    const id = req.params.deviceId;
    if (!validDeviceId(id)) return res.status(400).json({ error: "Bad device id" });

    const ra = await resolveApp(req.query.app);
    if (!ra.cfg) return res.status(ra.code).json({ error: ra.msg });
    const cfg = ra.cfg;

    const ref = devCol(cfg.id).doc(id);
    const load = () => db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? snap.data() : {};
      if (prev.trialStartedAt !== undefined) return prev;

      const now = Date.now();
      const base = {
        trialStartedAt: cfg.trialDays > 0 ? now : 0,
        trialEndsAt: cfg.trialDays > 0 ? now + cfg.trialDays * DAY_MS : 0,
        paidUntil: prev.paidUntil || 0,
        firstSeen: prev.firstSeen || now,
        lastSeen: prev.lastSeen || now
      };
      base.expiresAt = Math.max(base.paidUntil, base.trialEndsAt);
      tx.set(ref, base, { merge: true });
      return { ...prev, ...base };
    });

    let d = await load();
    let a = planOf(d, Date.now());

    // Not active: maybe they paid and the callback never arrived. Ask Daraja about pending prompts.
    if (a.plan === "expired") {
      const pend = await PAY.where("deviceId", "==", id).where("appId", "==", cfg.id)
        .where("status", "==", "pending").limit(3).get();
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
      trialUsed: cfg.trialDays > 0,
      app: cfg.id,
      appName: cfg.name,
      price: cfg.price,
      periodDays: cfg.periodDays
    });
  } catch (e) { fail(res, e); }
});

// 5) The app reports basic device info once a day (model only; no name, IMEI or number)
app.post("/api/device", async (req, res) => {
  try {
    const b = req.body || {};
    if (!validDeviceId(b.deviceId)) return res.status(400).json({ error: "Bad device id" });
    const ra = await resolveApp(b.appId);
    if (!ra.cfg) return res.status(ra.code).json({ error: ra.msg });

    const clip = (v, n) => String(v || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
    await devCol(ra.cfg.id).doc(b.deviceId).set({
      manufacturer: clip(b.manufacturer, 40),
      model: clip(b.model, 60),
      os: clip(b.os, 40),
      appVersion: clip(b.appVersion, 20),
      lastSeen: Date.now()
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
const sumOf = list => list.reduce((s, n) => s + n, 0);

// Which apps does the admin want to see? "" or "all" means every app.
async function selectedApps(filter) {
  const all = await listApps();
  return filter && filter !== "all" ? all.filter(a => a.id === filter) : all;
}

// Payments from the last ~month, read once and shared by the summary and the list
const recentPayments = () => cached("recentPayments", 2 * 60 * 1000, async () => {
  const now = Date.now();
  const since = Math.min(eatMonthStart(now), eatDayStart(now) - 29 * DAY_MS);
  const snap = await PAY.where("createdAt", ">=", since).orderBy("createdAt", "desc").limit(3000).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data(), appId: d.data().appId || DEFAULT_APP }));
});

app.get("/admin", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin.html"));
});

// The list of apps, with prices and all-time revenue
app.get("/api/admin/apps", adminAuth, async (req, res) => {
  try { res.json(await listApps()); } catch (e) { fail(res, e); }
});

// Add a new app or change an existing one (counters are never overwritten)
app.post("/api/admin/apps", adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || "").trim().toLowerCase();
    const name = String(b.name || "").replace(/[\u0000-\u001f<>]/g, "").trim();
    const price = Number(b.price), periodDays = Number(b.periodDays), trialDays = Number(b.trialDays);

    if (!validAppId(id)) return res.status(400).json({ error: "App ID: 2 to 30 letters, numbers or dashes" });
    if (!name || name.length > 40) return res.status(400).json({ error: "Give the app a name (up to 40 characters)" });
    if (!Number.isInteger(price) || price < 1 || price > 250000) return res.status(400).json({ error: "Price must be a whole number from 1 to 250000" });
    if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 366) return res.status(400).json({ error: "Days per payment: 1 to 366" });
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) return res.status(400).json({ error: "Free trial: 0 to 365 days" });

    const ref = APPS.doc(id);
    const exists = (await ref.get()).exists;
    const data = { name, price, periodDays, trialDays, active: b.active !== false };
    if (!exists) Object.assign(data, { createdAt: Date.now(), revenue: 0, paidCount: 0 });
    await ref.set(data, { merge: true });

    cache.clear();
    res.json({ ok: true, created: !exists });
  } catch (e) { fail(res, e); }
});

app.get("/api/admin/summary", adminAuth, async (req, res) => {
  try {
    const filter = String(req.query.app || "");
    res.json(await cached("summary:" + filter, 2 * 60 * 1000, async () => {
      const now = Date.now();
      const dayStart = eatDayStart(now);
      const monthStart = eatMonthStart(now);
      const soon = now + 5 * DAY_MS;

      const sel = await selectedApps(filter);
      const ids = new Set(sel.map(a => a.id));
      const pays = (await recentPayments()).filter(p => ids.has(p.appId));
      const paid = pays.filter(p => p.status === "paid");

      const sum = since => {
        const rows = paid.filter(p => p.createdAt >= since);
        return { amount: sumOf(rows.map(p => p.amount || 0)), count: rows.length };
      };

      const since30 = dayStart - 29 * DAY_MS;
      const series = [];
      for (let i = 0; i < 30; i++) {
        const t = since30 + i * DAY_MS;
        const rows = paid.filter(p => p.createdAt >= t && p.createdAt < t + DAY_MS);
        series.push({
          day: new Date(t + EAT).toISOString().slice(0, 10),
          amount: sumOf(rows.map(p => p.amount || 0)),
          count: rows.length
        });
      }

      const last30 = { paid: 0, failed: 0, pending: 0 };
      pays.filter(p => p.createdAt >= since30).forEach(p => { if (last30[p.status] !== undefined) last30[p.status]++; });

      const expiringLists = await Promise.all(sel.map(async a => {
        const snap = await devCol(a.id).where("paidUntil", ">", now).where("paidUntil", "<=", soon)
          .orderBy("paidUntil").limit(10).get();
        return snap.docs.map(d => ({
          expiresAt: d.data().paidUntil,
          phone: d.data().phone ? maskPhone(d.data().phone) : null,
          app: a.name
        }));
      }));

      const counts = await Promise.all(sel.map(async a => ({
        active: await countOf(devCol(a.id).where("paidUntil", ">", now)),
        soon: await countOf(devCol(a.id).where("paidUntil", ">", now).where("paidUntil", "<=", soon)),
        lapsed: await countOf(devCol(a.id).where("paidUntil", ">", 0).where("paidUntil", "<=", now))
      })));

      return {
        revenue: {
          today: sum(dayStart), week: sum(dayStart - 6 * DAY_MS), month: sum(monthStart),
          all: { amount: sumOf(sel.map(a => a.revenue)), count: sumOf(sel.map(a => a.paidCount)) }
        },
        subscribers: {
          active: sumOf(counts.map(c => c.active)),
          expiringSoon: sumOf(counts.map(c => c.soon)),
          lapsed: sumOf(counts.map(c => c.lapsed))
        },
        last30,
        stuckPending: pays.filter(p => p.status === "pending" && p.createdAt < now - 5 * 60 * 1000).length,
        expiring: expiringLists.flat().sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 10),
        series,
        serverTime: now
      };
    }));
  } catch (e) { fail(res, e); }
});

app.get("/api/admin/payments", adminAuth, async (req, res) => {
  try {
    const st = ["paid", "pending", "failed"].includes(req.query.status) ? req.query.status : null;
    const filter = String(req.query.app || "");
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = (await recentPayments())
      .filter(p => (!st || p.status === st) && (!filter || filter === "all" || p.appId === filter))
      .slice(0, limit);
    res.json(rows.map(r => ({
      id: r.id.slice(-8),
      app: r.appId,
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
    const filter = String(req.query.app || "");
    const rawSearch = String(req.query.q || "").trim();
    const search = rawSearch.toLowerCase();
    const digits = search.replace(/\D/g, "").replace(/^0/, "254");
    const phoneSearch = /^[\d\s+]+$/.test(rawSearch) && digits.length >= 9;
    const planFilter = ["paid", "trial", "expired"].includes(req.query.plan) ? req.query.plan : "";

    res.json(await cached(`devices:${filter}:${planFilter}:${rawSearch}:${full}`, 60 * 1000, async () => {
      const now = Date.now();
      const sel = await selectedApps(filter);

      const totals = await cached("deviceCounts:" + filter, 2 * 60 * 1000, async () => {
        const per = await Promise.all(sel.map(async a => {
          const total = await countOf(devCol(a.id));
          const active = await countOf(devCol(a.id).where("expiresAt", ">", now));
          const paid = await countOf(devCol(a.id).where("paidUntil", ">", now));
          return { total, active, paid };
        }));
        const total = sumOf(per.map(x => x.total)), active = sumOf(per.map(x => x.active)), paid = sumOf(per.map(x => x.paid));
        return { total, counts: { paid, trial: Math.max(0, active - paid), expired: Math.max(0, total - active) } };
      });

      const perApp = sel.length > 1 ? 100 : 300;
      const lists = await Promise.all(sel.map(async a => {
        const col = devCol(a.id);
        let docs;
        if (phoneSearch) {
          docs = (await col.where("phone", "==", digits).limit(20).get()).docs;
        } else {
          let one = null;
          if (validDeviceId(rawSearch)) { const s = await col.doc(rawSearch).get(); if (s.exists) one = [s]; }
          if (one) docs = one;
          else {
            let q;
            if (planFilter === "paid") q = col.where("paidUntil", ">", now).orderBy("paidUntil", "desc");
            else if (planFilter === "expired") q = col.where("expiresAt", "<=", now).orderBy("expiresAt", "desc");
            else if (planFilter === "trial") q = col.where("expiresAt", ">", now).orderBy("expiresAt", "desc");
            else q = col.orderBy("lastSeen", "desc");
            docs = (await q.limit(perApp).get()).docs;
          }
        }
        return docs.map(snap => ({ snap, app: a }));
      }));

      const cap = w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : "");
      let list = lists.flat().map(({ snap, app: a }) => {
        const r = snap.data();
        const p = planOf(r, now);
        return {
          plan: p.plan,
          app: a.name,
          device: [cap(r.manufacturer), r.model].filter(Boolean).join(" "),
          os: r.os || "",
          appVersion: r.appVersion || "",
          phone: r.phone ? (full ? r.phone : maskPhone(r.phone)) : "",
          expiresAt: p.expiresAt,
          daysLeft: Math.max(0, Math.ceil((p.expiresAt - now) / DAY_MS)),
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
      list.sort((a, b) => b.lastSeen - a.lastSeen);

      return { total: totals.total, counts: totals.counts, devices: list.slice(0, 200).map(({ _id, ...rest }) => rest) };
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
    callbackUrl: CALLBACK_URL
  };

  // 1) can we read and write Firestore?
  try {
    await STATS.doc("healthcheck").set({ at: Date.now() });
    await STATS.doc("healthcheck").get();
    out.firestore = { ok: true, project: serviceAccount.project_id };
  } catch (e) {
    out.firestore = { ok: false, project: serviceAccount.project_id, error: e.message };
  }

  // 2) the apps this server knows about
  try {
    cache.delete("apps");
    out.apps = (await listApps()).map(a => ({
      id: a.id, name: a.name, price: a.price, trialDays: a.trialDays, periodDays: a.periodDays, active: a.active
    }));
  } catch (e) { out.apps = []; }

  // 3) can we get a Daraja access token?
  try {
    tokenCache = { value: null, exp: 0 };
    await getToken();
    out.darajaAuth = { ok: true };
  } catch (e) {
    out.darajaAuth = { ok: false, error: e.message };
  }

  // 4) does the public callback URL reach this server?
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

  // 5) the last few payment attempts
  try {
    const snap = await PAY.orderBy("createdAt", "desc").limit(5).get();
    out.recent = snap.docs.map(d => {
      const x = d.data();
      return { app: x.appId || DEFAULT_APP, status: x.status, reason: x.reason, amount: x.amount, created_at: x.createdAt };
    });
  } catch (e) { out.recent = []; }

  res.json(out);
});

app.listen(process.env.PORT || 3000, () => console.log("PayTrack backend up"));
