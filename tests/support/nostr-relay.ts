import { schnorr } from '@noble/secp256k1';
import { eventId, hexToBytes, type NostrEvent } from '../../src/sync/nostr/event';

/**
 * An in-memory Nostr relay (NIP-01, addressable events, NIP-40 aware) used by
 * unit and end-to-end tests. It verifies ids and signatures like a real relay,
 * so incorrectly signed events fail the tests.
 */

type Filter = Record<string, unknown>;

export interface RelayClient {
  receive(raw: string): void;
  close(): void;
}

function matches(filter: Filter, event: NostrEvent): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'limit') continue;
    if (key === 'since' && event.created_at < (value as number)) return false;
    if (key === 'until' && event.created_at > (value as number)) return false;
    if (key === 'ids' && !(value as string[]).includes(event.id)) return false;
    if (key === 'authors' && !(value as string[]).includes(event.pubkey)) return false;
    if (key === 'kinds' && !(value as number[]).includes(event.kind)) return false;
    if (key.startsWith('#')) {
      const name = key.slice(1);
      const wanted = value as string[];
      if (!event.tags.some(([tag, v]) => tag === name && wanted.includes(v!))) return false;
    }
  }
  return true;
}

const isEphemeral = (kind: number) => kind >= 20000 && kind < 30000;
const isAddressable = (kind: number) => kind >= 30000 && kind < 40000;
const dTag = (event: NostrEvent) => event.tags.find((t) => t[0] === 'd')?.[1] ?? '';

export class NostrRelay {
  private stored: NostrEvent[] = [];
  private clients = new Set<{ send: (msg: string) => void; subs: Map<string, Filter[]> }>();
  /** Total connections ever opened. */
  connections = 0;
  /** Every event accepted, including replaced and ephemeral ones. */
  accepted: NostrEvent[] = [];

  constructor(private readonly options: { verify?: boolean } = {}) {}

  /** Events currently stored, for assertions. */
  get events(): NostrEvent[] {
    return [...this.stored];
  }

  connect(send: (message: string) => void): RelayClient {
    this.connections++;
    const client = { send, subs: new Map<string, Filter[]>() };
    this.clients.add(client);
    return {
      receive: (raw) => void this.handle(client, raw),
      close: () => this.clients.delete(client),
    };
  }

  /** Connections that are currently open. */
  get openConnections(): number {
    return this.clients.size;
  }

  /** Removes stored events, e.g. to simulate expiry. */
  removeWhere(predicate: (event: NostrEvent) => boolean): void {
    this.stored = this.stored.filter((e) => !predicate(e));
  }

  /** Stores an event without any checks, as a malicious relay could. */
  inject(event: NostrEvent): void {
    this.stored.push(event);
  }

  private async handle(
    client: { send: (msg: string) => void; subs: Map<string, Filter[]> },
    raw: string,
  ) {
    const message = JSON.parse(raw) as unknown[];
    const [type] = message;
    if (type === 'REQ') {
      const [, subId, ...filters] = message as [string, string, ...Filter[]];
      client.subs.set(subId, filters);
      const results = this.stored
        .filter((e) => filters.some((f) => matches(f, e)))
        .sort((a, b) => b.created_at - a.created_at);
      const limit = Math.min(...filters.map((f) => (f.limit as number) ?? Infinity));
      for (const event of results.slice(0, limit)) {
        client.send(JSON.stringify(['EVENT', subId, event]));
      }
      client.send(JSON.stringify(['EOSE', subId]));
    } else if (type === 'CLOSE') {
      client.subs.delete(message[1] as string);
    } else if (type === 'EVENT') {
      const event = message[1] as NostrEvent;
      const error = await this.validate(event);
      client.send(JSON.stringify(['OK', event.id, !error, error ?? '']));
      if (error) return;
      this.accepted.push(event);
      if (isAddressable(event.kind)) {
        const key = (e: NostrEvent) => `${e.kind}:${e.pubkey}:${dTag(e)}`;
        const existing = this.stored.find((e) => key(e) === key(event));
        if (existing && existing.created_at > event.created_at) return;
        this.stored = this.stored.filter((e) => key(e) !== key(event));
      }
      if (!isEphemeral(event.kind)) this.stored.push(event);
      for (const other of this.clients) {
        for (const [subId, filters] of other.subs) {
          if (filters.some((f) => matches(f, event)))
            other.send(JSON.stringify(['EVENT', subId, event]));
        }
      }
    }
  }

  private async validate(event: NostrEvent): Promise<string | undefined> {
    if (!this.options.verify) return undefined;
    const { id, pubkey, sig, ...rest } = event;
    if ((await eventId(pubkey, rest)) !== id) return 'invalid: bad event id';
    const valid = await schnorr.verifyAsync(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey));
    return valid ? undefined : 'invalid: bad signature';
  }
}
