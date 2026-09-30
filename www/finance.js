/*
    PAYTRACK — INCOME VS EXPENSE DASHBOARD

    Reads the full SMS inbox (via window.syncAllMpesaSms) and classifies
    every message as:
      - income   (parseMpesaSms from sms-parser.js -> "received")
      - expense  (parseOutgoingSms below -> sent / paid / withdrawn / airtime)

    Each row now carries date, time and M-PESA balance, so the dashboard
    can show the latest balance.

    The outgoing parser lives in this file so it no longer depends on
    parseMpesaOutgoing existing in sms-parser.js.
*/

let financeCache = { income: [], expense: [] };


/* =========================
   OUTGOING M-PESA PARSER
========================= */

function parseKshAmount(str) {
    return Number(String(str || "").replace(/,/g, "")) || 0;
}

function parseSmsDate(text, fallback) {

    const m = text.match(/\bon\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);

    if (m) {
        let day = m[1].padStart(2, "0");
        let month = m[2].padStart(2, "0");
        let year = m[3].length === 2 ? "20" + m[3] : m[3];
        return `${year}-${month}-${day}`;
    }

    if (fallback) {
        const d = new Date(fallback);
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }

    return "";
}

function parseSmsTime(text) {

    const m = text.match(/\bat\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return "";

    let hours = Number(m[1]);
    const meridian = (m[3] || "").toUpperCase();

    if (meridian === "PM" && hours < 12) hours += 12;
    if (meridian === "AM" && hours === 12) hours = 0;

    return String(hours).padStart(2, "0") + ":" + m[2];
}

function parseSmsBalance(text) {

    const m = text.match(
        /balance\s+is\s+(?:Ksh|KES)\.?\s*([\d,]+(?:\.\d{1,2})?)/i
    );

    return m ? parseKshAmount(m[1]) : null;
}

function cleanRecipient(name) {
    return String(name || "")
        .replace(/\s+(?:on|at)\s+\d.*$/i, "")
        .replace(/\s*\+?\d[\d\s-]{7,}$/, "")     // trailing phone number
        .replace(/[.\s]+$/, "")
        .trim() || "Unknown";
}

/* Returns an array with 0 or 1 expense rows. */
function parseOutgoingSms(body, fallbackDate) {

    const text = String(body || "").replace(/\s+/g, " ").trim();
    if (!text) return [];

    // never treat incoming money as an expense
    if (/you have received/i.test(text) && !/\bsent to\b|\bpaid to\b/i.test(text)) {
        return [];
    }

    const AMT = "Ksh\\.?\\s?([\\d,]+(?:\\.\\d{1,2})?)";
    let amount = 0;
    let recipient = "";
    let type = "";
    let m;

    if ((m = text.match(new RegExp(AMT + "\\s+sent to\\s+(.+?)(?=\\s+for account|\\s+on\\s+\\d|\\.\\s|$)", "i")))) {
        amount = parseKshAmount(m[1]);
        recipient = cleanRecipient(m[2]);
        type = "sent";

    } else if ((m = text.match(new RegExp(AMT + "\\s+paid to\\s+(.+?)(?=\\.?\\s+on\\s+\\d|$)", "i")))) {
        amount = parseKshAmount(m[1]);
        recipient = cleanRecipient(m[2]);
        type = "paid";

    } else if ((m = text.match(new RegExp("Withdraw\\s+" + AMT + "\\s+from\\s+(.+?)(?=\\s+New M-PESA|$)", "i")))) {
        amount = parseKshAmount(m[1]);
        recipient = "Withdrawal: " + cleanRecipient(m[2].replace(/^\d+\s*-\s*/, ""));
        type = "withdrawn";

    } else if ((m = text.match(new RegExp("bought\\s+" + AMT + "\\s+of airtime", "i")))) {
        amount = parseKshAmount(m[1]);
        recipient = "Airtime";
        type = "airtime";
    }

    if (!amount) return [];

    const codeMatch = text.match(/\b([A-Z0-9]{10})\b\s+confirmed/i);
    const feeMatch = text.match(/Transaction cost,?\s*Ksh\.?\s?([\d,]+(?:\.\d{1,2})?)/i);

    return [{
        id: codeMatch ? codeMatch[1].toUpperCase() : "",
        type: type,
        amount: amount,
        fee: feeMatch ? parseKshAmount(feeMatch[1]) : 0,
        recipient: recipient,
        date: parseSmsDate(text, fallbackDate),
        time: parseSmsTime(text),
        balance: parseSmsBalance(text)
    }];
}


/* =========================
   MODAL
========================= */

function openFinanceModal() {

    const modal = document.getElementById("financeModal");
    const body = document.getElementById("financeBody");

    if (!modal || !body) return;

    modal.style.display = "flex";
    body.innerHTML = "<p class='muted'>Reading M-PESA SMS inbox...</p>";

    syncFinance();
}

function closeFinanceModal() {
    const modal = document.getElementById("financeModal");
    if (modal) modal.style.display = "none";
}


/* =========================
   SYNC
========================= */

let financeLoading = null;


/* =========================
   SAVED HISTORY (LEDGER)
   Every transaction read from the inbox is also saved on this device,
   so deleting the SMS later does not remove it from PayTrack.
========================= */

const LEDGER_KEY = "paytrack_ledger_v1";
const LEDGER_MAX_ROWS = 20000;

function ledgerKey(kind, r) {
    return (kind === "in" ? r.receipt : r.id) ||
        [r.date, r.time, r.amount, r.details || r.recipient || ""].join("|");
}

function loadLedger() {
    try {
        const saved = JSON.parse(localStorage.getItem(LEDGER_KEY));
        if (saved && Array.isArray(saved.income) && Array.isArray(saved.expense)) {
            return saved;
        }
    } catch (e) {}
    return { income: [], expense: [] };
}

function saveLedger(ledger) {

    const trim = rows =>
        rows.length > LEDGER_MAX_ROWS
            ? rows.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""))
                  .slice(-LEDGER_MAX_ROWS)
            : rows;

    try {
        localStorage.setItem(LEDGER_KEY, JSON.stringify({
            income: trim(ledger.income),
            expense: trim(ledger.expense)
        }));
    } catch (e) {
        console.warn("PayTrack: could not save history", e);
    }
}

