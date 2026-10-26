/**
 * Panel layout model (issue #62).
 *
 * The right Sidebar can be resized from ~320px to wide docks. Rather than
 * scattering width arithmetic through the components, every layout decision
 * (which chrome stacks, whether footer keys keep labels, whether secondary meta
 * fits) is a pure function of the measured width — and unit-tested at the
 * breakpoints the issue asks for (320 / 400 / 600 / wider).
 */
import type { BootProgress } from './boot.ts'
import type { StreamState } from './stream.ts'

/** At or below this width the panel is "compact": labels collapse. */
export const PANEL_COMPACT_MAX = 360
/** At or above this width the panel is "wide": everything fits. */
export const PANEL_WIDE_MIN = 600
/** Width assumed when the container has not been measured yet. */
export const PANEL_DEFAULT_WIDTH = 400

export type PanelSize = 'compact' | 'regular' | 'wide'

export interface PanelLayout {
  size: PanelSize
  /** Header chrome wraps onto multiple rows instead of one squeezed row. */
  stackHeader: boolean
  /** Footer key buttons keep their text label under/next to the icon. */
  showKeyLabels: boolean
  /** Secondary line (device meta + decoder) is worth the vertical space. */
  showSecondary: boolean
}

/** Classify a measured panel width and derive layout flags. */
export function describePanelLayout(width: number): PanelLayout {
  const safe = Number.isFinite(width) && width > 0 ? width : PANEL_DEFAULT_WIDTH
  if (safe <= PANEL_COMPACT_MAX) {
    return { size: 'compact', stackHeader: true, showKeyLabels: false, showSecondary: false }
  }
  if (safe >= PANEL_WIDE_MIN) {
    return { size: 'wide', stackHeader: false, showKeyLabels: true, showSecondary: true }
  }
  return { size: 'regular', stackHeader: false, showKeyLabels: true, showSecondary: true }
}

/** Which overlay the stage shows above the canvas. */
export type StageView = 'canvas' | 'connecting' | 'booting' | 'error' | 'stopped'

export interface StageViewInput {
  status: StreamState
  /** True while the Host reports state=booting (progress poller running). */
  booting: boolean
  /** Host reports the runtime as stopped (no instance / external kill). */
  runtimeStopped?: boolean
  /** Decoder/stream error copy, if any. */
  error?: string
}

/**
 * Pick the stage overlay. Errors win over booting (a broken decoder must be
 * visible), booting wins over "connecting" (the instance exists), and only a
 * ready stream hides the overlay entirely.
 */
export function describeStageView(input: StageViewInput): StageView {
  if (input.runtimeStopped === true) return 'stopped'
  if (input.error !== undefined) return 'error'
  if (input.booting) return 'booting'
  if (input.status === 'ready') return 'canvas'
  return 'connecting'
}

export interface BootSummary {
  seconds: number
  /** Expected cold-boot duration shown next to the elapsed time. */
  estimateSeconds: number
  /** 0-100 progress against the boot ceiling. */
  percent: number
  phaseKey: string
  timedOut: boolean
}

/**
 * Turn poller progress into the one-line "已等待 Ns / 预计约 Ms" summary.
 * @param progress - progress from the boot poller (or a WS state frame).
 * @param estimateMs - expected cold-boot duration (defaults to ~100s).
 */
export function summarizeBoot(progress: BootProgress, estimateMs = 100_000): BootSummary {
  return {
    seconds: progress.seconds,
    estimateSeconds: Math.max(1, Math.round(estimateMs / 1000)),
    percent: progress.percent,
    phaseKey: progress.phaseKey,
    timedOut: progress.timedOut,
  }
}
