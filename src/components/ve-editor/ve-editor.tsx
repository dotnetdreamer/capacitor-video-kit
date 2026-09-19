import { Component, Element, Event, type EventEmitter, Host, Prop, State } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { isUntouched, normaliseOutput, qualityOf, reconcileManifest, uniqueClipKeys, type EditManifest } from '../../editor';
import { debugWarn } from '../../host/debug';
import { resolveEditorHost } from '../../host/defaults';
import { installEditorFonts } from '../../host/fonts';
import {
  RenderFailedError,
  type EditorCancelReason,
  type EditorInsets,
  type EditorSource,
  type VideoEditorHost,
  type VideoEditorResult,
} from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';
import type { EditorPanel } from '../../state/editor.types';
import { OverlayBitmaps } from '../../state/overlay-bitmap';
import { DISCARD_EDITS, EditorConfirm, RENDER_UNAVAILABLE, renderFailed } from '../ve-alert/editor-confirm';
import { formatClock, shellLayout } from './shell-layout';

/**
 * How long after the window changes size the insets are measured a second time. The bar flags can
 * change a moment after the resize - coming back from a system picker drops the launch's
 * edge-to-edge flags - so the first measurement is the old layout's and the second is the truth.
 */
const INSET_SETTLE_MS = 300;

/**
 * How far an arrow key moves the playhead, and how far it moves with Shift held.
 *
 * A third of a second is about what a careful scrub is worth at the zoom the timeline opens on, and
 * two seconds is the step for crossing a clip rather than inspecting one. A keyboard is a desktop's
 * only fine control: there is no equivalent of a finger dragging the timeline a few pixels.
 */
const NUDGE_MS = 333;
const NUDGE_COARSE_MS = 2000;

/**
 * The video editor, laid out the way TikTok's is, because that is the editor our customers already
 * know how to use: the video on top, a transport row, a timeline with a fixed centre playhead and
 * one lane per layer, and a row of tools at the bottom that turns into the tools for whatever is
 * selected.
 *
 * This is the only tag a host application places by hand. It is handed the sources, a previous edit
 * if there is one, and everything it cannot do for itself as `host`; it hands back a
 * [VideoEditorResult] on `veDone` and a reason on `veCancel`, and it changes nothing the host owns
 * in between. Every other tag in this package is something this one renders.
 *
 * ```html
 * <ve-editor></ve-editor>
 * <script type="module">
 *   const editor = document.querySelector('ve-editor');
 *   editor.sources = clips;
 *   editor.host = { media, render, platform };
 *   editor.addEventListener('veDone', (event) => post(event.detail));
 * </script>
 * ```
 *
 * Everything the customer does is a change to an [EditManifest], held by the [EditorStore] this
 * element creates; nothing touches a file until they tap Next. The preview plays the ORIGINAL
 * sources with the filter in CSS and every layer drawn as the same bitmap the render will place,
 * and the finished video comes from the host's renderer reading the same manifest.
 *
 * This element is only the frame: it loads the sources, lays the parts out, owns which panel is
 * open, and owns leaving - back, discard, and the render on Next. The parts do the editing.
 */
@Component({
  tag: 've-editor',
  /*
   * The token block first, and it is included here and nowhere else. Every other component in the
   * package reads `var(--ve-x, fallback)` at each point of use, so a host application that sets a
   * token on this element, or anywhere above it, changes it everywhere; a component that declared
   * one on its own `:host` would beat the inherited value and the override would fail in silence.
   */
  styleUrls: ['../ve-tokens.css', 've-editor.css'],
  shadow: true,
})
export class VeEditor {
  @Element() el!: HTMLElement;

  /**
   * The clips to edit, as the step before left them. The editor never opens one; it reads the key,
   * the playable URL and the poster, hands the same objects back in the result, and leaves whatever
   * else a host carries on them untouched.
   */
  @Prop() sources!: readonly EditorSource[];

  /** A previous edit of these sources, when the customer is stepping back into it. */
  @Prop() manifest?: EditManifest;

  /**
   * How many sources may end up on the post, which is what "add" asks before offering itself. The
   * public word is sources; inside, the store says clips for the same thing.
   */
  @Prop() maxSources = 10;

  /**
   * Everything the editor cannot do for itself: the pickers, the duration probe, the filmstrip, the
   * renderer, the keyboard, haptics, the back button and the inset measurement. Every field of it
   * is optional and what is missing falls back to a real browser implementation, so an editor with
   * no host at all still edits and still hands back a manifest.
   */
  @Prop() host?: VideoEditorHost;

