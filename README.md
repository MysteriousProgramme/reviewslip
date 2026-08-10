# Review helper

A single page a departing guest opens from a QR code. It writes a short 5-star
review, they tweak it if they want, copy it, and go straight to the Google
listing to post.

One instance serves many venues. Each **subscriber** is one venue, reached at
its own subdomain, holding its own OpenRouter key, model, review link and
website.

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
curl -X POST http://localhost:3000/api/admin/subscribers -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"slug":"baanpong-lodge","name":"Baanpong Lodge"}'
```

The response carries a **settings token, shown once**. Give that to the venue's
staff — it is what unlocks the gear on their page. Only its hash is stored, so
a lost one has to be rotated, not recovered.

Open `http://baanpong-lodge.localhost:3000`, tap the gear, paste the settings
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
baanpong-lodge.reviews.example   ->  the subscriber with slug "baanpong-lodge"
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
`from .env` or `default` so an inherited value is never a mystery. Categories
are the exception — they are the venue's own or the built-in set, with no
`.env` layer in between.

`PORT`, `ADMIN_TOKEN`, `BASE_DOMAIN`, `DEFAULT_SUBSCRIBER`, `TRUST_PROXY` and
`DB_FILE` are `.env` only — they are properties of the installation, not of a
venue.

The panel never receives a key back, only a masked hint like `sk-or-v1••••4f2a`.
Keys are stored in plain text in `data/app.db` (gitignored), so that file
belongs on the machine that runs the app and nowhere else.

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

## Seeding from the venue website

Settings takes the venue's own website address, and **Draft details from website**
reads it — via OpenRouter's `web_fetch` server tool — and proposes the venue
details the review writer may draw on: name, kind, place, a candidate
`safeDetails` list, and which category buttons the venue actually needs.

Every proposed detail quotes the sentence on the page it came from. That's the
point: the no-fabrication guarantee rests on `safeDetails` being true, and a
wrong detail gets repeated in *every* review from then on, not just one. The
source quote makes a wrong one visible at a glance.

Two layers guard it. The seeding prompt forbids awards, superlatives, numbers,
and staff or dish names, and requires a source quote. Then `screen()` in
[seed.js](seed.js) independently drops anything that slips through, and the
panel reports what it dropped and why.

**The output is a draft.** Nothing is written to the venue config — a human
reads the list and decides.

## Categories

The buttons a guest picks from are per venue, **five at most**, edited in the
panel. Each one is a **label** — what the button says — and an optional **note**
that steers what that review talks about. A blank note falls back to the label,
which reads fine: "write one review about Rooms".

Five is the whole picker. Past that a departing guest is reading a menu instead
of tapping the thing that stood out, and the built-in set is exactly five, so
that is the shape the page was designed around. The cap is enforced in
`settings.js` and sent to the panel, so the editor cannot drift from it.

Write them yourself, or press **Suggest from website** and have them drafted
from the venue's own site — the same `web_fetch` read that seeding uses, with a
prompt that only proposes a category the page gives evidence for. A place with
no bar does not get a bar button.

Suggestions are a draft, like the venue-details draft: they fill the editor and
nothing is stored until Save. Once there, they are ordinary rows — rename them,
delete them, write your own. The first suggestion is always the "Any"
catch-all, leaving four for the venue.

The note reaches the writing prompt, so it is screened on the way in: a note
carrying a number or an unverifiable claim ("our award-winning bar") is dropped
and the button kept, because a bad steer there shows up in *every* review under
that button, not one.

Ids are derived from labels and then kept. Renaming *Breakfast* to *Breakfast &
Coffee* keeps the id `breakfast`, so a guest already on that button is not
bounced off it; and a guest whose page predates a category edit falls back to
the first button rather than getting an error.

Remove every row to fall back to the built-in set in `config.js`, the same way
clearing a text field falls back down the chain. Categories skip the `.env`
layer — a list of buttons is not something you set installation-wide.

## Where a review gets posted

A venue can list on Google, on Tripadvisor, on both, or on neither. Each button
only appears once its link is set; with neither set, the page still writes
reviews and says there is nowhere to post one.

Both buttons do the same thing: copy the review to the clipboard, then open the
listing. A failed copy is said out loud rather than swallowed — the listing
opens either way, and arriving there with an empty clipboard is the one thing
that wastes the trip.

## Known limit: the venue identity is still global

Subscribers own their operational settings and their categories. They do not
yet own who the venue *is* — the name, kind, place and `safeDetails` that go
into the prompt still come from `config.js`, one set for the whole
installation. So a second subscriber today gets its own key, model, links and
buttons, but its guests are handed a review written about the venue in
`config.js`.

Moving those four fields onto the subscriber row is what closes this, and it is
also what would let an approved seeding draft be applied rather than only read.

## Where things live

| File | What it holds |
| --- | --- |
| `config.js` | The venue identity, the prompt, and the built-in category set a venue falls back to. Still installation-wide — see above. |
| `db.js` | The SQLite handle and the schema migrations. |
| `subscribers.js` | The subscriber store: rows, tokens, the legacy import. |
| `settings.js` | Resolves a venue's settings down the chain, and validates them. |
| `tenant.js` | Turns a hostname into a subscriber. |
| `auth.js` | The two bearer tokens, and the lockout. |
| `admin.js` | The admin API. |
| `openrouter.js` | The endpoints, the cached model catalogue, the pre-save checks. |
| `seed.js` | The seeding and category-suggestion prompts, plus the screens that drop unverifiable claims. |
| `server.js` | Serves the page, calls OpenRouter, cleans up the completion. |
| `public/` | The page itself. |
| `data/app.db` | Subscribers and their settings. Gitignored. |
| `.env` | Installation settings, plus the fallbacks under every venue. |

## Notes

- The model slug is checked against OpenRouter's live catalogue — on boot for
  every subscriber, and again whenever one is saved — so a typo warns instead
  of failing on first tap. The Model field offers the catalogue as a picker.
- The client sends its last three generations back with each request so
  Regenerate produces something genuinely different, not a reshuffle.
- The review throttle is keyed per subscriber *and* per address, so one busy
  venue cannot throttle another.
- The prompt forbids inventing details. Anything the writer is allowed to
  mention is in `VENUE.safeDetails` in `config.js`.
- Clipboard access needs a secure context. On `localhost` that's fine; when you
  put this on a phone-facing URL, serve it over HTTPS or Copy falls back to a
  less reliable path.
