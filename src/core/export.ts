import { MAX_ITEM_TEXT_LENGTH, MAX_LIST_NAME_LENGTH, cleanText, type Space } from './space';

/**
 * Plain JSON export of one space, as a backup that does not depend on relays
 * and as a way to move lists to another device without sharing them. It holds
 * only list content: never keys or links.
 */

export const EXPORT_FORMAT = 'lists-export';
export const EXPORT_VERSION = 1;
/** Files larger than this are rejected before parsing. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_LISTS = 1000;
const MAX_ITEMS_PER_LIST = 10_000;

export interface ExportedItem {
  text: string;
  checked: boolean;
}

export interface ExportedList {
  name: string;
  items: ExportedItem[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  name: string;
  lists: ExportedList[];
}

export class ImportError extends Error {}

export function exportSpace(space: Space, name: string): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    name,
    lists: space.getLists().map((list) => ({
      name: list.name,
      items: list.items.map((item) => ({ text: item.text, checked: item.checked })),
    })),
  };
}

/** A file name such as "lists-groceries-2026-10-26.json". */
export function exportFileName(data: ExportFile): string {
  const slug =
    data.name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'space';
  return `lists-${slug}-${data.exportedAt.slice(0, 10)}.json`;
}

/**
 * Parses and validates an export file. Throws ImportError with a message
 * suitable for the user. Unknown fields are ignored; text is cleaned and
 * length-limited exactly like typed input.
 */
export function parseExport(text: string): ExportFile {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError('The file is too large.');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError('The file is not valid JSON.');
  }
  const root = data as Record<string, unknown> | null;
  if (typeof root !== 'object' || root === null || root.format !== EXPORT_FORMAT) {
    throw new ImportError('This is not a Lists export file.');
  }
  if (root.version !== EXPORT_VERSION) {
    throw new ImportError('This export was made by a newer version of Lists.');
  }
  if (!Array.isArray(root.lists) || root.lists.length > MAX_LISTS) {
    throw new ImportError('The file has no lists, or too many.');
  }

  const lists: ExportedList[] = [];
  for (const raw of root.lists as unknown[]) {
    const list = raw as Record<string, unknown> | null;
    if (typeof list !== 'object' || list === null) continue;
    const name = typeof list.name === 'string' ? cleanText(list.name, MAX_LIST_NAME_LENGTH) : '';
    const rawItems = Array.isArray(list.items) ? (list.items as unknown[]) : [];
    if (rawItems.length > MAX_ITEMS_PER_LIST) throw new ImportError('A list has too many items.');
    const items: ExportedItem[] = [];
    for (const rawItem of rawItems) {
      const item = rawItem as Record<string, unknown> | null;
      if (typeof item !== 'object' || item === null || typeof item.text !== 'string') continue;
      const itemText = cleanText(item.text, MAX_ITEM_TEXT_LENGTH);
      if (itemText) items.push({ text: itemText, checked: item.checked === true });
    }
    lists.push({ name: name || 'Imported list', items });
  }

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : '',
    name: typeof root.name === 'string' ? cleanText(root.name, MAX_LIST_NAME_LENGTH) : '',
    lists,
  };
}

/** Adds the exported lists to a space, after any lists it already has. */
export function importInto(space: Space, data: ExportFile): { lists: number; items: number } {
  let items = 0;
  space.doc.transact(() => {
    for (const list of data.lists) {
      const listId = space.createList(list.name);
      for (const item of list.items) {
        const itemId = space.addItem(listId, item.text);
        if (!itemId) continue;
        if (item.checked) space.setChecked(listId, itemId, true);
        items++;
      }
    }
  });
  return { lists: data.lists.length, items };
}
