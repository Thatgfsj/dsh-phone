/**
 * Settings/onboarding card CSS (split from styles.ts to keep files <=300 lines).
 * Only \`--dsw-alias-*\` tokens are used.
 */
export const SETTINGS_CSS = `
/* ---- empty/onboarding surfaces ---------------------------------------- */
.dshp-empty { display: flex; flex-direction: column; gap: 10px; width: 100%; min-width: 0; padding: 10px 4px; }
.dshp-empty-title { font-size: 13px; font-weight: 600; }
.dshp-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.dshp-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-primary);
  border: 1px solid var(--dsw-alias-border-secondary);
}
.dshp-card[data-state='pending'] { border-color: var(--dsw-alias-border-accent); }
.dshp-card-title { margin: 0; font-size: 13px; }
.dshp-options { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dshp-option { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshp-command {
  display: block;
  width: 100%;
  min-width: 0;
  margin: 2px 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-tertiary);
  color: var(--dsw-alias-text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-all;
}

/* ---- settings surfaces (unchanged names, wrapped text) ----------------- */
.dshp-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshp-input {
  font: inherit;
  width: 100%;
  min-width: 0;
  min-height: 56px;
  resize: vertical;
  color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-primary);
  border: 1px solid var(--dsw-alias-border-secondary);
  border-radius: 6px;
  padding: 6px 8px;
}
.dshp-kv { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 4px 12px; align-items: baseline; min-width: 0; }
.dshp-kv dt { color: var(--dsw-alias-text-secondary); }
.dshp-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dshp-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 4px 0; }
.dshp-sep { height: 1px; background: var(--dsw-alias-border-secondary); }


/* ---- settings surfaces (unchanged names, wrapped text) ----------------- */
.dshp-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshp-input {
  font: inherit;
  width: 100%;
  min-width: 0;
  min-height: 56px;
  resize: vertical;
  color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-primary);
  border: 1px solid var(--dsw-alias-border-secondary);
  border-radius: 6px;
  padding: 6px 8px;
}
.dshp-kv { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 4px 12px; align-items: baseline; min-width: 0; }
.dshp-kv dt { color: var(--dsw-alias-text-secondary); }
.dshp-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dshp-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 4px 0; }
.dshp-sep { height: 1px; background: var(--dsw-alias-border-secondary); }

`
