import { Component, Prop } from '@stencil/core';

/**
 * The editor's busy indicator: one rotating arc, the crescent the editor already shows while a
 * project loads.
 *
 * It is drawn from a border rather than an SVG or a sprite so that it costs nothing to load and
 * inherits its colour from whatever it sits in. Size, weight, colour and speed are all CSS custom
 * properties, because the spinner appears at three different sizes across the editor and a prop
 * per size would put layout decisions inside the component.
 */
@Component({
  tag: 've-spinner',
  styleUrl: 've-spinner.css',
  shadow: true,
})
export class VeSpinner {
  /**
   * What a screen reader announces while the arc is turning. It is a label rather than a slot
   * because the arc has no text in it: without this the element is announced as nothing at all.
   */
  @Prop() label = 'Loading';

  render() {
    return <div class="arc" role="progressbar" aria-label={this.label} aria-busy="true"></div>;
  }
}