/*
    Merges rows read from the inbox into the saved history.
    Returns everything, plus how many rows are no longer in the inbox.
*/
function mergeLedger(income, expense) {

    const ledger = loadLedger();
    let kept = 0;

    const merge = (kind, saved, fresh) => {

        const map = new Map();

        saved.forEach(r => map.set(ledgerKey(kind, r), r));

        const freshKeys = new Set();

        fresh.forEach(r => {
            const k = ledgerKey(kind, r);
            freshKeys.add(k);
            map.set(k, r);          // newest read wins
        });

        map.forEach((_, k) => { if (!freshKeys.has(k)) kept++; });

        return Array.from(map.values());
    };

    const merged = {
        income: merge("in", ledger.income, income),
        expense: merge("out", ledger.expense, expense)
    };

    saveLedger(merged);

    return { income: merged.income, expense: merged.expense, kept: kept };
}

/*
    Reads the SMS inbox and fills financeCache.
    Shared by the Income vs Expense modal and the Today dashboard.
    Throws an Error with a readable message on failure.
*/
function loadFinanceData() {

    if (financeLoading) return financeLoading;

    financeLoading = (async () => {

        if (
            !window.Capacitor ||
            typeof window.Capacitor.isNativePlatform !== "function" ||
            !window.Capacitor.isNativePlatform()
        ) {
            throw new Error("This only works inside the Android app.");
        }

        if (typeof window.syncAllMpesaSms !== "function") {
            throw new Error("SMS bridge is not available. Please restart the app.");
        }

        const raw = await window.syncAllMpesaSms();

        if (!Array.isArray(raw)) {
            throw new Error("Invalid SMS response.");
        }

        const income = [];
        const expense = [];
        const seenIn = new Set();
        const seenOut = new Set();

        raw.forEach(message => {

            if (!message || !message.body) return;

            // ---- income ----
            try {
                if (typeof parseMpesaSms === "function") {
                    parseMpesaSms(message.body).forEach(row => {

                        // de-duplicate by M-PESA receipt
                        if (row.receipt) {
                            if (seenIn.has(row.receipt)) return;
                            seenIn.add(row.receipt);
                        }

                        income.push(row);
                    });
                }
            } catch (e) {
                console.warn("PayTrack Finance: income parse failed", e);
            }

            // ---- expense ----
            try {
                parseOutgoingSms(message.body, message.date).forEach(row => {

                    // de-duplicate by M-PESA transaction code
                    if (row.id) {
                        if (seenOut.has(row.id)) return;
                        seenOut.add(row.id);
                    }

                    expense.push(row);
                });
            } catch (e) {
                console.warn("PayTrack Finance: expense parse failed", e);
            }
        });

        financeCache = mergeLedger(income, expense);

        console.log(
            "PayTrack Finance: income rows:", financeCache.income.length,
            "expense rows:", financeCache.expense.length,
            "(kept from deleted messages:", financeCache.kept + ")"
        );

        return financeCache;

    })();

    financeLoading.then(
        () => { financeLoading = null; },
        () => { financeLoading = null; }
    );

    return financeLoading;
}


