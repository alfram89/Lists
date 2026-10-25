import { toBase64Url, toHex, utf8 } from './encoding';

/** Length of a space secret in bytes. */
export const SECRET_BYTES = 32;

/**
 * Keys derived from a space secret. See docs/PROTOCOL.md, "Key derivation".
 * The secret itself never leaves the device except inside a share link.
 */
export interface SpaceKeys {
  /** AES-256-GCM key for sealing every message. Not extractable. */
  encKey: CryptoKey;
  /** Public rendezvous topic: a one-way function of the secret, hex encoded. */
  roomId: string;
  /** Password Trystero uses to encrypt WebRTC signalling (SDP) on the relays. */
  signalPassword: string;
}

export function generateSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

export async function deriveKeys(secret: Uint8Array<ArrayBuffer>): Promise<SpaceKeys> {
  if (secret.length !== SECRET_BYTES) throw new Error('Invalid space secret');
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ]);
  const params = (info: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: utf8(info),
  });

  const encKey = await crypto.subtle.deriveKey(
    params('lists/v1/enc'),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const roomId = toHex(
    new Uint8Array(await crypto.subtle.deriveBits(params('lists/v1/room'), base, 256)),
  );
  const signalPassword = toBase64Url(
    new Uint8Array(await crypto.subtle.deriveBits(params('lists/v1/signal'), base, 256)),
  );
  return { encKey, roomId, signalPassword };
}
