// PAYTRACK BACKEND — Daraja STK Push + SQLite
//
//   npm i express better-sqlite3
//   env: DARAJA_CONSUMER_KEY DARAJA_CONSUMER_SECRET DARAJA_SHORTCODE DARAJA_PASSKEY
//        DARAJA_CALLBACK_BASE_URL DARAJA_ENV [DARAJA_TRANSACTION_TYPE] [DARAJA_TILL_NUMBER]
//        [DB_PATH] [PORT]

const express = require("express");
const Database = require("better-sqlite3");

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
  "DARAJA_PASSKEY", "DARAJA_CALLBACK_BASE_URL"].filter(k => !env[k]);
if (missing.length) {
  console.error("Missing env vars: " + missing.join(", "));
  process.exit(1);
}
console.log(`Daraja: ${IS_PROD ? "PRODUCTION" : "sandbox"} | ${TXN_TYPE} | callback ${CALLBACK_URL}`);
const PRICE = 50;
const DAY_MS = 864e5;
const PERIOD_DAYS = 30;

/* ---------- database ---------- */

const db = new Database(process.env.DB_PATH || "paytrack.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    device_id  TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    checkout_id TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    phone       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed
    reason      TEXT,
    receipt     TEXT UNIQUE,                        -- blocks duplicate credit
    amount      INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_payments_device ON payments(device_id);
`);

const q = {
  insertPayment: db.prepare(
    "INSERT INTO payments (checkout_id, device_id, phone, created_at) VALUES (?,?,?,?)"),
  getPayment: db.prepare("SELECT * FROM payments WHERE checkout_id = ?"),
  failPayment: db.prepare(
    "UPDATE payments SET status='failed', reason=? WHERE checkout_id=? AND status='pending'"),
  paidPayment: db.prepare(
    "UPDATE payments SET status='paid', receipt=?, amount=? WHERE checkout_id=? AND status='pending'"),
  getSub: db.prepare("SELECT expires_at FROM subscriptions WHERE device_id = ?"),
  upsertSub: db.prepare(`
    INSERT INTO subscriptions (device_id, expires_at) VALUES (?, ?)
    ON CONFLICT(device_id) DO UPDATE SET expires_at = excluded.expires_at`),
  recentPending: db.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE device_id=? AND status='pending' AND created_at > ?")
};

// Credit a payment atomically: mark paid + extend expiry (renewals stack)
const creditPayment = db.transaction((checkoutId, deviceId, receipt, amount) => {
  const res = q.paidPayment.run(receipt, amount, checkoutId);
  if (res.changes === 0) return false;                 // duplicate or unknown
  const cur = q.getSub.get(deviceId)?.expires_at || 0;
  q.upsertSub.run(deviceId, Math.max(Date.now(), cur) + PERIOD_DAYS * DAY_MS);
  return true;
});

/* ---------- daraja helpers ---------- */

const normalizePhone = p =>
  "254" + String(p).replace(/\D/g, "").replace(/^(254|0)/, "");

const timestamp = () =>
  new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

let tokenCache = { value: null, exp: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(`${KEY}:${SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } });
  const d = await r.json();
  if (!d.access_token) throw new Error("Daraja auth failed");
  tokenCache = { value: d.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return d.access_token;
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

// 1) Start a payment
app.post("/api/pay", async (req, res) => {
  try {
    const { deviceId, phone } = req.body || {};
    if (!deviceId || !phone || String(deviceId).length > 100)
      return res.status(400).json({ error: "Missing data" });

    const msisdn = normalizePhone(phone);
    if (!/^254[71]\d{8}$/.test(msisdn))
      return res.status(400).json({ error: "Invalid phone number" });

    // Basic abuse guard: max 3 pending prompts per device in 5 minutes
    if (q.recentPending.get(deviceId, Date.now() - 5 * 60 * 1000).n >= 3)
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
    const d = await r.json();
    if (d.ResponseCode !== "0")
      return res.status(400).json({ error: d.errorMessage || d.ResponseDescription || "Request rejected" });

    q.insertPayment.run(d.CheckoutRequestID, deviceId, msisdn, Date.now());
    res.json({ checkoutId: d.CheckoutRequestID });

  } catch (e) {
    console.error("pay:", e.message);
    res.status(500).json({ error: "Could not start payment" });
  }
});

// 2) Safaricom callback
app.post("/api/mpesa/callback", (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });   // ack first

  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return;

    const p = q.getPayment.get(cb.CheckoutRequestID);
    if (!p || p.status !== "pending") return;            // unknown or duplicate

    if (cb.ResultCode !== 0) {
      q.failPayment.run(cb.ResultDesc || "Payment not completed", cb.CheckoutRequestID);
      return;
    }

    const items = Object.fromEntries(
      (cb.CallbackMetadata?.Item || []).map(i => [i.Name, i.Value]));

    if (Number(items.Amount) < PRICE || !items.MpesaReceiptNumber) {
      q.failPayment.run("Amount mismatch", cb.CheckoutRequestID);
      return;
    }

    creditPayment(cb.CheckoutRequestID, p.device_id,
                  String(items.MpesaReceiptNumber), Number(items.Amount));

  } catch (e) {
    console.error("callback:", e.message);
  }
});

