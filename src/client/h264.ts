/**
 * H.264 Annex-B helpers shared by both decode paths (docs/protocol.md §2.2).
 *
 * The Host forwards scrcpy's H.264 byte stream untouched, so the client has to
 * turn the configuration packet (SPS/PPS in Annex-B form) into the AVC decoder
 * configuration record (`avcC`) WebCodecs expects. Pure functions only — this
 * is the part of decoding that is unit-tested without a browser.
 */

/** NAL unit types we care about. */
export const NAL_TYPE_SPS = 7
export const NAL_TYPE_PPS = 8
export const NAL_TYPE_IDR = 5

function startCodeLength(bytes: Uint8Array, offset: number): number {
  if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) return 0
  if (bytes[offset + 2] === 1) return 3
  if (bytes[offset + 2] === 0 && bytes[offset + 3] === 1) return 4
  return 0
}

/**
 * Split an Annex-B byte stream into NAL units, dropping the start codes.
 * @param data - one scrcpy packet payload.
 * @returns NAL units in stream order (empty when the payload has no start code).
 */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = []
  let index = 0
  let start = -1
  while (index < data.length - 2) {
    const length = startCodeLength(data, index)
    if (length !== 0) {
      if (start >= 0) units.push(data.subarray(start, index))
      index += length
      start = index
      continue
    }
    index += 1
  }
  if (start >= 0) units.push(data.subarray(start, data.length))
  return units.filter((unit) => unit.length > 0)
}

/** NAL unit type (lower 5 bits of the header byte). */
export function nalType(unit: Uint8Array): number {
  return (unit[0] ?? 0) & 0x1f
}

/**
 * Build the AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1) from the
 * configuration packet. WebCodecs requires `description` in avcC form, while
 * scrcpy delivers SPS/PPS as Annex-B; passing Annex-B straight through fails.
 * @param config - configuration packet payload.
 * @returns the record, or `undefined` when SPS/PPS are missing/malformed.
 */
export function buildAvcC(config: Uint8Array): Uint8Array | undefined {
  const units = splitAnnexB(config)
  const sps = units.find((unit) => nalType(unit) === NAL_TYPE_SPS)
  const pps = units.find((unit) => nalType(unit) === NAL_TYPE_PPS)
  if (sps === undefined || pps === undefined) return undefined
  if (sps.length < 4) return undefined
  const record = new Uint8Array(11 + sps.length + pps.length)
  const view = new DataView(record.buffer)
  record[0] = 1 // configurationVersion
  record[1] = sps[1]! // AVCProfileIndication
  record[2] = sps[2]! // profile_compatibility
  record[3] = sps[3]! // AVCLevelIndication
  record[4] = 0xff // reserved '111111' + lengthSizeMinusOne = 3
  record[5] = 0xe0 | 1 // reserved '111' + numOfSequenceParameterSets = 1
  view.setUint16(6, sps.length)
  record.set(sps, 8)
  const ppsOffset = 8 + sps.length
  record[ppsOffset] = 1
  view.setUint16(ppsOffset + 1, pps.length)
  record.set(pps, ppsOffset + 3)
  return record
}

/**
 * Derive the WebCodecs codec string from the configuration packet:
 * `avc1.<profile><constraints><level>` (dotted hex, ISO/IEC 14496-15 §5.3.4).
 */
export function codecStringFromConfig(config: Uint8Array): string | undefined {
  const sps = splitAnnexB(config).find((unit) => nalType(unit) === NAL_TYPE_SPS)
  if (sps === undefined || sps.length < 4) return undefined
  const hex = (value: number): string => value.toString(16).padStart(2, '0').toUpperCase()
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`
}
