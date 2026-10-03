package com.paytrack.app;

import android.database.Cursor;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONArray;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(
    name = "PayTrackSms",
    permissions = {
        // READ_SMS is needed to read the existing inbox (getAllMpesaSms).
        // RECEIVE_SMS is needed for live messages.
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

    private static final int MAX_INBOX_MESSAGES = 5000;

    private static PayTrackSmsPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    public static void notifyNewSms() {
        if (instance != null) {
            instance.notifyListeners("smsReceived", new JSObject());
        }
    }

    // ---------------------------------------------------------
    // LIVE QUEUE (unchanged)
    // ---------------------------------------------------------

    @PluginMethod
    public void getPendingSms(PluginCall call) {
        JSONArray arr = SmsQueue.get(getContext());
        JSObject result = new JSObject();
        result.put("messages", arr);
        call.resolve(result);
    }

    @PluginMethod
    public void removePending(PluginCall call) {
        try {
            JSArray ids = call.getArray("ids");
            Set<String> set = new HashSet<>();
            if (ids != null) {
                for (int i = 0; i < ids.length(); i++) set.add(ids.getString(i));
            }
            SmsQueue.remove(getContext(), set);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not remove messages");
        }
    }

    // ---------------------------------------------------------
    // FULL INBOX (NEW)
    // ---------------------------------------------------------

    @PluginMethod
    public void getAllMpesaSms(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermissionCallback");
            return;
        }
        readInbox(call);
    }

    @PermissionCallback
    private void smsPermissionCallback(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            readInbox(call);
        } else {
            call.reject("SMS permission denied");
        }
    }

    private void readInbox(PluginCall call) {
        Cursor cursor = null;
        try {
            Uri inbox = Uri.parse("content://sms/inbox");

            cursor = getContext().getContentResolver().query(
                inbox,
                new String[] { "_id", "address", "body", "date" },
                "address LIKE ? OR address LIKE ?",
                new String[] { "%MPESA%", "%M-PESA%" },
                "date DESC"
            );

            JSArray messages = new JSArray();

            if (cursor != null) {
                int idCol = cursor.getColumnIndexOrThrow("_id");
                int addressCol = cursor.getColumnIndexOrThrow("address");
                int bodyCol = cursor.getColumnIndexOrThrow("body");
                int dateCol = cursor.getColumnIndexOrThrow("date");

                int count = 0;
                while (cursor.moveToNext() && count < MAX_INBOX_MESSAGES) {
                    JSObject m = new JSObject();
                    m.put("id", cursor.getString(idCol));
                    m.put("address", cursor.getString(addressCol));
                    m.put("body", cursor.getString(bodyCol));
                    m.put("date", cursor.getLong(dateCol));
                    messages.put(m);
                    count++;
                }
            }

            JSObject result = new JSObject();
            result.put("messages", messages);
            call.resolve(result);

        } catch (Exception e) {
            call.reject("Could not read SMS inbox: " + e.getMessage());
        } finally {
            if (cursor != null) cursor.close();
        }
    }
}