  /**
   * The finished edit: the sources the post still uses, the manifest, and the rendered file when
   * there was one to make. A single untouched clip is handed back unrendered rather than re-encoded.
   */
  @Event() veDone!: EventEmitter<VideoEditorResult>;

  /**
   * The customer left without a video. `back` is what the editor itself emits, because its only way
   * out is peeling back through what is open until there is nothing left to close; a host that
   * takes the editor away for its own reasons is the other half of the union.
   */
  @Event() veCancel!: EventEmitter<EditorCancelReason>;

  /**
   * Plain `@State` rather than signals: nothing outside this class reads any of the three, and the
   * render already reads all three, so Stencil's own repaint is the whole of what they need.
   */
  @State() private loading = true;
  @State() private rendering = false;
  @State() private renderProgress = 0;

  private readonly watcher = new SignalWatcher(this);

  private ctx!: EditorContext;
  private store!: EditorStore;
  private media!: EditorMedia;
  /**
   * Held only so it can be disposed. It is what keeps every layer's bitmap in step with the
   * manifest, and it works entirely through an effect on the store, so nothing reads it - which is
   * exactly why it is the easy one to leave out. Without it no layer ever gets a bitmap, the
   * preview looks perfect because it falls back to drawing nothing, and every posted video loses
   * its text, its stickers and its effects.
   */
  private bitmaps!: OverlayBitmaps;
  private confirm!: EditorConfirm;

  private built = false;
  private destroyed = false;
  private leaving = false;
  private renderSupported = false;
  private unregisterBack: (() => void) | null = null;
  private renderAbort: AbortController | null = null;
  private measureTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * What the bars covered at each WebView height seen. The keyboard flips the WebView between the
   * same two heights and the host answers a frame or two after the resize - long enough for the
   * text sheet to flash 48px out of place each time - so a height that has been seen before takes
   * its insets at once and the measurement only confirms them.
   */
  private readonly insetsByHeight = new Map<number, EditorInsets>();

  /* ========================================================================================= */
  /* Life                                                                                      */
  /* ========================================================================================= */

  /**
   * The editor is built HERE and not in `connectedCallback`, and the difference is the whole
   * reason a framework wrapper works at all.
   *
   * Angular, and every framework that writes its bindings after it attaches, puts the element in
   * the document BEFORE it assigns that element's properties. `host` is therefore still undefined
   * in `connectedCallback`, so building there meant `<ve-editor [host]="...">` silently resolved
   * to the package's browser defaults: a file input where the gallery picker belongs, no native
   * render, no back button, and nothing at all saying so. Measured with a probe element, not
   * guessed. Stencil runs this hook after props are set and still before the first paint, which is
   * exactly the window this needs, so the only host that has to build the element by hand now is
   * one that wants to.
   */
  componentWillLoad() {
    if (this.built) {
      if (this.destroyed) {
        debugWarn('[ve-editor] came back after being removed; the edit is gone. Create a new element.');
      }
      return;
    }
    this.built = true;

    const host = resolveEditorHost(this.host);
    this.store = new EditorStore(host);
    this.media = new EditorMedia(this.store, host);
    this.bitmaps = new OverlayBitmaps(this.store, host);
    this.confirm = new EditorConfirm(host.platform);
    this.ctx = { store: this.store, media: this.media };

    this.unregisterBack = host.platform.registerBackHandler(this.onBack);

    /*
     * Fired here so that an editor dropped into a page works with no setup at all, and routed
     * through `debugWarn` because by this point there is nothing useful to do about a failure. The
     * README tells a host to call it at startup instead, where it is loud: these faces are what the
     * rasteriser burns into the posted video, so a missing one is not a missing font, it is text in
     * the finished video that is not the text the customer approved.
     */
    void installEditorFonts().catch((error: unknown) => debugWarn('[ve-editor] fonts failed', error));

    if (host.platform.measureInsets) {
      void this.measureSystemBars();
      window.addEventListener('resize', this.onWindowResize);
    }

    /*
     * On the window rather than on this element, because the editor is a full screen element and
     * the keys have to work with nothing inside it focused at all - which, on a desktop, is where
     * the focus is almost all of the time. `onKeyDown` refuses every keystroke that belongs to
     * something else.
     */
    window.addEventListener('keydown', this.onKeyDown);

    /*
     * Deliberately not awaited. Stencil waits for a promise handed back from this hook before it
     * paints anything, so returning this one would hold the whole editor off the screen while
     * every source is probed - which is the one moment the crescent exists for.
     */
    void this.load();
  }

