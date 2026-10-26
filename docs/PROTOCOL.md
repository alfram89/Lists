# Protocol specification

Status: **version 1, draft.** The share link, key derivation, message format, sync
protocol, the WebRTC and BroadcastChannel transports (phase 2) and the Nostr mailbox
(phase 3) are implemented. Access levels (phase 4) are still design only. Formats may
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

| Key              | HKDF info         | Use                                                             |
| ---------------- | ----------------- | --------------------------------------------------------------- |
| `encKey`         | `lists/v1/enc`    | AES-256-GCM key for every message (non-extractable `CryptoKey`) |
| `roomId`         | `lists/v1/room`   | 32 bytes, hex. Topic name used with relays and signalling       |
| `signalPassword` | `lists/v1/signal` | 32 bytes, base64url. Trystero encrypts WebRTC offers with it    |
| `nostrKey`       | `lists/v1/nostr`  | secp256k1 secret key for signing Nostr mailbox events (BIP-340) |

The salt is the empty string. That is acceptable because the input is a uniformly
random 256-bit secret.

If the `nostrKey` output is not a valid secp256k1 secret key (zero or not below the
group order, probability about 2^-128), it is derived again with the info
`lists/v1/nostr/1`, then `/2`, and so on. The matching x-only public key,
`nostrPubkey`, identifies the room on the relays.

Test vector (`tests/crypto.test.ts`): for a secret of 32 bytes all equal to `0x07`,
`roomId` is `edea8322d48af8f19b5d388a34c584ebf8574c53e5e8a9c905d7adb22b895828` and
`signalPassword` is `7JOt4KZioVaA2KtKdUgyIzHA0RQMeZ6y1F4M6N7RxsA` and `nostrPubkey` is
`2e96ae1764d9be7306cd7bc056626d378e89e6fda1223842cbf3d39109466fe7`.

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

### Nostr mailbox (phase 3, implemented)

`src/sync/mailbox.ts` uses the same public relays as an encrypted mailbox, so changes
reach people who are not online at the same time. It runs alongside the peer-to-peer
transports for every shared space; it is not a `Transport`, because relays store
messages rather than connect peers.

**Events.** Every event is NIP-78 application data (kind `30078`), signed by
`nostrPubkey` with `nostrKey`, with the base64 (standard alphabet) sealed message as
`content`. The author key alone identifies the room, so events carry no room tag.
Two kinds, told apart by the `d` tag:

| `d` tag      | Sealed type     | Contents                | Lifetime                                |
| ------------ | --------------- | ----------------------- | --------------------------------------- |
| `snapshot`   | `StateResponse` | The complete space      | Addressable: each one replaces the last |
| `u:<random>` | `Update`        | Changes the relays lack | NIP-40 `expiration` after 14 days       |

**Fetching.** On every (re)connection to a relay:

1. `REQ` `{kinds: [30078], authors: [nostrPubkey], "#d": ["snapshot"], limit: 1}`.
2. After its `EOSE`, `REQ` `{kinds: [30078], authors: [nostrPubkey], since}` where
   `since` is the snapshot's `created_at` minus 10 minutes (clock skew), or 14 days ago
   if there is no snapshot. This subscription stays open for live updates.

Every event is decrypted with `encKey` and applied to the document. Events that fail to
decrypt are ignored, so neither a relay nor anyone without the link can inject data,
even under the room's author key. The mailbox counts as ready once one relay has sent
everything (plus a short grace period for the others), or after 8 seconds.

**Shadow document.** The mailbox keeps a second Y.Doc with everything known to be on
the relays: everything fetched, plus everything a relay accepted from this device.

**Sending.** Local changes are batched for 400 ms. The update sent is the difference
between the local document and the shadow (`Y.encodeStateAsUpdate(doc,
stateVector(shadow))`), not just the newest edits. Yjs cannot apply a change before
every earlier change from the same client, so this keeps edits made before the space
was shared, or while offline, from being stranded. An update is published to every
connected relay; it counts as delivered once any relay answers `OK true`. Otherwise
it is retried when a relay reconnects, or after 30 seconds. When the page is hidden,
pending changes are sent at once, because mobile browsers suspend hidden pages.

Changes that arrived from a peer over WebRTC are forwarded only after 5 seconds, and
nothing is sent if the relays already hold everything (the local document equals the
shadow). The peer normally publishes its own changes, so this avoids duplicates while
still covering a peer that cannot reach any relay.

**Snapshots.** After the first fetch, and after 20 seconds without local edits, a peer
publishes a new snapshot (with a few seconds of random delay, so peers rarely do it at
once) if any of these hold:

- there is no snapshot yet,
- the snapshot is more than 24 hours old,
- there are updates at or after the snapshot's `created_at`,
- the local document has anything the shadow lacks (`Y.equalSnapshots` differs).

Snapshots and updates are both plain Yjs updates, so several peers publishing
snapshots at the same time cannot lose data: each contains everything its author had,
and updates stay on the relays for 14 days while active peers keep snapshots fresh.
Changes that never reached a relay are still in the author's local copy and are
uploaded the next time they open the app.

**Size limit.** Events whose content would exceed 100,000 characters are not sent to
relays (most relays reject events above about 128 KB); they still sync peer to peer.
Shopping lists are far below this.

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
- How long public relays actually keep events in practice, and whether 14 days of
  updates plus a daily snapshot is the right balance.
- User-chosen relays. The CSP currently allows only the built-in list; allowing
  arbitrary relays means allowing any `wss:` host.
- Whether presence (who is viewing) is worth the extra metadata it leaks.
- Whether to replace plain strings with `Y.Text` for item text, so concurrent edits of
  the same item merge character by character instead of last-writer-wins.
