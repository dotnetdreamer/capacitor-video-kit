# Smooth slow motion, phase 2: motion-compensated frame interpolation

A brief for a fresh session. Written 2026-09-26 at the end of the session that shipped phase 1.
Read it all before touching code: the plumbing you need already exists, and the job is ONE
swappable step in each engine, done well enough that fast motion stops looking like a double
exposure.

## 1. Where things stand

The product is LightSnap, a phone video editor. Two repos, both on `main`:

- **Video kit** `C:\Users\ik\Documents\GitHub\capacitor-video-kit`: the editor UI (Stencil) and every
  render engine: web (`src/video-composer/web`, WebGL2 painter), the live preview
  (`src/components/ve-preview`), Android (Media3 1.11.1, `android/src/main/java/net/dotnetdreamer/videokit/videocomposer`)
  and iOS (AVFoundation + Core Image, `ios/Sources/CapacitorVideoKitCore`).
- **App** `C:\Users\ik\Documents\GitHub\lighsnip` (Angular/Ionic/Capacitor). It links the kit through
  `node_modules/capacitor-video-kit` (a symlink) and loads the kit's BUILT output, so a kit change
  is invisible to the app until `npm run build` runs in the kit (about 2 minutes).

**Uncommitted work you are building on.** Phase 1 (below) is in the kit's working tree, NOT
committed: 21 files. The app has a merge from `origin/main` resolved and staged that the user is
committing themselves. Check `git status` in both before you start, and ask the user before you
commit anything.

### The problem

Templates slow clips down on the beat (0.25x to 0.6x "hits"). Phone footage is usually 30 fps, so
at 0.3x there are only about 9 real pictures per second. Before phase 1 every engine repeated
frames, and the hits stuttered visibly.

### Phase 1, done: synthesised frames by blending

Every video clip slower than 1x (base track, extra layers, and a transition's outgoing tail) is now
drawn at the output frame rate (spec `output.fps`, normally 30). Each missing frame is its two
neighbouring source frames A and B cross-faded by `w`, where `w` is how far the instant falls
between A's and B's timestamps. Clips at 1x or faster and pictures take the old path unchanged.
Nothing on the wire asks for it: `speed < 1` is the whole signal. The contract is written up on
`ComposeOutput.fps` in `src/video-composer/definitions.ts`.

Measured on the Samsung A13, slowed segments went from 6-19 distinct fps to 29-30 fps. Every 1x
frame timestamp was identical to before, and render time rose about 8-9%. A cut INTO a slowed
clip now lands on its planned instant; before, it was up to 100 ms late.

**What is still wrong, and why phase 2 exists.** Blending draws a moving edge as two faint edges
(the old position fading out, the new one fading in) instead of one edge in between. On fast
motion, a skater or a ball or a whip-pan, that reads as a ghostly double exposure. CapCut's
"Smooth slow-mo" and every pro editor's "optical flow" mode instead estimate how each pixel moved
from A to B and draw it part of the way along that path. That is phase 2.

## 2. Exactly where phase 2 plugs in

Phase 1 was built so that only the per-pixel "make the in-between picture" step changes. Everything
else stays as it is: choosing A, B and `w`, decoding and holding the frames, timestamps, cadence,
Media3 backpressure, the preview's frame capture, placement, colour, camera and transitions.

### Web (export and preview share one painter)

- `src/video-composer/web/frame-interpolation.ts` is the whole of the step:
  - `INTERPOLATE_FRAMES_GLSL` defines `vec3 interpolateFrames(sampler2D frameA, sampler2D frameB, vec2 uv, float w)`.
    The painter's layer shader calls it in place of its one texture read (`painter.ts` around line
    245, `u_tween > 0.0 ? interpolateFrames(...) : texture(...)`).
  - `interpolateFrames2d(ctx, frameA, frameB, w, width, height)` is the 2D-canvas fallback.
- `painter.ts` `drawLayerGl`, the tween branch around lines 550-585, uploads frame B to texture unit 1
  and sets `u_tween`. Compute the flow for a PAIR here, once, when a new B is uploaded, and pass it
  to the shader as extra texture(s). Pairs are stable across the several output frames that share
  them, in both the export and the preview.
- Frames arrive as source pictures: at source resolution, upright, before the colour matrix, crop,
  fit or camera. That is what a flow estimate wants.
- Plumbing, for reference only (do not change the timing):
  - `slow-motion.ts` picks A, B and `w` from real container frame times.
  - `media.ts` (`SourceReader.tweenAt`, `readFrameTimes`) seeks and holds the pair as ImageBitmaps.
  - `src/components/ve-preview/presented-frames.ts` builds pairs during playback from
    `requestVideoFrameCallback`, one source frame behind.

### Android

