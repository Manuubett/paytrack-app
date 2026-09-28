/*
    PAYTRACK — EXTENDED M-PESA SMS PARSER

    Replaces parseMpesaSms() in sms.js. Either paste this function over
    the old one, or load this file AFTER sms.js (it overrides it).

    Adds two fields to each result:
      time    "15:15"   (24h, or "" if the message has no time)
      balance 12345     (M-PESA balance after the transaction, or null)

    Dates are read as d/m/yy, which is how Safaricom writes them.
*/

function parseMpesaSms(text) {

    const startRegex = /\b[A-Z0-9]{10}(?=\s+Confirmed)/g;

    const starts = [];
    let match;

    while ((match = startRegex.exec(text)) !== null) {
        starts.push(match.index);
    }

    const results = [];
    const seen = new Set();

    starts.forEach((start, index) => {

        const end =
            index + 1 < starts.length
                ? starts[index + 1]
                : text.length;

        const chunk =
            text.slice(start, end).replace(/\s+/g, " ");

        const receipt = chunk.slice(0, 10);

        if (seen.has(receipt)) return;

        // Only money RECEIVED (ignore sent / paid / airtime)
        const amountMatch =
            chunk.match(
                /received\s+(?:Ksh|KES)\.?\s*([\d,]+(?:\.\d+)?)/i
            );

        if (!amountMatch) return;

        // "from NAME 07XX on 2/1/26 at 3:15 PM"
        const fromMatch =
            chunk.match(
                /from\s+(.+?)\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i
            );

        let details = "";
        let date = todayISO();
        let time = "";

        if (fromMatch) {

            details = fromMatch[1].trim();

            let year = Number(fromMatch[4]);

            if (year < 100) year += 2000;

            date =
                `${year}-` +
                `${fromMatch[3].padStart(2, "0")}-` +
                `${fromMatch[2].padStart(2, "0")}`;

            if (fromMatch[5]) {

                let hours = Number(fromMatch[5]);
                const meridian = (fromMatch[7] || "").toUpperCase();

                if (meridian === "PM" && hours < 12) hours += 12;
                if (meridian === "AM" && hours === 12) hours = 0;

                time =
                    String(hours).padStart(2, "0") + ":" + fromMatch[6];
            }
        }

        // "New M-PESA balance is Ksh12,345.00"
        const balanceMatch =
            chunk.match(
                /balance\s+is\s+(?:Ksh|KES)\.?\s*([\d,]+(?:\.\d+)?)/i
            );

        seen.add(receipt);

        results.push({
            receipt: receipt,
            amount: parseFloat(amountMatch[1].replace(/,/g, "")),
            date: date,
            time: time,
            balance: balanceMatch
                ? parseFloat(balanceMatch[1].replace(/,/g, ""))
                : null,
            details: details
        });
    });

    return results;
}