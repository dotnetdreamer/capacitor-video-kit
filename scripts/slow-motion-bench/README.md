# Smooth slow motion: the ground-truth benchmark

How the optical flow in `src/video-composer/web/optical-flow.ts` (and its Android twin,
`OpticalFlow.kt`) was chosen and tuned: clips whose missing frames are KNOWN, and every candidate
scored against them.

## What it is

`generate.sh` draws six scenes at 120 fps and keeps every fourth frame as the 30 fps "recording". An
engine slowing that recording to 0.5x has to invent the frame halfway between each pair, which is the
120 fps frame two along; at 0.25x it invents the three between. Those frames exist, so an invented
frame can be scored against the real one (PSNR and SSIM, in-between frames only).

| scene   | what it tests |
|---------|---------------|
| panzoom | a detailed picture panned and zoomed at once: motion everywhere, none of it a plain shift |
| objects | a spinning disc crossing in front of a card moving the other way: occlusion, rotation |
| whip    | a pan easing up to 120 px per recorded frame (at 720p) and back: inside the search range at the ends, far beyond it in the middle |
| static  | nothing moves, fresh sensor noise on every frame: the flow must find nothing |
| cut     | a hard cut between two recorded frames: no motion explains it |
| flash   | a slow pan through a burst of light: brightness changes, the picture does not move |

The flow has to clearly beat the cross-fade on the first three and must not be worse on the last three.

## Running it

From the kit. On Windows, with the fnm node on the path
(`/c/Users/ik/AppData/Roaming/fnm/node-versions/v24.15.0/installation`); on a Mac, the system node
(24.15 or later). Either way an `ffmpeg` and `ffprobe` on the path, with drawtext, mandelbrot and psnr.

```sh
# 1. The scenes (a minute; 360 640 for a quick run at half the pixels).
bash scripts/slow-motion-bench/generate.sh "$BENCH" 720 1280

# 2. Every missing frame, drawn by the real painter on the machine's real GPU, blend and flow.
VITE_BENCH_DIR="$BENCH" VITE_BENCH_OUT="$BENCH/out" \
  npx vitest run --config scripts/slow-motion-bench/vitest.bench.config.ts scripts/slow-motion-bench/interpolate.harness.ts

# 3. The table.
bash scripts/slow-motion-bench/score.sh "$BENCH" "$BENCH/out"

# The whole post exported by the web engine, for the parity checks (web-bench05.mp4, web-bench025.mp4);
# graded with VITE_BENCH_FILTER='[{"op":"contrast","amount":1.5}]' VITE_BENCH_TAG=-c15 in front:
VITE_BENCH_DIR="$BENCH" VITE_BENCH_OUT="$BENCH/web" \
  npx vitest run --config scripts/slow-motion-bench/vitest.bench.config.ts scripts/slow-motion-bench/web-export.harness.ts

# An export of the post scored in luma, every frame, invented and recorded apart: against the truth,
# or against another engine's export of the same post at the same speed.
bash scripts/slow-motion-bench/score-export.sh truth "$BENCH" "$BENCH/web/web-bench05.mp4" 0.5
bash scripts/slow-motion-bench/score-export.sh pair phone-bench05.mp4 "$BENCH/web/web-bench05.mp4" 0.5
```

`BENCH` is a Windows-style path (`C:/...`) on Windows and an ordinary absolute path on a Mac. The
harness can read and write only under it, the kit and `VITE_BENCH_OUT`. The runner picks ANGLE's
backend by platform - Direct3D 11 on Windows, Metal on a Mac, where asking for Direct3D quietly lands
on SwiftShader - and `BENCH_ANGLE` overrides it; `harness.txt` and each export's `.txt` name the
renderer a run really got, and the interpolate harness refuses SwiftShader. `generate.sh` also writes
`bench-30fps.mp4`, the six recordings end to end, for a post on a phone. Its `-colorspace bt709` is
only a label: an ffmpeg whose scaler does not follow it (6.0, on the Mac) stores BT.601 pixels under
it, so `score-export.sh` reads the matrix off the recording itself before it turns the truth into luma.

## The numbers (2026-09-26)

### The web engine, 720x1280, against the truth

The real painter on an Intel UHD GPU (ANGLE, Direct3D 11). PSNR over the in-between frames from their
mean squared error, the worst single frame, and SSIM.

| scene   | speed | blend PSNR | flow PSNR | blend worst | flow worst | blend SSIM | flow SSIM |
|---------|-------|-----------:|----------:|------------:|-----------:|-----------:|----------:|
| panzoom | 0.5x  | 17.29 | **29.53** | 16.52 | 28.18 | 0.343 | 0.961 |
| panzoom | 0.25x | 17.58 | **30.00** | 16.52 | 28.18 | 0.384 | 0.965 |
| objects | 0.5x  | 30.02 | **34.63** | 28.40 | 32.33 | 0.948 | 0.982 |
| objects | 0.25x | 30.63 | **35.04** | 28.40 | 32.33 | 0.952 | 0.982 |
| whip    | 0.5x  | 16.43 | **17.49** | 14.13 | 14.13 | 0.486 | 0.602 |
| whip    | 0.25x | 16.39 | **17.55** | 14.06 | 14.06 | 0.500 | 0.623 |
| static  | 0.5x  | 43.50 | 43.50 | 43.49 | 43.49 | 0.988 | 0.988 |
| static  | 0.25x | 43.28 | 43.28 | 43.17 | 43.17 | 0.987 | 0.987 |
| cut     | 0.5x  | 21.38 | 31.41 | 17.65 | 17.65 | 0.621 | 0.973 |
| cut     | 0.25x | 21.97 | 33.02 | 17.65 | 17.65 | 0.680 | 0.979 |
| flash   | 0.5x  | 17.88 | 31.01 | 17.33 | 19.85 | 0.575 | 0.970 |
| flash   | 0.25x | 17.92 | 31.34 | 17.33 | 19.22 | 0.607 | 0.973 |

