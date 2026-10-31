# Lists

Private shopping lists and checklists that you can share with a link. No accounts,
no tracking, and no backend server that can read your lists.

> **Status: prototype (phases 0–4).** Sharing works in real time between people who
> are online, and changes reach everyone else the next time they open the app.
> See [`PLAN.md`](PLAN.md).

## Features

- Several lists, each with free-text items you can check off
- Edit, reorder and delete items; "clear completed" and "uncheck all"
- **Share a set of lists with a link or QR code.** Everyone with the link sees changes
  in real time and can check off or add items
- End-to-end encrypted: the key is in the link, never on a server
- Optional passphrase on a share link, so a leaked link alone is useless
- Reset a share link to cut off everyone who only has the old one
- Export a space to a JSON file, and import it again
- Several spaces, for example one private and one shared with your household
- Works offline and can be installed to your home screen (PWA)
- Light and dark mode, follows your system setting
- Lists you have not shared never leave your device; a strict Content Security Policy
  blocks every connection except to the app itself and the five relays it uses

## How it works

```
Your browser ──► Yjs CRDT ──► AES-GCM encryption ──► WebRTC (peers online)
                    │                              └► Nostr relays (encrypted mailbox)
                    └► IndexedDB (local copy)
```

When people are online at the same time, changes travel directly between their
devices. Every change is also stored, encrypted, on public Nostr relays, so whoever
opens the app later gets it too. The relays only ever see ciphertext.

The encryption key lives in the part of the link after `#`, which browsers never send
to any server. Details: [`PLAN.md`](PLAN.md), [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev       # start the dev server
npm test          # run unit tests
npm run test:e2e  # run end-to-end tests (Playwright, Chromium)
npm run check     # type-check
npm run build     # production build in dist/
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for guidelines.

## Deployment

The app is a static site. On pushes to `main`, `.github/workflows/pages.yml` publishes
it to GitHub Pages. To enable that, set **Settings → Pages → Source** to **GitHub
Actions**. The `dist/` folder also works on any static host.

## Security

Please report vulnerabilities privately; see [`SECURITY.md`](SECURITY.md).

## License

[AGPL-3.0](LICENSE)
