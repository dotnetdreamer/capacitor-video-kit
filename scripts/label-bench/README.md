# The browser's scene table: how it was built, and how to build it again

`MEDIAPIPE` in `src/video-composer/scenes.ts` reads the labels of the browser's image recogniser
(`src/video-composer/web/labels.ts`: MediaPipe, EfficientNet-Lite0, ImageNet's 1000 classes) into the
kit's scenes. It was built against that engine's real answers for a set of pictures whose scene is
known, and these three scripts are that loop. Change the model, and the table has to be built again.

| step | script | writes |
|---|---|---|
| 1. fetch the pictures | `python scripts/label-bench/fetch_photos.py` | `.work/photos/<scene>/*.jpg` and `index.json`: 12 Creative Commons photos per scene from [Openverse](https://openverse.org), two searches each, one per photographer |
| 2. ask the engine | `node scripts/label-bench/bench.mjs` | `.work/results.json`: the top 25 labels of every picture, from the real classifier in a visible Chromium, on the CPU as `labelMedia` runs it |
| 3. score the table | `node scripts/label-bench/eval.mjs [--misses]` | per scene: how often its pictures come out with it on top, in the top two, its mean score, and how often it is wrongly on top for another scene's pictures |

Run the last two from the kit's folder with Node 24 (they use its `playwright`, and `eval.mjs` imports
`scenes.ts` directly). `.work/` is not committed; step 1 fetches it again.

Two optional folders join the set when present: `.work/photos-lab/<scene>/*`, pictures a host already
has for a scene (LightSnip's template lab stills went in here), and `.work/photos-game/*`, frames of
screen-recorded games, counted as `game` and `screen` both.

## Where it stood when it was built (2026-09-28)

301 pictures: 194 from Openverse, 85 LightSnip template lab stills, 22 frames of Ludo Wala captures.
Of the 255 whose scene the engine can see, 67% came out with it on top and 75% in the top two. Food
92%, pets 89%, cities 81%, games 79%, homes 77%, nature and travel 73%, beaches 69%; love 25% and kids
33%, whose photographs are mostly of people, which ImageNet has no class for. `people` and `sunset`
it never says; a sunset over water comes out as a beach.
