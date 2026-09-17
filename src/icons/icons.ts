/**
 * Every ionicon the editor draws, as the markup that goes inside one `<svg viewBox="0 0 512 512">`.
 *
 * Inlined rather than depended on. `ion-icon` is not part of @ionic/core at all - it is the
 * separate `ionicons` package, and the custom element on its own is 8,831 bytes gzipped before it
 * has fetched a single icon, against 7,053 for this whole file. Inlining also deletes the runtime
 * fetch and the `setAssetPath` that goes with it, which is one less thing a React or Vue host has
 * to get right before an icon appears.
 *
 * The shapes are Ionicons 8.0.13, MIT licensed, taken from `ionicons/dist/svg` unchanged apart
 * from the wrapper `<svg>` element and its `class` attribute. They stroke and fill with
 * `currentColor`, so an icon takes the colour of whatever it sits in.
 *
 * Adding one means copying its file's inner markup in here. There is deliberately no fallback for
 * a name that is not in the map: a missing icon is a typo, and drawing nothing at all is how it
 * gets noticed.
 */
export type EditorIconName =
  | 'add'
  | 'arrow-down-circle-outline'
  | 'arrow-down-outline'
  | 'arrow-forward'
  | 'arrow-redo-outline'
  | 'arrow-undo-outline'
  | 'arrow-up-circle-outline'
  | 'arrow-up-outline'
  | 'ban-outline'
  | 'bookmark-outline'
  | 'chatbox-ellipses-outline'
  | 'checkmark'
  | 'chevron-back'
  | 'chevron-down'
  | 'close'
  | 'cloudy-outline'
  | 'color-fill-outline'
  | 'color-filter-outline'
  | 'color-palette-outline'
  | 'color-wand-outline'
  | 'contract-outline'
  | 'contrast-outline'
  | 'copy-outline'
  | 'create-outline'
  | 'crop-outline'
  | 'cut-outline'
  | 'duplicate-outline'
  | 'expand-outline'
  | 'grid-outline'
  | 'happy-outline'
  | 'link-outline'
  | 'mic'
  | 'mic-outline'
  | 'musical-note'
  | 'musical-note-outline'
  | 'musical-notes-outline'
  | 'options-outline'
  | 'pause'
  | 'pencil'
  | 'play'
  | 'play-skip-back-outline'
  | 'play-skip-forward-outline'
  | 'repeat-outline'
  | 'resize-outline'
  | 'scan-outline'
  | 'search-outline'
  | 'sparkles'
  | 'sparkles-outline'
  | 'speedometer-outline'
  | 'sunny-outline'
  | 'swap-horizontal-outline'
  | 'swap-vertical-outline'
  | 'text-outline'
  | 'thermometer-outline'
  | 'time-outline'
  | 'trash-outline'
  | 'volume-high'
  | 'volume-high-outline'
  | 'volume-mute';

