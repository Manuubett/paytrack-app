/*
    PAYTRACK — EXTENDED M-PESA SMS PARSER (incoming money)

    Load AFTER sms.js / sms-parser.js and BEFORE finance.js.
    It overrides parseMpesaSms().

    Each result has:
      receipt   M-PESA transaction code
      amount    number
      date      "YYYY-MM-DD"   (d/m/yy in the SMS)
      time      "15:15"        (24h, or "" if missing)
      balance   number | null  (M-PESA balance after the transaction)
      details   sender name/number
*/

function mpesaTodayISO() {
    if (typeof todayISO === "function") return todayISO();
    return new Date().toISOString().slice(0, 10);
}

function parseMpesaSms(text) {

    text = String(text || "");

    // "confirmed" can be capitalised or not
    const startRegex = /\b[A-Z0-9]{10}(?=\s+[Cc]onfirmed)/g;

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
        let date = mpesaTodayISO();
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