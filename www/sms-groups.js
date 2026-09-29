/*
    PAYTRACK - SMS SENDER GROUPS

    Reads the ENTIRE M-PESA inbox through android-bridge.js,
    groups messages by sender, and lets the user link each
    sender to an employee.

    Flow:

        Sync All SMS
             ↓
        syncAllMpesaSms()
             ↓
        getAllMpesaSms()
             ↓
        parse M-PESA messages
             ↓
        group by sender
             ↓
        link sender to employee
*/


let smsGroupsCache = [];


// ============================================================
// SENDER KEY
// ============================================================

function senderKeyFor(details, address) {

    const fromDigits =
        last9Digits(details || "");

    if (fromDigits) {
        return fromDigits;
    }


    const addrDigits =
        last9Digits(address || "");

    if (addrDigits) {
        return addrDigits;
    }


    const name =
        String(details || "")
            .trim()
            .toUpperCase();

    if (name) {
        return name;
    }


    return String(address || "UNKNOWN")
        .toUpperCase();
}


// ============================================================
// FIND LINKED EMPLOYEE
// ============================================================

function findEmployeeBySmsKey(key) {

    if (!key) {
        return null;
    }


    return employees.find(employee =>
        Array.isArray(employee.smsLinks) &&
        employee.smsLinks.includes(key)
    ) || null;
}


// ============================================================
// OPEN / CLOSE MODAL
// ============================================================

function openSmsGroupsModal() {

    const modal =
        document.getElementById("smsGroupsModal");

    const list =
        document.getElementById("smsGroupsList");


    if (!modal || !list) {
        return;
    }


    modal.style.display = "flex";


    list.innerHTML =
        "<p class='muted'>Reading M-PESA SMS inbox...</p>";


    syncSmsGroups();
}


function closeSmsGroupsModal() {

    const modal =
        document.getElementById("smsGroupsModal");


    if (modal) {
        modal.style.display = "none";
    }
}


// ============================================================
// READ ENTIRE SMS INBOX
// ============================================================

async function syncSmsGroups() {

    const list =
        document.getElementById("smsGroupsList");


    if (!list) {
        return;
    }

<<<<<<< HEAD
=======

    // --------------------------------------------------------
    // Confirm Android / Capacitor
    // --------------------------------------------------------

    if (
        !window.Capacitor ||
        typeof window.Capacitor.isNativePlatform !==
            "function" ||
        !window.Capacitor.isNativePlatform()
    ) {

        list.innerHTML =
            "<p class='muted'>" +
            "SMS reading only works inside the Android app." +
            "</p>";

        return;
    }


    // --------------------------------------------------------
    // Confirm bridge is loaded
    // --------------------------------------------------------

    if (
        typeof window.syncAllMpesaSms !==
        "function"
    ) {

        list.innerHTML =
            "<p class='muted'>" +
            "SMS bridge is not available. " +
            "Please restart the app." +
            "</p>";

        console.error(
            "PayTrack: syncAllMpesaSms() is unavailable."
        );

        return;
    }


>>>>>>> 995a3d310049e37b7173607bcea13d2dd26e99e1
    try {

        list.innerHTML =
            "<p class='muted'>" +
            "Reading M-PESA messages..." +
            "</p>";


        // ----------------------------------------------------
        // Ask android-bridge.js for the complete inbox
        // ----------------------------------------------------

        const raw =
            await window.syncAllMpesaSms();


        if (!Array.isArray(raw)) {

            throw new Error(
                "Invalid SMS response."
            );
        }


        console.log(
            "PayTrack: SMS messages received:",
            raw.length
        );


        // ----------------------------------------------------
        // Existing recorded transactions
        // ----------------------------------------------------

        const recorded =
            new Set(
                payments
                    .map(payment =>
                        payment.transactionId
                    )
                    .filter(Boolean)
            );


        // ----------------------------------------------------
        // Group messages
        // ----------------------------------------------------

        const groups = {};


        raw.forEach(message => {

            if (
                !message ||
                !message.body
            ) {
                return;
            }


            let rows = [];


            try {

                rows =
                    parseMpesaSms(
                        message.body
                    ) || [];

            } catch (error) {

                console.error(
                    "PayTrack: SMS parse error:",
                    error
                );

                return;
            }


            rows.forEach(row => {

                if (!row) {
                    return;
                }


                const key =
                    senderKeyFor(
                        row.details,
                        message.address
                    );


                if (!groups[key]) {

                    groups[key] = {

                        key: key,

                        display:
                            row.details ||
                            message.address ||
                            "Unknown",

                        rows: [],

                        total: 0,

                        newCount: 0
                    };
                }


                groups[key].rows.push(row);


                groups[key].total +=
                    Number(row.amount) || 0;


                if (
                    row.receipt &&
                    !recorded.has(row.receipt)
                ) {

                    groups[key].newCount++;
                }
            });
        });


        // ----------------------------------------------------
        // Convert object → array
        // ----------------------------------------------------

        smsGroupsCache =
            Object.values(groups).sort(
                (a, b) =>
                    b.total - a.total
            );


        console.log(
            "PayTrack: sender groups:",
            smsGroupsCache.length
        );


        renderSmsGroups();


    } catch (error) {

        console.error(
            "PayTrack SMS group sync failed:",
            error
        );


        list.innerHTML =
            "<p class='muted'>" +
            "Could not read SMS: " +
            escapeHtml(
                error.message || "Unknown error"
            ) +
            "</p>";
    }
}


