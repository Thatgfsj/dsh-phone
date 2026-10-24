/**
 * End-to-end software decode check.
 *
 * WebCodecs cannot run under `node --test`, but the TinyH264 fallback path is
 * plain wasm + JS, so it can: we generate one red H.264 keyframe with ffmpeg
 * (skipped when ffmpeg is unavailable), decode it through the real
 * `SoftH264Decoder`, and assert the I420->RGBA result is red.
 *
 * The script shim supplies the globals the Emscripten worker-flavoured build
 * reads (`self.location.href`); it never posts messages, because the module runs
 * on the main thread (see docs/client.md §3).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { splitAnnexB, nalType, NAL_TYPE_SPS, NAL_TYPE_PPS } from '../../src/client/h264.ts'

const FFMPEG = '/usr/bin/ffmpeg'

function ffmpegAvailable(): boolean {
  if (!existsSync(FFMPEG)) return false
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('SoftH264Decoder decodes a real keyframe on the main thread', { skip: !ffmpegAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-phone-h264-'))
  try {
    const file = join(dir, 'frame.h264')
    execFileSync(FFMPEG, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=red:s=64x64:d=1',
      '-frames:v', '1',
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-pix_fmt', 'yuv420p',
      '-x264-params', 'keyint=1:min-keyint=1',
      file,
    ], { stdio: 'ignore' })
    const bytes = new Uint8Array(readFileSync(file))
    const nals = splitAnnexB(bytes)
    const configNals = nals.filter((nal) => {
      const type = nalType(nal)
      return type === NAL_TYPE_SPS || type === NAL_TYPE_PPS
    })
    assert.ok(configNals.length >= 2, 'fixture must carry SPS/PPS')

    // The Emscripten build reads self.location.href; everything else it needs on
    // this path already exists in Node.
    ;(globalThis as Record<string, unknown>).self = {
      location: { href: 'file:///tmp/' },
      addEventListener() {},
      postMessage() {},
    }

    const { SoftH264Decoder } = await import('../../src/client/decoder.ts')
    const pictures: { rgba: Uint8Array; width: number; height: number }[] = []
    const decoder = await SoftH264Decoder.create((rgba, width, height) => {
      pictures.push({ rgba, width, height })
    })
    decoder.configure(concatNals(configNals))
    decoder.decode({
      type: 'keyframe',
      keyframe: true,
      ptsTicks: 0,
      ptsMicros: 0,
      payload: bytes,
    })
    assert.ok(pictures.length >= 1, 'decoder must emit at least one picture')
    const picture = pictures[0]!
    assert.equal(picture.width, 64)
    assert.equal(picture.height, 64)
    assert.deepEqual([...picture.rgba.subarray(0, 4)], [255, 0, 0, 255], 'red frame')
    decoder.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function concatNals(nals: Uint8Array[]): Uint8Array {
  const parts = nals.map((nal) => Uint8Array.from([0, 0, 0, 1, ...nal]))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
