"""端到端自检：像 index.js 那样用 stdin NDJSON 驱动 popup.py。

用法：python test_notify.py <out.png> [spec.json]
"""

import ctypes
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

user32 = ctypes.WinDLL("user32", use_last_error=True)
try:
    user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

from PIL import ImageGrab  # noqa: E402

spec = {
    "cmd": "show",
    "id": "e2e",
    "status": "done",
    "title": "端到端自检",
    "body": "这一条走了 stdin → 渲染 → 提示音。",
    "meta": "任务完成 · 用时 1 分 03 秒",
    "dark": True,
    "brand": "DeepSeek Harness · Gemini猫猫",
    "theme_id": "gemini-cat",
    "theme_accents": ["#5B63E8", "#8E7BF0", "#E08BD8"],
    "duration_ms": 0,
    "art_path": os.path.join(ASSETS, "themes", "gemini-cat.webp"),
    "sound_path": os.path.join(ASSETS, "sounds", "done.wav"),
    "sound": True,
    "sound_volume": 0.7,
}
if len(sys.argv) > 2:
    with open(sys.argv[2], encoding="utf-8-sig") as handle:
        spec.update(json.load(handle))

python = sys.executable
proc = subprocess.Popen(
    [python, "-u", os.path.join(HERE, "popup.py")],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    cwd=HERE, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
)
time.sleep(0.6)
proc.stdin.write((json.dumps(spec) + "\n").encode("utf-8"))
proc.stdin.flush()
time.sleep(1.6)

image = ImageGrab.grab(all_screens=True)
image.save(sys.argv[1])
print("saved", sys.argv[1], image.size, flush=True)

proc.stdin.write(b'{"cmd":"dismiss-all"}\n')
proc.stdin.flush()
time.sleep(0.4)
proc.stdin.close()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
print("stderr:", proc.stderr.read().decode("utf-8", "replace").strip(), flush=True)
