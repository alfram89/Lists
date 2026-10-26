import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Space } from '../src/core/space';
import { deriveKeys, generateSecret, type SpaceKeys } from '../src/crypto/keys';
import { RelayMailbox } from '../src/sync/mailbox';
import type { SocketFactory, SocketLike } from '../src/sync/nostr/relay';
import { NostrRelay } from './support/nostr-relay';

/** Connects the mailbox's WebSockets to in-memory relays, one per URL. */
function network(urls: string[]) {
  const relays = new Map(urls.map((url) => [url, new NostrRelay({ verify: true })]));
  const offline = new Set<string>();
  const sockets = new Set<SocketLike>();

  const factory: SocketFactory = (url) => {
    let client: ReturnType<NostrRelay['connect']> | undefined;
    const socket: SocketLike & { readyState: number } = {
      readyState: 0,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send(data) {
        if (socket.readyState === 1) client?.receive(data);
      },
      close() {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        client?.close();
        sockets.delete(socket);
        setTimeout(() => socket.onclose?.({} as CloseEvent), 0);
      },
    };
    setTimeout(() => {
      if (offline.has(url) || socket.readyState === 3) {
        socket.readyState = 3;
        socket.onclose?.({} as CloseEvent);
        return;
      }
      client = relays.get(url)!.connect((message) =>
        setTimeout(() => {
          if (socket.readyState === 1) socket.onmessage?.({ data: message } as MessageEvent);
        }, 0),
      );
      socket.readyState = 1;
      sockets.add(socket);
      socket.onopen?.({} as Event);
    }, 0);
    return socket;
  };

  return {
    relays,
    factory,
    /** Takes every relay offline and drops open connections. */
    goOffline() {
      urls.forEach((u) => offline.add(u));
      [...sockets].forEach((s) => s.close());
    },
    goOnline() {
      offline.clear();
    },
  };
}

const URLS = ['wss://relay-a.test', 'wss://relay-b.test'];
const FAST = {
  flushDelayMs: 10,
  peerFlushDelayMs: 200,
  snapshotIdleMs: 50,
  snapshotJitterMs: 10,
  readyGraceMs: 20,
  readyTimeoutMs: 3000,
  retryDelayMs: 100,
};

const mailboxes: RelayMailbox[] = [];
afterEach(() => mailboxes.splice(0).forEach((m) => m.destroy()));

function attach(space: Space, keys: SpaceKeys, net: ReturnType<typeof network>) {
  const mailbox = new RelayMailbox(space.doc, keys, {
    urls: URLS,
    socketFactory: net.factory,
    timing: FAST,
  });
  mailboxes.push(mailbox);
  return mailbox;
}

