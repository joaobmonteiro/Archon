/**
 * Linear webhook authentication and authorization utilities.
 * Signature verification follows HMAC-SHA256 pattern (same as GitHub adapter).
 */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify a Linear webhook signature (HMAC-SHA256).
 * Linear sends the signature in the `linear-signature` header as a hex digest.
 */
export function verifyLinearSignature(payload: string, signature: string, secret: string): boolean {
  const hmac = createHmac('sha256', secret);
  const digest = hmac.update(payload).digest('hex');

  const digestBuffer = Buffer.from(digest);
  const signatureBuffer = Buffer.from(signature);

  if (digestBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(digestBuffer, signatureBuffer);
}

/**
 * Check if the issue assignee matches the configured target (case-insensitive).
 */
export function isTargetAssignee(
  assigneeName: string | undefined,
  configuredAssignee: string
): boolean {
  if (!assigneeName) return false;
  return assigneeName.toLowerCase() === configuredAssignee.toLowerCase();
}