Reading it: the whip's worst frames and the cut's are the cross-fade's exactly - those pairs are the
ones the flow cannot explain, and the trust test hands them back to the blend rather than tear them.
The cut and flash averages rise because their other pairs are slow pans the flow does get right; the
frames that matter for "not worse" are the worst ones, which are equal (cut) or better (flash). Static
is the cross-fade to the fifth decimal: where nothing moves, the flow draws the cross-fade.

### The web engine, 1080x1920

The same scenes at 1080x1920 (0.5x, flow against blend): panzoom 32.87 against 18.30, objects 35.76
against 30.56, whip 19.34 against 18.08, static 46.709 against 46.709, cut 32.03 against 22.98 with
the worst frame equal (18.06), flash 36.70 against 21.07 with the worst frame better (26.38 against
20.61).

The luma pass reads `lumaTaps` 2x2-texel reads per axis - 2 at 720p, 3 at 1080p - which is an exact box
filter over each working texel's footprint. A fixed two, which the 720p table was tuned with, point-
samples four pixels of every 6x6 at 1080p; on these scenes the two measure within 0.25 dB of each other
(panzoom +0.20 for the box, flash -0.24), but these scenes are drawn at 720p detail and scaled up, so
they cannot show the aliasing a real 1080p picture's finest texture would suffer. The box is kept
because it is the right filter, not because this bench could tell them apart.

### What each choice was worth (360x640, 0.5x PSNR, flow)

| step | panzoom | objects | whip | static | flash |
|------|--------:|--------:|-----:|-------:|------:|
| first cut: 4 levels, Super SloMo's linear approximation | 26.14 | 34.25 | 20.13 | 48.30 | 33.32 |
| points found by following the flow instead | 27.49 | 34.80 | 20.27 | 48.27 | 33.76 |
| cross-fade where nothing moves | 27.49 | 34.81 | 20.27 | **48.47** | 33.76 |
| stronger regularisation, 5 levels, tuned weights | 27.65 | 34.83 | 20.47 | 48.48 | 33.83 |
| 2x2 luma taps, 1 tracking step (cheaper, no loss) | 27.64 | 34.81 | 20.46 | 48.48 | 34.01 |
| "still or moved?" candidate in every iteration | 27.98 | 35.19 | 20.32 | 48.48 | 37.34 |
| occlusion fill | **28.89** | **35.63** | 20.31 | 48.48 | **38.87** |
| (blend, for reference) | 18.72 | 30.61 | 18.73 | 48.48 | 22.81 |

Tried and dropped: a 7x7 window (+0.1 to +1 dB, twice the cost), a sparse 5x5 window (-0.3 dB), fewer
iterations (-0.2 dB), no median (-0.9 dB, and static fell below the blend).

### The Android engine on the Samsung A13, against the truth

`bench-30fps.mp4` slowed to 0.5x and exported by Media3 at 720x1280, 20 Mb/s. Scored in LUMA (the
codec's 4:2:0 chroma cannot carry the scenes' saturated colour noise, so RGB would measure the codec).
"Recorded" is the same measure on the frames that were not invented: the ceiling the codec leaves.

| scene   | phase 1 (blend) | phase 2 (flow) | recorded frames |
|---------|----------------:|---------------:|----------------:|
| panzoom | 14.56 | **26.70** | 31.7 |
| objects | 27.18 | **31.31** | 37.5 |
| whip    | 13.86 | **14.90** | 26.7 |
| static  | 30.35 | 30.69 | 30.8 |
| cut     | 17.43 (worst 15.52) | 28.53 (worst 15.60) | 39.3 |
| flash   | 16.31 (worst 15.76) | 27.01 (worst 17.97) | 30.8 |

Frame timestamps are byte-identical to phase 1's for this post, Velocity and The Drop.

### Web against Android, the same post

Luma PSNR between the two engines' frames. The recorded frames share no interpolation code, so how far
they differ is how far two decoders and two encoders differ on their own; the invented frames agree
within 0.8 dB of that everywhere - the tolerance the two engines are held to is 1 dB.

| scene   | invented frames | recorded frames |
|---------|----------------:|----------------:|
| panzoom | 32.39 | 33.11 |
| objects | 36.49 | 36.92 |
| whip    | 26.96 | 27.76 |
| static  | 36.71 | 36.64 |
| cut     | 39.24 | 39.35 |
| flash   | 35.21 | 35.33 |

A GRADED post (contrast 1.5) is where the engines differ before any frame is invented: Android grades
and clamps each recorded frame and then mixes, the web mixes and then grades and clamps, and the two
orders part wherever the grade clips. The flow itself sees the same picture on both - the luma pass is
handed the post's colour matrix on the web and none on Android, whose frames arrive graded - and the
gap the clamp leaves is the same size as phase 1's cross-fade had:

| scene   | flow: invented / recorded | phase 1 blend: invented / recorded |
|---------|--------------------------:|-----------------------------------:|
| panzoom | 28.99 / 30.37 | 22.90 / 23.58 |
| objects | 32.26 / 33.25 | 29.89 / 29.88 |
| whip    | 23.67 / 25.71 | 21.45 / 22.61 |
| static  | 32.58 / 32.52 | 31.57 / 31.34 |
| cut     | 34.90 / 36.14 | 25.52 / 27.27 |
| flash   | 29.57 / 30.91 | 23.43 / 25.19 |

So the tolerance for a graded post is 2.5 dB below the recorded frames' agreement, against 1 dB for an
ungraded one.
