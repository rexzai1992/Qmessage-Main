package com.qmessage.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeNotificationSettings")
public class NativeNotificationSettingsPlugin extends Plugin {

    @PluginMethod
    public void openAppNotificationSettings(PluginCall call) {
        final String packageName = getContext().getPackageName();
        boolean opened = false;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryOpen(intent);
        }

        if (!opened) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryOpen(fallback);
        }

        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
    }

    @PluginMethod
    public void openChannelNotificationSettings(PluginCall call) {
        final String packageName = getContext().getPackageName();
        final String channelId = call.getString("channelId");
        boolean opened = false;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && channelId != null && !channelId.trim().isEmpty()) {
            Intent intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, channelId.trim())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryOpen(intent);
        }

        if (!opened) {
            Intent fallback = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryOpen(fallback);
        }

        if (!opened) {
            Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            opened = tryOpen(details);
        }

        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
    }

    private boolean tryOpen(Intent intent) {
        try {
            getContext().startActivity(intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }
}
