/*
    PAYTRACK - SMS SENDER GROUPS (Truecaller-style)

    Reads the ENTIRE M-PESA inbox (native), groups messages by sender,
    and lets the user link each sender to an employee.

    employee.smsLinks = ["254712345678", "JOHN KIPKORIR", ...]
    Once linked, all past + future messages from that sender key
    are recognised automatically (see senderKeyFor() used elsewhere).
*/

let smsGroupsCache = [];


// ---------- Key used to group/match a sender ----------

function senderKeyFor(details, address) {

    const fromDigits = last9Digits(details || "");
    if (fromDigits) return fromDigits;

    const addrDigits = last9Digits(address || "");
    if (addrDigits) return addrDigits;

    const name = (details || "").trim().toUpperCase();
    if (name) return name;

    return (address || "UNKNOWN").toUpperCase();
}


function findEmployeeBySmsKey(key) {

    if (!key) return null;

    return employees.find(e =>
        Array.isArray(e.smsLinks) && e.smsLinks.includes(key)
    ) || null;
}


// ---------- Open / close ----------

function openSmsGroupsModal() {

    document.getElementById("smsGroupsModal").style.display = "flex";
    document.getElementById("smsGroupsList").innerHTML =
        "<p class='muted'>Reading SMS inbox...</p>";

    syncSmsGroups();
}

function closeSmsGroupsModal() {
    document.getElementById("smsGroupsModal").style.display = "none";
}


// ---------- Pull entire inbox, group by sender ----------

async function syncSmsGroups() {

    const list = document.getElementById("smsGroupsList");

    if (
        !window.Capacitor ||
        !Capacitor.isNativePlatform ||
        !Capacitor.isNativePlatform()
    ) {
        list.innerHTML =
            "<p class='muted'>SMS reading only works on the Android app, not in a browser.</p>";
        return;
    }

    try {

        const Sms = Capacitor.registerPlugin("PayTrackSms");

        const status = await Sms.checkPermissions();
        if (status.sms !== "granted") {
            const req = await Sms.requestPermissions();
            if (req.sms !== "granted") {
                list.innerHTML =
                    "<p class='muted'>SMS permission was not granted. " +
                    "Enable it in Settings &gt; Apps &gt; PayTrack &gt; Permissions.</p>";
                return;
            }
        }

        const result = await Sms.getAllMpesaSms();
        const raw = result.messages || [];

        const recorded = new Set(
            payments.map(p => p.transactionId).filter(Boolean)
        );

        const groups = {};

        raw.forEach(msg => {

            parseMpesaSms(msg.body).forEach(row => {

                const key = senderKeyFor(row.details, msg.address);

                if (!groups[key]) {
                    groups[key] = {
                        key: key,
                        display: row.details || msg.address || "Unknown",
                        rows: [],
                        total: 0,
                        newCount: 0
                    };
                }

                groups[key].rows.push(row);
                groups[key].total += row.amount;

                if (!recorded.has(row.receipt)) {
                    groups[key].newCount++;
                }
            });
        });

        smsGroupsCache = Object.values(groups).sort(
            (a, b) => b.total - a.total
        );

        renderSmsGroups();

    } catch (error) {

        console.error("SMS sync failed", error);

        list.innerHTML =
            "<p class='muted'>Could not read SMS: " + escapeHtml(error.message || "") + "</p>";
    }
}


// ---------- Render the group list ----------

function renderSmsGroups() {

    const list = document.getElementById("smsGroupsList");

    if (smsGroupsCache.length === 0) {
        list.innerHTML = "<p class='muted'>No M-PESA messages found on this phone.</p>";
        return;
    }

    list.innerHTML = smsGroupsCache.map((group, i) => {

        const linkedEmployee = findEmployeeBySmsKey(group.key);

        return `
            <div class="sms-group-card">

                <div class="sms-group-info">
                    <strong>${escapeHtml(group.display)}</strong>
                    <p>
                        ${group.rows.length} message(s)
                        &middot; ${formatMoney(group.total)}
                        ${group.newCount > 0
                            ? ` &middot; <span class="neg">${group.newCount} new</span>`
                            : ""}
                    </p>
                    ${linkedEmployee
                        ? `<p class="ok">Linked to ${escapeHtml(linkedEmployee.name)}</p>`
                        : ""}
                </div>

                <div class="sms-group-actions">

                    <select id="smsGroupSelect${i}">
                        <option value="">-- link to employee --</option>
                        ${employees.map(e =>
                            `<option value="${escapeHtml(String(e.id))}"
                                ${linkedEmployee && linkedEmployee.id === e.id ? "selected" : ""}>
                                ${escapeHtml(e.name)}
                            </option>`
                        ).join("")}
                    </select>

                    <button class="secondary-btn" onclick="linkSmsGroup(${i})">
                        Link
                    </button>

                    <button class="secondary-btn" onclick="createEmployeeFromSmsGroup(${i})">
                        + New Employee
                    </button>

                    <button class="secondary-btn" onclick="importSmsGroup(${i})">
                        Import Payments
                    </button>

                </div>

            </div>
        `;
    }).join("");
}


// ---------- Link an existing employee to this sender ----------

function linkSmsGroup(index) {

    const group = smsGroupsCache[index];
    const empId = document.getElementById("smsGroupSelect" + index).value;

    if (!empId) {
        alert("Choose an employee first.");
        return;
    }

    const employee = employees.find(e => String(e.id) === empId);
    if (!employee) return;

    if (!Array.isArray(employee.smsLinks)) employee.smsLinks = [];

    if (!employee.smsLinks.includes(group.key)) {
        employee.smsLinks.push(group.key);
    }

    saveData();
    renderSmsGroups();

    alert(`Linked "${group.display}" to ${employee.name}.`);
}


// ---------- Create a brand-new employee from this sender's info ----------

function createEmployeeFromSmsGroup(index) {

    const group = smsGroupsCache[index];

    openEmployeeModal();

    document.getElementById("employeeName").value =
        /^[0-9+]+$/.test(group.key) ? "" : group.display;

    document.getElementById("employeePhone").value =
        /^[0-9]{6,}$/.test(group.key) ? group.key : "";

    window._pendingSmsLink = group.key;
}


document.addEventListener("DOMContentLoaded", () => {

    const form = document.getElementById("employeeForm");
    if (!form) return;

    form.addEventListener("submit", () => {

        if (!window._pendingSmsLink) return;

        setTimeout(() => {

            const newest = employees[employees.length - 1];
            if (!newest) return;

            if (!Array.isArray(newest.smsLinks)) newest.smsLinks = [];
            newest.smsLinks.push(window._pendingSmsLink);

            saveData();

            window._pendingSmsLink = null;

            if (document.getElementById("smsGroupsModal").style.display === "flex") {
                renderSmsGroups();
            }

        }, 0);
    });
});


// ---------- Import all not-yet-recorded payments for one sender ----------

function importSmsGroup(index) {

    const group = smsGroupsCache[index];
    const employee = findEmployeeBySmsKey(group.key);

    if (!employee) {
        alert("Link this sender to an employee first.");
        return;
    }

    const existing = new Set(
        payments.map(p => p.transactionId).filter(Boolean)
    );

    let added = 0;

    group.rows.forEach(row => {

        if (existing.has(row.receipt)) return;

        payments.push({
            id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
            employeeId: employee.id,
            amount: row.amount,
            date: row.date,
            time: row.time,
            balance: row.balance,
            transactionId: row.receipt
        });

        existing.add(row.receipt);
        added++;
    });

    saveData();
    render();
    renderSmsGroups();

       alert(`${added} payment(s) imported for ${employee.name}.`);
}