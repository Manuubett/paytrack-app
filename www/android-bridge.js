/*
    PAYTRACK — ANDROID BRIDGE

    Android Capacitor bridge.

    Flows:

    1. LIVE SMS
       Android SmsReceiver
            ↓
       SmsQueue
            ↓
       getPendingSms()
            ↓
       parseMpesaSms()
            ↓
       match employee
            ↓
       save payment / review
            ↓
       removePending()

    2. FULL SMS INBOX
       Existing SMS inbox
            ↓
       getAllMpesaSms()
            ↓
       window.syncAllMpesaSms()
            ↓
       sms-groups.js
            ↓
       group by sender

    Browser:
       This file does nothing.
*/

(function () {

    "use strict";


    // =========================================================
    // CAPACITOR CHECK
    // =========================================================

    if (!window.Capacitor) {

        console.log(
            "PayTrack: Capacitor not available. Browser mode."
        );

        return;
    }


    if (
        typeof window.Capacitor.isNativePlatform !== "function"
    ) {

        console.log(
            "PayTrack: Capacitor.isNativePlatform unavailable."
        );

        return;
    }


    if (!window.Capacitor.isNativePlatform()) {

        console.log(
            "PayTrack: running in browser."
        );

        return;
    }


    console.log(
        "PayTrack: Android Capacitor detected."
    );


    // =========================================================
    // REGISTER NATIVE PLUGIN
    // =========================================================

    if (
        typeof window.Capacitor.registerPlugin !== "function"
    ) {

        console.error(
            "PayTrack: Capacitor.registerPlugin is unavailable."
        );

        return;
    }


    const Sms =
        window.Capacitor.registerPlugin("PayTrackSms");


    if (!Sms) {

        console.error(
            "PayTrack: PayTrackSms plugin registration failed."
        );

        return;
    }


    console.log(
        "PayTrack: PayTrackSms plugin registered."
    );


    /*
        Keep a global reference for other existing files.

        IMPORTANT:
        This is only a compatibility reference.
        The bridge itself uses the local Sms variable.
    */

    window.PayTrackSms = Sms;


    // =========================================================
    // CONSTANTS
    // =========================================================

    const REVIEW_KEY = "paytrack_review";

    let busy = false;


    // =========================================================
    // REVIEW LIST
    // =========================================================

    function loadReview() {

        try {

            return JSON.parse(
                localStorage.getItem(REVIEW_KEY)
            ) || [];

        } catch (error) {

            console.error(
                "PayTrack: could not load review list",
                error
            );

            return [];
        }
    }


    function saveReview(list) {

        localStorage.setItem(
            REVIEW_KEY,
            JSON.stringify(list)
        );
    }


    function updateBanner() {

        const banner =
            document.getElementById("reviewBanner");

        if (!banner) return;


        const count =
            loadReview().length;


        banner.style.display =
            count > 0 ? "flex" : "none";


        const label =
            document.getElementById("reviewCount");


        if (label) {

            label.textContent =
                count;
        }
    }


    // =========================================================
    // EMPLOYEE MATCHING
    // =========================================================

    function pickEmployee(details) {

        const key =
            senderKeyFor(details, "");


        if (key) {

            const linked =
                employees.find(employee =>
                    Array.isArray(employee.smsLinks) &&
                    employee.smsLinks.includes(key)
                );


            if (linked) {

                return linked;
            }
        }


        const digits =
            String(details || "")
                .replace(/\D/g, "");


        const byPhone =
            employees.filter(employee => {

                const phone =
                    last9Digits(employee.phone);


                return (
                    phone &&
                    digits.includes(phone)
                );
            });


        if (byPhone.length === 1) {

            return byPhone[0];
        }


        // Never guess when multiple employees
        // have the same phone number.

        if (byPhone.length > 1) {

            return null;
        }


        // Existing name / masked-number matching.

        return matchSmsEmployee(details);
    }


    // =========================================================
    // FULL M-PESA INBOX
    // =========================================================

    /*
        Used by sms-groups.js.

        Reads existing M-PESA SMS messages from
        the Android inbox.

        Native method:
            PayTrackSms.getAllMpesaSms()
    */

    window.syncAllMpesaSms = async function () {

        try {

            console.log(
                "PayTrack: reading M-PESA SMS inbox..."
            );


            if (
                !Sms ||
                typeof Sms.getAllMpesaSms !== "function"
            ) {

                console.error(
                    "PayTrack: getAllMpesaSms() is unavailable."
                );

                return [];
            }


            const result =
                await Sms.getAllMpesaSms();


            const messages =
                result &&
                Array.isArray(result.messages)
                    ? result.messages
                    : [];


            console.log(
                "PayTrack: M-PESA messages found:",
                messages.length
            );


            return messages;


        } catch (error) {

            console.error(
                "PayTrack: failed to read M-PESA inbox:",
                error
            );


            return [];
        }
    };


    // =========================================================
    // LIVE SMS QUEUE
    // =========================================================

    async function processPending() {

        if (busy) {

            return;
        }


        busy = true;


        try {

            if (
                !Sms ||
                typeof Sms.getPendingSms !== "function"
            ) {

                console.error(
                    "PayTrack: getPendingSms() unavailable."
                );

                return;
            }


            const result =
                await Sms.getPendingSms();


            const messages =
                result &&
                Array.isArray(result.messages)
                    ? result.messages
                    : [];


            if (messages.length === 0) {

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


            const review =
                loadReview();


            const reviewIds =
                new Set(
                    review.map(
                        item => item.receipt
                    )
                );


            messages.forEach(message => {

                if (!message || !message.body) {

                    return;
                }


                const rows =
                    parseMpesaSms(message.body);


                rows.forEach(row => {

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


                    const employee =
                        pickEmployee(row.details);


                    if (employee) {

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


                    } else if (
                        !reviewIds.has(
                            row.receipt
                        )
                    ) {

                        review.push({

                            receipt:
                                row.receipt,

                            body:
                                message.body
                        });


                        reviewIds.add(
                            row.receipt
                        );
                    }
                });
            });


            /*
                IMPORTANT:

                Save everything BEFORE
                deleting the native queue.
            */

            saveData();

            saveReview(review);

            render();

            updateBanner();


            if (
                typeof Sms.removePending ===
                "function"
            ) {

                await Sms.removePending({

                    ids:
                        messages
                            .map(message =>
                                message.id
                            )
                            .filter(Boolean)
                });
            }


        } catch (error) {

            console.error(
                "PayTrack SMS sync failed:",
                error
            );

        } finally {

            busy = false;
        }
    }


    // =========================================================
    // REVIEW SCREEN
    // =========================================================

    window.openReview = function () {

        const bodies =
            [
                ...new Set(
                    loadReview()
                        .map(item => item.body)
                )
            ];


        if (
            typeof openSmsModal !==
            "function"
        ) {

            console.error(
                "PayTrack: openSmsModal() unavailable."
            );

            return;
        }


        openSmsModal();


        const textarea =
            document.getElementById(
                "smsText"
            );


        if (textarea) {

            textarea.value =
                bodies.join("\n\n");
        }


        if (
            typeof readSmsMessages ===
            "function"
        ) {

            readSmsMessages();
        }
    };


    // =========================================================
    // REVIEW IMPORT HOOK
    // =========================================================

    /*
        import.js is loaded before this file.

        Only override it if the original function
        actually exists.
    */

    if (
        typeof window.importSmsMessages ===
        "function"
    ) {

        const originalImport =
            window.importSmsMessages;


        window.importSmsMessages = function () {

            originalImport();


            try {

                const recorded =
                    new Set(
                        payments.map(
                            payment =>
                                payment.transactionId
                        )
                    );


                saveReview(
                    loadReview().filter(
                        item =>
                            !recorded.has(
                                item.receipt
                            )
                    )
                );


                updateBanner();


            } catch (error) {

                console.error(
                    "PayTrack: review cleanup failed:",
                    error
                );
            }
        };
    }


    // =========================================================
    // INITIALIZATION
    // =========================================================

    async function init() {

        try {

            /*
                Ask/check SMS permission.

                The native plugin declares:
                    READ_SMS
                    RECEIVE_SMS
            */

            if (
                typeof Sms.checkPermissions ===
                "function"
            ) {

                const status =
                    await Sms.checkPermissions();


                console.log(
                    "PayTrack SMS permission:",
                    status
                );


                if (
                    status &&
                    status.sms !== "granted"
                ) {

                    if (
                        typeof Sms.requestPermissions ===
                        "function"
                    ) {

                        await Sms.requestPermissions();

                    }
                }
            }


        } catch (error) {

            console.error(
                "SMS permission check failed:",
                error
            );
        }


        updateBanner();


        /*
            Process SMS that arrived while
            the app was not open.
        */

        processPending();


        // =====================================================
        // LIVE SMS LISTENER
        // =====================================================

        if (
            typeof Sms.addListener ===
            "function"
        ) {

            try {

                await Sms.addListener(
                    "smsReceived",
                    processPending
                );


                console.log(
                    "PayTrack: SMS listener registered."
                );


            } catch (error) {

                console.error(
                    "PayTrack: SMS listener failed:",
                    error
                );
            }
        }


        // =====================================================
        // APP RESUME
        // =====================================================

        document.addEventListener(
            "visibilitychange",
            () => {

                if (!document.hidden) {

                    processPending();
                }
            }
        );
    }


    // =========================================================
    // START
    // =========================================================

    init();


})();
