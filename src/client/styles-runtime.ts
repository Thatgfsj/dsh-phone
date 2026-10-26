/**
 * Lifecycle controls CSS (issue #83): big stopped-state buttons, destructive
 * stop tone, inline feedback bar. Only `--dsw-alias-*` tokens are used.
 */
export const RUNTIME_CSS = `
.dshp-runtime-actions { flex-wrap: wrap; margin-left: auto; }
.dshp-button--lg { min-height: 40px; padding: 8px 18px; font-size: 13px; border-radius: 8px; }
.dshp-button[data-tone='danger'] { color: var(--dsw-alias-text-danger); border-color: var(--dsw-alias-border-danger); }
.dshp-button[data-tone='danger']:hover:not(:disabled) { background: var(--dsw-alias-bg-hover); }
.dshp-stop { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; max-width: 340px; min-width: 0; }
.dshp-stop > * { min-width: 0; max-width: 100%; }
.dshp-stop-title { font-size: 14px; font-weight: 600; }
.dshp-actions--center { justify-content: center; }
.dshp-message { margin: 0; padding: 6px 10px; border-radius: 6px; background: var(--dsw-alias-bg-tertiary); color: var(--dsw-alias-text-secondary); }
.dshp-message--error { color: var(--dsw-alias-text-danger); }
.dshp-note { color: var(--dsw-alias-text-warning); }
`
