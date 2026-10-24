/**
 * Ambient declarations for the dsh-phone client bundle.
 *
 * This file is intentionally a script (no top-level import/export) so the
 * `declare module` blocks are ambient module declarations.
 *
 * - `window.__ModuleLoader__` is the DSH browser module loader (see
 *   docs/calibration.md §4.1). scripts/build.mjs wraps the bundle in
 *   `window.__ModuleLoader__.load({ id, factory })`.
 * - `tinyh264/es/*` ships no type declarations; the soft decoder declares the
 *   surface it uses. `tinyh264` is a phantom (transitive) dependency today:
 *   it arrives through `@yume-chan/scrcpy-decoder-tinyh264`. Recorded in
 *   docs/client.md; the dependency owner (issue #11) may promote it.
 */

interface ModuleLoaderFactoryRequire {
  (id: 'react'): typeof import('react')
  (id: string): unknown
}

interface ModuleLoader {
  load(entry: {
    id: string
    factory(require: ModuleLoaderFactoryRequire): unknown
  }): void
}

interface Window {
  __ModuleLoader__?: ModuleLoader
}

declare module 'tinyh264/es/TinyH264.js' {
  interface TinyH264Module {
    HEAPU8: Uint8Array
    _h264bsdAlloc(): number
    _h264bsdInit(storage: number, flags: number): void
    _h264bsdShutdown(storage: number): void
    _h264bsdFree(storage: number): void
    _h264bsdDecode(
      storage: number,
      buffer: number,
      size: number,
      picture: number,
      width: number,
      height: number,
    ): number
    _malloc(size: number): number
    _free(pointer: number): void
    getValue(pointer: number, type: 'i32' | 'i8*'): number
  }
  function createTinyH264Module(options?: Record<string, unknown>): Promise<TinyH264Module>
  export default createTinyH264Module
  export type { TinyH264Module }
}

declare module 'tinyh264/es/TinyH264Decoder.js' {
  export default class TinyH264PictureDecoder {
    constructor(
      module: unknown,
      onPictureReady: (picture: Uint8Array, width: number, height: number) => void,
    )
    decode(nal: Uint8Array): void
    release(): void
  }
}
