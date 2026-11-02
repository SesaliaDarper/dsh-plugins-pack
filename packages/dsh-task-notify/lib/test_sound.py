"""验证提示音三种路径：默认音色 / 显式 sound_path+音量 / settings.json 关闭。"""

import json
import os
import subprocess
import sys
import time

LIB = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(LIB)
PY = sys.executable


def run(spec, label, settings=None):
    settings_file = os.path.join(ROOT, "state", "settings.json")
    backup = None
    if os.path.isfile(settings_file):
        backup = settings_file + ".test_bak"
        os.replace(settings_file, backup)
    try:
        if settings is not None:
            os.makedirs(os.path.dirname(settings_file), exist_ok=True)
            with open(settings_file, "w", encoding="utf-8") as handle:
                json.dump(settings, handle)
        proc = subprocess.Popen(
            [PY, "-u", os.path.join(LIB, "popup.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}, cwd=LIB,
        )
        time.sleep(0.5)
        proc.stdin.write((json.dumps(spec) + "\n").encode("utf-8"))
        proc.stdin.flush()
        time.sleep(0.9)
        proc.stdin.write(b'{"cmd":"dismiss-all"}\n')
        proc.stdin.flush()
        time.sleep(0.3)
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        err = proc.stderr.read().decode("utf-8", "replace").strip()
        print(f"--- {label} ---\n{err or '(no stderr)'}", flush=True)
    finally:
        if settings is not None and os.path.isfile(settings_file):
            os.remove(settings_file)
        if backup:
            os.replace(backup, settings_file)


base = {
    "cmd": "show", "id": "s1", "status": "done", "title": "提示音自检",
    "body": "默认音色兜底。", "meta": "done", "dark": True, "duration_ms": 0,
    "art_path": os.path.join(ROOT, "assets", "themes", "gemini-cat.webp"),
}

run(dict(base, id="s1"), "默认音色（Host 不传 sound_path）")
run(dict(base, id="s2", status="failed",
         sound_path=os.path.join(ROOT, "assets", "sounds", "failed.wav"),
         sound_volume=0.5), "显式 sound_path + 0.5 音量")
run(dict(base, id="s3"), "settings.json 关闭", settings={"sound": False})
run(dict(base, id="s4"), "settings.json 音量 0.3", settings={"volume": 0.3})
