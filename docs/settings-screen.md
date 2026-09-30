# Reviewslip — the Settings screen (Listings included)

**This replaces the two module briefs I said were outstanding.** Neither Listings nor Settings
is a module, and writing them as modules would have been wrong:

- **Settings is a screen, not a module.** [05-frontend.md]'s "Settings screen (app-level
  settings)" says in terms that it belongs to no module. Module briefs ([08]) describe a
  record with a List View and an Edit View; app settings have neither.
- **Listings is not a module either.** It is four URLs and a button. There are exactly four
  platforms, fixed in `platforms.js`; a venue never creates a fifth, and the rows have no
  status a person works through from a start to an end. Making it a module would mean
  inventing a table for four rows that are really settings, and a List View that never
  changes. It belongs here, as one group box — which is where it already is.

So Reviewslip has **one module** (Reviews), a Home dashboard, and this screen.

Scope: `/dashboard/[slug]/settings`, today `components/dashboard/SettingsForm.tsx`, backed by
`settings.js` and columns on `subscribers`.

## Who

The account that owns the venue. [05] scopes the Settings screen to a BOS admin
(`users.admin_id = 1`); Reviewslip has no BOS and no per-venue roles — one account owns a
venue and that account is its admin. `requireOwnVenue` already enforces exactly this. A second
role inside a venue is not a thing this product has, and inventing one for a checkbox would be
building for a problem nobody has.

## Storage — a recorded deviation

[05] says settings live in an app-owned table, one row per setting. Reviewslip stores them as
**columns on `subscribers`**, with a `settings.js` resolver layering each venue's own value
over a platform default.

Keeping it. The resolver is the valuable part and a row-per-setting table would not change it;
the column layout is what makes "this venue's value, or the fallback" a single read. Recorded
in [architecture.md](architecture.md) alongside the other five.

**One consequence to respect:** `settings.js` returns every field as `{ value, source }` where
`source` is `subscriber` or `default`. The screen must keep showing which is which — a field
silently inheriting a platform default looks identical to one the venue set, and those are
different facts.

## Layout

One group box per topic, in this order. Today's three tabs (General / Topics / Theme) become
the first four boxes; **Writing** is new.

### 1. Venue

| Field | Editor | Notes |
|---|---|---|
| Business name | Text | Shown on the guest page and the table card |
| Business website | Text (URL) | Not shown to guests. It is what Topics and Theme are read from — the hint must say so, because the field otherwise looks like marketing |

### 2. Listings

The four platforms from `platforms.js`, each a row: brand mark, URL field, and a **Not on this
platform** checkbox.

- **The checkbox is load-bearing**, not a convenience. Without it, "have you set your
  Tripadvisor link" has two answers that look identical — *not yet* and *never* — and the
  setup checklist can never reach complete for a venue that only uses Google, which is most of
  them. A checklist that nags forever stops being read.
- **A link beats the flag.** Someone who marked Tripadvisor unused and later pasted a link has
  changed their mind; they must not have to untick a box first.
- **Wongnai has no brand mark** and gets a letter chip. A hand-drawn approximation of a
  trademark is worse than an honest initial.
- **Per-listing health** belongs here, next to the URL it is about: when we last read this
  listing, how many reviews we found, and the failure if the last read failed. A failed read is
  reported against the field that caused it, not as a toast on another screen.

**Check For New** sits on Reviews, not here — it is operational, and that is the screen where
its result appears.

**Recorded honestly, because whoever maintains this must not discover it by surprise:**
`listingreader.js` states that automated reading of a listing page is **against Google's terms
of service**. It runs only when a person presses a button for their own listing, and fetches
that one page once. That is a description of the scale, not an exemption. Consequences that
follow and must not be "improved" away:

- **No scheduled fetch. No background job. No fetch-all-venues cron.** The button is the
  design, not a placeholder for automation.
- The charter's start event therefore depends on somebody pressing it. That is a known weakness
  of the charter, not of this screen.
- A real API (Google Business Profile, Tripadvisor partner) replaces this the day it is
  available, and that is an integration reviewed at Milestone 5.

### 3. Topics

Up to 50, each `{ label, focus }`. The label is a button on the guest page; the focus is a
short bullet list the model writes from.

- **Re-generate From Website** rewrites the whole set from the venue's site — **except locked
  rows**, which are carried across untouched along with anything new that is not a duplicate
  of them.
- A blank label is a deleted row. An id sent back unchanged keeps a guest's in-flight
  selection working across a label edit.
- Limits, from `settings.js`: 50 topics, and 600 characters of description each.
- **Lock** (per row, and in the description editor) holds a topic against a re-generation.
  Locking also disables that row's **Write / Rewrite**, so the one flag means "no AI touches
  this" wherever it is read.
- **Write / Rewrite** fills one row's description from the topic name and the venue's website,
  one row at a time because each is a model call. Disabled on a locked row.
- **Order is the venue's.** `settings.js` returns topics in stored order and the editor moves
  them with **Move Up / Move Down**. The guest page draws ten at random but keeps this order
  (`sampleIds` — random *which*, not random *where*), so both screens agree on the venue's own
  sequence.
  - Reading used to sort alphabetically through a collator. That sort had to go, or the move
    buttons would have appeared to work and been undone by the next read. The collator still
    orders a **freshly proposed** set, where nobody has chosen an order yet.

