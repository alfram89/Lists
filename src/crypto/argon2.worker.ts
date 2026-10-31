import { argon2idAsync } from '@noble/hashes/argon2.js';

/**
 * Runs Argon2id off the main thread. Deriving a 64 MiB key takes seconds on a
 * phone, and on the main thread the page could not repaint meanwhile.
 */

interface Request {
  password: Uint8Array;
  salt: Uint8Array;
  params: { t: number; m: number; p: number; dkLen: number };
}

onmessage = async (event: MessageEvent<Request>) => {
  const { password, salt, params } = event.data;
  const key = await argon2idAsync(password, salt, params);
  postMessage(key, { transfer: [key.buffer] });
};
