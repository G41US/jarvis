#!/usr/bin/env python3
"""Writes minimal stand-ins for the Android classes the app uses, so `javac` can type-check the Java sources without the Android SDK.
This is a typo/signature check only - it is NOT a substitute for the real Android build."""
import os, sys
OUT = sys.argv[1]
S = {}
def c(fq, body): S[fq] = body

c('android.content.Context', '''public abstract class Context { public static final String AUDIO_SERVICE="audio", CONNECTIVITY_SERVICE="connectivity", NOTIFICATION_SERVICE="notification", POWER_SERVICE="power";
 public abstract Object getSystemService(String n); public abstract android.content.res.AssetManager getAssets(); public abstract android.content.pm.PackageManager getPackageManager();
 public abstract Context getApplicationContext(); public abstract void startActivity(android.content.Intent i); public abstract android.content.ComponentName startService(android.content.Intent i);
 public abstract android.content.ComponentName startForegroundService(android.content.Intent i); public abstract android.content.Intent registerReceiver(android.content.BroadcastReceiver r, android.content.IntentFilter f);
 public final String getString(int id){return "";} public abstract int checkSelfPermission(String p); }''')
c('android.content.ComponentName', 'public class ComponentName {}')
c('android.content.BroadcastReceiver', 'public abstract class BroadcastReceiver {}')
c('android.content.IntentFilter', 'public class IntentFilter { public IntentFilter(String a){} }')
c('android.content.res.AssetManager', 'public class AssetManager { public java.io.InputStream open(String n) throws java.io.IOException { return null; } }')
c('android.content.Intent', '''public class Intent { public static final String ACTION_VIEW="v", ACTION_DIAL="d", ACTION_MAIN="m", ACTION_BATTERY_CHANGED="b", CATEGORY_LAUNCHER="l"; public static final int FLAG_ACTIVITY_NEW_TASK=1, FLAG_ACTIVITY_SINGLE_TOP=2;
 public Intent(){} public Intent(String a){} public Intent(String a, android.net.Uri u){} public Intent(android.content.Context c, Class<?> k){}
 public Intent addFlags(int f){return this;} public Intent addCategory(String c){return this;} public Intent putExtra(String k, String v){return this;} public Intent putExtra(String k, int v){return this;}
 public String getAction(){return null;} public int getIntExtra(String k,int d){return d;} public Intent setAction(String a){return this;} public Intent setPackage(String p){return this;} }''')
c('android.content.pm.PackageManager', '''public abstract class PackageManager { public static final int PERMISSION_GRANTED=0; public abstract java.util.List<ResolveInfo> queryIntentActivities(android.content.Intent i,int f);
 public abstract android.content.Intent getLaunchIntentForPackage(String p); public abstract PackageInfo getPackageInfo(String p,int f) throws NameNotFoundException; public static class NameNotFoundException extends Exception {} }''')
c('android.content.pm.PackageInfo', 'public class PackageInfo {}')
c('android.content.pm.ResolveInfo', 'public class ResolveInfo { public ActivityInfo activityInfo; public CharSequence loadLabel(PackageManager pm){return "";} }')
c('android.content.pm.ActivityInfo', 'public class ActivityInfo { public String packageName; }')
c('android.content.pm.ServiceInfo', 'public class ServiceInfo { public static final int FOREGROUND_SERVICE_TYPE_MICROPHONE=128, FOREGROUND_SERVICE_TYPE_LOCATION=8; }')
c('android.graphics.drawable.Icon', 'public final class Icon { public static Icon createWithResource(android.content.Context c,int r){return null;} }')
c('android.app.Activity', '''public class Activity extends android.content.Context { public Object getSystemService(String n){return null;} public android.content.res.AssetManager getAssets(){return null;} public android.content.pm.PackageManager getPackageManager(){return null;}
 public android.content.Context getApplicationContext(){return this;} public void startActivity(android.content.Intent i){} public android.content.ComponentName startService(android.content.Intent i){return null;}
 public android.content.ComponentName startForegroundService(android.content.Intent i){return null;} public android.content.Intent registerReceiver(android.content.BroadcastReceiver r, android.content.IntentFilter f){return null;}
 public int checkSelfPermission(String p){return 0;} public void runOnUiThread(Runnable r){} public android.view.Window getWindow(){return null;} public void setContentView(android.view.View v, android.view.ViewGroup.LayoutParams p){}
 protected void onCreate(android.os.Bundle b){} protected void onResume(){} protected void onDestroy(){} protected void onSaveInstanceState(android.os.Bundle b){} public void onBackPressed(){} public boolean moveTaskToBack(boolean b){return true;}
 public void requestPermissions(String[] p,int c){} public void onRequestPermissionsResult(int c,String[] p,int[] r){} }''')
