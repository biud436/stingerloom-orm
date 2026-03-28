import { randomBytes } from "node:crypto";

/**
 * Generate a UUIDv7 (RFC 9562 Section 5.7).
 *
 * Layout (128 bits):
 * ```
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                         unix_ts_ms (48 bits)                  |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |  unix_ts_ms   |  ver  |         rand_a (12 bits)              |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |var|                       rand_b (62 bits)                    |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                           rand_b                              |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * ```
 *
 * - Bits 0–47: Unix timestamp in milliseconds
 * - Bits 48–51: Version (0b0111 = 7)
 * - Bits 52–63: Random (rand_a, 12 bits)
 * - Bits 64–65: Variant (0b10)
 * - Bits 66–127: Random (rand_b, 62 bits)
 *
 * @returns UUID v7 string in canonical format (8-4-4-4-12)
 */
export function generateUUIDv7(): string {
  const timestamp = Date.now();

  // 16 bytes buffer
  const bytes = randomBytes(16);

  // Bytes 0–5: 48-bit big-endian Unix timestamp in ms
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Byte 6: version (0b0111_xxxx) — high nibble = 7, low nibble = rand_a high 4 bits
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Byte 8: variant (0b10xx_xxxx) — high 2 bits = 10
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Format as canonical UUID string
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Extract the Unix timestamp (milliseconds) from a UUIDv7 string.
 *
 * @param uuid UUIDv7 string in canonical format
 * @returns Unix timestamp in milliseconds, or NaN if invalid
 */
export function extractTimestampFromUUIDv7(uuid: string): number {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) return NaN;
  // First 12 hex chars = 48-bit timestamp
  const tsHex = hex.slice(0, 12);
  return parseInt(tsHex, 16);
}
