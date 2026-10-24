/**
 * Single requestAnimationFrame paint loop shared by both decode paths.
 *
 * WebCodecs frames and software (I420->RGBA) frames both land here; only the
 * latest pending frame is drawn per animation frame, aspect-fitted into the
 * canvas backing store (which panel.tsx sizes from CSS pixels x DPR).
 */
/** Shared paint loop: latest frame wins, scaled into the canvas backing store. */
export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
  #pendingFrame: VideoFrame | undefined
  #pendingImage: ImageData | undefined
  #scratch: HTMLCanvasElement | undefined
  #raf = 0
  #deviceWidth = 0
  #deviceHeight = 0

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('canvas 2d context unavailable')
    this.canvas = canvas
    this.context = context
  }

  /** Device framebuffer size; used for aspect-fit until a frame reports its own. */
  setDeviceSize(width: number, height: number): void {
    this.#deviceWidth = width
    this.#deviceHeight = height
  }

  /** Resize the backing store for a CSS box + devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    const ratio = pixelRatio > 0 ? pixelRatio : 1
    const width = Math.max(1, Math.round(cssWidth * ratio))
    const height = Math.max(1, Math.round(cssHeight * ratio))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
  }

  /** Queue a decoded WebCodecs frame (ownership transfers to the renderer). */
  presentFrame(frame: VideoFrame): void {
    this.#closePendingFrame()
    this.#pendingFrame = frame
    this.#schedule()
  }

  /** Queue a decoded software frame. */
  presentImage(image: ImageData): void {
    this.#pendingImage = image
    this.#schedule()
  }

  dispose(): void {
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
    this.#raf = 0
    this.#closePendingFrame()
  }

  #schedule(): void {
    if (this.#raf !== 0) return
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0
      this.#paint()
    })
  }

  #paint(): void {
    const { context, canvas } = this
    const width = canvas.width
    const height = canvas.height
    context.clearRect(0, 0, width, height)
    const frame = this.#pendingFrame
    if (frame !== undefined) {
      this.#pendingFrame = undefined
      this.#drawSource(frame, frame.displayWidth, frame.displayHeight)
      frame.close()
      return
    }
    const image = this.#pendingImage
    if (image === undefined) return
    this.#pendingImage = undefined
    const scratch = (this.#scratch ??= document.createElement('canvas'))
    if (scratch.width !== image.width) scratch.width = image.width
    if (scratch.height !== image.height) scratch.height = image.height
    const scratchContext = scratch.getContext('2d')
    if (scratchContext === null) return
    scratchContext.putImageData(image, 0, 0)
    this.#drawSource(scratch, image.width, image.height)
  }

  #drawSource(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): void {
    const { context, canvas } = this
    const width = sourceWidth > 0 ? sourceWidth : this.#deviceWidth
    const height = sourceHeight > 0 ? sourceHeight : this.#deviceHeight
    if (width <= 0 || height <= 0) return
    const scale = Math.min(canvas.width / width, canvas.height / height)
    const drawWidth = width * scale
    const drawHeight = height * scale
    context.imageSmoothingEnabled = true
    context.drawImage(source, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight)
  }

  #closePendingFrame(): void {
    this.#pendingFrame?.close()
    this.#pendingFrame = undefined
  }
}