c('android.app.Service', '''public abstract class Service extends android.content.Context { public static final int START_NOT_STICKY=2, START_STICKY=1; public Object getSystemService(String n){return null;} public android.content.res.AssetManager getAssets(){return null;}
 public android.content.pm.PackageManager getPackageManager(){return null;} public android.content.Context getApplicationContext(){return this;} public void startActivity(android.content.Intent i){}
 public android.content.ComponentName startService(android.content.Intent i){return null;} public android.content.ComponentName startForegroundService(android.content.Intent i){return null;}
 public android.content.Intent registerReceiver(android.content.BroadcastReceiver r, android.content.IntentFilter f){return null;} public int checkSelfPermission(String p){return 0;}
 public int onStartCommand(android.content.Intent i,int f,int s){return 0;} public abstract android.os.IBinder onBind(android.content.Intent i); public void onDestroy(){} public final void stopForeground(boolean b){} public final void stopSelf(){}
 public final void startForeground(int id, android.app.Notification n){} public final void startForeground(int id, android.app.Notification n, int t){} }''')
c('android.app.Notification', '''public class Notification { public static class Builder { public Builder(android.content.Context c,String ch){} public Builder setSmallIcon(int i){return this;} public Builder setContentTitle(CharSequence t){return this;}
 public Builder setContentText(CharSequence t){return this;} public Builder setContentIntent(android.app.PendingIntent p){return this;} public Builder setOngoing(boolean b){return this;} public Builder addAction(Action a){return this;} public Notification build(){return null;} }
 public static class Action { public static class Builder { public Builder(android.graphics.drawable.Icon i, CharSequence t, android.app.PendingIntent p){} public Action build(){return null;} } } }''')
c('android.app.NotificationChannel', 'public class NotificationChannel { public NotificationChannel(String id, CharSequence n, int i){} }')
c('android.app.NotificationManager', 'public class NotificationManager { public static final int IMPORTANCE_LOW=2; public void createNotificationChannel(NotificationChannel c){} }')
c('android.app.PendingIntent', '''public class PendingIntent { public static final int FLAG_IMMUTABLE=1, FLAG_UPDATE_CURRENT=2; public static PendingIntent getActivity(android.content.Context c,int r,android.content.Intent i,int f){return null;}
 public static PendingIntent getService(android.content.Context c,int r,android.content.Intent i,int f){return null;} }''')
c('android.app.SearchManager', 'public class SearchManager { public static final String QUERY="query"; }')
c('android.net.Uri', 'public class Uri { public static Uri parse(String s){return null;} public String getScheme(){return null;} public String getHost(){return null;} }')
c('android.net.Network', 'public class Network {}')
c('android.net.NetworkCapabilities', 'public class NetworkCapabilities { public static final int TRANSPORT_WIFI=1, TRANSPORT_CELLULAR=0; public boolean hasTransport(int t){return false;} }')
c('android.net.ConnectivityManager', 'public class ConnectivityManager { public Network getActiveNetwork(){return null;} public NetworkCapabilities getNetworkCapabilities(Network n){return null;} }')
c('android.os.Bundle', 'public class Bundle { public void putInt(String k,int v){} }')
c('android.os.IBinder', 'public interface IBinder {}')
c('android.os.Process', 'public class Process { public static final int THREAD_PRIORITY_URGENT_AUDIO=-19; public static int myPid(){return 0;} public static void killProcess(int p){} public static void setThreadPriority(int p){} }')
c('android.os.Build', 'public class Build { public static class VERSION { public static final int SDK_INT=34; } }')
c('android.os.BatteryManager', 'public class BatteryManager { public static final String EXTRA_LEVEL="level", EXTRA_SCALE="scale", EXTRA_STATUS="status"; public static final int BATTERY_STATUS_CHARGING=2, BATTERY_STATUS_FULL=5; }')
c('android.os.PowerManager', '''public class PowerManager { public static final int PARTIAL_WAKE_LOCK=1; public WakeLock newWakeLock(int l,String t){return null;}
 public static class WakeLock { public void acquire(){} public void release(){} public boolean isHeld(){return false;} public void setReferenceCounted(boolean b){} } }''')
