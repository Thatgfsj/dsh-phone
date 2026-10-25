/**
 * Provisioning UI CSS (issue #66): progress/log surfaces and the collapsible
 * manual-command block. Split from styles.ts to keep every file within the
 * 300-line target; only `--dsw-alias-*` tokens are used.
 */
export const PROVISION_CSS = `
.dshp-provision { display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; }
.dshp-provision > * { min-width: 0; max-width: 100%; }
.dshp-logs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-width: 0;
  max-height: 96px;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-primary);
  border: 1px solid var(--dsw-alias-border-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 1.4;
}
.dshp-log-line {
  display: block;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  text-align: left;
  color: var(--dsw-alias-text-secondary);
}
.dshp-details { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshp-details summary { cursor: pointer; color: var(--dsw-alias-text-secondary); }
.dshp-manual { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
`
