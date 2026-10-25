# Project plan: Lists

Shared shopping lists and checklists, built with a focus on security and privacy.
Real-time sync between people who share a link, with **no backend we operate and
no server that can read the data**.

## Goals

- Create shopping lists and other checklists made of free-text items you can check off.
- Share one list, or a set of lists, through a link. Anyone with the link can check
  items off and add new ones.
- Lists update in real time for everyone, with no need to send a new link.
- No backend server that we run or that users must trust.
- Strong security and privacy: end-to-end encryption, no accounts, no tracking.
- Open source (AGPL-3.0), hosted on GitHub, deployable as a static site.

## Can this be done without a server?

Mostly yes, with one honest caveat. Two problems rule out a design with literally zero
servers:

1. **Browsers cannot discover each other on their own.** Even pure peer-to-peer
   (WebRTC) needs a rendezvous point for signalling.
2. **People are rarely online at the same time.** If your partner adds "milk" while
   your phone is off, the change has to wait somewhere until you open the app. Pure
   P2P only syncs while both peers are online, and that is a bad fit for shopping
   lists.

The solution is to use **public, decentralised infrastructure that only ever sees
encrypted data**, and to keep it replaceable. A server then becomes a "dumb post
office" that cannot read anything. That is nearly as good as having no server at all,
for security and for privacy.

## Architecture

```
┌──────────── Browser / PWA (static site on GitHub Pages) ───────────────┐
│  UI (Svelte)                                                           │
│  ↕                                                                     │
│  Yjs CRDT document  ←→  IndexedDB (local storage, works offline)       │
│  ↕                                                                     │
│  Encryption layer (WebCrypto, AES-GCM, key from the URL fragment)      │
│  ↕                                   ↕                                 │
│  Transport A: WebRTC P2P          Transport B: Nostr relays            │
│  (real time when peers are online) (encrypted "mailbox" for offline)   │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. Static app, no backend

- A Progressive Web App built with Vite and TypeScript, hosted for free on GitHub
  Pages (or any static host).
- Installable on the home screen and fully usable offline.

### 2. CRDT for real time and conflict-free merging

- **Yjs** (Automerge is the alternative). Several people can check items off and add
  items at the same time, offline too, and the changes merge automatically without
  conflicts.
- Data model (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)):
  ```
  Space (Y.Doc)
   └─ lists: Y.Map<listId, Y.Map{ name, createdAt, order, items }>
                                                      └─ Y.Map<itemId, Y.Map{ text, checked, checkedAt, createdAt, order }>
  ```
- Items are kept in a map keyed by id and sorted by a **fractional index** (`order`).
  Concurrent reordering then never causes duplicates or conflicts.

### 3. The share link is the key

```
https://<user>.github.io/lists/#s=<spaceId>&k=<256-bit key>
```

- Everything after `#` (the fragment) **is never sent to any server**, including the
  static host.
- The following are derived from the key with HKDF:
  - an encryption key (AES-256-GCM),
  - a **room id / topic** that relays cannot link to the content,
  - a signing key pair for Nostr events.
- A link can point to a whole set of lists (a "space") or to a single list. Each list
  can have its own key, so you can share one list without sharing the rest.

The exact format is specified in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

### 4. Transport: two channels that complement each other

**A. WebRTC P2P (real time)**, for example through **Trystero**. It uses existing
public networks (Nostr, BitTorrent trackers, MQTT) for signalling, so we need no
signalling server of our own. When two people have the list open, changes flow
directly between them within milliseconds.

**B. Nostr relays (delivery while the recipient is offline).** Nostr is an open
protocol network with hundreds of independent public relays that store signed events.
This is what lets us avoid running a server of our own:

- Every Yjs update is encrypted and published as an event to 3–5 relays, for
  redundancy.
- From time to time a client publishes an encrypted **snapshot** of the full state (an
  addressable event whose `d` tag is the room id), and old incremental updates are
  allowed to expire (NIP-40).
- When you open the app, it fetches the snapshot and any newer updates, merges them
  locally and subscribes to new changes. That gives real-time updates even without
  P2P.
- Users can choose their own relays, or run one themselves, for example on a
  Raspberry Pi.

**The transport layer is pluggable.** A self-hosted "blind relay" (for example
y-websocket or a Cloudflare Worker) can be added later for people who prefer that. It
would still only ever see ciphertext.

## Security and privacy

The full threat model is in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

