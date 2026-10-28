import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { generateSecret } from '../src/crypto/keys';
import { toBase64Url } from '../src/crypto/encoding';
import { deleteSpaceData, openSpace } from '../src/storage/local';
import { SpaceRegistry } from '../src/storage/spaces';

class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe('IndexedDB persistence', () => {
  it('persists a space across reopen', async () => {
    const first = await openSpace('test-space');
    const list = first.space.createList('Groceries');
    first.space.addItem(list, 'Milk');
    first.space.setName('Home');
    await first.close();

    const second = await openSpace('test-space');
    expect(second.space.getName()).toBe('Home');
    expect(second.space.getLists().map((l) => l.name)).toEqual(['Groceries']);
    expect(second.space.getList(list)!.items.map((i) => i.text)).toEqual(['Milk']);
    await second.close();
  });

  it('deletes a space', async () => {
    const first = await openSpace('to-delete');
    first.space.createList('Gone');
    await first.close();
    await deleteSpaceData('to-delete');
    const again = await openSpace('to-delete');
    expect(again.space.getLists()).toEqual([]);
    await again.close();
  });
});

describe('space registry', () => {
  it('creates a local space on first run and remembers it', () => {
    const storage = new MemoryStorage();
    const id = new SpaceRegistry(storage).currentId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const reloaded = new SpaceRegistry(storage);
    expect(reloaded.currentId).toBe(id);
    expect(reloaded.get(id)!.secret).toBeNull();
  });

  it('adopts the space id stored by phase 1', () => {
    const storage = new MemoryStorage();
    storage.setItem('lists:currentSpace', 'BBBBBBBBBBBBBBBBBBBBBB');
    const registry = new SpaceRegistry(storage);
    expect(registry.currentId).toBe('BBBBBBBBBBBBBBBBBBBBBB');
    expect(registry.list()).toHaveLength(1);
  });

  it('turns a local space into a shared one exactly once', () => {
    const registry = new SpaceRegistry(new MemoryStorage());
    const id = registry.currentId;
    const secret = registry.ensureSecret(id, generateSecret);
    expect(secret).toHaveLength(32);
    expect(registry.ensureSecret(id, generateSecret)).toEqual(secret);
    expect(registry.secretOf(id)).toEqual(secret);
  });

  it('adds shared spaces from links and refuses conflicting secrets', () => {
    const storage = new MemoryStorage();
    const registry = new SpaceRegistry(storage);
    const id = 'CCCCCCCCCCCCCCCCCCCCCC';
    const secret = generateSecret();
    expect(registry.addShared(id, secret)).toBe(true);
    expect(registry.addShared(id, secret)).toBe(true);
    expect(registry.addShared(id, generateSecret())).toBe(false);
    expect(new SpaceRegistry(storage).secretOf(id)).toEqual(secret);
  });

  it('removes spaces and falls back to another one', () => {
    const registry = new SpaceRegistry(new MemoryStorage());
    const first = registry.currentId;
    const second = registry.addLocal();
    registry.setCurrent(second);
    registry.remove(second);
    expect(registry.currentId).toBe(first);
  });

  it('drops corrupted or tampered entries', () => {
    const storage = new MemoryStorage();
    const good = {
      id: 'DDDDDDDDDDDDDDDDDDDDDD',
      secret: toBase64Url(generateSecret()),
      addedAt: 1,
    };
    storage.setItem(
      'lists:spaces',
      JSON.stringify([
        good,
        { id: 'bad' },
        { ...good, id: 'EEEEEEEEEEEEEEEEEEEEEE', secret: 'xx' },
        7,
      ]),
    );
    expect(new SpaceRegistry(storage).list()).toEqual([good]);
    storage.setItem('lists:spaces', '{not json');
    expect(new SpaceRegistry(storage).list()).toEqual([]);
  });

  it('replaces secrets and tracks moved spaces', () => {
    const registry = new SpaceRegistry(new MemoryStorage());
    const id = 'FFFFFFFFFFFFFFFFFFFFFF';
    const oldSecret = generateSecret();
    registry.addShared(id, oldSecret);
    registry.setMoved(id, oldSecret);
    expect(registry.get(id)!.moved).toBe(true);

    const newSecret = generateSecret();
    registry.replaceSecret(id, newSecret);
    expect(registry.get(id)!.moved).toBeUndefined();
    expect(registry.secretOf(id)).toEqual(newSecret);

    // A late "moved" notice for the old key must not affect the new one.
    registry.setMoved(id, oldSecret);
    expect(registry.get(id)!.moved).toBeUndefined();
  });

  it('never lets one tab overwrite what another tab stored', () => {
    const storage = new MemoryStorage();
    const tabA = new SpaceRegistry(storage);
    const tabB = new SpaceRegistry(storage);
    const id = tabA.currentId;
    const secret = tabA.ensureSecret(id, generateSecret);

    // Tab B started before the secret existed, then changes something else.
    tabB.setName(id, 'Renamed in tab B');
    const reloaded = new SpaceRegistry(storage);
    expect(reloaded.secretOf(id)).toEqual(secret);
    expect(reloaded.get(id)!.name).toBe('Renamed in tab B');
    expect(tabB.secretOf(id)).toEqual(secret);
  });

  it('keeps working when storage throws', () => {
    const broken = new MemoryStorage();
    broken.getItem = () => {
      throw new Error('blocked');
    };
    broken.setItem = () => {
      throw new Error('blocked');
    };
    expect(new SpaceRegistry(broken).currentId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
