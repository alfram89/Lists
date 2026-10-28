import * as Y from 'yjs';
import type { SpaceKeys } from '../crypto/keys';
import { MessageType, open, seal } from '../crypto/seal';
import type { Transport, TransportFactory } from './transport';

export interface SyncStatus {
  /** Other devices currently connected (WebRTC peers). */
  devices: number;
  /** Other tabs of this app on this device that have the space open. */
  tabs: number;
}

/**
 * Keeps one Y.Doc in sync with every peer reachable through the given
 * transports. All traffic is sealed with the space key.
 *
 * Protocol (docs/PROTOCOL.md, "Sync"):
 *  - When a peer joins, each side sends a StateRequest with its state vector.
 *  - A StateRequest is answered with a StateResponse holding exactly the
 *    updates the requester is missing.
 *  - Every local change is broadcast as an Update.
 *
 * Yjs updates are idempotent and commutative, so duplicates and reordering
 * are harmless.
 */
export class SyncSession {
  private readonly transports: Transport[] = [];
  private readonly peers: Set<string>[];
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private readonly movedListeners = new Set<() => void>();
  private closed = false;
  /** Number of messages dropped because they failed to open or apply. */
  dropped = 0;

  constructor(
    private readonly doc: Y.Doc,
    private readonly keys: SpaceKeys,
    factories: TransportFactory[],
  ) {
    doc.on('update', this.onDocUpdate);
    this.peers = factories.map(() => new Set());
    // Transports may report peers while they are being created, so the list is
    // filled one by one and the status is published once everything exists.
    factories.forEach((factory, index) => {
      this.transports.push(
        factory(
          { roomId: keys.roomId, signalPassword: keys.signalPassword },
          {
            onMessage: (data, peerId) => void this.receive(index, data, peerId),
            onPeerJoin: (peerId) => this.peerJoined(index, peerId),
            onPeerLeave: (peerId) => this.peerLeft(index, peerId),
          },
        ),
      );
    });
    this.emitStatus();
  }

  get status(): SyncStatus {
    let devices = 0;
    let tabs = 0;
    this.peers.forEach((peers, i) => {
      const transport = this.transports[i];
      if (!transport) return;
      if (transport.remote) devices += peers.size;
      else tabs += peers.size;
    });
    return { devices, tabs };
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when a peer announces that the space moved to a new key. */
  onMoved(listener: () => void): () => void {
    this.movedListeners.add(listener);
    return () => this.movedListeners.delete(listener);
  }

  /** Tells every connected peer that this key is retired. */
  async announceMoved(): Promise<void> {
    await this.sendTo(undefined, undefined, MessageType.Moved, new Uint8Array(0));
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.doc.off('update', this.onDocUpdate);
    for (const transport of this.transports) transport.close();
    this.listeners.clear();
    this.movedListeners.clear();
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Updates that came from peers are not echoed back; every peer
    // broadcasts its own changes.
    if (origin === this || this.closed) return;
    void this.sendTo(undefined, undefined, MessageType.Update, update);
  };

  private peerJoined(index: number, peerId: string) {
    if (this.closed) return;
    this.peers[index]!.add(peerId);
    this.emitStatus();
    void this.sendTo(index, peerId, MessageType.StateRequest, Y.encodeStateVector(this.doc));
  }

  private peerLeft(index: number, peerId: string) {
    if (this.peers[index]!.delete(peerId)) this.emitStatus();
  }

  private async receive(index: number, data: Uint8Array, peerId: string) {
    const message = await open(this.keys, data);
    if (this.closed) return;
    if (!message) {
      this.dropped++;
      return;
    }
    try {
      switch (message.type) {
        case MessageType.StateRequest: {
          const missing = Y.encodeStateAsUpdate(this.doc, message.payload);
          await this.sendTo(index, peerId, MessageType.StateResponse, missing);
          break;
        }
        case MessageType.Update:
        case MessageType.StateResponse:
          Y.applyUpdate(this.doc, message.payload, this);
          break;
        case MessageType.Moved:
          for (const listener of this.movedListeners) listener();
          break;
      }
    } catch {
      // Authentic but malformed payload (buggy peer). Ignore it.
      this.dropped++;
    }
  }

  /** Sends to one peer of one transport, or broadcasts on all transports. */
  private async sendTo(
    index: number | undefined,
    peerId: string | undefined,
    type: MessageType,
    payload: Uint8Array,
  ) {
    const sealed = await seal(this.keys, type, payload);
    if (this.closed) return;
    if (index === undefined) {
      this.transports.forEach((t, i) => {
        if (this.peers[i]!.size > 0) t.send(sealed);
      });
    } else {
      this.transports[index]!.send(sealed, peerId);
    }
  }

  private emitStatus() {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }
}
