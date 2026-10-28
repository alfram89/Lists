import { fromBase64Url, toBase64Url } from './encoding';
import { SECRET_BYTES } from './keys';
import { SALT_BYTES, WRAPPED_BYTES, type WrappedSecret } from './passphrase';

/**
 * Share links carry everything needed to join a space in the URL fragment,
 * which browsers never send to the server hosting the app:
 *
 *   https://host/path/#v=1&s=<spaceId>&k=<secret>               (plain)
 *   https://host/path/#v=1&s=<spaceId>&a=<salt>&w=<wrapped>     (passphrase)
 *
 * See docs/PROTOCOL.md, "Share link".
 */

export const LINK_VERSION = '1';
const SPACE_ID = /^[A-Za-z0-9_-]{22}$/;

export interface ShareInfo {
  spaceId: string;
  secret: Uint8Array<ArrayBuffer>;
}

export interface ProtectedShareInfo extends WrappedSecret {
  spaceId: string;
}

export type ParsedLink =
  ({ kind: 'plain' } & ShareInfo) | ({ kind: 'protected' } & ProtectedShareInfo);

/** `base` is the app URL without fragment, e.g. `location.origin + location.pathname`. */
export function buildShareLink(base: string, info: ShareInfo): string {
  return withFragment(base, { v: LINK_VERSION, s: info.spaceId, k: toBase64Url(info.secret) });
}

export function buildProtectedLink(base: string, info: ProtectedShareInfo): string {
  return withFragment(base, {
    v: LINK_VERSION,
    s: info.spaceId,
    a: toBase64Url(info.salt),
    w: toBase64Url(info.wrapped),
  });
}

function withFragment(base: string, params: Record<string, string>): string {
  return `${base.split('#')[0]}#${new URLSearchParams(params).toString()}`;
}

/**
 * Parses a URL fragment (with or without the leading '#'). Returns null if it
 * is not a share link, or if any part fails validation.
 */
export function parseLink(fragment: string): ParsedLink | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  if (params.get('v') !== LINK_VERSION) return null;
  const spaceId = params.get('s') ?? '';
  if (!SPACE_ID.test(spaceId)) return null;

  if (params.has('k')) {
    const secret = fromBase64Url(params.get('k') ?? '');
    if (!secret || secret.length !== SECRET_BYTES || params.has('a') || params.has('w'))
      return null;
    return { kind: 'plain', spaceId, secret };
  }
  const salt = fromBase64Url(params.get('a') ?? '');
  const wrapped = fromBase64Url(params.get('w') ?? '');
  if (!salt || salt.length !== SALT_BYTES || !wrapped || wrapped.length !== WRAPPED_BYTES)
    return null;
  return { kind: 'protected', spaceId, salt, wrapped };
}

/** Parses a plain link only. Kept for callers that do not handle passphrases. */
export function parseShareFragment(fragment: string): ShareInfo | null {
  const link = parseLink(fragment);
  return link?.kind === 'plain' ? { spaceId: link.spaceId, secret: link.secret } : null;
}
