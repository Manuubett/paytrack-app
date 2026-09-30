/*
    PAYTRACK — TODAY DASHBOARD

    Shows today's money in and money out, the latest M-PESA balance, and
    a list of today's transactions. Data comes from the phone's M-PESA
    SMS inbox through loadFinanceData() in finance.js.

    Refreshes: after unlock, when the app returns to the foreground,
    every couple of minutes, and when you tap Refresh.
*/

let dashboardBusy = false;
let dashboardLast = 0;
let dashboardTimer = null;

const DASHBOARD_MAX_ROWS = 15;


function localISO(d) {
    d = d || new Date();
    return (
        d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0")
    );
}

function dashboardUnlocked() {
    return !window.PayTrackLock || window.PayTrackLock.isUnlocked();
}

function dashboardOut(row) {
    if (typeof outAmount === "function") return outAmount(row);
    return (Number(row.amount) || 0) + (Number(row.fee) || 0);
}

function setDashboardStatus(message, isError) {
    const el = document.getElementById("todayStatus");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("neg", !!isError);
}

function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
}


function renderDashboard(data) {

    const today = localISO();

    const inRows = data.income.filter(r => r.date === today);
    const outRows = data.expense.filter(r => r.date === today);

    const totalIn = inRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const totalOut = outRows.reduce((s, r) => s + dashboardOut(r), 0);
    const net = totalIn - totalOut;

    document.getElementById("todayIn").textContent = formatMoney(totalIn);
    document.getElementById("todayOut").textContent = formatMoney(totalOut);

    const netEl = document.getElementById("todayNet");
    netEl.textContent = formatMoney(net);
    netEl.className = net >= 0 ? "pos" : "neg";

    document.getElementById("todayInCount").textContent =
        plural(inRows.length, "transaction");
    document.getElementById("todayOutCount").textContent =
        plural(outRows.length, "transaction");

    // ---------- latest balance (across the whole inbox) ----------

    let latest = null;

    data.income.concat(data.expense).forEach(r => {
        if (r.balance === null || r.balance === undefined || !r.date) return;
        const key = r.date + " " + (r.time || "00:00");
        if (!latest || key > latest.key) {
            latest = { key: key, balance: r.balance, date: r.date, time: r.time };
        }
    });

    const balEl = document.getElementById("todayBalance");

    balEl.innerHTML = latest
        ? "M-PESA balance: <strong>" + escapeHtml(formatMoney(latest.balance)) + "</strong> (" +
          escapeHtml(latest.date + (latest.time ? " " + latest.time : "")) + ")"
        : "";

    // ---------- today's transactions ----------

    const items = [];

    inRows.forEach(r => items.push({
        kind: "in",
        time: r.time || "",
        label: r.details || "Received",
        amount: Number(r.amount) || 0
    }));

    outRows.forEach(r => items.push({
        kind: "out",
        time: r.time || "",
        label: r.recipient || "Sent",
        amount: dashboardOut(r)
    }));

    items.sort((a, b) => (b.time || "00:00").localeCompare(a.time || "00:00"));

    const countEl = document.getElementById("todayListCount");
    if (countEl) countEl.textContent = items.length ? "(" + items.length + ")" : "";

    const list = document.getElementById("todayList");

    if (items.length === 0) {
        list.innerHTML = "<p class='muted'>No M-PESA transactions today yet.</p>";
        return;
    }

    const shown = items.slice(0, DASHBOARD_MAX_ROWS);

    list.innerHTML =
        shown.map(it => `
            <div class="today-item">
                <div class="who">
                    ${escapeHtml(it.label)}
                    <span class="when">${escapeHtml(it.time || "")}</span>
                </div>
                <div class="amt ${it.kind === "in" ? "pos" : "neg"}">
                    ${it.kind === "in" ? "+" : "−"} ${escapeHtml(formatMoney(it.amount))}
                </div>
            </div>
        `).join("") +
        (items.length > shown.length
            ? "<p class='muted' style='margin-top:8px;'>+ " +
              (items.length - shown.length) + " more today</p>"
            : "");
}


async function refreshDashboard() {

    if (dashboardBusy) return;

    const btn = document.getElementById("todayRefreshBtn");
    const dateEl = document.getElementById("todayDate");

    if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString("en-KE", {
            weekday: "long", day: "numeric", month: "short", year: "numeric"
        });
    }

    dashboardBusy = true;
    if (btn) btn.disabled = true;
    setDashboardStatus("Reading M-PESA messages...");

    try {

        if (typeof loadFinanceData !== "function") {
            throw new Error("finance.js is not loaded.");
        }

        const data = await loadFinanceData();

        renderDashboard(data);
        dashboardLast = Date.now();

        setDashboardStatus(
            "Updated " + new Date().toLocaleTimeString("en-KE", {
                hour: "2-digit", minute: "2-digit"
            })
        );

    } catch (error) {

        console.error("PayTrack dashboard:", error);

        if (!dashboardLast) {
            ["todayIn", "todayOut", "todayNet"].forEach(id => {
                document.getElementById(id).textContent = "—";
            });
        }

        setDashboardStatus(error.message || "Could not read SMS.", true);

    } finally {
        dashboardBusy = false;
        if (btn) btn.disabled = false;
    }
}


function startDashboardTimer() {

    clearInterval(dashboardTimer);

    dashboardTimer = setInterval(() => {
        if (
            document.visibilityState === "visible" &&
            dashboardUnlocked() &&
            Date.now() - dashboardLast > 60 * 1000
        ) {
            refreshDashboard();
        }
    }, 2 * 60 * 1000);
}


document.addEventListener("paytrack:unlocked", () => {
    refreshDashboard();
    startDashboardTimer();
});

document.addEventListener("visibilitychange", () => {
    if (
        document.visibilityState === "visible" &&
        dashboardUnlocked() &&
        Date.now() - dashboardLast > 30 * 1000
    ) {
        refreshDashboard();
    }
});

// If the lock module is missing, still load the dashboard
if (!window.PayTrackLock) {
    refreshDashboard();
    startDashboardTimer();
}