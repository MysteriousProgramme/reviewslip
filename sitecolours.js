'use strict';

/**
 * The colours a website actually uses, as against the ones it merely declares.
 *
 * This exists because asking a model to "take colours the site uses" does not
 * work, and it took looking at a real customer's site to see why. Their front
 * page carries 175 distinct hex codes. The first two dozen are Gutenberg's
 * stock palette — #ff6900, #cf2e2e, #abb8c3, #0693e3 — which WordPress writes
 * into every page it serves whether a single one is on screen or not, plus the
 * gradient presets and the wp-admin theme colours behind them. The four that
 * are actually rendered (a near-white ground, a white header, grey body text,
 * and one blue call-to-action) are indistinguishable from that noise if all
 * you have is a list of hex codes.
 *
 * So the value is not a colour, it is a colour *plus where it was attached*.
 * `background-color` on `body` is the ground whatever else the file says; a
 * colour that appears only inside a `--wp--preset--color--*` declaration has
 * never been drawn. That distinction is the whole module, and it is what lets
 * a model do the part it is good at — deciding which of four real colours is
 * the highlight — instead of the part it cannot do, which is guessing which of
 * 175 are real.
 *
 * Text in, structured evidence out. Nothing here fetches or touches a browser,
 * so it can be tested against a page saved to disk.
 */

/* --------------------------------------------------------------- colours */

/**
 * WordPress's stock palette, by name.
 *
 * These twelve are written into every page WordPress serves whether one of
 * them is on screen or not, and they are the bulk of the noise: a site with
 * four real colours carries 175 hex codes, and most of the difference is
 * this list plus the gradient presets behind it.
 *
 * By name and not by value, which matters more than it looks. `white` and
 * `black` are in here, and a blanket ban on #ffffff would throw away the
 * header colour of half the sites on the internet. What makes a colour
 * boilerplate is that WordPress named it, not what it happens to equal.
 */
const STOCK = new Set([
  'black', 'cyan-bluish-gray', 'white', 'pale-pink', 'vivid-red',
  'luminous-vivid-orange', 'luminous-vivid-amber', 'light-green-cyan',
  'vivid-green-cyan', 'pale-cyan-blue', 'vivid-cyan-blue', 'vivid-purple',
]);

/** Editor and block chrome. Never rendered on the public page at all. */
const CHROME = /^--(wp-admin|wp-block|wp-bound|wp--style)/i;

/**
 * What a theme variable's own name says it is for.
 *
 * This is the part that turned out to matter. A WordPress theme publishes the
 * palette its owner configured as named custom properties — on the site this
 * was built against, `--wp--preset--color--fl-body-bg: #f2f2f2`,
 * `--wp--preset--color--fl-accent: #2b7bb9`. That is not a colour that has to
 * be inferred from where it is painted. It is the site telling you, in words,
 * which colour is the background and which is the accent, because somebody
 * sat in a theme customiser and chose them.
 *
 * The first version of this file filtered every `--wp--preset--color--*` away
 * as framework noise, which threw out the answer along with the noise. The
 * stock names above are the noise; everything else under that prefix is a
 * theme the owner has configured.
 */
const NAMED = [
  { role: 'ground', re: /(body|page|site|content)[-_]?(bg|background)|^(bg|background)$/i },
  { role: 'header', re: /(header|topbar|nav|menu)[-_]?(bg|background)/i },
  { role: 'text', re: /(body|content)[-_]?(text|color|colour)|^text$/i },
  { role: 'heading', re: /heading|title/i },
  { role: 'highlight', re: /accent|primary|brand|cta|button|btn|link|action/i },
  { role: 'surface', re: /(card|panel|surface|well|box)[-_]?(bg|background)?/i },
];

function namedRole(variable) {
  const found = NAMED.find((n) => n.re.test(variable));
  return found ? found.role : null;
}

/** Properties whose value is a colour worth reading. */
const COLOUR_PROPERTY =
  /^(background|background-color|color|border-color|border-top-color|border-bottom-color|fill|outline-color)$/i;

/**
 * What a selector is for, and how much that is worth.
 *
 * The four slots a theme needs map onto a handful of places every site has,
 * and a colour's selector says which. Weights are coarse on purpose: this
 * orders the evidence, it does not make the decision.
 */