async function syncFinance() {

    const body = document.getElementById("financeBody");
    if (!body) return;

    try {

        await loadFinanceData();
        renderFinance();

    } catch (error) {

        console.error("PayTrack Finance sync failed:", error);

        const msg = error.message || "Unknown error";

        body.innerHTML =
            "<p class='muted'>" +
            (/^(This only works|SMS bridge)/.test(msg) ? "" : "Could not read SMS: ") +
            escapeHtml(msg) +
            "</p>";
    }
}


function monthKey(iso) {
    return (iso || "").slice(0, 7); // "YYYY-MM"
}

function outAmount(row) {
    return (Number(row.amount) || 0) + (Number(row.fee) || 0);
}


/* =========================
   RENDER
========================= */

function renderFinance() {

    const body = document.getElementById("financeBody");
    if (!body) return;

    const { income, expense } = financeCache;

    if (income.length === 0 && expense.length === 0) {
        body.innerHTML =
            "<p class='muted'>No M-PESA in/out transactions found.</p>";
        return;
    }

    const totalIn = income.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const totalOut = expense.reduce((s, r) => s + outAmount(r), 0);
    const totalFees = expense.reduce((s, r) => s + (Number(r.fee) || 0), 0);
    const net = totalIn - totalOut;

    // ---------- Latest M-PESA balance ----------

    let latest = null;

    income.concat(expense).forEach(r => {
        if (r.balance === null || r.balance === undefined || !r.date) return;
        const key = r.date + " " + (r.time || "00:00");
        if (!latest || key > latest.key) {
            latest = { key: key, balance: r.balance, date: r.date, time: r.time };
        }
    });

    // ---------- Group expenses by recipient ----------

    const byRecipient = {};

    expense.forEach(row => {
        const key = (row.recipient || "Unknown").trim();
        if (!byRecipient[key]) byRecipient[key] = { name: key, total: 0, count: 0 };
        byRecipient[key].total += outAmount(row);
        byRecipient[key].count++;
    });

    const topExpenses = Object.values(byRecipient)
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);

    // ---------- Group by month (last 6 months) ----------

    const months = {};

    income.forEach(r => {
        const k = monthKey(r.date);
        if (!k) return;
        if (!months[k]) months[k] = { in: 0, out: 0 };
        months[k].in += Number(r.amount) || 0;
    });

    expense.forEach(r => {
        const k = monthKey(r.date);
        if (!k) return;
        if (!months[k]) months[k] = { in: 0, out: 0 };
        months[k].out += outAmount(r);
    });

    const monthKeys = Object.keys(months).sort().slice(-6);
    const maxVal = Math.max(
        1,
        ...monthKeys.map(k => Math.max(months[k].in, months[k].out))
    );

    let html = `
        <div class="detail-summary">
            <div class="detail-card">
                <span>Total In (${income.length})</span>
                <strong class="pos">${formatMoney(totalIn)}</strong>
            </div>
            <div class="detail-card">
                <span>Total Out (${expense.length})</span>
                <strong class="neg">${formatMoney(totalOut)}</strong>
            </div>
            <div class="detail-card">
                <span>Net</span>
                <strong class="${net >= 0 ? "pos" : "neg"}">${formatMoney(net)}</strong>
            </div>
        </div>
        <p class="muted" style="margin:-8px 0 12px;">
            Total Out includes ${formatMoney(totalFees)} in transaction fees.
        </p>
    `;

    if (financeCache.kept > 0) {
        html += `
            <p class="muted" style="margin-bottom:12px;">
                Includes ${financeCache.kept} transaction(s) saved by PayTrack
                whose messages are no longer on this phone.
            </p>
        `;
    }

    if (latest) {
        html += `
            <p class="muted" style="margin-bottom:12px;">
                Latest M-PESA balance:
                <strong>${formatMoney(latest.balance)}</strong>
                (${escapeHtml(latest.date)}${latest.time ? " " + escapeHtml(latest.time) : ""})
            </p>
        `;
    }

    // ---------- Simple bar chart (inline SVG, no library) ----------

    if (monthKeys.length > 0) {

        const barWidth = 28;
        const gap = 14;
        const chartHeight = 140;
        const groupWidth = barWidth * 2 + 6;
        const chartWidth = monthKeys.length * (groupWidth + gap);

        let bars = "";

        monthKeys.forEach((k, i) => {

            const x = i * (groupWidth + gap);
            const inH = (months[k].in / maxVal) * chartHeight;
            const outH = (months[k].out / maxVal) * chartHeight;

            bars += `
                <rect x="${x}" y="${chartHeight - inH}" width="${barWidth}" height="${inH}" fill="#087f5b" rx="3"></rect>
                <rect x="${x + barWidth + 6}" y="${chartHeight - outH}" width="${barWidth}" height="${outH}" fill="#b42318" rx="3"></rect>
                <text x="${x + groupWidth / 2}" y="${chartHeight + 18}" font-size="11" text-anchor="middle" fill="#667085">${escapeHtml(k.slice(5))}</text>
            `;
        });

        html += `
            <h3 class="detail-heading">Last ${monthKeys.length} Month(s)</h3>
            <div class="table-wrap">
                <svg width="${chartWidth}" height="${chartHeight + 30}" viewBox="0 0 ${chartWidth} ${chartHeight + 30}">
                    ${bars}
                </svg>
            </div>
            <p class="muted" style="margin-top:6px;">
                <span style="color:#087f5b;">&#9632;</span> In &nbsp;
                <span style="color:#b42318;">&#9632;</span> Out
            </p>
        `;
    }

    // ---------- Top expense recipients ----------

    if (topExpenses.length > 0) {

        html += `
            <h3 class="detail-heading">Top Outgoing (by recipient)</h3>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr><th>Recipient</th><th>Count</th><th>Total</th></tr>
                    </thead>
                    <tbody>
                        ${topExpenses.map(r => `
                            <tr>
                                <td>${escapeHtml(r.name)}</td>
                                <td>${r.count}</td>
                                <td>${formatMoney(r.total)}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;
    }

    body.innerHTML = html;
}