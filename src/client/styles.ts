/**
 * Panel/settings styles. Only `--dsw-alias-*` theme tokens: literal colours
 * would ignore light/dark theme switches, and the DSH shell owns them.
 *
 * The CSS ships as a string; the plugin entry inserts it with
 * `styles.insert(css)` (a client service) and unregisters it on unload.
 */
export const CLIENT_CSS = `
.dshp-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  box-sizing: border-box;
  color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-secondary);
  font-size: 12px;
}
.dshp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshp-grow { flex: 1 1 auto; min-width: 0; }
.dshp-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-secondary);
  background: var(--dsw-alias-bg-tertiary);
  color: var(--dsw-alias-text-secondary);
  white-space: nowrap;
}
.dshp-badge[data-tone='ok'] { color: var(--dsw-alias-text-success); border-color: var(--dsw-alias-border-success); }
.dshp-badge[data-tone='warn'] { color: var(--dsw-alias-text-warning); border-color: var(--dsw-alias-border-warning); }
.dshp-badge[data-tone='error'] { color: var(--dsw-alias-text-danger); border-color: var(--dsw-alias-border-danger); }
.dshp-stage {
  position: relative; flex: 1 1 auto; min-height: 120px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; overflow: hidden;
  background: var(--dsw-alias-bg-primary);
  border: 1px solid var(--dsw-alias-border-secondary);
}
.dshp-canvas { display: block; max-width: 100%; max-height: 100%; image-rendering: auto; touch-action: none; }
.dshp-placeholder {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding: 12px; text-align: center; color: var(--dsw-alias-text-secondary);
}
.dshp-keys { display: flex; gap: 4px; flex-wrap: wrap; }
.dshp-button {
  font: inherit; color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-tertiary);
  border: 1px solid var(--dsw-alias-border-secondary);
  border-radius: 6px; padding: 4px 10px; cursor: pointer;
}
.dshp-button:hover { background: var(--dsw-alias-bg-hover); }
.dshp-button:disabled { opacity: 0.5; cursor: default; }
.dshp-button[data-variant='primary'] {
  background: var(--dsw-alias-bg-accent); color: var(--dsw-alias-text-on-accent);
  border-color: var(--dsw-alias-border-accent);
}
.dshp-hint { color: var(--dsw-alias-text-secondary); line-height: 1.5; }
.dshp-error { color: var(--dsw-alias-text-danger); line-height: 1.5; white-space: pre-wrap; }
.dshp-field { display: flex; flex-direction: column; gap: 6px; }
.dshp-input {
  font: inherit; width: 100%; box-sizing: border-box; min-height: 56px; resize: vertical;
  color: var(--dsw-alias-text-primary); background: var(--dsw-alias-bg-primary);
  border: 1px solid var(--dsw-alias-border-secondary); border-radius: 6px; padding: 6px 8px;
}
.dshp-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: baseline; }
.dshp-kv dt { color: var(--dsw-alias-text-secondary); }
.dshp-kv dd { margin: 0; word-break: break-all; }
.dshp-section { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
.dshp-sep { height: 1px; background: var(--dsw-alias-border-secondary); }
.dshp-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-primary);
  border: 1px solid var(--dsw-alias-border-secondary);
}
.dshp-card[data-state='pending'] { border-color: var(--dsw-alias-border-accent); }
.dshp-card-title { margin: 0; font-size: 13px; }
.dshp-options { display: flex; flex-direction: column; gap: 10px; }
.dshp-option { display: flex; flex-direction: column; gap: 4px; }
.dshp-command {
  display: block; margin: 2px 0; padding: 6px 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-tertiary); color: var(--dsw-alias-text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  white-space: pre-wrap; word-break: break-all;
}
`