// 3) Poll one payment
app.get("/api/pay/:checkoutId", (req, res) => {
  const p = q.getPayment.get(req.params.checkoutId);
  res.json({ status: p?.status || "unknown", reason: p?.reason || null });
});

// 4) Is this device subscribed?
app.get("/api/status/:deviceId", (req, res) => {
  const exp = q.getSub.get(req.params.deviceId)?.expires_at || 0;
  res.json({ active: exp > Date.now(), expiresAt: exp });
});

/* ---------- admin dashboard ---------- */

const crypto = require("crypto");
const path = require("path");
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

const maskPhone = p => String(p).replace(/^(\d{5})\d+(\d{3})$/, "$1****$2");

app.get("/admin", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/api/admin/summary", adminAuth, (req, res) => {
  const now = Date.now();
  const dayStart = Math.floor((now + EAT) / DAY_MS) * DAY_MS - EAT;   // midnight EAT today
  const d = new Date(now + EAT);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - EAT;

  const sum = since => db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM payments WHERE status='paid' AND created_at>=?"
  ).get(since);

  const since30 = dayStart - 29 * DAY_MS;
  const byDay = Object.fromEntries(db.prepare(`
    SELECT CAST((created_at + ?) / 86400000 AS INTEGER) AS d, SUM(amount) AS amount, COUNT(*) AS count
    FROM payments WHERE status='paid' AND created_at>=? GROUP BY d`
  ).all(EAT, since30).map(r => [r.d, r]));

  const series = [];
  for (let i = 0; i < 30; i++) {
    const t = since30 + i * DAY_MS;
    const r = byDay[Math.floor((t + EAT) / DAY_MS)];
    series.push({
      day: new Date(t + EAT).toISOString().slice(0, 10),
      amount: r?.amount || 0,
      count: r?.count || 0
    });
  }

  const status = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM payments WHERE created_at>=? GROUP BY status")
      .all(since30).map(r => [r.status, r.n]));

  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const soon = now + 5 * DAY_MS;

  res.json({
    revenue: { today: sum(dayStart), week: sum(dayStart - 6 * DAY_MS), month: sum(monthStart), all: sum(0) },
    subscribers: {
      active: count("SELECT COUNT(*) AS n FROM subscriptions WHERE expires_at>?", now),
      expiringSoon: count("SELECT COUNT(*) AS n FROM subscriptions WHERE expires_at>? AND expires_at<=?", now, soon),
      lapsed: count("SELECT COUNT(*) AS n FROM subscriptions WHERE expires_at<=?", now)
    },
    last30: { paid: status.paid || 0, failed: status.failed || 0, pending: status.pending || 0 },
    stuckPending: count("SELECT COUNT(*) AS n FROM payments WHERE status='pending' AND created_at<?", now - 5 * 60 * 1000),
    expiring: db.prepare(`
      SELECT s.expires_at AS expiresAt,
        (SELECT phone FROM payments p WHERE p.device_id=s.device_id AND p.status='paid'
         ORDER BY created_at DESC LIMIT 1) AS phone
      FROM subscriptions s WHERE s.expires_at>? AND s.expires_at<=? ORDER BY s.expires_at LIMIT 10`
    ).all(now, soon).map(r => ({ expiresAt: r.expiresAt, phone: r.phone ? maskPhone(r.phone) : null })),
    series,
    price: PRICE,
    serverTime: now
  });
});

app.get("/api/admin/payments", adminAuth, (req, res) => {
  const st = ["paid", "pending", "failed"].includes(req.query.status) ? req.query.status : null;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(`
    SELECT checkout_id, phone, status, reason, receipt, amount, created_at
    FROM payments ${st ? "WHERE status=?" : ""} ORDER BY created_at DESC LIMIT ?`
  ).all(...(st ? [st, limit] : [limit]));
  res.json(rows.map(r => ({
    id: r.checkout_id.slice(-8),
    phone: maskPhone(r.phone),
    status: r.status,
    reason: r.reason,
    receipt: r.receipt,
    amount: r.amount,
    at: r.created_at
  })));
});

app.listen(process.env.PORT || 3000, () => console.log("PayTrack backend up"));