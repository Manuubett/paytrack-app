/*
    PAYTRACK — UPDATE CHECK (via your Smart App Hub)

    Reads the public "apps" collection that the store page already uses,
    finds the newest entry named APP_NAME, and compares its version with
    the installed app. If it is newer, a banner offers the download.

    Release flow: upload the new APK in the store's admin page with
    Name = PayTrack and Version = the same versionName as build.gradle.
    Start "What's new" with [required] to make the update mandatory.

    Needs:    npm i @capacitor/app        (reads the installed version)
    Optional: npm i @capacitor/browser    (cleaner download)
*/

(function () {

    "use strict";

    const APP_NAME   = "PayTrack";
    const PROJECT_ID = "divine-treat-450709-b5";
    const API_KEY    = "AIzaSyDPZLbDio7OibE-FEXqFF1OdhM0qZc3yII";   // public web key, same as the store page
    const BACKEND    = "https://cbe-y1zb.onrender.com";
    const STORE_URL  = "https://manuubett.github.io/apks-store/";

    const DISMISS_KEY = "paytrack_update_dismissed";
    const MIN_GAP_MS  = 30 * 60 * 1000;      // check at most every 30 minutes

    let lastCheck = 0;
    let checking = false;


    function plugin(name) {
        const c = window.Capacitor;
        return c && c.Plugins && c.Plugins[name] ? c.Plugins[name] : null;
    }

    async function installedVersion() {
        try {
            const App = plugin("App");
            if (!App || typeof App.getInfo !== "function") return null;
            const info = await App.getInfo();
            return info && info.version ? String(info.version) : null;
        } catch (e) {
            return null;
        }
    }

    // "1.0.10" > "1.0.9"
    function cmpVersion(a, b) {
        const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
        const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d !== 0) return d;
        }
        return 0;
    }

    async function fetchLatest() {
        const url = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID +
            "/databases/(default)/documents/apps?pageSize=100&key=" + API_KEY;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error("Store lookup failed (" + r.status + ")");
        const data = await r.json();

        let best = null;
        (data.documents || []).forEach(doc => {
            const f = doc.fields || {};
            const name = f.name && f.name.stringValue;
            const version = f.version && f.version.stringValue;
            if (!name || !version) return;
            if (name.trim().toLowerCase() !== APP_NAME.toLowerCase()) return;
            if (!best || cmpVersion(version, best.version) > 0) {
                const log = (f.changelog && f.changelog.stringValue) || "";
                best = {
                    id: doc.name.split("/").pop(),
                    version: version,
                    mandatory: /^\s*\[required\]/i.test(log),
                    notes: log.replace(/^\s*\[required\]\s*/i, "")
                };
            }
        });
        return best;
    }

    function openUrl(url) {
        const Browser = plugin("Browser");
        if (Browser && typeof Browser.open === "function") Browser.open({ url: url });
        else window.location.href = url;
    }

    async function startDownload(latest, button) {
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "Preparing…";
        try {
            const r = await fetch(BACKEND + "/api/apps/download", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ appId: latest.id })
            });
            const d = await r.json();
            if (!r.ok || !d.url) throw new Error(d.error || "No download link");
            openUrl(d.url);
        } catch (e) {
            console.log("PayTrack: direct download failed, opening store:", e && e.message);
            openUrl(STORE_URL);              // fallback: download from the store page
        }
        button.disabled = false;
        button.textContent = label;
    }

    function removeBanner() {
        const old = document.getElementById("updateBanner");
        if (old) old.remove();
    }

    function showBanner(latest) {

        removeBanner();

        const bar = document.createElement("div");
        bar.id = "updateBanner";
        bar.setAttribute("role", "alert");
        bar.style.cssText =
            "position:fixed;left:0;right:0;top:0;z-index:8000;" +
            "padding:calc(10px + env(safe-area-inset-top,0px)) 14px 10px;" +
            "background:#0f7d3a;color:#fff;font:14px/1.4 system-ui,sans-serif;" +
            "display:flex;gap:10px;align-items:center;justify-content:space-between;";

        const text = document.createElement("div");
        text.textContent = "Update available: version " + latest.version +
            (latest.notes ? " · " + latest.notes : "");

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:8px;flex-shrink:0;";

        const get = document.createElement("button");
        get.type = "button";
        get.textContent = "Update";
        get.style.cssText =
            "background:#fff;color:#0f7d3a;border:0;border-radius:8px;padding:8px 12px;font-weight:600;";
        get.addEventListener("click", () => startDownload(latest, get));
        actions.appendChild(get);

        if (!latest.mandatory) {
            const later = document.createElement("button");
            later.type = "button";
            later.textContent = "Later";
            later.style.cssText =
                "background:transparent;color:#fff;border:1px solid #fff;border-radius:8px;padding:8px 12px;";
            later.addEventListener("click", () => {
                try { localStorage.setItem(DISMISS_KEY, latest.version); } catch (e) {}
                removeBanner();
            });
            actions.appendChild(later);
        }

        bar.appendChild(text);
        bar.appendChild(actions);
        document.body.appendChild(bar);
    }

    async function checkForUpdate(force) {

        if (checking) return;
        if (!force && Date.now() - lastCheck < MIN_GAP_MS) return;

        const current = await installedVersion();
        if (!current) return;                    // browser testing: nothing to compare

        checking = true;

        try {

            const latest = await fetchLatest();
            lastCheck = Date.now();

            if (!latest || cmpVersion(latest.version, current) <= 0) {
                removeBanner();
                return;
            }

            if (!latest.mandatory) {
                let dismissed = null;
                try { dismissed = localStorage.getItem(DISMISS_KEY); } catch (e) {}
                if (dismissed && cmpVersion(dismissed, latest.version) >= 0) return;
            }

            console.log("PayTrack: update available", latest.version, "(installed", current + ")");
            showBanner(latest);

        } catch (e) {
            console.log("PayTrack: update check failed:", e && e.message);
        } finally {
            checking = false;
        }
    }

    document.addEventListener("paytrack:unlocked", () => checkForUpdate(true));

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" &&
            (!window.PayTrackLock || window.PayTrackLock.isUnlocked())) {
            checkForUpdate(false);
        }
    });

})();