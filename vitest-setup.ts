import { defineCustomElements } from './loader';

/*
 * Nothing self registers under `single-export-module`, so the browser project registers everything
 * once through the lazy loader before any test renders a tag.
 */
defineCustomElements();
