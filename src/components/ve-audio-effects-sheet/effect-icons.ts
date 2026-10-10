import type { EditorIconName } from '../../icons/icons';

/**
 * The sign on each effect's tile in the Audio effects sheet, by effect id. Every effect in
 * `SOUND_EFFECTS` has one - a test holds that - because an effect has no frame to show the way a
 * filter does: it is heard, and its tile is only a name and a sign for it.
 *
 * Here rather than beside the sheet, because a Stencil component's module may export nothing but the
 * component.
 */
export const SOUND_EFFECT_ICONS: Readonly<Record<string, EditorIconName>> = {
  megaphone: 'megaphone-outline',
  // A record, since slow + reverb plays the sound as a record played under its speed.
  slowReverb: 'disc-outline',
  maleVoice: 'male-outline',
  femaleVoice: 'female-outline',
  telephone: 'call-outline',
};