### 4. Theme

Four colours — Background, Paper, Accent, Highlight — plus display and UI fonts, a logo and a
background image.

- **Generate From Website** reads the site's own stylesheets first and the model second. A
  colour the site actually names is a different claim from one a model liked the look of, and
  `sitecolours.js` exists to keep those apart.
- **Anything we should know?** — a free-text note, 300 characters, with suggestion chips
  ("Warmer", "Calmer, less contrast", "Use the colour from our sign", "Keep the table card
  quieter than the website"). It adjusts the colours already chosen rather than re-reading the
  site.
- The preview must draw the **derived** variables, not the four raw colours. Showing the raw
  four promises a page the guest is not going to get — the contrast pass moves them.
- Anything the contrast pass had to move is shown as moved, with the reason.

### 5. Writing — **new, and the one real gap**

The venue's OpenRouter key and model.

**Today there is no way for a customer to set a key.** `settings.js` resolves `apiKey` and
`model`, and the admin API can write them, but `SettingsForm.tsx` has no field for either. Yet
`setup.js` lists **"A writing key"** as a *blocking* checklist step. So a new venue is shown a
red, blocking item on its own dashboard that it has no means of clearing, and the guest page
refuses to work until someone at Reviewslip fixes it out of band.

That is the single worst thing I found in this survey, and it is a four-line screenshot away
from being obvious to a customer.

**Decided 2026-09-30: we own the key.** It is our cost — the 1,500-review budget — so it is
never the venue's outstanding work. **There is no Writing group box**, and this screen has
four boxes, not five.

Implemented in `setup.js`:

- The `key` step is gone from `steps`, so a venue's checklist is **three items**, all of which
  it can actually do.
- It is gone from `blocking`, which now answers only "what is the venue still to do".
- `canTakeReviews` asks for the key separately, so a missing key still stops the guest page.
- A new **`waitingOnUs`** says the venue has finished its side and is waiting on us. It is
  deliberately not `!key`: while the venue still has steps of its own, whose turn it is has an
  obvious answer, and saying "waiting for us" alongside their outstanding work would be an
  excuse rather than information.
- `guestMessage()` now takes the whole `progress()` result rather than `blocking`. It had to:
  once the key left that list, a venue missing only its key would have had an empty `blocking`,
  **no banner at all**, and a Generate button that quietly failed.

On the dashboard, `waitingOnUs` draws a **"Nearly there"** panel with nothing to click. Without
it the panel would vanish on `complete` while the guest page still refused — the same invisible
failure `SetupProgress` exists to prevent, only worse, because the venue would be certain it
had finished.

**BYOK is not ruled out for ever** ([ai.md] describes it, and the API already validates a key
live on save). If it returns, it is an addition to this screen, not a reversal: `waitingOnUs`
stays the right answer for every venue on the included budget.

## Save

One Save for the whole screen, behaving like every Edit View's Save ([05]): disabled until
something changes, the default action on Enter, and the draft laid over server data so a
refetch cannot overwrite something typed and unsaved.

**Validation that must stay server-side:** the OpenRouter key and model slug are checked
against OpenRouter's live catalogue on save. A typo is refused rather than stored, which is why
setting a placeholder key is impossible. Keep it.

## Help and guidance

| | Answer |
|---|---|
| **Help ids** | `settings.venue`, `settings.listings`, `settings.topics`, `settings.theme`, `settings.writing` |
| **Docs pages** | Reference: "Settings". How-to: "Add your review listings", "Choose what guests write about", "Match the page to your brand", "Mark a platform you are not on" |
| **Teaching tip** | Settings: *"Everything a review about this business is allowed to say. Most of it is read off your website — set that first and the rest fills in."* |
| **Empty states** | Topics with none: "No topics yet. Add your website above and we will suggest some." Listings with none linked: "No listings yet. A review with nowhere to go is never posted." |
| **Tooltips and hint text** | *Business website* — "Specifies the site we read your topics, colours and logo from. Guests never see it." *Not on this platform* — "Tells us to stop asking about this one." *Anything we should know?* — "Adjusts the colours we picked. It does not re-read your site." |
| **Setup checklist items** | All three: topics, a listing, and every platform decided. There is no fourth — the writing key is ours |

## Tests

The [09] rows that apply, adapted to this stack ([architecture.md](architecture.md)):

- `settings.js` is a **pure module**: resolution (venue value over platform default, and the
  `source` each field reports), topic validation (50 max, 600-character focus, blank label
  dropped, id preserved across a label edit), and platform on/off precedence — all testable
  with no database, in `test/`.
- `setup.js` is already pure: each checklist step's done rule, `canTakeReviews`, and the guest
  message for each blocking reason.
- API: a save from an account that does not own the venue is `403`; a bad key or model slug is
  `400` and stores nothing.
- One end-to-end path: paste a listing URL → Save → the venue page's checklist advances.

## Milestones

| Milestone | Reviewer | Date | Decision | Notes |
|---|---|---|---|---|
| 1. Functional spec (this document) | | | | Ready for review — the Writing decision was made 2026-09-30 |
| 3. Data structure & mockup | | | | The screen exists; a mockup is only needed for the Writing box |
| 4. Standalone | | | | |
| 5. Integration: listing fetch | | | | Carries the terms-of-service note above |
