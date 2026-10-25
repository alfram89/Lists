import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MAX_ITEM_TEXT_LENGTH, Space, cleanText } from '../src/core/space';

function texts(space: Space, listId: string): string[] {
  return space.getList(listId)!.items.map((i) => i.text);
}

/** Exchanges all updates between two docs, as a sync transport eventually will. */
function sync(a: Space, b: Space): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
}

describe('lists', () => {
  it('creates, renames and deletes lists in creation order', () => {
    const space = new Space();
    const a = space.createList('Groceries');
    const b = space.createList('  Hardware store ');
    expect(space.getLists().map((l) => l.name)).toEqual(['Groceries', 'Hardware store']);

    space.renameList(a, 'Food');
    space.renameList(a, '   '); // ignored
    expect(space.getList(a)!.name).toBe('Food');

    space.deleteList(b);
    expect(space.getLists().map((l) => l.id)).toEqual([a]);
  });

  it('rejects empty list names', () => {
    expect(() => new Space().createList(' \n ')).toThrow();
  });

  it('moves lists', () => {
    const space = new Space();
    const a = space.createList('A');
    space.createList('B');
    space.createList('C');
    space.moveList(a, 2);
    expect(space.getLists().map((l) => l.name)).toEqual(['B', 'C', 'A']);
  });
});

describe('items', () => {
  it('adds items at the end and ignores blank text', () => {
    const space = new Space();
    const list = space.createList('Groceries');
    space.addItem(list, 'Milk');
    space.addItem(list, 'Bread');
    expect(space.addItem(list, '   ')).toBeUndefined();
    expect(texts(space, list)).toEqual(['Milk', 'Bread']);
  });

  it('cleans and limits free text', () => {
    expect(cleanText('  two\n lines \r\n here ', 100)).toBe('two lines here');
    const space = new Space();
    const list = space.createList('L');
    const id = space.addItem(list, 'x'.repeat(MAX_ITEM_TEXT_LENGTH + 50))!;
    expect(space.getList(list)!.items.find((i) => i.id === id)!.text).toHaveLength(
      MAX_ITEM_TEXT_LENGTH,
    );
  });

  it('checks, unchecks and counts items', () => {
    const space = new Space();
    const list = space.createList('Groceries');
    const milk = space.addItem(list, 'Milk')!;
    space.addItem(list, 'Bread');

    space.setChecked(list, milk, true);
    let view = space.getList(list)!;
    expect(view.openCount).toBe(1);
    expect(view.doneCount).toBe(1);
    expect(view.items.find((i) => i.id === milk)!.checkedAt).toBeTypeOf('number');

    space.uncheckAll(list);
    view = space.getList(list)!;
    expect(view.doneCount).toBe(0);
    expect(view.items.every((i) => i.checkedAt === null)).toBe(true);
  });

  it('edits and deletes items', () => {
    const space = new Space();
    const list = space.createList('L');
    const id = space.addItem(list, 'Mlk')!;
    space.setItemText(list, id, 'Milk');
    expect(texts(space, list)).toEqual(['Milk']);
    space.deleteItem(list, id);
    expect(texts(space, list)).toEqual([]);
  });

  it('clears checked items only', () => {
    const space = new Space();
    const list = space.createList('L');
    const a = space.addItem(list, 'A')!;
    space.addItem(list, 'B');
    const c = space.addItem(list, 'C')!;
    space.setChecked(list, a, true);
    space.setChecked(list, c, true);
    expect(space.clearChecked(list)).toBe(2);
    expect(texts(space, list)).toEqual(['B']);
  });

  it('moves items within their own section', () => {
    const space = new Space();
    const list = space.createList('L');
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => space.addItem(list, t)!);
    space.setChecked(list, b!, true);

    // Open section is A, C, D. Move D to the top of it.
    space.moveItem(list, d!, 0);
    const open = space
      .getList(list)!
      .items.filter((i) => !i.checked)
      .map((i) => i.text);
    expect(open).toEqual(['D', 'A', 'C']);

    space.moveItem(list, a!, 99); // clamped to the end
    expect(
      space
        .getList(list)!
        .items.filter((i) => !i.checked)
        .map((i) => i.text),
    ).toEqual(['D', 'C', 'A']);
    expect(c).toBeDefined();
  });

  it('notifies listeners and stops after unsubscribing', () => {
    const space = new Space();
    let calls = 0;
    const off = space.onChange(() => calls++);
    const list = space.createList('L');
    space.addItem(list, 'A');
    off();
    space.addItem(list, 'B');
    expect(calls).toBe(2);
  });
});

describe('concurrent edits', () => {
  it('merges concurrent additions from two replicas', () => {
    const alice = new Space();
    const list = alice.createList('Groceries');
    const bob = new Space(new Y.Doc());
    sync(alice, bob);

    alice.addItem(list, 'Milk');
    bob.addItem(list, 'Eggs');
    sync(alice, bob);

    // Both added at the end with the same fractional key; the id breaks the tie
    // so both replicas agree on the order.
    expect(texts(alice, list)).toEqual(texts(bob, list));
    expect([...texts(alice, list)].sort()).toEqual(['Eggs', 'Milk']);
  });

  it('can still reorder after concurrent edits produced duplicate keys', () => {
    const alice = new Space();
    const list = alice.createList('L');
    const bob = new Space(new Y.Doc());
    sync(alice, bob);
    alice.addItem(list, 'A');
    bob.addItem(list, 'B');
    sync(alice, bob);
    const third = alice.addItem(list, 'C')!;

    // Moving C between the two items with identical keys forces a renumbering.
    alice.moveItem(list, third, 1);
    sync(alice, bob);
    const order = texts(alice, list);
    expect(order[1]).toBe('C');
    expect(texts(bob, list)).toEqual(order);
    const keys = alice.getList(list)!.items.map((i) => i.order);
    expect(new Set(keys).size).toBe(3);
  });

  it('a check on one replica and an edit on another both survive', () => {
    const alice = new Space();
    const list = alice.createList('L');
    const id = alice.addItem(list, 'Mlk')!;
    const bob = new Space(new Y.Doc());
    sync(alice, bob);

    alice.setChecked(list, id, true);
    bob.setItemText(list, id, 'Milk');
    sync(alice, bob);

    for (const s of [alice, bob]) {
      const item = s.getList(list)!.items[0]!;
      expect(item.text).toBe('Milk');
      expect(item.checked).toBe(true);
    }
  });
});

describe('untrusted document content', () => {
  it('ignores malformed entries instead of crashing', () => {
    const space = new Space();
    const list = space.createList('L');
    space.addItem(list, 'Valid');

    // Simulate a buggy or malicious peer writing unexpected types.
    const yLists = space.doc.getMap<unknown>('lists');
    yLists.set('bogus', 'not a map');
    const yItems = (yLists.get(list) as Y.Map<unknown>).get('items') as Y.Map<unknown>;
    yItems.set('weird', 42);
    const bad = new Y.Map<unknown>();
    yItems.set('bad', bad);
    bad.set('text', { evil: true });
    bad.set('checked', 'yes');
    bad.set('order', '!!!');

    const view = space.getLists();
    expect(view).toHaveLength(1);
    const items = view[0]!.items;
    expect(items.map((i) => i.text).sort()).toEqual(['', 'Valid']);
    expect(items.every((i) => i.checked === false)).toBe(true);

    // Writing next to an invalid order key still works (renumbers).
    expect(space.addItem(list, 'After')).toBeDefined();
    expect(texts(space, list).at(-1)).toBe('After');
  });
});
