"""把 22 个音效按教程编排铺到 40 秒时间轴上，再混进成片。

编排（复刻教程「音效编排」）：
- 警告页：warn_beep(67ms) + 6 声 key(800–1800ms)
- 绘制段：每笔起笔前 8 帧 key(0.22) + 起笔时 pen(0.55)，25 笔 × 360ms
- 12000ms：硬切 flip；13067ms：反色 power_on
- 蒙太奇 A：80 声 flip（每 100ms，0.5）
- 蒙太奇 B：104 声 flip（每 100ms）
- 乱码段：30 声 flip（0.4，从 34000ms 起）

跑法：python mix_nexus_audio.py
"""
import os
import wave

import numpy as np

BASE = r"D:\20533\deskbox\fangwork\Reelix\reference\nexusos\复刻包\音效"
OUT_DIR = r"D:\20533\deskbox\fangwork\Reelix\out"
TOTAL_MS = 40000
RATE = 44100


def load(name: str) -> np.ndarray:
    with wave.open(os.path.join(BASE, name), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == RATE
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def main():
    buf = np.zeros(int(RATE * TOTAL_MS / 1000), dtype=np.float32)

    flips = [load(f"flip_{i}.wav") for i in range(8)]
    pens = [load(f"pen_{i}.wav") for i in range(6)]
    keys = [load(f"key_{i}.wav") for i in range(6)]
    beep = load("warn_beep.wav")
    power = load("power_on.wav")

    def place(clip: np.ndarray, at_ms: float, gain: float):
        start = int(RATE * at_ms / 1000)
        if start >= len(buf):
            return
        n = min(len(clip), len(buf) - start)
        buf[start:start + n] += clip[:n] * gain

    # 警告页
    place(beep, 67, 0.9)
    for i in range(6):
        place(keys[i % 6], 800 + i * 200, 0.45)

    # 绘制段：25 笔，每笔 360ms
    for i in range(25):
        t = 3000 + i * 360
        place(keys[i % 6], max(0, t - 267), 0.22)
        place(pens[i % 6], t, 0.55)

    # 硬切 + 反色
    place(flips[0], 12000, 0.5)
    place(power, 13067, 0.8)

    # 蒙太奇 A：80 声
    for i in range(80):
        place(flips[i % 8], 13333 + i * 100, 0.5)

    # 蒙太奇 B：104 声
    for i in range(104):
        place(flips[(i + 3) % 8], 21333 + i * 100, 0.5)

    # 乱码段：30 声
    for i in range(30):
        place(flips[(i + 5) % 8], 34000 + i * 100, 0.4)

    peak = float(np.max(np.abs(buf))) or 1.0
    if peak > 0.98:
        buf *= 0.98 / peak

    pcm = (np.clip(buf, -1.0, 1.0) * 32767).astype("<i2")
    stereo = np.repeat(pcm, 2)  # 单声道 → 双声道
    out = os.path.join(OUT_DIR, "nexus_audio.wav")
    with wave.open(out, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(stereo.tobytes())
    print("音轨已生成:", out, f"{len(buf)/RATE:.2f}s，峰值 {peak:.2f}")


if __name__ == "__main__":
    main()
