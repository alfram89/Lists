import * as Y from 'yjs';
import { randomId } from '../core/id';
import type { SpaceKeys } from '../crypto/keys';
import { MessageType, open, seal } from '../crypto/seal';
import { signEvent, tagValue, type NostrEvent } from './nostr/event';
import { RelayConnection, browserSocket, type SocketFactory } from './nostr/relay';

/**
 * Offline delivery through Nostr relays: the relays act as an encrypted
 * mailbox, so changes reach people who are not online at the same time.
 * See docs/PROTOCOL.md, "Nostr mailbox".
 *
 * All events are NIP-78 application data (kind 30078) signed with the room's
 * Nostr key. The author key alone identifies the room, so no room tag is
 * needed. Two kinds of event, told apart by their `d` tag:
 *  - `snapshot`: the complete space. Addressable, so each new one replaces the
 *    last on the relay.
 *  - `u:<random>`: one batch of incremental changes, with a NIP-40 expiration.
 *
 * On every (re)connection to a relay the mailbox fetches the latest snapshot,
 * then every update since that snapshot, then stays subscribed for new ones.
 *
 * A shadow Y.Doc tracks everything known to be on the relays. When the local
 * document has anything the shadow lacks (changes made offline, or a publish
 * that never got through), or the snapshot is behind, a new snapshot is
 * published. Any peer can do this, and Yjs merges make it safe for several to.
 */

export const MAILBOX_KIND = 30078;
const SNAPSHOT_TAG = 'snapshot';
const UPDATE_TAG_PREFIX = 'u:';
/** Updates expire from relays after this long; snapshots carry everything older. */
export const UPDATE_TTL_SECONDS = 14 * 24 * 60 * 60;
/** Snapshots are refreshed at least this often while someone uses the space. */
const SNAPSHOT_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Overlap when asking for updates since a snapshot, to tolerate clock skew. */
const SINCE_MARGIN_SECONDS = 10 * 60;
/** Most relays reject events larger than about 128 KB. */
const MAX_CONTENT_CHARS = 100_000;

export interface MailboxTiming {
  /** Delay to batch rapid local changes into one event. */
  flushDelayMs: number;
  /**
   * Delay before forwarding changes that arrived from a peer over WebRTC. The
   * peer usually publishes them itself, so waiting lets that copy arrive first
   * and makes forwarding unnecessary; if it never comes (the peer cannot reach
   * any relay), this device forwards it.
   */
  peerFlushDelayMs: number;
  /** Idle time after the last change before a snapshot is considered. */
  snapshotIdleMs: number;
  /** Random extra delay before snapshotting, so peers rarely do it at the same time. */
  snapshotJitterMs: number;
  /** How long to wait for other relays after the first one has delivered everything. */
  readyGraceMs: number;
  /** Give up waiting for relays and report ready (offline) after this long. */
  readyTimeoutMs: number;
  /** Wait before resending when every relay rejected or missed a publish. */
  retryDelayMs: number;
}

const DEFAULT_TIMING: MailboxTiming = {
  flushDelayMs: 400,
  peerFlushDelayMs: 5_000,
  snapshotIdleMs: 20_000,
  snapshotJitterMs: 6_000,
  readyGraceMs: 1_500,
  readyTimeoutMs: 8_000,
  retryDelayMs: 30_000,
};

export interface MailboxStatus {
  /** Relays currently connected. */
  relays: number;
  totalRelays: number;
  /** Local changes not yet accepted by any relay. */
  pending: boolean;
  /** The first fetch from relays has finished (or timed out). */
  ready: boolean;
}

export interface MailboxOptions {
  urls: string[];
  socketFactory?: SocketFactory;
  timing?: Partial<MailboxTiming>;
  /** Current time in seconds; injectable for tests. */
  now?: () => number;
}

interface Snapshot {
  id: string;
  createdAt: number;
}

export class RelayMailbox {
  private readonly relays: RelayConnection[];
  private readonly shadow = new Y.Doc();
  private readonly seen = new Set<string>();
  private readonly timing: MailboxTiming;
  private readonly now: () => number;
  private readonly listeners = new Set<(status: MailboxStatus) => void>();

