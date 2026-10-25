import * as Y from 'yjs';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { randomId } from './id';

/**
 * A "space" is one Yjs document holding a set of lists. It is the unit that is
 * stored locally and, from phase 2 on, shared and synced through one link.
 *
 * Document layout (schema version 1):
 *
 *   meta:  Y.Map  { schema: 1 }
 *   lists: Y.Map<listId, Y.Map {
 *            name: string, createdAt: number, order: string,
 *            items: Y.Map<itemId, Y.Map {
 *              text: string, checked: boolean, checkedAt: number | null,
 *              createdAt: number, order: string
 *            }>
 *          }>
 *
 * `order` is a fractional index. Sorting by (order, id) gives every replica the
 * same order, even when two peers generate the same key concurrently.
 *
 * Once sync arrives, data in the document can come from other peers, so every
 * reader below validates types instead of trusting the shape.
 */

export const SCHEMA_VERSION = 1;
export const MAX_LIST_NAME_LENGTH = 200;
export const MAX_ITEM_TEXT_LENGTH = 1000;

export interface Item {
  id: string;
  text: string;
  checked: boolean;
  checkedAt: number | null;
  createdAt: number;
  order: string;
}

export interface List {
  id: string;
  name: string;
  createdAt: number;
  order: string;
  /** All items, sorted by order. */
  items: Item[];
  openCount: number;
  doneCount: number;
}

type YList = Y.Map<unknown>;
type YItem = Y.Map<unknown>;

interface Ordered {
  id: string;
  order: string;
}

export class Space {
  readonly doc: Y.Doc;
  private readonly lists: Y.Map<YList>;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.lists = doc.getMap<YList>('lists');
    const meta = doc.getMap<unknown>('meta');
    if (!meta.has('schema')) meta.set('schema', SCHEMA_VERSION);
  }

  /** Calls `listener` after every change, local or remote. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    const handler = () => listener();
    this.lists.observeDeep(handler);
    return () => this.lists.unobserveDeep(handler);
  }

  // ---- Reading -------------------------------------------------------------

  getLists(): List[] {
    const result: List[] = [];
    this.lists.forEach((yList, id) => {
      const list = readList(id, yList);
      if (list) result.push(list);
    });
    return sortByOrder(result);
  }

  getList(listId: string): List | undefined {
    const yList = this.lists.get(listId);
    return yList ? readList(listId, yList) : undefined;
  }

  // ---- Lists ---------------------------------------------------------------

  createList(name: string): string {
    const clean = cleanText(name, MAX_LIST_NAME_LENGTH);
    if (!clean) throw new Error('List name must not be empty');
    const id = randomId();
    this.doc.transact(() => {
      const siblings = this.getLists();
      const yList = new Y.Map<unknown>();
      yList.set('name', clean);
      yList.set('createdAt', Date.now());
      yList.set(
        'order',
        this.placeAt(siblings, siblings.length, (id, key) => this.lists.get(id)?.set('order', key)),
      );
      yList.set('items', new Y.Map<YItem>());
      this.lists.set(id, yList);
    });
    return id;
  }

  renameList(listId: string, name: string): void {
    const clean = cleanText(name, MAX_LIST_NAME_LENGTH);
    if (!clean) return;
    this.requireList(listId).set('name', clean);
  }

  deleteList(listId: string): void {
    this.lists.delete(listId);
  }

  /** Moves a list to `toIndex` in the sorted list of lists. */
  moveList(listId: string, toIndex: number): void {
    const yList = this.requireList(listId);
    this.doc.transact(() => {
      const order = this.placeAt(
        this.getLists().filter((l) => l.id !== listId),
        toIndex,
        (id, key) => this.lists.get(id)?.set('order', key),
      );
      yList.set('order', order);
    });
  }

  // ---- Items ---------------------------------------------------------------

  /** Adds an item at the end of the list. Returns its id, or undefined for empty text. */
  addItem(listId: string, text: string): string | undefined {
    const clean = cleanText(text, MAX_ITEM_TEXT_LENGTH);
    if (!clean) return undefined;
    const items = this.requireItems(listId);
    const id = randomId();
    this.doc.transact(() => {
      const siblings = sortByOrder(readItems(items));
      const yItem = new Y.Map<unknown>();
      yItem.set('text', clean);
      yItem.set('checked', false);
      yItem.set('checkedAt', null);
      yItem.set('createdAt', Date.now());
      yItem.set(
        'order',
        this.placeAt(siblings, siblings.length, (id, key) => items.get(id)?.set('order', key)),
      );
      items.set(id, yItem);
    });
    return id;
  }

  setItemText(listId: string, itemId: string, text: string): void {
    const clean = cleanText(text, MAX_ITEM_TEXT_LENGTH);
    if (!clean) return;
    this.requireItem(listId, itemId).set('text', clean);
  }

  setChecked(listId: string, itemId: string, checked: boolean): void {
    const yItem = this.requireItem(listId, itemId);
    this.doc.transact(() => {
      yItem.set('checked', checked);
      yItem.set('checkedAt', checked ? Date.now() : null);
    });
  }

  deleteItem(listId: string, itemId: string): void {
    this.requireItems(listId).delete(itemId);
  }

  /** Removes every checked item from the list. Returns how many were removed. */
  clearChecked(listId: string): number {
    const items = this.requireItems(listId);
    const done = readItems(items).filter((i) => i.checked);
    this.doc.transact(() => done.forEach((i) => items.delete(i.id)));
    return done.length;
  }

  uncheckAll(listId: string): void {
    const items = this.requireItems(listId);
    this.doc.transact(() => {
      for (const item of readItems(items)) {
        if (!item.checked) continue;
        const yItem = items.get(item.id);
        yItem?.set('checked', false);
        yItem?.set('checkedAt', null);
      }
    });
  }

  /**
   * Moves an item to `toIndex` within its own section: the open items or the
   * checked items, whichever the item belongs to. That matches what the UI shows.
   */
  moveItem(listId: string, itemId: string, toIndex: number): void {
    const items = this.requireItems(listId);
    const yItem = this.requireItem(listId, itemId);
    const checked = yItem.get('checked') === true;
    this.doc.transact(() => {
      const section = sortByOrder(readItems(items)).filter(
        (i) => i.id !== itemId && i.checked === checked,
      );
      const order = this.placeAt(section, toIndex, (id, key) => items.get(id)?.set('order', key));
      yItem.set('order', order);
    });
  }

  // ---- Helpers -------------------------------------------------------------

  /**
   * Returns an order key that puts a new entry at `toIndex` among `siblings`
   * (sorted, without the entry being moved). If concurrent edits left two
   * neighbours with the same key, or a peer wrote an invalid key, the siblings are
   * renumbered first via `setOrder`.
   */
  private placeAt(
    siblings: Ordered[],
    toIndex: number,
    setOrder: (id: string, key: string) => void,
  ): string {
    const index = Math.max(0, Math.min(toIndex, siblings.length));
    const prev = siblings[index - 1]?.order ?? null;
    const next = siblings[index]?.order ?? null;
    if (prev === null || next === null || prev < next) {
      try {
        return generateKeyBetween(prev, next);
      } catch {
        // Invalid key from a peer: fall through and renumber.
      }
    }
    const keys = generateNKeysBetween(null, null, siblings.length + 1);
    let k = 0;
    siblings.forEach((s, i) => {
      if (i === index) k++;
      s.order = keys[k++]!;
      setOrder(s.id, s.order);
    });
    return keys[index]!;
  }

  private requireList(listId: string): YList {
    const yList = this.lists.get(listId);
    if (!yList) throw new Error(`Unknown list ${listId}`);
    return yList;
  }

  private requireItems(listId: string): Y.Map<YItem> {
    const items = this.requireList(listId).get('items');
    if (!(items instanceof Y.Map)) throw new Error(`List ${listId} has no items`);
    return items as Y.Map<YItem>;
  }

  private requireItem(listId: string, itemId: string): YItem {
    const yItem = this.requireItems(listId).get(itemId);
    if (!yItem) throw new Error(`Unknown item ${itemId}`);
    return yItem;
  }
}

