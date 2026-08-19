# Review helper

A single page a departing customer opens from a QR code. It writes a short
5-star review, they tweak it if they want, copy it, and go straight to the
listing to post.

One instance serves many venues. Each **subscriber** is one venue, reached at
its own subdomain, holding its own OpenRouter key, model, review links and
website.

Nothing in the app describes a particular kind of business. It is sold to
whoever wants it — a lodge, a dental clinic, a garage — so what the writer knows
comes in two documents: [context.md](context.md) holds the craft, the same for
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

Two documents, and the split is the whole design.

**[context.md](context.md) — the generic one.** Markdown, in the repo, loaded
once at boot and folded into **every** review request for **every** business on
the platform. It is the part every customer's context has in common: what a
real review reads like, what a page of manufactured ones reads like, the
register to write in, and the compliance rules that keep a customer and a
business out of trouble. It names no kind of business anywhere.

**The business's own context** — one row each, edited in the dashboard, added
after the generic one. Who they are, their topics, the details a review may
claim, and their own About text.

They are separate because they have different lifetimes. `context.md` is
reviewed, versioned and deployed like code, because a bad edit there degrades
every review on the platform at once. A business's own context is edited by its
owner and can only affect them.

`context.md` is prose in a markdown file rather than string literals in
`context.js` for the same reason: it is read by a model, not parsed as
configuration, so it should be editable by someone who is not going to open a
`.js` file — and its diffs should show the argument changing rather than a
string literal changing. `context.js` reads it, finds the four `##` sections by
name, and **refuses to start if one is missing**. An app that will not boot is a
far better outcome than reviews quietly shipping with no compliance rules in
them.

Every business can see both halves assembled: **Download context.md** on the
General tab of its settings gives the real system prompt exactly as sent, its
topics, and the reviews its ratings are currently feeding back.

Those specifics are:

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

The first section of [context.md](context.md) mirrors the guide we publish at
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
   they leave out. Skipped once the owner has rated anything five stars, because
   a five-star review is a better example than an unrated one.
2. **The five-star ones** — match their tone and length, not their wording. Five
   and only five: four means "nearly", and a business rating honestly will have
   far more fours than fives, so feeding those back would teach the writer to aim
   at nearly-right. The bar is the top of the scale, which makes marking one a
   decision rather than a shrug. Up to five of them, newest-rated first, since
   each costs prompt tokens on every review from then on.
3. **The one and two star ones** — what this business does not want said about
   it, which the good ones cannot express. Worst first, unlike the examples: if
   only three fit, they should be the three the owner disliked most rather than
   the three they happened to rate most recently.
4. **What to write away from** — make this clearly different in wording,
   structure and opening.

Three and four stars are recorded and deliberately fed back neither way: they
are the reviews that were merely fine, and teaching the writer to aim at fine is
how everything ends up fine.

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

The buttons a customer picks from are per venue, **fifty at most**, edited in
the dashboard. Each one is a **label** — what the button says — and an optional
**note** that steers what that review talks about. A blank note falls back to the
label, which reads fine: "write one review about Rooms".

The guest page shows **ten of them, drawn at random**, with the rest behind
**Browse for more topics**. That is the reason the cap is fifty rather than
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

Write them yourself, or press **Generate from website** and have up to fifty
drafted from the venue's own site. Breadth is where a model pads, so the prompt
says plainly that a short honest list is a correct answer and splits the subjects
in three:

1. **Named things the business is known for** — a signature dish, a house
   speciality, a flagship product, a treatment it is identified with. Taken by
   name off the page: "The Pad Thai", "The Sunday Roast". These are the topics
   customers most want to talk about, and they are the reason the cap is fifty
   rather than thirty: a menu or a product range gives a real one per line.
2. **Specific but unnamed** — a room type, a space, a facility, somewhere
   nearby. A business with no bar does not get a bar topic.
3. **Common to any visit** — the welcome, how you were treated, whether you
   would come back. These need no evidence and suit any business.

That split is what makes a long list reachable without inventing a bar. The
prompt leads with the first kind where a business has any, and is explicit that a
name must be printed on the page — never invented, never guessed at from what a
business of that kind usually offers.

