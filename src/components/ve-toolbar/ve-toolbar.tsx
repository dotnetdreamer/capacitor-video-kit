import { computed } from '@preact/signals-core';
import { Component, Element, Host, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { MAX_LAYERS } from '../../editor';
import type { EditorIconName } from '../../icons/icons';
import type { EditorPanel } from '../../state/editor.types';

/** Which set of tools the bottom row is showing. */
export type ToolbarRowKind = 'root' | 'text' | 'clip' | 'layer' | 'zoom' | 'music' | 'voice';

/** One tile in the row. Built fresh whenever what the row depends on changes. */
export interface ToolTile {
  /** Unique within its row, and the key the vdom keeps the button by. */
  id: string;
  label: string;
  icon: EditorIconName;
  run: () => void;
  /** Not built yet: wears a "SOON" badge, and a tap says so instead of doing anything. */
  soon?: boolean;
  /**
   * Shown at 40% because the tool cannot do anything right now (the last clip cannot be deleted,
   * the top layer cannot come forward). A tap still runs `run`, which explains why - a dimmed tile
   * that silently ignores the finger reads as a broken one. That is also why this is never the
   * `disabled` attribute: a disabled button takes no click at all and answers nothing.
   */
  disabled?: boolean;
  /** Looks held down while the thing it opened is open (the Sound menu). */
  pressed?: boolean;
  /** For an on/off tool (Loop): its state. Undefined for tools that are not toggles. */
  toggled?: boolean;
  /** For a tool that opens a menu: whether the menu is open. Undefined for every other tool. */
  expanded?: boolean;
}

export interface ToolRow {
  kind: ToolbarRowKind;
  /** The toolbar's accessible name for this row. */
  label: string;
  /** The chevron at the far left that goes back one level, when there is a level to go back to. */
  collapse: { ariaLabel: string; run: () => void } | null;
  tiles: ToolTile[];
}

type LayerPlace = 'only' | 'top' | 'bottom' | 'middle';

/** Named because closing the Sound menu puts the focus back on the tile that opened it. */
const SOUND_TILE = 'sound';

/** How close the Sound menu may come to either side of the toolbar, which is also where it opens
 *  when the tile cannot be measured. It matches the tool row's own edge padding, `--tb-edge`. */
const MENU_EDGE_PX = 10;

/**
 * The bottom tool row, in LightCut's compact shape: small icons over short labels that scroll
 * sideways, and that turn into the tools for whatever is selected - a clip, a layer, the music, a
 * voiceover - with a chevron at the far left to step back out. It is short so the timeline above it
 * can have the height for its layers.
 *
 * The toolbar decides nothing itself. Every tile calls a store action (or the media layer for the
 * ones that open a picker), so a tool behaves the same here as from the timeline or the preview, and
 * every change it makes is a single undo step because the store's action is.
 *
 * What the row shows is derived from a handful of small computed signals (the row kind, the layer's
 * place in the drawing order, whether music loops...) rather than from the selected objects
 * themselves. `SignalWatcher` subscribes the component to exactly what the last paint read, and a
 * drag on the preview replaces the selected layer's object on every frame: a render reading
 * `manifest.value` would therefore rebuild and repaint the whole row sixty times a second, on the
 * phone that needs those frames for the drag. A computed only wakes its readers when its own value
 * changes, so a boolean or a short string in front of the manifest is what keeps the row still.
 */
@Component({
  tag: 've-toolbar',
  styleUrl: 've-toolbar.css',
  shadow: true,
})
export class VeToolbar {
  @Element() el!: HTMLElement;

  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  private scrollerEl?: HTMLElement;

  /** Watches the scroller's width for `updateEdges`, and goes with it. */
  private edgeWatch?: ResizeObserver;

  /** The row the scroller was last put back to the start for. */
  private scrolledFor = '';

  /** Set when the menu was opened from the keyboard, and answered by the next render. */
  private focusMenu = false;

  /* -- what the row depends on, each reduced to a value that only changes when the row must ---- */

  private readonly clipSelected = computed(() => !!this.ctx.store.selectedClip.value);
  private readonly layerKind = computed(() => this.ctx.store.selectedOverlay.value?.kind ?? null);
  private readonly voiceSelected = computed(() => !!this.ctx.store.selectedVoice.value);
  /**
   * A boolean, never the zoom itself: dragging the zoom's box on the preview rewrites the zoom on
   * every frame, and a row that read the object would be rebuilt sixty times a second for it.
   */
  private readonly zoomSelected = computed(() => !!this.ctx.store.selectedZoom.value);
  private readonly lastClip = computed(() => this.ctx.store.manifest.value.clips.length <= 1);
  /** The SELECTED segment's fit, or the post's when nothing is selected - what a tap will change. */
  private readonly fitContain = computed(() => this.ctx.store.clipFit(this.ctx.store.selectedClip.value) === 'contain');
  private readonly musicLoops = computed(() => !!this.ctx.store.manifest.value.music?.loop);

  /** Where the selected layer sits in the drawing order, which is what the four move tools need. */
  private readonly layerPlace = computed<LayerPlace | null>(() => {
    const sel = this.ctx.store.selection.value;
    if (sel?.kind !== 'overlay') return null;
    const overlays = this.ctx.store.manifest.value.overlays;
    const index = overlays.findIndex(overlay => overlay.id === sel.id);
    if (index < 0) return null;
    if (overlays.length === 1) return 'only';
    if (index === overlays.length - 1) return 'top';
    return index === 0 ? 'bottom' : 'middle';
  });

  private readonly rowKind = computed<ToolbarRowKind>(() => {
    if (this.clipSelected.value) return 'clip';
    if (this.layerKind.value) return 'layer';
    if (this.zoomSelected.value) return 'zoom';
    if (this.ctx.store.musicSelected.value) return 'music';
    if (this.voiceSelected.value) return 'voice';
    return this.ctx.store.toolbarMode.value === 'text' ? 'text' : 'root';
  });

  disconnectedCallback() {
    this.watcher.stop();
    this.keepScroller(undefined);
  }

  /**
   * Both of the things the Angular component used a render hook for, and neither of them is work
   * the render can do: one reads the scroller's own scroll position back and the other moves the
   * focus, which the vdom knows nothing about.
   */
  componentDidRender() {
    this.resetScroll();
    this.updateEdges();
    this.anchorSoundMenu();
    this.focusFirstMenuItem();
  }

  /**
   * A new set of tools starts at its first tile, as TikTok's does: a row left scrolled to where the
   * previous one was would open on tools from the middle of the list.
   *
   * Keyed on the row (and the layer kind, whose rows differ) rather than on the selection, so
   * tapping Duplicate - which selects the copy - does not throw the row back while the customer is
   * still using it. Without that signature this runs on every repaint instead, and the row would
   * jump back to the start each time a tile changed its own label.
   *
   * It lands a paint after the row it belongs to, because Stencil holds `componentDidRender` back
   * until the child elements that render created have loaded, and a new row is a row of new tiles
   * with new icons in them. Nothing turns on the gap, but a test that scrolls the row the moment
   * its new tiles appear is racing it.
   */
  private resetScroll(): void {
    const signature = `${this.rowKind.value}|${this.layerKind.value}`;
    if (signature === this.scrolledFor) return;
    this.scrolledFor = signature;
    const el = this.scrollerEl;
    if (el && el.scrollLeft !== 0) el.scrollLeft = 0;
  }

  /**
   * Puts the Sound menu under the Sound tile.
   *
   * The menu is positioned against this host, and the tile is not: the row centres itself while it
   * fits and scrolls sideways when it does not, so on anything wider than a phone the tile is
   * hundreds of pixels from the host's left edge - which is where the menu used to open, with the
   * button that opened it nowhere near it.
   *
   * A measurement rather than a CSS rule because no rule can see a scroll position. It runs on every
   * render, which is what keeps the menu under the tile while the row is scrolled under it, and it
   * writes nothing at all while the menu is closed, so the usual repaint costs one `if`.
   */
  private anchorSoundMenu(): void {
    if (!this.ctx.store.soundMenuOpen.value) return;
    const root = this.el.shadowRoot;
    const tile = root?.querySelector<HTMLElement>(`[data-tile="${SOUND_TILE}"]`);
    const menu = root?.querySelector<HTMLElement>('.tb__menu');
    if (!tile || !menu) return;
    // Left edges, both in this host's own coordinates, then held inside it so that a tile at the
    // right hand end of a scrolled row does not hang the menu off the side of the editor.
    const hostLeft = this.el.getBoundingClientRect().left;
    const x = tile.getBoundingClientRect().left - hostLeft;
    const max = this.el.clientWidth - menu.offsetWidth - MENU_EDGE_PX;
    this.el.style.setProperty('--tb-menu-x', `${Math.round(Math.min(Math.max(MENU_EDGE_PX, x), Math.max(MENU_EDGE_PX, max)))}px`);
  }

  private focusFirstMenuItem(): void {
    if (!this.focusMenu) return;
    this.focusMenu = false;
    this.el.shadowRoot?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value to
   * the vdom, so the listener would be taken off and put back on with every repaint and the ref
   * would run again as well.
   */
  private readonly keepScroller = (el?: HTMLElement) => {
    if (this.scrollerEl === el) return;
    this.scrollerEl?.removeEventListener('wheel', this.onWheel);
    this.scrollerEl?.removeEventListener('scroll', this.updateEdges);
    this.edgeWatch?.disconnect();
    this.edgeWatch = undefined;
    this.scrollerEl = el;
    if (!el) return;
    // Not passive: the whole point is to take the wheel away from the page, and a passive listener
    // may not. Attached by hand rather than through the vdom for that reason alone.
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('scroll', this.updateEdges, { passive: true });
    // A new row repaints, and `componentDidRender` answers that; a screen turned on its side does
    // not, and only this sees the row's width change.
    this.edgeWatch = new ResizeObserver(this.updateEdges);
    this.edgeWatch.observe(el);
  };

  /**
   * Marks which ends of the row have tools past them, for the stylesheet to fade.
   *
   * The tiles have no plate, so a row cut off between two of them shows nothing at the edge of the
   * screen, and the tools past it look as if they are not there: on a 360px phone the root row ended
   * cleanly after Effects with six more to come. Straight on the element rather than through the
   * render, because it follows a scroll and the row does not need repainting for it; the vdom only
   * ever adds and removes the classes it wrote itself, so it leaves these two alone.
   */
  private readonly updateEdges = () => {
    const el = this.scrollerEl;
    const track = el?.firstElementChild;
    if (!el || !track) return;
    // The tools themselves against the edges, not the scroll against its ends: the track has padding
    // at either end, and a row resting inside it has nothing past it, yet is not at its end.
    const box = el.getBoundingClientRect();
    const first = track.firstElementChild?.getBoundingClientRect();
    const last = track.lastElementChild?.getBoundingClientRect();
    el.classList.toggle('tb__scroller--before', !!first && first.left < box.left - 1);
    el.classList.toggle('tb__scroller--after', !!last && last.right > box.right + 1);
  };

  /**
   * A mouse wheel over the tool row, which only scrolls sideways.
   *
   * A wheel sends `deltaY`, a row like this scrolls in x, and no browser turns one into the other
   * on its own - so on a desktop the last few tools were simply unreachable: the scrollbar is
   * hidden by design, there is no touch to flick with, and shift+wheel is not something anybody
   * should have to know. A trackpad's sideways gesture already arrives as `deltaX` and is left
   * alone.
   *
   * The wheel goes back to the page at either end rather than being swallowed, so a scroll that
   * began on the toolbar and ran out of row does what the customer meant instead of stopping dead.
   */
  private readonly onWheel = (event: WheelEvent) => {
    const el = this.scrollerEl;
    if (!el || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const room = el.scrollWidth - el.clientWidth;
    if (room <= 0) return;
    // Firefox reports lines and a page wheel reports pages; both have to become pixels first.
    const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1;
    const next = Math.max(0, Math.min(room, el.scrollLeft + event.deltaY * step));
    if (next === el.scrollLeft) return;
    el.scrollLeft = next;
    event.preventDefault();
  };

  /* ========================================================================================= */
  /* Taps                                                                                      */
  /* ========================================================================================= */

  /** The one entry point for a tile, or Magic and Captions ship as buttons that do nothing. */
  private tap(tile: ToolTile): void {
    if (tile.soon) {
      this.ctx.store.showToast(`${tile.label} is coming soon`);
      this.ctx.store.haptic('light');
      return;
    }
    tile.run();
  }

  /**
   * Opened from the keyboard, the menu takes focus so the arrow keys reach it. A finger's tap
   * leaves the focused tile without `:focus-visible`, and then nothing moves.
   */
  private toggleSoundMenu(): void {
    const opening = !this.ctx.store.soundMenuOpen.value;
    const fromKeyboard = this.focusIsVisible();
    this.ctx.store.soundMenuOpen.value = opening;
    // Answered by componentDidRender, because the menu is not in the DOM until the repaint this
    // write asks for has happened. Angular's afterNextRender said the same thing.
    this.focusMenu = opening && fromKeyboard;
  }

  private readonly closeSoundMenu = (returnFocus = false) => {
    this.ctx.store.soundMenuOpen.value = false;
    if (!returnFocus) return;
    this.el.shadowRoot?.querySelector<HTMLButtonElement>(`[data-tile="${SOUND_TILE}"]`)?.focus();
  };

  private readonly addSound = () => {
    this.closeSoundMenu();
    this.ctx.media.openSound();
  };

  private readonly soundEffect = () => {
    this.closeSoundMenu();
    this.ctx.store.showToast('Sound effect is coming soon');
    this.ctx.store.haptic('light');
  };

  private readonly voiceover = () => {
    // Opening a panel closes the menu as well.
    this.ctx.store.openPanel('voiceover');
  };

  /**
   * Whether focus arrived from a keyboard. The question is asked of this component's own shadow
   * root, because `document.activeElement` names the outermost host once focus is inside one and
   * would answer about `<ve-editor>` instead. A WebView too old for `:focus-visible` throws on it.
   */
  private focusIsVisible(): boolean {
    try {
      return !!this.el.shadowRoot?.activeElement?.matches(':focus-visible');
    } catch {
      return false;
    }
  }

  /**
   * The arrow keys walk along the row as they do in any ARIA toolbar, bringing the focused tile into
   * view - most of a sideways-scrolling row is off screen.
   */
  private readonly onKeydown = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const root = this.el.shadowRoot;
    if (!root) return;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.tile'));
    const index = buttons.indexOf(root.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const last = buttons.length - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowLeft' ? Math.max(0, index - 1) : Math.min(last, index + 1);
    buttons[next].focus();
    buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  private readonly onMenuKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeSoundMenu(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const menu = event.currentTarget as HTMLElement;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = items.indexOf(this.el.shadowRoot?.activeElement as HTMLButtonElement);
    event.preventDefault();
    const down = event.key === 'ArrowDown';
    const next = index < 0 ? (down ? 0 : items.length - 1) : (index + (down ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  /* ========================================================================================= */
  /* Rows                                                                                      */
  /* ========================================================================================= */

  private row(): ToolRow {
    switch (this.rowKind.value) {
      case 'root':
        return this.rootRow();
      case 'text':
        return this.textRow();
      case 'clip':
        return this.clipRow();
      case 'layer':
        return this.layerRow();
      case 'zoom':
        return this.zoomRow();
      case 'music':
        return this.musicRow();
      case 'voice':
        return this.voiceRow();
    }
  }

  private rootRow(): ToolRow {
    const store = this.ctx.store;
    const full = store.layersFull.value;
    const soundOpen = store.soundMenuOpen.value;
    return {
      kind: 'root',
      label: 'Editing tools',
      collapse: null,
      tiles: [
        { id: 'edit', label: 'Edit', icon: 'cut-outline', run: () => store.selectClipAtPlayhead() },
        // Crop is the one tool a customer hunts for by name, so it is on the root row as well as on
        // the clip row. It selects the segment under the playhead itself, exactly as Edit does.
        { id: 'crop', label: 'Crop', icon: 'crop-outline', run: () => store.openCrop() },
        // Beside Crop, the other tool about framing. It adds a zoom at the playhead and opens its
        // sheet; the store says so when there is no room for one, or when the post is at its cap.
        { id: 'zoom', label: 'Zoom', icon: 'search-outline', run: () => store.addZoomAtPlayhead() },
        {
          id: 'layout',
          label: 'Layout',
          icon: 'grid-outline',
          // The second video takes a clip slot like any other source, so a post already at its
          // limit has no room for one. There is nothing to lay out either, so the tile is dimmed
          // and says so on a tap rather than disappearing from a row people learn by position.
          disabled: !store.videoTrack.value && !store.canAddClip.value,
          run: () => void this.openLayout(),
        },
        {
          id: SOUND_TILE,
          label: 'Sound',
          icon: 'musical-note-outline',
          pressed: soundOpen,
          expanded: soundOpen,
          run: () => this.toggleSoundMenu(),
        },
        { id: 'text', label: 'Text', icon: 'text-outline', run: () => (store.toolbarMode.value = 'text') },
        {
          id: 'effects',
          label: 'Effects',
          icon: 'sparkles-outline',
          disabled: full,
          run: () => this.openLayerPanel('effects'),
        },
        {
          id: 'overlay',
          label: 'Overlay',
          icon: 'copy-outline',
          disabled: full,
          // The media layer checks the layer cap before the picker opens and says why.
          run: () => void this.ctx.media.pickPhoto(),
        },
        {
          id: 'stickers',
          label: 'Stickers',
          icon: 'happy-outline',
          disabled: full,
          run: () => this.openLayerPanel('stickers'),
        },
        { id: 'filters', label: 'Filters', icon: 'color-filter-outline', run: () => store.openPanel('filters') },
        { id: 'adjust', label: 'Adjust', icon: 'options-outline', run: () => store.openPanel('adjust') },
        this.soonTile('magic', 'Magic', 'color-wand-outline'),
        this.soonTile('captions', 'Captions', 'chatbox-ellipses-outline'),
      ],
    };
  }

  private textRow(): ToolRow {
    const store = this.ctx.store;
    return {
      kind: 'text',
      label: 'Text tools',
      collapse: { ariaLabel: 'Back to all tools', run: () => (store.toolbarMode.value = 'root') },
      tiles: [
        {
          id: 'add-text',
          label: 'Add text',
          icon: 'text-outline',
          disabled: store.layersFull.value,
          // startNewText explains the layer cap itself.
          run: () => store.startNewText(),
        },
        this.soonTile('captions', 'Captions', 'chatbox-ellipses-outline'),
      ],
    };
  }

  private clipRow(): ToolRow {
    const store = this.ctx.store;
    const trackId = store.selectedClipTrackId.value;
    if (trackId) return this.trackClipRow(trackId);
    // A picture has no speed and no sound, so its row has neither tool rather than two that do
    // nothing. Taken away rather than dimmed: a dimmed tile says "not now", and for a still it is
    // never.
    const picture = store.selectedIsPicture.value;
    const tiles: ToolTile[] = [
      // Labelled Cut: the tool cuts the segment in two at the playhead. `split` stays its id.
      { id: 'split', label: 'Cut', icon: 'cut-outline', run: () => store.splitAtPlayhead() },
      ...(picture ? [] : [this.speedTile()]),
      {
        id: 'transition',
        label: 'Transition',
        icon: 'transition-outline',
        // One clip has no cut to put a transition on. Dimmed rather than taken away, and a tap says
        // what is missing - the same as Delete on the last clip.
        disabled: this.lastClip.value,
        run: () => this.openTransition(),
      },
      ...(picture ? [] : [this.volumeTile()]),
      {
        id: 'delete',
        label: 'Delete',
        icon: 'trash-outline',
        // The store says "a video needs at least one clip" when this is the last one.
        disabled: this.lastClip.value,
        run: () => store.deleteSelectedClip(),
      },
      { id: 'duplicate', label: 'Duplicate', icon: 'duplicate-outline', run: () => store.duplicateSelectedClip() },
      {
        id: 'replace',
        label: 'Replace',
        icon: 'swap-horizontal-outline',
        run: () => void this.ctx.media.replaceSelectedClip(),
      },
    ];
    if (store.canJoinSelected.value) {
      tiles.push({ id: 'join', label: 'Join', icon: 'link-outline', run: () => store.joinSelectedWithNext() });
    }
    // The label is what a tap will do: a fitted video offers to fill the frame, and back. Its icon
    // is not the crop one any more - Crop is its own tool on this row now, and two tiles side by
    // side wearing the same picture is a tile nobody taps on purpose.
    const contain = this.fitContain.value;
    tiles.push(
      { id: 'crop', label: 'Crop', icon: 'crop-outline', run: () => store.openCrop() },
      {
        id: 'fit',
        label: contain ? 'Fill' : 'Fit',
        icon: contain ? 'expand-outline' : 'scan-outline',
        run: () => store.toggleFit(),
      },
      { id: 'filters', label: 'Filters', icon: 'color-filter-outline', run: () => store.openPanel('filters') },
      { id: 'adjust', label: 'Adjust', icon: 'options-outline', run: () => store.openPanel('adjust') },
    );
    return { kind: 'clip', label: 'Clip tools', collapse: this.deselect('Close clip tools'), tiles };
  }

  /** The selected segment's speed sheet. On both clip rows, and on neither for a picture. */
  private speedTile(): ToolTile {
    const store = this.ctx.store;
    return { id: 'speed', label: 'Speed', icon: 'speedometer-outline', run: () => store.openPanel('speed') };
  }

  /** The selected segment's own volume. On both clip rows, and on neither for a picture. */
  private volumeTile(): ToolTile {
    const store = this.ctx.store;
    return {
      id: 'volume',
      label: 'Volume',
      icon: 'volume-high-outline',
      run: () => {
        const clip = store.selectedClip.value;
        if (clip) store.openVolume({ kind: 'clip', id: clip.id });
      },
    };
  }

  /**
   * The Transition tile: the transition sheet on the cut INTO the selected segment, which is the
   * dot at its left edge - or, for the first segment, which has no cut in front of it, the one at
   * its right edge. The same sheet the dot opens, and it deselects the segment on the way, because
   * the sheet is about a cut and not a clip.
   */
  private openTransition(): void {
    const store = this.ctx.store;
    const clip = store.selectedClip.value;
    const slots = store.slots.value;
    if (!clip) return;
    if (slots.length < 2) {
      store.showToast('Add another clip to use a transition');
      store.haptic('light');
      return;
    }
    const index = slots.findIndex(slot => slot.clip.id === clip.id);
    if (index < 0) return;
    store.openTransition(slots[Math.max(1, index)].clip.id);
  }

  /**
   * The tools for a segment on the SECOND video layer, which is a shorter row on purpose: split,
   * join, duplicate and reorder all rearrange the base track's `clips`, and this stage keeps the
   * extra layer one clip that the customer places rather than a timeline of its own. Where it sits
   * on the frame is Layout's business, and where it starts is Start here's.
   */
  private trackClipRow(trackId: string): ToolRow {
    const store = this.ctx.store;
    const picture = store.selectedIsPicture.value;
    return {
      kind: 'clip',
      label: 'Video layer tools',
      collapse: this.deselect('Close video layer tools'),
      tiles: [
        { id: 'layout', label: 'Layout', icon: 'grid-outline', run: () => store.openPanel('layout') },
        { id: 'crop', label: 'Crop', icon: 'crop-outline', run: () => store.openCrop() },
        // Fill or fit, on the layer row as well as the base one. A layer whose rectangle is not its
        // source's shape is drawn `contain` inside it, and until this tile existed there was no way
        // to say otherwise about a layer: the base row had the toggle and this row did not, so the
        // one segment somebody is most likely to want filling - the one sitting ON another picture -
        // was the one segment that could not be told to. `toggleFit` reads and writes the SELECTED
        // segment's own fit, which is this one.
        {
          id: 'fit',
          label: this.fitContain.value ? 'Fill' : 'Fit',
          icon: this.fitContain.value ? 'expand-outline' : 'scan-outline',
          run: () => store.toggleFit(),
        },
        // Neither for a picture, as on the base row.
        ...(picture ? [] : [this.speedTile(), this.volumeTile()]),
        {
          id: 'start-here',
          label: 'Start here',
          icon: 'play-skip-back-outline',
          run: () => store.setTrackStart(trackId, store.playheadMs.value),
        },
        {
          id: 'replace',
          label: 'Replace',
          icon: 'swap-horizontal-outline',
          run: () => void this.ctx.media.replaceSelectedClip(),
        },
        // The segment, not the whole layer: a layer can hold a sequence of them now. The store takes
        // the layer off when this was its last one, which is where the arrangement is undone too.
        { id: 'delete', label: 'Remove', icon: 'trash-outline', run: () => store.deleteSelectedClip() },
      ],
    };
  }

  private layerRow(): ToolRow {
    const store = this.ctx.store;
    const kind = this.layerKind.value;
    const place = this.layerPlace.value;
    const atTop = place === 'top' || place === 'only';
    const atBottom = place === 'bottom' || place === 'only';
    const isEffect = kind === 'effect';

    const tiles: ToolTile[] = [];
    if (kind === 'text') {
      tiles.push({
        id: 'edit-text',
        label: 'Edit',
        icon: 'create-outline',
        run: () => {
          const overlay = store.selectedOverlay.value;
          if (overlay) store.startEditText(overlay.id);
        },
      });
    }
    if (isEffect) {
      tiles.push({
        id: 'replace',
        label: 'Replace',
        icon: 'swap-horizontal-outline',
        run: () => store.openPanel('effects'),
      });
    }
    // The move tools call the store even when they are dimmed: it answers "Already on top".
    tiles.push(
      {
        id: 'split',
        label: 'Cut',
        icon: 'cut-outline',
        // A cut adds a layer, so like Duplicate it cannot at the cap; the store says why.
        disabled: store.layersFull.value,
        run: () => store.splitSelectedOverlayAtPlayhead(),
      },
      {
        id: 'duplicate',
        label: 'Duplicate',
        icon: 'duplicate-outline',
        disabled: store.layersFull.value,
        run: () => store.duplicateSelectedOverlay(),
      },
      {
        id: 'opacity',
        label: isEffect ? 'Strength' : 'Opacity',
        icon: 'contrast-outline',
        run: () => store.openPanel('opacity'),
      },
      {
        id: 'forward',
        label: 'Forward',
        icon: 'arrow-up-outline',
        disabled: atTop,
        run: () => store.moveSelectedLayer('forward'),
      },
      {
        id: 'backward',
        label: 'Backward',
        icon: 'arrow-down-outline',
        disabled: atBottom,
        run: () => store.moveSelectedLayer('backward'),
      },
      {
        id: 'front',
        label: 'To front',
        icon: 'arrow-up-circle-outline',
        disabled: atTop,
        run: () => store.moveSelectedLayer('front'),
      },
      {
        id: 'back',
        label: 'To back',
        icon: 'arrow-down-circle-outline',
        disabled: atBottom,
        run: () => store.moveSelectedLayer('back'),
      },
      {
        id: 'start-here',
        label: 'Start here',
        icon: 'play-skip-back-outline',
        run: () => store.setSelectedOverlayEdge('start'),
      },
      {
        id: 'end-here',
        label: 'End here',
        icon: 'play-skip-forward-outline',
        run: () => store.setSelectedOverlayEdge('end'),
      },
      { id: 'delete', label: 'Delete', icon: 'trash-outline', run: () => store.deleteSelectedOverlay() },
    );

    const label = kind === 'text' ? 'Text layer tools' : kind === 'sticker' ? 'Sticker tools' : kind === 'image' ? 'Overlay tools' : 'Effect tools';
    return { kind: 'layer', label, collapse: this.deselect(`Close ${label.toLowerCase()}`), tiles };
  }

  /**
   * The tools for a selected zoom. Short on purpose: its window is set by dragging its bar on the
   * timeline, and its level, curve and ramp in the sheet Edit opens. The zoom's id is read at tap
   * time, not from the row, for the reason [zoomSelected] gives.
   */
  private zoomRow(): ToolRow {
    const store = this.ctx.store;
    const withZoom = (act: (id: string) => void) => () => {
      const zoom = store.selectedZoom.value;
      if (zoom) act(zoom.id);
    };
    return {
      kind: 'zoom',
      label: 'Zoom tools',
      collapse: this.deselect('Close zoom tools'),
      tiles: [
        { id: 'edit', label: 'Edit', icon: 'create-outline', run: withZoom(id => store.openZoom(id)) },
        { id: 'duplicate', label: 'Duplicate', icon: 'duplicate-outline', run: withZoom(id => store.duplicateZoom(id)) },
        { id: 'delete', label: 'Delete', icon: 'trash-outline', run: withZoom(id => store.deleteZoom(id)) },
      ],
    };
  }

  private musicRow(): ToolRow {
    const store = this.ctx.store;
    const loops = this.musicLoops.value;
    return {
      kind: 'music',
      label: 'Sound tools',
      collapse: this.deselect('Close sound tools'),
      tiles: [
        {
          id: 'volume',
          label: 'Volume',
          icon: 'volume-high-outline',
          run: () => store.openVolume({ kind: 'music' }),
        },
        {
          id: 'loop',
          label: 'Loop',
          icon: 'repeat-outline',
          toggled: loops,
          run: () => this.toggleLoop(),
        },
        {
          id: 'start-here',
          label: 'Start here',
          icon: 'play-skip-back-outline',
          run: () => store.commitMusic({ startMs: Math.round(store.playheadMs.value) }, 'Move sound'),
        },
        {
          id: 'replace',
          label: 'Replace',
          icon: 'swap-horizontal-outline',
          run: () => this.ctx.media.openSound(),
        },
        { id: 'delete', label: 'Delete', icon: 'trash-outline', run: () => store.removeMusic() },
      ],
    };
  }

  private voiceRow(): ToolRow {
    const store = this.ctx.store;
    return {
      kind: 'voice',
      label: 'Voiceover tools',
      collapse: this.deselect('Close voiceover tools'),
      tiles: [
        {
          id: 'volume',
          label: 'Volume',
          icon: 'volume-high-outline',
          run: () => {
            const take = store.selectedVoice.value;
            if (take) store.openVolume({ kind: 'voice', id: take.id });
          },
        },
        { id: 'record', label: 'Record', icon: 'mic-outline', run: () => store.openPanel('voiceover') },
        { id: 'delete', label: 'Delete', icon: 'trash-outline', run: () => store.removeSelectedVoice() },
      ],
    };
  }

  /* ========================================================================================= */
  /* Helpers                                                                                   */
  /* ========================================================================================= */

  private soonTile(id: string, label: string, icon: EditorIconName): ToolTile {
    return { id, label, icon, soon: true, run: () => undefined };
  }

  private deselect(ariaLabel: string): ToolRow['collapse'] {
    return { ariaLabel, run: () => this.ctx.store.select(null) };
  }

  /**
   * The Layout tool. With a second video already on the frame it opens the sheet; without one there
   * is nothing to arrange yet, so it asks for that video first and opens the sheet on what comes
   * back. The media layer checks both caps before the picker opens and says which one bit.
   */
  private async openLayout(): Promise<void> {
    if (this.ctx.store.videoTrack.value) {
      this.ctx.store.openPanel('layout');
      return;
    }
    this.ctx.store.pause();
    if (await this.ctx.media.addVideoTrack()) this.ctx.store.openPanel('layout');
  }

  /**
   * Effects and Stickers only add layers, so at the cap their sheet would open onto choices that
   * all fail. The store checks the cap when a layer is added; this says it before the sheet opens.
   */
  private openLayerPanel(panel: EditorPanel): void {
    if (this.ctx.store.layersFull.value) {
      this.ctx.store.showToast(`You can add up to ${MAX_LAYERS} layers`);
      this.ctx.store.haptic('warning');
      return;
    }
    this.ctx.store.openPanel(panel);
  }

  /** Read at tap time, not from the row, so a double tap between frames still flips it twice. */
  private toggleLoop(): void {
    const music = this.ctx.store.manifest.value.music;
    if (!music) return;
    const loop = !music.loop;
    this.ctx.store.commitMusic({ loop }, loop ? 'Loop on' : 'Loop off');
    this.ctx.store.haptic('light');
  }

  render() {
    // Inside the watcher, so the row is rebuilt whenever one of the signals the last row read
    // changes. Built once outside it, the toolbar would be right at its first paint and then never
    // again, which is the mistake this component is the easiest one in the package to make.
    return this.watcher.run(() => {
      const row = this.row();
      const menuOpen = this.ctx.store.soundMenuOpen.value;
      return (
        <Host>
          <div
            class={{ 'tb': true, 'tb--balanced': !!row.collapse && row.tiles.length <= 3 }}
            role="toolbar"
            aria-orientation="horizontal"
            aria-label={row.label}
            onKeyDown={this.onKeydown}
          >
            {row.collapse && (
              <button type="button" key="collapse" class="tile tile--collapse" aria-label={row.collapse.ariaLabel} onClick={row.collapse.run}>
                <ve-icon class="tile__icon" name="chevron-down"></ve-icon>
              </button>
            )}
            {/*
              Keyed, because the collapse tile beside it comes and goes: the vdom pairs unkeyed
              siblings up by position, and the scroller would be thrown away and rebuilt every time
              a row with a chevron followed one without, taking its ref and its scroll position.
            */}
            <div key="scroller" class="tb__scroller" ref={this.keepScroller}>
              <div class="tb__track">
                {row.tiles.map(tile => (
                  <button
                    type="button"
                    key={tile.id}
                    data-tile={tile.id}
                    class={{
                      'tile': true,
                      'tile--dim': !!tile.disabled,
                      'tile--pressed': !!tile.pressed,
                      'tile--on': !!tile.toggled,
                    }}
                    // Strings on purpose: the vdom drops an attribute whose value is boolean false,
                    // and a toggle with no `aria-pressed` at all is announced as a plain button.
                    aria-disabled={tile.disabled ? 'true' : null}
                    aria-pressed={tile.toggled === undefined ? null : String(tile.toggled)}
                    aria-haspopup={tile.expanded === undefined ? null : 'menu'}
                    aria-expanded={tile.expanded === undefined ? null : String(tile.expanded)}
                    aria-label={tile.soon ? `${tile.label}, coming soon` : null}
                    onClick={() => this.tap(tile)}
                  >
                    <ve-icon class="tile__icon" name={tile.icon}></ve-icon>
                    <span class="tile__label">{tile.label}</span>
                    {tile.soon && (
                      <span class="tile__soon" aria-hidden="true">
                        Soon
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {menuOpen && [
            // Behind the menu and over the whole editor: a tap anywhere else only closes the menu.
            <div key="catcher" class="tb__catcher" aria-hidden="true" onClick={() => this.closeSoundMenu()}></div>,
            <div key="menu" class="tb__menu" role="menu" aria-label="Sound" onKeyDown={this.onMenuKeydown}>
              <button type="button" role="menuitem" class="tb__menu-item" onClick={this.addSound}>
                <ve-icon name="musical-note-outline"></ve-icon>
                <span>Add sound</span>
              </button>
              <button type="button" role="menuitem" class="tb__menu-item" aria-label="Sound effect, coming soon" onClick={this.soundEffect}>
                <ve-icon name="musical-notes-outline"></ve-icon>
                <span>Sound effect</span>
              </button>
              <button type="button" role="menuitem" class="tb__menu-item" onClick={this.voiceover}>
                <ve-icon name="mic-outline"></ve-icon>
                <span>Voiceover</span>
              </button>
            </div>,
          ]}
        </Host>
      );
    });
  }
}
