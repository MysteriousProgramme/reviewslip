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

/**
 * A background photograph is allowed to be bigger than a logo, because it is a
 * photograph. Still capped hard: it is downloaded to a guest's phone, often on
 * mobile data, before the page is any use to them.
 */
const MAX_BACKGROUND_BYTES = 500 * 1024;
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
async function fetchImage(raw, { maxBytes = MAX_BYTES } = {}) {
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
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: `That image is over ${Math.round(maxBytes / 1024)}kB.` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      return { ok: false, error: `That image is over ${Math.round(maxBytes / 1024)}kB.` };
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

/* -------------------------------------------------------------------- fonts */

const MAX_FONT_BYTES = 300 * 1024;

/**
 * Formats a browser can use, by content type and by extension.
 *
 * Servers are careless about font content types — plenty send
 * application/octet-stream — so the extension is accepted as evidence when the
 * header is unhelpful. The format string matters because it goes into the
 * @font-face rule.
 */
const FONT_FORMATS = {
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'truetype',
  'font/otf': 'opentype',
  'application/font-woff2': 'woff2',
  'application/font-woff': 'woff',
  'application/x-font-woff': 'woff',
  'application/x-font-ttf': 'truetype',
  'application/x-font-opentype': 'opentype',
  'application/vnd.ms-fontobject': 'embedded-opentype',
};

const FONT_EXTENSIONS = {
  '.woff2': 'woff2',
  '.woff': 'woff',
  '.ttf': 'truetype',
  '.otf': 'opentype',
};

/**
 * Font services that license per domain and forbid redistribution outright.
 *
 * Refused rather than downloaded. These are not edge cases — they are how most
 * paid type reaches a website — and serving one of their files from our domain
 * is a licence breach by us, not by the customer whose site it came from. Most
 * of them block the request anyway; refusing first means the customer gets a
 * sentence explaining why instead of a download error.
 *
 * Self-hosted files on the business's own domain are a different matter and are
 * allowed: the business may well hold a licence that covers this, and it is the
 * only party that can know. The dashboard asks it to confirm.
 */
const LICENSED_HOSTS = [
  'use.typekit.net',
  'p.typekit.net',
  'fonts.adobe.com',
  'fast.fonts.net',
  'fast.fonts.com',
  'cloud.typography.com',
  'hello.myfonts.net',
  'webfonts.fontslive.com',
  'f.fontdeck.com',
  'fonts.typotheque.com',
];

/** @returns {string} '' when the host is fine, or why it is not */
function licensedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  const hit = LICENSED_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
  return hit
    ? `${hit} licenses fonts per website, so that file cannot be served from here.`
    : '';
}

/**
 * Downloads a webfont from the business's own site.
 *
 * Same address checks as an image — the URL comes from the same place and is
 * exactly as untrusted — plus the licence check above and a larger ceiling,
 * because a woff2 with a full Latin range is bigger than a logo.
 *
 * @returns {Promise<{ok: true, data: string, format: string, bytes: number}
 *   |{ok: false, error: string}>}
 */
async function fetchFont(raw) {
  const target = parseUrl(raw);
  if (!target.ok) return target;

  const licensed = licensedHost(target.url.hostname);
  if (licensed) return { ok: false, error: licensed };

  const allowed = await checkHost(target.url.hostname);
  if (!allowed.ok) return allowed;

  let response;
  try {
    response = await fetch(target.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Google's font CSS varies by user agent, and so do some self-hosted
      // setups. Asking as a current browser gets woff2 rather than eot.
      headers: {
        Accept: 'font/woff2,font/woff,*/*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      error: timedOut
        ? 'That font took too long to download.'
        : 'Could not download that font.',
    };
  }

  // `follow` was used rather than the manual walk the image fetch does, so the
  // final address is re-checked here instead — a redirect chain that ends
  // somewhere private is the thing being guarded against either way.
  const landed = parseUrl(response.url || target.url.toString());
  if (!landed.ok) return landed;
  const stillAllowed = await checkHost(landed.url.hostname);
  if (!stillAllowed.ok) return stillAllowed;
  const landedLicensed = licensedHost(landed.url.hostname);
  if (landedLicensed) return { ok: false, error: landedLicensed };

  if (!response.ok) {
    return { ok: false, error: `That font address returned ${response.status}.` };
  }

  const type = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const extension = (landed.url.pathname.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const format = FONT_FORMATS[type] || FONT_EXTENSIONS[extension];

  if (!format) {
    return {
      ok: false,
      error: `That is a ${type || extension || 'unknown'} file, not a font we can use.`,
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) return { ok: false, error: 'That font address returned nothing.' };
  if (buffer.length > MAX_FONT_BYTES) {
    return { ok: false, error: `That font is over ${MAX_FONT_BYTES / 1024}kB.` };
  }

  return {
    ok: true,
    format,
    bytes: buffer.length,
    data: buffer.toString('base64'),
  };
}

/** A stored logo, for validation on the way back in. */
const DATA_URI_RE = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,[A-Za-z0-9+/]+=*$/;

function isStoredImage(value, maxBytes = MAX_BYTES) {
  return (
    typeof value === 'string' &&
    DATA_URI_RE.test(value) &&
    // Base64 is about a third larger than the bytes it encodes.
    value.length <= Math.ceil((maxBytes * 4) / 3) + 64
  );
}

/**
 * A stored font, for validation on the way back in.
 *
 * The bytes are kept base64 without a data: wrapper, unlike the logo: they are
 * served as a font file from their own route, never inlined into CSS, so there
 * is no mime type to carry around — the `format` says everything @font-face
 * needs.
 */
function isStoredFont(value) {
  if (!value || typeof value !== 'object') return false;

  const formats = new Set(Object.values(FONT_FORMATS));
  return (
    typeof value.family === 'string' &&
    value.family.length > 0 &&
    value.family.length <= 80 &&
    formats.has(value.format) &&
    typeof value.data === 'string' &&
    /^[A-Za-z0-9+/]+=*$/.test(value.data) &&
    value.data.length <= Math.ceil((MAX_FONT_BYTES * 4) / 3) + 64
  );
}

module.exports = {
  MAX_BYTES,
  MAX_BACKGROUND_BYTES,
  MAX_FONT_BYTES,
  TYPES,
  FONT_FORMATS,
  LICENSED_HOSTS,
  licensedHost,
  isPrivateAddress,
  checkHost,
  parseUrl,
  fetchImage,
  fetchFont,
  isStoredImage,
  isStoredFont,
};