A named topic changes what the writer may say. The writing prompt used to ban
dish names outright, which would have made "The Pad Thai" a button the writer
was forbidden to discuss; it now permits naming **the specific thing the topic
names, and nothing else** — that name came off the business's own pages and the
customer chose it, so it is not an invention. Everything else stays banned: no
staff names, no prices, and no name the writer supplied itself.

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

## Themes

A business picks four colours, two typefaces and its logo — or has all of it read
off its own website — and they dress its review page and its printed table card.

### Colours

| Slot | What it is |
| --- | --- |
| `ground` | the deep background behind the page |
| `paper` | the card the review is written on |
| `accent` | labels, borders, topic buttons |
| `highlight` | spent once, on the button that opens the listing |

Four rather than a full palette because four is what a model can genuinely read
off a page — a header, a body, a button — while the tints, shades, the softened
text and the colour of the label *inside* the button are arithmetic.
[theme.js](theme.js) does that better than a prompt can, and it makes the result
checkable: four hex values either parse or they do not.

### Readability is enforced, not requested

A brand palette is not an interface palette. A pale gold that works in a logo is
unreadable as body text on a phone outdoors, and asking a model to do WCAG
arithmetic gets confident wrong numbers. So every colour that ends up as text is
nudged until it clears a ratio, and what moved is reported back in words:

| Pair | Ratio | Why |
| --- | --- | --- |
| review text on paper | 7:1 | the one thing a guest reads word by word, outdoors |
| soft text on paper | 4.5:1 | |
| labels on ground | 4.5:1 | |
| the post button's colour on ground | 4.5:1 | a second listing renders it as text, not a fill |
| the label inside the button | 4.5:1 | |
| paper against ground | 3:1 | not text — it only has to read as a separate surface |

The nudge tries white *and* black at each step and takes whichever clears the
target with the least movement. Picking the direction from the background's
luminance is the obvious implementation and it is wrong for any mid-tone colour:
a coral button reads as "dark, go toward white", but white on coral is 2.7:1 and
no amount of further whitening helps, while black clears 8:1 at once.

Only one thing is refused outright — a ground and paper too close to tell apart,
because every fix above needs a direction to push in and that leaves none.

### Typefaces

The business's **real font files**, read out of its own `@font-face` rules and
downloaded, with a curated shortlist as the fallback. Two slots — the review text
and everything else — and they are independent, so a site whose headings are
self-hosted and whose body text comes from a foundry CDN keeps the one it may
keep.

**The licence is the hard part, and it is not ours to judge.** A review page is
on our domain, so a grabbed font is served from ours. Most paid typefaces are
licensed per website and do not allow that. Three things follow:

- **Per-domain foundries are refused before any request is made** —
  `use.typekit.net`, `fast.fonts.net`, `cloud.typography.com` and the rest of the
  list in [assets.js](assets.js). Serving one of their files from here would be a
  breach by us, not by the customer whose site it came from. Most of them block
  the request anyway; refusing first turns a download error into a sentence
  explaining why.
- **Self-hosted files are allowed**, because the business may well hold a licence
  that covers this and is the only party that can know.
- **The dashboard asks it to confirm that**, per draft, and the file is only
  stored once it has. Unticking falls back to the shortlist.

Everything else is treated as untrusted, because it is. The family name is read
off a third party's stylesheet and written straight back into a rule we serve, so
it is stripped of anything that could end a declaration. The file goes through
the same address checks as the logo. And nothing but a downloaded, checked file
can be stored — this must never become a way to put arbitrary bytes behind a font
URL on our own domain.

The fallback shortlist is open-licensed and served from Google Fonts. A font is
chosen by **id** from it, never by name, precisely so that a model's output
cannot become part of a URL.

Every stack ends in a generic family. A themed face covers Latin; a review
written in Thai, Chinese, Japanese or Korean falls through to whatever the device
has. That is the right outcome — few of these faces carry those scripts, and the
alternative is a page of boxes. It is also why the two shipped faces are Trirong
and Bai Jamjuree, which do carry Thai.

### The logo

