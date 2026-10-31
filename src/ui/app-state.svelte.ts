import { exportSpace, importInto, parseExport, type ExportFile } from '../core/export';
import type { Space } from '../core/space';
import { deriveKeys, generateSecret } from '../crypto/keys';
import {
  buildProtectedLink,
  buildShareLink,
  parseLink,
  type ProtectedShareInfo,
} from '../crypto/link';
import { unwrapSecret, wrapSecret } from '../crypto/passphrase';
import { deleteSpaceData, openSpace, type OpenSpace } from '../storage/local';
import { SpaceRegistry } from '../storage/spaces';
import { RELAY_URLS } from '../sync/config';
import { localChannelTransport } from '../sync/local-channel';
import { RelayMailbox, type MailboxStatus } from '../sync/mailbox';
import { SyncSession, type SyncStatus } from '../sync/session';
import type { TransportFactory } from '../sync/transport';
import { webrtcTransport } from '../sync/webrtc';

export interface SpaceSummary {
  id: string;
  name: string;
  shared: boolean;
}

/** A link for a space this device already has, but with a different key. */
export interface PendingRekey {
  spaceId: string;
  secret: Uint8Array<ArrayBuffer>;
  name: string;
}

/** How long resetting a link waits for relays to accept the "moved" marker. */
const MOVED_PUBLISH_TIMEOUT_MS = 5000;

const DEFAULT_LOCAL_NAME = 'My lists';
const DEFAULT_SHARED_NAME = 'Shared lists';

/**
 * Owns the open space, its sync session and the registry of known spaces.
 * Components read the reactive fields and call the methods.
 */
export class AppState {
  readonly registry = new SpaceRegistry();
  opened = $state.raw<OpenSpace | null>(null);
  spaceId = $state<string | null>(null);
  /** Bumped on every document change so derived views re-read the space. */
  version = $state(0);
  /** Sync status of the current space, or null if it is not shared. */
  sync = $state<SyncStatus | null>(null);
  /** Relay mailbox status of the current space, or null if it is not shared. */
  relay = $state<MailboxStatus | null>(null);
  spaces = $state<SpaceSummary[]>([]);
  error = $state<string | null>(null);
  notice = $state<string | null>(null);
  /** The current space's link was reset elsewhere; it no longer syncs. */
  moved = $state(false);
  /** A passphrase-protected link waiting for its passphrase. */
  pendingUnlock = $state.raw<ProtectedShareInfo | null>(null);
  /** A link with a new key for a known space, waiting for the user to accept it. */
  pendingRekey = $state.raw<PendingRekey | null>(null);

  private session: SyncSession | null = null;
  private mailbox: RelayMailbox | null = null;
  private cleanups: (() => void)[] = [];
  private switchToken = 0;

  constructor(
    private readonly transports: TransportFactory[] = [localChannelTransport, webrtcTransport],
  ) {}

  get space(): Space | null {
    return this.opened?.space ?? null;
  }

  get spaceName(): string {
    void this.version;
    const id = this.spaceId;
    if (!id || !this.space) return '';
    return this.space.getName() || this.defaultName(id);
  }

  get isShared(): boolean {
    return this.spaceId !== null && this.registry.secretOf(this.spaceId) !== null;
  }

  async start(): Promise<void> {
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    const joined = this.consumeShareLink();
    await this.switchTo(joined ?? this.registry.currentId);
  }

  async switchTo(id: string): Promise<void> {
    const token = ++this.switchToken;
    void this.closeCurrent();
    try {
      const opened = await openSpace(id);
      if (token !== this.switchToken) {
        await opened.close();
        return;
      }
      this.registry.setCurrent(id);
      this.opened = opened;
      this.spaceId = id;
      this.moved = this.registry.get(id)?.moved === true;
      this.cleanups.push(
        opened.space.onChange(() => {
          this.version++;
          this.cacheName();
        }),
      );
      this.version++;
      this.cacheName();
      this.refreshSpaces();
      await this.startSync();
    } catch (error) {
      console.error(error);
      this.error =
        'Could not open local storage. Private browsing or blocked site data can cause this.';
    }
  }

