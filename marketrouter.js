'use strict';

const express = require('express');

const market = require('./market');
const marketplace = require('./marketplace');
const emails = require('./emails');
const mailer = require('./mailer');
const tariff = require('./tariff');
const { throttled } = require('./throttle');

/**
 * The marketplace's public API, at /api/market.
 *
 * Called by the website's server, which renders the search, venue and checkout
 * pages, and by browsers only for photos (through the website's proxy). No
 * session: a guest booking a room has no account and does not need one.
 *
 * Reached on the API's own host rather than a venue's — it answers for every
 * listed venue at once — so it is mounted before the tenant resolver.
 */

const router = express.Router();

// Where the guest's "see your booking" link points: the website, which owns
// the pages. Not this app's host, which serves venues' own pages.
const SITE = String(process.env.SITE_URL || 'https://reviewslip.com').replace(/\/$/, '');

function money(currency, minor) {
  return `${currency} ${tariff.formatAmount(minor)}`;
}

/** Search, venue and booking all take the same stay out of the query. */
function stayFrom(source, res) {
  const checked = market.checkSearch(source);
  if (!checked.ok) {
    res.status(400).json({ error: checked.error });
    return null;
  }
  const { ok: _ok, ...stay } = checked;
  return stay;
}

router.get('/places', async (_req, res, next) => {
  try {
    res.json({ places: await marketplace.places() });
  } catch (err) {
    next(err);
  }
});

router.get('/search', async (req, res, next) => {
  try {
    if (throttled(`market:search:${req.ip}`, { max: 120 })) {
      return res.status(429).json({ error: 'Too many searches. Wait a minute.' });
    }
    const stay = stayFrom(req.query, res);
    if (!stay) return;
    res.json(await marketplace.search(stay));
  } catch (err) {
    next(err);
  }
});

/**
 * One venue. Without dates it still answers — a guest arriving from a link
 * sees the venue and its rooms, and is asked for dates to see prices.
 */
router.get('/venues/:slug', async (req, res, next) => {
  try {
    let stay = null;
    if (req.query.arrival || req.query.departure) {
      stay = stayFrom(req.query, res);
      if (!stay) return;
    }
    const venue = await marketplace.venue(req.params.slug, stay);
    if (!venue) return res.status(404).json({ error: 'No such venue on Reviewslip.' });
    res.json(venue);
  } catch (err) {
    next(err);
  }
});

router.post('/venues/:slug/bookings', async (req, res, next) => {
  try {
    if (throttled(`market:book:${req.params.slug}:${req.ip}`, { max: 10 })) {
      return res.status(429).json({ error: 'Too many tries. Wait a minute and try again.' });
    }
    const stay = stayFrom(req.body, res);
    if (!stay) return;
    const guest = market.validateGuest(req.body.guest);
    if (!guest.ok) return res.status(400).json({ error: guest.error });

    const groupId = Number(req.body.groupId);
    const planId = Number(req.body.planId);
    if (!Number.isSafeInteger(groupId) || !Number.isSafeInteger(planId)) {
      return res.status(400).json({ error: 'Pick a room and a rate.' });
    }

    const booked = await marketplace.book({
      slug: req.params.slug,
      groupId,
      planId,
      expectTotalMinor: req.body.expectTotalMinor,
      stay,
      guest: guest.guest,
    });

    const view = await marketplace.bookingView(booked.reference);
    const link = `${SITE}/stays/booking/${booked.reference}?k=${encodeURIComponent(booked.key || '')}`;
    const contact = [view.venue.contact.phone, view.venue.contact.email].filter(Boolean).join(' · ');

    // After the commit and never fatal: the booking stands whether or not the
    // mail goes, and the confirmation page shows everything the email does.
    mailer
      .send({
        to: guest.guest.email,
        ...emails.bookingEmail({
          venue: view.venue.name,
          reference: booked.reference,
          guestName: guest.guest.name,
          roomName: view.roomName,
          planName: view.planName,
          arrival: view.arrival,
          departure: view.departure,
          nights: view.nights,
          rooms: view.rooms,
          total: money(view.currency, view.totalMinor),
          payment: `Pay ${money(view.currency, view.totalMinor)} at the property.`,
          cancellation: view.freeCancelUntil
            ? `Free cancellation until ${view.freeCancelUntil}. Cancel from your booking page.`
            : 'Non-refundable.',
          checkIn: view.checkIn,
          checkOut: view.checkOut,
          link,
          contact,
        }),
      })
      .catch(() => {});
    marketplace
      .venueEmail(booked.subscriber.id)
      .then((to) =>
        mailer.send({
          to,
          ...emails.bookingAlertEmail({
            venue: view.venue.name,
            reference: booked.reference,
            guestName: guest.guest.name,
            guestEmail: guest.guest.email,
            guestPhone: guest.guest.phone,
            roomName: view.roomName,
            planName: view.planName,
            arrival: view.arrival,
            departure: view.departure,
            nights: view.nights,
            rooms: view.rooms,
            party: `${view.adults} adult${view.adults === 1 ? '' : 's'}${view.children ? `, ${view.children} child${view.children === 1 ? '' : 'ren'}` : ''}`,
            total: money(view.currency, view.totalMinor),
            requests: guest.guest.requests,
          }),
        })
      )
      .catch(() => {});

    res.status(201).json({ reference: booked.reference, key: booked.key });
  } catch (err) {
    if (err.status === 409 && Number.isSafeInteger(err.totalMinor)) {
      return res.status(409).json({ error: err.message, totalMinor: err.totalMinor });
    }
    next(err);
  }
});

