"""Screen control (desktop/app/pc_control.py) end to end on a real screen: a small app with a text box and two buttons, the real
mouse and keyboard, and a scripted stand-in for the vision model's choices. Checks it clicks and types, stops to ask before a step
that can't be undone, carries on after a yes, and reports back.
Run on a desktop, or headless:  Xvfb :99 & DISPLAY=:99 python3 tests/pc_control_test.py   (needs tkinter, pyautogui, pillow, fastapi)"""
import json, os, subprocess, sys, tempfile, textwrap, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "desktop", "app"))
fails = []
def check(c, w): print(("  ok  " if c else "  FAIL ") + w); (None if c else fails.append(w))

TARGET = textwrap.dedent('''
    import sys, tkinter as tk
    log = open(sys.argv[1], "a", buffering=1)
    r = tk.Tk(); r.geometry("700x400+0+0"); r.title("Test app")
    e = tk.Entry(r, font=("Arial", 16)); e.place(x=100, y=80, width=400, height=36)
    tk.Button(r, text="Open", command=lambda: log.write("open\\n")).place(x=100, y=200, width=120, height=40)
    tk.Button(r, text="Delete all", command=lambda: log.write("delete " + e.get() + "\\n")).place(x=400, y=200, width=160, height=40)
    r.mainloop()''')

def main():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    log = tempfile.mktemp(); tf = tempfile.mktemp(suffix=".py"); open(tf, "w").write(TARGET)
    target = subprocess.Popen([sys.executable, tf, log]); time.sleep(1.5)

    script = [   # what the "vision model" decides, step by step (screen is 1280 wide, so screenshot pixels = screen pixels)
        {"action": "click", "x": 160, "y": 220, "risky": False},
        {"action": "type", "x": 300, "y": 98, "text": "old files", "risky": False},
        {"action": "click", "x": 480, "y": 220, "risky": True},              # "Delete all": must ask first
        {"action": "click", "x": 480, "y": 220, "risky": True},              # after the yes
        {"action": "done", "say": "Cleared them out."},
    ]
    seen = []
    def describe(url, prompt):
        seen.append(prompt); return json.dumps(script.pop(0)) if script else json.dumps({"action": "done"})
    said, conv, reg = [], [], {}
    def tool(name, description="", properties=None, required=None):
        def deco(fn): reg[name] = fn; return fn
        return deco
    ns = {"tool": tool, "app": FastAPI(), "_TOOL_GROUPS": [], "_needs_tool": lambda t: False, "_describe_image": describe,
          "_broadcast_ws": lambda m: said.append(m), "conversation": conv}
    import pc_control
    pc_control.install(ns)
    web = TestClient(ns["app"])

    print("Floating head state:")
    check(web.get("/ui_state").json()["window_open"] is False, "no page yet: the head should show")
    web.post("/ui_state", json={"state": "listening", "visible": False})
    st = web.get("/ui_state").json()
    check(st["window_open"] and not st["visible"] and st["state"] == "listening", f"page minimised and listening: {st}")

    print("Driving the screen:")
    r = reg["use_computer"]("clear out the old files")
    check(r.startswith("On it"), "starts in the background")
    for _ in range(100):
        if not pc_control.RUN["busy"]: break
        time.sleep(0.2)
    lines = open(log).read().split("\n") if os.path.exists(log) else []
    check("open" in lines, "clicked Open with the real mouse")
    check(not any(l.startswith("delete") for l in lines), "did NOT press Delete all on its own")
    check(said and "can't be undone" in said[-1] and conv and conv[-1]["role"] == "assistant", f"asked first: {said[-1] if said else None}")
    check("Ask him" in reg["use_computer"](action="continue"), "won't continue without confirmed=true")
    reg["use_computer"](action="continue", confirmed=True)
    for _ in range(100):
        if not pc_control.RUN["busy"]: break
        time.sleep(0.2)
    lines = open(log).read().split("\n")
    check("delete old files" in lines, f"typed into the box and pressed Delete all after the yes: {lines}")
    check(said[-1] == "proactive:Cleared them out.", "reported back when done")
    check("[1]" not in seen[0] and "(none listed" in seen[0], "no UI Automation here: the model is told to use x and y")
    check(pc_control.RUN["log"][:2] == ["click (160, 220)", "typed 'old files'"], f"step log {pc_control.RUN['log']}")

    print("Stop:")
    script[:] = [{"action": "wait"}] * 50
    reg["use_computer"]("wait around")
    time.sleep(0.8); check(reg["use_computer"](action="stop") == "Stopping.", "stop is accepted")
    for _ in range(50):
        if not pc_control.RUN["busy"]: break
        time.sleep(0.2)
    check(not pc_control.RUN["busy"] and said[-1] == "proactive:Stopped.", "stops and says so")
    check(ns["_needs_tool"]("fill in this form for me in chrome") and ns["_TOOL_GROUPS"][0][1][0] == "use_computer", "routing")
    target.terminate()
    print("\n" + ("ALL PASSED" if not fails else f"{len(fails)} FAILED")); sys.exit(1 if fails else 0)

if __name__ == "__main__": main()