| Threat                               | Mitigation                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| A relay or the network reads content | End-to-end encryption (AES-GCM) of every update. The key lives only in the URL fragment                                            |
| A relay links data to people         | Room id derived via HKDF, a separate Nostr key per list (no identity), no accounts                                                 |
| Metadata (size and timing)           | Padding to fixed size buckets and batching of updates. Document clearly that relays can see IP addresses (VPN or Tor can be used)  |
| The link leaks                       | Optional **passphrase** on top of the link (Argon2id). A "rotate key" action that creates a new link and migrates the data         |
| Someone should only view, not edit   | Separate **read-only links**: readers get only the decryption key, and updates must be signed with a write key that clients verify |
| Malicious code (XSS, dependencies)   | Strict CSP, no third-party scripts or analytics, few dependencies, Dependabot, CodeQL, locked versions, SRI                        |
| Tampering with the app               | Reproducible builds, signed releases and GitHub Artifact Attestations. The app can also be downloaded and run locally              |
| Spam into a room                     | Without the key nobody can create valid encrypted updates. Clients drop anything that fails to decrypt or verify                   |

**Honest limitations, which the README must state:**

- Anyone with the link has full access. The link _is_ the password.
- Public relays give no guarantee about how long they keep data. Local storage in
  IndexedDB and periodic snapshots reduce the risk, and JSON export/import works as a
  backup.
- GitHub Pages does not let you set HTTP headers. The CSP therefore lives in a
  `<meta>` tag, where `frame-ancestors` has no effect. For full header control, deploy
  to Cloudflare Pages or Netlify (`_headers`).

## Technology choices

- **Language and build:** TypeScript, Vite, vite-plugin-pwa
- **UI:** Svelte 5 (compiled, small runtime)
- **Sync:** Yjs, y-indexeddb, Trystero, nostr-tools
- **Crypto:** WebCrypto (native). Argon2id via WASM, only for passphrases
- **Tests:** Vitest (unit tests, including crypto) and Playwright (two browsers syncing
  with each other)
- **Licence:** AGPL-3.0

## Repository layout

```
lists/
├─ src/
│  ├─ core/        # data model, Yjs document, operations (add/check/reorder)
│  ├─ crypto/      # key derivation, encryption, signing, link format   (phase 2)
│  ├─ sync/        # pluggable transports: webrtc.ts, nostr.ts          (phases 2–3)
│  ├─ storage/     # IndexedDB persistence, export/import
│  └─ ui/          # Svelte components
├─ tests/
├─ docs/           # ARCHITECTURE.md, PROTOCOL.md, THREAT_MODEL.md
├─ SECURITY.md  CONTRIBUTING.md
└─ .github/        # CI, CodeQL, Pages deploy, Dependabot
```

## Roadmap

### Phase 0: Foundation ✅ (prototype)

- [x] Repository setup: TypeScript, Vite, Svelte, Prettier, svelte-check, Vitest
- [x] CI (check, test, build), CodeQL, Dependabot, GitHub Pages deploy, all with
      least-privilege permissions and actions pinned to commit SHAs
- [x] `SECURITY.md`, `CONTRIBUTING.md`
- [x] Threat model, architecture notes and a draft protocol spec (link format, key
      derivation, versioned message format)

### Phase 1: Local app ✅ (prototype)

- [x] PWA with several lists, free-text items, check/uncheck, reordering, rename,
      delete, "clear completed"
- [x] Yjs data model, persisted to IndexedDB
- [x] Works offline (service worker precaches the app)
- [x] Strict CSP, no third-party requests at all
- [x] Unit tests for the data model

### Phase 2: Sharing and real time

- [ ] Crypto layer and share link (plus a QR code)
- [ ] WebRTC sync via Trystero
- [ ] Playwright test with two browsers

### Phase 3: Offline delivery

- [ ] Nostr transport, snapshots and compaction
- [ ] Relay selection
- [ ] Sync status in the UI ("synced with 3 of 4 relays")

### Phase 4: Hardening

- [ ] Read-only links, passphrases, key rotation
- [ ] Padding of encrypted messages
- [ ] JSON export/import
- [ ] External security review, or peer review of the crypto

### Phase 5: Later

- [ ] Suggestions based on earlier items, categories and store order
- [ ] Dark mode toggle (automatic dark mode already follows the OS), i18n
      (Norwegian/English)
- [ ] Optional self-hostable blind relay as an alternative transport

## Alternatives considered

- **WebRTC P2P only:** simplest, but changes never arrive while the other person is
  offline. Too weak for shopping lists on its own.
- **Data inside the link (compressed JSON in the URL):** fully serverless, but static.
  You would need a new link after every change, so it fails the real-time requirement.
- **Firebase/Supabase:** easy, but locks the project to one vendor and is weaker on
  privacy, even with encryption.
- **A small blind relay of our own:** technically the simplest and most reliable, but
  then someone has to run a server. It is planned as an optional transport, not the
  default.

**Recommendation:** Yjs, end-to-end encryption with the key in the URL fragment,
WebRTC for real time and Nostr relays for offline delivery. That meets every
requirement: no backend of our own, sharing by link, real-time updates and strong
privacy.
