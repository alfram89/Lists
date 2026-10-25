import type { BrowserContext, WebSocketRoute } from '@playwright/test';

/**
 * A minimal in-memory Nostr relay (NIP-01) for tests. Every WebSocket the app
 * opens to a relay is routed here instead of the internet, so signalling
 * between test browsers is deterministic and offline.
 */

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

type Filter = Record<string, unknown>;

function matches(filter: Filter, event: NostrEvent): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'limit') continue;
    if (key === 'since' && event.created_at < (value as number)) return false;
    if (key === 'until' && event.created_at > (value as number)) return false;
    if (key === 'ids' && !(value as string[]).includes(event.id)) return false;
    if (key === 'authors' && !(value as string[]).includes(event.pubkey)) return false;
    if (key === 'kinds' && !(value as number[]).includes(event.kind)) return false;
    if (key.startsWith('#')) {
      const wanted = value as string[];
      const name = key.slice(1);
      if (!event.tags.some(([tag, tagValue]) => tag === name && wanted.includes(tagValue!)))
        return false;
    }
  }
  return true;
}

const isEphemeral = (kind: number) => kind >= 20000 && kind < 30000;

export class MockRelay {
  private stored: NostrEvent[] = [];
  private subscriptions = new Map<WebSocketRoute, Map<string, Filter[]>>();
  /** Number of WebSocket connections the app has opened. */
  connections = 0;

  async attach(context: BrowserContext) {
    await context.routeWebSocket(/^wss:\/\//, (ws) => this.accept(ws));
  }

  private accept(ws: WebSocketRoute) {
    this.connections++;
    const subs = new Map<string, Filter[]>();
    this.subscriptions.set(ws, subs);
    ws.onClose(() => this.subscriptions.delete(ws));
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as unknown[];
      const [type] = message;
      if (type === 'REQ') {
        const [, subId, ...filters] = message as [string, string, ...Filter[]];
        subs.set(subId, filters);
        for (const event of this.stored) {
          if (filters.some((f) => matches(f, event)))
            ws.send(JSON.stringify(['EVENT', subId, event]));
        }
        ws.send(JSON.stringify(['EOSE', subId]));
      } else if (type === 'CLOSE') {
        subs.delete(message[1] as string);
      } else if (type === 'EVENT') {
        const event = message[1] as NostrEvent;
        ws.send(JSON.stringify(['OK', event.id, true, '']));
        if (!isEphemeral(event.kind)) this.stored.push(event);
        for (const [socket, socketSubs] of this.subscriptions) {
          for (const [subId, filters] of socketSubs) {
            if (filters.some((f) => matches(f, event)))
              socket.send(JSON.stringify(['EVENT', subId, event]));
          }
        }
      }
    });
  }
}
