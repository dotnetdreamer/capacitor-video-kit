import { Component, Prop, State } from '@stencil/core';

import { activeElementDeep } from '../../bridge/active-element';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import {
  DEFAULT_TEXT_STYLE_ID,
  TEXT_STYLES,
  TEXT_STYLE_CATEGORIES,
  TRENDING_TEXT_STYLE_IDS,
  textStyleById,
  textStyleCss,
  textStylesIn,
  type TextStyleCategory,
} from '../../data/text-styles';
import { TEXT_COLORS, findOverlay, type TextAlign, type TextEffect, type TextOverlay } from '../../editor';

/** The four panels that take the keyboard's place. Alignment has none: its icon just cycles. */
type StylePanel = 'font' | 'colour' | 'background' | 'stroke';

type BackgroundEffect = Extract<TextEffect, 'none' | 'plate' | 'plateSoft'>;
type StrokeEffect = Extract<TextEffect, 'none' | 'shadow' | 'outline'>;

interface EffectChoice<T extends TextEffect> {
  effect: T;
  label: string;
}

/** Every sample the two effect panels draw, in the layer's own font and colour. */
type EffectSamples = Record<TextEffect, Record<string, string>>;

const MAX_TEXT_LENGTH = 200;

/** The field grows line by line up to three lines, then scrolls. Must match the CSS. */
const FIELD_LINE_PX = 22;
const FIELD_PAD_Y_PX = 9;
const FIELD_MAX_PX = FIELD_LINE_PX * 3 + FIELD_PAD_Y_PX * 2;

/** A panel is as tall as the keyboard it replaces, within reason, so swapping the two barely moves the preview. */
const PANEL_DEFAULT_PX = 260;
const PANEL_MIN_PX = 240;
const PANEL_MAX_PX = 300;

/**
 * The sheet opens with the keyboard up. Android shows the keyboard for a programmatic focus only
 * once the sheet is laid out and while the tap that opened it still counts as a user gesture, so
 * the focus waits a beat instead of running in the tick the element loaded in.
 */
const FOCUS_DELAY_MS = 120;

/** How long a WebView is given to raise the keyboard by itself before the host is asked to. */
const KEYBOARD_FALLBACK_MS = 450;

/** The WebView's resize lands a moment after the keyboard's first report, so the first look waits. */
const KEYBOARD_SETTLE_MS = 180;

/** How long after the keyboard has gone the WebView is assumed to have grown back to full size. */
const KEYBOARD_REST_MS = 400;

/** How long a panel waits for a keyboard that was asked for and may never report. */
const PANEL_CLOSE_MS = 400;

/** How long a keyboard is given to give its room back before a panel takes the room anyway. */
const PANEL_ROOM_MS = 500;

/** TikTok's order: centred first, since that is where a new text starts. */
const NEXT_ALIGN: Record<TextAlign, TextAlign> = { center: 'left', left: 'right', right: 'center' };

const BACKGROUND_CHOICES: readonly EffectChoice<BackgroundEffect>[] = [
  { effect: 'none', label: 'None' },
  { effect: 'plate', label: 'Solid' },
  { effect: 'plateSoft', label: 'Soft' },
];

const STROKE_CHOICES: readonly EffectChoice<StrokeEffect>[] = [
  { effect: 'none', label: 'None' },
  { effect: 'shadow', label: 'Shadow' },
  { effect: 'outline', label: 'Outline' },
];

/** Each style's tile CSS, worked out once: the grid re-renders on every tab switch and every pick. */
const FONT_TILE_CSS = new Map(TEXT_STYLES.map(style => [style.id, textStyleCss(style)]));

/**
 * A tap on a button takes focus off the field, and losing focus is what drops the keyboard. So
 * every button in this sheet cancels its mousedown and the handlers decide instead: a panel icon
 * blurs on purpose, alignment leaves the keyboard where it is.
 */
const keepFocus = (event: MouseEvent): void => {
  event.preventDefault();
};

