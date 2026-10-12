package com.jarvis.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Face recognition on the phone, like the PC version: YuNet finds the face, SFace turns it into a 128-number signature,
 * and signatures are compared with the people you asked Jarvis to remember (same threshold as the PC, 0.42).
 * Faces are kept only on this phone (SharedPreferences), as signatures, never as photos.
 */
public final class FaceEngine {
    private static final String TAG = "JarvisFace", PREFS = "jarvis_faces";
    static final double MATCH = 0.42;
    private static final float DETECT_SCORE = 0.6f, NMS = 0.3f;
    private final Context ctx;
    private OrtSession yunet, sface;
    private OrtEnvironment env;
    private String loadError = "";

    FaceEngine(Context c) { ctx = c.getApplicationContext(); }

    private static byte[] asset(Context c, String name) throws Exception {
        try (InputStream in = c.getAssets().open(name)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return bo.toByteArray();
        }
    }

    private synchronized boolean load() {
        if (yunet != null && sface != null) return true;
        if (!loadError.isEmpty()) return false;
        try {
            env = OrtEnvironment.getEnvironment();
            OrtSession.SessionOptions o = new OrtSession.SessionOptions();
            o.setIntraOpNumThreads(2);
            yunet = env.createSession(asset(ctx, "face/yunet.onnx"), o);
            sface = env.createSession(asset(ctx, "face/sface.onnx"), o);
            return true;
        } catch (Throwable e) { loadError = String.valueOf(e); Log.e(TAG, "face models", e); return false; }
    }

    boolean available() {
        try { ctx.getAssets().open("face/sface.onnx").close(); return true; } catch (Exception e) { return false; }
    }

    /** The signature of the largest face in a JPEG, or null if there's no face. Throws if the models can't load. */
    synchronized float[] signature(byte[] jpeg) throws Exception {
        if (!load()) throw new IllegalStateException("face models: " + loadError);
        BitmapFactory.Options opt = new BitmapFactory.Options();
        opt.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, opt);
        if (bmp == null) throw new IllegalArgumentException("not a picture");
        int w = bmp.getWidth(), h = bmp.getHeight();
        int[] px = new int[w * h];
        bmp.getPixels(px, 0, w, 0, 0, w, h);
        bmp.recycle();
        FaceMath.Input in = FaceMath.letterbox(px, w, h);
        float[][] cls = new float[3][], obj = new float[3][], box = new float[3][], kps = new float[3][];
        OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(in.blob), new long[]{1, 3, FaceMath.SIZE, FaceMath.SIZE});
        try {
            OrtSession.Result r = yunet.run(Collections.singletonMap(yunet.getInputNames().iterator().next(), t));
            try {
                // outputs in the model's order: cls_8/16/32, obj_8/16/32, bbox_8/16/32, kps_8/16/32
                for (int s = 0; s < 3; s++) { cls[s] = floats(r, s); obj[s] = floats(r, 3 + s); box[s] = floats(r, 6 + s); kps[s] = floats(r, 9 + s); }
            } finally { r.close(); }
        } finally { t.close(); }
        List<FaceMath.Face> faces = FaceMath.decode(cls, obj, box, kps, DETECT_SCORE, NMS, in.sx, in.sy);
        FaceMath.Face f = FaceMath.largest(faces);
        if (f == null) return null;
        float[] blob = FaceMath.alignedBlob(px, w, h, FaceMath.similarity(f.lm));
        OnnxTensor a = OnnxTensor.createTensor(env, FloatBuffer.wrap(blob), new long[]{1, 3, 112, 112});
        try {
            OrtSession.Result r = sface.run(Collections.singletonMap(sface.getInputNames().iterator().next(), a));
            try { return floats(r, 0); } finally { r.close(); }
        } finally { a.close(); }
    }

    private static float[] floats(OrtSession.Result r, int i) throws Exception {
        FloatBuffer fb = ((OnnxTensor) r.get(i)).getFloatBuffer();
        float[] out = new float[fb.remaining()];
        fb.get(out);
        return out;
    }

    // ------------------------------------------------------------------ the people Jarvis knows
    private SharedPreferences prefs() { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    synchronized JSONArray people() {
        try { return new JSONArray(prefs().getString("people", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    private synchronized void save(JSONArray a) { prefs().edit().putString("people", a.toString()).apply(); }

    private static String key(String name) { return name == null ? "" : name.trim().toLowerCase(Locale.ROOT); }

    /** Adds this signature to the person (up to 5 per person, from different moments, for better recognition). */
    synchronized int remember(String name, String title, float[] sig) throws Exception {
        JSONArray all = people();
        JSONObject p = null;
        for (int i = 0; i < all.length(); i++) if (key(all.getJSONObject(i).optString("name")).equals(key(name))) { p = all.getJSONObject(i); break; }
        if (p == null) { p = new JSONObject(); p.put("name", name.trim()); p.put("samples", new JSONArray()); all.put(p); }
        if (title != null && !title.trim().isEmpty()) p.put("title", title.trim());
        JSONArray s = p.getJSONArray("samples");
        JSONArray v = new JSONArray();
        for (float x : sig) v.put((double) Math.round(x * 10000) / 10000.0);
        s.put(v);
        while (s.length() > 5) s.remove(0);
        save(all);
        return s.length();
    }

    /** {name, title, similarity} of the best match over the threshold, or null. */
    synchronized JSONObject match(float[] sig) throws Exception {
        JSONArray all = people();
        JSONObject best = null;
        double bestSim = MATCH;
        for (int i = 0; i < all.length(); i++) {
            JSONObject p = all.getJSONObject(i);
            JSONArray s = p.optJSONArray("samples");
            if (s == null) continue;
            for (int j = 0; j < s.length(); j++) {
                JSONArray v = s.getJSONArray(j);
                float[] ref = new float[v.length()];
                for (int k = 0; k < ref.length; k++) ref[k] = (float) v.getDouble(k);
                double sim = FaceMath.cosine(sig, ref);
                if (sim >= bestSim) { bestSim = sim; best = new JSONObject().put("name", p.optString("name")).put("title", p.optString("title")).put("similarity", Math.round(sim * 100) / 100.0); }
            }
        }
        return best;
    }

    synchronized boolean forget(String name) {
        JSONArray all = people(), out = new JSONArray();
        boolean hit = false;
        for (int i = 0; i < all.length(); i++) {
            JSONObject p = all.optJSONObject(i);
            if (p != null && (key(name).equals("everyone") || key(p.optString("name")).equals(key(name)))) { hit = true; continue; }
            out.put(p);
        }
        save(out);
        return hit;
    }
}