Fetched **once, server-side, and stored** as a data URI — never hotlinked.
Hotlinking would put a request to the customer's server on every guest's phone,
leaking the guest's address to a third party and breaking the page the day the
customer reorganises their media folder. A logo is a few kilobytes; our own copy
is cheaper than either problem.

The URL comes from a model reading a page, which means it ultimately comes from
whatever is *on* that page. So [assets.js](assets.js) treats it as hostile:

- **https only.** A logo fetched in the clear can be swapped in transit and would
  then be served from our own domain.
- **The address is resolved and checked before the request**, and again on every
  redirect. `169.254.169.254` is the one that matters on EC2 — the instance
  metadata service, and a well-known way to turn "fetch this image" into "hand me
  your credentials". Loopback, the private ranges, carrier NAT, link-local and
  IPv4-mapped IPv6 are all closed behind it. Every DNS record is checked, not the
  first, because a name resolving to one public and one private address is a way
  past a check that only looks once.
- **Type and size are checked** — 120kB, and only formats an `<img>` can render.

SVG is allowed, because logos usually are one and it is by far the smallest
option. That is safe *here* specifically because the result is only ever rendered
through an `<img>` tag, which runs no script and loads no subresources. It must
never be inlined into the DOM as markup — different context, different rules.

### The background photograph

Grabbed the same way as the logo — the hero image off the front page, downloaded
once and stored — and then **never used as a background**. It goes behind a wash
of the ground colour, and the opacity of that wash is computed per palette in
`scrimFor`.

That is not a style choice. Every ratio in the table above is measured against
`ground`; put a photograph behind the text and none of those numbers mean
anything, because the thing the text sits on is now the photo. A page that
measured 7:1 in the dashboard can be unreadable outdoors over a bright sky.

So the scrim's opacity is chosen so the **composited** result still clears every
ratio against a pure white image and a pure black one — the two extremes any
photo lies between. The image ends up reading as texture rather than as a
picture, which is the only way it can be there without the rest of the design
becoming a lie. A palette too marginal to survive any photo gets an opaque scrim,
which hides the image rather than serving unreadable text.

Not on the printed card: a full-bleed photograph on A5 is the cartridge problem
the card's own notes already explain.

### How it reaches the three surfaces

The guest page loads `/theme.css` after `styles.css`, redefining the same custom
properties. A stylesheet rather than properties set from JavaScript once
`/api/config` lands: the guest would otherwise watch the shipped colours for the
length of a request. **A business with no theme is served an empty file**, so the
original design stands untouched rather than being reconstructed by arithmetic
that would land close but not exact.

Nothing in `styles.css` may hardcode a colour a theme would need to change —
there is a note at the top of the file saying so, because a rule with a literal
hex in it is the one that stays jade on a themed page.

The printed card is measured against **white**, separately, and keeps its white
stock and its pure black QR. A full-bleed coloured A5 costs a cartridge and
leaves a margin on any printer that cannot go borderless, and tinting a QR is the
most common way to make one a phone will not read in a dim room. The theme
reaches the card's ink, its frame and its rule.

Typefaces arrive through `/fonts.css`, which takes one of three shapes because
the two slots are independent:

| Grabbed | What is served |
| --- | --- |
| neither | a 302 to Google Fonts — the cheapest case, and what every unthemed venue gets |
| both | a small stylesheet of `@font-face` rules pointing at `/font/display` and `/font/ui` |
| one | both: the `@import` first, then the `@font-face` |

A redirect rather than a stylesheet in the first case because one static `<link>`
has to resolve differently per venue, and a 302 with no body beats a CSS file
that would serialise another download in front of the font files. The preconnects
in `index.html` keep the connection to Google warm across it.

The font files themselves are served from `/font/:slot` rather than inlined into
that stylesheet as data URIs — a woff2 is a couple of hundred kilobytes, and
inlined it would be re-downloaded on every change to a colour.

The logo is served from `/logo` as bytes with a cache header, rather than riding
along in `/api/config` — as base64 in a JSON body it would be re-sent on every
generation and cached by nothing.

The four colours and two font ids are what is stored; everything else is derived
per request. So an improvement to the derivation reaches every business without a
migration.

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
from reading them, which is what the dashboard's star ratings are for — and what the
realism sample feeds back into the next one.

