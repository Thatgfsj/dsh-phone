/**
 * Video decoding for the right-Sidebar panel.
 *
 * Two paths, one presentation loop:
 * 1. WebCodecs `VideoDecoder` (hardware, preferred) configured for **Annex-B**
 *    (`avc: { format: 'annexb' }`, no `description`): the Host forwards scrcpy
 *    bytes untouched, so the bitstream stays Annex-B; the configuration packet
 *    is prepended to the first keyframe chunk for in-band SPS/PPS.
 *    `timestamp` = pts ticks * 1000 / 90 µs as frozen by docs/protocol.md §2.2.
 * 2. TinyH264 (WASM) software fallback, only when WebCodecs is missing or
 *    fails. It runs the `tinyh264` Emscripten module on the main thread
 *    (base64-embedded wasm, no worker/chunk: see docs/client.md §3 for why)
 *    and converts I420 to RGBA.
 *
 * Both paths hand frames to {@link CanvasRenderer}, which owns the single
 * requestAnimationFrame paint loop for the panel canvas.
 *
 * Delta frames are dropped until a keyframe arrives after (re)configuration,
 * matching docs/protocol.md §2.2.
 */
import type { ParsedVideoFrame } from './connection.ts'
import { splitAnnexB, webCodecsChunk, webCodecsConfig } from './h264.ts'
import type { TinyH264Module } from 'tinyh264/es/TinyH264.js'
import createTinyH264Module from 'tinyh264/es/TinyH264.js'
import TinyH264PictureDecoder from 'tinyh264/es/TinyH264Decoder.js'
import { CanvasRenderer } from './render.ts'
import { i420ToRgba } from './yuv.ts'

export type DecoderKind = 'webcodecs' | 'soft' | 'unavailable'

/** WebCodecs H.264 backend: hardware-accelerated when the browser allows it. */
export class WebCodecsDecoder {
  #decoder: VideoDecoder
  #configured = false
  #awaitingKeyframe = true
  /** Configuration packet not yet prepended to a keyframe chunk. */
  #configPrefix: Uint8Array | undefined
  #onError: ((error: Error) => void) | undefined

  static supported(): boolean {
    return typeof VideoDecoder !== 'undefined'
  }

