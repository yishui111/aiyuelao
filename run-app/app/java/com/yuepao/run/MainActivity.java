package com.yuepao.run;

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
 * 约跑步 APP 壳：内置 www/index.html 界面 + 原生 GPS 定位桥。
 * 定位走 LocationManager（GPS + 网络双通道），比 WebView 网页定位更省电可靠；
 * 网页通过 window.onNativeLocation(lat, lng, accuracy) 收坐标。
 *
 * 注意：嵌套类必须全部 static（显式传 Activity 引用），不能用非静态内部类/匿名类/
 * lambda —— JDK21 javac 编译出的 this$0 内部类会让 d8 直接 NPE（实测 8.2/3.3 均炸）。
 */
public class MainActivity extends Activity implements LocationListener {

    static final int REQ_LOCATION = 1;
    private static final long GPS_MIN_MS = 3000L;   // GPS 3 秒一帧
    private static final long NET_MIN_MS = 5000L;   // 网络定位 5 秒一帧

    private WebView web;
    private LocationManager lm;
    private boolean gpsOn;

    /** 允许网页 geolocation（原生定位桥之外的备用通道） */
    private static final class PromptGrant extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                GeolocationPermissions.Callback callback) {
            callback.invoke(origin, true, false);
        }
    }

    /** JS 桥：window.AndroidBridge.startLocation() / .toast() */
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
        s.setDomStorageEnabled(true);                    // localStorage 存登录态
        s.setAllowFileAccess(true);
        // file:// 页面直接 fetch http 后端，绕过跨域限制（仅加载内置资源，可接受）
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setGeolocationEnabled(true);                   // 网页定位备用通道
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
        if (gpsOn) return; // 已在监听，避免重复注册
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
            // 立即给网页一帧最近已知位置，冷启动不用等 GPS 锁定
            Location last = lm.getLastKnownLocation(
                    lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                            ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER);
            if (last != null) pushToJs(last);
            gpsOn = any;
        } catch (SecurityException ignored) {
            // 权限被回收时静默，网页会显示"定位不可用"
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
                Toast.makeText(this, "需要定位权限才能发现附近的跑者", Toast.LENGTH_LONG).show();
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
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