// ---- Validation and reading --------------------------------------------------

/** Trims, collapses line breaks and limits length. Returns '' for blank input. */
export function cleanText(text: string, maxLength: number): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sortByOrder<T extends Ordered>(entries: T[]): T[] {
  // Plain code unit comparison: fractional-indexing keys must not be compared
  // with localeCompare.
  return entries.sort((a, b) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readList(id: string, yList: unknown): List | undefined {
  if (!(yList instanceof Y.Map)) return undefined;
  const yItems = yList.get('items');
  const items = yItems instanceof Y.Map ? sortByOrder(readItems(yItems as Y.Map<YItem>)) : [];
  const doneCount = items.filter((i) => i.checked).length;
  return {
    id,
    name: str(yList.get('name')).slice(0, MAX_LIST_NAME_LENGTH),
    createdAt: num(yList.get('createdAt')),
    order: str(yList.get('order'), 'a0'),
    items,
    openCount: items.length - doneCount,
    doneCount,
  };
}

function readItems(yItems: Y.Map<YItem>): Item[] {
  const items: Item[] = [];
  yItems.forEach((yItem: unknown, id) => {
    if (!(yItem instanceof Y.Map)) return;
    const checkedAt = yItem.get('checkedAt');
    items.push({
      id,
      text: str(yItem.get('text')).slice(0, MAX_ITEM_TEXT_LENGTH),
      checked: yItem.get('checked') === true,
      checkedAt: typeof checkedAt === 'number' ? checkedAt : null,
      createdAt: num(yItem.get('createdAt')),
      order: str(yItem.get('order'), 'a0'),
    });
  });
  return items;
}
