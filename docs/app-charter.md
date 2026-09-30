# Reviewslip — App charter

Answered once, before any module brief ([02-app-model.md] App charter, [08-module-brief.md]
App-level blocks). Every later module brief works inside it.

- **App name:** Reviewslip
- **Table prefix:** none. [02] rule 2's prefix exists so an app can share a database with
  other apps' tables; Reviewslip owns its whole database, and renaming 18 live tables would
  buy nothing ([architecture.md](architecture.md)).
- **Integration:** **Option 1 (standalone)** — a blank tenant database. No customer in this
  market runs BOS; there is no schema to colocate with.
- **Form factor:** **Desktop only** ([05-frontend.md], decided once per app). No phone tree.
- **Region:** ap-southeast-1 (Singapore). Every tenant is in Thailand.

## The charter

| | Answer |
|---|---|
| **Role** | **Guest relations manager.** At the size of venue we sell to this is the owner or the front-of-house manager — one person who answers what guests write in public. |
| **Starts when** | A guest's review is published on a platform and the app's fetch imports it. The record it creates is one `external_reviews` row, status **New**. |
| **Start record lives in** | **An external platform** — Google, TripAdvisor, Facebook, Wongnai. Not this app, so getting it is an **Option 1 import job** (today's `listingreader.js` fetch), designed and reviewed as an integration at Milestone 5 ([03-bos-integration.md], [10-milestones-review.md]). The charter records where the record lives; it does not design the fetch. |
| **Ends when** | The venue's reply is published on the platform → status **Replied** (Complete group). **The app does not publish it** (decision 2 below): the manager pastes the reply into the platform's own console, and the record closes when the next fetch sees a reply, or when the manager marks it Replied. |
| **Comes from** | **The guest**, via the review platform. What persuades the guest to write at all — the slip, the QR, the table card — is upstream of the start and outside this charter (below). |
| **Goes to** | **Nobody downstream in an app sense.** A review reporting something operational (a broken aircon, a dirty room) is copied out as a record in the app that owns that work — Housekeeping, or Maintenance when it exists — and this app's record still ends at Replied. |
| **Stages** | **New** (Pending) → **Drafted** (Active) → **Replied** (Complete) / **Skipped** (Cancelled). |
| **Other roles** | The **owner**, who reads the rating trend and never replies. **Us**, for support. Neither shapes the screens. |
| **Measure of done** | **Unanswered reviews** — the Home dashboard's first card. Shown with **time to reply** (`posted_at` → `replied_at`), because that is the number the platforms themselves rank on. |
| **Outside the charter** | See below. Each line names the app it belongs to. |

## Outside the charter

Work before the start or after the end belongs to another app ([02-app-model.md] rule 11).
This is the list that decides what may **not** be added to Reviewslip.

| Today's modules | Belongs to | Status |
|---|---|---|
| `housekeeping.js`, `roomstatus.js`, `checklist.js`, `checklists.js`, `shift.js` | **vcs-housekeeping** — role: housekeeper; starts when a room needs cleaning; ends at Clean | Built to the standards, not yet deployed |
| `bookings.js`, `guests.js`, `rooms.js`, `nights.js`, `rates.js`, `tariff.js`, `tm30.js`, `bookingfilter.js` | **vcs-bookings** — role: front-desk clerk; needs its own charter, not yet written | Not started |
| `tickets.js`, `ticketrules.js` | **Our own support desk.** Not a tenant app — the tenant is the person raising the ticket | Stays where it is |
| `plans.js`, `quota.js`, `referrals.js`, `rewards.js`, `subscribers.js` | **Our commercial back office** — billing, the included AI budget, the referral scheme. Not a tenant app | Stays where it is |
| `theme.js`, `sitecolours.js`, `themenote.js`, `assets.js`, `seed.js`, the table card | **The guest page** — the documented exception below | Stays, as an exception |

## Exception: the guest page is not an employee screen

The review slip — the public page a guest lands on from a QR code, and the printed table
card that carries it — is **unauthenticated, has no employee role, and is deliberately
branded per venue**. `theme.js` and `sitecolours.js` exist to make it look like that venue's
own website.

[05-frontend.md] mandates monochrome plus one accent, system fonts and compact density. That
standard governs **employee screens**. The guest page is not one, so it sits outside the app
model entirely — recorded here as an explicit exception, the same way vcs-housekeeping's own
guest page is recorded in its charter.

**What this means in practice:** the theme engine is not a defect to be removed. It is also
not a module — it has no List View and no Edit View, because no employee is looking at a list.
The one-accent rule still governs the **dashboard**, which is an employee screen; it stops at
the guest page.

## App-level: Home dashboard

- **Cards, in order:** 1. **Unanswered reviews** (the charter's open work). 2. **Average
  rating, last 30 days**, with the previous 30 alongside — the only card needing a
  comparison in v1. 3. **Reviews this month**, by platform.
- **Recent activity:** the last 10 `external_reviews` rows by `posted_at`, whatever their status.
  Reviews only; nothing else here produces activity a manager would scan.
- **Quick actions:** none. A review arrives; a person never creates one. This is the rare
  app with no New button on its dashboard, and inventing one would misrepresent where the
  work comes from.
- **Never shows:** another tenant's rows, and no card needing the venue's booking data —
  that lives in a different app and, after the split, different tables.

## App-level: Menu source

**Fixed nav** (`src/config/nav.ts`). Option 2's BOS menu template does not apply.

Nav: **Home** (dashboard), **Reviews** (the one module), **Settings** (the screen).

Listings is not a separate entry — it is a group box inside Settings
([settings-screen.md](settings-screen.md) explains why it is not a module).

## App-level: Setup and help

- **Pre-filled defaults:** the four platforms (`platforms.js`), Thai and English reply
  tones, the reply-length default. Nothing read from BOS — this is Option 1.
- **Setup checklist** (in order, the last item being the charter's start event):
  1. **Add Your Listings** — paste the venue's Google, TripAdvisor, Facebook and Wongnai
     URLs so the app can read its reviews. 3 min. Required. Opens Listings. Done when at
     least one listing is saved.
  2. **Check How We Describe Your Venue** — the AI writes replies from this, so a wrong
     description produces wrong replies. 4 min. Required. Opens Settings → About. Done when
     the description has been saved once.
  3. **Choose Your Reply Voice** — language and tone. 2 min. Required. Opens Settings →
     Replies. Done when saved.
  4. **Read Your First Review** — 1 min. Required. Opens Reviews. Done when a review has
     been opened. **This is the start event.**
- **Wizards:** item 1 only — a linear "paste a URL, we confirm we found the venue" step per
  platform.
- **AI first pass:** item 2. The venue description is drafted from the venue's own website
  ([ai.md]) and the person edits it. Never saved without them looking.
- **Sample data:** neither. A faded fake review would teach the wrong thing about the one
  screen that must always be real.
- **Get-started tutorial:** one, for the guest relations manager — sign in → Listings →
  first fetch → open the oldest unanswered review → write a reply → copy it and publish it on
  the platform.

## Decisions

Both answered by Zac on 2026-09-30.

### 1. Form factor: Desktop only

Replying is typing prose, and at the size of venue we sell to it is done sitting at the front
desk. No phone tree, no `Both` second navigation tree ([05-frontend.md] Form factor).

### 2. The app does not publish replies

The app drafts a reply and hands it over; the manager publishes it in the platform's own
console. No write API is called, for any platform, in any version — this is a decision, not a
deferral.

**What follows from it, and must not be designed around later:**

- **The charter's end event happens outside the app.** The app observes the end; it does not
  perform it. Every design here has to be honest about that.
- **The app therefore needs two ways to close a record**, because one of them is unreliable:
  1. **The fetch sees a reply** and sets Replied. This is the good path, but it only works on
     platforms whose replies we can actually read, and it lags by up to the fetch interval.
  2. **The manager marks it Replied.** Required, not a convenience. Without it, a review on a
     platform whose replies we cannot read would sit on the unanswered list for ever, and the
     charter's measure of done would be permanently wrong.
- **The Reply editor's output is a clipboard payload**, so it must be plain text that survives
  a paste into someone else's textarea. No formatting, no markdown, no smart quotes.
- **The measure of done is approximate by design.** "Unanswered reviews" can briefly overcount
  between a manager publishing a reply and the next fetch. That is acceptable; a number that
  is occasionally one too high is better than a write integration we cannot support.
