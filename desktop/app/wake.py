r"""
wake.py - always-on "Hey Jarvis" listener.

Started automatically by server.py, or run it alone to debug:
    venv\Scripts\python.exe wake.py

Set JARVIS_WAKE_DEBUG=1 to print the live detection score every two seconds.
Set JARVIS_WAKE_THRESHOLD=0.2 to make it more sensitive (default 0.3).
Set JARVIS_MIC_INDEX=<n> to pick a microphone (the device list prints at start).
Set JARVIS_WAKE_GAIN_MAX=1 to turn off the automatic boost for quiet microphones (default 6).
"""
import os
import sys
import time

import numpy as np
import requests
import pyaudio
import openwakeword
from openwakeword.model import Model

SERVER = os.environ.get("JARVIS_SERVER", "http://127.0.0.1:8000")
THRESHOLD = float(os.environ.get("JARVIS_WAKE_THRESHOLD", "0.3"))
DEBUG = os.environ.get("JARVIS_WAKE_DEBUG", "0") == "1"
MIC_INDEX = os.environ.get("JARVIS_MIC_INDEX", "").strip()
RATE = 16000
CHUNK = 1280              # 80 ms at 16 kHz, what openwakeword expects
COOLDOWN_S = 2.0          # ignore repeat triggers right after a wake
GAIN_MAX = float(os.environ.get("JARVIS_WAKE_GAIN_MAX", "6"))   # quiet mics get boosted up to this much


def auto_gain(x, recent_peak):
    """Boost a quiet voice toward a healthy level so 'Hey Jarvis' doesn't have to be shouted.
    Pure room noise (peak under 250) is left alone, so silence is never amplified into false wakes.
    Returns (samples, new_recent_peak)."""
    recent_peak = max(float(np.max(np.abs(x))) if len(x) else 0.0, recent_peak * 0.97)
    if GAIN_MAX > 1.0 and 250.0 < recent_peak < 5000.0:
        g = min(GAIN_MAX, 6000.0 / recent_peak)
        x = np.clip(x.astype(np.float32) * g, -32768, 32767).astype(np.int16)
    return x, recent_peak


def log(*a):
    print(time.strftime("%H:%M:%S"), "[WAKE]", *a, flush=True)     # the time, so a log shows which start each line belongs to


def load_model():
    res = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
    have = os.path.isdir(res) and any(f.startswith("hey_jarvis") for f in os.listdir(res)) and any(f.startswith("melspectrogram") for f in os.listdir(res))
    try:
        if have: raise FileExistsError     # shipped with the app: nothing to fetch (on a slow line that download kept him deaf for minutes)
        try:
            openwakeword.utils.download_models(model_names=["hey_jarvis"])
        except TypeError:                      # older openwakeword versions
            openwakeword.utils.download_models()
    except FileExistsError: pass
    except Exception as e:
        log(f"model download skipped ({type(e).__name__}); using cached files if present")
    for framework in ("onnx", None):
        try:
            kw = {"wakeword_models": ["hey_jarvis"]}
            if framework:
                kw["inference_framework"] = framework
            m = Model(**kw)
            log("model ready:", ", ".join(getattr(m, "models", {}).keys()) or "hey_jarvis")
            return m
        except Exception as e:
            log(f"model load failed ({framework or 'default'} backend): {type(e).__name__}: {e}")
    return None


def list_mics(pa):
    log("input devices:")
    for i in range(pa.get_device_count()):
        try:
            d = pa.get_device_info_by_index(i)
            if d.get("maxInputChannels", 0) > 0:
                log(f"   [{i}] {d['name']}")
        except Exception:
            pass


def open_mic(pa):
    """Open the mic at 16 kHz, or at the device's own rate (we resample). Returns (stream, rate, frames)."""
    try:
        if MIC_INDEX.isdigit():
            info = pa.get_device_info_by_index(int(MIC_INDEX))
        else:
            info = pa.get_default_input_device_info()
    except Exception as e:
        log(f"no usable microphone found ({e}). Plug one in / enable it in Windows sound settings.")
        list_mics(pa)
        return None, 0, 0
    idx = int(info["index"])
    rates = [RATE]
    native = int(info.get("defaultSampleRate", 0) or 0)
    if native and native != RATE:
        rates.append(native)
    for rate in rates:
        frames = int(CHUNK * rate / RATE)
        try:
            s = pa.open(format=pyaudio.paInt16, channels=1, rate=rate, input=True,
                        input_device_index=idx, frames_per_buffer=frames)
            log(f"listening on '{info['name']}' at {rate} Hz")
            return s, rate, frames
        except Exception as e:
            log(f"could not open mic at {rate} Hz: {e}")
    list_mics(pa)
    return None, 0, 0


