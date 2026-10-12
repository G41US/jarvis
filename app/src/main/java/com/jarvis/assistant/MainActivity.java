package com.jarvis.assistant;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** One full-screen WebView showing the Jarvis page from the app's own files. No server, no localhost. */
public class MainActivity extends Activity {
    private static final String TAG = "Jarvis";
    private static final int REQ_PERMS = 41;

    private WebView web;
    private Bridge bridge;
    private PermissionRequest pendingWebPermission;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    /** Serves assets/www/* at https://appassets.androidplatform.net/* so the page keeps its normal absolute paths. */
    private static class WwwHandler implements WebViewAssetLoader.PathHandler {
        private final Activity a;
        WwwHandler(Activity a) { this.a = a; }

        @Override public WebResourceResponse handle(String path) {
            try {
                if (path == null || path.contains("..")) return null;
                if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";
                InputStream in = a.getAssets().open("www/" + path);
                return new WebResourceResponse(mime(path), mime(path).startsWith("text/") || mime(path).contains("json") || mime(path).contains("javascript") ? "utf-8" : null, in);
            } catch (IOException e) { return null; }
        }

        static String mime(String p) {
            String s = p.toLowerCase(Locale.ROOT);
            if (s.endsWith(".html")) return "text/html";
            if (s.endsWith(".js") || s.endsWith(".mjs")) return "text/javascript";
            if (s.endsWith(".css")) return "text/css";
            if (s.endsWith(".json") || s.endsWith(".map")) return "application/json";
            if (s.endsWith(".glb")) return "model/gltf-binary";
            if (s.endsWith(".gltf")) return "model/gltf+json";
            if (s.endsWith(".png")) return "image/png";
            if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
            if (s.endsWith(".webp")) return "image/webp";
            if (s.endsWith(".svg")) return "image/svg+xml";
            if (s.endsWith(".ico")) return "image/x-icon";
            if (s.endsWith(".wasm")) return "application/wasm";
            if (s.endsWith(".woff2")) return "font/woff2";
            if (s.endsWith(".woff")) return "font/woff";
            if (s.endsWith(".ktx2")) return "image/ktx2";
            return "application/octet-stream";
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF05060A);
        setContentView(web, new android.view.ViewGroup.LayoutParams(-1, -1));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        WebView.setWebContentsDebuggingEnabled(true);   // chrome://inspect works for troubleshooting

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WwwHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (WebViewAssetLoader.DEFAULT_DOMAIN.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        boolean needMic = false, needCam = false;
                        for (String r : request.getResources()) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) needMic = true;
                            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) needCam = true;
                        }
                        if (needCam) { request.deny(); return; }              // no camera features on the phone
                        if (!needMic || has(Manifest.permission.RECORD_AUDIO)) { request.grant(request.getResources()); return; }
                        pendingWebPermission = request;
                        askPermissions();
                    }
                });
            }
            @Override public void onGeolocationPermissionsShowPrompt(final String origin, final GeolocationPermissions.Callback callback) {
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION)) { callback.invoke(origin, true, true); return; }
                        pendingGeoOrigin = origin;
                        pendingGeoCallback = callback;
                        askPermissions();
                    }
                });
            }
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });

        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "AndroidBridge");

        askPermissions();
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("https://" + WebViewAssetLoader.DEFAULT_DOMAIN + "/index.html");
    }

    private boolean has(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    private void askPermissions() {
        List<String> need = new ArrayList<>();
        if (!has(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO);
        if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) { need.add(Manifest.permission.ACCESS_FINE_LOCATION); need.add(Manifest.permission.ACCESS_COARSE_LOCATION); }
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) need.add(Manifest.permission.POST_NOTIFICATIONS);
        if (need.isEmpty()) { startKeepAlive(); return; }
        requestPermissions(need.toArray(new String[0]), REQ_PERMS);
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (pendingWebPermission != null) {
            if (has(Manifest.permission.RECORD_AUDIO)) pendingWebPermission.grant(pendingWebPermission.getResources()); else pendingWebPermission.deny();
            pendingWebPermission = null;
        }
        if (pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION), true);
            pendingGeoCallback = null;
        }
        startKeepAlive();
    }

    /** Keeps Jarvis alive while the phone is in your pocket or another app (like maps) is on screen. Best effort: never fatal. */
    private void startKeepAlive() {
        try {
            int types = 0;
            if (has(Manifest.permission.RECORD_AUDIO)) types |= 1;
            if (has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION)) types |= 2;
            if (types == 0) return;
            Intent i = new Intent(this, JarvisService.class).putExtra("types", types);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        } catch (Exception e) { Log.w(TAG, "service not started", e); }
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (web != null) web.saveState(out); }

    @Override public void onBackPressed() {
        // Back never closes Jarvis; it goes to the home screen and keeps listening.
        moveTaskToBack(true);
    }

    @Override protected void onResume() {
        super.onResume();
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override protected void onDestroy() {
        if (bridge != null) bridge.destroy();
        if (web != null) { web.removeJavascriptInterface("AndroidBridge"); web.destroy(); }
        super.onDestroy();
    }
}
