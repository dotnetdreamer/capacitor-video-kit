# Image labeling in a browser

`efficientnet_lite0.tflite` is the model `labelMedia` runs in a browser (`src/video-composer/web/labels.ts`):
MediaPipe's EfficientNet-Lite0 image classifier, int8, trained on ImageNet's 1000 classes, with the class
names embedded in its metadata.

- Source: `https://storage.googleapis.com/mediapipe-models/image_classifier/efficientnet_lite0/int8/1/efficientnet_lite0.tflite`
- Size: 5,434,517 bytes, SHA-256 `bc2ffe19c1118de0c0c2a9088992da5589722656e0fba81421385300a4a34b16`
- Licence: Apache License 2.0, as published by Google with MediaPipe

A host serves it beside its page together with MediaPipe's JavaScript and WebAssembly (`vision_bundle.mjs`
and `wasm/` from `@mediapipe/tasks-vision`), in what it DEPLOYS and not in any build's output, so a
phone app made from the same build never carries it; `docs/media.md` says how. The scene table that reads its labels is
`MEDIAPIPE` in `src/video-composer/scenes.ts`, and replacing the model means building that table again.
