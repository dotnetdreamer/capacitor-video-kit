# ve-alert



<!-- Auto Generated Below -->


## Overview

The editor's confirmation, for a host that has no dialog of its own.

The package asks the customer two questions - discard the edits on the way out, and what to do
when a render failed - and both of them went to Ionic's `AlertController` in the app. A host
application usually has a dialog already, one that looks like the rest of it, so
`EditorPlatformHost.confirm` is where the question goes when there is one. This is what happens
when there is not: a browser, a host that has not wired one up, and the dev harness. [EditorConfirm]
in `editor-confirm.ts` is the piece that decides between the two, and it is the only thing that
should be putting this element on the screen.

Deliberately not `<dialog>`. `showModal()` gives a focus trap, a backdrop and top layer paint for
free, and it is iOS 15.4 and up; choisy ships to phones older than that. There `<dialog>` is an
element the browser has never heard of: it lays out as an ordinary block wherever the shell put
it, `showModal` is not a function, and what the customer gets is the question printed into the
editor with nothing modal about it. So the backdrop, the focus and the escape key are done by
hand here, which works the same on every phone the app runs on.

It takes no `ctx`: it reads nothing from the store and changes nothing in it. Every other
component in the editor takes one because every other component is part of the edit; this one is
a question with two buttons, and the answer goes back to whoever asked through `veDismiss`.

## Properties

| Property               | Attribute | Description                                                                                                                                                                                                                                                           | Type                                         | Default     |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------- |
| `buttons`              | --        | The answers, in the order they are shown. Empty by default rather than required, because a missing list would otherwise throw inside `render` and take the whole editor down with it; an alert with no buttons is still readable and the backdrop still dismisses it. | `readonly { text: string; role: string; }[]` | `[]`        |
| `header` _(required)_  | `header`  | The question, in a few words.                                                                                                                                                                                                                                         | `string`                                     | `undefined` |
| `message` _(required)_ | `message` | What answering either way will do. Both of the editor's own say what is kept, not what is lost.                                                                                                                                                                       | `string`                                     | `undefined` |


## Events

| Event       | Description                                                                                                                                                                                                                                                                                                                                                                                                                  | Type                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `veDismiss` | The `role` of the button that was pressed, or null for a dismissal: a press on the backdrop or the escape key. The editor's back press is the third way out and does not come through here - the shell settles its own question directly, the way it used to dismiss the Ionic alert.  Null is an answer rather than an error. Both callers read it as "neither of those": stay in the editor, keep the edits, post nothing. | `CustomEvent<null \| string>` |


----------------------------------------------

*Built with [StencilJS](https://stenciljs.com/)*
