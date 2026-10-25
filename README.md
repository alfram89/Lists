# Lists

Private shopping lists and checklists that you can share with a link. No accounts,
no tracking, and no backend server that can read your lists.

> **Status: prototype (phases 0–2).** Sharing works peer to peer while people have
> the app open at the same time. Delivery to people who are offline comes in phase 3.
> See [`PLAN.md`](PLAN.md).

## Features

- Several lists, each with free-text items you can check off
- Edit, reorder and delete items; "clear completed" and "uncheck all"
- **Share a set of lists with a link or QR code.** Everyone with the link sees changes
  in real time and can check off or add items
- End-to-end encrypted: the key is in the link, never on a server
- Several spaces, for example one private and one shared with your household
- Works offline and can be installed to your home screen (PWA)
- Light and dark mode, follows your system setting
- Lists you have not shared never leave your device; a strict Content Security Policy
  blocks everything except the signalling relays

## How it works

```
Your browser ──► Yjs CRDT ──► AES-GCM encryption ──► WebRTC (peers online)
                    │                              └► Nostr relays (offline delivery, phase 3)
                    └► IndexedDB (local copy)
```

Public Nostr relays are only used so devices can find each other (signalling). The
list data itself travels directly between devices, encrypted.

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
