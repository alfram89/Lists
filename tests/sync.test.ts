import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Space } from '../src/core/space';
import { randomId } from '../src/core/id';
import { deriveKeys, generateSecret, type SpaceKeys } from '../src/crypto/keys';
import { SyncSession } from '../src/sync/session';
import { localChannelTransport } from '../src/sync/local-channel';
import type { TransportEvents, TransportFactory } from '../src/sync/transport';

/** An in-memory network: every transport created from it sees every other one. */
function createHub() {
  const members = new Map<string, TransportEvents>();
  const factory: TransportFactory = (_room, events) => {
    const id = randomId();
    for (const [otherId, other] of members) {
      other.onPeerJoin(id);
      events.onPeerJoin(otherId);
    }
    members.set(id, events);
    return {
      remote: true,
      send(data, peerId) {
        for (const [otherId, other] of members) {
          if (otherId === id || (peerId && peerId !== otherId)) continue;
          const copy = data.slice();
          setTimeout(() => other.onMessage(copy, id), 0);
        }
      },
      close() {
        members.delete(id);
        for (const other of members.values()) other.onPeerLeave(id);
      },
    };
  };
  return { factory, members };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sessions: SyncSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.destroy()));

function connect(space: Space, keys: SpaceKeys, factory: TransportFactory) {
  const session = new SyncSession(space.doc, keys, [factory]);
  sessions.push(session);
  return session;
}

const itemTexts = (space: Space, listId: string) =>
  space.getList(listId)?.items.map((i) => i.text) ?? [];

describe('sync session', () => {
  it('brings a new peer up to date and then streams live changes', async () => {
    const keys = await deriveKeys(generateSecret());
    const hub = createHub();

    const alice = new Space();
    const list = alice.createList('Groceries');
    alice.addItem(list, 'Milk');
    const aliceSession = connect(alice, keys, hub.factory);

    const bob = new Space(new Y.Doc());
    const bobSession = connect(bob, keys, hub.factory);

    await waitFor(() => itemTexts(bob, list).length === 1);
    expect(bob.getList(list)!.name).toBe('Groceries');
    expect(aliceSession.status.devices).toBe(1);
    expect(bobSession.status.devices).toBe(1);

    bob.addItem(list, 'Eggs');
    await waitFor(() => itemTexts(alice, list).length === 2);

    const milk = alice.getList(list)!.items[0]!.id;
    alice.setChecked(list, milk, true);
    await waitFor(() => bob.getList(list)!.items[0]!.checked);
  });

  it('merges edits made while disconnected', async () => {
    const keys = await deriveKeys(generateSecret());
    const alice = new Space();
    const list = alice.createList('L');
    const bob = new Space(new Y.Doc());

    // First meeting.
    const hub1 = createHub();
    const a1 = connect(alice, keys, hub1.factory);
    const b1 = connect(bob, keys, hub1.factory);
    await waitFor(() => bob.getList(list) !== undefined);
    a1.destroy();
    b1.destroy();

    // Offline edits on both sides.
    alice.addItem(list, 'From Alice');
    bob.addItem(list, 'From Bob');

    // They meet again.
    const hub2 = createHub();
    connect(alice, keys, hub2.factory);
    connect(bob, keys, hub2.factory);
    await waitFor(() => itemTexts(alice, list).length === 2 && itemTexts(bob, list).length === 2);
    expect(itemTexts(alice, list)).toEqual(itemTexts(bob, list));
  });

  it('ignores peers that do not have the key', async () => {
    const keys = await deriveKeys(generateSecret());
    const intruderKeys = { ...(await deriveKeys(generateSecret())), roomId: keys.roomId };
    const hub = createHub();

    const alice = new Space();
    const list = alice.createList('Private');
    const aliceSession = connect(alice, keys, hub.factory);

    const mallory = new Space(new Y.Doc());
    mallory.createList('Injected');
    connect(mallory, intruderKeys, hub.factory);

    await waitFor(() => aliceSession.dropped > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(alice.getLists().map((l) => l.id)).toEqual([list]);
    expect(mallory.getList(list)).toBeUndefined();
  });

  it('stops sending after destroy', async () => {
    const keys = await deriveKeys(generateSecret());
    const hub = createHub();
    const alice = new Space();
    const list = alice.createList('L');
    const bob = new Space(new Y.Doc());
    const aliceSession = connect(alice, keys, hub.factory);
    connect(bob, keys, hub.factory);
    await waitFor(() => bob.getList(list) !== undefined);

    aliceSession.destroy();
    alice.addItem(list, 'Not sent');
    await new Promise((r) => setTimeout(r, 50));
    expect(itemTexts(bob, list)).toEqual([]);
  });
});

describe('local channel transport', () => {
  it('syncs between tabs over BroadcastChannel', async () => {
    const keys = await deriveKeys(generateSecret());
    const tab1 = new Space();
    const list = tab1.createList('Shared');
    const s1 = connect(tab1, keys, localChannelTransport);
    const tab2 = new Space(new Y.Doc());
    const s2 = connect(tab2, keys, localChannelTransport);

    await waitFor(() => tab2.getList(list) !== undefined);
    expect(s1.status).toEqual({ devices: 0, tabs: 1 });

    tab2.addItem(list, 'Hello from tab 2');
    await waitFor(() => itemTexts(tab1, list).length === 1);

    s2.destroy();
    await waitFor(() => s1.status.tabs === 0);
  });
});
