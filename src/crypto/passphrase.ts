import { argon2idAsync } from '@noble/hashes/argon2.js';
import { concatBytes, utf8 } from './encoding';
import { SECRET_BYTES } from './keys';

/**
 * Passphrase-protected share links. The space secret travels in the link
 * wrapped (encrypted) with a key derived from a passphrase, which the sender
 * passes on separately. A leaked link alone is then useless.
 *
 * Key derivation is Argon2id, which is memory-hard and so expensive to
 * brute-force on GPUs. It runs in plain JavaScript (no WebAssembly), so the
 * Content Security Policy needs no 'wasm-unsafe-eval'. See docs/PROTOCOL.md,
 * "Passphrase-protected links".
 */

/** Argon2id parameters for link version 1. Changing them requires a new link version. */
export const ARGON2_PARAMS = { t: 2, m: 64 * 1024, p: 1, dkLen: 32 } as const;
export const SALT_BYTES = 16;
const NONCE_BYTES = 12;
/** nonce || ciphertext of the 32-byte secret || 16-byte tag */
export const WRAPPED_BYTES = NONCE_BYTES + SECRET_BYTES + 16;
export const MIN_PASSPHRASE_LENGTH = 8;

/** Passphrases are compared after Unicode normalisation and trimming. */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFC').trim();
}

/**
 * Argon2id in a Web Worker in the browser, so the page stays responsive. Where
 * workers are unavailable (unit tests in Node), it runs in place.
 */
function argon2id(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return argon2idAsync(password, salt, ARGON2_PARAMS);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Uint8Array>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Key derivation failed'));
    };
    worker.postMessage({ password, salt, params: ARGON2_PARAMS });
  });
}

async function wrappingKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await argon2id(utf8(normalizePassphrase(passphrase)), salt);
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Binds the wrapped secret to its space, so it cannot be moved into another link. */
const associatedData = (spaceId: string) => utf8(`lists/v1/wrap:${spaceId}`);

export interface WrappedSecret {
  salt: Uint8Array<ArrayBuffer>;
  wrapped: Uint8Array<ArrayBuffer>;
}

export async function wrapSecret(
  secret: Uint8Array,
  passphrase: string,
  spaceId: string,
): Promise<WrappedSecret> {
  if (normalizePassphrase(passphrase).length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await wrappingKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData(spaceId) },
    key,
    new Uint8Array(secret),
  );
  return { salt, wrapped: concatBytes(nonce, new Uint8Array(ciphertext)) };
}

/** Returns the space secret, or null if the passphrase is wrong or the data was altered. */
export async function unwrapSecret(
  { salt, wrapped }: WrappedSecret,
  passphrase: string,
  spaceId: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (salt.length !== SALT_BYTES || wrapped.length !== WRAPPED_BYTES) return null;
  const key = await wrappingKey(passphrase, salt);
  try {
    const secret = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: wrapped.slice(0, NONCE_BYTES),
        additionalData: associatedData(spaceId),
      },
      key,
      wrapped.slice(NONCE_BYTES),
    );
    return new Uint8Array(secret);
  } catch {
    return null;
  }
}
