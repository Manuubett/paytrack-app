window.syncAllMpesaSms = async function () {

    try {

        console.log("PayTrack: reading complete SMS inbox...");

        const result = await Sms.getAllMpesaSms();

        const messages = result.messages || [];

        console.log(
            "PayTrack: M-PESA messages found:",
            messages.length
        );

        return messages;

    } catch (error) {

        console.error(
            "PayTrack: failed to read M-PESA inbox",
            error
        );

        return [];

    }
};