const ROLES = [
  { role: 'ground', weight: 100, re: /(^|,)\s*(html|body)\s*(,|\{|$)/i },
  { role: 'header', weight: 80, re: /(^|[\s,.#])(site-header|masthead|page-header|navbar|topbar|header|nav)\b/i },
  { role: 'highlight', weight: 90, re: /(^|[\s,.#])(btn|button|cta|book|reserve|primary|accent|highlight|submit)\b/i },
  { role: 'footer', weight: 50, re: /(^|[\s,.#])(site-footer|footer)\b/i },
  { role: 'surface', weight: 40, re: /(^|[\s,.#])(card|panel|content|main|wrapper|container|section)\b/i },
];

function role(selector) {
  const found = ROLES.find((r) => r.re.test(selector));
  return found ? { role: found.role, weight: found.weight } : { role: 'other', weight: 10 };
}

/** `#abc`, `#aabbcc`, `rgb(1,2,3)` and `rgba(1,2,3,.5)` to `#rrggbb`. */
function toHex(raw) {
  const value = String(raw || '').trim().toLowerCase();

  const short = value.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;

  const long = value.match(/^#([0-9a-f]{6})$/);
  if (long) return `#${long[1]}`;

  const fn = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/);
  if (fn) {
    // A colour that is nearly transparent was never really drawn, and picking
    // one up as a brand colour produces a palette nobody recognises.
    const alpha = fn[4] === undefined ? 1 : parseFloat(fn[4]) / (fn[4].includes('%') ? 100 : 1);
    if (!(alpha > 0.5)) return null;
    const part = (n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, '0');
    return `#${part(fn[1])}${part(fn[2])}${part(fn[3])}`;
  }

  return null;
}

/** Every colour in one declaration value — a shorthand may hold one. */
function coloursIn(value) {
  const out = [];
  const text = String(value || '');
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
    const hex = toHex(m[0].length === 9 || m[0].length === 5 ? m[0].slice(0, m[0].length === 9 ? 7 : 4) : m[0]);
    if (hex) out.push(hex);
  }
  return out;
}

/**
 * The palette a theme publishes about itself, by name.
 *
 * Read before anything else and trusted above everything else, because it is
 * a statement rather than an inference: the owner picked these in a theme
 * customiser and the theme wrote them out.
 *
 * Later declarations win, the way CSS does. A theme's own stylesheet loads
 * after the framework's, so when the same variable is set twice the last one
 * is the one on screen.
 */
function fromVariables(css) {
  const found = new Map();
  const text = String(css || '');

  for (const m of text.matchAll(/--([a-z0-9-_]{2,80})\s*:\s*([^;{}]{1,120})[;}]/gi)) {
    const variable = m[1].toLowerCase();
    if (CHROME.test('--' + variable)) continue;

    // `--wp--preset--color--fl-accent` is a theme's accent; the same prefix
    // with `vivid-red` after it is WordPress's stock palette.
    const preset = variable.match(/^wp--preset--color--(.+)$/);
    if (preset && STOCK.has(preset[1])) continue;
    if (/^wp--preset--gradient/.test(variable)) continue;

    const name = preset ? preset[1] : variable;
    const role = namedRole(name);
    if (!role) continue;

    const hex = toHex(m[2].trim());
    if (!hex) continue;

    // Last wins, so a later declaration simply replaces an earlier one.
    found.set(name, { hex, name, role, where: `the theme's own --${name}` });
  }

  /*
   * One entry per colour rather than per variable. A theme that sets
   * accent, accent-hover, topbar-link and nav-hover to the same blue has said
   * one thing four times, and printing it four times would read as four
   * separate findings.
   */
  const byHex = new Map();
  for (const entry of found.values()) {
    const seen = byHex.get(entry.hex);
    if (seen) {
      seen.uses += 1;
      if (!seen.roles.includes(entry.role)) seen.roles.push(entry.role);
      continue;
    }
    byHex.set(entry.hex, {
      hex: entry.hex,
      uses: 1,
      roles: [entry.role],
      where: entry.where,
      named: true,
    });
  }

  return [...byHex.values()];
}

/**
 * Colour candidates from stylesheet text, ranked by where they are used.
 *
 * Deliberately not a CSS parser. Resolving the cascade properly means
 * specificity, media queries, `!important` and the order of four files, and
 * getting that half-right is worse than not doing it — it would produce
 * confident wrong answers. This reads declarations and reports what it saw and
 * where, which is evidence, and evidence is what the model was missing.
 *
 * @param {string} css - one or more stylesheets, concatenated
 * @returns {Array<{hex: string, roles: string[], score: number, uses: number,
 *   where: string}>} best first
 */
function fromCss(css, { limit = 16 } = {}) {
  const found = new Map();
  const text = String(css || '');

  // selector { declarations }. Good enough for this: at-rule bodies get read
  // as if they were top level, which is what we want — a colour inside a
  // media query is still a colour the site uses.
  for (const block of text.matchAll(/([^{}]{1,400})\{([^{}]{0,4000})\}/g)) {
    const selector = block[1].trim();
    if (!selector || selector.startsWith('@')) continue;

    const { role: named, weight } = role(selector);

    for (const decl of block[2].split(';')) {
      const at = decl.indexOf(':');
      if (at === -1) continue;

      const property = decl.slice(0, at).trim().toLowerCase();
      const value = decl.slice(at + 1);

      // The line that makes the whole thing work: a colour that exists only
      // as a framework preset has never been on screen.
      // Variables are read properly by fromVariables, which knows which of
      // them are the theme's and which are WordPress's. Counting them here as
      // well would let the stock palette back in through the side door.
      if (property.startsWith('--')) continue;
      if (!COLOUR_PROPERTY.test(property)) continue;

      for (const hex of coloursIn(value)) {
        const entry = found.get(hex) ?? { hex, uses: 0, score: 0, roles: new Set(), where: '' };
        entry.uses += 1;

        const points = weight;
        entry.score += points;

        if (named !== 'other') entry.roles.add(named);
        if (!entry.where || points > entry.best) {
          entry.best = points;
          entry.where = `${property} on ${selector.split(',')[0].trim().slice(0, 60)}`;
        }
        found.set(hex, entry);
      }
    }
  }

  return [...found.values()]
    .map(({ hex, uses, score, roles, where }) => ({
      hex,
      uses,
      score,
      roles: [...roles],
      where,
    }))
    .sort((a, b) => b.score - a.score || b.uses - a.uses)
    .slice(0, limit);
}

/* ---------------------------------------------------------------- images */

/** Absolute, or null if it cannot be made so. */
function absolute(raw, base) {
  try {
    const url = new URL(String(raw).trim().replace(/^["']|["']$/g, ''), base);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const LOGO_HINT = /logo|brand|wordmark|site-?icon/i;
const NOT_A_LOGO = /sprite|icon-|favicon-16|placeholder|pixel|spacer|tracking|facebook|instagram|twitter|tripadvisor|whatsapp|line-?icon|payment|visa|mastercard/i;

/**
 * Furniture, not photographs.
 *
 * A page's CSS backgrounds are mostly the theme's and its plugins' own parts:
 * slider arrows, a loading spinner, a one-pixel gradient, an icon sheet. On
 * the site this was built against, four of the five background candidates
 * were bx_loader.gif and friends — offering those as the hero photograph of a
 * hotel is worse than offering nothing, because somebody has to notice.
 *
 * Anything shipped with a plugin or a theme is chrome. What an owner uploaded
 * is content, and that is the distinction WordPress happens to put in the
 * path for us.
 */
const CHROME_IMAGE =
  /\/(plugins|themes|modules)\/|loader|spinner|controls?\.|arrow|bullet|shadow|gradient|transparent|blank|sprite|icons?[-_.]|pattern|texture-bg|placeholder|\/emoji\//i;

/**
 * Logo and background candidates, in the order they are worth trying.
 *
 * Both come back as lists rather than a single answer, because every rule
 * here is a guess that is right most of the time: a file called logo.svg
 * usually is one, og:image usually is the picture the site wants associated
 * with it. Handing over the ranked list lets the model use what it can see of
 * the page to choose, and lets the customer override with an address of their
 * own when both of us are wrong.
 */
function images(html, base) {
  const text = String(html || '');
  const logos = [];
  const backgrounds = [];

  const add = (list, url, why, { chromeOk = false } = {}) => {
    const abs = absolute(url, base);
    if (!abs || NOT_A_LOGO.test(abs)) return;
    // A logo may legitimately live in a theme directory; a hero photograph
    // that does is a piece of the theme rather than a picture of the place.
    if (!chromeOk && CHROME_IMAGE.test(abs)) return;
    if (!list.some((c) => c.url === abs)) list.push({ url: abs, why });
  };

  // A site's own declaration of its mark, which beats anything inferred.
  for (const m of text.matchAll(/<link[^>]+rel=["']?([^"'>\s]+)[^>]*>/gi)) {
    const rel = m[1].toLowerCase();
    const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (/apple-touch-icon/.test(rel)) add(logos, href, 'the apple touch icon', { chromeOk: true });
    else if (/^(icon|shortcut)/.test(rel)) add(logos, href, 'the site icon', { chromeOk: true });
  }

  for (const m of text.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0];
    const prop = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
    if (!prop || !content) continue;
    if (prop === 'og:image' || prop === 'twitter:image') {
      add(backgrounds, content, 'the image the site shares with links');
    }
    if (prop === 'og:logo') add(logos, content, 'the declared logo');
  }

  // Images whose address says what they are. A file called logo.svg is one
  // far more often than not, and the ones that are not get filtered above.
  for (const m of text.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
    const alt = tag.match(/\salt=["']([^"']*)["']/i)?.[1] ?? '';
    if (!src) continue;
    if (LOGO_HINT.test(src) || LOGO_HINT.test(alt) || LOGO_HINT.test(tag.match(/class=["']([^"']*)["']/i)?.[1] ?? '')) {
      add(logos, src, 'an image called a logo on the page', { chromeOk: true });
    }
  }

  // The hero, which on most sites is a CSS background rather than an <img>.
  for (const m of text.matchAll(/background(?:-image)?\s*:\s*[^;}]*url\((["']?)([^"')]+)\1\)/gi)) {
    add(backgrounds, m[2], 'a background image on the page');
  }

  for (const m of text.matchAll(/<img[^>]+>/gi)) {
    const src = m[0].match(/\ssrc=["']([^"']+)["']/i)?.[1];
    if (src && !LOGO_HINT.test(src)) add(backgrounds, src, 'a photograph on the page');
  }

  /*
   * Uploaded media first. On WordPress that is the one path a person put
   * something in deliberately, and on any site it beats whatever a stylesheet
   * happened to reference.
   */
  const uploaded = (c) => (/\/(uploads|media|images|img)\//i.test(c.url) ? 0 : 1);
  backgrounds.sort((a, b) => uploaded(a) - uploaded(b));

  return { logos: logos.slice(0, 6), backgrounds: backgrounds.slice(0, 8) };
}

/**
 * The evidence, as the lines that go into the prompt.
 *
 * Written out rather than handed over as JSON because it is read by a model
 * alongside the page, and "#2b7bb9 — background-color on .fl-button, used 6
 * times, looks like a button" is a sentence it can weigh. A bare object of
 * hex codes is the thing that did not work.
 */
function brief({ colours = [], logos = [], backgrounds = [] }) {
  const lines = [];

  const named = colours.filter((c) => c.named);
  const swept = colours.filter((c) => !c.named);

  if (named.length) {
    lines.push("The palette this site's theme publishes about itself:");
    for (const c of named) {
      lines.push(`  ${c.hex}  the ${c.roles.join(' and ')} (${c.where})`);
    }
    lines.push(
      'Somebody chose these in a theme customiser and the theme wrote them out by name, so they are the site\'s real colours and the names are its own words for them. Use them. Only depart from one if it cannot do the job the slot needs — a pale background where a dark ground is required, say — and say so in "source" when you do.'
    );
  }

  if (swept.length) {
    lines.push(
      named.length ? '' : 'Colours found in this site\'s stylesheets:',
      ...(named.length ? ['Other colours painted on the site, in case a slot is still empty:'] : []),
    );
    for (const c of swept) {
      const roles = c.roles.length ? ` — looks like the ${c.roles.join(' and ')}` : '';
      lines.push(`  ${c.hex}  ${c.where}, ${c.uses} time${c.uses === 1 ? '' : 's'}${roles}`);
    }
    if (!named.length) {
      lines.push(
        'These come from the site\'s own stylesheets with the framework presets removed. A site that loads Bootstrap or similar will have its defaults in here too, so prefer a colour whose selector names something this site built over one that names a generic component.'
      );
    }
  }

  if (logos.length) {
    lines.push('', 'Possible logos, best first:');
    for (const l of logos) lines.push(`  ${l.url}  (${l.why})`);
  }

  if (backgrounds.length) {
    lines.push('', 'Possible background photographs, best first:');
    for (const b of backgrounds) lines.push(`  ${b.url}  (${b.why})`);
  }

  return lines.join('\n');
}

/**
 * Everything the stylesheets say about the palette, best evidence first.
 *
 * Named theme variables ahead of anything swept out of the rules, and it is
 * not a close call. On the site this was built against, the sweep's top
 * answers were Bootstrap's defaults — #337ab7 on .btn-primary, #333 on body —
 * because a vendor bundle declares its colours hundreds of times and a theme
 * overrides them once. Frequency measures how verbose a framework is. The
 * variables are what somebody chose.
 */
function palette(css, { limit = 14 } = {}) {
  const named = fromVariables(css);
  const taken = new Set(named.map((c) => c.hex));

  /*
   * A theme that names its own ground and its own highlight has answered the
   * question, and the sweep after it is not a second opinion — it is the
   * vendor bundle underneath. On the site this was built against it offered
   * Bootstrap's #337ab7 directly below the theme's real accent #2b7bb9, which
   * is not extra evidence, it is a decoy: two blues, one of them never drawn,
   * and nothing on the line to tell them apart.
   *
   * So when the named palette covers the two slots that carry the page, it is
   * the whole answer. The sweep is for sites that publish nothing.
   */
  const roles = new Set(named.flatMap((c) => c.roles));
  const enough = named.length >= 4 && roles.has('ground') && roles.has('highlight');
  if (enough) return { named, swept: [], all: named.slice(0, limit) };

  const swept = fromCss(css, { limit: limit * 2 }).filter((c) => !taken.has(c.hex));
  return {
    named,
    swept: swept.slice(0, Math.max(0, limit - named.length)),
    all: [...named, ...swept].slice(0, limit),
  };
}

module.exports = { fromCss, fromVariables, palette, images, brief, toHex, coloursIn, role };