c('android.provider.MediaStore', 'public class MediaStore { public static final String INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH="a", EXTRA_MEDIA_FOCUS="b"; }')
c('android.media.AudioAttributes', '''public class AudioAttributes { public static final int USAGE_ASSISTANCE_NAVIGATION_GUIDANCE=12, CONTENT_TYPE_SPEECH=1, USAGE_ASSISTANCE_SONIFICATION=13, CONTENT_TYPE_SONIFICATION=4; public static class Builder { public Builder setUsage(int u){return this;} public Builder setContentType(int c){return this;} public AudioAttributes build(){return null;} } }''')
c('android.media.AudioFocusRequest', '''public class AudioFocusRequest { public static class Builder { public Builder(int g){} public Builder setAudioAttributes(AudioAttributes a){return this;}
 public Builder setOnAudioFocusChangeListener(AudioManager.OnAudioFocusChangeListener l){return this;} public AudioFocusRequest build(){return null;} } }''')
c('android.media.AudioManager', '''public class AudioManager { public static final int AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK=3, STREAM_MUSIC=3; public int requestAudioFocus(AudioFocusRequest r){return 0;} public int abandonAudioFocusRequest(AudioFocusRequest r){return 0;}
 public void dispatchMediaKeyEvent(android.view.KeyEvent e){} public interface OnAudioFocusChangeListener { void onAudioFocusChange(int c); } }''')
c('android.speech.tts.TextToSpeech', '''public class TextToSpeech { public static final int SUCCESS=0, QUEUE_ADD=1; public interface OnInitListener { void onInit(int status); } public static class Engine { public static final String KEY_PARAM_STREAM="streamType"; }
 public TextToSpeech(android.content.Context c, OnInitListener l){} public int setLanguage(java.util.Locale l){return 0;} public int setAudioAttributes(android.media.AudioAttributes a){return 0;} public int setOnUtteranceProgressListener(UtteranceProgressListener l){return 0;}
 public int speak(CharSequence t,int m,android.os.Bundle p,String id){return 0;} public int stop(){return 0;} public void shutdown(){} public int setSpeechRate(float r){return 0;} public int setPitch(float p){return 0;}
 public java.util.Set<Voice> getVoices(){return null;} public int setVoice(Voice v){return 0;} }''')
c('android.speech.tts.UtteranceProgressListener', '''public abstract class UtteranceProgressListener { public abstract void onStart(String id); public abstract void onDone(String id); public abstract void onError(String id); public void onStop(String id, boolean interrupted){} }''')
c('android.speech.tts.Voice', 'public class Voice { public String getName(){return "";} public java.util.Locale getLocale(){return null;} public int getQuality(){return 0;} public boolean isNetworkConnectionRequired(){return false;} }')
c('android.util.Log', 'public class Log { public static int w(String t,String m){return 0;} public static int w(String t,String m,Throwable e){return 0;} public static int d(String t,String m){return 0;} public static int e(String t,String m){return 0;} public static int e(String t,String m,Throwable x){return 0;} }')
c('android.view.KeyEvent', 'public class KeyEvent { public static final int ACTION_DOWN=0, ACTION_UP=1, KEYCODE_MEDIA_PLAY=126, KEYCODE_MEDIA_PAUSE=127, KEYCODE_MEDIA_NEXT=87, KEYCODE_MEDIA_PREVIOUS=88; public KeyEvent(int a,int c){} }')
c('android.view.View', 'public class View { public static final int SYSTEM_UI_FLAG_LAYOUT_STABLE=256; public void setSystemUiVisibility(int v){} public void setBackgroundColor(int c){} }')
c('android.view.ViewGroup', 'public class ViewGroup extends View { public static class LayoutParams { public LayoutParams(int w,int h){} } }')
c('android.view.Window', 'public abstract class Window { public void addFlags(int f){} public void clearFlags(int f){} public View getDecorView(){return null;} }')
c('android.view.WindowManager', 'public interface WindowManager { class LayoutParams { public static final int FLAG_KEEP_SCREEN_ON=128; } }')
c('android.annotation.SuppressLint', 'public @interface SuppressLint { String[] value(); }')
c('android.Manifest', 'public final class Manifest { public static final class permission { public static final String RECORD_AUDIO="a", ACCESS_FINE_LOCATION="b", ACCESS_COARSE_LOCATION="c", POST_NOTIFICATIONS="d"; } }')
c('android.webkit.JavascriptInterface', '''@java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) public @interface JavascriptInterface {}''')
c('android.webkit.WebView', '''public class WebView extends android.view.View { public WebView(android.content.Context c){} public WebSettings getSettings(){return null;} public static void setWebContentsDebuggingEnabled(boolean b){}
 public void setWebViewClient(WebViewClient c){} public void setWebChromeClient(WebChromeClient c){} public void addJavascriptInterface(Object o,String n){} public void removeJavascriptInterface(String n){} public void loadUrl(String u){}
 public void evaluateJavascript(String s, ValueCallback<String> cb){} public Object restoreState(android.os.Bundle b){return null;} public Object saveState(android.os.Bundle b){return null;} public void destroy(){} }''')
