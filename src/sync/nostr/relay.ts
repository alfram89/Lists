import { isNostrEvent, type Filter, type NostrEvent } from './event';

/** The parts of WebSocket this module uses, so tests can provide a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export const browserSocket: SocketFactory = (url) => new WebSocket(url);

interface SubscriptionHandlers {
  onEvent(event: NostrEvent): void;
  /** End of stored events (EOSE), or the relay closed the subscription. */
  onEose(): void;
}

const OPEN = 1;
const PUBLISH_TIMEOUT_MS = 10_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * One WebSocket connection to one Nostr relay, with automatic reconnection.
 * Subscriptions are not restored on reconnect: the owner gets `onOpen` again
 * and decides what to request.
 */
export class RelayConnection {
  connected = false;
  private socket: SocketLike | null = null;
  private subscriptions = new Map<string, SubscriptionHandlers>();
  private pendingPublishes = new Map<string, (accepted: boolean) => void>();
  private backoff = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    readonly url: string,
    private readonly createSocket: SocketFactory,
    private readonly callbacks: { onOpen(): void; onStateChange(): void },
  ) {
    this.connect();
  }

  subscribe(subId: string, filters: Filter[], handlers: SubscriptionHandlers): void {
    this.subscriptions.set(subId, handlers);
    this.send(['REQ', subId, ...filters]);
  }

  unsubscribe(subId: string): void {
    if (this.subscriptions.delete(subId)) this.send(['CLOSE', subId]);
  }

  /** Resolves true once the relay accepts the event, false on rejection, timeout or disconnect. */
  publish(event: NostrEvent): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), PUBLISH_TIMEOUT_MS);
      const finish = (accepted: boolean) => {
        clearTimeout(timer);
        this.pendingPublishes.delete(event.id);
        resolve(accepted);
      };
      this.pendingPublishes.set(event.id, finish);
      this.send(['EVENT', event]);
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.dropConnection();
  }

  private connect() {
    if (this.closed) return;
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.backoff = MIN_BACKOFF_MS;
      this.callbacks.onStateChange();
      this.callbacks.onOpen();
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.dropConnection();
      this.scheduleReconnect();
    };
  }

  private dropConnection() {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    this.subscriptions.clear();
    for (const finish of [...this.pendingPublishes.values()]) finish(false);
    if (wasConnected) this.callbacks.onStateChange();
  }

  private scheduleReconnect() {
    if (this.closed) return;
    // Jitter avoids every client hammering a relay that just came back.
    const delay = this.backoff * (0.5 + Math.random());
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(message: unknown[]) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(raw: unknown) {
    if (typeof raw !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, a, b] = message as [unknown, unknown, unknown];

    if (type === 'EVENT' && typeof a === 'string' && isNostrEvent(b)) {
      this.subscriptions.get(a)?.onEvent(b);
    } else if ((type === 'EOSE' || type === 'CLOSED') && typeof a === 'string') {
      const handlers = this.subscriptions.get(a);
      if (type === 'CLOSED') this.subscriptions.delete(a);
      handlers?.onEose();
    } else if (type === 'OK' && typeof a === 'string') {
      this.pendingPublishes.get(a)?.(b === true);
    }
  }
}
