# Threat model

This document says what Lists protects, against whom, and what it does not protect.
It covers the full design. Items marked _(phase N)_ are not built yet; the current
prototype (phases 0–1) stores data only on the device and makes no network requests
at all.

## Assets

1. **List content:** item text, list names, check state, timestamps.
2. **Membership:** who shares a list with whom.
3. **Usage metadata:** when and how often someone edits, and from which IP address.
4. **Integrity:** lists must not be silently changed by someone without access.
5. **The app code itself:** a tampered app could leak everything above.

## Actors

| Actor                             | Capabilities                                   | Trusted?                               |
| --------------------------------- | ---------------------------------------------- | -------------------------------------- |
| Link holder                       | Reads and writes the shared space              | Yes, fully. The link is the credential |
| Read-only link holder _(phase 4)_ | Reads, cannot write                            | For reading only                       |
| Relay / signalling operator       | Sees encrypted messages, room ids, IPs, timing | No                                     |
| Network attacker                  | Sees and alters traffic                        | No                                     |
| Static host (GitHub Pages)        | Serves the app code                            | Partly: see "Supply chain"             |
| Dependency authors                | Code that runs in the app or the build         | Partly: see "Supply chain"             |
| Someone with the unlocked device  | Everything the browser stores                  | Out of scope                           |

## Security goals and how they are met

### Confidentiality of content

- Content is encrypted end to end with AES-256-GCM before it leaves the device
  _(phase 2)_.
- The key exists only in the link fragment and in the browser's local storage. The
  fragment is never sent to the host serving the app.
- Relays receive only ciphertext and a room id derived one-way from the key.

### Integrity

- AES-GCM authenticates every message, so a relay cannot change or forge one without
  the key.
- Associated data binds each message to its room, so messages cannot be replayed
  across rooms.
- Read-only links add per-update signatures, so readers cannot write _(phase 4)_.
- Replaying an old update is harmless: Yjs updates are idempotent.

### Unlinkability and metadata

- No accounts, no e-mail addresses, no phone numbers, no analytics, no telemetry.
- Each space uses its own derived Nostr key, so different lists cannot be linked
  through keys.
- Size-bucket padding hides exactly how much changed _(phase 4)_.
- **Not protected:** relays and signalling servers see the IP addresses of peers and
  when they are active. WebRTC reveals the IP addresses of peers to each other. Users
  who need to hide this can use a VPN or Tor, or run their own relay.

### Availability

- Data is always kept locally in IndexedDB, so the app works without any network.
- Several relays are used at once, so losing one is not fatal _(phase 3)_.
- **Not guaranteed:** public relays may delete data at any time. Snapshots and JSON
  export mitigate this _(phases 3–4)_.
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

- **Strict CSP** (`default-src 'none'`, `script-src 'self'`, `connect-src 'self'`). The
  app cannot load third-party code or send data to any host that is not listed. Phases
  2–3 will add only the specific signalling and relay endpoints, and the user can
  inspect them.
- Few runtime dependencies (currently `yjs`, `y-indexeddb`, `fractional-indexing`),
  exact version pins, a committed lockfile, Dependabot and CodeQL.
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
  history and screenshots. Mitigations: passphrase links and key rotation
  _(phase 4)_.
- Access cannot be revoked for a single person. Rotation moves the space to a new key
  that everyone else must receive again.
- There is no forward secrecy: someone who later obtains the key can decrypt old
  messages still stored on relays. Short relay expiration limits how much is exposed.
