import { concatBytes, utf8 } from './encoding';
import type { SpaceKeys } from './keys';

/**
 * Sealed message format, see docs/PROTOCOL.md, "Message format":
 *
 *   sealed = version (0x01) || nonce (12 bytes) || AES-256-GCM ciphertext
 *   plain  = type (1 byte) || payload length (uint32, big endian) || payload || zero padding
 *
 * The associated data binds every message to its room.
 */

export const SEAL_VERSION = 1;
const NONCE_BYTES = 12;
const HEADER_BYTES = 5;
const TAG_BYTES = 16;

/** Messages larger than this are dropped before any decryption is attempted. */
export const MAX_SEALED_BYTES = 8 * 1024 * 1024;

export const MessageType = {
  /** An incremental Yjs update, broadcast to all peers. */
  Update: 1,
  /** Reply to a state request: everything the requester is missing, as one Yjs update. */
  StateResponse: 2,
  /** A Yjs state vector, asking the receiver for the updates the sender lacks. */
  StateRequest: 4,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

const KNOWN_TYPES = new Set<number>(Object.values(MessageType));

export interface OpenedMessage {
  type: MessageType;
  payload: Uint8Array<ArrayBuffer>;
}

/**
 * Plaintext is padded up to one of these sizes, so an observer only learns
 * roughly how large a change was. Beyond the last bucket, sizes round up to
 * the next multiple of it.
 */
const PAD_BUCKETS = [256, 1024, 4096, 16384, 65536, 262144, 1048576];

export function paddedLength(length: number): number {
  for (const bucket of PAD_BUCKETS) if (length <= bucket) return bucket;
  const last = PAD_BUCKETS.at(-1)!;
  return Math.ceil(length / last) * last;
}

function associatedData(keys: SpaceKeys): Uint8Array<ArrayBuffer> {
  return utf8(`lists/v${SEAL_VERSION}:${keys.roomId}`);
}

export async function seal(
  keys: SpaceKeys,
  type: MessageType,
  payload: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const plain = new Uint8Array(paddedLength(HEADER_BYTES + payload.length));
  const view = new DataView(plain.buffer);
  view.setUint8(0, type);
  view.setUint32(1, payload.length);
  plain.set(payload, HEADER_BYTES);

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData(keys) },
    keys.encKey,
    plain,
  );
  return concatBytes(new Uint8Array([SEAL_VERSION]), nonce, new Uint8Array(ciphertext));
}

/**
 * Decrypts and validates a sealed message. Returns null for anything that is
 * not a well-formed message for this room: wrong key, tampering, unknown
 * version or type, bad length. Callers must simply drop those.
 */
export async function open(keys: SpaceKeys, sealed: Uint8Array): Promise<OpenedMessage | null> {
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES + HEADER_BYTES) return null;
  if (sealed.length > MAX_SEALED_BYTES) return null;
  if (sealed[0] !== SEAL_VERSION) return null;

  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: sealed.slice(1, 1 + NONCE_BYTES),
          additionalData: associatedData(keys),
        },
        keys.encKey,
        sealed.slice(1 + NONCE_BYTES),
      ),
    );
  } catch {
    return null;
  }

  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const type = view.getUint8(0);
  const length = view.getUint32(1);
  if (!KNOWN_TYPES.has(type) || HEADER_BYTES + length > plain.length) return null;
  return {
    type: type as MessageType,
    payload: plain.slice(HEADER_BYTES, HEADER_BYTES + length),
  };
}
