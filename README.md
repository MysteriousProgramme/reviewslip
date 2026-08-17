# Review helper

A single page a departing customer opens from a QR code. It writes a short
5-star review, they tweak it if they want, copy it, and go straight to the
listing to post.

One instance serves many venues. Each **subscriber** is one venue, reached at
its own subdomain, holding its own OpenRouter key, model, review links and
website.

Nothing in the app describes a particular kind of business. It is sold to
whoever wants it — a lodge, a dental clinic, a garage — so what the writer knows
comes in two layers: [context.js](context.js) holds the craft, the same for
everyone, and each venue's own row holds who it is. See
[What the writer knows](#what-the-writer-knows).

## Run it

```bash
npm install
```

Copy `.env.example` to `.env` and set `ADMIN_TOKEN` — without it the admin API
refuses to answer, and there is no other way to create a subscriber.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
npm start
```

Then create a venue:

```bash
curl -X POST http://localhost:3000/api/admin/subscribers -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"slug":"riverside-dental","name":"Riverside Dental"}'
```

The response carries a **settings token, shown once**. Give that to the venue's
staff — it is what unlocks the gear on their page. Only its hash is stored, so
a lost one has to be rotated, not recovered.

Open `http://riverside-dental.localhost:3000`, tap the gear, paste the settings
token, then paste an [OpenRouter key](https://openrouter.ai/keys). The key is
checked against OpenRouter as you save it, so you know straight away whether it
works.

Browsers resolve every `*.localhost` name to the loopback address on their own,
so that address works with no DNS setup. In production, `BASE_DOMAIN` needs a
wildcard DNS record and a wildcard TLS certificate.

### Coming from the single-tenant version

Leave `settings.json` where it is and start the app. If the store is empty it
becomes the first subscriber, and the boot log prints its address and settings
token once. After that the file is ignored and safe to delete.

## Addresses

The hostname picks the venue:

```
riverside-dental.reviews.example   ->  the subscriber with slug "riverside-dental"
reviews.example                  ->  the apex; not a venue
www.reviews.example              ->  reserved; not a venue
```

A slug has to be a legal DNS label, because it becomes one. Anything that does
not resolve to an active subscriber gets a 404 saying so, rather than someone
else's review page. To run a single venue with no DNS at all, set
`DEFAULT_SUBSCRIBER` and every unmatched hostname falls back to it.

Behind a reverse proxy, set `TRUST_PROXY` so the guest's real hostname and
address are read from `X-Forwarded-*`. Leave it off when the app faces the
internet directly — trusting those headers from an untrusted client lets a
caller pick its own subscriber and dodge the throttle.

## Settings

Every field resolves in this order, per venue:

```
the venue's own row  ->  .env  ->  built-in default
```

The `.env` layer is deliberate: one platform key there works for every venue,
and a venue that brings its own overrides it. Clearing a field in the panel
falls back through the same chain, and the panel labels each value `this venue`,
`from .env` or `default` so an inherited value is never a mystery.

Who the venue *is* skips the chain entirely — its topics, its details, what kind
of place it is, where it is, and its own AI context. There is no `.env` layer and
no built-in value for any of them, because one venue's description is worse than
nothing for another: a business that has not described itself gets no topic
buttons and is told to claim no specific fact, rather than inheriting somebody
else's garden.

`PORT`, `ADMIN_TOKEN`, `BASE_DOMAIN`, `DEFAULT_SUBSCRIBER`, `TRUST_PROXY` and
`DATABASE_URL` are `.env` only — they are properties of the installation, not of
a venue.

The panel never receives a key back, only a masked hint like `sk-or-v1••••4f2a`.
Keys are stored in plain text in Postgres, so it should listen on loopback only
and stay on the machine that runs the app.

## API

Two tokens, both `Authorization: Bearer …`.

`ADMIN_TOKEN` manages subscribers, on any hostname:

| Route | What it does |
| --- | --- |
| `GET /api/admin/subscribers` | List them. Keys masked. |
| `POST /api/admin/subscribers` | Create one. Returns the settings token, once. |
| `GET /api/admin/subscribers/:slug` | One of them. |
| `PATCH /api/admin/subscribers/:slug` | Change name, status or any setting. |
| `DELETE /api/admin/subscribers/:slug` | Remove it. |
| `POST /api/admin/subscribers/:slug/token` | Rotate; the old token dies at once. |

A venue's settings token edits only that venue, on that venue's hostname. The
admin token works there too. `status` is `active` or `suspended`; a suspended
venue's page returns 403.

| Route | Auth |
| --- | --- |
| `GET /api/config`, `POST /api/review` | none — the guest page |
| `GET`/`POST /api/settings`, `GET /api/models`, `POST /api/seed`, `POST /api/categories/suggest` | settings token |

Ten failed token attempts from one address locks that address out of the
settings routes for fifteen minutes. Guests are unaffected — only the panel.

## What the writer knows

Two layers, on purpose, because they have different lifetimes.

**The generic context document**, [context.js](context.js), is the same for every
business on the platform. It opens with the rules that get a customer or a
business into trouble if broken — see [Compliance](#compliance) — and then turns
to craft: what a real review reads like
(short, uneven, one or two specific things, slightly imperfect, no marketing
vocabulary), and what a *page* of manufactured ones reads like — the repeated
opening formula, the uniform length, the recurring adjectives, the closing
"Highly recommend!". That second half is the one that matters, because every
review this writer produces lands on the same listing, and those tells are
invisible in one review and obvious across twenty. It is the authenticity section
of our own published guide, turned into instructions.

It is a git-tracked file rather than a database row deliberately: a bad edit here
degrades every review on the platform at once, so it gets reviewed and deployed
like the code it is. It goes into every generation, so it earns its length or it
comes out. It names no kind of business anywhere.

**The business's own context**, one row each, is where the specifics live:

| Field | What it is |
| --- | --- |
| `kind`, `place` | What kind of business, and where. |
| `safeDetails` | The only things a review is allowed to *claim*. Editable. |
| `contextDoc` | Free prose: who comes here, what they mention, how their reviews read. Editable. |
| `categories` | The topics a customer picks from. |

`safeDetails` and `contextDoc` are deliberately different in kind. A detail is a
fact the review may assert, so it is screened hard — no numbers, nothing a
customer could not check with their own eyes — whether a model proposed it or a
person typed it. The context document asserts nothing: the prompt tells the
writer it is background for tone and subject matter and not to repeat claims from
it, which is why a figure is allowed there and refused in a detail. Superlatives
are refused in both, because "award-winning" comes back out in the reviews
whatever the framing says.

### Compliance

The first section of [context.js](context.js) mirrors the guide we publish at
<https://reviewslip.com/faq>, which is generated from
`lib/i18n/dictionaries/*.ts` in the website repo. **That guide is the source of
truth — when it changes, `COMPLIANCE` changes with it.** A test asserts every
rule survives into the assembled prompt, including for a business with nothing
filled in, so the check is mechanical rather than something someone has to
remember.

Most of the published guide is deliberately *not* in the prompt. It is largely
advice to the owner — where the QR code goes, not asking only the happy ones,
not letting everyone post from the venue WiFi, not emailing the whole list at
once. None of that is something the writer can obey or disobey, and pouring it
into every generation would dilute the part that is. What is carried across is
the subset that constrains the review *text*: the ways a sentence can itself be
the violation.

| Rule | The question it comes from |
| --- | --- |
| Nothing the customer did not experience | "What do these rules actually ban?" |
| No mention of a discount, gift or reward | "Can I offer a discount or a free item for a review?" |
| Written as a customer, never an insider | "Can staff, friends or family leave reviews?" |
| No reference to being asked, prompted or reminded | undisclosed solicitation |
| No award, ranking or named-competitor comparison | unverifiable claims |
| Understate rather than overstate | it stays the customer's to edit and post |

The sameness rules in the section below carry the last one — "Will AI-drafted
reviews all read the same?" — which the guide answers with *yes, and it is a real
risk*.

This is a mirror rather than a live fetch on purpose. Reading the page per
generation would add a network call and a failure mode to every review, feed the
model a page that is mostly irrelevant to it, and let an edit to a marketing page
silently change every prompt on the platform with nobody reviewing it. Encoded
here, the rules are versioned, diffable and tested.

### Learning from the reviews already written

The nearest thing to training the product does, and it happens per generation
rather than in a training run. The writing prompt carries, in this order:

1. **A realism sample** — reviews already written for this business, framed as
   *how a real one reads here*: their length, their level of detail, how much
   they leave out. Skipped once the owner has approved anything, because an
   approved review is a better example than an unrated one.
2. **The approved ones** — match their tone and length, not their wording.
3. **The rejected ones** — what this business does not want said about it, which
   the approved ones cannot express.
4. **What to write away from** — make this clearly different in wording,
   structure and opening.

The realism sample and the write-away-from list are disjoint slices of one random
draw, not two draws: the same review in both would be an instruction to differ
from itself. And the sample is drawn across the last hundred rather than taking
the newest few — the newest few are already the most alike, so steering around
only those leaves the model free to drift back onto last week's review.

## Reading the venue website

Settings takes the venue's own website address, and three buttons read it via
OpenRouter's `web_fetch` server tool:

| Button | Proposes |
| --- | --- |
| **Read website** | `kind`, `place`, and the `safeDetails` list. |
| **Generate from website** | The topic set. |
| **Draft from website** | The AI context document. |

**Every one of them returns a draft.** Nothing is stored by reading a website:
the values land in the editor, and Save is a separate deliberate act — so a human
reads every line before it can reach a review.

Every proposed *detail* quotes the sentence on the page it came from. That's the
point: the no-fabrication guarantee rests on `safeDetails` being true, and a
wrong detail gets repeated in *every* review from then on, not just one. The
source quote makes a wrong one visible at a glance.

Two layers guard it. The prompt forbids awards, superlatives, numbers, and staff
or dish names, and requires a source quote. Then `screen()` in [seed.js](seed.js)
independently drops anything that slips through, and the dashboard reports what
it dropped and why. The context draft is screened the same way but by the
sentence, so one bad clause costs a sentence rather than another minute of
waiting — and the customer is told which sentence went.

The context draft also reads whatever review links are set, not just the website.
How a business's own customers already write is the most useful thing on the
subject and the one thing its marketing pages cannot say. Often the listing will
not be readable — Google renders its reviews in the browser, so a fetch gets a
shell — and the prompt is explicit that seeing none is a normal outcome and to
say nothing rather than describe reviews it has not read.

## Topics

The buttons a customer picks from are per venue, **thirty at most**, edited in
the dashboard. Each one is a **label** — what the button says — and an optional
**note** that steers what that review talks about. A blank note falls back to the
label, which reads fine: "write one review about Rooms".

The guest page shows **ten of them, drawn at random**, with the rest behind
**Browse for more topics**. That is the reason the cap is thirty rather than
five. The old argument for five was about the *picker* — a departing guest past
five is reading a menu — and sampling satisfies it while making the set behind it
worth having: two customers an hour apart are offered different tens, so they
lead with different subjects, and the listing does not fill up with reviews about
the same three things.

The sample keeps the venue's own order rather than shuffling. The list is written
most-obvious-first, and a picker that reordered itself every load would make the
same ten feel like a different ten. Random *which*, not random *where*. A topic
the guest picked while browsing stays on screen after the list collapses, so a
choice is never silently dropped while still being sent.

There is no "Any" catch-all any more. It used to be pinned first out of five,
which does not survive sampling, and it was never needed: a customer who taps
nothing already gets a review about the visit overall.

Write them yourself, or press **Generate from website** and have up to thirty
drafted from the venue's own site. Breadth is where a model pads, so the prompt
says plainly that a short honest list is a correct answer and splits the subjects
in two: things this business demonstrably *has*, which need evidence on the page,
and things every customer of any business experiences — the welcome, how you were
treated, whether you would come back — which do not. That split is what makes
thirty reachable without inventing a bar.

The note reaches the writing prompt, so it is screened on the way in: a note
carrying a number or an unverifiable claim ("our award-winning bar") is dropped
and the button kept, because a bad steer there shows up in *every* review under
that button, not one.

Ids are derived from labels and then kept. Renaming *Breakfast* to *Breakfast &
Coffee* keeps the id `breakfast`, so a guest already on that button is not
bounced off it; and a guest whose page predates a topic edit has the unknown id
dropped and gets a review about the visit overall rather than an error.

Remove every row and the venue has no topics — not somebody else's. Topics skip
the `.env` layer; a list of buttons is not something you set installation-wide.

## Review length

The guest picks **Any**, **Short** or **Detailed** next to the topics. Real
listings are not uniform, and every review being the same length is itself one of
the tells in the generic document — so what the guest picks is which *pool* a
length is drawn from, not an exact length. Asking twice for Short still gives two
different shapes. Any draws from both pools, which is what the page did before
the selector existed.

The word ceiling in the system prompt moves with the choice: under 30 for Short,
45 for Any, 80 for Detailed. A "Detailed" review still capped at 45 words would
not be detailed. The choices are sent to the page by `/api/config` rather than
hardcoded in it, so the selector cannot drift from the prompt — the same reason
the language list is.

## Where a review gets posted

A venue can list on Google, on Tripadvisor, on both, or on neither. Each button
only appears once its link is set; with neither set, the page still writes
reviews and says there is nowhere to post one.

Both buttons do the same thing: copy the review to the clipboard, then open the
listing. A failed copy is said out loud rather than swallowed — the listing
opens either way, and arriving there with an empty clipboard is the one thing
that wastes the trip.

## Tests

```bash
npm test
```

Node's own runner, no database and no network. The prompt is a pure function of a
business and a guest's choices, so it is tested as one: that Short reached the
prompt, that a business with no details is not handed somebody else's, that a
superlative typed into the context box does not survive to the listing, that the
realism block and the write-away-from block keep their separate framings.

What it cannot tell you is whether the reviews are any *good*. That only comes
from reading them, which is what the dashboard's thumbs are for — and what the
realism sample feeds back into the next one.

## Where things live

| File | What it holds |
| --- | --- |
| `context.js` | The generic context document: the craft, the same for every business. |
| `config.js` | The writing prompt — how the generic document, the business, the topics, the length and the prior reviews are assembled into two messages. |
| `db.js` | The Postgres pool and the schema migrations. |
| `subscribers.js` | The subscriber store: rows, tokens, the legacy import. |
| `settings.js` | Resolves a venue's settings down the chain, and validates them. |
| `tenant.js` | Turns a hostname into a subscriber. |
| `auth.js` | The two bearer tokens, and the lockout. |
| `admin.js` | The admin API. |
| `openrouter.js` | The endpoints, the cached model catalogue, the pre-save checks. |
| `seed.js` | The seeding and category-suggestion prompts, plus the screens that drop unverifiable claims. |
| `server.js` | Serves the page, calls OpenRouter, cleans up the completion. |
| `public/` | The page itself. |
| `scripts/import-sqlite.js` | One-off: copies subscribers out of the old `data/app.db` into Postgres. |
| `.env` | Installation settings, plus the fallbacks under every venue. |

## Notes

- The model slug is checked against OpenRouter's live catalogue — on boot for
  every subscriber, and again whenever one is saved — so a typo warns instead
  of failing on first tap. The Model field offers the catalogue as a picker.
- The client sends its last three generations back with each request so
  Regenerate produces something genuinely different, not a reshuffle.
- The review throttle is keyed per subscriber *and* per address, so one busy
  venue cannot throttle another.
- The prompt forbids inventing details. Anything the writer is allowed to claim
  is in that venue's own `safeDetails`; a venue with none is told to write about
  the customer's impression and state no specific fact at all.
- When a venue has exactly one review link set, the prompt says which platform
  the review is bound for — a Google review and a Xiaohongshu post are different
  genres. With two or more it stays neutral, because the guest picks the button
  after the review is already written.
- **The generic context document costs tokens on every generation.** A bare
  prompt went from roughly 315 tokens to 890, and one with a context document,
  topics and the full realism and avoid samples reaches about 1,630. At the
  1,500 reviews a month `plans.js` allows per business, that is 1.4M–2.5M tokens
  against a stated allowance of 1M. Neither limit is enforced on the review path
  today — only the per-address hourly cap is — so nothing breaks, but the
  dashboard's token meter will read over 100% for a busy venue and the OpenRouter
  bill is roughly three times what it was. Raising
  `TOKENS_PER_MONTH_PER_VENUE` is one lever; trimming `context.js` is the other.
- Clipboard access needs a secure context. On `localhost` that's fine; when you
  put this on a phone-facing URL, serve it over HTTPS or Copy falls back to a
  less reliable path.