c('android.webkit.ValueCallback', 'public interface ValueCallback<T> { void onReceiveValue(T v); }')
c('android.webkit.WebSettings', '''public abstract class WebSettings { public static final int MIXED_CONTENT_NEVER_ALLOW=1, LOAD_DEFAULT=-1; public abstract void setJavaScriptEnabled(boolean b); public abstract void setDomStorageEnabled(boolean b);
 public abstract void setMediaPlaybackRequiresUserGesture(boolean b); public abstract void setGeolocationEnabled(boolean b); public abstract void setAllowFileAccess(boolean b); public abstract void setAllowContentAccess(boolean b);
 public abstract void setMixedContentMode(int m); public abstract void setCacheMode(int m); }''')
c('android.webkit.WebViewClient', '''public class WebViewClient { public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r){return null;} public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r){return false;} }''')
c('android.webkit.WebResourceRequest', 'public interface WebResourceRequest { android.net.Uri getUrl(); }')
c('android.webkit.WebResourceResponse', 'public class WebResourceResponse { public WebResourceResponse(String m,String e,java.io.InputStream d){} }')
c('android.webkit.ConsoleMessage', 'public class ConsoleMessage { public String message(){return "";} public String sourceId(){return "";} public int lineNumber(){return 0;} }')
c('android.webkit.GeolocationPermissions', 'public class GeolocationPermissions { public interface Callback { void invoke(String origin, boolean allow, boolean retain); } }')
c('android.webkit.PermissionRequest', '''public abstract class PermissionRequest { public static final String RESOURCE_AUDIO_CAPTURE="a", RESOURCE_VIDEO_CAPTURE="v"; public abstract String[] getResources(); public abstract void grant(String[] r); public abstract void deny(); }''')
c('android.webkit.WebChromeClient', '''public class WebChromeClient { public void onPermissionRequest(PermissionRequest r){} public void onGeolocationPermissionsShowPrompt(String o, GeolocationPermissions.Callback c){} public boolean onConsoleMessage(ConsoleMessage m){return false;} }''')
c('androidx.webkit.WebViewAssetLoader', '''public final class WebViewAssetLoader { public static final String DEFAULT_DOMAIN="appassets.androidplatform.net"; public interface PathHandler { android.webkit.WebResourceResponse handle(String path); }
 public android.webkit.WebResourceResponse shouldInterceptRequest(android.net.Uri u){return null;} public static final class Builder { public Builder addPathHandler(String p, PathHandler h){return this;} public WebViewAssetLoader build(){return null;} } }''')
c('org.json.JSONObject', '''public class JSONObject { public JSONObject(){} public JSONObject(String s) throws JSONException {} public java.util.Iterator<String> keys(){return null;} public String optString(String k){return "";} public JSONObject put(String k,Object v) throws JSONException {return this;}
 public JSONObject put(String k,int v) throws JSONException {return this;} public JSONObject put(String k,boolean v) throws JSONException {return this;} public static String quote(String s){return s;} }''')
