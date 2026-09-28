/*
    PAYTRACK
    Payment Reconciliation System

    Version 2
    - Expected vs received ledger
    - Missing / late payment detection
    - Outstanding total on dashboard
    - Printable employee report
*/


// ==========================================
// DATA
// ==========================================

let employees =
    JSON.parse(localStorage.getItem("paytrack_employees")) || [];

let payments =
    JSON.parse(localStorage.getItem("paytrack_payments")) || [];


function saveData() {

    localStorage.setItem(
        "paytrack_employees",
        JSON.stringify(employees)
    );

    localStorage.setItem(
        "paytrack_payments",
        JSON.stringify(payments)
    );
}


// ==========================================
// HELPERS
// ==========================================

function formatMoney(amount) {

    return "KSh " +
        Number(amount || 0).toLocaleString(
            "en-KE",
            {
                minimumFractionDigits: 0,
                maximumFractionDigits: 2
            }
        );
}


function escapeHtml(text) {

    return String(text ?? "").replace(
        /[&<>"']/g,
        char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[char])
    );
}


// ---------- Dates (all stored as YYYY-MM-DD, local time) ----------

function toISO(date) {

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");

    return `${y}-${m}-${d}`;
}


function todayISO() {
    return toISO(new Date());
}


function parseISO(iso) {

    const [y, m, d] = iso.split("-").map(Number);

    return new Date(y, m - 1, d);
}


function addDays(iso, days) {

    const date = parseISO(iso);

    date.setDate(date.getDate() + days);

    return toISO(date);
}


function daysBetween(fromIso, toIso) {

    return Math.round(
        (parseISO(toIso) - parseISO(fromIso)) / 86400000
    );
}


