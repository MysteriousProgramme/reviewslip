'use strict';

const crypto = require('crypto');
const nights = require('./nights');

/**
 * The marketplace: the rules, with no database and no Express.
 *
 * Guests search reviewslip.com by place and dates, see which listed venues
 * have a room for them and what it costs, and book it themselves. The booking
 * is confirmed at once — the room is free on every night and priced, or it is
 * refused — and lands on the venue's calendar like any other.
 *
 * What a venue says about itself (the profile), about a room type, and about a
 * rate plan is checked here; so is a search, a guest's details, what is due
 * online, the guest-facing reference and the key that opens a booking again.
 *
 * Payment is not connected yet. The venue's choice — a deposit or the full
 * amount — is stored and worked out now, and charged once there is a provider.
 */

function fail(error) {
  return { ok: false, error };
}

function text(value, max) {
  return String(value ?? '').trim().replace(/[ \t]+/g, ' ').slice(0, max + 1);
}

/* --------------------------------------------------------------- amenities */

/**
 * What a venue or a room can say it has, as keys the site translates.
 *
 * A fixed list rather than free text: a guest filters and compares on these,
 * and "Free WiFi", "wifi" and "Wi-Fi in rooms" are one thing to them.
 */
const VENUE_AMENITIES = [
  'wifi', 'parking', 'pool', 'restaurant', 'breakfast', 'aircon', 'garden',
  'airport', 'shuttle', 'laundry', 'kitchen', 'spa', 'gym', 'family', 'pets',
  'frontdesk24',
];

const ROOM_AMENITIES = [
  'aircon', 'fan', 'wifi', 'tv', 'fridge', 'kettle', 'balcony', 'bathtub',
  'shower', 'desk', 'safe', 'view', 'kitchenette', 'terrace',
];

function pickAmenities(value, allowed) {
  const list = Array.isArray(value) ? value : [];
  // The order of the list, not the order ticked: every venue page reads alike.
  return allowed.filter((key) => list.includes(key));
}

/* ----------------------------------------------------------------- profile */

