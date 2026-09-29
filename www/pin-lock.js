/*
    PAYTRACK — PIN LOCK

    - First launch: asks the user to create a 4-6 digit PIN.
    - Afterwards: the app is locked on start, when you tap 🔒, and when
      the app has been in the background for more than 30 seconds.
    - 5 wrong tries triggers a timed lockout (30s, doubling, max 5 min).
    - The PIN is stored only as a salted hash (PBKDF2 when available).
    - "Forgot PIN" erases all PayTrack data on this device, then restarts.

    NOTE: this is an app-level lock. It keeps people out of the screen,
    it does not encrypt the data stored on the phone.

    Exposes window.PayTrackLock { lock, changePin, isUnlocked, hasPin }
    and fires a "paytrack:unlocked" event on document after each unlock.
*/

(function () {
    "use strict";

    var HASH_KEY = "paytrack_pin_hash";
    var SALT_KEY = "paytrack_pin_salt";
    var FAIL_KEY = "paytrack_pin_fail";

    var AUTO_LOCK_MS = 30 * 1000;
    var MIN_LEN = 4;
    var MAX_LEN = 6;
    var FREE_TRIES = 5;

    var mode = "unlock";   // setup | setup-confirm | unlock | change-verify | change-new | change-confirm
    var entry = "";
    var firstEntry = "";
    var unlocked = false;
    var hiddenAt = 0;
    var busy = false;
    var countdown = null;


    /* ---------- helpers ---------- */

    function $(id) { return document.getElementById(id); }

    function read(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function write(key, value) {
        try { localStorage.setItem(key, value); } catch (e) {}
    }

    function hasPin() { return !!read(HASH_KEY); }

    function isVerifyMode() {
        return mode === "unlock" || mode === "change-verify";
    }

    function toast(message) {
        var t = document.createElement("div");
        t.className = "toast";
        t.textContent = message;
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, 2500);
    }


    /* ---------- hashing ---------- */

    function toHex(buffer) {
        return Array.prototype.map.call(new Uint8Array(buffer), function (b) {
            return ("0" + b.toString(16)).slice(-2);
        }).join("");
    }

    function newSalt() {
        var bytes = new Uint8Array(16);
        if (window.crypto && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
        } else {
            for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        return toHex(bytes);
    }

    // Used only if the WebView has no crypto.subtle
    function fallbackHash(pin, salt) {
        var s = salt + ":" + pin + ":" + salt;
        var h1 = 5381, h2 = 52711;
        for (var r = 0; r < 3000; r++) {
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                h1 = ((h1 * 33) ^ c) >>> 0;
                h2 = ((h2 * 31) + c + h1) >>> 0;
            }
        }
        return "f1:" + h1.toString(16) + h2.toString(16);
    }

    async function strongHash(pin, salt) {
        var enc = new TextEncoder();
        var key = await crypto.subtle.importKey(
            "raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]
        );
        var bits = await crypto.subtle.deriveBits(
            { name: "PBKDF2", salt: enc.encode(salt), iterations: 150000, hash: "SHA-256" },
            key, 256
        );
        return "p1:" + toHex(bits);
    }

    async function hashNew(pin, salt) {
        if (window.crypto && crypto.subtle) {
            try { return await strongHash(pin, salt); } catch (e) {}
        }
        return fallbackHash(pin, salt);
    }

    async function savePin(pin) {
        var salt = newSalt();
        write(SALT_KEY, salt);
        write(HASH_KEY, await hashNew(pin, salt));
        write(FAIL_KEY, JSON.stringify({ count: 0, until: 0 }));
    }

    async function verifyPin(pin) {
        var stored = read(HASH_KEY);
        var salt = read(SALT_KEY) || "";
        if (!stored) return false;

        if (stored.indexOf("f1:") === 0) {
            return fallbackHash(pin, salt) === stored;
        }

        try { return (await strongHash(pin, salt)) === stored; }
        catch (e) { return false; }
    }


    /* ---------- lockout after wrong PINs ---------- */

    function getFail() {
        try { return JSON.parse(read(FAIL_KEY)) || { count: 0, until: 0 }; }
        catch (e) { return { count: 0, until: 0 }; }
    }

    function remainingLock() {
        return Math.max(0, getFail().until - Date.now());
    }

    function registerFail() {
        var f = getFail();
        f.count++;
        if (f.count >= FREE_TRIES) {
            var extra = f.count - FREE_TRIES;
            f.until = Date.now() + Math.min(30000 * Math.pow(2, extra), 300000);
        }
        write(FAIL_KEY, JSON.stringify(f));
    }

    function resetFails() {
        write(FAIL_KEY, JSON.stringify({ count: 0, until: 0 }));
    }

    function setPadDisabled(disabled) {
        var box = $("pinBox");
        if (box) box.classList.toggle("disabled", disabled);
    }

    function tick() {
        var ms = remainingLock();

        if (ms <= 0) {
            clearInterval(countdown);
            countdown = null;
            setPadDisabled(false);
            showError("");
            return;
        }

        setPadDisabled(true);
        showError("Too many wrong attempts. Try again in " + Math.ceil(ms / 1000) + "s");
    }

    function startCountdown() {
        clearInterval(countdown);
        tick();
        if (remainingLock() > 0) countdown = setInterval(tick, 500);
    }


    /* ---------- UI ---------- */

    var TEXT = {
        "setup":          ["Create a PIN",   "Choose 4 to 6 digits to protect PayTrack"],
        "setup-confirm":  ["Confirm PIN",    "Enter the same PIN again"],
        "unlock":         ["Enter PIN",      "PayTrack is locked"],
        "change-verify":  ["Current PIN",    "Enter your current PIN"],
        "change-new":     ["New PIN",        "Choose 4 to 6 digits"],
        "change-confirm": ["Confirm new PIN","Enter the new PIN again"]
    };

    function showError(message) {
        var e = $("pinError");
        if (e) e.textContent = message || "";
    }

    function renderDots() {
        var wrap = $("pinDots");
        if (!wrap) return;

        var count = Math.max(MIN_LEN, entry.length);
        var html = "";

        for (var i = 0; i < count; i++) {
            html += '<span class="pin-dot' + (i < entry.length ? " filled" : "") + '"></span>';
        }

        wrap.innerHTML = html;
    }

    function setMode(newMode) {
        mode = newMode;
        entry = "";

        $("pinTitle").textContent = TEXT[mode][0];
        $("pinSubtitle").textContent = TEXT[mode][1];

        var changing = mode.indexOf("change") === 0;

        $("pinCancel").style.display = changing ? "inline" : "none";
        $("pinForgot").style.display = isVerifyMode() ? "inline" : "none";

        showError("");
        renderDots();
    }

    function shake() {
        var box = $("pinBox");
        box.classList.remove("shake");
        void box.offsetWidth;
        box.classList.add("shake");
    }

    function showOverlay() {
        $("pinLock").classList.add("show");
        document.body.classList.add("is-locked");

        if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
        }

        if (isVerifyMode() && remainingLock() > 0) startCountdown();
    }

    function hideOverlay() {
        $("pinLock").classList.remove("show");
        document.body.classList.remove("is-locked");
    }

    function unlock() {
        unlocked = true;
        hideOverlay();
        document.dispatchEvent(new CustomEvent("paytrack:unlocked"));
    }

    function lock() {
        unlocked = false;
        setMode(hasPin() ? "unlock" : "setup");
        showOverlay();
    }

    function changePin() {
        if (!hasPin()) { lock(); return; }
        setMode("change-verify");
        showOverlay();
    }

    function cancelChange() {
        hideOverlay();
        setMode("unlock");
    }


    /* ---------- submit ---------- */

    async function submit() {

        if (busy) return;

        if (entry.length < MIN_LEN) {
            showError("PIN must be at least " + MIN_LEN + " digits");
            shake();
            return;
        }

        if (isVerifyMode() && remainingLock() > 0) return;

        var pin = entry;
        busy = true;

        try {

            if (mode === "setup") {
                firstEntry = pin;
                setMode("setup-confirm");

            } else if (mode === "setup-confirm") {

                if (pin !== firstEntry) {
                    firstEntry = "";
                    setMode("setup");
                    showError("PINs did not match. Try again.");
                    shake();
                } else {
                    await savePin(pin);
                    firstEntry = "";
                    unlock();
                    toast("PIN set");
                }

            } else if (mode === "unlock" || mode === "change-verify") {

                var ok = await verifyPin(pin);

                if (ok) {
                    resetFails();
                    if (mode === "unlock") unlock();
                    else setMode("change-new");
                } else {
                    registerFail();
                    entry = "";
                    renderDots();
                    shake();

                    if (remainingLock() > 0) startCountdown();
                    else showError("Wrong PIN");
                }

            } else if (mode === "change-new") {
                firstEntry = pin;
                setMode("change-confirm");

            } else if (mode === "change-confirm") {

                if (pin !== firstEntry) {
                    firstEntry = "";
                    setMode("change-new");
                    showError("PINs did not match. Try again.");
                    shake();
                } else {
                    await savePin(pin);
                    firstEntry = "";
                    hideOverlay();
                    setMode("unlock");
                    toast("PIN changed");
                }
            }

        } finally {
            busy = false;
        }
    }

    function onKey(key) {

        if (busy) return;
        if (isVerifyMode() && remainingLock() > 0) return;

        if (key === "back") {
            entry = entry.slice(0, -1);
        } else if (key === "ok") {
            submit();
            return;
        } else if (/^\d$/.test(key) && entry.length < MAX_LEN) {
            entry += key;
        }

        showError("");
        renderDots();
    }

    function forgotPin() {

        var ok = confirm(
            "Forgot your PIN?\n\n" +
            "The only way to reset it is to erase ALL PayTrack data " +
            "stored on this device (employees and recorded payments). " +
            "Your M-PESA messages are not affected.\n\nContinue?"
        );

        if (!ok) return;

        var typed = prompt("Type RESET to confirm");

        if (typed === null || typed.trim().toUpperCase() !== "RESET") return;

        try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}

        location.reload();
    }


    /* ---------- init ---------- */

    function init() {

        $("pinPad").addEventListener("click", function (e) {
            var btn = e.target.closest("[data-key]");
            if (btn) onKey(btn.getAttribute("data-key"));
        });

        $("pinCancel").addEventListener("click", cancelChange);
        $("pinForgot").addEventListener("click", forgotPin);

        document.addEventListener("keydown", function (e) {

            if (!$("pinLock").classList.contains("show")) return;

            if (/^\d$/.test(e.key)) onKey(e.key);
            else if (e.key === "Backspace") onKey("back");
            else if (e.key === "Enter") onKey("ok");
            else if (e.key === "Escape" && mode.indexOf("change") === 0) cancelChange();
        });

        // Re-lock after the app has been in the background for a while
        document.addEventListener("visibilitychange", function () {

            if (document.visibilityState === "hidden") {
                hiddenAt = Date.now();
                return;
            }

            if (unlocked && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) {
                lock();
            }

            hiddenAt = 0;
        });

        var lockBtn = $("lockBtn");
        if (lockBtn) lockBtn.addEventListener("click", lock);

        var changeBtn = $("changePinBtn");
        if (changeBtn) changeBtn.addEventListener("click", changePin);

        lock();
    }

    window.PayTrackLock = {
        lock: lock,
        changePin: changePin,
        hasPin: hasPin,
        isUnlocked: function () { return unlocked; }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();