export const EDITOR_ICONS: Readonly<Record<EditorIconName, string>> = {
  'add':
    '<path d="M256 112v288M400 256H112" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'arrow-down-circle-outline':
    '<path d="M176 262.62 256 342l80-79.38M256 330.97V170" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M256 64C150 64 64 150 64 256s86 192 192 192 192-86 192-192S362 64 256 64Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/>',
  'arrow-down-outline':
    '<path d="m112 268 144 144 144-144M256 392V100" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48px"/>',
  'arrow-forward':
    '<path d="m268 112 144 144-144 144M392 256H100" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48px"/>',
  'arrow-redo-outline':
    '<path d="M448 256 272 88v96C103.57 184 64 304.77 64 424c48.61-62.24 91.6-96 208-96v96Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/>',
  'arrow-undo-outline':
    '<path d="M240 424v-96c116.4 0 159.39 33.76 208 96 0-119.23-39.57-240-208-240V88L64 256Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/>',
  'arrow-up-circle-outline':
    '<path d="M176 249.38 256 170l80 79.38M256 181.03V342" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M448 256c0-106-86-192-192-192S64 150 64 256s86 192 192 192 192-86 192-192Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/>',
  'arrow-up-outline':
    '<path d="m112 244 144-144 144 144M256 120v292" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48px"/>',
  'ban-outline':
    '<circle cx="256" cy="256" r="208" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32"/><path fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32" d="m108.92 108.92 294.16 294.16"/>',
  'bookmark-outline':
    '<path d="M352 48H160a48 48 0 0 0-48 48v368l144-128 144 128V96a48 48 0 0 0-48-48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'chatbox-ellipses-outline':
    '<path d="M408 64H104a56.16 56.16 0 0 0-56 56v192a56.16 56.16 0 0 0 56 56h40v80l93.72-78.14a8 8 0 0 1 5.13-1.86H408a56.16 56.16 0 0 0 56-56V120a56.16 56.16 0 0 0-56-56Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/><circle cx="160" cy="216" r="32"/><circle cx="256" cy="216" r="32"/><circle cx="352" cy="216" r="32"/>',
  'checkmark':
    '<path d="M416 128 192 384l-96-96" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'chevron-back':
    '<path d="M328 112 184 256l144 144" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48px"/>',
  'chevron-down':
    '<path d="m112 184 144 144 144-144" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="48px"/>',
  'close':
    '<path d="m289.94 256 95-95A24 24 0 0 0 351 127l-95 95-95-95a24 24 0 0 0-34 34l95 95-95 95a24 24 0 1 0 34 34l95-95 95 95a24 24 0 0 0 34-34Z"/>',
  'cloudy-outline':
    '<path d="M100.18 241.19a15.93 15.93 0 0 0 13.37-13.25C126.6 145.59 186.34 96 256 96c64.69 0 107.79 42.36 124.92 87a16.11 16.11 0 0 0 12.53 10.18C449.36 202.06 496 239.21 496 304c0 66-54 112-120 112H116c-55 0-100-27.44-100-88 0-54.43 43.89-80.81 84.18-86.81Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/>',
  'color-fill-outline':
    '<path d="M419.1 337.45a3.94 3.94 0 0 0-6.1 0c-10.5 12.4-45 46.55-45 77.66 0 27 21.5 48.89 48 48.89s48-22 48-48.89c0-31.11-34.3-65.26-44.9-77.66ZM387 287.9 155.61 58.36a36 36 0 0 0-51 0l-5.15 5.15a36 36 0 0 0 0 51l52.89 52.89 57-57L56.33 263.2a28 28 0 0 0 .3 40l131.2 126a28.05 28.05 0 0 0 38.9-.1c37.8-36.6 118.3-114.5 126.7-122.9 5.8-5.8 18.2-7.1 28.7-7.1h.3a6.53 6.53 0 0 0 4.57-11.2Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/>',
  'color-filter-outline':
    '<circle cx="256" cy="184" r="120" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/><circle cx="344" cy="328" r="120" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/><circle cx="168" cy="328" r="120" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/>',
  'color-palette-outline':
    '<path d="M430.11 347.9c-6.6-6.1-16.3-7.6-24.6-9-11.5-1.9-15.9-4-22.6-10-14.3-12.7-14.3-31.1 0-43.8l30.3-26.9c46.4-41 46.4-108.2 0-149.2-34.2-30.1-80.1-45-127.8-45-55.7 0-113.9 20.3-158.8 60.1-83.5 73.8-83.5 194.7 0 268.5 41.5 36.7 97.5 55 152.9 55.4h1.7c55.4 0 110-17.9 148.8-52.4 14.4-12.7 11.99-36.6.1-47.7Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/><circle cx="144" cy="208" r="32"/><circle cx="152" cy="311" r="32"/><circle cx="224" cy="144" r="32"/><circle cx="256" cy="367" r="48"/><circle cx="328" cy="144" r="32"/>',
  'color-wand-outline':
    '<rect width="63.03" height="378.2" x="280.48" y="122.9" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32" rx="31.52" transform="rotate(-45 312.002 311.994)"/><path d="M178.38 178.38a31.64 31.64 0 0 0 0 44.75L223.25 268 268 223.25l-44.87-44.87a31.64 31.64 0 0 0-44.75 0"/><path stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32" d="M48 192h48M90.18 90.18l33.94 33.94M192 48v48M293.82 90.18l-33.94 33.94M124.12 259.88l-33.94 33.94"/>',
  'contract-outline':
    '<path d="M304 416V304h112M314.2 314.23 432 432M208 96v112H96M197.8 197.77 80 80M416 208H304V96M314.23 197.8 432 80M96 304h112v112M197.77 314.2 80 432" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'contrast-outline':
    '<circle cx="256" cy="256" r="208" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/><path d="M256 464c-114.88 0-208-93.12-208-208S141.12 48 256 48Z"/>',
  'copy-outline':
    '<rect width="336" height="336" x="128" y="128" rx="57" ry="57" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/><path d="m383.5 128 .5-24a56.16 56.16 0 0 0-56-56H112a64.19 64.19 0 0 0-64 64v216a56.16 56.16 0 0 0 56 56h24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'create-outline':
    '<path d="M384 224v184a40 40 0 0 1-40 40H104a40 40 0 0 1-40-40V168a40 40 0 0 1 40-40h167.48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M459.94 53.25a16.06 16.06 0 0 0-23.22-.56L424.35 65a8 8 0 0 0 0 11.31l11.34 11.32a8 8 0 0 0 11.34 0l12.06-12c6.1-6.09 6.67-16.01.85-22.38M399.34 90 218.82 270.2a9 9 0 0 0-2.31 3.93L208.16 299a3.91 3.91 0 0 0 4.86 4.86l24.85-8.35a9 9 0 0 0 3.93-2.31L422 112.66a9 9 0 0 0 0-12.66l-9.95-10a9 9 0 0 0-12.71 0"/>',
  'crop-outline':
    '<path d="M144 48v272a48 48 0 0 0 48 48h272" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M368 304V192a48 48 0 0 0-48-48H208M368 368v96M144 144H48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'cut-outline':
    '<circle cx="104" cy="152" r="56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><circle cx="104" cy="360" r="56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="m157 175-11 15 37 15s3.46-6.42 7-10Z" fill="none" stroke="currentColor" stroke-linecap="square" stroke-miterlimit="10" stroke-width="32px"/><path d="M154.17 334.43 460 162c-2.5-6.7-28-12-64-4-29.12 6.47-121.16 29.05-159.16 56.05C205.85 236.06 227 272 192 298c-25.61 19-44.43 22.82-44.43 22.82ZM344.47 278.24 295 306.67c14.23 6.74 65.54 33.27 117 36.33 14.92.89 30 .39 39-6Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/><circle cx="256" cy="240" r="32" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/>',
  'duplicate-outline':
    '<rect width="336" height="336" x="128" y="128" rx="57" ry="57" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="32px"/><path d="m383.5 128 .5-24a56.16 56.16 0 0 0-56-56H112a64.19 64.19 0 0 0-64 64v216a56.16 56.16 0 0 0 56 56h24M296 216v160M376 296H216" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'expand-outline':
    '<path d="M432 320v112H320M421.8 421.77 304 304M80 192V80h112M90.2 90.23 208 208M320 80h112v112M421.77 90.2 304 208M192 432H80V320M90.23 421.8 208 304" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'grid-outline':
    '<rect width="176" height="176" x="48" y="48" rx="20" ry="20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><rect width="176" height="176" x="288" y="48" rx="20" ry="20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><rect width="176" height="176" x="48" y="288" rx="20" ry="20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><rect width="176" height="176" x="288" y="288" rx="20" ry="20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'happy-outline':
    '<circle cx="184" cy="232" r="24"/><path d="M256.05 384c-45.42 0-83.62-29.53-95.71-69.83a8 8 0 0 1 7.82-10.17h175.69a8 8 0 0 1 7.82 10.17c-11.99 40.3-50.2 69.83-95.62 69.83"/><circle cx="328" cy="232" r="24"/><circle cx="256" cy="256" r="208" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/>',
  'link-outline':
    '<path d="M208 352h-64a96 96 0 0 1 0-192h64M304 160h64a96 96 0 0 1 0 192h-64M163.29 256h187.42" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="36px"/>',
  'mic':
    '<path d="M192 448h128M384 208v32c0 70.4-57.6 128-128 128h0c-70.4 0-128-57.6-128-128v-32M256 368v80" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M256 320a78.83 78.83 0 0 1-56.55-24.1A80.9 80.9 0 0 1 176 239V128a79.69 79.69 0 0 1 80-80c44.86 0 80 35.14 80 80v111c0 44.66-35.89 81-80 81"/>',
  'mic-outline':
    '<path d="M192 448h128M384 208v32c0 70.4-57.6 128-128 128h0c-70.4 0-128-57.6-128-128v-32M256 368v80" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M256 64a63.68 63.68 0 0 0-64 64v111c0 35.2 29 65 64 65s64-29 64-65V128c0-36-28-64-64-64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'musical-note':
    '<path d="M183.83 480a55.2 55.2 0 0 1-32.36-10.55A56.64 56.64 0 0 1 128 423.58a50.26 50.26 0 0 1 34.14-47.73L213 358.73a16.25 16.25 0 0 0 11-15.49V92a32.1 32.1 0 0 1 24.09-31.15l108.39-28.14A22 22 0 0 1 384 54v57.75a32.09 32.09 0 0 1-24.2 31.19l-91.65 23.13A16.24 16.24 0 0 0 256 181.91V424a48.22 48.22 0 0 1-32.78 45.81l-21.47 7.23a56 56 0 0 1-17.92 2.96"/>',
  'musical-note-outline':
    '<path d="M240 343.31V424a32.28 32.28 0 0 1-21.88 30.65l-21.47 7.23c-25.9 8.71-52.65-10.75-52.65-38.32h0A34.29 34.29 0 0 1 167.25 391l50.87-17.12A32.29 32.29 0 0 0 240 343.24V92a16.13 16.13 0 0 1 12.06-15.66L360.49 48.2A6 6 0 0 1 368 54v57.76a16.13 16.13 0 0 1-12.12 15.67l-91.64 23.13A32.25 32.25 0 0 0 240 181.91v39.39" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'musical-notes-outline':
    '<path d="M192 218v-6c0-14.84 10-27 24.24-30.59l174.59-46.68A20 20 0 0 1 416 154v22" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M416 295.94v80c0 13.91-8.93 25.59-22 30l-22 8c-25.9 8.72-52-10.42-52-38h0a33.37 33.37 0 0 1 23-32l51-18.15c13.07-4.4 22-15.94 22-29.85V58a10 10 0 0 0-12.6-9.61L204 102a16.48 16.48 0 0 0-12 16v226c0 13.91-8.93 25.6-22 30l-52 18c-13.88 4.68-22 17.22-22 32h0c0 27.58 26.52 46.55 52 38l22-8c13.07-4.4 22-16.08 22-30v-80" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'options-outline':
    '<path d="M368 128h80M64 128h240M368 384h80M64 384h240M208 256h240M64 256h80" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><circle cx="336" cy="128" r="32" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><circle cx="176" cy="256" r="32" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><circle cx="336" cy="384" r="32" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'pause':
    '<path d="M208 432h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16M352 432h-48a16 16 0 0 1-16-16V96a16 16 0 0 1 16-16h48a16 16 0 0 1 16 16v320a16 16 0 0 1-16 16"/>',
  'pencil':
    '<path d="M358.62 129.28 86.49 402.08 70 442l39.92-16.49 272.8-272.13zM413.07 74.84l-11.79 11.78 24.1 24.1 11.79-11.79a16.51 16.51 0 0 0 0-23.34l-.75-.75a16.51 16.51 0 0 0-23.35 0" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="44px"/>',
  'play':
    '<path d="M133 440a35.37 35.37 0 0 1-17.5-4.67c-12-6.8-19.46-20-19.46-34.33V111c0-14.37 7.46-27.53 19.46-34.33a35.13 35.13 0 0 1 35.77.45l247.85 148.36a36 36 0 0 1 0 61l-247.89 148.4A35.5 35.5 0 0 1 133 440"/>',
  'play-skip-back-outline':
    '<path d="M400 111v290c0 17.44-17 28.52-31 20.16L121.09 272.79c-12.12-7.25-12.12-26.33 0-33.58L369 90.84c14-8.36 31 2.72 31 20.16Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/><path d="M112 80v352" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/>',
  'play-skip-forward-outline':
    '<path d="M112 111v290c0 17.44 17 28.52 31 20.16l247.9-148.37c12.12-7.25 12.12-26.33 0-33.58L143 90.84c-14-8.36-31 2.72-31 20.16Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/><path d="M400 80v352" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/>',
  'repeat-outline':
    '<path d="m320 120 48 48-48 48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M352 168H144a80.24 80.24 0 0 0-80 80v16M192 392l-48-48 48-48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M160 344h208a80.24 80.24 0 0 0 80-80v-16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'resize-outline':
    '<path d="M304 96h112v112M405.77 106.2 111.98 400.02M208 416H96V304" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'scan-outline':
    '<path d="M336 448h56a56 56 0 0 0 56-56v-56M448 176v-56a56 56 0 0 0-56-56h-56M176 448h-56a56 56 0 0 1-56-56v-56M64 176v-56a56 56 0 0 1 56-56h56" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'search-outline':
    '<path d="M221.09 64a157.09 157.09 0 1 0 157.09 157.09A157.1 157.1 0 0 0 221.09 64Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/><path d="M338.29 338.29 448 448" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/>',
  'sparkles':
    '<path d="M208 512a24.84 24.84 0 0 1-23.34-16l-39.84-103.6a16.06 16.06 0 0 0-9.19-9.19L32 343.34a25 25 0 0 1 0-46.68l103.6-39.84a16.06 16.06 0 0 0 9.19-9.19L184.66 144a25 25 0 0 1 46.68 0l39.84 103.6a16.06 16.06 0 0 0 9.19 9.19l103 39.63a25.49 25.49 0 0 1 16.63 24.1 24.82 24.82 0 0 1-16 22.82l-103.6 39.84a16.06 16.06 0 0 0-9.19 9.19L231.34 496A24.84 24.84 0 0 1 208 512M88 176a14.67 14.67 0 0 1-13.69-9.4l-16.86-43.84a7.28 7.28 0 0 0-4.21-4.21L9.4 101.69a14.67 14.67 0 0 1 0-27.38l43.84-16.86a7.3 7.3 0 0 0 4.21-4.21L74.16 9.79A15 15 0 0 1 86.23.11a14.67 14.67 0 0 1 15.46 9.29l16.86 43.84a7.3 7.3 0 0 0 4.21 4.21l43.84 16.86a14.67 14.67 0 0 1 0 27.38l-43.84 16.86a7.28 7.28 0 0 0-4.21 4.21l-16.86 43.84A14.67 14.67 0 0 1 88 176M400 256a16 16 0 0 1-14.93-10.26l-22.84-59.37a8 8 0 0 0-4.6-4.6l-59.37-22.84a16 16 0 0 1 0-29.86l59.37-22.84a8 8 0 0 0 4.6-4.6l22.67-58.95a16.45 16.45 0 0 1 13.17-10.57 16 16 0 0 1 16.86 10.15l22.84 59.37a8 8 0 0 0 4.6 4.6l59.37 22.84a16 16 0 0 1 0 29.86l-59.37 22.84a8 8 0 0 0-4.6 4.6l-22.84 59.37A16 16 0 0 1 400 256"/>',
  'sparkles-outline':
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="M259.92 262.91 216.4 149.77a9 9 0 0 0-16.8 0l-43.52 113.14a9 9 0 0 1-5.17 5.17L37.77 311.6a9 9 0 0 0 0 16.8l113.14 43.52a9 9 0 0 1 5.17 5.17l43.52 113.14a9 9 0 0 0 16.8 0l43.52-113.14a9 9 0 0 1 5.17-5.17l113.14-43.52a9 9 0 0 0 0-16.8l-113.14-43.52a9 9 0 0 1-5.17-5.17M108 68 88 16 68 68 16 88l52 20 20 52 20-52 52-20zM426.67 117.33 400 48l-26.67 69.33L304 144l69.33 26.67L400 240l26.67-69.33L496 144z"/>',
  'speedometer-outline':
    '<path d="m326.1 231.9-47.5 75.5a31 31 0 0 1-7 7 30.11 30.11 0 0 1-35-49l75.5-47.5a10.23 10.23 0 0 1 11.7 0 10.06 10.06 0 0 1 2.3 14"/><path d="M256 64C132.3 64 32 164.2 32 287.9a223.18 223.18 0 0 0 56.3 148.5c1.1 1.2 2.1 2.4 3.2 3.5a25.19 25.19 0 0 0 37.1-.1 173.13 173.13 0 0 1 254.8 0 25.19 25.19 0 0 0 37.1.1l3.2-3.5A223.18 223.18 0 0 0 480 287.9C480 164.2 379.7 64 256 64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M256 128v32M416 288h-32M128 288H96M165.49 197.49l-22.63-22.63M346.51 197.49l22.63-22.63" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/>',
  'sunny-outline':
    '<path d="M256 48v48M256 416v48M403.08 108.92l-33.94 33.94M142.86 369.14l-33.94 33.94M464 256h-48M96 256H48M403.08 403.08l-33.94-33.94M142.86 142.86l-33.94-33.94" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/><circle cx="256" cy="256" r="80" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/>',
  'swap-horizontal-outline':
    '<path d="m304 48 112 112-112 112M398.87 160H96M208 464 96 352l112-112M114 352h302" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'swap-vertical-outline':
    '<path d="M464 208 352 96 240 208M352 113.13V416M48 304l112 112 112-112M160 398V96" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'text-outline':
    '<path d="m32 415.5 120-320 120 320M230 303.5H74M326 239.5c12.19-28.69 41-48 74-48h0c46 0 80 32 80 80v144" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M320 358.5c0 36 26.86 58 60 58 54 0 100-27 100-106v-15c-20 0-58 1-92 5-32.77 3.86-68 19-68 58" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'thermometer-outline':
    '<path d="M307.72 302.27a8 8 0 0 1-3.72-6.75V80a48 48 0 0 0-48-48h0a48 48 0 0 0-48 48v215.52a8 8 0 0 1-3.71 6.74 97.51 97.51 0 0 0-44.19 86.07A96 96 0 0 0 352 384a97.49 97.49 0 0 0-44.28-81.73ZM256 112v272" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/><circle cx="256" cy="384" r="48"/>',
  'time-outline':
    '<path d="M256 64C150 64 64 150 64 256s86 192 192 192 192-86 192-192S362 64 256 64Z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32px"/><path d="M256 128v144h96" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'trash-outline':
    '<path d="m112 112 20 320c.95 18.49 14.4 32 32 32h184c17.67 0 30.87-13.51 32-32l20-320" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/><path d="M80 112h352" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/><path d="M192 112V72h0a23.93 23.93 0 0 1 24-24h80a23.93 23.93 0 0 1 24 24h0v40M256 176v224M184 176l8 224M328 176l-8 224" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'volume-high':
    '<path d="M232 416a23.88 23.88 0 0 1-14.2-4.68 8 8 0 0 1-.66-.51L125.76 336H56a24 24 0 0 1-24-24V200a24 24 0 0 1 24-24h69.75l91.37-74.81a8 8 0 0 1 .66-.51A24 24 0 0 1 256 120v272a24 24 0 0 1-24 24M320 336a16 16 0 0 1-14.29-23.19c9.49-18.87 14.3-38 14.3-56.81 0-19.38-4.66-37.94-14.25-56.73a16 16 0 0 1 28.5-14.54C346.19 208.12 352 231.44 352 256c0 23.86-6 47.81-17.7 71.19A16 16 0 0 1 320 336"/><path d="M368 384a16 16 0 0 1-13.86-24C373.05 327.09 384 299.51 384 256c0-44.17-10.93-71.56-29.82-103.94a16 16 0 0 1 27.64-16.12C402.92 172.11 416 204.81 416 256c0 50.43-13.06 83.29-34.13 120a16 16 0 0 1-13.87 8"/><path d="M416 432a16 16 0 0 1-13.39-24.74C429.85 365.47 448 323.76 448 256c0-66.5-18.18-108.62-45.49-151.39a16 16 0 1 1 27-17.22C459.81 134.89 480 181.74 480 256c0 64.75-14.66 113.63-50.6 168.74A16 16 0 0 1 416 432"/>',
  'volume-high-outline':
    '<path d="M126 192H56a8 8 0 0 0-8 8v112a8 8 0 0 0 8 8h69.65a15.93 15.93 0 0 1 10.14 3.54l91.47 74.89A8 8 0 0 0 240 392V120a8 8 0 0 0-12.74-6.43l-91.47 74.89A15 15 0 0 1 126 192M320 320c9.74-19.38 16-40.84 16-64 0-23.48-6-44.42-16-64M368 368c19.48-33.92 32-64.06 32-112s-12-77.74-32-112M416 416c30-46 48-91.43 48-160s-18-113-48-160" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32px"/>',
  'volume-mute':
    '<path d="M416 432 64 80" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32px"/><path d="M243.33 98.86a23.89 23.89 0 0 0-25.55 1.82l-.66.51-28.52 23.35a8 8 0 0 0-.59 11.85l54.33 54.33a8 8 0 0 0 13.66-5.66v-64.49a24.51 24.51 0 0 0-12.67-21.71M251.33 335.29 96.69 180.69A16 16 0 0 0 85.38 176H56a24 24 0 0 0-24 24v112a24 24 0 0 0 24 24h69.76l92 75.31a23.9 23.9 0 0 0 25.87 1.69A24.51 24.51 0 0 0 256 391.45v-44.86a16 16 0 0 0-4.67-11.3M352 256c0-24.56-5.81-47.87-17.75-71.27a16 16 0 1 0-28.5 14.55C315.34 218.06 320 236.62 320 256q0 4-.31 8.13a8 8 0 0 0 2.32 6.25l14.36 14.36a8 8 0 0 0 13.55-4.31A146 146 0 0 0 352 256M416 256c0-51.18-13.08-83.89-34.18-120.06a16 16 0 0 0-27.64 16.12C373.07 184.44 384 211.83 384 256c0 23.83-3.29 42.88-9.37 60.65a8 8 0 0 0 1.9 8.26L389 337.4a8 8 0 0 0 13.13-2.79C411 311.76 416 287.26 416 256"/><path d="M480 256c0-74.25-20.19-121.11-50.51-168.61a16 16 0 1 0-27 17.22C429.82 147.38 448 189.5 448 256c0 46.19-8.43 80.27-22.43 110.53a8 8 0 0 0 1.59 9l11.92 11.92a8 8 0 0 0 12.92-2.16C471.6 344.9 480 305 480 256"/>',
};

/** The one box every shape is drawn in, so a component sizes with `width` and `height` alone. */
export const EDITOR_ICON_VIEW_BOX = '0 0 512 512';
