import { Component, Host, Prop } from '@stencil/core';

import { EDITOR_ICON_VIEW_BOX, EDITOR_ICONS, type EditorIconName } from '../../icons/icons';

/**
 * One glyph, drawn from the shapes inlined in `src/icons`.
 *
 * It is `ion-icon`'s shape without `ion-icon`: an element that takes its size from the font size it
 * inherits and its colour from the text around it, so a button styles its icon the way it styles
 * its label. The shape is kept because the editor is already written to it. Fifteen of its
 * stylesheets size an icon with `font-size` and no two of them agree on the number, from 34px on
 * the play button to 14px on a preview handle, so a `size` prop would mean rewriting every one of
 * them into a second vocabulary that only icons speak.
 *
 * Every instance in the editor is decorative - the glyph sits inside a button that already carries
 * its name - so an icon is hidden from the accessibility tree unless it is given a `label`.
 */
@Component({
  tag: 've-icon',
  styleUrl: 've-icon.css',
  shadow: true,
})
export class VeIcon {
  /**
   * Which shape to draw. A name that is not in the map draws nothing, deliberately: `src/icons`
   * has no fallback glyph, because a missing icon is a typo and an empty box is how it is noticed.
   */
  @Prop() name!: EditorIconName;

  /**
   * What a screen reader announces. Left unset, the element is `aria-hidden`, which is what nearly
   * every use of an icon in this editor wants: the name is already on the button, and an icon that
   * announces itself reads every tile out twice.
   */
  @Prop() label?: string;

  private svg?: SVGElement;
  private painted?: EditorIconName;

  /**
   * Handed to the vdom as one stable function rather than a fresh arrow per render, because a new
   * value is a changed value to Stencil and the ref would run again on every repaint. It forgets
   * what was painted as well, so a glyph is drawn into whatever element the ref last handed back
   * rather than assumed to still be in the one before it.
   */
  private readonly keepSvg = (el?: SVGElement) => {
    this.svg = el;
    this.painted = undefined;
  };

  componentDidRender() {
    // The shape is written into the element by hand because it cannot be written in the JSX:
    // Stencil's vdom only ever sets attributes on an SVG element, so an `innerHTML` there compiles
    // clean, lands as an attribute of that name and draws nothing at all. Remembering the last
    // name painted keeps a repaint for some other reason from reparsing the markup.
    if (!this.svg || this.painted === this.name) {
      return;
    }
    this.painted = this.name;
    this.svg.innerHTML = EDITOR_ICONS[this.name] ?? '';
  }

  render() {
    return (
      <Host role="img" aria-label={this.label} aria-hidden={this.label ? null : 'true'}>
        <svg viewBox={EDITOR_ICON_VIEW_BOX} ref={this.keepSvg}></svg>
      </Host>
    );
  }
}
