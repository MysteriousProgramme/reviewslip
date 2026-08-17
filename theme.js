'use strict';

/**
 * Per-business themes: four colours in, a whole palette out.
 *
 * A business picks — or has drafted from its website — four colours:
 *
 *   ground     the dark page behind the guest's review
 *   paper      the light surface the review sits on, and the printed card
 *   accent     the quiet furniture: labels, borders, topic chips
 *   highlight  the one spent colour: the button that opens the listing
 *
 * Everything else is derived here rather than asked for. Tints, shades, the
 * softened text colour, the colour of the text *on* the highlight — those are
 * arithmetic, and a model asked for eleven colours produces a set that does not
 * hang together and cannot be checked. Four it can genuinely read off a page.
 *
 * Derivation is also where readability is enforced. A palette taken from a
 * website is a brand, not an interface: a pale gold that looks fine in a logo is
 * unreadable as body text on a dark ground. So every colour that ends up as text
 * is nudged until it meets a contrast ratio, and what was nudged is reported —
 * the customer sees that their colour moved and why, rather than wondering why
 * the page does not match their site.
 *
 * Nothing here reads the database or the network. It is a pure function of four
 * strings, which is what makes it testable.
 */

/* -------------------------------------------------------------- colour maths */

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** @returns {string|null} the normalised `#rrggbb`, or null if it is not one */
function hex(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  // `#abc` is a legal CSS colour and a likely thing for a model to return.
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return HEX_RE.test(v) ? v : null;
}

