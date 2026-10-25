# Contributing

Thanks for helping out! Lists is a small, privacy-first project, and a few principles
guide every change.

## Principles

1. **No backend that can read data.** Anything that leaves the device is end-to-end
   encrypted, and any server involved must be replaceable.
2. **No tracking.** No analytics, telemetry, third-party fonts, CDNs or ads.
3. **Few dependencies.** Every new runtime dependency is attack surface and needs a
   good reason. Prefer platform APIs (WebCrypto, IndexedDB) and small, focused code.
4. **Treat document content as untrusted.** It can come from other peers.
5. **Accessible and mobile first.** Touch targets of at least 44 px, real form
   controls and labels, and it must work with a keyboard.

## Getting started

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev      # dev server at http://localhost:5173
```

Before opening a pull request, run:

```sh
npm run check         # svelte-check and TypeScript, warnings fail
npm test              # unit tests (Vitest)
npm run format:check  # Prettier
npm run build         # production build
```

CI runs the same commands.

## Project layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). In short: the UI lives in
`src/ui`, all document logic in `src/core` (with tests in `tests/`), and persistence in
`src/storage`.

## Pull requests

- Keep changes focused, and explain the _why_ in the description.
- Add or update tests for changes to `src/core` or `src/storage`.
- Changes to cryptography or the protocol need an update to
  [`docs/PROTOCOL.md`](docs/PROTOCOL.md) and
  [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) in the same pull request.
- Security problems: see [`SECURITY.md`](SECURITY.md) and do not open a public issue.

By contributing you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE).
