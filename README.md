# Lists

Private shopping lists and checklists that you can share with a link. No accounts,
no tracking, and no backend server that can read your lists.

> **Status: early prototype (phases 0–1).** Lists are stored only on your device.
> Encrypted sharing and real-time sync are next. See [`PLAN.md`](PLAN.md).

## Features

- Several lists, each with free-text items you can check off
- Edit, reorder and delete items; "clear completed" and "uncheck all"
- Works offline and can be installed to your home screen (PWA)
- Light and dark mode, follows your system setting
- Nothing is sent anywhere: a strict Content Security Policy blocks all third-party
  requests

Coming next: share a link so others can see and edit the same lists in real time,
end-to-end encrypted, synced peer-to-peer and through public relays that see only
ciphertext.

## How it will work

```
Your browser ──► Yjs CRDT ──► AES-GCM encryption ──► WebRTC (peers online)
                    │                              └► Nostr relays (offline delivery)
                    └► IndexedDB (local copy)
```

The encryption key lives in the part of the link after `#`, which browsers never send
to any server. Details: [`PLAN.md`](PLAN.md), [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev       # start the dev server
npm test          # run unit tests
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
