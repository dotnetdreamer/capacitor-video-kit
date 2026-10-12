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

## Finding subjects in a browser

`selfie_segmenter.tflite` is the model `findSubjects` runs in a browser (`src/video-composer/web/subjects.ts`):
MediaPipe's selfie segmenter, float16, which answers how likely each pixel is to be a person. It is served from
the same folder as the classifier and runs on the same MediaPipe JavaScript and WebAssembly, so a host that
serves this folder serves both.

- Source: `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite`
- Size: 249,537 bytes, SHA-256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`
- Licence: Apache License 2.0, as published by Google with MediaPipe
