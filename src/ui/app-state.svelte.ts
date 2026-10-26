import type { Space } from '../core/space';
import { deriveKeys, generateSecret } from '../crypto/keys';
import { buildShareLink, parseShareFragment } from '../crypto/link';
import { deleteSpaceData, openSpace, type OpenSpace } from '../storage/local';
import { SpaceRegistry } from '../storage/spaces';
import { localChannelTransport } from '../sync/local-channel';
import { SyncSession, type SyncStatus } from '../sync/session';
import type { TransportFactory } from '../sync/transport';
import { webrtcTransport } from '../sync/webrtc';

export interface SpaceSummary {
  id: string;
  name: string;
  shared: boolean;
}

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
  spaces = $state<SpaceSummary[]>([]);
  error = $state<string | null>(null);
  notice = $state<string | null>(null);

  private session: SyncSession | null = null;
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
    return buildShareLink(location.origin + location.pathname, { spaceId: id, secret });
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
    void this.closeCurrent();
  }

  private async startSync() {
    const id = this.spaceId;
    const secret = id ? this.registry.secretOf(id) : null;
    const doc = this.opened?.space.doc;
    if (!secret || !doc || this.session) return;
    const token = this.switchToken;
    const keys = await deriveKeys(secret);
    if (token !== this.switchToken || this.session) return;
    const session = new SyncSession(doc, keys, this.transports);
    this.session = session;
    this.sync = session.status;
    this.cleanups.push(session.onStatus((status) => (this.sync = status)));
  }

  private stopSync() {
    this.session?.destroy();
    this.session = null;
    this.sync = null;
  }

  private closeCurrent(): Promise<void> {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    this.stopSync();
    const closing = this.opened?.close() ?? Promise.resolve();
    this.opened = null;
    this.spaceId = null;
    return closing.catch((error: unknown) => console.error(error));
  }

  /**
   * Reads a share link from the URL fragment, registers the space and removes
   * the fragment from the address bar. Returns the space id to open, if any.
   */
  private consumeShareLink(): string | null {
    if (!location.hash) return null;
    const info = parseShareFragment(location.hash);
    history.replaceState(history.state, '', location.pathname + location.search);
    if (!info) {
      this.notice = 'That link is not a valid share link.';
      return null;
    }
    if (!this.registry.addShared(info.spaceId, info.secret)) {
      this.notice =
        'This device already has a different copy of that space, so the link was ignored.';
      return null;
    }
    this.refreshSpaces();
    return info.spaceId;
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
  private readonly onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void this.startSync();
  };
}