c('org.json.JSONException', 'public class JSONException extends Exception {}')
c('org.json.JSONArray', 'public class JSONArray { public JSONArray put(Object o){return this;} }')
c('com.jarvis.assistant.R', '''public final class R { public static final class drawable { public static final int ic_stat=1; } public static final class string { public static final int notif_title=1, notif_text=2, notif_quit=3, app_name=4; } }''')

c('android.media.AudioFormat', """public class AudioFormat { public static final int CHANNEL_IN_MONO=16, CHANNEL_OUT_MONO=4, ENCODING_PCM_16BIT=2;
 public static class Builder { public Builder setEncoding(int e){return this;} public Builder setSampleRate(int r){return this;} public Builder setChannelMask(int m){return this;} public AudioFormat build(){return null;} } }""")
c('android.media.AudioRecord', """public class AudioRecord { public static final int STATE_INITIALIZED=1; public AudioRecord(int src,int rate,int ch,int fmt,int size){} public static int getMinBufferSize(int r,int c,int f){return 0;}
 public int getState(){return 1;} public void release(){} public void startRecording(){} public void stop(){} public int read(short[] b,int off,int n){return n;} }""")
c('android.media.AudioTrack', """public class AudioTrack { public static final int MODE_STATIC=0; public int write(short[] d,int off,int n){return n;} public void play(){} public void release(){}
 public static class Builder { public Builder setAudioAttributes(AudioAttributes a){return this;} public Builder setAudioFormat(AudioFormat f){return this;} public Builder setTransferMode(int m){return this;} public Builder setBufferSizeInBytes(int n){return this;} public AudioTrack build(){return null;} } }""")
c('android.media.MediaRecorder', """public class MediaRecorder { public static class AudioSource { public static final int MIC=1, VOICE_RECOGNITION=6; } }""")
c('android.os.SystemClock', 'public class SystemClock { public static long elapsedRealtime(){return 0;} }')
c('ai.onnxruntime.OrtException', 'public class OrtException extends Exception {}')
c('ai.onnxruntime.OnnxValue', 'public interface OnnxValue extends AutoCloseable { void close(); }')
c('ai.onnxruntime.OnnxTensorLike', 'public abstract class OnnxTensorLike implements OnnxValue { public void close(){} }')
c('ai.onnxruntime.OnnxTensor', """public class OnnxTensor extends OnnxTensorLike { public static OnnxTensor createTensor(OrtEnvironment e, java.nio.FloatBuffer b, long[] shape) throws OrtException {return null;} public static OnnxTensor createTensor(OrtEnvironment e, java.nio.LongBuffer b, long[] shape) throws OrtException {return null;}
 public java.nio.FloatBuffer getFloatBuffer(){return null;} }""")
c('ai.onnxruntime.OrtEnvironment', 'public class OrtEnvironment { public static OrtEnvironment getEnvironment(){return null;} public OrtSession createSession(byte[] m, OrtSession.SessionOptions o) throws OrtException {return null;} }')
c('ai.onnxruntime.OrtSession', """public class OrtSession implements AutoCloseable { public java.util.Set<String> getInputNames() throws OrtException {return null;}
 public Result run(java.util.Map<String, ? extends OnnxTensorLike> inputs) throws OrtException {return null;} public void close(){}
 public static class SessionOptions implements AutoCloseable { public void setIntraOpNumThreads(int n) throws OrtException {} public void setInterOpNumThreads(int n) throws OrtException {} public void close(){} }
 public static class Result implements AutoCloseable, Iterable<java.util.Map.Entry<String, OnnxValue>> { public OnnxValue get(int i){return null;} public void close(){} public java.util.Iterator<java.util.Map.Entry<String, OnnxValue>> iterator(){return null;} } }""")

for fq, body in S.items():
    pkg, name = fq.rsplit('.', 1)
    d = os.path.join(OUT, *pkg.split('.')); os.makedirs(d, exist_ok=True)
    body = body if body.lstrip().startswith(('public', '@')) else 'public ' + body
    open(os.path.join(d, name + '.java'), 'w').write(f'package {pkg};\n{body}\n')
print(len(S), 'stubs')
