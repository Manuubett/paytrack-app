package com.paytrack.app;

import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(
    name = "PayTrackSms",
    permissions = {
        @Permission(
            strings = {
                android.Manifest.permission.RECEIVE_SMS,
                android.Manifest.permission.READ_SMS
            },
            alias = "sms"
        )
    }
)
public class PayTrackSmsPlugin extends Plugin {

    private static PayTrackSmsPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    public static void notifyNewSms() {
        if (instance != null) {
            instance.notifyListeners(
                "smsReceived",
                new JSObject()
            );
        }
    }

    // --------------------------------
    // Pending SMS
    // --------------------------------

    @PluginMethod
    public void getPendingSms(PluginCall call) {
        try {
            JSONArray arr = SmsQueue.get(getContext());

            JSObject result = new JSObject();
            result.put("messages", arr);

            call.resolve(result);

        } catch (Exception e) {
            call.reject(
                "Could not get pending SMS: " + e.getMessage()
            );
        }
    }

    @PluginMethod
    public void removePending(PluginCall call) {
        try {
            JSArray ids = call.getArray("ids");

            Set<String> set = new HashSet<>();

            if (ids != null) {
                for (int i = 0; i < ids.length(); i++) {
                    set.add(ids.getString(i));
                }
            }

            SmsQueue.remove(getContext(), set);

            call.resolve();

        } catch (Exception e) {
            call.reject(
                "Could not remove messages: " + e.getMessage()
            );
        }
    }

    // --------------------------------
    // Read M-PESA SMS inbox
    // --------------------------------

    @PluginMethod
    public void getAllMpesaSms(PluginCall call) {

        try {

            JSONArray results = new JSONArray();

            Uri uri = Telephony.Sms.Inbox.CONTENT_URI;

            String[] projection = {
                Telephony.Sms._ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE
            };

            Cursor cursor = getContext()
                .getContentResolver()
                .query(
                    uri,
                    projection,
                    null,
                    null,
                    Telephony.Sms.DATE + " DESC"
                );

            if (cursor != null) {

                int idIdx =
                    cursor.getColumnIndex(Telephony.Sms._ID);

                int addrIdx =
                    cursor.getColumnIndex(Telephony.Sms.ADDRESS);

                int bodyIdx =
                    cursor.getColumnIndex(Telephony.Sms.BODY);

                int dateIdx =
                    cursor.getColumnIndex(Telephony.Sms.DATE);

                while (cursor.moveToNext()) {

                    String body =
                        cursor.getString(bodyIdx);

                    if (body == null) {
                        continue;
                    }

                    String address =
                        cursor.getString(addrIdx);

                    boolean isMpesa =
                        (address != null &&
                         address.toUpperCase().contains("MPESA"))
                        ||
                        body.toUpperCase().contains("M-PESA");

                    if (!isMpesa) {
                        continue;
                    }

                    JSONObject sms = new JSONObject();

                    sms.put(
                        "id",
                        cursor.getString(idIdx)
                    );

                    sms.put(
                        "address",
                        address == null ? "" : address
                    );

                    sms.put(
                        "body",
                        body
                    );

                    sms.put(
                        "date",
                        cursor.getLong(dateIdx)
                    );

                    results.put(sms);
                }

                cursor.close();
            }

            JSObject result = new JSObject();

            result.put(
                "messages",
                results
            );

            call.resolve(result);

        } catch (Exception e) {

            call.reject(
                "Could not read SMS inbox: " +
                e.getMessage()
            );
        }
    }
}
