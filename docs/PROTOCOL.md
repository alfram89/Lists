# Protocol specification (draft)

Status: **draft, not implemented.** This describes how phases 2–4 will share and sync
spaces. It is written down before the code so it can be reviewed early. Everything
here may change until version 1 is frozen; every format carries a version number so
it can evolve later without breaking old links.

## Terminology

- **Space**: one Yjs document containing one or more lists. The unit of sharing.
- **Space secret**: 32 random bytes generated with `crypto.getRandomValues`. Whoever
  holds it can read and write the space.
- **Peer**: a browser that has the space open.
- **Relay**: a third-party server (Nostr relay, signalling server) that forwards or
  stores messages but never holds keys.

## Share link

```
https://<host>/<path>/#v=1&s=<spaceId>&k=<secret>
```

| Parameter | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `v`       | Link format version. Currently `1`.                                       |
| `s`       | Space id, 16 random bytes, base64url. Used only locally (IndexedDB name). |
| `k`       | Space secret, 32 bytes, base64url without padding.                        |

The parameters live in the URL **fragment**, which browsers never send to the server
hosting the app. On load, the app reads the fragment, stores the space locally and
then removes the fragment from the address bar with `history.replaceState`. That keeps
it out of screenshots and shoulder-surfing, but not out of browser history.

Planned later (phase 4):

- `r=1`: read-only link. It carries a read key instead of the full secret (see "Access
  levels").
- `p=1`: a passphrase is required. The key is then derived from `k` and the passphrase
  with Argon2id.

## Key derivation

All keys are derived from the space secret with HKDF-SHA-256 (WebCrypto). Each one uses
a distinct `info` label, so a key used for one purpose can never be confused with
another:

| Key        | HKDF info        | Use                                                       |
| ---------- | ---------------- | --------------------------------------------------------- |
| `encKey`   | `lists/v1/enc`   | AES-256-GCM key for every message and snapshot            |
| `roomId`   | `lists/v1/room`  | 32 bytes, hex. Topic name used with relays and signalling |
| `nostrKey` | `lists/v1/nostr` | secp256k1 private key for signing Nostr events            |

The salt is the empty string. That is acceptable because the input is a uniformly
random 256-bit secret.

`roomId` is a one-way function of the secret. A relay that sees the room id cannot use
it to derive `encKey` or to find the link.

## Message format

Every unit of data that leaves the device is a **sealed message**:

```
sealed  = version(1 byte = 0x01) || nonce(12 bytes) || ciphertext
plain   = type(1 byte) || padding-length(varuint) || payload || zero padding
```

- AES-256-GCM with a fresh random 96-bit nonce for each message.
- The associated data is `"lists/v1" || roomId`, which binds the ciphertext to its
  room so it cannot be replayed into another one.
- `type`: `0x01` Yjs update, `0x02` full snapshot (Yjs state as an update), `0x03`
  awareness/presence (optional).
- Padding (phase 4) rounds `plain` up to the next size bucket (256 B, 1 KiB, 4 KiB,
  16 KiB, …) to hide the exact size of edits.

A receiver drops any message that fails to decrypt, has an unknown version or type, or
whose payload Yjs rejects. Invalid messages never reach the document.

## Transports

All transports carry only sealed messages, and implement one interface:

```ts
interface Transport {
  connect(roomId: string): Promise<void>;
  publish(message: Uint8Array): Promise<void>;
  onMessage(handler: (message: Uint8Array) => void): () => void;
  disconnect(): Promise<void>;
}
```

### WebRTC (phase 2)

- Peers meet through Trystero, using the `roomId` as the room name. Signalling runs
  over public Nostr relays or BitTorrent trackers.
- On connect, peers exchange Yjs state vectors and send each other the missing
  updates. After that, every local update is broadcast to all connected peers.
- WebRTC data channels are already encrypted with DTLS. The sealed message format adds
  end-to-end protection against the signalling layer and keeps all transports alike.

### Nostr relays (phase 3)

- **Updates:** regular events (kind in the 1000–9999 range, exact number to be decided)
  tagged `["t", roomId]`, whose `content` is the base64 sealed message. They carry an
  `expiration` tag (NIP-40) of about 30 days.
- **Snapshots:** an addressable event (kind in the 30000–39999 range) with
  `["d", roomId]`. Peers replace it with a fresh snapshot about once a day, or after
  roughly 100 updates. Because Yjs merges are idempotent, two peers writing snapshots at
  the same time cannot lose data: the updates that went into either snapshot are still
  on the relays until they expire.
- **Sync on open:** fetch the snapshot, then updates since the snapshot's `created_at`
  minus a safety margin, merge everything, then subscribe for new events.
- All events are signed with `nostrKey`, which is shared by everyone who has the link.
  Relays see only one pseudonymous key per room and cannot connect it to people.
- Default relay set: 3–5 well-known public relays, user-configurable. A message counts
  as delivered once at least two relays accept it.

## Access levels (phase 4)

- **Full access:** holds the space secret.
- **Read-only:** holds `encKey` and the public half of a write-signing key, but not the
  private half. Writers sign every Yjs update with Ed25519 inside the sealed message,
  and every client verifies the signature before applying it. A read-only peer can
  therefore decrypt but cannot produce updates others will accept.
- **Key rotation:** create a new space secret, copy the current state into the new
  room, and leave a final sealed "moved" message in the old room. Only people who are
  given the new link can follow.

## Open questions

- Exact Nostr kinds, and whether to use NIP-59 gift wrapping to hide the room tag.
- How long relays actually keep events in practice, and how that should drive snapshot
  frequency.
- Whether presence (who is viewing) is worth the extra metadata it leaks.
- Whether to replace plain strings with `Y.Text` for item text, so concurrent edits of
  the same item merge character by character instead of last-writer-wins.