def notify_server(state):
    """Tell the Jarvis page to wake. Returns True if at least one browser tab heard it."""
    for _ in range(3):
        try:
            r = requests.post(f"{SERVER}/wake", timeout=3)
            sent = r.json().get("sent_to", 0)
            if sent == 0 and time.time() - state.get("warned", 0) > 30:
                state["warned"] = time.time()
                log(f"heard you, but no Jarvis page is connected. Open {SERVER} in your browser and leave it open.")
            return sent > 0
        except Exception as e:
            err = type(e).__name__
            time.sleep(0.5)
    if time.time() - state.get("warned", 0) > 30:
        state["warned"] = time.time()
        log(f"heard you, but the Jarvis server at {SERVER} isn't reachable ({err}).")
    return False


def main():
    model = load_model()
    if model is None:
        log("FATAL: could not load the 'hey_jarvis' wake word model. Run once with internet so it can download.")
        sys.exit(1)

    pa = pyaudio.PyAudio()
    stream, rate, frames = None, 0, 0
    last_fire = 0.0
    recent_peak = 0.0
    peak = 0.0
    last_dbg = time.time()
    level, best, last_lvl, first_lvl = 0.0, 0.0, time.time(), True   # what the mic actually hears, logged so a dead or muted mic is obvious
    dead_since = None     # a mic giving pure digital silence (another app holding it, or Windows switched device): reopen it
    state = {}
    log(f"waiting for 'Hey Jarvis' (trigger score {THRESHOLD})")

    try:
        while True:
            if stream is None:
                stream, rate, frames = open_mic(pa)
                if stream is None:
                    time.sleep(3)
                    continue
            try:
                pcm = stream.read(frames, exception_on_overflow=False)
            except Exception as e:
                log(f"mic read failed ({e}); reopening")
                try:
                    stream.close()
                except Exception:
                    pass
                stream = None
                time.sleep(1)
                continue

            x = np.frombuffer(pcm, dtype=np.int16)
            if len(x): level = max(level, float(np.max(np.abs(x))))
            # a real room is never this quiet (even silence reads 20+): the mic is blocked or gone, so open it afresh
            # (the default mic may have changed, e.g. a headset was plugged in or Windows handed it to another app)
            if len(x) and np.max(np.abs(x)) <= 2:
                dead_since = dead_since or time.time()
                if time.time() - dead_since > 20:
                    log("the mic has given pure silence for 20 s (muted, blocked, or the default mic changed); reopening it")
                    try: stream.close()
                    except Exception: pass
                    try: pa.terminate(); pa = pyaudio.PyAudio()      # a fresh look at the devices: Windows may have a new default
                    except Exception as e: log(f"audio restart failed: {e}")
                    stream, dead_since = None, None
                    time.sleep(1); continue
            else:
                dead_since = None
            if rate != RATE:
                x = np.interp(np.linspace(0, len(x) - 1, CHUNK), np.arange(len(x)), x).astype(np.int16)

            x, recent_peak = auto_gain(x, recent_peak)

            try:
                pred = model.predict(x)
            except Exception as e:
                log(f"model error: {e}")
                time.sleep(0.5)
                continue
            score = max(pred.values()) if pred else 0.0
            peak = max(peak, score); best = max(best, score)
            if time.time() - last_lvl > (5 if first_lvl else 15):
                if first_lvl or level > 400:
                    hint = "  <- almost silent: is the mic muted (Dell: F4 key light) or the wrong device?" if level < 150 else ""
                    log(f"mic level {int(level)} of 32767, best 'Hey Jarvis' score {best:.2f} (wakes at {THRESHOLD}){hint}")
                level, best, last_lvl, first_lvl = 0.0, 0.0, time.time(), False

            if DEBUG and time.time() - last_dbg > 2:
                log(f"peak score {peak:.2f} (wakes at {THRESHOLD})")
                peak, last_dbg = 0.0, time.time()

            if score > THRESHOLD and time.time() - last_fire > COOLDOWN_S:
                last_fire = time.time()
                log(f"Hey Jarvis detected (score {score:.2f})")
                notify_server(state)
                try:
                    model.reset()
                except Exception:
                    pass
    except KeyboardInterrupt:
        log("stopping")
    finally:
        try:
            if stream:
                stream.stop_stream()
                stream.close()
        except Exception:
            pass
        pa.terminate()


if __name__ == "__main__":
    main()
