/**
 * Network endpoints the app may contact. Kept in one place because the
 * Content Security Policy in vite.config.ts is generated from this file:
 * nothing outside these lists can be reached.
 *
 * None of these services can read list content. They only ever see
 * encrypted signalling and connection metadata (see docs/THREAT_MODEL.md).
 */

/** Identifies this app's rooms to Trystero. Changing it splits the network. */
export const APP_ID = 'lists-e2ee-v1';

/**
 * Public Nostr relays used for WebRTC signalling (Trystero). Peers find each
 * other here and exchange encrypted connection offers; no list data passes
 * through them. Phase 3 will make this user-configurable.
 */
export const RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.snort.social',
];

/**
 * STUN servers tell a browser its public address so peers behind NAT can
 * connect. They see the IP address but nothing else. There is no TURN server,
 * so some strict networks (certain mobile carriers, corporate firewalls)
 * cannot connect directly; offline delivery through relays in phase 3 covers
 * those cases.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];
