package com.paytrack.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

public class SmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;

        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (parts == null || parts.length == 0) return;

        StringBuilder body = new StringBuilder();
        for (SmsMessage p : parts) body.append(p.getMessageBody());

        String sender = parts[0].getOriginatingAddress();
        String text = body.toString();

        // Only keep M-Pesa messages, never store personal SMS
        boolean mpesa =
            (sender != null && sender.toUpperCase().contains("MPESA")) ||
            text.toUpperCase().contains("M-PESA");
        if (!mpesa) return;

        SmsQueue.add(context, text);
        PayTrackSmsPlugin.notifyNewSms();
    }
}