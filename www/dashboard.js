/*
    PAYTRACK — TODAY DASHBOARD (with last 7 days)

    Shows money in and money out, the latest M-PESA balance, and a list of
    transactions for ONE day. A strip of the last 7 days sits above the
    cards: each day shows its profit, and tapping a day shows that day's
    figures and transactions. Personal transactions are left out everywhere.
    Data comes from the phone's M-PESA SMS inbox through loadFinanceData().

    Refreshes: after unlock, when the app returns to the foreground,
    every couple of minutes, and when you tap Refresh.
*/

let dashboardBusy = false;
let dashboardLast = 0;
let dashboardTimer = null;

const DASHBOARD_MAX_ROWS = 15;
const WEEK_DAYS = 7;

let dashboardData = null;
let dashboardDay = null;        // null = today (follows midnight automatically)
let dashboardShowAll = false;
const PERSONAL_KEY = "paytrack_personal_rows";


/* ---------- transactions marked "personal" (not business) ---------- */

function loadPersonal() {
    try {
        return new Set(JSON.parse(localStorage.getItem(PERSONAL_KEY)) || []);
    } catch (e) {
        return new Set();
    }
}

function savePersonal(set) {
    try {
        // keep the list from growing forever
        const arr = Array.from(set).slice(-2000);
        localStorage.setItem(PERSONAL_KEY, JSON.stringify(arr));
    } catch (e) {}
}

function dashboardRowKey(kind, r) {
    return kind + ":" + (
        r.receipt || r.id ||
        [r.date, r.time, r.amount, r.details || r.recipient || ""].join("|")
    );
}


/* ---------- dates ---------- */

function localISO(d) {
    d = d || new Date();
    return (
        d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0")
    );
}

function isoDaysAgo(n) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);            // noon avoids any daylight-saving edge
    d.setDate(d.getDate() - n);
    return localISO(d);
}

function dayLabel(iso, opts) {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-KE", opts);
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

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
}


/* ---------- last 7 days ---------- */

function weekSummary(data, personal) {

    const days = [];
    const index = {};

    for (let i = WEEK_DAYS - 1; i >= 0; i--) {
        const day = { date: isoDaysAgo(i), inAmt: 0, outAmt: 0, count: 0, net: 0 };
        days.push(day);
        index[day.date] = day;
    }

    data.income.forEach(r => {
        const d = index[r.date];
        if (!d || personal.has(dashboardRowKey("in", r))) return;
        d.inAmt += Number(r.amount) || 0;
        d.count++;
    });

    data.expense.forEach(r => {
        const d = index[r.date];
        if (!d || personal.has(dashboardRowKey("out", r))) return;
        d.outAmt += dashboardOut(r);
        d.count++;
    });

    days.forEach(d => { d.net = d.inAmt - d.outAmt; });

    return days;
}

function renderWeekStrip(days, selected, today) {

    const strip = document.getElementById("weekStrip");
    if (strip) {
        strip.innerHTML = days.map(d => {

            const isSel = d.date === selected;
            const title = d.date === today
                ? "Today"
                : dayLabel(d.date, { weekday: "short" });

            return `
                <button type="button"
                        class="week-day${isSel ? " is-selected" : ""}"
                        data-day="${escapeHtml(d.date)}"
                        aria-pressed="${isSel}">
                    <span class="wd-name">${escapeHtml(title)}</span>
                    <span class="wd-date">${escapeHtml(dayLabel(d.date, { day: "numeric", month: "short" }))}</span>
                    <span class="wd-net ${d.count ? (d.net >= 0 ? "pos" : "neg") : "muted"}">
                        ${d.count ? escapeHtml(formatMoney(d.net)) : "–"}
                    </span>
                </button>`;
        }).join("");
    }

    const totalIn = days.reduce((s, d) => s + d.inAmt, 0);
    const totalOut = days.reduce((s, d) => s + d.outAmt, 0);
    const net = totalIn - totalOut;

    setText(
        "weekTotal",
        "Last 7 days: in " + formatMoney(totalIn) +
        " · out " + formatMoney(totalOut) +
        " · " + (net >= 0 ? "profit " : "loss ") + formatMoney(Math.abs(net))
    );
}


/* ---------- main render ---------- */

