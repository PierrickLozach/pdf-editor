#!/usr/bin/env python3
"""Turns the frames of tests/pw/demo-gif.mjs into an optimised GIF (and a still poster).
Usage: python3 tools/make_gif.py [frames dir] [out.gif] [width] [fps]"""
import json, pathlib, sys
from PIL import Image, ImageChops

src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/demo-frames")
out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "demo.gif").expanduser()
width = int(sys.argv[3]) if len(sys.argv) > 3 else 960
fps = int(sys.argv[4]) if len(sys.argv) > 4 else 12

times = json.loads((src / "times.json").read_text())
files = sorted(src.glob("*.jpg"))
t0, t1 = times[0], times[-1]
step = 1.0 / fps

def load(i):
    im = Image.open(files[i]).convert("RGB")
    h = round(im.height * width / im.width)
    return im.resize((width, h), Image.LANCZOS)

# one frame per tick: the latest captured frame at that moment
ticks, j, t = [], 0, t0
while t <= t1 + 1e-6:
    while j + 1 < len(times) and times[j + 1] <= t: j += 1
    ticks.append(j); t += step

# one palette for the whole GIF (stable colours, smaller file): built from a strip of sample frames
samples = [load(ticks[k]) for k in range(0, len(ticks), max(1, len(ticks) // 12))]
strip = Image.new("RGB", (width, sum(s.height for s in samples)))
y = 0
for s in samples: strip.paste(s, (0, y)); y += s.height
pal = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT)

frames, durations, cache = [], [], {}
ms = round(1000 / fps)
for i in ticks:
    if i not in cache: cache[i] = load(i).quantize(palette=pal, dither=Image.Dither.NONE)
    q = cache[i]
    if frames and ImageChops.difference(frames[-1].convert("RGB"), q.convert("RGB")).getbbox() is None:
        durations[-1] += ms                                   # the same picture: hold it longer
    else:
        frames.append(q); durations.append(ms)
durations[-1] += 1200                                          # a pause on the last picture before looping

frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True, disposal=1)
load(ticks[int(len(ticks) * 0.72)]).save(out.with_suffix(".png"))   # a still for places that do not take GIFs
print(f"{out}: {len(frames)} frames, {sum(durations) / 1000:.1f} s, {out.stat().st_size / 1e6:.2f} MB")
