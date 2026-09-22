package com.weiliao.watch;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 微聊手表端壳：内置 www/index.html（精简聊天界面）+ 原生定位桥。
 * 与手机端同一套后端接口，直接对接 wechat-backend(3002)。
 *
 * 注意：嵌套类必须全部 static —— JDK21 javac 产物里的非静态内部类/匿名类
 * 会让 d8 NPE（实测 8.2/3.3 均炸）。
 */
public class MainActivity extends Activity implements LocationListener {

    static final int REQ_LOCATION = 1;
    private static final long GPS_MIN_MS = 3000L;
    private static final long NET_MIN_MS = 5000L;

    private WebView web;
    private LocationManager lm;
    private boolean gpsOn;

    private static final class PromptGrant extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                GeolocationPermissions.Callback callback) {
            callback.invoke(origin, true, false);
        }
    }

    private static final class JsBridge {
        private final MainActivity act;
        JsBridge(MainActivity act) { this.act = act; }

        @JavascriptInterface
        public void startLocation() {
            act.runOnUiThread(new StartLocationRun(act));
        }

        @JavascriptInterface
        public void toast(final String msg) {
            act.runOnUiThread(new ToastRun(act, msg));
        }

        @JavascriptInterface
        public void exitApp() {
            act.runOnUiThread(new ExitRun(act));
        }
    }

    private static final class StartLocationRun implements Runnable {
        private final MainActivity act;
        StartLocationRun(MainActivity act) { this.act = act; }
        public void run() {
            if (act.selfHasLocation()) {
                act.startGps();
            } else {
                act.requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            }
        }
    }

    private static final class ExitRun implements Runnable {
        private final Activity act;
        ExitRun(Activity act) { this.act = act; }
        public void run() { act.finish(); }
    }

    private static final class ToastRun implements Runnable {
        private final Activity act;
        private final String msg;
        ToastRun(Activity act, String msg) { this.act = act; this.msg = msg; }
        public void run() {
            Toast.makeText(act, msg, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setGeolocationEnabled(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new PromptGrant());
        web.addJavascriptInterface(new JsBridge(this), "AndroidBridge");
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");

        if (selfHasLocation()) {
            startGps();
        } else {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }
    }

    boolean selfHasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    void startGps() {
        if (lm == null) lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (gpsOn) return;
        try {
            boolean any = false;
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, GPS_MIN_MS, 3f, this);
                any = true;
            }
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, NET_MIN_MS, 10f, this);
                any = true;
            }
            Location last = lm.getLastKnownLocation(
                    lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                            ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER);
            if (last != null) pushToJs(last);
            gpsOn = any;
        } catch (SecurityException ignored) {
        }
    }

    private void pushToJs(Location l) {
        final String js = "window.onNativeLocation&&window.onNativeLocation("
                + l.getLatitude() + "," + l.getLongitude() + "," + l.getAccuracy() + ")";
        web.evaluateJavascript(js, null);
    }

    @Override
    public void onLocationChanged(Location location) {
        pushToJs(location);
    }

    @Override
    public void onProviderEnabled(String provider) { }

    @Override
    public void onProviderDisabled(String provider) { }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_LOCATION) {
            if (selfHasLocation()) {
                startGps();
            } else {
                Toast.makeText(this, "需要定位权限", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (lm != null && gpsOn) {
            lm.removeUpdates(this);
        }
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.onAppBack&&window.onAppBack()", null);
    }
}
