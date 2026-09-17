# ve-toast



<!-- Auto Generated Below -->


## Overview

The editor's one line of feedback: a dark pill over the bottom of the stage saying what just
happened, or why nothing did.

Everything in the editor that has something to say says it through `store.showToast`, and the
store owns the message and its life: which sentence, how long it stays (1600ms, or the 2200 and
2400 that a handful of the longer ones ask for), and the rule that a new message replaces the one
on screen rather than queueing behind it. This component is the pill and
nothing else. It holds no timer, so an editor torn down mid message leaves nothing behind but the
store's own timeout, which `store.dispose()` clears.

Deliberately not a toast controller. Ionic's presented an element of its own over the whole page,
outlived the editor that asked for it, and could not be placed: these messages belong over the
video, above the round back and next buttons, and most of them answer a tap that landed on the
stage itself.

The shell renders one of these and never inside a condition: the element stays and the pill
inside it comes and goes. The comment on the `Host` below says what that buys.

## Properties

| Property           | Attribute | Description                                                                                             | Type            | Default     |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------- | --------------- | ----------- |
| `ctx` _(required)_ | --        | The editor this pill belongs to. Only `store.toast` is read: the message and its clock are the store's. | `EditorContext` | `undefined` |


## CSS Custom Properties

| Name               | Description                 |
| ------------------ | --------------------------- |
| `--ve-toast-bg`    | The pill behind the message |
| `--ve-toast-color` | The message itself          |


----------------------------------------------

*Built with [StencilJS](https://stenciljs.com/)*
