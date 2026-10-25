import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Space } from '../core/space';
import { randomId } from '../core/id';

const CURRENT_SPACE_KEY = 'lists:currentSpace';
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

/**
 * Returns the id of the space to open on start, creating one on first run.
 * Phase 1 has a single local space; shared spaces arrive with phase 2.
 */
export function currentSpaceId(storage: Storage | undefined = safeLocalStorage()): string {
  try {
    const existing = storage?.getItem(CURRENT_SPACE_KEY);
    if (existing) return existing;
  } catch {
    // Storage can be blocked (private mode, site data disabled); fall through.
  }
  const id = randomId();
  try {
    storage?.setItem(CURRENT_SPACE_KEY, id);
  } catch {
    // Without localStorage the space id cannot be remembered between sessions.
  }
  return id;
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

function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
