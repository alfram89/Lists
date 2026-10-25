import { fromBase64Url, toBase64Url } from './encoding';
import { SECRET_BYTES } from './keys';

/**
 * Share links carry everything needed to join a space in the URL fragment,
 * which browsers never send to the server hosting the app:
 *
 *   https://host/path/#v=1&s=<spaceId>&k=<secret>
 *
 * See docs/PROTOCOL.md, "Share link".
 */

export const LINK_VERSION = '1';
const SPACE_ID = /^[A-Za-z0-9_-]{22}$/;

export interface ShareInfo {
  spaceId: string;
  secret: Uint8Array<ArrayBuffer>;
}

/** `base` is the app URL without fragment, e.g. `location.origin + location.pathname`. */
export function buildShareLink(base: string, info: ShareInfo): string {
  const params = new URLSearchParams({
    v: LINK_VERSION,
    s: info.spaceId,
    k: toBase64Url(info.secret),
  });
  return `${base.split('#')[0]}#${params.toString()}`;
}

/**
 * Parses a URL fragment (with or without the leading '#'). Returns null if it
 * is not a share link, or if any part fails validation.
 */
export function parseShareFragment(fragment: string): ShareInfo | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  if (params.get('v') !== LINK_VERSION) return null;
  const spaceId = params.get('s') ?? '';
  const secret = fromBase64Url(params.get('k') ?? '');
  if (!SPACE_ID.test(spaceId) || !secret || secret.length !== SECRET_BYTES) return null;
  return { spaceId, secret };
}
