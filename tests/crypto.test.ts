import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../src/crypto/encoding';
import { SECRET_BYTES, deriveKeys, generateSecret } from '../src/crypto/keys';
import { MAX_SEALED_BYTES, MessageType, open, paddedLength, seal } from '../src/crypto/seal';
import { buildShareLink, parseShareFragment } from '../src/crypto/link';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (let n = 0; n < 40; n++) {
      const data = crypto.getRandomValues(new Uint8Array(n));
      expect(fromBase64Url(toBase64Url(data))).toEqual(data);
    }
  });

  it('rejects invalid or non-canonical input', () => {
    expect(fromBase64Url('a+b/')).toBeNull(); // standard alphabet
    expect(fromBase64Url('AAA=')).toBeNull(); // padding
    expect(fromBase64Url('A')).toBeNull(); // impossible length
    expect(fromBase64Url('AB')).toBeNull(); // stray bits: canonical form is 'AA'
    expect(fromBase64Url('AA')).toEqual(bytes(0));
  });
});

describe('key derivation', () => {
  it('is deterministic and separates purposes', async () => {
    const secret = generateSecret();
    const a = await deriveKeys(secret);
    const b = await deriveKeys(new Uint8Array(secret));
    expect(a.roomId).toBe(b.roomId);
    expect(a.signalPassword).toBe(b.signalPassword);
    expect(a.roomId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.signalPassword).not.toBe(a.roomId);
    expect(a.encKey.extractable).toBe(false);
  });

  it('gives different rooms for different secrets', async () => {
    const a = await deriveKeys(generateSecret());
    const b = await deriveKeys(generateSecret());
    expect(a.roomId).not.toBe(b.roomId);
  });

  it('matches a fixed test vector', async () => {
    // Guards against accidental changes to labels or parameters, which would
    // silently split every existing shared space.
    const keys = await deriveKeys(new Uint8Array(SECRET_BYTES).fill(7));
    expect(keys.roomId).toMatchInlineSnapshot(
      `"edea8322d48af8f19b5d388a34c584ebf8574c53e5e8a9c905d7adb22b895828"`,
    );
    expect(keys.signalPassword).toMatchInlineSnapshot(
      `"7JOt4KZioVaA2KtKdUgyIzHA0RQMeZ6y1F4M6N7RxsA"`,
    );
  });

  it('rejects secrets of the wrong length', async () => {
    await expect(deriveKeys(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('sealed messages', () => {
  it('round-trips every message type', async () => {
    const keys = await deriveKeys(generateSecret());
    for (const type of Object.values(MessageType)) {
      const payload = crypto.getRandomValues(new Uint8Array(300));
      const sealed = await seal(keys, type, payload);
      expect(await open(keys, sealed)).toEqual({ type, payload });
    }
  });

  it('pads to size buckets so lengths leak little', async () => {
    const keys = await deriveKeys(generateSecret());
    const small = await seal(keys, MessageType.Update, new Uint8Array(1));
    const larger = await seal(keys, MessageType.Update, new Uint8Array(200));
    expect(small.length).toBe(larger.length);
    expect(paddedLength(257)).toBe(1024);
    expect(paddedLength(3 * 1048576 + 1)).toBe(4 * 1048576);
  });

  it('uses a fresh nonce for every message', async () => {
    const keys = await deriveKeys(generateSecret());
    const payload = bytes(1, 2, 3);
    const a = await seal(keys, MessageType.Update, payload);
    const b = await seal(keys, MessageType.Update, payload);
    expect(a).not.toEqual(b);
  });

  it('rejects the wrong key, tampering and garbage', async () => {
    const keys = await deriveKeys(generateSecret());
    const other = await deriveKeys(generateSecret());
    const sealed = await seal(keys, MessageType.Update, bytes(1, 2, 3));

    expect(await open(other, sealed)).toBeNull();

    for (const index of [0, 5, 20, sealed.length - 1]) {
      const tampered = new Uint8Array(sealed);
      tampered[index]! ^= 1;
      expect(await open(keys, tampered)).toBeNull();
    }

    expect(await open(keys, new Uint8Array(10))).toBeNull();
    expect(await open(keys, crypto.getRandomValues(new Uint8Array(400)))).toBeNull();
    expect(await open(keys, new Uint8Array(MAX_SEALED_BYTES + 1))).toBeNull();
  });

  it('binds messages to their room', async () => {
    // Same encryption key but a different room id: the associated data differs.
    const keys = await deriveKeys(generateSecret());
    const sealed = await seal(keys, MessageType.Update, bytes(9));
    expect(await open({ ...keys, roomId: '00'.repeat(32) }, sealed)).toBeNull();
  });
});

describe('share links', () => {
  const spaceId = 'AAAAAAAAAAAAAAAAAAAAAA';

  it('round-trips through the URL fragment', () => {
    const secret = generateSecret();
    const link = buildShareLink('https://example.org/lists/#old', { spaceId, secret });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://example.org/lists/');
    expect(url.search).toBe('');
    expect(parseShareFragment(url.hash)).toEqual({ spaceId, secret });
  });

  it('rejects malformed links', () => {
    const k = toBase64Url(generateSecret());
    expect(parseShareFragment('')).toBeNull();
    expect(parseShareFragment(`#v=2&s=${spaceId}&k=${k}`)).toBeNull();
    expect(parseShareFragment(`#v=1&s=short&k=${k}`)).toBeNull();
    expect(parseShareFragment(`#v=1&s=${spaceId}&k=${k.slice(2)}`)).toBeNull();
    expect(parseShareFragment(`#v=1&s=${spaceId}`)).toBeNull();
    expect(parseShareFragment(`#v=1&s=${spaceId}&k=${k}`)).not.toBeNull();
  });
});