// ============================================================
// RENDER GROUPS
// ============================================================

function renderSmsGroups() {

    const list =
        document.getElementById(
            "smsGroupsList"
        );


    if (!list) {
        return;
    }


    if (
        smsGroupsCache.length === 0
    ) {

        list.innerHTML =
            "<p class='muted'>" +
            "No M-PESA messages found on this phone." +
            "</p>";

        return;
    }


    list.innerHTML =
        smsGroupsCache
            .map((group, i) => {

                const linkedEmployee =
                    findEmployeeBySmsKey(
                        group.key
                    );


                return `
                    <div class="sms-group-card">

                        <div class="sms-group-info">

                            <strong>
                                ${escapeHtml(
                                    group.display
                                )}
                            </strong>

                            <p>
                                ${group.rows.length}
                                message(s)

                                &middot;

                                ${formatMoney(
                                    group.total
                                )}

                                ${
                                    group.newCount > 0
                                        ? `
                                            &middot;
                                            <span class="neg">
                                                ${group.newCount}
                                                new
                                            </span>
                                          `
                                        : ""
                                }
                            </p>

                            ${
                                linkedEmployee
                                    ? `
                                        <p class="ok">
                                            Linked to
                                            ${escapeHtml(
                                                linkedEmployee.name
                                            )}
                                        </p>
                                      `
                                    : ""
                            }

                        </div>


                        <div class="sms-group-actions">

                            <select
                                id="smsGroupSelect${i}"
                            >

                                <option value="">
                                    -- link to employee --
                                </option>

                                ${employees
                                    .map(employee => {

                                        const selected =
                                            linkedEmployee &&
                                            String(
                                                linkedEmployee.id
                                            ) ===
                                            String(
                                                employee.id
                                            )
                                                ? "selected"
                                                : "";

                                        return `
                                            <option
                                                value="${escapeHtml(
                                                    String(
                                                        employee.id
                                                    )
                                                )}"
                                                ${selected}
                                            >
                                                ${escapeHtml(
                                                    employee.name
                                                )}
                                            </option>
                                        `;
                                    })
                                    .join("")}

                            </select>


                            <button
                                class="secondary-btn"
                                onclick="linkSmsGroup(${i})"
                            >
                                Link
                            </button>


                            <button
                                class="secondary-btn"
                                onclick="createEmployeeFromSmsGroup(${i})"
                            >
                                + New Employee
                            </button>


                            <button
                                class="secondary-btn"
                                onclick="importSmsGroup(${i})"
                            >
                                Import Payments
                            </button>

                        </div>

                    </div>
                `;
            })
            .join("");
}


// ============================================================
// LINK EXISTING EMPLOYEE
// ============================================================