## Backups

A nightly `pg_dump` to S3, run by a systemd timer. Everything below is in the
repo — [scripts/backup-to-s3.sh](scripts/backup-to-s3.sh),
[deploy/reviewslip-backup.service](deploy/reviewslip-backup.service) and
[deploy/reviewslip-backup.timer](deploy/reviewslip-backup.timer) — but the AWS
side has to be built once by hand.

**Know what is in this file before you decide where it goes.** The dump contains
every venue's OpenRouter key in plain text and every customer's email and
password hash. It is the most sensitive object the business owns. A public
bucket here is worse than having no backups at all.

### 0. What you need first

Run everything in steps 1–3 from somewhere with **admin** AWS credentials — your
laptop or CloudShell. Not the box: the instance role is deliberately allowed to
write backups and nothing else, so it cannot create the bucket it writes to.

Collect these first; every command below uses them.

```bash
aws sts get-caller-identity --query Account --output text
```

```bash
aws ec2 describe-instances --filters Name=ip-address,Values=YOUR.EC2.IP --query 'Reservations[].Instances[].[InstanceId,Placement.AvailabilityZone,IamInstanceProfile.Arn]' --output text
```

That last one answers three questions at once: the instance id, the region (the
availability zone minus its trailing letter), and **whether a role is already
attached**. If the third column is not `None`, do not create a new role in step
3 — an instance can only have one. Add the policy to the role it already has.

### 1. The bucket

In the **same region as the instance** — cross-region transfer is billed and
slower, and there is no benefit here.

Bucket names are globally unique across all of AWS, so `reviewslip-backups` is
almost certainly taken. Suffix it with your account id, which is not a secret:

```bash
BUCKET=reviewslip-backups-123456789012 REGION=ap-northeast-1
```

```bash
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
```

If your region is `us-east-1`, drop the `--create-bucket-configuration` flag
entirely — that one region rejects it, which is a long-standing wart rather than
anything you have done wrong.

Then, in order:

```bash
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

```bash
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
```

Versioning is what makes a bad overwrite or an accidental delete recoverable.
Without it, a script bug at 3am can destroy the history in one run.

Add a bucket policy refusing anything that is not TLS, so a misconfigured client
cannot send this file in the clear:

```bash
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyInsecureTransport\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
```

### 2. A KMS key, and what it buys

Optional, and worth understanding rather than copying. With a customer-managed
key you can let the instance role **write** backups without letting it **read
them back** — so someone who gets onto the box cannot download the history of
every key you have ever held.

The catch, and it is a real one: uploading with SSE-KMS needs
`kms:GenerateDataKey*`, and a **multipart** upload additionally needs
`kms:Decrypt`. The AWS CLI switches to multipart at 8MB by default. So the
write-only property holds while dumps are small and breaks silently the night
one crosses the threshold. Raise the threshold so that never happens:

```bash
sudo -u ubuntu aws configure set default.s3.multipart_threshold 5GB
```

Without a key, set nothing — objects still get SSE-S3, which protects the disks
under S3 and nothing else.

### 3. The instance role

**Never put access keys on the box.** Attach an IAM role to the instance and the
CLI picks up credentials from the metadata service on its own — nothing to
rotate, nothing to leak in a dump.

If step 0 showed the instance already has a profile attached, skip to the policy
and attach it to that role instead. An instance can only carry one.

Least privilege for what the script actually does — `PutObject` to upload, and
`GetObject` because it calls `head-object` afterwards to prove the object landed
and is the right length:

```bash
aws iam create-role --role-name reviewslip-backup --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

```bash
aws iam put-role-policy --role-name reviewslip-backup --policy-name write-backups --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/reviewslip/*\"}]}"
```

A role is not the same thing as an instance profile, and the CLI will not create
the profile for you the way the console does. This is the step that is easy to
miss, and the symptom is `associate-iam-instance-profile` failing with a message
about the profile not existing:

```bash
aws iam create-instance-profile --instance-profile-name reviewslip-backup && aws iam add-role-to-instance-profile --instance-profile-name reviewslip-backup --role-name reviewslip-backup
```