- `SlowMotionEffect.kt` (the effect sits after the speed retiming and the grade, and before the
  geometry, camera and transition side):
  - `interface FrameInterpolator` (line ~121) has four methods:
    - `configure(width, height)`: the frame size.
    - `prepare(fromTexId, toTexId)`: called ONCE per new pair. This is where the flow goes.
    - `draw(fromTexId, toTexId, weight)`: called per output frame.
    - `release()`.
  - `BlendInterpolator` (line ~144) is phase 1's answer.
  - `SlowMotionEffect(..., interpolator: () -> FrameInterpolator = { BlendInterpolator() })`
    (line ~61) is where you swap in yours.
- `SlowMotion.kt` holds `SlowMotionCadence` (instants and weights) and `SlowMotionPump` (the
  Media3 protocol with GL cut out). Both are JVM-tested; leave them alone.
- **GL version matters.** The phase 1 shaders are GLSL ES **1.00** (`#version 100`), because Media3
  runs SDR effects in a GLES 2-level context. Before designing the flow passes, find out:
  - whether that context is really GLES 2 or 3 on the A13 (Mali-G52);
  - whether you can render to half-float textures (`EXT_color_buffer_half_float`), or must pack
    flow into RGBA8;
  - whether Media3 1.11.1 lets you ask for a GLES 3 context (a `GlObjectsProvider` on the
    `DefaultVideoFrameProcessor.Factory`?).

  Use the ctx7 CLI for Media3 docs, as the user's global rules require, and read the Media3
  sources in the Gradle cache. This decides the texture formats for BOTH engines if you want one
  algorithm.

### iOS: out of scope, but know it

iOS has neither phase 1 nor phase 2: it still repeats frames. The custom compositor
(`EditCompositor.swift`) is only handed the frame at the requested time, so getting the NEXT
source frame is the first problem there. Two candidates: a second track offset by one source
frame, or an `AVAssetReader`. Swift cannot be compiled on this Windows machine. Leave iOS for a
later phase, and do not change iOS files; mention in your report anything iOS will need.

## 3. The algorithm to build

Keep it fragment-shader only. WebGL2 has no compute shaders, Android's context may be GLES 2-level,
and the same algorithm has to run in both engines (the transitions precedent: one design, written
per engine, proven equal by tests). A proven, shader-friendly recipe:

1. **Luma pyramids** of A and B at reduced size. The flow does not need full resolution: estimate
   at about 1/4 of the frame (180x320 for a 720x1280 source), with 3-4 pyramid levels.
2. **Bidirectional flow**, A→B and B→A, coarse to fine. A good fit for fragment passes is
   pyramidal Lucas-Kanade / Horn-Schunck-style iterations, or Dense Inverse Search (Kroeger et al.
   2016: patch inverse search, densification, a few variational smoothing passes). A few
   iterations per level. Your choice, justified by measurements (section 5).
3. **Occlusion / confidence** from forward-backward consistency: where `F_AB(x) + F_BA(x + F_AB(x))`
   is far from zero, the pixel is occluded or the estimate is wrong.
4. **Synthesis at weight `t`** (Super SloMo, Jiang et al. 2018, linear-motion approximation):
   - `F_t0 = -(1-t)·t·F_01 + t²·F_10`
   - `F_t1 = (1-t)²·F_01 - t·(1-t)·F_10`
   - `I_t = ((1-t)·V0·A(x + F_t0) + t·V1·B(x + F_t1)) / ((1-t)·V0 + t·V1)`

   Here V0 and V1 are visibility weights from step 3. Flow is estimated at low resolution,
   upsampled bilinearly, and the colour is sampled at FULL resolution.
5. **Fall back to the blend** where the flow cannot be trusted: per pixel when confidence is low,
   and for the whole pair when the frames differ too much. A scene cut inside a clip, a flash, a
   whip-pan or motion beyond the search range would otherwise tear. A tearing artefact is far worse
   than a ghost, so be conservative.

Everything that is a property of the PAIR (pyramids, flows, visibility) is computed once, in
`prepare()` on Android and when B is first uploaded on the web. The per-output-frame work is only
step 4. Budget GPU memory: a handful of small textures per slowed item, released with it.

## 4. Constraints you must respect

- **Nothing outside slowed clips changes.** A clip at 1x or faster and every picture must render
  byte-for-byte as today. The existing painter and render comparison tests prove this; keep them green.
- **Timestamps do not move.** Phase 2 changes pixels only, never which frames exist or when.
- **The preview is a guide.** It must stay real-time on the A13 in the WebView. If flow is too
  heavy there, the preview may keep the blend or use a cheaper flow setting. Measure it, decide,
  and say so in `frame-interpolation.ts`. Exports must use the full method.
- **Low-end phone first.** The A13 is the target device. Keep export time within about +60% of
  phase 1 on Velocity (phase 1: about 22.4 s on the A13). Report the real numbers.
- **One algorithm, two engines.** The same passes, constants and fallbacks on the web and Android,
  with a parity check (section 5).
- **House style.** Long "why" comments like the surrounding files, and doc comments that state the
  contract.

## 5. How to prove it

### Ground truth, objectively

The static colour bars in `qa-sample.mp4` are useless for this. Make a benchmark where the right
answer is known:

