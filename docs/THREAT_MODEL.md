# Threat model

This document says what Lists protects, against whom, and what it does not protect.
It covers the full design. Items marked _(phase N)_ are not built yet. As of phase 3,
a space that has never been shared stays on the device and makes no network requests
at all. A shared space syncs peer to peer over WebRTC, and public Nostr relays carry
WebRTC signalling and store encrypted changes for people who are offline.

## Assets

1. **List content:** item text, list names, check state, timestamps.
2. **Membership:** who shares a list with whom.
3. **Usage metadata:** when and how often someone edits, and from which IP address.
4. **Integrity:** lists must not be silently changed by someone without access.
5. **The app code itself:** a tampered app could leak everything above.

## Actors

| Actor                              | Capabilities                                   | Trusted?                               |
| ---------------------------------- | ---------------------------------------------- | -------------------------------------- |
| Link holder                        | Reads and writes the shared space              | Yes, fully. The link is the credential |
| Read-only link holder _(deferred)_ | Reads, cannot write                            | For reading only                       |
| Relay / signalling operator        | Sees encrypted messages, room ids, IPs, timing | No                                     |
| STUN server operator               | Sees the IP addresses of peers, and when       | No                                     |
| Network attacker                   | Sees and alters traffic                        | No                                     |
| Static host (GitHub Pages)         | Serves the app code                            | Partly: see "Supply chain"             |
| Dependency authors                 | Code that runs in the app or the build         | Partly: see "Supply chain"             |
| Someone with the unlocked device   | Everything the browser stores                  | Out of scope                           |

## Security goals and how they are met

### Confidentiality of content

- Content is sealed with AES-256-GCM before it leaves the device, on every transport,
  including the WebRTC data channel (which adds its own DTLS encryption).
- The key exists only in the link fragment and in the browser's local storage. The
  fragment is never sent to the host serving the app, and the app removes it from the
  address bar after reading it.
- Signalling relays see only a topic derived one-way from the room id, plus WebRTC
  offers that Trystero encrypts with a password derived from the secret.
- Relays acting as a mailbox store sealed messages: AES-256-GCM ciphertext under a
  pseudonymous author key derived from the secret. They cannot read list content,
  names or check state.
- Transports receive only the public room id and the signalling password, never the
  encryption key.

### Integrity

- AES-GCM authenticates every message, so a relay cannot change or forge one without
  the key. Mailbox events that fail to decrypt are ignored, even when they claim the
  room's author key, so a malicious relay can withhold data but not inject it.
- The Nostr signing key only proves "has the link" to relays. Anyone with the link can
  sign, so it adds no integrity beyond the encryption; it lets honest relays reject
  outsiders who try to overwrite the room's snapshot.
- Associated data binds each message to its room, so messages cannot be replayed
  across rooms.
- Read-only links would add per-update signatures, so readers cannot write
  _(deferred)_.
- Replaying an old update is harmless: Yjs updates are idempotent.

### Unlinkability and metadata

- No accounts, no e-mail addresses, no phone numbers, no analytics, no telemetry.
- Each space uses its own derived Nostr key, so different lists cannot be linked
  through keys.
- Size-bucket padding hides exactly how much changed.
- Only spaces that have been shared ever connect to anything. A local space opens no
  connections, and this is checked by an end-to-end test.
- **Not protected:** signalling relays and STUN servers (Cloudflare, Google) see the
  IP addresses of peers and when they are online. WebRTC reveals the IP addresses of
  peers to each other, which is expected between people who share a list. Users who
  need to hide this can use a VPN or Tor, or run their own relay.
- **Not protected:** mailbox relays see, per room, when changes are made, roughly how
  large they are (padded size buckets) and which IP addresses fetch or publish them.
  They can tell that several IP addresses share one room, but not who the people are
  or what the lists contain.

### Availability

- Data is always kept locally in IndexedDB, so the app works without any network.
- Changes reach people who are offline through the relay mailbox, and peers whose
  networks block direct WebRTC connections still sync through it.
- Five relays are used at once, so losing some is not fatal.
- **Not guaranteed:** public relays may delete data at any time, rate-limit, or go
  away. Every device keeps a full local copy, uploads whatever the relays lack the next
  time it opens the app, and snapshots are refreshed daily while the space is in use.
  JSON export adds a manual backup that does not depend on relays. Export files are
  plain text: they contain list content (never keys), so they should be stored like
  any other private document.
- A malicious relay can withhold or delay events; other relays and direct peer
  connections compensate.
- Browsers can evict site data. The app asks for persistent storage
  (`navigator.storage.persist()`) after the first list is created.

### Untrusted input

- All document content may come from other peers, so readers in `src/core/space.ts`
  validate types and lengths and skip malformed entries instead of crashing.
- Text is rendered only through Svelte's escaping text interpolation. The codebase does
  not use `{@html}`, `innerHTML` or `eval`.
- Text length is capped (list names 200 characters, items 1000).

## Supply chain and app integrity

A compromised build or host could ship code that sends keys elsewhere. This is the
largest residual risk of every web app that does end-to-end encryption, and the main
reason the project keeps its dependency footprint small.

Mitigations:

- **Strict CSP** (`default-src 'none'`, `script-src 'self'`). `connect-src` allows only
  the app itself and the relays in `src/sync/config.ts`; the policy is
  generated from that file, so the code and the policy cannot drift apart. CSP does
  not govern WebRTC, so peer and STUN connections are limited by the code instead.
- Few runtime dependencies: `yjs`, `y-indexeddb`, `fractional-indexing`, `trystero`
  (with `@noble/secp256k1`) and `uqr`. Exact version pins, a committed lockfile,
  install scripts disabled, Dependabot with a cooldown, and CodeQL.
- GitHub Actions use least-privilege tokens and are pinned to commit SHAs.
- Planned: reproducible builds, release attestations, and a downloadable build that can
  be served from your own machine or host.

Limitations:

- GitHub Pages cannot send HTTP headers. The CSP is delivered through `<meta>`, which
  does not support `frame-ancestors`, `report-to` or `sandbox`. Deploy to a host with
  custom headers for those.
- A malicious browser extension can read everything. That is out of scope.

## Known limitations of the link model

- Anyone who gets the link has full access. Links can leak through chat backups, browser
  history and screenshots. Mitigations:
  - **Passphrase-protected links.** The key in the link is encrypted with a key derived
    from a passphrase by Argon2id (64 MiB, 2 passes), which makes guessing expensive
    even on GPUs. A leaked protected link is useless without the passphrase, as long
    as the passphrase is strong and travels separately. A weak passphrase (a single
    common word) can still be guessed offline by anyone holding the link.
  - **Resetting the link** (key rotation) cuts off everyone who only has the old
    link, from then on.
- Access cannot be revoked for a single person. Rotation moves the space to a new key
  that everyone else must receive again. Whoever had the old key keeps what was in the
  space up to that moment, on their device.
- **Taking over a space by link.** Someone who knows a space id (from any old link)
  could send a link with that id and their own key, hoping to receive whatever the
  victim adds later. The app therefore never replaces a known space's key silently:
  the user must confirm "Use the new link", with a warning to accept it only from a
  person they trust.
- Anyone with the old key can send a "moved" notice, which stops syncing on the old
  key. This only affects people who already shared that key with them.
- There is no forward secrecy: someone who later obtains the key can decrypt old
  messages still stored on relays. Updates expire after 14 days, but the latest
  snapshot, which holds the whole space, stays until a relay drops it. Leaving a space
  does not delete it from relays.
