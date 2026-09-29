/*
    PAYTRACK — ANDROID BRIDGE

    Runs only inside the Capacitor Android app (does nothing in a browser).

    Flow:
      native receiver queues raw SMS
        -> this file pulls the queue (on start, on resume, and live)
        -> parseMpesaSms() -> match employee
        -> exactly one match: saved automatically
        -> none / ambiguous: kept in "needs review"
        -> queue is cleared only AFTER data is saved

    Load order:
      app.js, import.js, sms.js, sms-parser.js, android-bridge.js
*/

(function () {

    if (
        !window.Capacitor ||
        !Capacitor.isNativePlatform ||
        !Capacitor.isNativePlatform()
    ) {
        return;
    }

    const Sms = Capacitor.registerPlugin("PayTrackSms");
window.PayTrackSms = Sms;

    const REVIEW_KEY = "paytrack_review";

    let busy = false;


    // ---------- Review list (unmatched / ambiguous) ----------

    function loadReview() {
        try {
            return JSON.parse(localStorage.getItem(REVIEW_KEY)) || [];
        } catch (error) {
            return [];
        }
    }

    function saveReview(list) {
        localStorage.setItem(REVIEW_KEY, JSON.stringify(list));
    }

    function updateBanner() {

        const banner = document.getElementById("reviewBanner");

        if (!banner) return;

        const count = loadReview().length;

        banner.style.display = count > 0 ? "flex" : "none";

        const label = document.getElementById("reviewCount");

        if (label) label.textContent = count;
    }


    // ---------- Matching (only auto-save when it is unambiguous) ----------

   function pickEmployee(details) {

    const key = senderKeyFor(details, "");

    if (key) {
        const linked = employees.find(e =>
            Array.isArray(e.smsLinks) && e.smsLinks.includes(key)
        );
        if (linked) return linked;
    }

    const digits = details.replace(/\D/g, "");

        const byPhone =
            employees.filter(employee => {

                const phone = last9Digits(employee.phone);

                return phone && digits.includes(phone);
            });

        if (byPhone.length === 1) return byPhone[0];

        // Two employees share this number: don't guess
        if (byPhone.length > 1) return null;

        // Fall back to name match / masked number (from sms.js)
        return matchSmsEmployee(details);
    }


    // ---------- Pull the native queue ----------

    async function processPending() {

        if (busy) return;

        busy = true;

        try {

            const result = await Sms.getPendingSms();

            const messages = result.messages || [];

            if (messages.length === 0) return;

            const existing =
                new Set(
                    payments
                        .map(payment => payment.transactionId)
                        .filter(Boolean)
                );

            const review = loadReview();

            const reviewIds =
                new Set(review.map(item => item.receipt));

            messages.forEach(message => {

                parseMpesaSms(message.body).forEach(row => {

                    if (existing.has(row.receipt)) return;

                    const employee = pickEmployee(row.details);

                    if (employee) {

                        payments.push({

                            id:
                                Date.now().toString() +
                                Math.random().toString(36).slice(2, 7),

                            employeeId: employee.id,
                            amount: row.amount,
                            date: row.date,
                            time: row.time,
                            balance: row.balance,
                            transactionId: row.receipt
                        });

                        existing.add(row.receipt);

                    } else if (!reviewIds.has(row.receipt)) {

                        review.push({
                            receipt: row.receipt,
                            body: message.body
                        });

                        reviewIds.add(row.receipt);
                    }
                });
            });

            // Save first, THEN clear the native queue
            saveData();
            saveReview(review);
            render();
            updateBanner();

            await Sms.removePending({
                ids: messages.map(message => message.id)
            });

        } catch (error) {

            console.error("PayTrack SMS sync failed", error);

        } finally {

            busy = false;
        }
    }


    // ---------- Review screen (reuses the paste-SMS preview) ----------

    window.openReview = function () {

        const bodies =
            [...new Set(loadReview().map(item => item.body))];

        openSmsModal();

        document.getElementById("smsText").value =
            bodies.join("\n\n");

        readSmsMessages();
    };


    // After a review import, drop items that are now recorded
    const originalImport = importSmsMessages;

    window.importSmsMessages = function () {

        originalImport();

        const recorded =
            new Set(payments.map(payment => payment.transactionId));

        saveReview(
            loadReview().filter(item => !recorded.has(item.receipt))
        );

        updateBanner();
    };


    // ---------- Start-up ----------

    async function init() {

        try {

            const status = await Sms.checkPermissions();

            if (status.sms !== "granted") {
                await Sms.requestPermissions();
            }

        } catch (error) {
            console.error("SMS permission check failed", error);
        }

        updateBanner();

        processPending();

        // App already open when an SMS arrives
        Sms.addListener("smsReceived", processPending);

        // App brought back from the background
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) processPending();
        });
    }

    init();

})();
