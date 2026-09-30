/*
    PAYTRACK — STATEMENT IMPORT

    Reads an M-PESA statement (.csv / .txt), finds every "Paid In" row,
    matches it to an employee (by phone number or name in the Details
    column) and records it as a payment. Duplicates are skipped by
    transaction ID.

    Also accepts:
      - semicolon or tab separated statements
      - a .txt file of pasted M-PESA SMS messages (used automatically
        when the file has no "Paid in" column; needs
        mpesa-parser-extended.js / parseMpesaSms)

    PDF files are rejected with a helpful message (PDFs can't be read here).

    Load AFTER app.js:
    <script src="app.js"></script>
    <script src="import.js"></script>
*/


// ==========================================
// CSV LINE SPLITTER (handles "quoted, values")
// ==========================================

function splitCsvLine(line, delimiter) {

    delimiter = delimiter || ",";

    const cells = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {

        const char = line[i];

        if (char === '"') {

            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }

        } else if (char === delimiter && !inQuotes) {

            cells.push(current.trim());
            current = "";

        } else {

            current += char;
        }
    }

    cells.push(current.trim());

    return cells;
}


// Picks , ; or tab by looking at the header row
function detectDelimiter(text) {

    const headerLine =
        text.split(/\r?\n/).find(line =>
            line.toLowerCase().includes("paid in")
        );

    if (!headerLine) return ",";

    const counts = {
        ",": (headerLine.match(/,/g) || []).length,
        ";": (headerLine.match(/;/g) || []).length,
        "\t": (headerLine.match(/\t/g) || []).length
    };

    let best = ",";

    Object.keys(counts).forEach(key => {
        if (counts[key] > counts[best]) best = key;
    });

    return best;
}


// ==========================================
// HELPERS
// ==========================================

function parseAmount(value) {

    const cleaned =
        String(value || "").replace(/[^0-9.\-]/g, "");

    const number = parseFloat(cleaned);

    return isNaN(number) ? 0 : number;
}


function normaliseDate(value) {

    const text = String(value || "").trim();

    // 2026-09-28 or 2026-09-28 14:30:00
    let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);

    if (match) {
        return `${match[1]}-${match[2]}-${match[3]}`;
    }

    // 28/09/2026 or 28-09-2026
    match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);

    if (match) {
        return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
    }

    return "";
}


function last9Digits(phone) {

    const digits = String(phone || "").replace(/\D/g, "");

    return digits.length >= 9 ? digits.slice(-9) : "";
}


function findEmployeeForDetails(details) {

    const text = details.toUpperCase();
    const digitsOnly = details.replace(/\D/g, "");

    // 1. Match by phone number
    for (const employee of employees) {

        const phone = last9Digits(employee.phone);

        if (phone && digitsOnly.includes(phone)) {
            return employee;
        }
    }

    // 2. Match by name (every name part must appear in the details)
    for (const employee of employees) {

        const parts =
            employee.name
                .toUpperCase()
                .split(/\s+/)
                .filter(part => part.length > 1);

        if (
            parts.length > 0 &&
            parts.every(part => text.includes(part))
        ) {
            return employee;
        }
    }

    return null;
}


// ==========================================
// PARSE STATEMENT TEXT (CSV with a "Paid in" column)
// ==========================================

function parseStatement(text) {

    const delimiter = detectDelimiter(text);

    const lines =
        text.split(/\r?\n/).filter(line => line.trim() !== "");

    let columns = {
        receipt: -1,
        date: -1,
        details: -1,
        paidIn: -1
    };

    const rows = [];

    for (const line of lines) {

        const cells = splitCsvLine(line, delimiter);
        const lower = cells.map(cell => cell.toLowerCase());

        // Detect header row
        const paidInIndex =
            lower.findIndex(cell => cell.includes("paid in"));

        if (paidInIndex !== -1) {

            columns.paidIn = paidInIndex;

            columns.receipt =
                lower.findIndex(cell => cell.includes("receipt"));

            columns.date =
                lower.findIndex(cell =>
                    cell.includes("completion") || cell.includes("date")
                );

            columns.details =
                lower.findIndex(cell => cell.includes("details"));

            continue;
        }

        // Skip until we have found a header
        if (columns.paidIn === -1) continue;

        const receipt = cells[columns.receipt] || "";
        const date = normaliseDate(cells[columns.date]);
        const details = cells[columns.details] || "";
        const amount = parseAmount(cells[columns.paidIn]);

        // Only real, incoming payments
        if (!receipt || !date || amount <= 0) continue;

        rows.push({ receipt, date, details, amount });
    }

    return rows;
}


