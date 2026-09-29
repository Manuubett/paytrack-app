/*
    PAYTRACK - IN-APP DEBUG LOG
    Captures console.log/warn/error so we can view them
    on the phone itself, without USB debugging.
*/

window._paytrackLogs = [];

function paytrackCapture(type, args) {
    try {
        const text = Array.from(args).map(a => {
            if (a instanceof Error) return a.message;
            if (typeof a === "object") {
                try { return JSON.stringify(a); } catch (e) { return String(a); }
            }
            return String(a);
        }).join(" ");

        window._paytrackLogs.push(
            "[" + type + "] " + text
        );

        if (window._paytrackLogs.length > 300) {
            window._paytrackLogs.shift();
        }
    } catch (e) {}
}

const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;

console.log = function () {
    paytrackCapture("log", arguments);
    _origLog.apply(console, arguments);
};

console.error = function () {
    paytrackCapture("error", arguments);
    _origError.apply(console, arguments);
};

console.warn = function () {
    paytrackCapture("warn", arguments);
    _origWarn.apply(console, arguments);
};

function openDebugLog() {
    const modal = document.getElementById("debugLogModal");
    const pre = document.getElementById("debugLogContent");
    if (!modal || !pre) return;

    pre.textContent = window._paytrackLogs.length
        ? window._paytrackLogs.join("\n")
        : "No logs captured yet.";

    modal.style.display = "flex";
}

function closeDebugLog() {
    const modal = document.getElementById("debugLogModal");
    if (modal) modal.style.display = "none";
}