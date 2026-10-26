import { randomId } from '../core/id';
import { fromBase64Url, toBase64Url } from '../crypto/encoding';
import { SECRET_BYTES } from '../crypto/keys';

/**
 * The spaces this device knows about, kept in localStorage:
 *  - local spaces (no secret), which never leave the device, and
 *  - shared spaces, created by sharing or by opening a share link.
 *
 * The secret is stored in plain text, like the list content in IndexedDB.
 * Protecting data on an unlocked device is out of scope (docs/THREAT_MODEL.md).
 */

export interface SpaceRecord {
  id: string;
  /** base64url space secret, or null for a space that has never been shared. */
  secret: string | null;
  addedAt: number;
  /** Cached display name, so the space switcher need not open every space. */
  name?: string;
}

const SPACES_KEY = 'lists:spaces';
const CURRENT_KEY = 'lists:currentSpace';
const SPACE_ID = /^[A-Za-z0-9_-]{22}$/;

function isRecord(value: unknown): value is SpaceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    SPACE_ID.test(r.id) &&
    typeof r.addedAt === 'number' &&
    (r.name === undefined || (typeof r.name === 'string' && r.name.length <= 200)) &&
    (r.secret === null ||
      (typeof r.secret === 'string' && fromBase64Url(r.secret)?.length === SECRET_BYTES))
  );
}

export class SpaceRegistry {
  private records: SpaceRecord[] = [];
  private current: string | null = null;

  constructor(private readonly storage: Storage | undefined = safeLocalStorage()) {
    this.records = this.load();
    this.current = this.read(CURRENT_KEY);
    // Phase 1 stored only the current space id. Adopt it as a local space.
    if (this.current && !this.get(this.current) && SPACE_ID.test(this.current)) {
      this.records.push({ id: this.current, secret: null, addedAt: Date.now() });
      this.save();
    }
  }

  list(): SpaceRecord[] {
    return [...this.records];
  }

  get(id: string): SpaceRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** The space to show. Creates a local space on first run. */
  get currentId(): string {
    if (this.current && this.get(this.current)) return this.current;
    const id = this.records[0]?.id ?? this.addLocal();
    this.setCurrent(id);
    return id;
  }

  setCurrent(id: string): void {
    this.current = id;
    this.write(CURRENT_KEY, id);
  }

  addLocal(): string {
    const id = randomId();
    this.records.push({ id, secret: null, addedAt: Date.now() });
    this.save();
    return id;
  }

  /** Adds a shared space from a link. Returns false if the id is known with a different secret. */
  addShared(id: string, secret: Uint8Array): boolean {
    const encoded = toBase64Url(secret);
    const existing = this.get(id);
    if (existing) return existing.secret === encoded;
    this.records.push({ id, secret: encoded, addedAt: Date.now() });
    this.save();
    return true;
  }

  /** Turns a local space into a shared one. Returns the (new or existing) secret. */
  ensureSecret(id: string, generate: () => Uint8Array): Uint8Array<ArrayBuffer> {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown space ${id}`);
    const existing = record.secret ? fromBase64Url(record.secret) : null;
    if (existing) return existing;
    const secret = new Uint8Array(generate());
    record.secret = toBase64Url(secret);
    this.save();
    return secret;
  }

  setName(id: string, name: string): void {
    const record = this.get(id);
    if (!record || record.name === name) return;
    record.name = name;
    this.save();
  }

  secretOf(id: string): Uint8Array<ArrayBuffer> | null {
    const secret = this.get(id)?.secret;
    return secret ? fromBase64Url(secret) : null;
  }

  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
    if (this.current === id) this.current = null;
  }

  private load(): SpaceRecord[] {
    try {
      const parsed: unknown = JSON.parse(this.read(SPACES_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  private save() {
    this.write(SPACES_KEY, JSON.stringify(this.records));
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string) {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // Storage blocked (private mode, site data disabled): keep working in memory.
    }
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