function formatDate(iso) {

    return parseISO(iso).toLocaleDateString(
        "en-GB",
        {
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    );
}


function frequencyLabel(frequency) {

    return frequency
        ? `Every ${frequency} days`
        : "No fixed schedule";
}


// ==========================================
// MODALS
// ==========================================

function openEmployeeModal() {

    document.getElementById("startDate").value =
        todayISO();

    document.getElementById(
        "employeeModal"
    ).style.display = "flex";
}


function closeEmployeeModal() {

    document.getElementById(
        "employeeModal"
    ).style.display = "none";
}


function openPaymentModal() {

    if (employees.length === 0) {

        alert("Please add an employee first.");

        return;
    }


    const select =
        document.getElementById("paymentEmployee");

    select.innerHTML = "";

    employees.forEach(employee => {

        const option =
            document.createElement("option");

        option.value = employee.id;

        option.textContent = employee.name;

        select.appendChild(option);
    });


    document.getElementById("paymentDate").value =
        todayISO();

    document.getElementById(
        "paymentModal"
    ).style.display = "flex";
}


function closePaymentModal() {

    document.getElementById(
        "paymentModal"
    ).style.display = "none";
}


function closeDetailsModal() {

    document.getElementById(
        "detailsModal"
    ).style.display = "none";
}


// ==========================================
// ADD EMPLOYEE
// ==========================================

document.getElementById(
    "employeeForm"
).addEventListener(
    "submit",
    function(event) {

        event.preventDefault();

        const employee = {

            id: Date.now().toString(),

            name:
                document.getElementById(
                    "employeeName"
                ).value.trim(),

            phone:
                document.getElementById(
                    "employeePhone"
                ).value.trim(),

            expectedAmount:
                Number(
                    document.getElementById(
                        "expectedAmount"
                    ).value
                ),

            frequency:
                Number(
                    document.getElementById(
                        "paymentFrequency"
                    ).value
                ),

            // Date the FIRST payment was/is due
            startDate:
                document.getElementById(
                    "startDate"
                ).value || todayISO(),

            createdAt: new Date().toISOString()
        };

        employees.push(employee);

        saveData();

        this.reset();

        closeEmployeeModal();

        render();
    }
);


// ==========================================
// ADD PAYMENT
// ==========================================

document.getElementById(
    "paymentForm"
).addEventListener(
    "submit",
    function(event) {

        event.preventDefault();

        const transactionId =
            document.getElementById(
                "transactionId"
            ).value.trim().toUpperCase();


        // Warn about duplicate M-PESA codes
        if (
            transactionId &&
            payments.some(
                payment =>
                    payment.transactionId === transactionId
            )
        ) {

            alert(
                "A payment with this transaction ID " +
                "is already recorded."
            );

            return;
        }


        payments.push({

            id: Date.now().toString(),

            employeeId:
                document.getElementById(
                    "paymentEmployee"
                ).value,

            amount:
                Number(
                    document.getElementById(
                        "paymentAmount"
                    ).value
                ),

            date:
                document.getElementById(
                    "paymentDate"
                ).value,

            transactionId: transactionId
        });

        saveData();

        this.reset();

        closePaymentModal();

        render();
    }
);


// ==========================================
// LEDGER CALCULATIONS
// ==========================================

function getEmployeePayments(employeeId) {

    return payments.filter(
        payment =>
            payment.employeeId === employeeId
    );
}


function getEmployeeTotal(employeeId) {

    return getEmployeePayments(employeeId).reduce(
        (total, payment) =>
            total + Number(payment.amount),
        0
    );
}


/*
    Builds the full ledger for one employee.

    Due dates start on the employee's first due date and repeat
    every `frequency` days up to today.

    Each payment (oldest first) is matched to the earliest unpaid
    due date. A payment may arrive up to half a cycle early and
    still count for that due date.
*/
function getLedger(employee) {

    const employeePayments =
        getEmployeePayments(employee.id)
            .slice()
            .sort((a, b) => a.date.localeCompare(b.date));

    const total =
        employeePayments.reduce(
            (sum, payment) =>
                sum + Number(payment.amount),
            0
        );

    const ledger = {
        payments: employeePayments,
        total: total,
        hasSchedule: false,
        schedule: [],
        extras: [],
        expectedCount: 0,
        expectedTotal: 0,
        difference: 0,
        missingCount: 0,
        lateCount: 0
    };


    if (!employee.frequency) {
        return ledger;
    }


    const start =
        employee.startDate ||
        toISO(new Date(employee.createdAt || Date.now()));

    const today = todayISO();

    const tolerance = Math.floor(employee.frequency / 2);


    // Every due date from start until today
    const schedule = [];

    for (
        let due = start;
        due <= today;
        due = addDays(due, employee.frequency)
    ) {
        schedule.push({ due: due, payment: null });
    }


    // Match payments to due dates
    employeePayments.forEach(payment => {

        const slot = schedule.find(
            item =>
                !item.payment &&
                item.due <= addDays(payment.date, tolerance)
        );

        if (slot) {
            slot.payment = payment;
        } else {
            ledger.extras.push(payment);
        }
    });


    // Work out status of each due date
    schedule.forEach(item => {

        if (!item.payment) {

            item.status =
                item.due === today ? "due" : "missing";

            ledger.missingCount++;

            return;
        }

        const daysLate =
            daysBetween(item.due, item.payment.date);

        if (daysLate > tolerance) {

            item.status = "late";
            item.daysLate = daysLate;
            ledger.lateCount++;

        } else {

            item.status = "paid";
        }
    });


    ledger.hasSchedule = true;
    ledger.schedule = schedule;
    ledger.expectedCount = schedule.length;

    ledger.expectedTotal =
        schedule.length * employee.expectedAmount;

    ledger.difference =
        ledger.expectedTotal - total;

    return ledger;
}


function describeDifference(difference) {

    if (difference > 0) {
        return {
            text: `${formatMoney(difference)} short`,
            css: "neg"
        };
    }

    if (difference < 0) {
        return {
            text: `${formatMoney(-difference)} ahead`,
            css: "pos"
        };
    }

    return { text: "Fully paid", css: "ok" };
}


// ==========================================
// DELETE
// ==========================================

function deleteEmployee(employeeId) {

    const employee =
        employees.find(
            item => item.id === employeeId
        );

    if (!employee) return;

    const confirmed =
        confirm(
            `Delete ${employee.name} and all their payments?`
        );

    if (!confirmed) return;

    employees =
        employees.filter(
            item => item.id !== employeeId
        );

    payments =
        payments.filter(
            payment =>
                payment.employeeId !== employeeId
        );

    saveData();

    render();
}


function deletePayment(paymentId, employeeId) {

    if (!confirm("Delete this payment?")) return;

    payments =
        payments.filter(
            payment => payment.id !== paymentId
        );

    saveData();

    render();

    viewEmployee(employeeId);
}


// ==========================================
// VIEW EMPLOYEE (LEDGER + REPORT)
// ==========================================

function viewEmployee(employeeId) {

    const employee =
        employees.find(
            item => item.id === employeeId
        );

    if (!employee) return;

    const ledger = getLedger(employee);


    document.getElementById("detailsName").textContent =
        employee.name;


    // ---------- Summary cards ----------

    let html = `

        <div class="print-only report-meta">
            PayTrack report generated on
            ${formatDate(todayISO())}
        </div>

        <div class="detail-summary">

            <div class="detail-card">
                <span>Expected Payment</span>
                <strong>${formatMoney(employee.expectedAmount)}</strong>
            </div>

            <div class="detail-card">
                <span>Frequency</span>
                <strong>${frequencyLabel(employee.frequency)}</strong>
            </div>

            <div class="detail-card">
                <span>Payments Found</span>
                <strong>${ledger.payments.length}</strong>
            </div>

            <div class="detail-card">
                <span>Total Received</span>
                <strong>${formatMoney(ledger.total)}</strong>
            </div>
    `;


    if (ledger.hasSchedule) {

        const diff = describeDifference(ledger.difference);

        html += `

            <div class="detail-card">
                <span>
                    Expected
                    (${ledger.expectedCount} payments
                    since ${formatDate(
                        employee.startDate ||
                        toISO(new Date(employee.createdAt))
                    )})
                </span>
                <strong>${formatMoney(ledger.expectedTotal)}</strong>
            </div>

            <div class="detail-card">
                <span>Difference</span>
                <strong class="${diff.css}">${diff.text}</strong>
            </div>
        `;
    }

    html += `</div>`;


    html += `
        <button
            class="secondary-btn no-print"
            style="margin-bottom:20px;"
            onclick="window.print()"
        >
            🖨 Print / Save Report
        </button>
    `;


    // ---------- Missing & late ----------

    if (ledger.hasSchedule) {

        const problems =
            ledger.schedule.filter(
                item => item.status !== "paid"
            );

        html += `
            <h3 class="detail-heading">
                Missing &amp; Late Payments
            </h3>
        `;

        if (problems.length === 0) {

            html += `
                <p class="muted">
                    No missing or late payments.
                </p>
            `;

        } else {

            html += `
                <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Due Date</th>
                            <th>Status</th>
                            <th>Paid On</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            problems.forEach(item => {

                let label = "";
                let css = "";

                if (item.status === "missing") {
                    label = "Missing";
                    css = "neg";
                } else if (item.status === "due") {
                    label = "Due today";
                    css = "warn";
                } else {
                    label = `Late by ${item.daysLate} days`;
                    css = "warn";
                }

                html += `
                    <tr>
                        <td>${formatDate(item.due)}</td>
                        <td class="${css}">${label}</td>
                        <td>
                            ${
                                item.payment
                                ? formatDate(item.payment.date)
                                : "-"
                            }
                        </td>
                    </tr>
                `;
            });

            html += `
                    </tbody>
                </table>
                </div>
            `;
        }

        if (ledger.extras.length > 0) {

            html += `
                <p class="muted" style="margin-top:8px;">
                    ${ledger.extras.length} payment(s) did not match
                    any due date (made before the start date or
                    beyond the schedule).
                </p>
            `;
        }
    }


    // ---------- Payment history ----------

    html += `
        <h3 class="detail-heading">
            Payment History
        </h3>
    `;

    if (ledger.payments.length === 0) {

        html += `
            <p class="muted">No payments recorded yet.</p>
        `;

    } else {

        html += `
            <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Amount</th>
                        <th>Transaction ID</th>
                        <th class="no-print"></th>
                    </tr>
                </thead>
                <tbody>
        `;

        ledger.payments
            .slice()
            .reverse()
            .forEach(payment => {

                html += `
                    <tr>
                        <td>${formatDate(payment.date)}</td>
                        <td>${formatMoney(payment.amount)}</td>
                        <td>
                            ${escapeHtml(payment.transactionId) || "-"}
                        </td>
                        <td class="no-print">
                            <button
                                class="delete-btn small-btn"
                                onclick="deletePayment('${payment.id}', '${employee.id}')"
                            >
                                ×
                            </button>
                        </td>
                    </tr>
                `;
            });

        html += `
                </tbody>
            </table>
            </div>
        `;
    }


    document.getElementById("detailsContent").innerHTML =
        html;

    document.getElementById("detailsModal").style.display =
        "flex";
}


// ==========================================
// RENDER DASHBOARD
// ==========================================

function render() {

    const employeeList =
        document.getElementById("employeeList");

    const emptyState =
        document.getElementById("emptyState");


    // ---------- Summary ----------

    document.getElementById("employeeCount").textContent =
        employees.length;

    document.getElementById("paymentCount").textContent =
        payments.length;

    const totalReceived =
        payments.reduce(
            (total, payment) =>
                total + Number(payment.amount),
            0
        );

    document.getElementById("totalReceived").textContent =
        formatMoney(totalReceived);


    // Outstanding = what is still owed across all employees
    // with a payment schedule (overpayments don't offset others)
    const ledgers =
        employees.map(employee => ({
            employee: employee,
            ledger: getLedger(employee)
        }));

    const outstanding =
        ledgers.reduce(
            (total, item) =>
                total + Math.max(0, item.ledger.difference),
            0
        );

    document.getElementById("totalOutstanding").textContent =
        formatMoney(outstanding);


    // ---------- Employee list ----------

    employeeList.innerHTML = "";

    if (employees.length === 0) {

        emptyState.style.display = "block";

        return;
    }

    emptyState.style.display = "none";


    ledgers.forEach(({ employee, ledger }) => {

        let statusHtml = "";

        if (ledger.hasSchedule) {

            const diff = describeDifference(ledger.difference);

            statusHtml = `
                <p>
                    Expected ${formatMoney(ledger.expectedTotal)}
                    &middot;
                    <span class="${diff.css}">${diff.text}</span>
                </p>
            `;

            if (ledger.missingCount > 0) {

                statusHtml += `
                    <p class="neg">
                        ${ledger.missingCount} payment(s) missing
                    </p>
                `;
            }
        }

        const div = document.createElement("div");

        div.className = "employee";

        div.innerHTML = `

            <div class="employee-info">

                <h3>${escapeHtml(employee.name)}</h3>

                <p>
                    ${escapeHtml(employee.phone) || "No phone number"}
                </p>

                <p>
                    Expected:
                    ${formatMoney(employee.expectedAmount)}
                    &middot;
                    ${frequencyLabel(employee.frequency)}
                </p>

            </div>


            <div>

                <div class="employee-total">
                    ${formatMoney(ledger.total)}
                </div>

                <div class="employee-info">

                    <p>${ledger.payments.length} payment(s)</p>

                    ${statusHtml}

                </div>

            </div>


            <div class="employee-buttons">

                <button
                    class="view-btn"
                    onclick="viewEmployee('${employee.id}')"
                >
                    View
                </button>

                <button
                    class="delete-btn"
                    onclick="deleteEmployee('${employee.id}')"
                >
                    Delete
                </button>

            </div>

        `;

        employeeList.appendChild(div);
    });
}


// ==========================================
// INITIAL LOAD
// ==========================================

render();