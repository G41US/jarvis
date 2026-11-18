"""Streaming studio (desktop/app/studio.py) against a stand-in OBS that speaks obs-websocket 5 with a password, like the real one.
Run: python tests/studio_test.py   (needs fastapi, httpx, websockets)"""
import asyncio, base64, hashlib, json, os, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "desktop", "app"))
PW = "hunter2"

# ---------------- a fake OBS ----------------
class FakeObs:
    def __init__(self):
        self.scenes = []; self.items = {}; self.inputs = {}; self.current = None; self.live = False; self.calls = []

    def handle(self, t, d):
        self.calls.append(t)
        if t == "CreateScene":
            if d["sceneName"] in self.scenes: return False, 601, "A source already exists by that scene name."
            self.scenes.append(d["sceneName"]); self.items[d["sceneName"]] = []; return True, 100, None
        if t == "CreateInput":
            if d["inputName"] in self.inputs: return False, 601, "A source already exists by that input name."
            self.inputs[d["inputName"]] = (d["inputKind"], d.get("inputSettings") or {}); self.items[d["sceneName"]].append(d["inputName"]); return True, 100, None
        if t == "SetInputSettings": self.inputs[d["inputName"]] = (self.inputs[d["inputName"]][0], d["inputSettings"]); return True, 100, None
        if t == "CreateSceneItem": self.items[d["sceneName"]].append(d["sourceName"]); return True, 100, None
        if t == "GetSceneItemId": return True, 100, {"sceneItemId": self.items[d["sceneName"]].index(d["sourceName"]) + 1}
        if t == "SetSceneItemIndex":
            it = self.items[d["sceneName"]]; name = it.pop(d["sceneItemId"] - 1); it.insert(d["sceneItemIndex"], name); return True, 100, None
        if t == "SetCurrentProgramScene":
            if d["sceneName"] not in self.scenes: return False, 600, "No source was found by the name of `%s`." % d["sceneName"]
            self.current = d["sceneName"]; return True, 100, None
        if t == "GetCurrentProgramScene": return True, 100, {"currentProgramSceneName": self.current, "sceneName": self.current}
        if t == "GetSceneList": return True, 100, {"scenes": [{"sceneName": n} for n in reversed(self.scenes)]}
        if t == "GetStreamStatus": return True, 100, {"outputActive": self.live, "outputTimecode": "00:12:03.000"}
        if t == "GetRecordStatus": return True, 100, {"outputActive": False}
        if t == "StartStream": self.live = True; return True, 100, None
        if t == "StopStream": self.live = False; return True, 100, None
        if t == "SetInputMute": return True, 100, None
        if t == "PressInputPropertiesButton": return True, 100, None
        return False, 204, f"Unknown request type {t}"

def run_fake_obs(fake, port):
    import websockets
    async def conn(ws):
        salt, challenge = "s4lt", "ch4llenge"
        await ws.send(json.dumps({"op": 0, "d": {"rpcVersion": 1, "authentication": {"salt": salt, "challenge": challenge}}}))
        ident = json.loads(await ws.recv())
        secret = base64.b64encode(hashlib.sha256((PW + salt).encode()).digest()).decode()
        want = base64.b64encode(hashlib.sha256((secret + challenge).encode()).digest()).decode()
        if ident["d"].get("authentication") != want: await ws.close(4009, "Authentication failed."); return
        await ws.send(json.dumps({"op": 2, "d": {"negotiatedRpcVersion": 1}}))
        async for raw in ws:
            m = json.loads(raw); d = m["d"]
            ok, code, extra = fake.handle(d["requestType"], d.get("requestData") or {})
            resp = {"requestType": d["requestType"], "requestId": d["requestId"], "requestStatus": {"result": ok, "code": code}}
            if not ok: resp["requestStatus"]["comment"] = extra
            elif extra: resp["responseData"] = extra
            await ws.send(json.dumps({"op": 7, "d": resp}))
    async def main():
        async with websockets.serve(conn, "127.0.0.1", port): await asyncio.Future()
    threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start()
    time.sleep(0.5)

# ---------------- the parts of server.py studio.install() uses ----------------
def make_ns():
    from fastapi import FastAPI
    reg, schemas = {}, []
    def tool(name, description="", properties=None, required=None):
        def deco(fn): reg[name] = fn; schemas.append(name); return fn
        return deco
    return {"tool": tool, "app": FastAPI(), "_TOOL_GROUPS": [], "_needs_tool": lambda t: False, "_reg": reg}

fails = []
def check(cond, what):
    print(("  ok  " if cond else "  FAIL ") + what)
    if not cond: fails.append(what)