- Generate a 60 fps (or 120 fps) clip with real motion, using ffmpeg:
  - a textured image panned and zoomed with `zoompan`/`crop` expressions;
  - moving shapes over a detailed background, with an occlusion (one object passing in front of
    another);
  - one fast whip.
- Decimate it to 30 fps: that is the source.
- Slow the 30 fps source to 0.5x (and 0.25x). The perfect in-between frames are the dropped
  60 fps (or 120 fps) frames.
- Score blend and flow against them with PSNR and SSIM (ffmpeg's `psnr` and `ssim` filters) on the
  in-between frames only.
- Flow must clearly beat blend on the moving scenes, and must NOT be worse than blend on a
  static scene, a scene cut, or a flash.
- Keep the generator script and the scores table in the report.

### Tests

- **Pure maths** in TypeScript and Kotlin: the Super SloMo flow composition, visibility weighting,
  the fallback thresholds, and pyramid sizes.
- **Painter comparison tests** in the style of `painter-slow-motion.cmp.test.ts`: a textured
  square translated by `d` between A and B. At `w = 0.5` the result must match the square at
  `d/2` within a tolerance, and must NOT show two half-strength squares, which is what blend draws.
  Run them on both the GPU and 2D paths (the 2D path may keep the blend; document it).
- **Android JVM tests** for any new pure code: `./gradlew :capacitor-video-kit:testDebugUnitTest`,
  run from `lighsnip/android` with Android Studio's JBR. 7 failures in `StagedRenderInputsTest` are
  pre-existing Windows path issues.
- **Kit:** `npm test` and `npm run typecheck`. `ve-toast`, `ve-text-sheet` and `ve-progress`
  component tests are flaky under full load; re-run them alone if they are the only failures.

### On the phone

Export Velocity (0.3x hits around 7.65-8.1 s) and The Drop (0.5x at 7.85-9.5 s). Also export a post
built from your 60-fps-derived benchmark clip.

- **Look:** consecutive-frame strips of the slow hits, compared with phase 1. You should see no
  double exposure on moving subjects, no tearing at edges or occlusions, and a static background
  that stays static.
- **Measure:** PSNR against ground truth where you have it, render time, and that the frame
  timestamps are identical to phase 1 (`ffprobe -show_frames`).
- **Parity:** compare the same spec rendered by the web export and by Android. The two should
  agree within a small PSNR tolerance, which you set and justify.
- **Evidence:** the phase-1 device evidence and numbers are in the session scratchpad (they may be
  gone). Re-measure a phase-1 baseline from the current code before you change it.

## 6. Environment rules (hard-won; follow exactly)

- **Phone:** use the Samsung A13 ONLY, adb serial `R58T51N3G2X`, and pass `-s R58T51N3G2X` to
  every adb command. A Galaxy S25 is often attached as well: never touch it.
  - In Git Bash, prefix device-path commands with `MSYS_NO_PATHCONV=1`.
  - Take screenshots with `adb -s R58T51N3G2X exec-out screencap -p > f.png`.
  - Seeds on the phone: `/sdcard/Movies/qa-sample.mp4` (60 s, static bars, with audio),
    `qa-tr-a/b/c`, and `qa-photo.jpg`.
  - Delete any render you save from `/sdcard/Movies/LightSnip` after pulling it, and leave the
    phone as you found it.
- **Node:** the system node is too old. Run
  `export PATH="/c/Users/ik/AppData/Roaming/fnm/node-versions/v24.15.0/installation:$PATH"`.
  The Angular CLI is `node node_modules/@angular/cli/bin/ng.js ...`, not `npx ng`.
- **App build for the phone:**
  1. `npm run build:web` (it bundles the template catalogue);
  2. `npx cap sync android`;
  3. Gradle `assembleDebug` in `lighsnip/android`, with the JDK at `/c/Program Files/Android/Android Studio/jbr`;
  4. `adb -s R58T51N3G2X install -r`.
- **Worktrees:** never use git worktrees. One with a `node_modules` junction once deleted the main
  `node_modules`.
- **Commits:** do not commit or push unless the user asks. The ECC pre-commit hook blocks commits
  in `lighsnip` because its lint step calls ESLint's removed `compact` formatter; the user commits
  there themselves.
- **Fact-Forcing Gate:** a hook asks you to state facts before your first Bash command and before
  the first edit of each file. Answer it plainly (callers, API, schema, the user's instruction) and
  retry.
- **Library docs:** the user's global rule is to use the ctx7 CLI for any library or API question
  (Media3, WebGL, and so on), not memory.

## 7. What to hand back

A report with:

- **Design:** the algorithm chosen and why, texture formats per engine, and where each pass runs.
- **Files changed.**
- **Evidence:**
  - the benchmark table (PSNR/SSIM for blend vs flow per scene and speed);
  - device render times against phase 1;
  - preview cost and the decision you made for it;
  - frame-strip paths;
  - web/Android parity numbers.
- **What is unverified.**
- **What iOS will need.**

Do not commit.
