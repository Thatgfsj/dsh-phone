/**
 * Panel shell CSS (issue #62): header / stage / footer layout and the
 * min-width:0 + wrapped-block rules that keep CJK copy from going vertical.
 * Only \`--dsw-alias-*\` tokens are used.
 */
import { SETTINGS_CSS } from './styles-settings.ts'
import { PROVISION_CSS } from './styles-provision.ts'
export const PANEL_CSS = `
.dshp-root {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 0;
  height: 100%;
  min-width: 0;
  min-height: 0;
  color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-secondary);
  font-size: 12px;
  line-height: 1.45;
}
.dshp-root *,
.dshp-root *::before,
.dshp-root *::after { box-sizing: border-box; }
.dshp-header,
.dshp-footer,
.dshp-stage,
.dshp-scroll,
.dshp-row,
.dshp-keyrow,
.dshp-card,
.dshp-field { min-width: 0; }
.dshp-header,
.dshp-footer { flex: 0 0 auto; }
.dshp-stage { flex: 1 1 auto; min-height: 0; }
.dshp-scroll { flex: 1 1 auto; min-height: 0; position: relative; overflow-y: auto; overflow-x: hidden; padding: 12px; }

/* ---- long text: always an explicit wrapping block ---------------------- */
.dshp-text {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  text-align: center;
  line-height: 1.5;
}
.dshp-text--left { text-align: left; }
.dshp-text--secondary { color: var(--dsw-alias-text-secondary); font-size: 11px; }
.dshp-hint,
.dshp-error {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.5;
}
.dshp-hint { color: var(--dsw-alias-text-secondary); }
.dshp-error { color: var(--dsw-alias-text-danger); }

/* ---- rows / flex children --------------------------------------------- */
.dshp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dshp-grow { flex: 1 1 auto; min-width: 0; }

/* ---- header ------------------------------------------------------------ */
.dshp-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-secondary);
  background: var(--dsw-alias-bg-primary);
}
.dshp-header-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshp-header-icon {
  display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto; width: 22px; height: 22px;
  color: var(--dsw-alias-text-accent);
}
.dshp-title {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dshp-header-actions { display: flex; align-items: center; gap: 6px; min-width: 0; margin-left: auto; }

/* ---- badges ------------------------------------------------------------ */
.dshp-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-secondary);
  background: var(--dsw-alias-bg-tertiary);
  color: var(--dsw-alias-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
}
.dshp-badge[data-tone='ok'] { color: var(--dsw-alias-text-success); border-color: var(--dsw-alias-border-success); }
.dshp-badge[data-tone='warn'] { color: var(--dsw-alias-text-warning); border-color: var(--dsw-alias-border-warning); }
.dshp-badge[data-tone='error'] { color: var(--dsw-alias-text-danger); border-color: var(--dsw-alias-border-danger); }

/* ---- boot line (header) ------------------------------------------------ */
.dshp-bootline { display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; }
.dshp-bootline-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dshp-bootline-head > * { min-width: 0; max-width: 100%; }
.dshp-progress { width: 100%; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-tertiary); overflow: hidden; }
.dshp-progress-bar { height: 100%; border-radius: 999px; background: var(--dsw-alias-bg-accent); transition: width 300ms linear; }

/* ---- stage / canvas ---------------------------------------------------- */
.dshp-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-primary);
}
.dshp-canvas {
  display: block;
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  touch-action: none;
  image-rendering: auto;
}
.dshp-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-width: 0;
  padding: 16px;
  background: var(--dsw-alias-bg-primary);
  text-align: center;
  overflow: auto;
}
.dshp-overlay > * { min-width: 0; max-width: 100%; }
.dshp-overlay .dshp-text { max-width: 320px; }
.dshp-spinner {
  width: 22px; height: 22px; flex: 0 0 auto; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-secondary);
  border-top-color: var(--dsw-alias-text-accent);
  animation: dshp-spin 900ms linear infinite;
}
@keyframes dshp-spin { to { transform: rotate(360deg); } }
.dshp-overlay-progress { width: min(100%, 260px); }

/* ---- buttons ----------------------------------------------------------- */
.dshp-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  min-height: 28px;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  text-align: center;
  color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-tertiary);
  border: 1px solid var(--dsw-alias-border-secondary);
  border-radius: 6px;
  cursor: pointer;
}
.dshp-button:hover:not(:disabled) { background: var(--dsw-alias-bg-hover); }
.dshp-button:active:not(:disabled) { background: var(--dsw-alias-bg-active); }
.dshp-button:disabled { opacity: 0.5; cursor: default; }
.dshp-button:focus-visible { outline: 2px solid var(--dsw-alias-border-accent); outline-offset: 1px; }
.dshp-button[data-variant='primary'] {
  background: var(--dsw-alias-bg-accent);
  color: var(--dsw-alias-text-on-accent);
  border-color: var(--dsw-alias-border-accent);
}
.dshp-icon-button { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; }
.dshp-header-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0;
  color: var(--dsw-alias-text-secondary);
  background: transparent;
  border: 1px solid transparent; border-radius: 6px; cursor: pointer;
}
.dshp-header-button:hover { background: var(--dsw-alias-bg-hover); color: var(--dsw-alias-text-primary); }
.dshp-header-button:focus-visible { outline: 2px solid var(--dsw-alias-border-accent); outline-offset: 1px; }

/* ---- footer ------------------------------------------------------------ */
.dshp-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--dsw-alias-border-secondary);
  background: var(--dsw-alias-bg-primary);
}
.dshp-keyrow { display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap; }
.dshp-key-btn {
  flex: 1 1 52px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 44px;
  max-width: 100%;
  padding: 6px 4px;
  font: inherit;
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--dsw-alias-text-primary);
  background: var(--dsw-alias-bg-tertiary);
  border: 1px solid var(--dsw-alias-border-secondary);
  border-radius: 8px;
  cursor: pointer;
}
.dshp-key-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-hover); }
.dshp-key-btn:disabled { opacity: 0.5; cursor: default; }
.dshp-key-btn:focus-visible { outline: 2px solid var(--dsw-alias-border-accent); outline-offset: 1px; }
.dshp-key-label { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshp-footer-hint { text-align: left; }

/* ---- narrow dock: collapse labels, never squeeze text ------------------ */
@container (max-width: 360px) {
  .dshp-key-label { display: none; }
  .dshp-option .dshp-button { width: 100%; }
  .dshp-key-btn { min-width: 40px; padding: 6px 2px; }
  .dshp-header-main { gap: 6px; }
  .dshp-title { flex: 1 1 auto; }
  .dshp-actions .dshp-button { flex: 1 1 100%; }
  .dshp-footer-hint { text-align: center; }
}
`

export const CLIENT_CSS = PANEL_CSS + SETTINGS_CSS + PROVISION_CSS
