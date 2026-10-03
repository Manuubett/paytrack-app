// PAYTRACK BACKEND — Daraja STK Push + SQLite
//
//   npm i express better-sqlite3
//   env: KEY SECRET SHORTCODE PASSKEY CALLBACK_URL [DARAJA_BASE] [DB_PATH] [PORT]
//   (production: DARAJA_BASE=https://api.safaricom.co.ke)

const express = require("express");
const Database = require("better-sqlite3");

const BASE = process.env.DARAJA_BASE || "https://sandbox.safaricom.co.ke";
const { KEY, SECRET, SHORTCODE, PASSKEY, CALLBACK_URL } = process.env;
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
app.use(express.json());

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
        TransactionType: "CustomerPayBillOnline", // "CustomerBuyGoodsOnline" for a Till
        Amount: PRICE,
        PartyA: msisdn,
        PartyB: SHORTCODE,
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

app.listen(process.env.PORT || 3000, () => console.log("PayTrack backend up"));