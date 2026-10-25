import { randomId } from '../core/id';
import { asBytes, type TransportFactory } from './transport';

/**
 * Syncs between tabs of the app in the same browser through BroadcastChannel.
 * Tabs share IndexedDB, but y-indexeddb does not push live changes between
 * them, so without this an open tab would not see edits made in another.
 *
 * Messages are still sealed: the channel is same-origin only, but keeping
 * every transport identical keeps the sync code simple and auditable.
 */

type ChannelMessage =
  | { kind: 'hello' | 'bye'; from: string }
  | { kind: 'welcome'; from: string; to: string }
  | { kind: 'data'; from: string; to?: string; data: Uint8Array };

function isChannelMessage(value: unknown): value is ChannelMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.from === 'string' &&
    (m.to === undefined || typeof m.to === 'string') &&
    ['hello', 'bye', 'welcome', 'data'].includes(m.kind as string)
  );
}

export const localChannelTransport: TransportFactory = (room, events) => {
  const self = randomId();
  const peers = new Set<string>();
  const channel = new BroadcastChannel(`lists:${room.roomId}`);

  const addPeer = (peerId: string) => {
    if (peers.has(peerId)) return;
    peers.add(peerId);
    events.onPeerJoin(peerId);
  };

  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isChannelMessage(message) || message.from === self) return;
    if ('to' in message && message.to !== undefined && message.to !== self) return;

    switch (message.kind) {
      case 'hello':
        channel.postMessage({ kind: 'welcome', from: self, to: message.from });
        addPeer(message.from);
        break;
      case 'welcome':
        addPeer(message.from);
        break;
      case 'bye':
        if (peers.delete(message.from)) events.onPeerLeave(message.from);
        break;
      case 'data': {
        const data = asBytes(message.data);
        if (data && peers.has(message.from)) events.onMessage(data, message.from);
        break;
      }
    }
  };

  channel.postMessage({ kind: 'hello', from: self });

  return {
    remote: false,
    send(data, peerId) {
      channel.postMessage({ kind: 'data', from: self, to: peerId, data });
    },
    close() {
      channel.postMessage({ kind: 'bye', from: self });
      channel.close();
      peers.clear();
    },
  };
};