def main():
    work = tempfile.mkdtemp(); os.chdir(work)
    os.environ.update({"OBS_PORT": "4466", "OBS_PASSWORD": "wrong", "JARVIS_PORT": "8000"})
    import studio
    ns = make_ns(); studio.install(ns); T = ns["_reg"]
    from fastapi.testclient import TestClient
    web = TestClient(ns["app"])

    print("OBS not running:")
    r = T["stream_studio"]("JARVIS x GTA 6", "MARATHON STREAM", "vice city", "twitch.tv/yourname, @yourname", 5, "SUB GOAL", 5)
    check("designs are ready" in r and "WebSocket" in r, "says the designs are ready and how to switch OBS's WebSocket on")
    check(all(os.path.exists(f"overlays/jarvis-{k}.html") for k in ("starting", "brb", "ending", "gameplay")), "all four overlays written")

    fake = FakeObs(); run_fake_obs(fake, 4466)
    print("OBS with the wrong password:")
    r = T["obs"]("status"); check("password" in r.lower(), f"explains the password problem ({r[:60]}...)")

    print("OBS running:")
    os.environ["OBS_PASSWORD"] = PW; studio.OBS._drop()
    r = T["stream_studio"]("JARVIS x GTA 6", "MARATHON STREAM", "vice city", "twitch.tv/yourname, @yourname", 5, "SUB GOAL", 5)
    check(r.startswith("Done in OBS"), "builds the scenes: " + r[:70])
    check(set(fake.scenes) == {"Starting Soon", "Be Right Back", "Ending", "Gameplay"}, f"four scenes {fake.scenes}")
    check(fake.current == "Starting Soon", "Starting Soon on screen")
    check(fake.items["Gameplay"][0] == "Game" and "Jarvis Gameplay Overlay" in fake.items["Gameplay"], f"game under the overlay {fake.items['Gameplay']}")
    check(fake.inputs["Jarvis Starting Soon"][1]["url"].endswith("/overlay/jarvis-starting"), "browser source points at Jarvis's overlay")
    check(fake.inputs["Game"][0] in ("game_capture", "screen_capture"), "game capture source")
    r = T["stream_studio"]("JARVIS x GTA 6", "MARATHON STREAM", "vice", "", 5)
    check(r.startswith("Done in OBS") and len(fake.scenes) == 4, "running it twice doesn't duplicate scenes")

    print("OBS actions:")
    check("Gameplay is on screen" in T["obs"]("switch_scene", name="gameplay"), "switch scene by loose name")
    r = T["obs"]("start_stream"); check("Ask him first" in r and not fake.live, "won't go live without a yes")
    check(T["obs"]("start_stream", confirmed=True) == "We're live." and fake.live, "goes live after yes")
    check("Live for 00:12:03" in T["obs"]("status"), "status says live")
    check("Scenes:" in T["obs"]("list_scenes"), "lists scenes")
    check("Added Camera" in T["obs"]("add_source", source="camera", scene="Gameplay"), "adds the camera")
    check("Stream ended" in T["obs"]("stop_stream", confirmed=True) and not fake.live, "ends the stream after yes")

    print("Overlays:")
    page = web.get("/overlay/jarvis-starting")
    check(page.status_code == 200 and "JARVIS x GTA 6" in page.text and "STARTING IN" in page.text, "starting-soon page served")
    check(web.get("/overlay/nope").status_code == 404, "unknown overlay is a 404")
    check(web.get("/overlay_image", params={"path": "/etc/passwd"}).status_code == 404, "won't serve non-image files")
    st = web.get("/overlay_state").json()
    check(st["goal"]["target"] == 5 and st["countdown_end"] > time.time() + 200, "goal and countdown in the live state")
    T["overlay"]("alert", title="mission passed", sub="new follower: Sam")
    T["overlay"]("add_star"); T["overlay"]("radio", text="Non Stop Pop FM")
    st = web.get("/overlay_state").json()
    check(st["alert"]["title"] == "MISSION PASSED" and st["goal"]["current"] == 1 and st["now_playing"] == "Non Stop Pop FM", "alert, star, radio live")
    check("Restyled: gold" in T["overlay"]("restyle", theme="black and gold"), "restyle redraws")
    check("#ffcc4d" in web.get("/overlay/jarvis-gameplay").text, "gameplay overlay took the new colours")

    print("Announcements:")
    r = T["announce"]("We go live at 8!", "discord"); check("Read him this exact message" in r, "asks before posting")
    os.environ.pop("DISCORD_WEBHOOK_URL", None)
    check("Discord isn't connected" in T["announce"]("x", "discord", True), "explains Discord setup")
    sent = []
    studio.post_discord = lambda t: (sent.append(("d", t)) or (True, ""))
    studio.post_telegram = lambda t: (sent.append(("t", t)) or (True, ""))
    r = T["announce"]("We go live at 8!", "both", True)
    check(r == "Sent to Discord. Sent to Telegram." and len(sent) == 2, "posts to both after yes")

    print("Routing:")
    check(ns["_needs_tool"]("yo prepare everything for the stream"), "stream talk counts as a request")
    check(ns["_TOOL_GROUPS"][0][1] == ("stream_studio", "obs", "overlay", "announce"), "studio tools offered for stream talk")
    print("\n" + ("ALL PASSED" if not fails else f"{len(fails)} FAILED"))
    sys.exit(1 if fails else 0)

if __name__ == "__main__": main()
