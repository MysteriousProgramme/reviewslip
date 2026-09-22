'use strict';

const assets = require('./assets');
const sitecolours = require('./sitecolours');

/**
 * Going and looking at a website, so the model does not have to guess.
 *
 * The theme drafter used to hand a model a URL and ask it to read the
 * stylesheets. It cannot: OpenRouter's web_fetch returns the page, not the
 * four files the page links, and even when the CSS is inlined — as it is on
 * the site this was built against, 400kB of it — a model reading a 500kB
 * document is being asked to find four colours among a hundred and seventy
 * five, most of them WordPress presets that are never drawn. What came back
 * were plausible colours rather than the site's, and that is what "colours
 * actually based off the site" was asking to fix.
 *
 * So the fetching happens here, where it can be exact, and the model is given
 * evidence instead of a haystack: the palette the theme publishes by name, the
 * colours painted on real selectors, and a shortlist of logos and photographs
 * with a note on where each came from. The model still chooses — which of
 * these is the ground, which is worth spending on the button — because that is
 * judgement, and it is good at judgement when it can see the facts.
 *
 * Everything fetched goes through assets.js, which already refuses anything
 * that is not https, resolves the host and refuses private addresses, follows
 * redirects by hand so each hop is checked, and caps the bytes.
 */

/** A page this size is already unusual. Past it, nothing is learned. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Stylesheets, and how many are worth following. */
const MAX_SHEET_BYTES = 1024 * 1024;
const MAX_SHEETS = 6;

/**
 * Sheets that are somebody else's and say nothing about this site.
 *
 * A theme loads Bootstrap or Font Awesome and inherits a few hundred declared
 * colours it never uses. Reading those in is how #337ab7 — Bootstrap's default
 * button blue — ends up looking like the most-used colour on a site whose
 * button is a different blue entirely.
 */
const VENDOR_SHEET =
  /bootstrap|font-?awesome|foundicons|normalize|reset\.|jquery|slick|swiper|animate|fontawesome|icons?\.css|googleapis|gstatic/i;

/**
 * Text from a URL, with the same refusals assets.js applies to an image.
 *
 * @returns {Promise<{ok: true, text: string}|{ok: false, error: string}>}
 */
async function fetchText(raw, { maxBytes = MAX_PAGE_BYTES } = {}) {
  const target = assets.parseUrl(raw);
  if (!target.ok) return target;

  let url = target.url;

  for (let hop = 0; hop <= 3; hop++) {
    const allowed = await assets.checkHost(url.hostname);
    if (!allowed.ok) return allowed;

    let response;
    try {
      response = await fetch(url, {
        // By hand, so every hop's address is checked too. An open redirect on
        // a public host is otherwise a way straight into the private network
        // the check above exists to close.
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: {
          Accept: 'text/html,text/css,*/*',
          // Some hosts serve a stub to anything that does not look like a
          // browser, and a stub has no colours in it.
          'User-Agent':
            'Mozilla/5.0 (compatible; Reviewslip/1.0; +https://reviewslip.com)',
        },
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return {
        ok: false,
        error: timedOut ? 'that page took too long' : 'that page could not be reached',
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { ok: false, error: 'that page could not be read' };
      const next = assets.parseUrl(new URL(location, url).toString());
      if (!next.ok) return next;
      url = next.url;
      continue;
    }

    if (!response.ok) {
      return { ok: false, error: `that page answered ${response.status}` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { ok: false, error: 'that page was empty' };

    // Truncated rather than refused. Half a stylesheet still has the palette
    // in it, and the alternative is learning nothing about a large site.
    return { ok: true, text: buffer.subarray(0, maxBytes).toString('utf8'), url: url.toString() };
  }

  return { ok: false, error: 'that page redirects too many times' };
}

/** The stylesheets a page links, absolute and worth reading. */
function sheetsOf(html, base) {
  const out = [];

  for (const tag of String(html).matchAll(/<link[^>]+>/gi)) {
    if (!/rel=["']?stylesheet/i.test(tag[0])) continue;
    const href = tag[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;

    let url;
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!url.startsWith('https://')) continue;
    if (VENDOR_SHEET.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }

  return out.slice(0, MAX_SHEETS);
}

/** Whatever the page inlines, which on a cached WordPress site is most of it. */
function inlineCss(html) {
  return [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join('\n');
}

/**
 * Everything worth knowing about a site's look, ready for the prompt.
 *
 * Never throws and never fails the draft: a site that will not be read leaves
 * the model doing what it did before, which is worse but not nothing. What it
 * must not do is stop somebody getting a theme because their web host was slow.
 *
 * @returns {Promise<{brief: string, colours: object[], logos: object[],
 *   backgrounds: object[], read: string[], note: string}>}
 */
async function gather(pageUrl) {
  const empty = { brief: '', colours: [], logos: [], backgrounds: [], read: [], note: '' };
  if (!pageUrl) return empty;

  const page = await fetchText(pageUrl);
  if (!page.ok) {
    return { ...empty, note: `The site's own files could not be read — ${page.error}.` };
  }

  const base = page.url ?? pageUrl;
  let css = inlineCss(page.text);
  const read = [];

  for (const href of sheetsOf(page.text, base)) {
    const sheet = await fetchText(href, { maxBytes: MAX_SHEET_BYTES });
    if (sheet.ok) {
      css += '\n' + sheet.text;
      read.push(href);
    }
  }

  const found = sitecolours.palette(css);
  const images = sitecolours.images(page.text, base);

  return {
    brief: sitecolours.brief({ colours: found.all, ...images }),
    colours: found.all,
    named: found.named,
    logos: images.logos,
    backgrounds: images.backgrounds,
    read,
    note: '',
  };
}

module.exports = { gather, fetchText, sheetsOf, inlineCss, MAX_SHEETS, VENDOR_SHEET };
