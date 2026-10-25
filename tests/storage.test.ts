import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { currentSpaceId, openSpace } from '../src/storage/local';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
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

describe('local storage', () => {
  it('persists a space across reopen', async () => {
    const first = await openSpace('test-space');
    const list = first.space.createList('Groceries');
    first.space.addItem(list, 'Milk');
    await first.close();

    const second = await openSpace('test-space');
    expect(second.space.getLists().map((l) => l.name)).toEqual(['Groceries']);
    expect(second.space.getList(list)!.items.map((i) => i.text)).toEqual(['Milk']);
    await second.close();
  });

  it('remembers the current space id', () => {
    const storage = new MemoryStorage();
    const id = currentSpaceId(storage);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(currentSpaceId(storage)).toBe(id);
  });

  it('still returns an id when storage throws', () => {
    const broken = new MemoryStorage();
    broken.getItem = () => {
      throw new Error('blocked');
    };
    broken.setItem = () => {
      throw new Error('blocked');
    };
    expect(currentSpaceId(broken)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
