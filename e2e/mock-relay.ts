import type { BrowserContext } from '@playwright/test';
import { NostrRelay } from '../tests/support/nostr-relay';

/**
 * Routes every WebSocket the app opens to a relay to one in-memory Nostr relay
 * instead of the internet, so tests are deterministic and offline. It serves
 * both WebRTC signalling (Trystero) and the encrypted mailbox.
 */
export class MockRelay extends NostrRelay {
  constructor() {
    super({ verify: true });
  }

  async attach(context: BrowserContext) {
    await context.routeWebSocket(/^wss:\/\//, (ws) => {
      const client = this.connect((message) => ws.send(message));
      ws.onMessage((raw) => client.receive(String(raw)));
      ws.onClose(() => client.close());
    });
  }
}