  /**
   * Leaving the document ends the edit, and there is no way back from it.
   *
   * A host must therefore create this element where it means to keep it, and never move it. That is
   * not this class being careless with a store it could have held on to: every component in the
   * tree below stops watching its signals when it leaves the document, and Stencil does not render
   * a component again when it comes back, so a reparented editor is a screen that has stopped
   * repainting whatever the shell does about its own state. Measured on a synchronous remove and
   * re-append, the shell still swapped sheets and still applied its layout classes while the toast
   * underneath it stayed frozen on the message it had when it went. Half an editor is not better
   * than none, so this tears down and says so if the element ever comes back.
   */
  disconnectedCallback() {
    this.teardown();
  }

  /**
   * Tells Android that the accessibility tree has changed, because it does not notice on its own.
   *
   * An Android WebView does not rebuild the accessibility tree it hands the platform when a subtree
   * appears inside THIS element's shadow root. Chromium's own tree is right - `<ve-alert>` is in it,
   * unignored, with its heading and both buttons - but nothing of it reaches Android, so the
   * question is painted on the screen and TalkBack goes on reading the editor underneath it. It is
   * the bridge that goes stale, not the markup: measured on an API 35 emulator, the dialog was still
   * missing fifteen seconds after it appeared.
   *
   * Any ARIA attribute written on an element in the PAGE's light DOM does refresh it, and this host
   * is such an element. `aria-hidden="false"` is the default state spelled out - it tells a reader
   * exactly what it already assumed about this element - so it changes nothing for anyone and buys
   * the refresh. It is written only while a question is open, so each opening and each answer is one
   * attribute change, and a frame that renders neither writes nothing.
   */
  componentDidRender() {
    if (this.confirm.showing) this.el.setAttribute('aria-hidden', 'false');
    else this.el.removeAttribute('aria-hidden');
  }

  private teardown(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.unregisterBack?.();
    this.unregisterBack = null;
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.measureTimer) clearTimeout(this.measureTimer);
    this.measureTimer = null;

    // A customer who leaves mid render leaves an encode running on the phone otherwise.
    this.renderAbort?.abort();
    this.renderAbort = null;

    /*
     * The voiceover sheet stops its own take when it goes, but that stop is a promise that outlives
     * the element, and the editor can be taken away in the middle of it. The microphone is the one
     * thing that must not be left running, so it is asked twice rather than once; a recorder that
     * has already stopped refuses the second call and that refusal is the answer we wanted.
     */
    if (this.store.recordingFromMs.value !== null) {
      void this.store.host.media.voice?.stop().catch(() => undefined);
    }

