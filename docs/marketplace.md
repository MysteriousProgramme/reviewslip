# The marketplace — guests booking venues on reviewslip.com

A guest searches reviewslip.com by place and dates, sees which listed venues have a room for
their party and what it costs, opens a venue, picks a room and a rate, and books it — confirmed
at once, on the venue's calendar. Beside the online booking, every venue page offers the venue's
own phone, LINE, WhatsApp and email for guests who would rather talk first.

Built 2026-10-07. Decisions by Zac on the same day.

## Decisions

- **On reviewslip.com, across every listed venue** — the trip.com shape: a bar on the home page
  (where, check-in, check-out, guests and rooms), a results list, a venue page, checkout.
- **Instant confirmation.** If the room type is free on every night and priced, the booking is
  confirmed; otherwise it is refused. No request-and-wait.
- **Payment: not connected yet.** The provider is undecided, so nothing is charged and every page
  says the guest pays at the property. Each venue already chooses a deposit (5–95%) or the full
  amount; it is stored on the venue and worked out on every booking (`due_now_minor`), so
  connecting a provider later is a charge step, not a redesign.
- **The money goes to the venue directly** once there is a provider — Reviewslip never holds
  it, which keeps us out of payment licensing and payout liability.
- **No commission.** Included in the plan.
- **"Book directly with us"** means the venue's own contact buttons beside the online booking.

## Where it lives

| | |
|---|---|
| Rules | `market.js` (pure, tested): profiles, room details, rate terms, the search, party fit and split, deposit, guest details, reference and its key |
| Storage and queries | `marketplace.js` — search, venue page, booking, photos, the venue's settings |
| Public API | `marketrouter.js` at `/api/market` — mounted before the tenant resolver, because it answers for every venue at once |
| Shared with Rates | `rates.availabilityOn` and `rates.pricesOn` — the same counts and prices as the calendar, runnable inside a transaction |
| Dashboard API | `customer.js`: `/businesses/:slug/market…` |
| Storage | migration 33: `subscribers.market_listed`, `market_profile`; `room_groups.profile`; `rate_plans.breakfast`, `cancel_days`; `market_photos`; `bookings.reference`, `due_now_minor`, `payment_status` |
| Website | `/stays` (results), `/stays/<slug>` (venue), `/stays/<slug>/book` (checkout), `/stays/booking/<ref>?k=…` (confirmation); the bar on the home page; **Bookings → Online Booking** in the dashboard |

## How a booking is taken

One transaction holding the room type's row (`FOR UPDATE`): availability is counted and the price
worked out on that transaction, so two guests racing for the last room cannot both have it — the
second waits, then finds nothing free. The checkout sends the total the guest saw; if the venue
changed a price in between, the booking is refused with the new total rather than taken at a
figure nobody agreed to. Several rooms are several booking rows under one reference, the party
spread across them. Every booking is unassigned, like any channel's: the guest booked a type.

The guest gets an email with everything needed at the door and a link back to the booking; the
venue gets one at its account address. Both are sent after the commit and never fail the booking.

A booking opens again by reference **and** key (`HMAC(SECRET_KEY,'booking-access')`), so the
email link works without an account and guessing references gets nothing.

## Cancelling

A guest cancels from their booking page — reference and key, the same pair that opens it — while
the free-cancellation deadline frozen on the booking (`free_cancel_until`, migration 34) is still
ahead and the stay has not started. Every room under the reference is cancelled and released in one
transaction, and both the guest and the venue are emailed. After the deadline, or on a
non-refundable rate, the page sends the guest to the venue instead.

A venue cancelling from its calendar is recorded as `cancelled_by = 'venue'`, and once every room
under the reference is cancelled the guest is emailed who to contact.

## Listing

A venue lists itself on **Online Booking**. Listing is refused until there is a place to search by
and at least one room type with active rooms and a priced rate — a listed venue with nothing to
book is a dead end. Rooms and prices are not edited there: the Rooms and Rates screens own them.

## Not done, and should be

- **Payment.** Choose a provider (Stripe Connect was recommended: per-venue onboarding, money to
  the venue), then charge `due_now_minor` at checkout and set `payment_status`.
- **Terms and privacy.** Reviewslip now passes guests' details to venues and sends booking email.
  The terms and privacy policy need a section on the marketplace. Legal text, not code.
- **Translations.** The stays pages are in all eleven languages, written without a native speaker
  for each. Have the Thai read before the marketplace is announced.
- **Search scale.** Each result runs a handful of queries per venue, capped at 60 venues. Fine
  for tens of venues; batch it before there are hundreds.
- **A venue whose slug is `booking`** would be shadowed by `/stays/booking/…`. Reserve the slug.

## Outside the charter

Selling rooms to guests is not the guest relations manager's job ([app-charter.md](app-charter.md));
bookings belong to vcs-bookings. Built here by decision, recorded in the charter's Outside table.
