/*
    PAYTRACK - SMS IMPORT (paste-SMS modal + employee matching)
    Load order: app.js, import.js, sms.js, sms-parser.js, android-bridge.js
    parseMpesaSms() comes from sms-parser.js.
*/

let smsRows = [];


function openSmsModal() {
    document.getElementById("smsModal").style.display = "flex";
    document.getElementById("smsPreview").innerHTML = "";
    document.getElementById("smsImportBtn").style.display = "none";
    smsRows = [];
}

function closeSmsModal() {
    document.getElementById("smsModal").style.display = "none";
    document.getElementById("smsText").value = "";
}


// Returns ONE employee, or null if none or ambiguous
function matchSmsEmployee(details) {

    const key = typeof senderKeyFor === "function"
        ? senderKeyFor(details, "")
        : null;

    if (key) {
        const linked = employees.find(e =>
            Array.isArray(e.smsLinks) && e.smsLinks.includes(key)
        );
        if (linked) return linked;
    }

    const text = (details || "").toUpperCase();
    // ... rest of the function stays the same
    const digits = text.replace(/\D/g, "");

    // 1. Full phone number
    const byPhone = employees.filter(e => {
        const p = last9Digits(e.phone);
        return p && digits.includes(p);
    });
    if (byPhone.length === 1) return byPhone[0];
    if (byPhone.length > 1) return null;

    // 2. Masked number, e.g. 0712***678 or 254712***678
    const masked = text.match(/(\d{3,})\*+(\d{3})/);
    if (masked) {
        const prefix = masked[1].slice(-6);
        const suffix = masked[2];
        const byMask = employees.filter(e => {
            const p = last9Digits(e.phone);
            return p && p.startsWith(prefix.slice(-Math.min(prefix.length, 6))) && p.endsWith(suffix);
        });
        if (byMask.length === 1) return byMask[0];
        if (byMask.length > 1) return null;
    }

    // 3. Name: every word of the employee's name appears in the SMS
    const byName = employees.filter(e => {
        const words = (e.name || "").toUpperCase().split(/\s+/).filter(w => w.length > 1);
        return words.length > 0 && words.every(w => text.includes(w));
    });
    if (byName.length === 1) return byName[0];

    return null;
}


function readSmsMessages() {

    const text = document.getElementById("smsText").value;
    const preview = document.getElementById("smsPreview");
    const importBtn = document.getElementById("smsImportBtn");

    smsRows = parseMpesaSms(text);

    if (smsRows.length === 0) {
        preview.innerHTML =
            "<p>No received-money M-PESA messages found.</p>";
        importBtn.style.display = "none";
        return;
    }

    const recorded = new Set(
        payments.map(p => p.transactionId).filter(Boolean)
    );

    preview.innerHTML = smsRows.map((row, i) => {

        const duplicate = recorded.has(row.receipt);
        const match = matchSmsEmployee(row.details);

        const options =
            `<option value="">-- choose employee --</option>` +
            employees.map(e =>
                `<option value="${escapeHtml(String(e.id))}"` +
                `${match && match.id === e.id ? " selected" : ""}>` +
                `${escapeHtml(e.name)}</option>`
            ).join("");

        return `
            <div style="border:1px solid #ddd;border-radius:8px;padding:10px;margin:8px 0;${duplicate ? "opacity:.5;" : ""}">
                <label style="display:flex;gap:8px;align-items:center;">
                    <input type="checkbox" id="smsRow${i}"
                        ${duplicate ? "disabled" : "checked"}>
                    <strong>${escapeHtml(row.receipt)}</strong>
                    &nbsp;${formatMoney(row.amount)}
                </label>
                <div style="font-size:13px;margin:4px 0;">
                    ${escapeHtml(row.details)}<br>
                    ${escapeHtml(row.date)} ${escapeHtml(row.time)}
                    ${duplicate ? "<br><em>Already recorded</em>" : ""}
                </div>
                <select id="smsEmp${i}" ${duplicate ? "disabled" : ""}>
                    ${options}
                </select>
            </div>`;
    }).join("");

    importBtn.style.display = "block";
}


function importSmsMessages() {

    let added = 0;
    let skipped = 0;

    smsRows.forEach((row, i) => {

        const box = document.getElementById("smsRow" + i);
        if (!box || !box.checked) return;

        const empId = document.getElementById("smsEmp" + i).value;
        const employee = employees.find(e => String(e.id) === empId);

        if (!employee) { skipped++; return; }

        payments.push({
            id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
            employeeId: employee.id,
            amount: row.amount,
            date: row.date,
            time: row.time,
            balance: row.balance,
            transactionId: row.receipt
        });

        added++;
    });

    saveData();
    render();
    closeSmsModal();

    alert(
        added + " payment(s) imported." +
        (skipped ? " " + skipped + " skipped (no employee chosen)." : "")
    );
}