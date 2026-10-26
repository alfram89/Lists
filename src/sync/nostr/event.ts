import { schnorr } from '@noble/secp256k1';
import { toHex, utf8 } from '../../crypto/encoding';

/** A Nostr event (NIP-01). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedEvent = Pick<NostrEvent, 'created_at' | 'kind' | 'tags' | 'content'>;

/** A subscription filter (NIP-01). Only the fields this app uses. */
export interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  limit?: number;
  '#d'?: string[];
}

export async function eventId(pubkey: string, event: UnsignedEvent): Promise<string> {
  const serialized = JSON.stringify([
    0,
    pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(serialized))));
}

/** Computes the id and BIP-340 signature for an event. */
export async function signEvent(
  secretKey: Uint8Array,
  pubkey: string,
  event: UnsignedEvent,
): Promise<NostrEvent> {
  const id = await eventId(pubkey, event);
  const sig = toHex(await schnorr.signAsync(hexToBytes(id), secretKey));
  return { ...event, id, pubkey, sig };
}

/** Structural check for events received from a relay. Contents are verified later by decryption. */
export function isNostrEvent(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.pubkey === 'string' &&
    typeof e.created_at === 'number' &&
    typeof e.kind === 'number' &&
    typeof e.content === 'string' &&
    typeof e.sig === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  );
}

export function tagValue(event: Pick<NostrEvent, 'tags'>, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