function renderDashboard(data) {

    const today = localISO();

    dashboardData = data;

    const personal = loadPersonal();

    // week strip (also validates the selected day)
    const days = weekSummary(data, personal);

    if (dashboardDay && !days.some(d => d.date === dashboardDay)) {
        dashboardDay = null;
    }

    const day = dashboardDay || today;
    const isToday = day === today;
    const dayName = isToday
        ? "today"
        : dayLabel(day, { weekday: "short", day: "numeric", month: "short" });

    renderWeekStrip(days, day, today);

    const inAll = data.income
        .filter(r => r.date === day)
        .map(r => ({ row: r, key: dashboardRowKey("in", r) }));

    const outAll = data.expense
        .filter(r => r.date === day)
        .map(r => ({ row: r, key: dashboardRowKey("out", r) }));

    const inRows = inAll.filter(x => !personal.has(x.key)).map(x => x.row);
    const outRows = outAll.filter(x => !personal.has(x.key)).map(x => x.row);

    const excludedCount =
        (inAll.length - inRows.length) + (outAll.length - outRows.length);

    const totalIn = inRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const totalOut = outRows.reduce((s, r) => s + dashboardOut(r), 0);
    const net = totalIn - totalOut;

    document.getElementById("todayIn").textContent = formatMoney(totalIn);
    document.getElementById("todayOut").textContent = formatMoney(totalOut);

    setText("todayInLabel", "Money In (" + dayName + ")");
    setText("todayOutLabel", "Money Out (" + dayName + ")");

    const netEl = document.getElementById("todayNet");
    netEl.textContent = formatMoney(net);
    netEl.className = net >= 0 ? "pos" : "neg";

    const netLabel = document.getElementById("todayNetLabel");
    if (netLabel) {
        netLabel.textContent =
            (net >= 0 ? "Profit" : "Loss") + (isToday ? " Today" : " · " + dayName);
    }

    const exEl = document.getElementById("todayExcluded");
    if (exEl) {
        exEl.textContent = excludedCount
            ? plural(excludedCount, "transaction") + " marked personal (not counted)"
            : "";
    }

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

    // ---------- the selected day's transactions ----------

    const items = [];

    inAll.forEach(x => items.push({
        kind: "in",
        key: x.key,
        personal: personal.has(x.key),
        time: x.row.time || "",
        label: x.row.details || "Received",
        amount: Number(x.row.amount) || 0
    }));

    outAll.forEach(x => items.push({
        kind: "out",
        key: x.key,
        personal: personal.has(x.key),
        time: x.row.time || "",
        label: x.row.recipient || "Sent",
        amount: dashboardOut(x.row)
    }));

    items.sort((a, b) => (b.time || "00:00").localeCompare(a.time || "00:00"));

    const countEl = document.getElementById("todayListCount");
    if (countEl) {
        countEl.textContent = items.length
            ? (isToday ? "" : dayName + " ") + "(" + items.length + ")"
            : (isToday ? "" : dayName);
    }

    const list = document.getElementById("todayList");

    if (items.length === 0) {
        list.innerHTML = "<p class='muted'>" +
            (isToday ? "No M-PESA transactions today yet."
                     : "No M-PESA transactions on this day.") +
            "</p>";
        return;
    }

    const shown = dashboardShowAll ? items : items.slice(0, DASHBOARD_MAX_ROWS);

    let footer = "";

    if (items.length > DASHBOARD_MAX_ROWS) {
        footer = dashboardShowAll
            ? "<button type='button' class='mark-btn' data-showall='0' style='margin-top:8px;'>Show fewer</button>"
            : "<button type='button' class='mark-btn' data-showall='1' style='margin-top:8px;'>Show all (" +
              (items.length - shown.length) + " more)</button>";
    }

    list.innerHTML =
        shown.map(it => `
            <div class="today-item${it.personal ? " is-personal" : ""}">
                <div class="who">
                    ${escapeHtml(it.label)}
                    <span class="when">${escapeHtml(it.time || "")}${it.personal ? " · personal" : ""}</span>
                </div>
                <div class="row-right">
                    <div class="amt ${it.kind === "in" ? "pos" : "neg"}">
                        ${it.kind === "in" ? "+" : "−"} ${escapeHtml(formatMoney(it.amount))}
                    </div>
                    <button type="button" class="mark-btn" data-mark="${escapeHtml(it.key)}">
                        ${it.personal ? "Count it" : "Personal"}
                    </button>
                </div>
            </div>
        `).join("") + footer;
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
            }) +
            (data.kept > 0
                ? " · includes " + data.kept + " saved from deleted messages"
                : "")
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


// Tap "Personal" / "Count it" on a transaction, or "Show all" / "Show fewer"
(function () {
    const list = document.getElementById("todayList");
    if (!list) return;

    list.addEventListener("click", function (e) {

        if (!dashboardData) return;

        const more = e.target.closest("[data-showall]");
        if (more) {
            dashboardShowAll = more.getAttribute("data-showall") === "1";
            renderDashboard(dashboardData);
            return;
        }

        const btn = e.target.closest("[data-mark]");
        if (!btn) return;

        const key = btn.getAttribute("data-mark");
        const set = loadPersonal();

        if (set.has(key)) set.delete(key);
        else set.add(key);

        savePersonal(set);
        renderDashboard(dashboardData);
    });
})();


// Tap a day in the last-7-days strip
(function () {
    const strip = document.getElementById("weekStrip");
    if (!strip) return;

    strip.addEventListener("click", function (e) {

        const btn = e.target.closest("[data-day]");
        if (!btn || !dashboardData) return;

        const date = btn.getAttribute("data-day");

        dashboardDay = date === localISO() ? null : date;
        dashboardShowAll = false;

        renderDashboard(dashboardData);
    });
})();
