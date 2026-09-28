package com.paytrack.app;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

public class SmsQueue {
    private static final String PREFS = "paytrack_sms";
    private static final String KEY = "queue";

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized void add(Context c, String body) {
        try {
            JSONArray arr = new JSONArray(prefs(c).getString(KEY, "[]"));
            JSONObject o = new JSONObject();
            o.put("id", System.currentTimeMillis() + "-" + arr.length());
            o.put("body", body);
            arr.put(o);
            prefs(c).edit().putString(KEY, arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    public static synchronized JSONArray get(Context c) {
        try {
            return new JSONArray(prefs(c).getString(KEY, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    public static synchronized void remove(Context c, Set<String> ids) {
        try {
            JSONArray arr = new JSONArray(prefs(c).getString(KEY, "[]"));
            JSONArray keep = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!ids.contains(o.getString("id"))) keep.put(o);
            }
            prefs(c).edit().putString(KEY, keep.toString()).apply();
        } catch (Exception ignored) {}
    }
}