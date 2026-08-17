'use strict';

const dns = require('dns').promises;
const net = require('net');

/**
 * Fetching a business's logo off its own website, once, and safely.
 *
 * The URL comes from a model reading a page, which means it ultimately comes
 * from whatever is on that page — so this is a server making an outbound request
 * to an address a third party controls. On a cloud box that is a route to the
 * instance metadata service and to anything else listening on the private
 * network, so the address is resolved and checked before the request is made,
 * and again on every redirect.
 *
 * Fetched once and stored rather than hotlinked. Hotlinking would put a request
 * to the customer's server on every guest's phone — leaking the guest's address
 * to a third party, and breaking the page the day the customer reorganises their
 * media folder. A logo is a few kilobytes; keeping our own copy is cheaper than
 * either problem.
 */

const MAX_BYTES = 120 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

/**
 * What an <img> can display and what we are willing to store.
 *
 * SVG is allowed because logos are usually SVG and it is by far the smallest
 * option. It is safe *here* specifically because the result is only ever
 * rendered through an <img> tag or a CSS background, and neither runs script or
 * loads subresources from an SVG. It must never be inlined into the DOM as
 * markup — that is a different context with different rules.
 */
const TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

/* ------------------------------------------------------------------ address */

/**
 * Ranges that must never be reachable from a URL someone else supplied.
 *
 * 169.254.169.254 is the one that matters most on EC2 — the instance metadata
 * service, and a well known way to turn "fetch this image" into "hand me your
 * credentials". The rest close the private network behind it.
 */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || // this network
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier NAT
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast and reserved
    );
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    // ::, ::1, unique-local (fc00::/7) and link-local (fe80::/10).
    if (v === '::' || v === '::1') return true;
    if (/^f[cd]/.test(v)) return true;
    if (/^fe[89ab]/.test(v)) return true;
    // An IPv4 address wearing an IPv6 hat still reaches the same host.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
  }

  return false;
}

/**
 * @returns {Promise<{ok: true}|{ok: false, error: string}>}
 */
async function checkHost(hostname) {
  // A literal address skips DNS, and skipping the check with it would be the
  // whole hole.
  if (net.isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? { ok: false, error: 'That address is not reachable.' }
      : { ok: true };
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return { ok: false, error: 'Could not resolve that address.' };
  }

  // Every record, not the first: a name that resolves to one public and one
  // private address is a way to pass the check and connect somewhere else.
  if (!records.length || records.some((r) => isPrivateAddress(r.address))) {
    return { ok: false, error: 'That address is not reachable.' };
  }
  return { ok: true };
}

/** @returns {{ok: true, url: URL}|{ok: false, error: string}} */
function parseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, error: 'That is not a valid image address.' };
  }
  // https only. A logo fetched over http can be swapped in transit, and it would
  // then be served from our own domain with our name on it.
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'The image address must start with https://.' };
  }
  return { ok: true, url };
}

/* -------------------------------------------------------------------- fetch */

/**
 * Downloads an image and returns it as a data URI.
 *
 * @returns {Promise<{ok: true, dataUri: string, bytes: number, type: string}
 *   |{ok: false, error: string}>}
 */
async function fetchImage(raw) {
  let target = parseUrl(raw);
  if (!target.ok) return target;

  let url = target.url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const allowed = await checkHost(url.hostname);
    if (!allowed.ok) return allowed;

    let response;
    try {
      response = await fetch(url, {
        // Followed by hand so each hop's address is checked too — an open
        // redirect on a public host is otherwise a way straight to the private
        // network the check above exists to close.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'image/*' },
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return {
        ok: false,
        error: timedOut
          ? 'That image took too long to download.'
          : 'Could not download that image.',
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, error: 'Could not download that image.' };

      const next = parseUrl(new URL(location, url).toString());
      if (!next.ok) return next;
      url = next.url;
      continue;
    }

    if (!response.ok) {
      return { ok: false, error: `That image address returned ${response.status}.` };
    }

    const type = (response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!TYPES.has(type)) {
      return {
        ok: false,
        error: `That is a ${type || 'unknown'} file, not an image we can use.`,
      };
    }

    // Checked before reading where the server declares it, and again after, in
    // case it lied or did not say.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return { ok: false, error: `That image is over ${MAX_BYTES / 1024}kB.` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      return { ok: false, error: `That image is over ${MAX_BYTES / 1024}kB.` };
    }
    if (!buffer.length) {
      return { ok: false, error: 'That image address returned nothing.' };
    }

    return {
      ok: true,
      type,
      bytes: buffer.length,
      dataUri: `data:${type};base64,${buffer.toString('base64')}`,
    };
  }

  return { ok: false, error: 'That image address redirects too many times.' };
}

/** A stored logo, for validation on the way back in. */
const DATA_URI_RE = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,[A-Za-z0-9+/]+=*$/;

function isStoredImage(value) {
  return (
    typeof value === 'string' &&
    DATA_URI_RE.test(value) &&
    // Base64 is about a third larger than the bytes it encodes.
    value.length <= Math.ceil((MAX_BYTES * 4) / 3) + 64
  );
}

module.exports = {
  MAX_BYTES,
  TYPES,
  isPrivateAddress,
  checkHost,
  parseUrl,
  fetchImage,
  isStoredImage,
};
