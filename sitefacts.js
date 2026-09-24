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

/**
 * How many pages of a site to read, beyond the one we were given.
 *
 * A front page is a hero photograph and a sentence. The rooms are on the
 * rooms page, the food is on the restaurant page, and a site that loads an
 * extra stylesheet does it on the page that needs it — so reading only the
 * front page was reading the smallest part of the site and calling it the
 * whole.
 *
 * Four is a compromise with the customer's own server: this runs while
 * somebody watches a spinner, each page is a request, and the returns fall
 * away quickly once the shared stylesheet has been seen. Ordered by what a
 * page is likely to be, not by where it sits in the navigation.
 */
const MAX_PAGES = 4;

/**
 * What a link is probably for, lower being read first.
 *
 * Rooms and food before contact and terms, because this is looking for
 * photographs of the place and the colours the site actually paints with. A
 * privacy policy has neither and is often the longest page on the site.
 */
const WORTH_READING = [
  /\b(rooms?|accommodation|suites?|villas?|chalets?|stay)\b/i,
  /\b(restaurant|dining|food|menu|bar|eat)\b/i,
  /\b(gallery|photos?|facilities|amenities|about)\b/i,
  /\b(events?|weddings?|activities|experiences?)\b/i,
];

const NOT_WORTH_READING =
  /\b(privacy|terms|cookie|legal|sitemap|login|account|cart|checkout|feed|rss|wp-admin|wp-login)\b|\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?)($|\?)/i;

/**
 * Pages on the same site worth reading, best first.
 *
 * Same origin only, and never more than one per path: a site with a language
 * switcher offers the same page in eight languages, and reading all eight is
 * eight requests for one page's worth of colours.
 */
function otherPages(html, base) {
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return [];
  }

  const seen = new Set([new URL(base).pathname.replace(/\/$/, '')]);
  const ranked = [];

  for (const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    let url;
    try {
      url = new URL(m[1], base);
    } catch {
      continue;
    }

    if (url.origin !== origin) continue;
    if (NOT_WORTH_READING.test(url.pathname)) continue;

    // The fragment and the query are the same page wearing a hat.
    url.hash = '';
    url.search = '';
    const path = url.pathname.replace(/\/$/, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);

    const rank = WORTH_READING.findIndex((re) => re.test(path));
    if (rank === -1) continue;
    ranked.push({ url: url.toString(), rank });
  }

  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_PAGES)
    .map((p) => p.url);
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
  const empty = {
    brief: '',
    colours: [],
    logos: [],
    backgrounds: [],
    read: [],
    pages: [],
    note: '',
  };
  if (!pageUrl) return empty;

  const front = await fetchText(pageUrl);
  if (!front.ok) {
    return { ...empty, note: `The site's own files could not be read — ${front.error}.` };
  }

  const base = front.url ?? pageUrl;

  /*
   * The front page, then a few of the pages it links to.
   *
   * Reading one page was reading the smallest part of a site: the front page
   * is a hero and a sentence, and the rooms, the food and half the
   * photographs are behind the navigation. Each page also brings whatever
   * stylesheet it loads that the front page did not.
   */
  const pages = [{ url: base, html: front.text }];
  for (const href of otherPages(front.text, base)) {
    const next = await fetchText(href);
    if (next.ok) pages.push({ url: next.url ?? href, html: next.text });
  }

  let css = '';
  const read = [];
  const sheets = new Set();

  for (const page of pages) {
    css += '\n' + inlineCss(page.html);

    for (const href of sheetsOf(page.html, page.url)) {
      // Once per file, not once per page that links it. Every page on a site
      // loads the same theme stylesheet, and reading it five times would be
      // five requests and five copies of the same colours to weigh.
      if (sheets.has(href)) continue;
      sheets.add(href);

      const sheet = await fetchText(href, { maxBytes: MAX_SHEET_BYTES });
      if (sheet.ok) {
        css += '\n' + sheet.text;
        read.push(href);
      }
    }
  }

  /*
   * Images from every page, the front page's first.
   *
   * Order matters here in a way it does not for colours: the candidates are
   * tried in turn until one downloads, and the picture a site puts on its own
   * front page is the one it would choose.
   */
  const logos = [];
  const backgrounds = [];
  for (const page of pages) {
    const found = sitecolours.images(page.html, page.url);
    for (const l of found.logos) if (!logos.some((x) => x.url === l.url)) logos.push(l);
    for (const b of found.backgrounds) {
      if (!backgrounds.some((x) => x.url === b.url)) backgrounds.push(b);
    }
  }

  const palette = sitecolours.palette(css);

  return {
    brief: sitecolours.brief({
      colours: palette.all,
      logos: logos.slice(0, 6),
      backgrounds: backgrounds.slice(0, 8),
    }),
    colours: palette.all,
    named: palette.named,
    logos: logos.slice(0, 6),
    backgrounds: backgrounds.slice(0, 8),
    read,
    pages: pages.map((p) => p.url),
    note: '',
  };
}

module.exports = {
  gather,
  fetchText,
  sheetsOf,
  otherPages,
  inlineCss,
  MAX_SHEETS,
  MAX_PAGES,
  VENDOR_SHEET,
};