  /** Makes the current space shared (if it is not already) and returns its link. */
  async shareLink(): Promise<string> {
    const id = this.spaceId;
    const space = this.space;
    if (!id || !space) throw new Error('No space open');
    // The name is shared with everyone who joins, so "My lists" would mislead them.
    if (!space.getName()) space.setName(DEFAULT_SHARED_NAME);
    const secret = this.registry.ensureSecret(id, generateSecret);
    if (!this.session) await this.startSync();
    this.refreshSpaces();
    return buildShareLink(this.appUrl(), { spaceId: id, secret });
  }

  /** Like shareLink(), but the key in the link is wrapped with a passphrase. */
  async protectedShareLink(passphrase: string): Promise<string> {
    await this.shareLink();
    const id = this.spaceId!;
    const secret = this.registry.secretOf(id)!;
    const wrapped = await wrapSecret(secret, passphrase, id);
    return buildProtectedLink(this.appUrl(), { spaceId: id, ...wrapped });
  }

  /**
   * Gives the current space a new key and returns the new link. Peers still on
   * the old key are told the space moved; whoever should keep access needs the
   * new link. The old encrypted snapshot on the relays is replaced by the marker.
   */
  async resetShareLink(): Promise<string> {
    const id = this.spaceId;
    if (!id || !this.isShared) throw new Error('Space is not shared');
    const session = this.session;
    const mailbox = this.mailbox;
    const relaysTold = await Promise.race([
      Promise.all([session?.announceMoved(), mailbox?.publishMoved()]).then(
        ([, accepted]) => accepted === true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), MOVED_PUBLISH_TIMEOUT_MS)),
    ]);
    this.stopSync();
    this.registry.replaceSecret(id, generateSecret());
    this.moved = false;
    await this.startSync();
    if (!relaysTold) {
      // The old link is cut off either way (everything new uses the new key),
      // but people on it are not told, and the old encrypted copy stays on the
      // relays until it expires or a relay drops it.
      this.notice =
        'The link was reset, but no relay could be reached to tell the others. The old link ' +
        'gets no new changes, but people using it will not see that it was reset until you ' +
        'send them the new link.';
    }
    return this.shareLink();
  }

  /**
   * Tries a passphrase for the pending protected link. Deriving the key takes a
   * few seconds; if the user cancels meanwhile, the link is not used.
   */
  async unlock(passphrase: string): Promise<'joined' | 'wrong' | 'cancelled'> {
    const pending = this.pendingUnlock;
    if (!pending) return 'cancelled';
    const secret = await unwrapSecret(pending, passphrase, pending.spaceId);
    if (this.pendingUnlock !== pending) return 'cancelled';
    if (!secret) return 'wrong';
    this.pendingUnlock = null;
    const id = this.acceptLink(pending.spaceId, secret);
    if (id) await this.switchTo(id);
    return 'joined';
  }

  cancelUnlock(): void {
    this.pendingUnlock = null;
  }

  /** Accepts a new key for a space this device already has (after a link reset). */
  async confirmRekey(): Promise<void> {
    const pending = this.pendingRekey;
    if (!pending) return;
    this.pendingRekey = null;
    if (this.spaceId === pending.spaceId) await this.closeCurrent();
    this.registry.replaceSecret(pending.spaceId, pending.secret);
    await this.switchTo(pending.spaceId);
  }

  dismissRekey(): void {
    this.pendingRekey = null;
  }

  exportCurrent(): ExportFile | null {
    return this.space ? exportSpace(this.space, this.spaceName) : null;
  }

  /** Imports an export file into a new local space. Throws ImportError on bad files. */
  async importFile(text: string): Promise<void> {
    const data = parseExport(text);
    await this.switchTo(this.registry.addLocal());
    const space = this.space;
    if (!space) return;
    space.setName(data.name || 'Imported lists');
    importInto(space, data);
  }

  async createSpace(): Promise<void> {
    await this.switchTo(this.registry.addLocal());
  }

  renameSpace(name: string): void {
    this.space?.setName(name);
  }

  /** Removes the current space from this device. Others who share it keep their copy. */
  async removeCurrent(): Promise<void> {
    const id = this.spaceId;
    if (!id) return;
    // The database must be closed before it can be deleted.
    await this.closeCurrent();
    this.registry.remove(id);
    await deleteSpaceData(id).catch((error: unknown) => console.error(error));
    await this.switchTo(this.registry.currentId);
  }

  destroy(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    void this.closeCurrent();
  }

  private async startSync() {
    const id = this.spaceId;
    const secret = id ? this.registry.secretOf(id) : null;
    const doc = this.opened?.space.doc;
    if (!id || !secret || !doc || this.session || this.registry.get(id)?.moved) return;
    const token = this.switchToken;
    const keys = await deriveKeys(secret);
    if (token !== this.switchToken || this.session) return;
    const session = new SyncSession(doc, keys, this.transports);
    this.session = session;
    this.sync = session.status;
    this.cleanups.push(session.onStatus((status) => (this.sync = status)));

    const mailbox = new RelayMailbox(doc, keys, { urls: RELAY_URLS });
    this.mailbox = mailbox;
    this.relay = mailbox.status;
    this.cleanups.push(mailbox.onStatus((status) => (this.relay = status)));

    const onMoved = () => {
      if (this.session === session) this.markMoved(id, secret);
    };
    this.cleanups.push(session.onMoved(onMoved), mailbox.onMoved(onMoved));
  }

  /** The key of the open space was retired by someone else: stop syncing it. */
  private markMoved(id: string, secret: Uint8Array) {
    this.registry.setMoved(id, secret);
    this.stopSync();
    this.moved = true;
    this.refreshSpaces();
  }

  private stopSync() {
    this.session?.destroy();
    this.session = null;
    this.sync = null;
    this.mailbox?.destroy();
    this.mailbox = null;
    this.relay = null;
  }

  private closeCurrent(): Promise<void> {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.stopSync();
    const closing = this.opened?.close() ?? Promise.resolve();
    this.opened = null;
    this.spaceId = null;
    this.moved = false;
    return closing.catch((error: unknown) => console.error(error));
  }

  /**
   * Reads a share link from the URL fragment and removes the fragment from the
   * address bar. Returns the space id to open, if it can be opened right away.
   * A protected link waits for its passphrase (pendingUnlock), and a new key
   * for a known space waits for confirmation (pendingRekey).
   */
  private consumeShareLink(): string | null {
    if (!location.hash) return null;
    const link = parseLink(location.hash);
    history.replaceState(history.state, '', location.pathname + location.search);
    if (!link) {
      this.notice = 'That link is not a valid share link.';
      return null;
    }
    if (link.kind === 'protected') {
      this.pendingUnlock = link;
      return null;
    }
    return this.acceptLink(link.spaceId, link.secret);
  }

  private acceptLink(spaceId: string, secret: Uint8Array<ArrayBuffer>): string | null {
    const existing = this.registry.get(spaceId);
    if (existing && this.registry.secretOf(spaceId) !== null && !this.sameSecret(spaceId, secret)) {
      // Never switch keys silently: a link with a known space id and a different
      // key is either a reset link from a friend, or someone trying to take over.
      this.pendingRekey = { spaceId, secret, name: existing.name || DEFAULT_SHARED_NAME };
      return null;
    }
    if (existing && this.registry.secretOf(spaceId) === null) {
      // A local space with the same id cannot happen by accident (ids are random).
      this.notice = 'That link does not match any space on this device.';
      return null;
    }
    this.registry.addShared(spaceId, secret);
    this.refreshSpaces();
    return spaceId;
  }

  private sameSecret(spaceId: string, secret: Uint8Array): boolean {
    const current = this.registry.secretOf(spaceId);
    return current !== null && current.every((b, i) => b === secret[i]);
  }

  private appUrl(): string {
    return location.origin + location.pathname;
  }

  private cacheName() {
    if (!this.spaceId || !this.space) return;
    const name = this.space.getName();
    if (name && this.registry.get(this.spaceId)?.name !== name) {
      this.registry.setName(this.spaceId, name);
      this.refreshSpaces();
    }
  }

  private refreshSpaces() {
    this.spaces = this.registry.list().map((r) => ({
      id: r.id,
      name: r.name || this.defaultName(r.id),
      shared: r.secret !== null,
    }));
  }

  private defaultName(id: string): string {
    return this.registry.secretOf(id) ? DEFAULT_SHARED_NAME : DEFAULT_LOCAL_NAME;
  }

  private readonly onHashChange = () => {
    const joined = this.consumeShareLink();
    if (joined) void this.switchTo(joined);
  };

  // Leave the rooms when the page is hidden for good or put in the back/forward
  // cache, and rejoin if it comes back.
  private readonly onPageHide = () => this.stopSync();
  // Mobile browsers suspend hidden pages, so send pending changes immediately.
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.mailbox?.flushNow();
  };
  private readonly onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void this.startSync();
  };
}
