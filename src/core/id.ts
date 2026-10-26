import { toBase64Url } from '../crypto/encoding';

/** Returns a random 128-bit identifier encoded as base64url (22 characters). */
export function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}
