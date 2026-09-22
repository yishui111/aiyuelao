package com.weiliao.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 微聊 APP 壳：内置 www/index.html（仿微信界面）+ 原生 GPS 定位桥 + 文件选择 + 麦克风。
 * 定位走 LocationManager（GPS + 网络双通道），网页通过 window.onNativeLocation(lat,lng,acc) 收坐标。
 *
 * 注意：嵌套类必须全部 static（显式传 Activity 引用），不能用非静态内部类/匿名类/
 * lambda —— JDK21 javac 编译出的 this$0 内部类会让 d8 直接 NPE（实测 8.2/3.3 均炸）。
 */
public class MainActivity extends Activity implements LocationListener {

    static final int REQ_LOCATION = 1;
    static final int REQ_MIC = 2;
    static final int REQ_FILE = 3;
    private static final long GPS_MIN_MS = 3000L;
    private static final long NET_MIN_MS = 5000L;

    private WebView web;
    private LocationManager lm;
    private boolean gpsOn;
    private ValueCallback<Uri[]> fileCb;

    /** WebChromeClient：网页定位授权 + 麦克风授权 + 文件选择 */
    private static final class Chrome extends WebChromeClient {
        private final MainActivity act;
        Chrome(MainActivity act) { this.act = act; }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                GeolocationPermissions.Callback callback) {
            callback.invoke(origin, true, false);
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            act.runOnUiThread(new GrantRun(request));
        }

        @Override
        public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> cb,
                FileChooserParams params) {
            return act.startFileChooser(cb);
        }
    }

    private static final class GrantRun implements Runnable {
        private final PermissionRequest request;
        GrantRun(PermissionRequest request) { this.request = request; }
        public void run() { request.grant(request.getResources()); }
    }

    /** JS 桥：window.AndroidBridge.startLocation()/requestMic()/toast() */
    private static final class JsBridge {
        private final MainActivity act;
        JsBridge(MainActivity act) { this.act = act; }

        @JavascriptInterface
        public void startLocation() {
            act.runOnUiThread(new StartLocationRun(act));
        }

        @JavascriptInterface
        public void requestMic() {
            act.runOnUiThread(new StartMicRun(act));
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

    private static final class ExitRun implements Runnable {
        private final Activity act;
        ExitRun(Activity act) { this.act = act; }
        public void run() { act.finish(); }
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

    private static final class StartMicRun implements Runnable {
        private final MainActivity act;
        StartMicRun(MainActivity act) { this.act = act; }
        public void run() {
            if (act.selfHasMic()) {
                act.pushToJs("window.onMicReady&&window.onMicReady()");
            } else {
                act.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
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
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);    // 语音消息允许程序化播放
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new Chrome(this));
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

    boolean selfHasMic() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO)
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
        if (l == null) return;
        final String js = "window.onNativeLocation&&window.onNativeLocation("
                + l.getLatitude() + "," + l.getLongitude() + "," + l.getAccuracy() + ")";
        web.evaluateJavascript(js, null);
    }

    void pushToJs(String js) {
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
                Toast.makeText(this, "需要定位权限才能使用位置功能", Toast.LENGTH_LONG).show();
            }
        } else if (requestCode == REQ_MIC) {
            if (selfHasMic()) {
                pushToJs("window.onMicReady&&window.onMicReady()");
            } else {
                Toast.makeText(this, "需要麦克风权限才能发语音消息", Toast.LENGTH_LONG).show();
            }
        }
    }

    // ---- 文件选择（发图片/视频/文件用） ----
    boolean startFileChooser(ValueCallback<Uri[]> cb) {
        if (fileCb != null) {
            fileCb.onReceiveValue(null);
        }
        fileCb = cb;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        try {
            startActivityForResult(Intent.createChooser(i, "选择内容"), REQ_FILE);
        } catch (Exception e) {
            fileCb = null;
            return false;
        }
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (fileCb != null) {
                fileCb.onReceiveValue(result);
                fileCb = null;
            }
        } else {
            super.onActivityResult(requestCode, resultCode, data);
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
        // 网页处理返回（页面内导航栈）；需要退出时网页调用 AndroidBridge.exitApp()
        web.evaluateJavascript("window.onAppBack&&window.onAppBack()", null);
    }
}
