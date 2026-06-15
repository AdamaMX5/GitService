import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison to prevent timing-based side-channel attacks.
 * Pads both buffers to the same length before comparing, then also checks that
 * the original lengths match, so a correctly-guessed padded value still fails.
 *
 * @param {string} a - Received value (potentially attacker-controlled)
 * @param {string} b - Expected secret value
 * @returns {boolean}
 */
export function timingSafeCompare(a, b) {
  try {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    const len = Math.max(aBuf.length, bBuf.length);
    const aPadded = Buffer.alloc(len);
    const bPadded = Buffer.alloc(len);
    aBuf.copy(aPadded);
    bBuf.copy(bPadded);
    return timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
  } catch {
    return false;
  }
}
