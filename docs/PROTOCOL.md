# Protocol specification

Status: **version 1, draft.** The share link, key derivation, message format, sync
protocol and the WebRTC and BroadcastChannel transports are implemented (phase 2). The
Nostr mailbox (phase 3) and access levels (phase 4) are still design only. Formats may
change until version 1 is frozen; every format carries a version number so it can
evolve later without breaking old links.

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
hosting the app. On load (and on `hashchange`), the app reads the fragment, stores the
space locally and then removes the fragment from the address bar with
`history.replaceState`. That keeps it out of screenshots and shoulder-surfing, but not
out of browser history.

Parsing is strict (`src/crypto/link.ts`): `v` must be `1`, `s` must be 22 base64url
characters, and `k` must be canonical unpadded base64url that decodes to exactly 32
bytes. Anything else is rejected and nothing is stored. If the device already knows
the space id with a different secret, the link is ignored.

Planned later (phase 4):

- `r=1`: read-only link. It carries a read key instead of the full secret (see "Access
  levels").
- `p=1`: a passphrase is required. The key is then derived from `k` and the passphrase
  with Argon2id.

## Key derivation

All keys are derived from the space secret with HKDF-SHA-256 (WebCrypto). Each one uses
a distinct `info` label, so a key used for one purpose can never be confused with
another:

| Key              | HKDF info         | Use                                                                |
| ---------------- | ----------------- | ------------------------------------------------------------------ |
| `encKey`         | `lists/v1/enc`    | AES-256-GCM key for every message (non-extractable `CryptoKey`)    |
| `roomId`         | `lists/v1/room`   | 32 bytes, hex. Topic name used with relays and signalling          |
| `signalPassword` | `lists/v1/signal` | 32 bytes, base64url. Trystero encrypts WebRTC offers with it       |
| `nostrKey`       | `lists/v1/nostr`  | _(phase 3)_ secp256k1 private key for signing Nostr mailbox events |

The salt is the empty string. That is acceptable because the input is a uniformly
random 256-bit secret.

Test vector (`tests/crypto.test.ts`): for a secret of 32 bytes all equal to `0x07`,
`roomId` is `edea8322d48af8f19b5d388a34c584ebf8574c53e5e8a9c905d7adb22b895828` and
`signalPassword` is `7JOt4KZioVaA2KtKdUgyIzHA0RQMeZ6y1F4M6N7RxsA`.

`roomId` is a one-way function of the secret. A relay that sees the room id cannot use
it to derive `encKey` or to find the link.

## Message format

Every unit of data that leaves the device is a **sealed message**:

```
sealed  = version (1 byte = 0x01) || nonce (12 bytes) || ciphertext (incl. 16-byte tag)
plain   = type (1 byte) || payload length (uint32, big endian) || payload || zero padding
```

- AES-256-GCM with a fresh random 96-bit nonce for each message.
- The associated data is the UTF-8 string `"lists/v1:" + roomId`, which binds the
  ciphertext to its room so it cannot be replayed into another one.
- Message types:

  | Type   | Name            | Payload                                                 |
  | ------ | --------------- | ------------------------------------------------------- |
  | `0x01` | `Update`        | An incremental Yjs update                               |
  | `0x02` | `StateResponse` | The Yjs updates the requester is missing, as one update |
  | `0x04` | `StateRequest`  | The sender's Yjs state vector                           |

  `0x03` is reserved for presence.

- Padding: `plain` is rounded up to the next size bucket (256 B, 1 KiB, 4 KiB, 16 KiB,
  64 KiB, 256 KiB, 1 MiB, then multiples of 1 MiB). Observers learn only roughly how
  large a change was.
- Sealed messages larger than 8 MiB are dropped before decryption.

A receiver drops any message that fails to decrypt, has an unknown version or type, a
length field that does not fit, or a payload Yjs rejects. Invalid messages never reach
the document.

## Sync

Implemented in `src/sync/session.ts`. Each transport reports peers joining and leaving,
and delivers messages from a specific peer.

1. When a peer joins, each side sends it a `StateRequest` with its own state vector.
2. A `StateRequest` is answered, to that peer only, with a `StateResponse` containing
   exactly the updates the requester lacks (`Y.encodeStateAsUpdate(doc, stateVector)`).
3. Every local change to the document is sealed and broadcast as an `Update` to all
   connected peers on all transports.
4. Updates received from peers are applied but not re-broadcast: every peer sends its
   own changes, and the join handshake covers anything missed.

Yjs updates are idempotent and commutative, so duplicates and reordering are harmless.
Because both sides request state on join, two peers that edited while apart converge
as soon as they meet.

## Transports

All transports carry only sealed messages, and never receive keys other than the
public `roomId` and the `signalPassword` (`src/sync/transport.ts`):

```ts
interface Transport {
  readonly remote: boolean; // other devices (true) or other tabs (false)
  send(data: Uint8Array, peerId?: string): void; // one peer, or all when omitted
  close(): void;
}

type TransportFactory = (
  room: { roomId: string; signalPassword: string },
  events: { onMessage(data, peerId); onPeerJoin(peerId); onPeerLeave(peerId) },
) => Transport;
```

### WebRTC (phase 2, implemented)

`src/sync/webrtc.ts`, using Trystero's Nostr strategy:

- `appId` is `lists-e2ee-v1` and the Trystero room id is `roomId`. Trystero hashes them
  into the topic it announces on the relays.
- Signalling runs over the public Nostr relays listed in `src/sync/config.ts`. Trystero
  encrypts the WebRTC offers and answers it posts there with `signalPassword`, so
  relays cannot read session descriptions or the IP addresses inside them.
- ICE uses public STUN servers (Cloudflare, Google), also listed in
  `src/sync/config.ts`. There is no TURN server, so peers behind some strict NATs
  cannot connect directly. Phase 3 covers them through the Nostr mailbox.
- All sealed messages travel on one Trystero action named `sync`. WebRTC data channels
  are already encrypted with DTLS; sealing adds end-to-end protection that does not
  depend on the signalling layer, and keeps all transports alike.
- The Content Security Policy allows WebSocket connections only to the listed relays.

### BroadcastChannel (phase 2, implemented)

`src/sync/local-channel.ts` syncs tabs of the app in the same browser through a
`BroadcastChannel` named `lists:<roomId>`. Tabs announce themselves with `hello`,
answer with `welcome`, leave with `bye`, and exchange `data` messages that carry sealed
messages, optionally addressed to one tab. The channel is same-origin only; messages
are still sealed so every transport is handled the same way.

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

- Which public relays work best for Trystero signalling in practice. The current list
  is a starting point and will become user-configurable in phase 3.
- Exact Nostr kinds, and whether to use NIP-59 gift wrapping to hide the room tag.
- How long relays actually keep events in practice, and how that should drive snapshot
  frequency.
- Whether presence (who is viewing) is worth the extra metadata it leaks.
- Whether to replace plain strings with `Y.Text` for item text, so concurrent edits of
  the same item merge character by character instead of last-writer-wins.