const ABOUT_MAX = 2000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_RE = /^\+?[\d\s()-]{6,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_PROFILE = Object.freeze({
  about: '',
  amenities: [],
  contact: { phone: '', email: '', line: '', whatsapp: '', voiceSite: '' },
  checkIn: '14:00',
  checkOut: '12:00',
  payment: { mode: 'full', depositPct: null },
});

/**
 * How a guest reaches the venue instead of booking online.
 *
 * LINE is an id or a line.me link; WhatsApp a number. Both are turned into the
 * link that opens the app, by the site, so they are stored as typed.
 */
function checkContact(value = {}) {
  const phone = text(value.phone, 24);
  const email = text(value.email, 254).toLowerCase();
  const line = text(value.line, 100);
  const whatsapp = text(value.whatsapp, 24);
  // The venue's site key on the Vibe Crafted softphone. When set, "Call" on the
  // marketplace and in the Guest App is an in-browser call to the venue's team,
  // with the phone number as the fallback for browsers that cannot place one.
  const voiceSite = text(value.voiceSite, 40).toLowerCase();

  if (phone && !PHONE_RE.test(phone)) return fail('That phone number does not look right.');
  if (voiceSite && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(voiceSite)) {
    return fail('The softphone site key is lowercase letters, digits and hyphens, like baanponglodge.');
  }
  if (email && !EMAIL_RE.test(email)) return fail('That email address does not look right.');
  if (whatsapp && !PHONE_RE.test(whatsapp)) return fail('Give WhatsApp as a phone number, with the country code.');
  if (line && !/^(@?[\w.-]{2,40}|https:\/\/(line\.me|lin\.ee)\/\S+)$/i.test(line)) {
    return fail('Give LINE as an id, like @baanpong, or a line.me link.');
  }
  return { ok: true, contact: { phone, email, line, whatsapp, voiceSite } };
}

/**
 * What a venue says about itself to guests.
 *
 * @returns {{ok: true, profile: object}|{ok: false, error: string}}
 */
function validateProfile(body = {}) {
  const about = text(body.about, ABOUT_MAX);
  if (about.length > ABOUT_MAX) return fail(`Keep the description under ${ABOUT_MAX} characters.`);

  const contact = checkContact(body.contact);
  if (!contact.ok) return contact;

  const checkIn = text(body.checkIn, 5) || DEFAULT_PROFILE.checkIn;
  const checkOut = text(body.checkOut, 5) || DEFAULT_PROFILE.checkOut;
  if (!TIME_RE.test(checkIn) || !TIME_RE.test(checkOut)) {
    return fail('Check-in and check-out are times, like 14:00.');
  }

  const mode = body.payment?.mode === 'deposit' ? 'deposit' : 'full';
  let depositPct = null;
  if (mode === 'deposit') {
    depositPct = Number(body.payment?.depositPct);
    if (!Number.isInteger(depositPct) || depositPct < 5 || depositPct > 95) {
      return fail('A deposit is a whole percentage from 5 to 95.');
    }
  }

  return {
    ok: true,
    profile: {
      about,
      amenities: pickAmenities(body.amenities, VENUE_AMENITIES),
      contact: contact.contact,
      checkIn,
      checkOut,
      payment: { mode, depositPct },
    },
  };
}

/** The stored profile, or the defaults. Never throws on what is stored. */
function parseProfile(stored) {
  try {
    const checked = validateProfile(JSON.parse(stored || '{}'));
    if (checked.ok) return checked.profile;
  } catch {
    // Fall through to the defaults: a venue page with no description is
    // better than one that fails to open.
  }
  return structuredClone(DEFAULT_PROFILE);
}

/* -------------------------------------------------------------- room types */

const ROOM_TEXT_MAX = 1000;

/** What a room type says about itself, beyond its name and capacity. */
function validateRoomProfile(body = {}) {
  const description = text(body.description, ROOM_TEXT_MAX);
  if (description.length > ROOM_TEXT_MAX) {
    return fail(`Keep the room description under ${ROOM_TEXT_MAX} characters.`);
  }
  const bed = text(body.bed, 60);
  if (bed.length > 60) return fail('Keep the bed under 60 characters, like "1 king bed".');

  let sizeSqm = null;
  if (body.sizeSqm !== null && body.sizeSqm !== undefined && body.sizeSqm !== '') {
    sizeSqm = Number(body.sizeSqm);
    if (!Number.isInteger(sizeSqm) || sizeSqm < 5 || sizeSqm > 1000) {
      return fail('Room size is a whole number of square metres.');
    }
  }

  return {
    ok: true,
    room: { description, bed, sizeSqm, amenities: pickAmenities(body.amenities, ROOM_AMENITIES) },
  };
}

function parseRoomProfile(stored) {
  try {
    const checked = validateRoomProfile(JSON.parse(stored || '{}'));
    if (checked.ok) return checked.room;
  } catch {
    // As parseProfile.
  }
  return { description: '', bed: '', sizeSqm: null, amenities: [] };
}

/* ------------------------------------------------------------- rate terms */

const MAX_CANCEL_DAYS = 60;

/**
 * What a rate includes and how it cancels.
 *
 * cancelDays is how many days before arrival the guest can still cancel for
 * nothing; null is non-refundable. 0 means up to the day of arrival.
 */
function validatePlanTerms(body = {}) {
  let cancelDays = null;
  if (body.cancelDays !== null && body.cancelDays !== undefined && body.cancelDays !== '') {
    cancelDays = Number(body.cancelDays);
    if (!Number.isInteger(cancelDays) || cancelDays < 0 || cancelDays > MAX_CANCEL_DAYS) {
      return fail(`Free cancellation is 0 to ${MAX_CANCEL_DAYS} days before arrival, or none.`);
    }
  }
  return { ok: true, terms: { breakfast: body.breakfast === true, cancelDays } };
}

/**
 * The last day the guest can cancel for nothing, or null when they cannot —
 * a non-refundable rate, or a deadline that has already passed.
 */
function freeCancelUntil({ arrival, cancelDays, today }) {
  if (cancelDays === null || cancelDays === undefined) return null;
  const until = nights.addDays(arrival, -cancelDays);
  return until && until >= today ? until : null;
}

/**
 * Whether a guest may cancel online, from the booking's live rooms and the
 * deadline frozen on it.
 *
 * @param {{statuses: string[], freeCancelUntil: string|null, today: string}} input
 * @returns {{ok: true}|{ok: false, error: string}}
 */
function canCancel({ statuses = [], freeCancelUntil, today }) {
  if (!statuses.length) return fail('This booking is already cancelled.');
  if (statuses.some((s) => s !== 'confirmed')) {
    return fail('This stay has already started. Speak to the front desk.');
  }
  if (!freeCancelUntil || freeCancelUntil < today) {
    return fail('This rate can no longer be cancelled online. Contact the venue to change it.');
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ search */

const MAX_STAY = 30;
const MAX_AHEAD = 365;
const MAX_ROOMS = 4;

/**
 * A guest's search, checked.
 *
 * Arrival from today in Thailand — every venue is there — and no more than a
 * year out, because nobody has priced the year after.
 *
 * @returns {{ok: true, q: string, arrival: string, departure: string,
 *            adults: number, children: number, rooms: number}|{ok: false, error: string}}
 */
function checkSearch(query = {}, { today = nights.todayAt('Asia/Bangkok') } = {}) {
  const q = text(query.q, 80);

  const stay = nights.checkStay({ arrival: query.arrival, departure: query.departure });
  if (!stay.ok) return fail(stay.error);
  const { arrival, departure } = query;
  if (arrival < today) return fail('Check-in cannot be in the past.');
  if (arrival > nights.addDays(today, MAX_AHEAD)) return fail('Check-in is more than a year away.');
  if (nights.nightCount(arrival, departure) > MAX_STAY) {
    return fail(`Book up to ${MAX_STAY} nights online. For longer, contact the venue.`);
  }

  const adults = Number(query.adults ?? 2);
  const children = Number(query.children ?? 0);
  const rooms = Number(query.rooms ?? 1);
  if (!Number.isInteger(adults) || adults < 1 || adults > 16) return fail('Adults is 1 to 16.');
  if (!Number.isInteger(children) || children < 0 || children > 10) return fail('Children is 0 to 10.');
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > MAX_ROOMS) return fail(`Rooms is 1 to ${MAX_ROOMS}.`);
  if (adults < rooms) return fail('Every room needs at least one adult.');

  return { ok: true, q, arrival, departure, adults, children, rooms };
}

/**
 * Whether a room type can take this party: enough rooms free on every night,
 * and enough beds across them.
 */
function fits({ capacity, free }, { adults, children, rooms }) {
  return free >= rooms && capacity * rooms >= adults + children;
}

/**
 * The party spread over its rooms, as evenly as it goes: three adults in two
 * rooms is two and one. Each room is one booking row, and the front desk reads
 * who is in it.
 */
function split({ adults, children, rooms }) {
  return Array.from({ length: rooms }, (_, i) => ({
    adults: Math.floor(adults / rooms) + (i < adults % rooms ? 1 : 0),
    children: Math.floor(children / rooms) + (i < children % rooms ? 1 : 0),
  }));
}

/* ----------------------------------------------------------------- payment */

/**
 * What the guest pays online, in minor units.
 *
 * A deposit is rounded up to a whole unit of the currency: a deposit of
 * ฿1,234.57 reads as a mistake, and rounding down would take less than the
 * venue asked for.
 */
function dueNow(totalMinor, payment = {}) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) return 0;
  if (payment.mode !== 'deposit') return totalMinor;
  const raw = (totalMinor * payment.depositPct) / 100;
  return Math.min(totalMinor, Math.ceil(raw / 100) * 100);
}