function rgb(value) {
  const h = hex(value);
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function toHex([r, g, b]) {
  const part = (n) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance. */
function luminance(value) {
  const [r, g, b] = rgb(value).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** @param {number} amount 0 = all `a`, 1 = all `b` */
function mix(a, b, amount) {
  const from = rgb(a);
  const to = rgb(b);
  return toHex(from.map((c, i) => c + (to[i] - c) * amount));
}

/**
 * Moves `colour` toward white or black — whichever direction the background is
 * not — until it clears `target`, keeping as much of the original hue as the
 * ratio allows.
 *
 * Nudged rather than rejected on purpose. A business that picked its own brand
 * colour and got "no" learns nothing; a business whose gold came back a little
 * deeper can see that it did, and read why.
 *
 * @returns {{colour: string, moved: boolean}}
 */
function readable(colour, against, target) {
  if (contrast(colour, against) >= target) return { colour, moved: false };

  // Both directions, smallest move first.
  //
  // Picking the direction from the background's luminance is the obvious
  // implementation and it is wrong for any mid-tone background. A coral button
  // sits at about 0.35, which reads as "dark, so go toward white" — but white on
  // coral is 2.7:1 and no amount of further whitening helps, while black clears
  // 8:1 straight away. So try both at each step and take whichever reaches the
  // target with the least movement, which is also the one that keeps most of the
  // original hue.
  let best = { colour, ratio: contrast(colour, against) };

  for (let step = 1; step <= 20; step++) {
    for (const toward of ['#ffffff', '#000000']) {
      const candidate = mix(colour, toward, step / 20);
      const ratio = contrast(candidate, against);

      if (ratio >= target) return { colour: candidate, moved: true };
      if (ratio > best.ratio) best = { colour: candidate, ratio };
    }
  }

  // Neither end reaches it — a background of middling luminance can be like
  // this, where nothing clears 7:1 either way. Hand back the best found rather
  // than an arbitrary end, and let the caller's own ratio be the one that gave.
  return { colour: best.colour, moved: true };
}

/* ------------------------------------------------------------------ the ratios */

/**
 * Why each number is what it is.
 *
 * The review text is the one thing on the page a guest genuinely reads word by
 * word, and they are outdoors on a phone, so it gets AAA rather than AA. The
 * furniture around it is AA. The paper against the ground is not text at all —
 * it only has to read as a separate surface, so it takes the non-text ratio.
 */
const RATIOS = {
  reviewText: 7, // ink on paper
  softText: 4.5, // ink-soft on paper
  bodyText: 4.5, // accent on ground
  actionText: 4.5, // highlight on ground, which .btn-go-second sets as text
  onHighlight: 4.5, // the label inside the filled button
  surface: 3, // paper against ground
};

/* ---------------------------------------------------------------- derivation */

/** The four a business actually chooses. */
const SLOTS = ['ground', 'paper', 'accent', 'highlight'];

/** The printed card's stock. Not themeable — see the card notes in `derive`. */
const CARD = '#ffffff';

/** The palette the app shipped with, and what an unthemed business still gets. */
const DEFAULT_THEME = {
  ground: '#0c1f19',
  paper: '#f3ecdc',
  accent: '#82b49b',
  highlight: '#e9a03b',
};

function rgbaOf(colour, alpha) {
  const [r, g, b] = rgb(colour);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Four colours to the full set of custom properties, with every text pair
 * checked.
 *
 * @param {object} theme - ground, paper, accent, highlight
 * @returns {{vars: object, adjusted: string[]}} `adjusted` names the slots that
 *   had to move, in words a customer can read.
 */
function derive(theme) {
  const ground = hex(theme?.ground) || DEFAULT_THEME.ground;
  const adjusted = [];

  // Paper first: it is the surface everything else is measured against, and it
  // has to separate from the ground before anything sitting on it matters.
  const paperFix = readable(
    hex(theme?.paper) || DEFAULT_THEME.paper,
    ground,
    RATIOS.surface
  );
  if (paperFix.moved) adjusted.push('the paper colour, to separate it from the background');
  const paper = paperFix.colour;

  const accentFix = readable(
    hex(theme?.accent) || DEFAULT_THEME.accent,
    ground,
    RATIOS.bodyText
  );
  if (accentFix.moved) adjusted.push('the accent, so labels stay readable on the background');
  const accent = accentFix.colour;

  const highlightFix = readable(
    hex(theme?.highlight) || DEFAULT_THEME.highlight,
    ground,
    RATIOS.actionText
  );
  if (highlightFix.moved) adjusted.push('the highlight, so the post button stays readable');
  const highlight = highlightFix.colour;

  // Ink is never chosen, only derived: it is whatever reads on the paper. Start
  // from the ground so the text keeps the palette's cast rather than going flat
  // black, then push it until it clears AAA.
  const ink = readable(ground, paper, RATIOS.reviewText).colour;
  const inkSoft = readable(mix(ink, paper, 0.45), paper, RATIOS.softText).colour;

  // The label inside the filled button. Black or white, whichever the highlight
  // carries better, tinted a little toward the palette so it is not stark.
  const onHighlightBase = luminance(highlight) > 0.5 ? ground : paper;
  const onHighlight = readable(onHighlightBase, highlight, RATIOS.onHighlight).colour;

  return {
    adjusted,
    vars: {
      '--shade': ground,
      '--shade-deep': mix(ground, '#000000', 0.45),
      '--paper': paper,
      '--paper-shadow': mix(paper, '#000000', 0.12),
      '--ink': ink,
      '--ink-soft': inkSoft,
      // Still called jade in the stylesheet. Renaming the variables would touch
      // every rule in the file for no behavioural gain, so the names stayed and
      // the meaning generalised.
      '--jade': accent,
      '--jade-dim': rgbaOf(accent, 0.5),
      '--jade-line': rgbaOf(accent, 0.24),
      '--jade-wash': rgbaOf(accent, 0.08),
      '--jade-tint': rgbaOf(accent, 0.12),
      '--jade-tint-strong': rgbaOf(accent, 0.2),
      '--marigold': highlight,
      '--marigold-soft': rgbaOf(highlight, 0.12),
      '--marigold-lift': mix(highlight, '#ffffff', 0.1),
      '--on-marigold': onHighlight,
      '--glow-strong': rgbaOf(highlight, 0.16),
      '--glow-faint': rgbaOf(highlight, 0.04),
      // The error notice. Lifted off the highlight so it belongs to the theme,
      // then held to body-text contrast — it is the line that explains why
      // nothing happened, so it is the last thing that may be hard to read.
      '--warn': readable(
        mix(highlight, paper, 0.35),
        ground,
        RATIOS.bodyText
      ).colour,

      // The printed table card. It is measured against white rather than the
      // theme's paper, and that is deliberate: a full-bleed coloured A5 costs a
      // cartridge and leaves a white margin on any printer that cannot go
      // borderless, which is most of the printers a small venue owns. So the
      // card stays white and the theme reaches its ink and its two rules.
      //
      // Checked separately for the same reason it exists separately — a theme
      // whose ground is pale reads fine on its own dark page and disappears on
      // white.
      '--card-ink': readable(ground, CARD, RATIOS.reviewText).colour,
      '--card-frame': readable(accent, CARD, RATIOS.surface).colour,
      '--card-rule': readable(highlight, CARD, RATIOS.surface).colour,
      '--card-muted': readable(
        mix(readable(ground, CARD, RATIOS.reviewText).colour, CARD, 0.55),
        CARD,
        RATIOS.softText
      ).colour,
      '--card-brand': readable(
        mix(readable(ground, CARD, RATIOS.reviewText).colour, CARD, 0.68),
        CARD,
        RATIOS.surface
      ).colour,
    },
  };
}

/**
 * The stylesheet served at /theme.css for one business.
 *
 * A stylesheet rather than properties set from JavaScript after /api/config
 * lands: the guest would otherwise watch the default palette for as long as that
 * request takes, on a phone, outdoors. A business with no theme gets an empty
 * file, so the shipped design stands untouched rather than being reconstructed
 * from arithmetic that would not quite reproduce it.
 */
function css(theme) {
  if (!theme) return '';

  const { vars } = derive(theme);
  const body = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  return `:root {\n${body}\n}\n`;
}

/* ---------------------------------------------------------------- validation */

/**
 * @param {any} value - what arrived on the wire
 * @returns {{ok: true, theme: object|null}|{ok: false, error: string}} a null
 *   theme is a cleared one, which falls back to the shipped palette.
 */
function validate(value) {
  if (value === null || value === undefined || value === '') {
    return { ok: true, theme: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'A theme is four colours.' };
  }

  const theme = {};

  for (const slot of SLOTS) {
    const colour = hex(value[slot]);
    if (!colour) {
      return {
        ok: false,
        error: `The ${slot} colour must be a hex value like #1b2a23.`,
      };
    }
    theme[slot] = colour;
  }

  // The one thing derivation cannot rescue. Every text colour is pushed toward
  // white or black to clear its ratio, and that only works if there is a
  // direction to push in — a ground and a paper that are the same colour leave
  // none, and the result would be a page of one flat rectangle.
  if (contrast(theme.ground, theme.paper) < 1.6) {
    return {
      ok: false,
      error:
        'The background and paper colours are too close to tell apart. Pick a dark background and a light paper, or the other way round.',
    };
  }

  return { ok: true, theme };
}

module.exports = {
  SLOTS,
  DEFAULT_THEME,
  RATIOS,
  hex,
  luminance,
  contrast,
  mix,
  readable,
  derive,
  css,
  validate,
};