/**
 * TikTok's "Add text" sheet: a text field between a cross and a tick, a row of five style icons,
 * and - when one of them is tapped - a panel that takes the keyboard's place (fonts, colours,
 * background, stroke).
 *
 * The layer already exists when this opens: `store.startNewText()` / `startEditText()` created or
 * picked it and opened ONE gesture around the whole edit. So everything here - every keystroke,
 * every font, colour or alignment tap - is a live `previewOverlay`, and the preview redraws the
 * layer as it changes. The tick calls `finishText()`, which lands the gesture as a single undo step
 * (or drops an empty text); the cross before the field and the shell's back both call
 * `cancelText()`, which puts everything back. This sheet never commits or ends the gesture itself,
 * and never on destroy.
 *
 * It draws its own head rather than the frame's: the cross and the tick belong either side of the
 * field, and the tab strip belongs inside the panel. Both are the frame's own pieces all the same -
 * `showConfirm` is off so there is one tick rather than two, and the strip is `sheet-common.css`'s,
 * so it is the same strip the frame's head draws and not one that merely looks like it.
 */
@Component({
  tag: 've-text-sheet',
  styleUrls: ['../sheet-common.css', 've-text-sheet.css'],
  shadow: true,
})
export class VeTextSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  /*
   * Plain `@State` rather than signals: nothing but the render reads any of these, and a signal
   * only earns its keep when a computed has to read it. Every one of them repaints this component
   * and nothing else.
   */

  /** Which panel has replaced the keyboard; null while typing. */
  @State() private panel: StylePanel | null = null;

  @State() private panelHeight = PANEL_DEFAULT_PX;

  /**
   * False from a panel opening over the keyboard until the keyboard has given its room back. For
   * that moment both are on screen, and a full-height panel squeezed the preview to half its size
   * and let it spring back.
   */
  @State() private panelRoom = true;

  /** Room kept under the sheet for a keyboard the WebView did not make room for (see [fitAboveKeyboard]). */
  @State() private keyboardPad = 0;

  /** The tab opens where the current style lives, so the selected tile is on screen. */
  @State() private fontTab: TextStyleCategory = 'trending';

  private field?: HTMLTextAreaElement;
  private frame?: HTMLElement;

  /** The layer the field was last loaded from. */
  private loadedId: string | null = null;

  private stopKeyboard: (() => void) | null = null;
  private keyboardOpen = false;
  private keyboardHeight = 0;

  /**
   * Whether this host has ever reported a keyboard of its own.
   *
   * It stands where `Capacitor.isNativePlatform()` stood, and answers the question that check was
   * really asking: is there a keyboard that will tell us when it opens, or is the panel on its own?
   * A phone browser reporting through `visualViewport` now behaves like the native build rather
   * than like a desktop, which is what the platform check got wrong.
   */
  private keyboardEverReported = false;

  /** `window.innerHeight` with the keyboard down, to tell whether the WebView shrank for it. */
  private fullHeight = 0;

  /**
   * The sheet's bottom padding with the keyboard down: the navigation bar, when the WebView reaches
   * under it. A panel stands on that padding while the keyboard stood on the bar itself, and the
   * keyboard's reported height runs to the bottom of the screen, bar included.
   */
  private restingBottomPad = 0;

  /** Set when the field took focus from a panel: the panel stays until the keyboard is on its way. */
  private panelClosePending = false;

  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private showFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private panelCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private padTimer: ReturnType<typeof setTimeout> | null = null;
  private panelRoomTimer: ReturnType<typeof setTimeout> | null = null;

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value
   * to the vdom, so a ref would run again and a listener would come off and go back on every
   * repaint - and this component repaints on every keystroke.
   */
  private readonly keepField = (el?: HTMLTextAreaElement) => {
    this.field = el;
  };

  private readonly keepFrame = (el?: HTMLElement) => {
    this.frame = el;
  };

  private readonly onWindowResize = (): void => {
    if (this.keyboardOpen) {
      this.fitAboveKeyboard();
    } else {
      // Only ever raised here: the shrink for an opening keyboard can reach JS before the host
      // reports the keyboard, and taking THAT as the full height would hide the resize from us.
      this.fullHeight = Math.max(this.fullHeight, window.innerHeight);
      if (window.innerHeight >= this.fullHeight - 1) this.releasePanelRoom();
    }
  };

  /**
   * The whole keyboard state machine, over the one number a host reports.
   *
   * Capacitor's four events are one stream now, so the sheet asks what the number means rather than
   * which event arrived: a height above zero is willShow and didShow together, zero is willHide and
   * didHide together. The first report of an opening is the "will" - a guess to size the panel from,
   * with the measurement left to settle - and every report after it is a "did" and is measured at
   * once.
   */
  private readonly onKeyboardHeight = (heightPx: number): void => {
    if (heightPx > 0) {
      const wasOpen = this.keyboardOpen;
      this.keyboardOpen = true;
      this.keyboardEverReported = true;
      this.keyboardHeight = heightPx;
      // A first guess; fitAboveKeyboard corrects it from the room the keyboard really took.
      this.setPanelHeight(heightPx);
      this.closePendingPanel();
      if (wasOpen) {
        this.fitAboveKeyboard();
        return;
      }
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.fitAboveKeyboard(), KEYBOARD_SETTLE_MS);
      return;
    }

    // A browser host reports 0 the moment it is subscribed to, and again on every viewport scroll.
    if (!this.keyboardOpen) return;
    this.keyboardOpen = false;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.keyboardPad = 0;
    // One stream cannot tell the two hide events apart, and at the first of them the WebView has
    // not grown back yet: taking `innerHeight` as the full height here would leave the reference
    // stuck at the shrunken one for good. So it is only RAISED here, the way the resize listener
    // raises it, and assigned once the WebView has had its time - which is what makes a rotation or
    // a split-screen change made while typing the new reference rather than a stale overestimate.
    this.fullHeight = Math.max(this.fullHeight, window.innerHeight);
    this.releasePanelRoom();
    // The shell measures the bars again once the WebView has grown back; read both after it.
    if (this.padTimer) clearTimeout(this.padTimer);
    this.padTimer = setTimeout(() => this.onKeyboardRested(), KEYBOARD_REST_MS);
  };

  componentWillLoad() {
    this.fullHeight = window.innerHeight;
    window.addEventListener('resize', this.onWindowResize);
    // Set up here rather than in `connectedCallback`, which runs before `ctx` can be counted on,
    // and torn down in `disconnectedCallback`, which is the only hook there is. The shell renders
    // this sheet at a fixed position in its own tree, so the element is created and destroyed
    // rather than moved, and the two hooks pair up.
    this.stopKeyboard = this.ctx.store.host.platform.keyboard.subscribe(this.onKeyboardHeight);
    this.fontTab = this.initialFontTab();
  }

  componentDidRender() {
    // The shell keeps this sheet mounted for as long as the panel is 'text', so if the edit moves
    // to another text layer (tapping a different one on the preview) the same instance carries on
    // and the field, which is never bound, has to be reloaded by hand.
    //
    // An id comparison here and not an effect on `textEdit`: the render already reads that signal,
    // and a preact effect runs synchronously inside the assignment that woke it - which for
    // `startEditText()` is the middle of the store's own bookkeeping, before this sheet has been
    // asked to render at all.
    const id = this.ctx.store.textEdit.value?.id ?? null;
    if (!id || id === this.loadedId || !this.field) return;
    this.loadField();
    this.fontTab = this.initialFontTab();
  }

  componentDidLoad() {
    this.readRestingBottomPad();
    this.focusTimer = setTimeout(() => this.focusField(true), FOCUS_DELAY_MS);
  }

  disconnectedCallback() {
    this.watcher.stop();
    for (const timer of [
      this.focusTimer,
      this.showFallbackTimer,
      this.settleTimer,
      this.panelCloseTimer,
      this.padTimer,
      this.panelRoomTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    window.removeEventListener('resize', this.onWindowResize);
    this.stopKeyboard?.();
    this.stopKeyboard = null;
    // Removing a focused field usually drops the keyboard too, but not reliably on every WebView.
    const field = this.field;
    if (field && activeElementDeep() === field) field.blur();
  }

  /* ========================================================================================= */
  /* Typing                                                                                    */
  /* ========================================================================================= */

  private readonly onInput = (event: Event): void => {
    const field = event.target as HTMLTextAreaElement;
    this.autoGrow(field);
    const overlay = this.overlay();
    if (!overlay) return;
    // `maxlength` is not enforced while an IME is still composing, so the stored text is capped
    // too - by code points, so an emoji is never cut in half.
    const chars = Array.from(field.value);
    const text = chars.length > MAX_TEXT_LENGTH ? chars.slice(0, MAX_TEXT_LENGTH).join('') : field.value;
    this.ctx.store.previewOverlay(overlay.id, { text });
  };

  /** Focusing the field is how the customer goes back to typing, so the panel makes way. */
  private readonly onFieldFocus = (): void => {
    if (!this.panel) return;
    if (!this.keyboardEverReported) {
      this.panel = null;
      return;
    }
    // Closing the panel at once would drop the sheet to the bottom and pop it back up when the
    // keyboard arrives. It goes on the keyboard's first report instead; the timer covers a keyboard
    // that never reports (a hardware keyboard, say).
    this.panelClosePending = true;
    if (this.panelCloseTimer) clearTimeout(this.panelCloseTimer);
    this.panelCloseTimer = setTimeout(() => this.closePendingPanel(), PANEL_CLOSE_MS);
  };

  /** The keyboard button. */
  private readonly showKeyboard = (): void => {
    this.focusField();
  };

  /** The tick. The store decides what Done means (an empty text is removed). */
  private readonly done = (): void => {
    this.field?.blur();
    this.ctx.store.finishText();
  };

  /**
   * The cross, which is the shell's back in a button: `cancelText()` puts everything back - a new
   * text goes, an edited one is as it was before the sheet opened - and nothing lands on the undo
   * stack.
   *
   * The sheet needs its own because back is not a button everywhere. On Android it is the system's,
   * and the shell peels the text edit off first. iOS has no back button, this sheet is tall enough
   * to take the stage's round Back with it, and Escape needs a hardware keyboard, so the tick - which
   * KEEPS the text - was the only way out, and a text could be started there and never abandoned.
   */
  private readonly cancel = (): void => {
    this.field?.blur();
    this.ctx.store.cancelText();
  };

  private focusField(fromOpen = false): void {
    const field = this.field;
    if (!field) return;
    field.focus({ preventScroll: true });
    const end = field.value.length;
    field.setSelectionRange(end, end);
    if (!fromOpen) return;
    // Belt and braces for a WebView that focuses the field but keeps the keyboard down because the
    // focus did not come straight from a tap. Only when no keyboard has shown up by then, and only
    // while the customer is still typing: the host raises the IME for whatever the WebView has
    // focused, so asking after a panel has opened would pop an empty keyboard over it. A host with
    // no `show` at all - a browser - simply does nothing here.
    const { keyboard } = this.ctx.store.host.platform;
    this.showFallbackTimer = setTimeout(() => {
      if (this.keyboardOpen || this.panel || activeElementDeep() !== field) return;
      keyboard.show?.();
    }, KEYBOARD_FALLBACK_MS);
  }

  /**
   * Puts the layer's text in the field. Written here rather than bound: echoing every keystroke
   * back into `value` would fight the keyboard's composition and move the caret.
   */
  private loadField(): void {
    const field = this.field;
    const overlay = this.overlay();
    this.loadedId = overlay?.id ?? null;
    if (!field) return;
    field.value = overlay?.text ?? '';
    this.autoGrow(field);
  }

  /** The field is a `rows=1` textarea that grows with its content up to three lines. */
  private autoGrow(field: HTMLTextAreaElement): void {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, FIELD_MAX_PX)}px`;
  }

  /* ========================================================================================= */
  /* Styling                                                                                   */
  /* ========================================================================================= */

  /**
   * Opens a panel in the keyboard's place; tapping the open panel's icon again goes back to typing,
   * the way TikTok's does.
   */
  private togglePanel(panel: StylePanel): void {
    if (this.panel === panel) {
      this.focusField();
      return;
    }
    this.panelClosePending = false;
    if (this.keyboardOpen) {
      this.panelRoom = false;
      // The WebView's resize releases it; the timer covers a keyboard that leaves without one.
      if (this.panelRoomTimer) clearTimeout(this.panelRoomTimer);
      this.panelRoomTimer = setTimeout(() => this.releasePanelRoom(), PANEL_ROOM_MS);
    }
    this.field?.blur();
    this.panel = panel;
  }

  private releasePanelRoom(): void {
    if (this.panelRoomTimer) {
      clearTimeout(this.panelRoomTimer);
      this.panelRoomTimer = null;
    }
    this.panelRoom = true;
  }

  /** Alignment has no panel: each tap moves to the next one, and the keyboard stays where it is. */
  private readonly cycleAlign = (): void => {
    const overlay = this.overlay();
    if (!overlay) return;
    this.ctx.store.previewOverlay(overlay.id, { align: NEXT_ALIGN[overlay.align] });
    this.ctx.store.haptic('selection');
  };

  private readonly pickStyle = (styleId: string): void => {
    this.patch({ styleId });
  };

  private readonly pickColour = (color: string): void => {
    this.patch({ color });
  };

  /**
   * "None" only takes a plate away. A text with a shadow or an outline already has no background,
   * and tapping None here should not quietly strip the stroke the customer chose in the other panel.
   */
  private readonly pickBackground = (effect: BackgroundEffect): void => {
    if (effect === 'none' && backgroundOf(this.overlay()) === 'none') return;
    this.patch({ effect });
  };

  /** The stroke panel's None, likewise, never removes a plate. */
  private readonly pickStroke = (effect: StrokeEffect): void => {
    if (effect === 'none' && strokeOf(this.overlay()) === 'none') return;
    this.patch({ effect });
  };

  private patch(patch: Partial<Pick<TextOverlay, 'styleId' | 'color' | 'effect'>>): void {
    const overlay = this.overlay();
    if (!overlay) return;
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(key => overlay[key] !== patch[key]);
    if (!changed) return;
    this.ctx.store.previewOverlay(overlay.id, patch);
    this.ctx.store.haptic('selection');
  }

  /**
   * The layer being edited, or null for the moment between the edit ending and this sheet going.
   *
   * A method rather than a computed: the render reads it inside `SignalWatcher`, which tracks the
   * two signals it touches, and every other caller is a handler, where a read is untracked anyway.
   */
  private overlay(): TextOverlay | null {
    const { store } = this.ctx;
    const edit = store.textEdit.value;
    const layer = edit ? findOverlay(store.manifest.value, edit.id) : null;
    return layer?.kind === 'text' ? layer : null;
  }

  private initialFontTab(): TextStyleCategory {
    const styleId = this.overlay()?.styleId ?? DEFAULT_TEXT_STYLE_ID;
    return TRENDING_TEXT_STYLE_IDS.includes(styleId) ? 'trending' : textStyleById(styleId).category;
  }

  /* ========================================================================================= */
  /* Keyboard                                                                                  */
  /* ========================================================================================= */

  /**
   * Keeps the sheet above the keyboard however the WebView behaves.
   *
   * The Android manifest sets no `windowSoftInputMode` and `resizeOnFullScreen` is on, so on our
   * builds the WebView normally SHRINKS when the keyboard opens: the editor's column gets shorter,
   * the preview gives up the room and this sheet already sits on the keyboard - adding padding then
   * would float it a keyboard's height too high. But a WebView that is not resized (another
   * activity mode, a host that wires the keyboard differently) leaves the keyboard drawn over the
   * bottom of the page, sheet and all. So the sheet measures: if `innerHeight` dropped by roughly
   * the keyboard's height, nothing is needed; otherwise it keeps that much room under itself.
   */
  private fitAboveKeyboard(): void {
    if (!this.keyboardOpen) return;
    const shrunk = Math.max(0, this.fullHeight - window.innerHeight);
    const resized = shrunk >= this.keyboardHeight * 0.5;
    const pad = resized ? 0 : Math.max(0, Math.round(this.keyboardHeight - shrunk));
    if (pad !== this.keyboardPad) this.keyboardPad = pad;
    this.setPanelHeight(resized ? shrunk : this.keyboardHeight);
  }

  /**
   * A panel as tall as the room the keyboard took, less the padding the resting sheet keeps at the
   * bottom anyway, ends exactly where the keyboard's top edge was - so swapping one for the other
   * leaves the preview where it is.
   */
  private setPanelHeight(coveredPx: number): void {
    const height = Math.round(Math.min(PANEL_MAX_PX, Math.max(PANEL_MIN_PX, coveredPx - this.restingBottomPad)));
    if (height !== this.panelHeight) this.panelHeight = height;
  }

  private onKeyboardRested(): void {
    this.padTimer = null;
    if (this.keyboardOpen) return;
    this.fullHeight = window.innerHeight;
    this.readRestingBottomPad();
  }

  private readRestingBottomPad(): void {
    const frame = this.frame;
    if (this.keyboardOpen || !frame) return;
    this.restingBottomPad = parseFloat(getComputedStyle(frame).paddingBottom) || 0;
  }

  private closePendingPanel(): void {
    if (this.panelCloseTimer) {
      clearTimeout(this.panelCloseTimer);
      this.panelCloseTimer = null;
    }
    if (!this.panelClosePending) return;
    this.panelClosePending = false;
    this.panel = null;
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  /*
   * `glyph` is `unknown` because there is no name for a JSX element to be had here: the automatic
   * runtime leaves no `JSX` namespace in scope, and `VNode` is what `h()` returns rather than what
   * the transform hands back. It is only ever passed straight through to a child position.
   */
  private toolButton(panel: StylePanel, label: string, glyph: unknown) {
    const on = this.panel === panel;
    return (
      <button
        type="button"
        class={{ 'ts__tool': true, 'ts__tool--on': on }}
        aria-label={label}
        // A string, because the vdom removes an attribute set to boolean false and a button with no
        // `aria-pressed` at all is announced as an ordinary one rather than as an unpressed toggle.
        aria-pressed={String(on)}
        onMouseDown={keepFocus}
        onClick={() => this.togglePanel(panel)}
      >
        {glyph}
      </button>
    );
  }

  private fontPanel() {
    const tiles = textStylesIn(this.fontTab).map(style => ({
      id: style.id,
      label: style.label,
      css: FONT_TILE_CSS.get(style.id) ?? textStyleCss(style),
    }));
    /** Resolved through the registry, so a draft with a retired style id still shows Classic as picked. */
    const activeStyleId = textStyleById(this.overlay()?.styleId ?? DEFAULT_TEXT_STYLE_ID).id;

    return [
      <div class="sheet__tabs ts__tabs" role="tablist">
        {TEXT_STYLE_CATEGORIES.map(tab => (
          <button
            type="button"
            role="tab"
            key={tab.id}
            class={{ 'sheet__tab': true, 'sheet__tab--on': tab.id === this.fontTab }}
            aria-selected={String(tab.id === this.fontTab)}
            onMouseDown={keepFocus}
            onClick={() => (this.fontTab = tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>,
      <div class="ts__scroll">
        <div class="ts__font-grid">
          {tiles.map(style => (
            <button
              type="button"
              key={style.id}
              class={{ 'ts__font-tile': true, 'ts__font-tile--on': style.id === activeStyleId }}
              aria-pressed={String(style.id === activeStyleId)}
              aria-label={style.label}
              onMouseDown={keepFocus}
              onClick={() => this.pickStyle(style.id)}
            >
              <span class="ts__font-name" style={style.css}>
                {style.label}
              </span>
            </button>
          ))}
        </div>
      </div>,
    ];
  }

  private colourPanel(overlay: TextOverlay | null) {
    const active = (overlay?.color ?? '#ffffff').toLowerCase();
    return (
      <div class="ts__scroll">
        <div class="ts__colours" role="radiogroup" aria-label="Text colour">
          {TEXT_COLORS.map(colour => (
            <button
              type="button"
              role="radio"
              key={colour}
              class={{ 'ts__colour': true, 'ts__colour--on': colour === active }}
              aria-checked={String(colour === active)}
              aria-label={colour}
              onMouseDown={keepFocus}
              onClick={() => this.pickColour(colour)}
            >
              <span class="ts__swatch" style={{ background: colour }}></span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /**
   * Background and stroke are one panel drawn twice. They differ only in which choices they offer
   * and which half of `effect` they read, and the two type parameters are what keeps a stroke value
   * out of the background's handler now that they share a body.
   */
  private effectPanel<T extends TextEffect>(
    label: string,
    choices: readonly EffectChoice<T>[],
    current: T,
    pick: (effect: T) => void,
    samples: EffectSamples,
  ) {
    return (
      <div class="ts__scroll">
        <div class="ts__effects" role="radiogroup" aria-label={label}>
          {choices.map(choice => (
            <button
              type="button"
              role="radio"
              key={choice.effect}
              class={{ 'ts__effect': true, 'ts__effect--on': choice.effect === current }}
              aria-checked={String(choice.effect === current)}
              onMouseDown={keepFocus}
              onClick={() => pick(choice.effect)}
            >
              <span class="ts__effect-stage">
                <span class="ts__effect-sample" style={samples[choice.effect]}>
                  Aa
                </span>
              </span>
              <span class="ts__effect-label">{choice.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  private panelBody(open: StylePanel, overlay: TextOverlay | null) {
    if (open === 'font') return this.fontPanel();
    if (open === 'colour') return this.colourPanel(overlay);
    const samples = effectSamples(overlay);
    if (open === 'background') {
      return this.effectPanel('Background', BACKGROUND_CHOICES, backgroundOf(overlay), this.pickBackground, samples);
    }
    return this.effectPanel('Stroke', STROKE_CHOICES, strokeOf(overlay), this.pickStroke, samples);
  }

  render() {
    return this.watcher.run(() => {
      const overlay = this.overlay();
      const open = this.panel;
      const align: TextAlign = overlay?.align ?? 'center';

      return (
        <ve-sheet showConfirm={false} ref={this.keepFrame}>
          <div class="ts__input-row">
            <button key="cancel" type="button" class="ts__icon-btn" aria-label="Cancel" onMouseDown={keepFocus} onClick={this.cancel}>
              <ve-icon name="close"></ve-icon>
            </button>

            {/*
              Never bound to `value` and never moved: `loadField` writes the text in by hand, which
              only holds while the vdom leaves this element and its content alone. Hence the key and
              the fixed position among two conditional siblings of another tag.
            */}
            <textarea
              key="field"
              class="ts__field"
              ref={this.keepField}
              rows={1}
              placeholder="Enter text"
              autocapitalize="sentences"
              autocomplete="off"
              aria-label="Text"
              maxLength={MAX_TEXT_LENGTH}
              onInput={this.onInput}
              onFocus={this.onFieldFocus}
            ></textarea>

            {open ? (
              <button
                key="keyboard"
                type="button"
                class="ts__icon-btn"
                aria-label="Show keyboard"
                onMouseDown={keepFocus}
                onClick={this.showKeyboard}
              >
                <svg class="ts__svg" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="2" y="5.5" width="20" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7" />
                  <circle cx="6" cy="9.5" r="1" fill="currentColor" />
                  <circle cx="9.33" cy="9.5" r="1" fill="currentColor" />
                  <circle cx="12.67" cy="9.5" r="1" fill="currentColor" />
                  <circle cx="16" cy="9.5" r="1" fill="currentColor" />
                  <circle cx="7.67" cy="12.3" r="1" fill="currentColor" />
                  <circle cx="11" cy="12.3" r="1" fill="currentColor" />
                  <circle cx="14.33" cy="12.3" r="1" fill="currentColor" />
                  <circle cx="17.67" cy="12.3" r="1" fill="currentColor" />
                  <line x1="8" y1="15.4" x2="16" y2="15.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                </svg>
              </button>
            ) : null}

            <button key="done" type="button" class="ts__icon-btn" aria-label="Done" onMouseDown={keepFocus} onClick={this.done}>
              <ve-icon name="checkmark"></ve-icon>
            </button>
          </div>

          <div class="ts__tools" role="toolbar" aria-label="Text style">
            {this.toolButton(
              'font',
              'Font',
              <span class="ts__glyph-font" aria-hidden="true">
                A
              </span>,
            )}
            {this.toolButton('colour', 'Colour', <span class="ts__glyph-colour" aria-hidden="true"></span>)}
            {this.toolButton(
              'background',
              'Background',
              <span class={{ 'ts__glyph-box': true, 'ts__glyph-box--on': backgroundOf(overlay) !== 'none' }} aria-hidden="true">
                A
              </span>,
            )}

            <button type="button" class="ts__tool" aria-label={`Alignment: ${align}`} onMouseDown={keepFocus} onClick={this.cycleAlign}>
              <svg class="ts__svg" viewBox="0 0 24 24" aria-hidden="true">
                {alignBars(align).map((bar, i) => (
                  <line key={i} x1={bar.x1} x2={bar.x2} y1={bar.y} y2={bar.y} />
                ))}
              </svg>
            </button>

            {this.toolButton(
              'stroke',
              'Stroke',
              <span class="ts__glyph-stroke" aria-hidden="true">
                A
              </span>,
            )}
          </div>

          {/*
            Keyed by which panel is open, so a switch replaces the subtree rather than patching the
            font tab strip into a colour grid position by position. The keyboard room below is a
            conditional div beside it and needs a key of its own for the same reason.
          */}
          {open ? (
            <div class="ts__panel" key={open} style={{ height: `${this.panelRoom ? this.panelHeight : 0}px` }}>
              {this.panelBody(open, overlay)}
            </div>
          ) : null}

          {this.keyboardPad > 0 ? <div class="ts__keyboard-room" key="keyboard-room" style={{ height: `${this.keyboardPad}px` }}></div> : null}
        </ve-sheet>
      );
    });
  }
}

/* ------------------------------------------------------------------------------------------- */

/*
 * `effect` is one field, so background and stroke are two views of it: a text with a shadow has no
 * background, and a text on a plate has no stroke.
 */

function backgroundOf(overlay: TextOverlay | null): BackgroundEffect {
  const effect = overlay?.effect;
  return effect === 'plate' || effect === 'plateSoft' ? effect : 'none';
}

function strokeOf(overlay: TextOverlay | null): StrokeEffect {
  const effect = overlay?.effect;
  return effect === 'shadow' || effect === 'outline' ? effect : 'none';
}

/**
 * "Aa" as each effect would draw it in the layer's own font and colour, so the tiles answer "what
 * will my text look like" rather than showing a generic icon. They follow the [TextEffect] contract
 * - a plate paints the colour behind the text and picks black or white letters - but are CSS
 * approximations; the preview's bitmap is the exact result.
 */
function effectSamples(overlay: TextOverlay | null): EffectSamples {
  const color = overlay?.color ?? '#ffffff';
  const font = textStyleCss(textStyleById(overlay?.styleId ?? DEFAULT_TEXT_STYLE_ID));
  const ink = contrastInk(color);
  return {
    none: { ...font, color },
    plate: { ...font, color: ink, background: color, 'text-shadow': 'none' },
    plateSoft: { ...font, color: ink, background: withAlpha(color, 0.55), 'text-shadow': 'none' },
    shadow: { ...font, color, 'text-shadow': '0 2px 6px rgba(0, 0, 0, 0.85)' },
    outline: { ...font, color, 'text-shadow': outlineShadow(ink) },
  };
}

/** Four bars of an alignment glyph, laid out for the layer's current alignment. */
function alignBars(align: TextAlign): { x1: number; x2: number; y: number }[] {
  return [16, 10, 16, 10].map((width, i) => {
    const x1 = align === 'left' ? 4 : align === 'right' ? 20 - width : 12 - width / 2;
    return { x1, x2: x1 + width, y: 6 + i * 4 };
  });
}

/** Black or white, whichever reads on `hex`. */
function contrastInk(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return '#000000';
  const [r, g, b] = rgb;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff';
}

function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : hex;
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** An outline from eight hard shadows: `-webkit-text-stroke` would eat into thin script faces. */
function outlineShadow(ink: string): string {
  const d = '1.5px';
  const n = `-${d}`;
  return [
    `${n} ${n} 0 ${ink}`,
    `0 ${n} 0 ${ink}`,
    `${d} ${n} 0 ${ink}`,
    `${d} 0 0 ${ink}`,
    `${d} ${d} 0 ${ink}`,
    `0 ${d} 0 ${ink}`,
    `${n} ${d} 0 ${ink}`,
    `${n} 0 0 ${ink}`,
  ].join(', ');
}
