import test from 'node:test'
import assert from 'node:assert/strict'

import { describeBootProgress } from '../../src/client/boot.ts'
import {
  PANEL_COMPACT_MAX,
  PANEL_WIDE_MIN,
  describePanelLayout,
  describeStageView,
  summarizeBoot,
} from '../../src/client/layout.ts'

test('describePanelLayout maps the dock widths to three deliberate layouts', () => {
  const compact320 = describePanelLayout(320)
  assert.equal(compact320.size, 'compact')
  assert.equal(compact320.stackHeader, true)
  assert.equal(compact320.showKeyLabels, false)
  assert.equal(compact320.showSecondary, false)

  assert.equal(describePanelLayout(PANEL_COMPACT_MAX).size, 'compact')
  assert.equal(describePanelLayout(PANEL_COMPACT_MAX + 1).size, 'regular')

  const regular400 = describePanelLayout(400)
  assert.equal(regular400.size, 'regular')
  assert.equal(regular400.showKeyLabels, true)
  assert.equal(regular400.showSecondary, true)

  assert.equal(describePanelLayout(PANEL_WIDE_MIN).size, 'wide')
  assert.equal(describePanelLayout(800).size, 'wide')
})

test('describePanelLayout falls back to the regular layout for unmeasured widths', () => {
  for (const width of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
    const layout = describePanelLayout(width)
    assert.equal(layout.size, 'regular')
    assert.equal(layout.showKeyLabels, true)
  }
})

test('describeStageView: error wins, then booting, then canvas only when ready', () => {
  assert.equal(describeStageView({ status: 'ready', booting: false, error: 'boom' }), 'error')
  assert.equal(describeStageView({ status: 'ready', booting: true, error: 'boom' }), 'error')
  assert.equal(describeStageView({ status: 'ready', booting: true }), 'booting')
  assert.equal(describeStageView({ status: 'connecting', booting: true }), 'booting')
  assert.equal(describeStageView({ status: 'ready', booting: false }), 'canvas')
  for (const status of ['idle', 'connecting', 'open', 'reconnecting', 'closed', 'hidden'] as const) {
    assert.equal(describeStageView({ status, booting: false }), 'connecting')
  }
})

test('summarizeBoot builds the elapsed/estimate line from poller progress', () => {
  const early = summarizeBoot(describeBootProgress(12_000))
  assert.equal(early.seconds, 12)
  assert.equal(early.estimateSeconds, 100)
  assert.equal(early.percent, 10)
  assert.equal(early.phaseKey, 'panel.boot.phase.starting')
  assert.equal(early.timedOut, false)

  const almost = summarizeBoot(describeBootProgress(100_000))
  assert.equal(almost.seconds, 100)
  assert.equal(almost.percent, 83)
  assert.equal(almost.phaseKey, 'panel.boot.phase.slow')

  const capped = summarizeBoot(describeBootProgress(120_000))
  assert.equal(capped.percent, 100)
  assert.equal(capped.timedOut, true)
  assert.equal(summarizeBoot(describeBootProgress(5_000), 10_000).estimateSeconds, 10)
})
