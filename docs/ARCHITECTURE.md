# Architecture

Lists is a static single-page app. There is no backend: all logic runs in the browser,
and data lives in IndexedDB. Shared spaces sync through pluggable, end-to-end encrypted
transports. See [`PLAN.md`](../PLAN.md) for the roadmap and
[`PROTOCOL.md`](PROTOCOL.md) for the wire format.

## Layers

```
src/ui/        Svelte components. Read plain snapshots, call Space methods.
   │           app-state.svelte.ts owns the open space, its sync session and the
   │           registry of spaces.
   │
src/core/      Space: the Yjs document and every operation on it. Pure TypeScript,
   │           no DOM, fully unit tested.
   │
src/storage/   IndexedDB persistence (y-indexeddb) and the registry of known spaces
   │           and their secrets (localStorage).
   │
src/sync/      SyncSession: keeps a Y.Doc in sync over any number of transports.
   │           Transports: WebRTC (Trystero over Nostr) and BroadcastChannel (tabs).
   │           config.ts lists every network endpoint; the CSP is built from it.
   │
src/crypto/    Key derivation (HKDF), sealed messages (AES-GCM), share links.
```

Rules:

- The UI never touches Yjs types directly. It renders `List` and `Item` snapshots
  returned by `Space.getLists()` and re-reads them when `Space.onChange` fires. This
  keeps Yjs details, validation and ordering in one tested place.
- `core` does not know about storage or the network. Persistence and sync attach to the
  `Y.Doc` from outside, which is how Yjs providers are designed to work.
- Everything read from the document is validated, because once sync exists other
  peers can write to it.

## Data model

One space is one `Y.Doc`:

```
meta:  Y.Map  { schema: 1, name?: string }   (name is the space's shared display name)
lists: Y.Map<listId, Y.Map>
         name: string            (max 200 characters)
         createdAt: number       (ms since epoch)
         order: string           (fractional index)
         items: Y.Map<itemId, Y.Map>
                  text: string             (max 1000 characters, single line)
                  checked: boolean
                  checkedAt: number | null
                  createdAt: number
                  order: string            (fractional index)
```

Design notes:

- **Maps plus fractional indexes instead of `Y.Array`.** Moving an item in a `Y.Array`
  means deleting and re-inserting it, so concurrent moves can duplicate it. Changing
  one `order` string never duplicates anything. Ties (two peers generating the same
  key) are broken by id, so every replica sorts the same way. If a move has to go
  between two equal keys, the siblings are renumbered.
- **Ids** are 128-bit random values (base64url), safe to generate offline with no
  coordination.
- **Item text is a plain string,** so the last writer wins if two people edit the same
  item at the same moment. That is acceptable for short shopping items, and can be
  upgraded to `Y.Text` later.
- **Checked items keep their position.** The UI shows them in a separate "Completed"
  section, and unchecking returns an item to where it was.

## Spaces and sharing

A device can hold several spaces. `SpaceRegistry` (`src/storage/spaces.ts`) records
each space's id, its secret if it has been shared, and a cached name for the switcher.

- **Sharing** a space generates its 32-byte secret once, starts a `SyncSession` and
  shows the link (`#v=1&s=<id>&k=<secret>`) with a QR code. All lists in the space are
  shared; the dialog says so. Use a separate space for lists that should stay private.
- **Opening a link** registers the space, removes the fragment from the address bar and
  opens the space. It starts empty and fills as soon as a peer who has it is online.
- **Leaving** a space deletes the local copy and the secret from this device only.

Every shared space runs one `SyncSession` with two transports: BroadcastChannel for
other tabs on the same device, and WebRTC for other devices. Spaces that were never
shared have no session and open no connections.

## Navigation

The app uses `history.pushState` with a state object instead of URL routes. The phone's
back button works, list ids never appear in the URL, and the URL fragment stays free
for share keys.

## Offline and installation

`vite-plugin-pwa` generates a Workbox service worker that precaches the built app (no
runtime caching of anything else). The app is installable and works with no network
from the second visit on.

## Build and deployment

- `npm run build` writes a fully static site to `dist/` with a relative base path, so
  it works on GitHub Pages under `/lists/`, on forks, and on any other static host.
- The production `index.html` gets a strict Content Security Policy `<meta>` tag (see
  `vite.config.ts`).
- `.github/workflows/pages.yml` deploys `main` to GitHub Pages.