/** A booking again, by reference and key. Every failure is the same 404. */
router.get('/bookings/:reference', async (req, res, next) => {
  try {
    if (throttled(`market:view:${req.ip}`, { max: 60 })) {
      return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
    }
    const reference = String(req.params.reference || '').toUpperCase();
    if (!market.opensBooking(reference, req.query.k)) {
      return res.status(404).json({ error: 'No booking with that reference.' });
    }
    const view = await marketplace.bookingView(reference);
    if (!view) return res.status(404).json({ error: 'No booking with that reference.' });
    res.json(view);
  } catch (err) {
    next(err);
  }
});

/**
 * The guest cancels, by reference and key — the same pair that opens the
 * booking. Every failure to prove it is the same 404 as a wrong reference.
 */
router.post('/bookings/:reference/cancel', async (req, res, next) => {
  try {
    if (throttled(`market:cancel:${req.ip}`, { max: 10 })) {
      return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
    }
    const reference = String(req.params.reference || '').toUpperCase();
    if (!market.opensBooking(reference, req.body?.k)) {
      return res.status(404).json({ error: 'No booking with that reference.' });
    }

    const { subscriberId } = await marketplace.cancelByGuest(reference);
    const view = await marketplace.bookingView(reference);

    mailer
      .send({
        to: view.guestEmail,
        ...emails.bookingCancelledEmail({
          venue: view.venue.name,
          reference,
          guestName: view.guestName,
          arrival: view.arrival,
          departure: view.departure,
          by: 'guest',
          link: `${SITE}/stays`,
        }),
      })
      .catch(() => {});
    marketplace
      .venueEmail(subscriberId)
      .then((to) =>
        mailer.send({
          to,
          ...emails.bookingCancelAlertEmail({
            reference,
            guestName: view.guestName,
            roomName: view.roomName,
            rooms: view.rooms,
            arrival: view.arrival,
            departure: view.departure,
          }),
        })
      )
      .catch(() => {});

    res.json(view);
  } catch (err) {
    next(err);
  }
});

/**
 * A listed venue's photo. Immutable: a photo is never edited, only added and
 * removed, so its id names its bytes for ever and it can be cached hard.
 */
router.get('/photos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(404).end();
    const image = await marketplace.photo(id);
    if (!image) return res.status(404).end();
    res.set({
      'Content-Type': image.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.send(image.buffer);
  } catch (err) {
    next(err);
  }
});

// Errors carrying a status are the guest's to read; anything else is ours.
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('Marketplace:', err);
  res.status(500).json({ error: 'Something went wrong. Try again.' });
});

module.exports = router;