  constructor(onFrame: (frame: VideoFrame) => void, onError?: (error: Error) => void) {
    this.#onError = onError
    this.#decoder = new VideoDecoder({
      output: onFrame,
      error: (error) => this.#onError?.(error),
    })
  }

  /**
   * Configure from the scrcpy configuration packet.
   * @returns false when this browser/codec combination refuses the stream.
   */
  configure(config: Uint8Array): boolean {
    const options = webCodecsConfig(config)
    if (options === undefined) return false
    try {
      // Annex-B, no description: the chunks below stay Annex-B, so nothing is
      // transcoded between the scrcpy stream and WebCodecs.
      this.#decoder.configure(options)
    } catch {
      return false
    }
    this.#configPrefix = config.slice()
    this.#configured = true
    this.#awaitingKeyframe = true
    return true
  }

  decode(frame: ParsedVideoFrame): void {
    if (!this.#configured) return
    if (frame.type === 'delta' && this.#awaitingKeyframe) return
    const init = webCodecsChunk(frame, frame.type === 'keyframe' ? this.#configPrefix : undefined)
    if (init === undefined) return
    if (frame.type === 'keyframe') {
      this.#awaitingKeyframe = false
      this.#configPrefix = undefined
    }
    this.#decoder.decode(new EncodedVideoChunk(init))
  }

  dispose(): void {
    try {
      if (this.#decoder.state !== 'closed') this.#decoder.close()
    } catch {
      /* already closed */
    }
  }
}

export type SoftPictureSink = (rgba: Uint8Array, width: number, height: number) => void

let tinyH264Module: Promise<TinyH264Module> | undefined

/** Instantiate the embedded-wasm decoder once per page. */
export async function loadTinyH264(): Promise<TinyH264Module> {
  tinyH264Module ??= createTinyH264Module()
  return tinyH264Module
}

/**
 * Software H.264 backend over `tinyh264`.
 *
 * The module is single-threaded and shared; each configuration packet creates a
 * fresh picture decoder (SPS/PPS can change on rotation / re-encode).
 */
export class SoftH264Decoder {
  #module: TinyH264Module
  #decoder: TinyH264PictureDecoder | undefined
  #awaitingKeyframe = true
  #rgba: Uint8Array | undefined
  #sink: SoftPictureSink

  private constructor(module: TinyH264Module, sink: SoftPictureSink) {
    this.#module = module
    this.#sink = sink
  }

  /** Load the wasm module; rejects when the browser cannot instantiate it. */
  static async create(sink: SoftPictureSink): Promise<SoftH264Decoder> {
    const module = await loadTinyH264()
    return new SoftH264Decoder(module, sink)
  }

  get backend(): string {
    return 'tinyh264'
  }

  configure(config: Uint8Array): void {
    this.#decoder?.release()
    this.#decoder = new TinyH264PictureDecoder(this.#module, (picture, width, height) => {
      const rgba = i420ToRgba(picture, width, height, this.#rgba)
      if (rgba === undefined) return
      this.#rgba = rgba
      this.#sink(rgba, width, height)
    })
    this.#awaitingKeyframe = true
    for (const nal of splitAnnexB(config)) this.#decoder.decode(nal)
  }

  decode(frame: ParsedVideoFrame): void {
    const decoder = this.#decoder
    if (decoder === undefined) return
    if (frame.type === 'delta' && this.#awaitingKeyframe) return
    if (frame.type === 'keyframe') this.#awaitingKeyframe = false
    for (const nal of splitAnnexB(frame.payload)) decoder.decode(nal)
  }

  dispose(): void {
    this.#decoder?.release()
    this.#decoder = undefined
  }
}

export interface StreamDecoderOptions {
  canvas: HTMLCanvasElement
  onError?: (message: string) => void
  onKindChange?: (kind: DecoderKind) => void
}

/**
 * Pick a decode path per configuration packet, fall back once on failure, and
 * keep both paths feeding the same {@link CanvasRenderer}.
 */
export class StreamDecoder {
  readonly renderer: CanvasRenderer
  #options: StreamDecoderOptions
  #kind: DecoderKind = 'unavailable'
  #webcodecs: WebCodecsDecoder | undefined
  #soft: SoftH264Decoder | undefined
  #config: Uint8Array | undefined
  #fallingBack = false

  private constructor(options: StreamDecoderOptions) {
    this.#options = options
    this.renderer = new CanvasRenderer(options.canvas)
  }

  /** Create the decoder; WebCodecs is probed lazily on the first configuration. */
  static create(options: StreamDecoderOptions): StreamDecoder {
    const decoder = new StreamDecoder(options)
    if (!WebCodecsDecoder.supported()) {
      decoder.#setKind('soft')
      void decoder.#ensureSoft()
    } else {
      decoder.#setKind('webcodecs')
      decoder.#webcodecs = new WebCodecsDecoder(
        (frame) => decoder.renderer.presentFrame(frame),
        () => void decoder.#fallback('WebCodecs error'),
      )
    }
    return decoder
  }

  get kind(): DecoderKind {
    return this.#kind
  }

  /** Feed one parsed stream frame. */
  push(frame: ParsedVideoFrame): void {
    if (frame.type === 'configuration') {
      this.#config = frame.payload.slice()
      this.#configure()
      return
    }
    if (frame.type === 'audio' || frame.type === 'control') return
    if (this.#kind === 'webcodecs') {
      try {
        this.#webcodecs?.decode(frame)
      } catch {
        void this.#fallback('WebCodecs decode error')
      }
      return
    }
    if (this.#kind === 'soft') this.#soft?.decode(frame)
  }

  dispose(): void {
    this.#webcodecs?.dispose()
    this.#soft?.dispose()
    this.renderer.dispose()
  }

  #configure(): void {
    const config = this.#config
    if (config === undefined) return
    if (this.#kind === 'webcodecs') {
      if (this.#webcodecs?.configure(config) === true) return
      void this.#fallback('WebCodecs configure rejected')
      return
    }
    if (this.#kind === 'soft') this.#soft?.configure(config)
  }

  async #ensureSoft(): Promise<void> {
    if (this.#soft !== undefined) return
    this.#soft = await SoftH264Decoder.create((rgba, width, height) => {
      const image = new ImageData(
        new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength),
        width,
        height,
      )
      this.renderer.presentImage(image)
    })
    // A configuration packet can arrive while the wasm module is still loading;
    // apply it now instead of waiting for another (there is no re-config packet).
    const config = this.#config
    if (config !== undefined && this.#kind === 'soft') this.#soft.configure(config)
  }

  async #fallback(reason: string): Promise<void> {
    if (this.#fallingBack || this.#kind === 'unavailable' || this.#kind === 'soft') return
    this.#fallingBack = true
    this.#webcodecs?.dispose()
    this.#webcodecs = undefined
    try {
      await this.#ensureSoft()
      this.#setKind('soft')
      const config = this.#config
      if (config !== undefined) this.#soft?.configure(config)
    } catch (error) {
      this.#setKind('unavailable')
      const detail = error instanceof Error ? error.message : String(error)
      this.#options.onError?.(detail === '' ? reason : detail)
    } finally {
      this.#fallingBack = false
    }
  }

  #setKind(kind: DecoderKind): void {
    if (this.#kind === kind) return
    this.#kind = kind
    this.#options.onKindChange?.(kind)
  }
}