// ==========================================
// PARSE PASTED / EXPORTED M-PESA SMS TEXT
// ==========================================

function parseSmsFileText(text) {

    if (typeof parseMpesaSms !== "function") return [];

    try {

        return parseMpesaSms(text).map(row => ({
            receipt: row.receipt,
            date: row.date,
            details: row.details || "",
            amount: row.amount
        }));

    } catch (error) {

        console.warn("PayTrack import: SMS parse failed", error);
        return [];
    }
}


// ==========================================
// IMPORT
// ==========================================

function importStatementText(text) {

    let rows = parseStatement(text);
    let source = "statement";

    // No "Paid in" column? Try reading it as M-PESA SMS messages.
    if (rows.length === 0) {
        rows = parseSmsFileText(text);
        source = "sms";
    }

    if (rows.length === 0) {

        alert(
            "No incoming payments found.\n\n" +
            "The file should be either:\n" +
            "• a CSV statement with a 'Paid in' column, or\n" +
            "• a text file of M-PESA messages (\"... Confirmed. " +
            "You have received Ksh...\")."
        );

        return;
    }

    const existingIds =
        new Set(
            payments
                .map(payment => payment.transactionId)
                .filter(Boolean)
        );

    let imported = 0;
    let duplicates = 0;
    const unmatched = [];

    rows.forEach(row => {

        if (existingIds.has(row.receipt)) {
            duplicates++;
            return;
        }

        const employee = findEmployeeForDetails(row.details);

        if (!employee) {
            unmatched.push(row);
            return;
        }

        payments.push({

            id:
                Date.now().toString() +
                Math.random().toString(36).slice(2, 7),

            employeeId: employee.id,

            amount: row.amount,

            date: row.date,

            transactionId: row.receipt

        });

        existingIds.add(row.receipt);
        imported++;
    });

    saveData();
    render();

    let message =
        `Import complete\n` +
        (source === "sms"
            ? "(read as M-PESA SMS messages)\n"
            : "") +
        `\n` +
        `Imported: ${imported}\n` +
        `Already recorded (skipped): ${duplicates}\n` +
        `No matching employee: ${unmatched.length}`;

    if (unmatched.length > 0) {

        message += "\n\nUnmatched payments:\n";

        unmatched.slice(0, 8).forEach(row => {
            message +=
                `• ${row.date}  ${formatMoney(row.amount)}  ` +
                `${row.details.slice(0, 40)}\n`;
        });

        if (unmatched.length > 8) {
            message += `…and ${unmatched.length - 8} more`;
        }

        message +=
            "\nTip: add the employee's phone number or full name " +
            "exactly as it appears on the statement, then import again.";
    }

    alert(message);
}


// ==========================================
// FILE INPUT LISTENER
// ==========================================

document.getElementById(
    "statementFile"
).addEventListener(
    "change",
    function(event) {

        const file = event.target.files[0];

        if (!file) return;

        // PDFs can't be read as text
        const isPdf =
            file.type === "application/pdf" ||
            /\.pdf$/i.test(file.name);

        if (isPdf) {

            alert(
                "PDF statements can't be imported.\n\n" +
                "Try one of these instead:\n" +
                "• Export the statement as CSV (from the M-PESA app or " +
                "a converter) and import that.\n" +
                "• Use 'Sync All SMS' to read the messages already on " +
                "this phone."
            );

            this.value = "";
            return;
        }

        if (employees.length === 0) {

            alert("Please add an employee first.");
            this.value = "";
            return;
        }

        const reader = new FileReader();

        reader.onload = () => {
            importStatementText(reader.result);
        };

        reader.onerror = () => {
            alert("Could not read that file.");
        };

        reader.readAsText(file);

        // Allow importing the same file again later
        this.value = "";
    }
);