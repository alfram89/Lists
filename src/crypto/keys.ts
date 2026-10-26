import { schnorr, utils as secp256k1 } from '@noble/secp256k1';
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
  /**
   * secp256k1 secret key for signing mailbox events on Nostr relays. Shared by
   * everyone with the link; it only proves "has the link" to relays.
   */
  nostrSecretKey: Uint8Array<ArrayBuffer>;
  /** x-only public key (hex) matching `nostrSecretKey`. Identifies the room on relays. */
  nostrPubkey: string;
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

  // An HKDF output is a valid secp256k1 key unless it is >= the group order,
  // which happens with probability ~2^-128. Re-derive with a counter if so.
  let nostrSecretKey = new Uint8Array(0);
  for (let i = 0; !secp256k1.isValidSecretKey(nostrSecretKey); i++) {
    const info = i === 0 ? 'lists/v1/nostr' : `lists/v1/nostr/${i}`;
    nostrSecretKey = new Uint8Array(await crypto.subtle.deriveBits(params(info), base, 256));
  }
  const nostrPubkey = toHex(schnorr.getPublicKey(nostrSecretKey));

  return { encKey, roomId, signalPassword, nostrSecretKey, nostrPubkey };
}