async function waitFor(condition: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const texts = (space: Space, listId: string) =>
  space.getList(listId)?.items.map((i) => i.text) ?? [];
const isSnapshot = (e: { tags: string[][] }) =>
  e.tags.some((t) => t[0] === 'd' && t[1] === 'snapshot');

describe('relay mailbox', () => {
  it('delivers changes to someone who opens the space later', async () => {
    const keys = await deriveKeys(generateSecret());
    const net = network(URLS);

    const alice = new Space();
    const aliceBox = attach(alice, keys, net);
    await waitFor(() => aliceBox.status.ready);
    const list = alice.createList('Groceries');
    alice.addItem(list, 'Milk');
    await waitFor(() => !aliceBox.status.pending && aliceBox.status.relays === 2);
    aliceBox.destroy();

    // Bob opens the link after Alice has gone.
    const bob = new Space(new Y.Doc());
    const bobBox = attach(bob, keys, net);
    await waitFor(() => bobBox.status.ready);
    expect(texts(bob, list)).toEqual(['Milk']);
  });

  it('streams live changes through the relays', async () => {
    const keys = await deriveKeys(generateSecret());
    const net = network(URLS);
    const alice = new Space();
    const bob = new Space(new Y.Doc());
    const a = attach(alice, keys, net);
    const b = attach(bob, keys, net);
    await waitFor(() => a.status.ready && b.status.ready);

    const list = alice.createList('Live');
    alice.addItem(list, 'One');
    await waitFor(() => texts(bob, list).length === 1);
    bob.addItem(list, 'Two');
    await waitFor(() => texts(alice, list).length === 2);
  });

  it('publishes a snapshot that survives expired updates', async () => {
    const keys = await deriveKeys(generateSecret());
    const net = network(URLS);
    const alice = new Space();
    const aliceBox = attach(alice, keys, net);
    await waitFor(() => aliceBox.status.ready);
    const list = alice.createList('Long lived');
    alice.addItem(list, 'Keep me');

    const relayA = net.relays.get(URLS[0]!)!;
    // The edits are followed, once idle, by a snapshot that covers them.
    await waitFor(() => relayA.events.some(isSnapshot) && !aliceBox.needsSnapshot());
    aliceBox.destroy();

    // Updates expire; only the snapshot is left.
    for (const relay of net.relays.values()) relay.removeWhere((e) => !isSnapshot(e));

    const carol = new Space(new Y.Doc());
    const carolBox = attach(carol, keys, net);
    await waitFor(() => carolBox.status.ready);
    expect(texts(carol, list)).toEqual(['Keep me']);
  });

  it('keeps changes made offline and sends them when relays come back', async () => {
    const keys = await deriveKeys(generateSecret());
    const net = network(URLS);
    const alice = new Space();
    const aliceBox = attach(alice, keys, net);
    await waitFor(() => aliceBox.status.ready && aliceBox.status.relays === 2);

    net.goOffline();
    await waitFor(() => aliceBox.status.relays === 0);
    const list = alice.createList('Offline');
    alice.addItem(list, 'Written in a tunnel');
    await new Promise((r) => setTimeout(r, 50));
    expect(aliceBox.status.pending).toBe(true);

    net.goOnline();
    // Reconnection uses exponential backoff, so this can take a few seconds.
    await waitFor(() => !aliceBox.status.pending, 12_000);

    const bob = new Space(new Y.Doc());
    const bobBox = attach(bob, keys, net);
    await waitFor(() => bobBox.status.ready && texts(bob, list).length === 1);
  }, 20_000);

  it('uploads changes from an earlier session that never reached a relay', async () => {
    const keys = await deriveKeys(generateSecret());
    const net = network(URLS);

    // Edits made while the app had no mailbox (e.g. closed before sending).
    const alice = new Space();
    const list = alice.createList('Unsent');
    alice.addItem(list, 'From last time');

    const aliceBox = attach(alice, keys, net);
    await waitFor(() => aliceBox.status.ready);
    await waitFor(() => net.relays.get(URLS[0]!)!.events.some(isSnapshot));

    const bob = new Space(new Y.Doc());
    const bobBox = attach(bob, keys, net);
    await waitFor(() => bobBox.status.ready);
    expect(texts(bob, list)).toEqual(['From last time']);
  });

  it('ignores events it cannot decrypt, even from its own author key', async () => {
    const keys = await deriveKeys(generateSecret());
    const net = network(URLS);
    // A malicious relay serves garbage under the room's author key.
    for (const relay of net.relays.values()) {
      relay.inject({
        id: 'f'.repeat(64),
        pubkey: keys.nostrPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 30078,
        tags: [['d', 'snapshot']],
        content: btoa('not a sealed message'.repeat(5)),
        sig: '0'.repeat(128),
      });
    }
    const alice = new Space();
    const box = attach(alice, keys, net);
    await waitFor(() => box.status.ready);
    expect(alice.getLists()).toEqual([]);
  });

  it('does not republish changes the relays already delivered', async () => {
    const keys = await deriveKeys(generateSecret());
    const net = network(URLS);
    const alice = new Space();
    const bob = new Space(new Y.Doc());
    const a = attach(alice, keys, net);
    const b = attach(bob, keys, net);
    await waitFor(() => a.status.ready && b.status.ready);
    const relayA = net.relays.get(URLS[0]!)!;
    // Let start-up snapshots settle first.
    await new Promise((r) => setTimeout(r, 1200));
    const before = relayA.accepted.length;

    const list = alice.createList('Once');
    await waitFor(() => bob.getList(list) !== undefined);
    // Simulate Bob also receiving it over WebRTC (origin: a peer session).
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc), 'peer');
    await new Promise((r) => setTimeout(r, 400));
    const updates = relayA.accepted
      .slice(before)
      .filter((e) => e.tags.some((t) => t[0] === 'd' && t[1]!.startsWith('u:')));
    expect(updates).toHaveLength(1);
    expect(b.status.pending).toBe(false);
  });

  it('does not see spaces with other keys', async () => {
    const net = network(URLS);
    const alice = new Space();
    const aliceBox = attach(alice, await deriveKeys(generateSecret()), net);
    await waitFor(() => aliceBox.status.ready);
    alice.createList('Private');
    await waitFor(() => !aliceBox.status.pending);

    const eve = new Space(new Y.Doc());
    const eveBox = attach(eve, await deriveKeys(generateSecret()), net);
    await waitFor(() => eveBox.status.ready);
    expect(eve.getLists()).toEqual([]);
  });
});