Attach it. IAM is eventually consistent, so if this fails the first time, wait
ten seconds and run it again rather than assuming something is wrong:

```bash
aws ec2 associate-iam-instance-profile --instance-id i-xxxxxxxx --iam-instance-profile Name=reviewslip-backup
```

Then prove it from the box itself, before touching anything else:

```bash
aws sts get-caller-identity
```

That should name `reviewslip-backup`. If it names something else, or asks for
credentials, the association has not landed yet.

If you are using KMS and `head-object` starts returning AccessDenied, that call
is asking KMS to decrypt. Either grant `kms:Decrypt` — giving up the write-only
property — or replace the verification with `list-objects-v2`, which reports
`Size` and never touches KMS.

### 4. On the box

```bash
sudo apt install -y postgresql-client awscli
```

Set `BACKUP_S3_URI` in `/opt/reviewslip/.env` — and `BACKUP_KMS_KEY_ID` if you
made a key. Then install the timer:

```bash
sudo cp /opt/reviewslip/deploy/reviewslip-backup.* /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now reviewslip-backup.timer
```

Run it once by hand before trusting it:

```bash
sudo systemctl start reviewslip-backup.service && sudo journalctl -u reviewslip-backup.service -n 20 --no-pager
```

```bash
systemctl list-timers reviewslip-backup.timer
```

### 5. Retention

In a lifecycle rule, not in the script. A declarative rule is reversible and
visible; a shell script that deletes things unattended at 3am is neither.

```bash
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"expire","Status":"Enabled","Filter":{"Prefix":"reviewslip/"},"Transitions":[{"Days":30,"StorageClass":"GLACIER_IR"}],"Expiration":{"Days":365},"NoncurrentVersionExpiration":{"NoncurrentDays":30},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
```

### 6. Prove you can restore it

This is the only step that turns the rest into a backup. Do it now, not on the
day you need it:

```bash
aws s3 ls "s3://$BUCKET/reviewslip/" && aws s3 cp "s3://$BUCKET/reviewslip/reviewslip-2026-08-19T032000Z.dump" /var/tmp/test.dump
```

```bash
createdb restore_test && pg_restore --no-owner --no-privileges --dbname=restore_test /var/tmp/test.dump && psql restore_test -c 'SELECT count(*) FROM subscribers;'
```

```bash
dropdb restore_test && rm /var/tmp/test.dump
```

The script already refuses to upload anything `pg_restore --list` cannot read,
so a truncated or corrupt dump never reaches the bucket. That catches the file
being broken; only the above catches the *contents* being wrong.

### 7. Know when it stops

Backups fail silently by nature, and a backup you wrongly believe in is worse
than none. Set `BACKUP_HEARTBEAT_URL` to a dead-man's-switch — healthchecks.io,
BetterStack, Cronitor — and the script pings it only after an upload is
verified. A failed or skipped run then alerts by *not* arriving.

## Where things live

| File | What it holds |
| --- | --- |
| `context.md` | The generic context document — the prose every review is written from. |
| `context.js` | Loads it, checks its sections are all there, and refuses to start if not. |
| `theme.js` | Four colours to a palette, with every text pair held to a contrast ratio, plus the typeface allowlist. |
| `assets.js` | Downloading a logo or a font from an address a third party controls, safely. |
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
  prompt went from roughly 315 tokens to about 1,720 once the Terms and Privacy
  clauses were folded in, and one carrying a business's own context, topics and
  the full realism and avoid samples goes past 2,400. At the 1,500 reviews a
  month `plans.js` allows per business, that is 3M–3.7M tokens against a stated
  allowance of 1M. Neither limit is enforced on the review path
  today — only the per-address hourly cap is — so nothing breaks, but the
  dashboard's token meter will read over 100% for a busy venue and the OpenRouter
  bill is roughly three times what it was. Raising
  `TOKENS_PER_MONTH_PER_VENUE` is one lever; trimming `context.md` is the other.
- Clipboard access needs a secure context. On `localhost` that's fine; when you
  put this on a phone-facing URL, serve it over HTTPS or Copy falls back to a
  less reliable path.
