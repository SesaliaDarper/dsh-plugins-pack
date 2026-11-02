"""生成 dsh-task-notify 的提示音（16-bit PCM WAV，单声道 44.1 kHz）。

一次性脚本：产出 assets/sounds/{done,failed,cancelled}.wav。
声音刻意做得短、轻、不刺耳 —— 通知音是「完成了」的暗示，不是闹钟：

  done      C6 → E6 两个上行音符，带泛音和快速衰减
  failed    A3 → F3 两个下行音符，加一点点三角波质地
  cancelled 单个 G4 中音，短促一声

运行：
    python scripts/make_sounds.py
"""

from __future__ import annotations

import math
import os
import struct
import wave

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets", "sounds")


def _note(freq: float, seconds: float, amp: float, harmonics=((1.0, 1.0), (2.0, 0.32), (3.0, 0.12))):
    """一个带包络的音符，返回 float 样本列表。"""
    count = int(SR * seconds)
    out = [0.0] * count
    for index in range(count):
        t = index / SR
        # 3 ms 起音 + 指数衰减，尾巴收干净，避免爆音
        attack = min(1.0, t / 0.003)
        release = math.exp(-4.2 * t / seconds) * min(1.0, (seconds - t) / 0.02)
        envelope = attack * release
        value = 0.0
        for multiple, weight in harmonics:
            value += math.sin(2.0 * math.pi * freq * multiple * t) * weight
        out[index] = amp * envelope * value / sum(w for _, w in harmonics)
    return out


def _silence(seconds: float):
    return [0.0] * int(SR * seconds)


def _mix(*tracks):
    length = max(len(track) for track in tracks)
    out = [0.0] * length
    for track in tracks:
        for index, value in enumerate(track):
            out[index] += value
    return out


def _concat(*tracks):
    out = []
    for track in tracks:
        out.extend(track)
    return out


def _write(name: str, samples, peak: float = 0.42) -> str:
    os.makedirs(OUT_DIR, exist_ok=True)
    high = max((abs(value) for value in samples), default=0.0) or 1.0
    gain = peak / high
    # 2 ms 淡出，杜绝 WAV 结尾的「啪」声
    fade = max(1, int(SR * 0.002))
    frames = bytearray()
    total = len(samples)
    for index, value in enumerate(samples):
        shaped = value * gain
        if total - index < fade:
            shaped *= (total - index) / fade
        frames += struct.pack("<h", int(max(-1.0, min(1.0, shaped)) * 32767))
    path = os.path.join(OUT_DIR, name)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(bytes(frames))
    return path


def build_done() -> str:
    first = _note(1046.50, 0.20, 0.55)          # C6
    second = _note(1318.51, 0.34, 0.50)         # E6
    tail = _note(1567.98, 0.55, 0.26)           # G6，很轻的和声尾巴
    body = _mix(_concat(first, _silence(0.035), second), _concat(_silence(0.24), tail))
    return _write("done.wav", body)


def build_failed() -> str:
    first = _note(220.00, 0.22, 0.60, ((1.0, 1.0), (2.0, 0.45), (3.0, 0.22)))
    second = _note(174.61, 0.42, 0.58, ((1.0, 1.0), (2.0, 0.45), (3.0, 0.22)))
    return _write("failed.wav", _concat(first, _silence(0.03), second))


def build_cancelled() -> str:
    body = _note(392.00, 0.26, 0.55, ((1.0, 1.0), (2.0, 0.28)))
    return _write("cancelled.wav", body, peak=0.34)


def main() -> int:
    for label, builder in (
        ("done.wav", build_done),
        ("failed.wav", build_failed),
        ("cancelled.wav", build_cancelled),
    ):
        path = builder()
        print(f"{label}: {os.path.getsize(path)} bytes -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