/* --------------------------------------------------------------- the guest */

const NAME_MAX = 120;
const REQUESTS_MAX = 1000;

/** The guest's details at checkout. Error strings are shown on the form. */
function validateGuest(body = {}) {
  const name = text(body.name, NAME_MAX);
  const email = text(body.email, 254).toLowerCase();
  const phone = text(body.phone, 24);
  const requests = String(body.requests ?? '').trim().slice(0, REQUESTS_MAX + 1);

  if (!name) return fail('Add the name the booking is under.');
  if (name.length > NAME_MAX) return fail('That name is too long.');
  if (!EMAIL_RE.test(email)) return fail('Add an email address for the confirmation.');
  if (!PHONE_RE.test(phone)) return fail('Add a phone number the venue can reach you on, with the country code.');
  if (requests.length > REQUESTS_MAX) return fail(`Keep requests under ${REQUESTS_MAX} characters.`);

  return { ok: true, guest: { name, email, phone, requests } };
}

/* --------------------------------------------------------------- reference */

// Crockford's alphabet: no I, L, O or U, so a reference read out over the phone
// cannot be misheard as a 1, a 0 or a V.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** RS plus eight characters: forty bits, and short enough to say. */
function makeReference(bytes = crypto.randomBytes(8)) {
  let out = 'RS';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

const REFERENCE_RE = /^RS[0-9A-HJKMNP-TV-Z]{8}$/;

function accessKeyFor(reference) {
  const raw = String(process.env.SECRET_KEY || '').trim();
  if (raw.length !== 64) return null;
  // Its own derived key, as the welcome pass has, so neither can stand in for
  // the other.
  const key = crypto.createHmac('sha256', Buffer.from(raw, 'hex')).update('booking-access').digest();
  return crypto.createHmac('sha256', key).update(reference).digest('base64url').slice(0, 22);
}

/**
 * Whether a key opens a booking.
 *
 * The confirmation page and the email link carry the reference and this key,
 * so a guest can open their booking again without an account — and somebody
 * guessing references gets nothing without the key.
 */
function opensBooking(reference, key) {
  if (!REFERENCE_RE.test(String(reference ?? ''))) return false;
  const expected = accessKeyFor(reference);
  if (!expected) return false;
  const given = Buffer.from(String(key ?? ''));
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = {
  VENUE_AMENITIES,
  ROOM_AMENITIES,
  MAX_ROOMS,
  validateProfile,
  parseProfile,
  validateRoomProfile,
  parseRoomProfile,
  validatePlanTerms,
  freeCancelUntil,
  canCancel,
  checkSearch,
  fits,
  split,
  dueNow,
  validateGuest,
  makeReference,
  accessKeyFor,
  opensBooking,
};