  private latestSnapshot: Snapshot | null = null;
  /** created_at of every update event seen, to count those newer than the snapshot. */
  private updateTimes: number[] = [];
  /** The local document has changes not yet sent to the relays. */
  private dirty = false;
  private flushing = false;
  private ready = false;
  private closed = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushDueAt = Infinity;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly doc: Y.Doc,
    private readonly keys: SpaceKeys,
    options: MailboxOptions,
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    doc.on('update', this.onDocUpdate);
    this.relays = options.urls.map((url) => {
      const relay: RelayConnection = new RelayConnection(
        url,
        options.socketFactory ?? browserSocket,
        {
          onOpen: () => this.onRelayOpen(relay),
          onStateChange: () => this.onRelayStateChange(),
        },
      );
      return relay;
    });
    this.readyTimer = setTimeout(() => this.markReady(), this.timing.readyTimeoutMs);
  }

  get status(): MailboxStatus {
    return {
      relays: this.relays.filter((r) => r.connected).length,
      totalRelays: this.relays.length,
      pending: this.dirty || this.flushing,
      ready: this.ready,
    };
  }

  /** Sends pending changes right away, e.g. before the page is hidden. */
  flushNow(): void {
    clearTimeout(this.flushTimer);
    this.flushDueAt = Infinity;
    void this.flush();
  }

  onStatus(listener: (status: MailboxStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.doc.off('update', this.onDocUpdate);
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.snapshotTimer);
    clearTimeout(this.readyTimer);
    for (const relay of this.relays) relay.close();
    this.shadow.destroy();
    this.listeners.clear();
  }

  // ---- Receiving -------------------------------------------------------------

  private onRelayOpen(relay: RelayConnection) {
    const author = { kinds: [MAILBOX_KIND], authors: [this.keys.nostrPubkey] };
    const snapshotSub = `s${randomId().slice(0, 8)}`;
    relay.subscribe(snapshotSub, [{ ...author, '#d': [SNAPSHOT_TAG], limit: 1 }], {
      onEvent: (event) => void this.receive(event),
      onEose: () => {
        relay.unsubscribe(snapshotSub);
        const since = this.latestSnapshot
          ? this.latestSnapshot.createdAt - SINCE_MARGIN_SECONDS
          : this.now() - UPDATE_TTL_SECONDS;
        relay.subscribe(`u${randomId().slice(0, 8)}`, [{ ...author, since }], {
          onEvent: (event) => void this.receive(event),
          onEose: () => this.onRelayCaughtUp(),
        });
      },
    });
  }

  private onRelayStateChange() {
    this.emitStatus();
    // A relay came (back) online: send anything that is still waiting.
    if (this.dirty) this.scheduleFlush();
  }

  private onRelayCaughtUp() {
    if (this.ready) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => this.markReady(), this.timing.readyGraceMs);
  }

  private markReady() {
    if (this.ready || this.closed) return;
    this.ready = true;
    this.emitStatus();
    if (this.dirty) this.scheduleFlush();
    this.scheduleSnapshot(this.timing.snapshotJitterMs * Math.random() + 1000);
  }

  private async receive(event: NostrEvent) {
    if (this.closed || this.seen.has(event.id)) return;
    if (event.pubkey !== this.keys.nostrPubkey || event.kind !== MAILBOX_KIND) return;
    this.seen.add(event.id);

    const d = tagValue(event, 'd') ?? '';
    const isSnapshot = d === SNAPSHOT_TAG;
    if (!isSnapshot && !d.startsWith(UPDATE_TAG_PREFIX)) return;

    const sealed = fromBase64(event.content);
    const message = sealed && (await open(this.keys, sealed));
    if (!message || this.closed) return; // not ours, or tampered: ignore

    try {
      Y.applyUpdate(this.doc, message.payload, this);
      Y.applyUpdate(this.shadow, message.payload);
    } catch {
      return;
    }

    if (isSnapshot) {
      if (!this.latestSnapshot || event.created_at > this.latestSnapshot.createdAt) {
        this.latestSnapshot = { id: event.id, createdAt: event.created_at };
      }
    } else {
      this.updateTimes.push(event.created_at);
    }
  }

  // ---- Sending ---------------------------------------------------------------

  private readonly onDocUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === this || this.closed) return;
    // Local edits have no origin; anything else came from a peer.
    const fromPeer = origin !== null && origin !== undefined;
    this.dirty = true;
    this.emitStatus();
    this.scheduleFlush(fromPeer ? this.timing.peerFlushDelayMs : this.timing.flushDelayMs);
    // Snapshot once the user has stopped editing for a while.
    if (!fromPeer) this.scheduleSnapshot(this.timing.snapshotIdleMs);
  };

  /** Flushes after `delayMs`, unless a flush is already due sooner. */
  private scheduleFlush(delayMs = this.timing.flushDelayMs) {
    const dueAt = Date.now() + delayMs;
    if (dueAt >= this.flushDueAt) return;
    clearTimeout(this.flushTimer);
    this.flushDueAt = dueAt;
    this.flushTimer = setTimeout(() => {
      this.flushDueAt = Infinity;
      void this.flush();
    }, delayMs);
  }

  /** True if the relays hold everything the local document has. */
  private relaysUpToDate(): boolean {
    return Y.equalSnapshots(Y.snapshot(this.doc), Y.snapshot(this.shadow));
  }

  /**
   * Sends everything the relays lack: the difference between the local document
   * and the shadow of what relays hold. Yjs needs every earlier change from a
   * client before it can apply a later one, so sending only the newest edits
   * would strand them if anything before them (say, edits made before the
   * space was shared) never reached a relay.
   */
  private async flush() {
    if (this.closed || this.flushing || !this.dirty || !this.ready) return;
    if (!this.relays.some((r) => r.connected)) return; // retried when a relay connects
    if (this.relaysUpToDate()) {
      this.dirty = false; // e.g. a peer's change that the relays already delivered
      this.emitStatus();
      return;
    }
    this.flushing = true;
    this.dirty = false;
    const update = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.shadow));
    const createdAt = this.now();
    const accepted = await this.publish(
      MessageType.Update,
      update,
      [
        ['d', UPDATE_TAG_PREFIX + randomId()],
        ['expiration', String(createdAt + UPDATE_TTL_SECONDS)],
      ],
      createdAt,
    );
    this.flushing = false;
    if (this.closed) return;
    if (accepted) {
      Y.applyUpdate(this.shadow, update);
      this.updateTimes.push(createdAt);
      this.scheduleSnapshot(this.timing.snapshotIdleMs);
    } else {
      // Retry when a relay (re)connects, or after a pause in case the connected
      // relays are only rate limiting.
      this.dirty = true;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.scheduleFlush(), this.timing.retryDelayMs);
    }
    this.emitStatus();
    if (this.dirty && accepted) this.scheduleFlush();
  }

  private scheduleSnapshot(delayMs: number) {
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => void this.maybeSnapshot(), delayMs);
  }

  /** True if relays are missing something this device has, or the snapshot is stale. */
  needsSnapshot(): boolean {
    const snapshot = this.latestSnapshot;
    if (!snapshot) return true;
    if (this.now() - snapshot.createdAt > SNAPSHOT_MAX_AGE_SECONDS) return true;
    if (this.updateTimes.some((t) => t >= snapshot.createdAt)) return true;
    return !this.relaysUpToDate();
  }

  private async maybeSnapshot() {
    if (this.closed || !this.ready || this.flushing || this.dirty) return;
    if (!this.relays.some((r) => r.connected) || !this.needsSnapshot()) return;
    const state = Y.encodeStateAsUpdate(this.doc);
    const createdAt = this.now();
    const accepted = await this.publish(
      MessageType.StateResponse,
      state,
      [['d', SNAPSHOT_TAG]],
      createdAt,
    );
    if (!accepted || this.closed) return;
    Y.applyUpdate(this.shadow, state);
    this.latestSnapshot = { id: '', createdAt };
    this.updateTimes = [];
  }

  /** Seals, signs and sends one event to every connected relay. True if at least one accepted it. */
  private async publish(
    type: MessageType,
    payload: Uint8Array,
    tags: string[][],
    createdAt: number,
  ): Promise<boolean> {
    const content = toBase64(await seal(this.keys, type, payload));
    if (content.length > MAX_CONTENT_CHARS) {
      // Retrying would never succeed. Report an update as handled so it is not
      // resent forever; a snapshot is simply skipped. Both still sync peer to peer.
      console.warn('Lists: change too large for relays; it will only sync peer to peer.');
      return type === MessageType.Update;
    }
    const event = await signEvent(this.keys.nostrSecretKey, this.keys.nostrPubkey, {
      kind: MAILBOX_KIND,
      created_at: createdAt,
      tags,
      content,
    });
    this.seen.add(event.id);
    const results = await Promise.all(
      this.relays.filter((r) => r.connected).map((r) => r.publish(event)),
    );
    return results.some(Boolean);
  }

  private emitStatus() {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