function linkSmsGroup(index) {

    const group =
        smsGroupsCache[index];


    if (!group) {
        return;
    }


    const select =
        document.getElementById(
            "smsGroupSelect" + index
        );


    if (!select) {
        return;
    }


    const empId =
        select.value;


    if (!empId) {

        alert(
            "Choose an employee first."
        );

        return;
    }


    const employee =
        employees.find(
            e =>
                String(e.id) ===
                String(empId)
        );


    if (!employee) {
        return;
    }


    if (
        !Array.isArray(
            employee.smsLinks
        )
    ) {

        employee.smsLinks = [];
    }


    if (
        !employee.smsLinks.includes(
            group.key
        )
    ) {

        employee.smsLinks.push(
            group.key
        );
    }


    saveData();


    renderSmsGroups();


    alert(
        `Linked "${group.display}" to ${employee.name}.`
    );
}


// ============================================================
// CREATE EMPLOYEE FROM SENDER
// ============================================================

function createEmployeeFromSmsGroup(index) {

    const group =
        smsGroupsCache[index];


    if (!group) {
        return;
    }


    openEmployeeModal();


    const nameInput =
        document.getElementById(
            "employeeName"
        );


    const phoneInput =
        document.getElementById(
            "employeePhone"
        );


    if (nameInput) {

        nameInput.value =
            /^[0-9+]+$/.test(group.key)
                ? ""
                : group.display;
    }


    if (phoneInput) {

        phoneInput.value =
            /^[0-9]{6,}$/.test(group.key)
                ? group.key
                : "";
    }


    window._pendingSmsLink =
        group.key;
}


// ============================================================
// ATTACH SMS LINK AFTER EMPLOYEE CREATION
// ============================================================

document.addEventListener(
    "DOMContentLoaded",
    () => {

        const form =
            document.getElementById(
                "employeeForm"
            );


        if (!form) {
            return;
        }


        form.addEventListener(
            "submit",
            () => {

                if (
                    !window._pendingSmsLink
                ) {
                    return;
                }


                setTimeout(() => {

                    const newest =
                        employees[
                            employees.length - 1
                        ];


                    if (!newest) {
                        return;
                    }


                    if (
                        !Array.isArray(
                            newest.smsLinks
                        )
                    ) {

                        newest.smsLinks = [];
                    }


                    if (
                        !newest.smsLinks.includes(
                            window._pendingSmsLink
                        )
                    ) {

                        newest.smsLinks.push(
                            window._pendingSmsLink
                        );
                    }


                    saveData();


                    window._pendingSmsLink =
                        null;


                    const modal =
                        document.getElementById(
                            "smsGroupsModal"
                        );


                    if (
                        modal &&
                        modal.style.display === "flex"
                    ) {

                        renderSmsGroups();
                    }

                }, 0);
            }
        );
    }
);


// ============================================================
// IMPORT PAYMENTS FOR SENDER
// ============================================================

function importSmsGroup(index) {

    const group =
        smsGroupsCache[index];


    if (!group) {
        return;
    }


    const employee =
        findEmployeeBySmsKey(
            group.key
        );


    if (!employee) {

        alert(
            "Link this sender to an employee first."
        );

        return;
    }


    const existing =
        new Set(
            payments
                .map(payment =>
                    payment.transactionId
                )
                .filter(Boolean)
        );


    let added = 0;


    group.rows.forEach(row => {

        if (
            !row ||
            !row.receipt
        ) {
            return;
        }


        if (
            existing.has(row.receipt)
        ) {
            return;
        }


        payments.push({

            id:
                Date.now().toString() +
                Math.random()
                    .toString(36)
                    .slice(2, 7),

            employeeId:
                employee.id,

            amount:
                row.amount,

            date:
                row.date,

            time:
                row.time,

            balance:
                row.balance,

            transactionId:
                row.receipt
        });


        existing.add(
            row.receipt
        );


        added++;
    });


    saveData();

    render();

    renderSmsGroups();


    alert(
        `${added} payment(s) imported for ${employee.name}.`
    );
}