    // Anyone still waiting on a question is answered null rather than left holding a dead promise.
    this.confirm.dispose();
    this.watcher.stop();
    this.bitmaps.dispose();
    this.media.dispose();
    this.store.dispose();
  }

  /**
   * Fills the store, then lets the editor open. Every await here can land after the element has
   * gone - the customer can leave while a source is still being measured - so `destroyed` is
   * checked after each one.
   */
  private async load(): Promise<void> {
    const store = this.store;
    // A custom element can be written into a page with no properties set at all, and an editor with
    // nothing in it is a better answer to that than a throw inside the first render.
    const sources = this.sources ? [...this.sources] : [];

    store.clips.value = sources;
    store.maxClips.value = this.maxSources;

    this.renderSupported = await this.askRenderSupported();
    if (this.destroyed) return;

    await Promise.all(sources.map(source => this.media.probe(source)));
    if (this.destroyed) return;

    const manifest = reconcileManifest(
      this.manifest,
      sources.map(source => source.key),
      store.durations.value,
    );
    /*
     * A post that has never been given a frame starts on the host's, not on this package's.
     *
     * Tested on the INCOMING manifest rather than the reconciled one, because reconciling fills the
     * default in: by the time it comes back there is no way to tell a post that asked for 720x1280
     * from one that never said. A post stepped back into keeps the frame it was edited at, which is
     * the whole reason the field is on the manifest.
     */
    const chosen = (this.manifest as { output?: unknown } | undefined)?.output
      ? manifest
      : { ...manifest, output: normaliseOutput(store.host.output.initial) };
    store.load(sources, store.durations.value, chosen);
    this.loading = false;

    // Filmstrips are a nicety that arrives while the customer is already editing, one source at a time.
    for (const source of sources) void this.media.loadFilmstrip(source);
  }

  /** A host that cannot answer is a host that cannot render, and the editor still edits either way. */
  private async askRenderSupported(): Promise<boolean> {
    const render = this.store.host.render;
    if (!render) return false;
    try {
      return await render.isSupported();
    } catch (error) {
      debugWarn('[ve-editor] isSupported failed', error);
      return false;
    }
  }

  /* ========================================================================================= */
  /* The safe area                                                                             */
  /* ========================================================================================= */

  private readonly onWindowResize = (): void => {
    const known = this.insetsByHeight.get(window.innerHeight);
    if (known) this.applyInsets(known);
    void this.measureSystemBars();
    if (this.measureTimer) clearTimeout(this.measureTimer);
    this.measureTimer = setTimeout(() => void this.measureSystemBars(), INSET_SETTLE_MS);
  };

  private async measureSystemBars(): Promise<void> {
    const measure = this.store.host.platform.measureInsets;
    if (!measure) return;
    try {
      const insets = await measure();
      if (this.destroyed) return;
      this.insetsByHeight.set(window.innerHeight, insets);
      this.applyInsets(insets);
    } catch (error) {
      // A host that cannot measure leaves `env()` in place, which is what it is the fallback for.
      debugWarn('[ve-editor] measureInsets failed', error);
    }
  }

  /**
   * Written onto the element rather than held in state, and only once a measurement has arrived, so
   * a host that set either property itself keeps its own value until the device contradicts it. It
   * is also why nothing repaints for this: the two properties are read by CSS in this element and
   * in every component under it, and setting the same value again changes nothing.
   */
  private applyInsets({ top, bottom }: EditorInsets): void {
    this.el.style.setProperty('--ve-safe-top', `${Math.ceil(Math.max(0, top))}px`);
    this.el.style.setProperty('--ve-safe-bottom', `${Math.ceil(Math.max(0, bottom))}px`);
  }

  /* ========================================================================================= */
  /* Transport                                                                                 */
  /* ========================================================================================= */

  private readonly togglePlay = (): void => {
    this.store.togglePlay();
  };

  private readonly toggleFullscreen = (): void => {
    this.store.fullscreen.value = !this.store.fullscreen.value;
    this.store.select(null);
  };

  /*
   * Bound once rather than written inline in the render. The clock beside these two reads the
   * playhead, so this row is rebuilt thirty times a second during playback, and a fresh closure
   * each time would have Stencil remove and re-add both listeners on every one of those frames.
   */
  private readonly onUndo = (): void => {
    this.store.undo();
  };

  private readonly onRedo = (): void => {
    this.store.redo();
  };

  /* ========================================================================================= */
  /* The keyboard                                                                              */
  /* ========================================================================================= */

  /**
   * A desktop's transport. Space plays, the arrows move the playhead (further with Shift, to either
   * end with Home and End), Cmd or Ctrl with Z undoes and adds Shift to redo, and Escape closes
   * whatever is open.
   *
   * Three kinds of keystroke are refused rather than acted on, and each is a real collision rather
   * than caution: one the browser is about to act on itself (Space on a focused button would both
   * press it and toggle playback), one already answered further down the tree (the toolbar's own
   * arrow key navigation, which says so by calling `preventDefault`), and one being typed into a
   * field. Escape is the exception to the last: it is how a customer gets out of the text they are
   * in the middle of, while every other key there belongs to the field.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || this.loading || this.rendering || event.defaultPrevented) return;
    const focus = keyTarget(event);
    if (isTextEntry(focus) && event.key !== 'Escape') return;

    const store = this.store;
    if (event.metaKey || event.ctrlKey) {
      if (event.altKey || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      // Locked while a voiceover take is running. The store refuses both anyway; this is only so
      // the key does nothing rather than appearing to half undo a recording.
      if (store.historyLocked.value) return;
      if (event.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (event.altKey) return;

    switch (event.key) {
      // `Spacebar` is the name an older WebView gives the same key.
      case ' ':
      case 'Spacebar':
        if (isPressable(focus)) return;
        event.preventDefault();
        store.togglePlay();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        this.nudge(event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey ? NUDGE_COARSE_MS : NUDGE_MS);
        return;
      case 'Home':
        event.preventDefault();
        this.seekTo(0);
        return;
      case 'End':
        event.preventDefault();
        this.seekTo(store.totalMs.value);
        return;
      case 'Escape':
        // Peels, exactly as the back button does, but never the last layer: closing what is open is
        // what Escape means everywhere, and throwing away an edit is not.
        if (this.peel()) event.preventDefault();
        return;
      default:
        return;
    }
  };

  private nudge(direction: number, step: number): void {
    this.seekTo(this.store.playheadMs.value + direction * step);
  }

  /** Stops the player first, the way the timeline's own drags do: two things moving the playhead at
   *  once leaves it flickering between them. `seek` clamps to the video at both ends. */
  private seekTo(ms: number): void {
    this.store.pause();
    this.store.seek(ms);
  }

  /* ========================================================================================= */
  /* Leaving                                                                                   */
  /* ========================================================================================= */

  /**
   * Back peels one layer at a time: fullscreen, the text being typed, an open sheet or menu, a
   * selection, a second-level tool row - and only then the editor itself.
   *
   * Synchronous, because that is what a back handler is: the answer is whether the press was
   * consumed, and a host with a back button of its own needs it now rather than a promise later.
   * True for everything the Angular handler swallowed, including the early return, because a press
   * during a render must not take the screen away from under an encode.
   */
  private readonly onBack = (): boolean => {
    if (this.rendering || this.loading) return true;

    if (this.confirm.pending) {
      /*
       * A question is open. If it is ours, back closes it the way a tap outside it would and
       * nothing else. If it is the host's own dialog, this handler is registered ahead of the
       * host's overlay handler and consuming the press here would leave that dialog on the screen
       * with no way out, so the press is handed back.
       */
      if (!this.confirm.showing) return false;
      this.confirm.settle(null);
      return true;
    }

    if (!this.peel()) void this.leave();
    return true;
  };

  /**
   * Closes the outermost thing that is open, and says whether there was one.
   *
   * Split out of [onBack] so that Escape can have the peeling without the leaving: the two presses
   * mean the same thing while anything at all is open, and different things when nothing is.
   */
  private peel(): boolean {
    const store = this.store;
    if (store.fullscreen.value) {
      store.fullscreen.value = false;
    } else if (store.textEdit.value) {
      store.cancelText();
    } else if (store.recordingFromMs.value !== null) {
      // The voiceover sheet owns the microphone; closing it stops the take.
      store.closePanel();
    } else if (store.panel.value) {
      store.closePanel();
    } else if (store.soundMenuOpen.value) {
      store.soundMenuOpen.value = false;
    } else if (store.selection.value) {
      store.select(null);
    } else if (store.toolbarMode.value !== 'root') {
      store.toolbarMode.value = 'root';
    } else {
      return false;
    }
    return true;
  }

  /** Leaving with changes asks first: the sources stay either way, the edits would not. */
  private async leave(): Promise<void> {
    if (this.leaving) return;
    this.store.pause();
    if (this.store.dirty.value) {
      this.leaving = true;
      const role = await this.confirm.ask(DISCARD_EDITS);
      this.leaving = false;
      if (this.destroyed) return;
      if (role !== 'destructive') return;
    }
    this.veCancel.emit('back');
  }

  /* ========================================================================================= */
  /* Next                                                                                      */
  /* ========================================================================================= */

  private readonly onNext = (): void => {
    void this.next();
  };

  private readonly onBackTap = (): void => {
    this.onBack();
  };

  private readonly onQuality = (): void => {
    this.store.openPanel('quality');
  };

  /**
   * Renders the edit and hands the finished video over. A single untouched clip skips the encode
   * entirely and goes up as it is, which is faster and kinder to the picture.
   */
  private async next(): Promise<void> {
    if (this.rendering || this.loading) return;
    const store = this.store;

    if (this.media.busy.value) {
      // A picked clip or track is still being read, and rendering the manifest without it would
      // build the video the customer asked for minus the thing they just chose.
      store.showToast('Still reading what you picked');
      return;
    }
    if (store.recordingFromMs.value !== null) {
      store.showToast('Stop recording first');
      return;
    }
    if (store.textEdit.value) store.finishText();
    store.closePanel();
    store.pause();

    const manifest = store.manifest.value;
    const sources = this.postedSources(manifest);
    const render = store.host.render;

    // A post that is one of its own clips, untouched, is posted as that file: no encode, no quality
    // lost, and the fast path every engine tests for.
    if (isUntouched(manifest, store.durations.value)) {
      this.finish({ sources, manifest });
      return;
    }

    /*
     * A post that is NOT that, on a host that cannot build one. It used to finish here without a
     * word, handing back a manifest and no video - and a host that takes the first clip as the
     * post's own then published one raw clip as though it were the edit. A two layer post went out
     * as whichever clip happened to be first.
     *
     * So it is asked instead. Posting the clips unedited is still on offer, because it is what the
     * customer may well want and what a failed render already offers; what has gone is doing it to
     * them silently.
     */
    if (!render || !this.renderSupported) {
      const role = await this.confirm.ask(RENDER_UNAVAILABLE);
      if (this.destroyed || role !== 'plain') return;
      this.finish({ sources, manifest });
      return;
    }

    this.rendering = true;
    this.renderProgress = 0;
    const abort = new AbortController();
    this.renderAbort = abort;
    try {
      // What makes `EditorRenderHost.render`'s side of the bargain true: every layer has been drawn
      // before the host is asked for a file. In the common case the pass has already run and this
      // resolves in a microtask; the case it is here for is Next tapped in the same turn as a
      // change, where the effect that draws has not had its turn yet.
      await this.bitmaps.ensureFresh();
      const stitched = await render.render({
        manifest,
        sources,
        onProgress: progress => {
          this.renderProgress = progress;
        },
        signal: abort.signal,
      });
      if (this.destroyed) return;
      this.finish({ sources, manifest, stitched });
    } catch (error) {
      if (this.destroyed) return;
      debugWarn('[ve-editor] render failed', error);
      this.rendering = false;
      await this.onRenderFailed(error);
    }
  }

  private async onRenderFailed(error: unknown): Promise<void> {
    const code = error instanceof RenderFailedError ? error.code : 'unknown';
    const role = await this.confirm.ask(renderFailed(code));
    if (this.destroyed) return;

    if (role === 'retry') {
      await this.next();
    } else if (role === 'plain') {
      const manifest = this.store.manifest.value;
      this.finish({ sources: this.postedSources(manifest), manifest });
    }
    // Dismissed is the third answer: stay in the editor with the edit exactly as it was.
  }

  private finish(result: VideoEditorResult): void {
    this.rendering = false;
    this.release(result.sources);
    this.veDone.emit(result);
  }

  /**
   * Gives the host back what the edit stopped using, now that the edit is settled.
   *
   * A source whose every segment was deleted, and the one a Replace pointed away from, stay in the
   * store so an undo can bring them back - but they are not on the post, they are not in the result,
   * and nothing after this can reach them. Both lists go over because only the host knows what a
   * file costs and that two keys can share one: in choisy the same gallery video picked twice is two
   * keys and ONE path, and unlinking a path a kept source still reads is the failure this call was
   * written against.
   */
  private release(kept: readonly EditorSource[]): void {
    const media = this.store.host.media;
    if (!media.release) return;
    const keptKeys = new Set(kept.map(source => source.key));
    const dropped = this.store.clips.value.filter(source => !keptKeys.has(source.key));
    media.release({ kept, dropped });
  }

  /**
   * Each source the edit still uses, once, in the order it first appears. A split or a duplicate
   * puts one source on the timeline twice but the post uploads its original once, and a source whose
   * every segment was deleted is not posted at all.
   */
  private postedSources(manifest: EditManifest): EditorSource[] {
    return uniqueClipKeys(manifest)
      .map(key => this.store.clipByKey(key))
      .filter((source): source is EditorSource => !!source);
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  render() {
    return this.watcher.run(() => {
      const ctx = this.ctx;
      const store = ctx.store;
      const panel = store.panel.value;
      const layout = shellLayout(panel);
      const fullscreen = store.fullscreen.value;
      const asking = this.confirm.showing;

      return (
        <Host>
          <div
            class={{
              've': true,
              've--compact': layout === 'compact',
              've--tall': layout === 'tall',
              've--fullscreen': fullscreen,
            }}
          >
            {this.loading
              ? this.renderLoading()
              : [
                  this.renderStage(ctx, layout, fullscreen),
                  layout === 'tall' ? null : this.renderTransport(ctx, fullscreen),
                  !fullscreen && layout !== 'tall' ? (
                    <ve-timeline key="timeline" class="ve__timeline" ctx={ctx} compact={layout === 'compact'} />
                  ) : null,
                  fullscreen ? null : this.renderTools(ctx, panel),
                ]}

            {this.rendering ? this.renderProgressCard() : null}
          </div>

          {/*
           * Outside the column and last in paint order, which is where `ve-alert` expects to be put:
           * it covers the whole editor with `position: fixed`, and nothing above it here carries a
           * transform that would make itself the containing block instead.
           */}
          {asking ? (
            <ve-alert
              header={asking.header}
              message={asking.message}
              buttons={asking.buttons}
              onVeDismiss={event => this.confirm.settle(event.detail)}
            />
          ) : null}
        </Host>
      );
    });
  }

  private renderLoading() {
    return (
      <div class="ve__loading" key="loading">
        <ve-spinner label="Opening your clips" />
      </div>
    );
  }

  private renderStage(ctx: EditorContext, layout: 'main' | 'compact' | 'tall', fullscreen: boolean) {
    const chromeShowing = !fullscreen && layout !== 'tall';
    const output = ctx.store.output.value;
    return (
      /*
        The frame's own two numbers, for the rules that place the round buttons just outside it.
        They used to be written into the stylesheet as `9 / 16`, which put both circles over the
        picture the moment a customer turned the canvas on its side.
      */
      <div
        class="ve__stage"
        key="stage"
        style={{ '--ve-frame-w-px': String(output.width), '--ve-frame-h-px': String(output.height) }}
      >
        {/*
         * Keyed, like everything else in this column. The preview's player reads its media elements
         * once and never again, so a `<ve-preview>` the vdom matched to a different position and
         * re-created would leave the transport driving elements that are no longer on the screen:
         * the picture freezes on its last frame and nothing throws.
         */}
        <ve-preview key="preview" class="ve__preview" ctx={ctx} />

        {chromeShowing ? (
          <button
            key="back"
            type="button"
            class="ve__round ve__round--back"
            aria-label="Back"
            onClick={this.onBackTap}
          >
            <ve-icon name="chevron-back" />
          </button>
        ) : null}
        {/*
          The finished post's shape and size, where a customer looks for it: on the canvas, beside
          the button that takes them out of the editor with it. It reads as a statement of what they
          are about to make - `1080P` - and opens the sheet that changes it.

          Not a tile in the tool row. It was one, and it was the eleventh of thirteen in a row that
          scrolls: a decision about the whole post sat off the right-hand edge behind Adjust, which
          is not where anybody would think to look for it.
        */}
        {chromeShowing ? (
          <button key="quality" type="button" class="ve__quality" onClick={this.onQuality}>
            <span>{qualityOf(ctx.store.output.value).label}</span>
            <ve-icon name="chevron-down" />
          </button>
        ) : null}
        {chromeShowing ? (
          <button
            key="next"
            type="button"
            class="ve__round ve__round--next"
            aria-label="Next"
            disabled={this.rendering || ctx.media.busy.value}
            onClick={this.onNext}
          >
            <ve-icon name="arrow-forward" />
          </button>
        ) : null}

        {/* Unconditional: the pill comes and goes inside it, and the live region has to be here
            before the message is, or a screen reader has nothing it was already watching. */}
        <ve-toast key="toast" ctx={ctx} />
      </div>
    );
  }

  private renderTransport(ctx: EditorContext, fullscreen: boolean) {
    const store = ctx.store;
    const playing = store.playing.value;
    return (
      <div class="ve__transport" key="transport">
        {/* The playhead is read here and nowhere else in this component, so playback repaints the
            shell's own thirty vnodes a second and no child: every prop below is unchanged, and an
            unchanged prop is not written. */}
        <span class="ve__clock">
          <span class="ve__clock-now">{formatClock(store.playheadMs.value)}</span>
          <span class="ve__clock-total">/{formatClock(store.totalMs.value)}</span>
        </span>

        <button type="button" class="ve__play" aria-label={playing ? 'Pause' : 'Play'} onClick={this.togglePlay}>
          <ve-icon name={playing ? 'pause' : 'play'} />
        </button>

        <span class="ve__transport-end">
          {fullscreen ? null : (
            <button
              key="undo"
              type="button"
              class="ve__icon"
              aria-label="Undo"
              disabled={!store.canUndo.value || store.historyLocked.value}
              onClick={this.onUndo}
            >
              <ve-icon name="arrow-undo-outline" />
            </button>
          )}
          {fullscreen ? null : (
            <button
              key="redo"
              type="button"
              class="ve__icon"
              aria-label="Redo"
              disabled={!store.canRedo.value || store.historyLocked.value}
              onClick={this.onRedo}
            >
              <ve-icon name="arrow-redo-outline" />
            </button>
          )}
          <button
            key="fullscreen"
            type="button"
            class="ve__icon"
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={this.toggleFullscreen}
          >
            <ve-icon name={fullscreen ? 'contract-outline' : 'expand-outline'} />
          </button>
        </span>
      </div>
    );
  }

  /**
   * The open sheet, or the toolbar when nothing is open.
   *
   * Fourteen literal tags rather than a lookup, and this is the one place in the package where that
   * matters: under `dist-custom-elements` a component's generated `defineCustomElement` also defines
   * every tag it renders, transitively, and the compiler finds those tags by collecting the string
   * literals passed to `h()`. A tag produced through a variable is invisible to that analysis, so a
   * host would define `ve-editor`, get most of the tags, and find that one sheet opens as an unknown
   * element - which lays out as nothing and throws nothing. [PANEL_LAYOUT] is what keeps the list
   * exhaustive; this switch is what makes the elements.
   */
  private renderTools(ctx: EditorContext, panel: EditorPanel | null) {
    switch (panel) {
      case 'text':
        return <ve-text-sheet key="text" class="ve__sheet ve__sheet--text" ctx={ctx} />;
      case 'stickers':
        return <ve-sticker-sheet key="stickers" class="ve__sheet ve__sheet--tall" ctx={ctx} />;
      case 'effects':
        return <ve-effects-sheet key="effects" class="ve__sheet ve__sheet--grid" ctx={ctx} />;
      case 'filters':
        return <ve-filter-sheet key="filters" class="ve__sheet" ctx={ctx} />;
      case 'adjust':
        return <ve-adjust-sheet key="adjust" class="ve__sheet" ctx={ctx} />;
      case 'crop':
        return <ve-crop-sheet key="crop" class="ve__sheet" ctx={ctx} />;
      case 'layout':
        return <ve-layout-sheet key="layout" class="ve__sheet" ctx={ctx} />;
      case 'quality':
        return <ve-quality-sheet key="quality" class="ve__sheet" ctx={ctx} />;
      case 'speed':
        return <ve-speed-sheet key="speed" class="ve__sheet" ctx={ctx} />;
      case 'volume':
        return <ve-volume-sheet key="volume" class="ve__sheet" ctx={ctx} />;
      case 'opacity':
        return <ve-opacity-sheet key="opacity" class="ve__sheet" ctx={ctx} />;
      case 'voiceover':
        // Its position must not move while a take is running: this element stops the recorder when
        // it leaves the document, and the vdom moving it would end the take with no press.
        return <ve-voiceover-sheet key="voiceover" class="ve__sheet" ctx={ctx} />;
      case 'sound':
        return <ve-sound-sheet key="sound" class="ve__sheet ve__sheet--tall" ctx={ctx} />;
      default:
        return <ve-toolbar key="toolbar" class="ve__toolbar" ctx={ctx} />;
    }
  }

  private renderProgressCard() {
    const progress = this.renderProgress;
    return (
      <div class="ve__render" key="render">
        <div class="ve__render-card">
          <p class="ve__render-title">Preparing your video</p>
          {/* Indeterminate until the first figure arrives: a host that reports nothing until the
              encode is half done would otherwise show an empty bar that looks stuck. */}
          <ve-progress
            value={progress}
            type={progress > 0 ? 'determinate' : 'indeterminate'}
            label="Preparing your video"
          />
          <p class="ve__render-pct">{(progress * 100).toFixed(0)}%</p>
          <p class="ve__render-hint">This happens on your phone, so it keeps going if you leave the app.</p>
        </div>
      </div>
    );
  }
}

/**
 * What the keystroke was actually aimed at.
 *
 * `event.target` is no use from a window listener: every key pressed anywhere inside the editor is
 * retargeted to `ve-editor` itself on its way out of the shadow tree, so the answer would be the
 * same element for the sticker search field as for nothing at all. The composed path is the tree
 * before that retargeting.
 */
function keyTarget(event: KeyboardEvent): HTMLElement | null {
  const first = event.composedPath()[0] ?? event.target;
  return first instanceof HTMLElement ? first : null;
}

/** Something the keystroke is being typed into, where every key but Escape belongs to the field. */
function isTextEntry(el: HTMLElement | null): boolean {
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Something Space will press on its own. A click leaves the focus on the button it pressed, so
 * without this the first Space after using any tool would both run that tool again and start
 * playback.
 */
function isPressable(el: HTMLElement | null): boolean {
  return !!el && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button');
}
