/*
    PAYTRACK — SUBSCRIPTION (KSh 50 / month via M-PESA STK Push)

    The server decides who is paid up. The app only asks it and shows the
    paywall. The last known expiry is cached so a short offline spell
    doesn't lock a paying user out.
*/

const API = "https://paytrack-app.onrender.com";   // must be HTTPS
const SUB_CACHE_KEY = "paytrack_sub_expiry";
const OFFLINE_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

let paywallBusy = false;

let DEVICE_ID = null;

// On the phone this is Android's per-device ID (Capacitor Device plugin). It survives
// uninstall and reinstall, so a reinstall does not give a new free trial.
// In a normal browser (testing) it falls back to a random ID saved in localStorage.
async function ensureDeviceId() {
    if (DEVICE_ID) return DEVICE_ID;
    try {
        const Device = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Device;
        if (Device) {
            const info = await Device.getId();
            const id = info && (info.identifier || info.uuid);
            if (id) return (DEVICE_ID = String(id));
        }
    } catch (e) {}

    let id = localStorage.getItem("paytrack_device_id");
    if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) ||
             String(Date.now()) + Math.random().toString(16).slice(2);
        localStorage.setItem("paytrack_device_id", id);
    }
    return (DEVICE_ID = id);
}

/* ---------- paywall UI ---------- */

function paywallStatus(msg, type) {
    const el = document.getElementById("paywallStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "paywall-status" + (type ? " " + type : "");
}

function openPaywall(info) {
    const el = document.getElementById("paywall");
    if (!el) return;
    if (info) document.getElementById("paywallInfo").textContent = info;
    el.classList.add("show");
}

function closePaywall() {
    const el = document.getElementById("paywall");
    if (el) el.classList.remove("show");
    paywallStatus("");
}

/* ---------- server calls ---------- */

async function fetchSubscription() {
    const r = await fetch(API + "/api/status/" + encodeURIComponent(await ensureDeviceId()));
    if (!r.ok) throw new Error("Status check failed");
    return r.json();   // { active, expiresAt }
}

function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function startPayment(phone) {
    const r = await fetch(API + "/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: await ensureDeviceId(), phone })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Could not start payment");
    return d.checkoutId;
}

async function waitForPayment(checkoutId) {
    for (let i = 0; i < 30; i++) {            // ~60 seconds
        await wait(2000);
        const r = await fetch(API + "/api/pay/" + encodeURIComponent(checkoutId));
        const s = await r.json();
        if (s.status === "paid") return;
        if (s.status === "failed") throw new Error(s.reason || "Payment was not completed");
    }
    throw new Error("Timed out. If money was deducted, tap “Check again”.");
}

/* ---------- gate ---------- */

function showSubStatus(s) {
    const el = document.getElementById("subStatus");
    if (!el) return;
    const exp = s && s.expiresAt;
    if (!exp || exp < Date.now() || !s.active) { el.textContent = ""; return; }

    const days = Math.ceil((exp - Date.now()) / 864e5);
    const left = days + " day" + (days === 1 ? "" : "s") + " left";
    const until = new Date(exp).toLocaleDateString("en-KE", {
        day: "numeric", month: "short", year: "numeric"
    });
    const isTrial = s.plan === "trial";
    el.innerHTML = (isTrial ? "Free trial: " + left : "Subscribed until " + until + " (" + left + ")") +
        (isTrial || days <= 5 ? " · <a href='#' id='subRenew'>" + (isTrial ? "Subscribe" : "Renew") + "</a>" : "");

    const link = document.getElementById("subRenew");
    if (link) link.addEventListener("click", e => {
        e.preventDefault();
        openPaywall(isTrial
            ? "Subscribe now. Your 30 days start after your free trial ends."
            : "Renew now. The 30 days are added on top of what you have left.");
    });
}

async function enforceSubscription() {
    try {
        const s = await fetchSubscription();
        localStorage.setItem(SUB_CACHE_KEY, String(s.expiresAt || 0));
        showSubStatus(s);
        if (s.active) { closePaywall(); return true; }

        const left = s.trialUsed
            ? "Your free trial has ended. Subscribe to keep using PayTrack."
            : "Pay with M-PESA to keep using PayTrack.";
        openPaywall(left);
        return false;

    } catch (e) {
        // Offline / server down: allow if expiry (plus grace) hasn't passed
        const cached = Number(localStorage.getItem(SUB_CACHE_KEY)) || 0;
        if (cached && Date.now() < cached + OFFLINE_GRACE_MS) return true;
        openPaywall("Can't reach the server. Connect to the internet to continue.");
        return false;
    }
}

async function onPayClick() {
    if (paywallBusy) return;
    const phone = document.getElementById("paywallPhone").value.trim();
    if (!/^(?:\+?254|0)?[71]\d{8}$/.test(phone.replace(/\s/g, ""))) {
        paywallStatus("Enter a valid Safaricom number, e.g. 0712345678.", "error");
        return;
    }

    const payBtn = document.getElementById("paywallPayBtn");
    paywallBusy = true;
    payBtn.disabled = true;

    try {
        paywallStatus("Sending M-PESA prompt to your phone...");
        const id = await startPayment(phone);
        paywallStatus("Enter your M-PESA PIN on your phone...");
        await waitForPayment(id);
        paywallStatus("Payment received. Thank you!", "ok");
        await enforceSubscription();
    } catch (e) {
        paywallStatus(e.message || "Payment failed.", "error");
    } finally {
        paywallBusy = false;
        payBtn.disabled = false;
    }
}

async function onCheckClick() {
    paywallStatus("Checking...");
    const ok = await enforceSubscription();
    if (!ok) paywallStatus("No active subscription found yet.", "error");
}

document.addEventListener("DOMContentLoaded", () => {
    const pay = document.getElementById("paywallPayBtn");
    const check = document.getElementById("paywallCheckBtn");
    if (pay) pay.addEventListener("click", onPayClick);
    if (check) check.addEventListener("click", onCheckClick);
});

document.addEventListener("paytrack:unlocked", enforceSubscription);

// Re-check when the app returns to the foreground
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" &&
        (!window.PayTrackLock || window.PayTrackLock.isUnlocked())) {
        enforceSubscription();
    }
});