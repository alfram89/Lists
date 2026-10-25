import * as Y from 'yjs';
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import { Space } from '../core/space';

const DB_PREFIX = 'lists-space-';

export interface OpenSpace {
  space: Space;
  persistence: IndexeddbPersistence;
  close: () => Promise<void>;
}

/**
 * Opens a space and keeps it in IndexedDB. Resolves once the stored state has
 * been loaded, so the first render already shows the user's lists.
 */
export async function openSpace(spaceId: string): Promise<OpenSpace> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(DB_PREFIX + spaceId, doc);
  await persistence.whenSynced;
  return {
    space: new Space(doc),
    persistence,
    close: async () => {
      await persistence.destroy();
      doc.destroy();
    },
  };
}

/** Permanently deletes the local copy of a space. */
export async function deleteSpaceData(spaceId: string): Promise<void> {
  await clearDocument(DB_PREFIX + spaceId);
}

/**
 * Asks the browser not to evict our data under storage pressure. Some browsers
 * (notably Safari) otherwise clear site data after a period without visits.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
