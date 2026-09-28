import { describe, expect, it } from 'vitest';

import type { LabelEngine, LabeledFrame } from './definitions';
import { MEDIA_SCENES, mergeScenes, scenesFromLabels, type SceneScore } from './scenes';

/** A frame from `[label, confidence]` pairs, as an engine lists them. */
function frame(labels: readonly (readonly [string, number])[], timeMs = 0): LabeledFrame {
  return { timeMs, labels: labels.map(([label, confidence]) => ({ label, confidence })) };
}

function scoreOf(scenes: readonly SceneScore[], scene: string): number | undefined {
  return scenes.find(entry => entry.scene === scene)?.score;
}

describe('MEDIA_SCENES', () => {
  it('names each scene once', () => {
    expect(new Set(MEDIA_SCENES).size).toBe(MEDIA_SCENES.length);
  });
});

describe('scenesFromLabels', () => {
  it('counts a scene as its strongest label, not as the sum of every label that says it', () => {
    /* Vision names one cake four ways, all at the cake's own confidence. */
    const cake = frame([
      ['food', 0.72],
      ['dessert', 0.72],
      ['baked_goods', 0.72],
      ['cake', 0.72],
    ]);
    const scenes = scenesFromLabels([cake], 'vision');
    expect(scoreOf(scenes, 'food')).toBeCloseTo(0.72, 3);
    /* A cake says birthday too, at its own weight. */
    expect(scoreOf(scenes, 'birthday')).toBeCloseTo(0.432, 3);
  });

  it('counts a label below its floor as nothing, and above it at its full weight', () => {
    /* ML Kit's Dog: 0.79 on a city bridge at night, 0.97 on a dog. */
    expect(scoreOf(scenesFromLabels([frame([['Dog', 0.85]])], 'mlkit'), 'pet')).toBeUndefined();
    expect(scoreOf(scenesFromLabels([frame([['Dog', 0.95]])], 'mlkit'), 'pet')).toBeCloseTo(0.855, 3);
  });

  it('averages a scene over the frames, a frame without it counting as 0', () => {
    const scenes = scenesFromLabels([frame([['food', 0.8]], 0), frame([['beach', 0.6]], 1000)], 'vision');
    expect(scoreOf(scenes, 'food')).toBeCloseTo(0.4, 3);
    expect(scoreOf(scenes, 'beach')).toBeCloseTo(0.3, 3);
  });

  it('reads ML Kit names as they come, spaces and capitals and hyphens', () => {
    const scenes = scenesFromLabels(
      [
        frame([
          ['Fast food', 0.9],
          ['Pixie-bob', 0.5],
        ]),
      ],
      'mlkit',
    );
    expect(scoreOf(scenes, 'food')).toBeCloseTo(0.9, 3);
    expect(scoreOf(scenes, 'pet')).toBeCloseTo(0.4, 3);
  });

  it('lists only the scenes something said, strongest first, ties in MEDIA_SCENES order', () => {
    const scenes = scenesFromLabels(
      [
        frame([
          ['beach', 0.5],
          ['food', 0.5],
          ['abacus', 0.9],
        ]),
      ],
      'vision',
    );
    expect(scenes).toEqual([
      { scene: 'food', score: 0.5 },
      { scene: 'beach', score: 0.5 },
    ]);
  });

  it('ignores a confidence that is not a number or not above 0, and holds one above 1 at 1', () => {
    const scenes = scenesFromLabels(
      [
        frame([
          ['food', Number.NaN],
          ['beach', -1],
          ['sunset_sunrise', 3],
        ]),
      ],
      'vision',
    );
    expect(scenes).toEqual([{ scene: 'sunset', score: 1 }]);
  });

  it('answers nothing for no frames, and for an engine it has no table for', () => {
    expect(scenesFromLabels([], 'vision')).toEqual([]);
    expect(scenesFromLabels([frame([['food', 0.9]])], 'someday' as LabelEngine)).toEqual([]);
  });

  /*
   * The browser's engine scores one softmax over ImageNet, so the classes that mean a scene split a
   * picture's confidence between them and the scene is their sum. Real answers from the evaluation
   * its table was built against, labels to three places above the 0.02 it reports down to.
   */
  describe('in a browser, where the labels of a scene add up', () => {
    it('adds a dog split between six breeds back up to one pet', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['Irish water spaniel', 0.328],
            ['Border collie', 0.145],
            ['groenendael', 0.074],
            ['English springer', 0.07],
            ['standard poodle', 0.051],
            ['curly-coated retriever', 0.035],
            ['ox', 0.027],
          ]),
        ],
        'mediapipe',
      );
      expect(scenes).toEqual([{ scene: 'pet', score: 0.703 }]);
    });

    it('never takes a scene past 1, however many labels say it', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['seashore', 0.8],
            ['sandbar', 0.5],
            ['coral reef', 0.3],
          ]),
        ],
        'mediapipe',
      );
      expect(scoreOf(scenes, 'beach')).toBe(1);
    });

    it('reads a screen-recorded game as a game first and a screen second', () => {
      const scenes = scenesFromLabels([frame([['joystick', 0.918]])], 'mediapipe');
      expect(scenes).toEqual([
        { scene: 'game', score: 0.918 },
        { scene: 'screen', score: 0.459 },
      ]);
    });

    it('sees a birthday by its candles, and a bowl of fruit as food', () => {
      expect(scenesFromLabels([frame([['candle', 0.965]])], 'mediapipe')[0]).toEqual({ scene: 'birthday', score: 0.965 });
      const fruit = scenesFromLabels(
        [
          frame([
            ['pomegranate', 0.297],
            ['strawberry', 0.297],
            ['pizza', 0.043],
            ['acorn squash', 0.039],
            ['fig', 0.035],
          ]),
        ],
        'mediapipe',
      );
      expect(fruit).toEqual([{ scene: 'food', score: 0.577 }]);
    });

    it('has no word for a sunset, so a sunset over the water reads as a beach', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['breakwater', 0.176],
            ['fountain', 0.109],
            ['lakeside', 0.078],
            ['seashore', 0.078],
            ['pier', 0.063],
            ['patio', 0.039],
          ]),
        ],
        'mediapipe',
      );
      expect(scenes.map(entry => entry.scene)).toEqual(['beach', 'nature']);
      expect(scoreOf(scenes, 'sunset')).toBeUndefined();
    });

    it('still takes the strongest label, not the sum, for the phones', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['food', 0.5],
            ['drink', 0.5],
          ]),
        ],
        'vision',
      );
      expect(scoreOf(scenes, 'food')).toBe(0.5);
    });
  });

  /*
   * Real answers, from the evaluation the tables were built against: each engine's labels for one
   * of the photographs, or the frames of one screen-recorded game, confidences to three places.
   */
  describe('on what the engines really said', () => {
    it('Vision: a skater popping a kickflip is sport', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['recreation', 0.997],
            ['skating', 0.993],
            ['skateboarding', 0.966],
            ['skatepark', 0.944],
            ['outdoor', 0.885],
            ['sky', 0.885],
            ['skateboard', 0.833],
            ['sport', 0.833],
            ['sports_equipment', 0.833],
            ['palm_tree', 0.824],
            ['plant', 0.824],
            ['tree', 0.824],
          ]),
        ],
        'vision',
      );
      expect(scenes[0]).toEqual({ scene: 'sport', score: 0.993 });
    });

    it('Vision: a plate of loaded fries is food, whatever it was served on', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['tableware', 0.852],
            ['utensil', 0.852],
            ['plate', 0.843],
            ['food', 0.664],
            ['pasta', 0.664],
            ['material', 0.56],
            ['textile', 0.56],
            ['structure', 0.462],
            ['wood_processed', 0.462],
          ]),
        ],
        'vision',
      );
      expect(scenes[0]).toEqual({ scene: 'food', score: 0.664 });
    });

    it('Vision: a firework is a party first and the night second', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['fire', 0.933],
            ['fireworks', 0.933],
            ['pyrotechnics', 0.933],
            ['outdoor', 0.193],
            ['sky', 0.193],
            ['night_sky', 0.161],
            ['cloudy', 0.155],
            ['blue_sky', 0.105],
          ]),
        ],
        'vision',
      );
      expect(scenes.map(entry => entry.scene).slice(0, 2)).toEqual(['party', 'night']);
      expect(scoreOf(scenes, 'party')).toBeCloseTo(0.84, 3);
      expect(scoreOf(scenes, 'night')).toBeCloseTo(0.56, 3);
    });

    it('Vision: five frames of a screen-recorded board game are a screen, then a game', () => {
      const scenes = scenesFromLabels(
        [
          frame(
            [
              ['document', 0.868],
              ['screenshot', 0.867],
              ['games', 0.395],
              ['dice', 0.387],
              ['map', 0.292],
              ['board_game', 0.212],
            ],
            755,
          ),
          frame(
            [
              ['document', 0.737],
              ['screenshot', 0.736],
              ['games', 0.3],
              ['board_game', 0.3],
              ['dice', 0.27],
              ['map', 0.223],
            ],
            2265,
          ),
          frame(
            [
              ['document', 0.733],
              ['screenshot', 0.731],
              ['games', 0.478],
              ['dice', 0.477],
              ['map', 0.222],
              ['board_game', 0.144],
            ],
            3776,
          ),
          frame(
            [
              ['games', 0.723],
              ['dice', 0.722],
              ['document', 0.655],
              ['screenshot', 0.653],
              ['map', 0.225],
              ['board_game', 0.187],
            ],
            5287,
          ),
          frame(
            [
              ['document', 0.739],
              ['screenshot', 0.738],
              ['games', 0.448],
              ['dice', 0.444],
              ['board_game', 0.262],
              ['map', 0.229],
            ],
            6797,
          ),
        ],
        'vision',
      );
      expect(scenes.map(entry => entry.scene).slice(0, 2)).toEqual(['screen', 'game']);
      expect(scoreOf(scenes, 'screen')).toBeCloseTo(0.745, 3);
      expect(scoreOf(scenes, 'game')).toBeCloseTo(0.422, 3);
    });

    it('Vision revision 1: the same game, which it calls a board game rather than a screen, is still a game', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['games', 0.868],
            ['board_game', 0.868],
            ['recreation', 0.868],
            ['structure', 0.262],
          ]),
        ],
        'vision',
      );
      expect(scenes[0]).toEqual({ scene: 'game', score: 0.781 });
    });

    it('ML Kit: a cat is a pet', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['Cat', 0.995],
            ['Pet', 0.969],
            ['Ear', 0.769],
            ['Fur', 0.547],
            ['Eyelash', 0.502],
            ['Dog', 0.427],
          ]),
        ],
        'mlkit',
      );
      expect(scenes[0]).toEqual({ scene: 'pet', score: 0.969 });
    });

    it('ML Kit: a bridge at night is the city, and the dog ML Kit thought it saw is not a pet', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['Bridge', 0.961],
            ['Sky', 0.919],
            ['River', 0.834],
            ['Dog', 0.785],
            ['Skyline', 0.685],
            ['Skyscraper', 0.52],
            ['Building', 0.423],
            ['Tower', 0.266],
            ['Road', 0.226],
            ['Bird', 0.202],
          ]),
        ],
        'mlkit',
      );
      expect(scenes[0]).toEqual({ scene: 'city', score: 0.685 });
      expect(scoreOf(scenes, 'pet')).toBeUndefined();
    });

    it('ML Kit: a mug on a bedside table is a cup of something, not the cat ML Kit saw at 0.77', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['Skin', 0.906],
            ['Tableware', 0.872],
            ['Cup', 0.824],
            ['Flowerpot', 0.787],
            ['Cat', 0.77],
            ['Room', 0.645],
            ['Dog', 0.559],
            ['Saucer', 0.484],
            ['Pillow', 0.459],
          ]),
        ],
        'mlkit',
      );
      expect(scenes[0]?.scene).toBe('food');
      expect(scoreOf(scenes, 'pet')).toBeUndefined();
    });

    it('ML Kit: a bunch of balloons is a birthday', () => {
      const scenes = scenesFromLabels(
        [
          frame([
            ['Balloon', 0.948],
            ['Toy', 0.944],
            ['Sky', 0.779],
            ['Fun', 0.555],
            ['Leisure', 0.532],
            ['Event', 0.337],
          ]),
        ],
        'mlkit',
      );
      expect(scenes[0]).toEqual({ scene: 'birthday', score: 0.569 });
    });
  });
});

describe('mergeScenes', () => {
  it('is each scene averaged over the set, a member without it counting as 0', () => {
    const merged = mergeScenes([
      [{ scene: 'food', score: 0.8 }],
      [
        { scene: 'food', score: 0.4 },
        { scene: 'beach', score: 0.6 },
      ],
      [],
      [{ scene: 'beach', score: 0.2 }],
    ]);
    expect(merged).toEqual([
      { scene: 'food', score: 0.3 },
      { scene: 'beach', score: 0.2 },
    ]);
  });

  it('is nothing for an empty set', () => {
    expect(mergeScenes([])).toEqual([]);
  });
});
