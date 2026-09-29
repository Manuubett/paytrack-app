/*
    PAYTRACK — INCOME VS EXPENSE DASHBOARD

    Reads the full SMS inbox (via window.syncAllMpesaSms, already
    used by sms-groups.js) and classifies every message as:
      - income   (parseMpesaSms     -> "received")
      - expense  (parseMpesaOutgoing -> "sent"/"paid"/"withdrawn")

    Renders a simple summary + breakdown, no chart library needed.
*/

let financeCache = { income: [], expense: [] };


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


async function syncFinance() {

    const body = document.getElementById("financeBody");
    if (!body) return;

    if (
        !window.Capacitor ||
        typeof window.Capacitor.isNativePlatform !== "function" ||
        !window.Capacitor.isNativePlatform()
    ) {
        body.innerHTML =
            "<p class='muted'>This only works inside the Android app.</p>";
        return;
    }

    if (typeof window.syncAllMpesaSms !== "function") {
        body.innerHTML =
            "<p class='muted'>SMS bridge is not available. Please restart the app.</p>";
        return;
    }

    try {

        const raw = await window.syncAllMpesaSms();

        if (!Array.isArray(raw)) {
            throw new Error("Invalid SMS response.");
        }

        const income = [];
        const expense = [];

        raw.forEach(message => {

            if (!message || !message.body) return;

            try {

                parseMpesaSms(message.body).forEach(row => {
                    income.push(row);
                });

            } catch (e) {}

            try {

                parseMpesaOutgoing(message.body).forEach(row => {
                    expense.push(row);
                });

            } catch (e) {}
        });

        financeCache = { income, expense };

        console.log(
            "PayTrack Finance: income rows:", income.length,
            "expense rows:", expense.length
        );

        renderFinance();

    } catch (error) {

        console.error("PayTrack Finance sync failed:", error);

        body.innerHTML =
            "<p class='muted'>Could not read SMS: " +
            escapeHtml(error.message || "Unknown error") +
            "</p>";
    }
}


function monthKey(iso) {
    return (iso || "").slice(0, 7); // "YYYY-MM"
}


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
    const totalOut = expense.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const net = totalIn - totalOut;

    // ---------- Group expenses by recipient ----------

    const byRecipient = {};

    expense.forEach(row => {
        const key = (row.recipient || "Unknown").trim();
        if (!byRecipient[key]) byRecipient[key] = { name: key, total: 0, count: 0 };
        byRecipient[key].total += Number(row.amount) || 0;
        byRecipient[key].count++;
    });

    const topExpenses = Object.values(byRecipient)
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);

    // ---------- Group by month (last 6 months) ----------

    const months = {};

    income.forEach(r => {
        const k = monthKey(r.date);
        if (!months[k]) months[k] = { in: 0, out: 0 };
        months[k].in += Number(r.amount) || 0;
    });

    expense.forEach(r => {
        const k = monthKey(r.date);
        if (!months[k]) months[k] = { in: 0, out: 0 };
        months[k].out += Number(r.amount) || 0;
    });

    const monthKeys = Object.keys(months).sort().slice(-6);
    const maxVal = Math.max(
        1,
        ...monthKeys.map(k => Math.max(months[k].in, months[k].out))
    );

    let html = `
        <div class="detail-summary">
            <div class="detail-card">
                <span>Total In</span>
                <strong class="pos">${formatMoney(totalIn)}</strong>
            </div>
            <div class="detail-card">
                <span>Total Out</span>
                <strong class="neg">${formatMoney(totalOut)}</strong>
            </div>
            <div class="detail-card">
                <span>Net</span>
                <strong class="${net >= 0 ? "pos" : "neg"}">${formatMoney(net)}</strong>
            </div>
        </div>
    `;

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