import test from 'node:test'
import assert from 'node:assert/strict'

import { fitRect, mapKeyboardKey, mapPointerToDevice } from '../../src/client/input.ts'

test('fitRect letterboxes a portrait device inside a wide box', () => {
  const rect = fitRect({ width: 400, height: 300 }, { width: 720, height: 1280 })
  assert.equal(rect.height, 300)
  assert.equal(rect.width, 168.75)
  assert.equal(rect.left, (400 - 168.75) / 2)
  assert.equal(rect.top, 0)
})

test('fitRect is the identity when aspect ratios match', () => {
  const rect = fitRect({ width: 360, height: 640 }, { width: 720, height: 1280 })
  assert.deepEqual(rect, { left: 0, top: 0, width: 360, height: 640 })
})

test('fitRect degrades to zero on empty input', () => {
  assert.deepEqual(fitRect({ width: 0, height: 0 }, { width: 1, height: 1 }), {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  })
})

test('mapPointerToDevice maps the content box to device pixels', () => {
  const point = mapPointerToDevice({ x: 180, y: 320 }, { width: 360, height: 640 }, { width: 720, height: 1280 })
  assert.deepEqual(point, { x: 360, y: 640 })
})

test('mapPointerToDevice ignores the letterbox bars and clamps to the device', () => {
  const box = { width: 400, height: 300 }
  const device = { width: 720, height: 1280 }
  const rect = fitRect(box, device)
  const topLeft = mapPointerToDevice({ x: rect.left, y: rect.top }, box, device)
  assert.deepEqual(topLeft, { x: 0, y: 0 })
  const bottomRight = mapPointerToDevice({ x: rect.left + rect.width, y: rect.top + rect.height }, box, device)
  assert.deepEqual(bottomRight, { x: 719, y: 1279 })
  // Tapping a letterbox bar pins to the nearest device edge, never out of range.
  assert.deepEqual(mapPointerToDevice({ x: 0, y: 0 }, box, device), { x: 0, y: 0 })
})

test('mapKeyboardKey forwards only shortcut keys', () => {
  assert.equal(mapKeyboardKey('Escape'), 'BACK')
  assert.equal(mapKeyboardKey('Enter'), 'ENTER')
  assert.equal(mapKeyboardKey('Backspace'), 'DEL')
  assert.equal(mapKeyboardKey('a'), undefined)
})
