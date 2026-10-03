package com.paytrack.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import org.json.JSONArray;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(
    name = "PayTrackSms",
    permissions = {
        @Permission(strings = { android.Manifest.permission.RECEIVE_SMS }, alias = "sms")
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
            instance.notifyListeners("smsReceived", new JSObject());
        }
    }

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
}