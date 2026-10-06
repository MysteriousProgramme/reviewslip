# Reviewslip — the structure we have, and are keeping

Decided 2026-09-30: Reviewslip keeps its current architecture. It is **not** rebuilt onto
the app-standards stack, and it does **not** use DevExtreme. The standards still apply
where they are about *what the app is* rather than *what it is written with* — see
[Deviations](#deviations-from-the-standards) below for the line between the two.

## Two repos

| | Repo | Stack |
|---|---|---|
| **Review app** | `C:\Projects\reviewslip` (`customer-backend`) | Node + Express 4, Postgres via `pg`, CommonJS. Owns the database. |
| **Website** | `C:\Projects\reviewslip-website` (`main`) | Next 16, React 19, TypeScript, App Router. Owns no data. |

The website is a **client of the review app's API** over loopback. Nothing in the website
talks to Postgres, on purpose: two codebases writing one schema is how schemas rot.

## Review app

About 60 single-purpose modules, flat at the repo root. The shape is not accidental and is
worth keeping deliberately:

**Entry and routing**
- `server.js` (1,388) — Express wiring, tenant resolution from the hostname, the guest page,
  the housekeeping board, the error handler.
- `customer.js` (2,614) — the signed-in customer API, `/api/customer/*`.
- `admin.js` (118) — the platform API, `/api/admin/*`, guarded by `ADMIN_TOKEN`.
- `auth.js` (129) — two bearer tokens, two jobs.

**The database**
- `db.js` (1,173) — **34 append-only numbered migrations**, applied under
  `pg_advisory_lock(8274123)` and tracked in `schema_version`. An applied migration is never
  edited. 18 tables.

**Data-access modules** — these are the only files that touch Postgres:

    accounts  bookings  checklists  events  guests  listings  rates
    referrals  rooms  staff  subscribers  tickets

**Pure rule modules** — no database, no network, no Express. This is the most valuable
property the codebase has, and new work should keep extending it rather than eroding it:

    assets  bookingfilter  checklist  housekeeping  inbound  listingreader
    nights  note  roomstatus  secrets  setup  shift  sitecolours  tariff
    theme  themenote  tm30

They can be tested with no database at all, which is why `test/prompt.test.js` can hold
**250 tests** and still run in seconds. `db.js` throws without `DATABASE_URL`, so anything
that imports it cannot be tested this cheaply.

**Static front-ends** — `public/`: the guest review page (`index.html` + `app.js` +
`styles.css`) and the housekeeping board (`housekeeping.*`). Vanilla JS, no build step.

## Website

- **App Router** with a `[lang]` segment. English is served at the root; `/en/…` redirects
  to the unprefixed form, so there is exactly one canonical URL per page per language.
- `proxy.ts` — locale negotiation, and the **staff host**: anything on `admin.*` is rewritten
  under `/admin`, and `/admin` answers nowhere else. A separate host means a separate,
  host-only cookie, so a customer session is never sent to a venue subdomain.
- `lib/customer.ts` — `server-only`. The session token lives in an httpOnly cookie and is
  forwarded as a bearer, so the review app verifies the caller rather than trusting this site.
- **45 components**, split `components/marketing/` and `components/dashboard/`.
- No component library, no state-management library, no CSS framework. The authenticated
  app has its own shell and stylesheet — see [The authenticated app's UI](#the-authenticated-apps-ui).

## What the standards still govern

These are about what the app *is*, cost little, and stay in force:

| From | Applies |
|---|---|
| [02] App charter | Written: [app-charter.md](app-charter.md). One role, one start, one end. |
| [02] Status groups | Every module status maps onto Pending / Active / Complete / Cancelled. |
| [02] List View + Edit View | Every module is a list of records and one record open. |
| [02] Self-contained rows | Names and values on the row, not master IDs. Already true — `platform` and `author` are text. |
| [04] Error envelope | `{ error, code, details? }`. **Today we send `{ error }` only** — adding `code` is a small, real improvement. |
| [08] Module briefs | One per module before implementing. Reviews is written; Listings and Settings are not. |
| [09] Required tests per module | The checklist form of each brief. The stack changes which file they live in, not whether they exist. |
| [10] Milestones | Peer review before deploy. |
| [13] Code style | Comments say why; no history in comments; one implementation per job. Already the house style. |

## Deviations from the standards

Each one is a decision, with the reason. None is an oversight.

### 1. No DevExtreme ([05])

[05] makes DevExtreme Grid and Editors mandatory for every List and Edit View. Reviewslip
does not use it and will not.

**Why:** it is a paid licence per developer for a product whose dashboard is already built,
already works, and is read mostly by one person per venue on a laptop. The grids here are
short — a venue has twelve rooms and tens of reviews a month, not thousands of rows needing
virtual scrolling, column chooser and server-side grouping. The licence, the ThemeBuilder
build step and the trial watermark all buy capability this app has no use for.

**Consequences, accepted:**
- The [05] rules that exist *because* of DevExtreme do not apply here: the grid toolbar,
  column chooser, saved layout, row menu, remote-operations `CustomStore`.
- The DevExpress Documentation MCP server is **not** required on this repo's machines.
- The style rules that are not about DevExtreme still apply: **one accent colour**, system
  light/dark, compact density, Title Case on controls.

### 2. One database, `subscriber_id` on every table ([02] rule 1)

[02] rule 1 requires a database per tenant and forbids a shared table with a tenant-ID
column. Reviewslip's 18 tables are all keyed on `subscriber_id`.

**Why:** changing it is not a migration, it is a different architecture, and it would be
performed on a live venue whose passport numbers are encrypted under a `SECRET_KEY` that
cannot be rotated without losing them. The risk is real and the benefit is structural
tidiness.

**Consequence, accepted:** tenant isolation is enforced in code (`requireOwnVenue`) rather
than by the database boundary. Every new query must scope by `subscriber_id`, and that is now
the single most important review point in this codebase.

### 3. Express and raw SQL, not Fastify and Drizzle ([06])

Working, tested, and understood by the people maintaining it. Rewriting the transport layer
changes no behaviour a customer can see.

### 4. Flat CommonJS repo, not `apps/web` + `apps/api` + `packages/*` ([07])

The two halves are already separate repos with a clean API boundary between them, which is
what [07]'s layout is for. The pure/impure module split above does the job [07] assigns to
`packages/`.

### 5. Next with server rendering, not a static export ([05])

The dashboard reads an httpOnly session cookie server-side. A static export cannot, and the
marketing site's locale routing runs in `proxy.ts`.

### 6. The guest page is themed per venue

Recorded in the charter. It is not an employee screen, so [05]'s monochrome-plus-one-accent
rule does not reach it.

### 7. No Tailwind and no shadcn/ui ([05])

[05]'s stack builds the shell from shadcn/ui's Sidebar on Tailwind. The authenticated app is
built **to that specification** — the same zones, tokens, sizes and behaviour — in the
site's own CSS (`app/app.css`), with `next-themes` and `lucide-react` from the standard's
stack.

**Why:** the site is five thousand lines of hand-written CSS and the marketing pages share a
stylesheet with the app. Tailwind's reset would restyle a live public site to change a
dashboard. What the standard is protecting is the result — one shell, one token set, one
accent — and that is what was built.

## The public site's UI

The marketing pages, sign-in and sign-up follow [05]'s rule for marketing pages: the Vibe
Crafted Software grey ramp with **zero hue**, the system font with **no webfont**, roomy
spacing, sentence-case headings, and light and dark from the same theme system as the app.
The one colour is the functional red on a form field that is wrong.

- `app/globals.css` — the ramp (`--gray-950` … `--gray-50`), the shared tokens for light and
  `.dark`, and the same kind of bridge the app has: the old brand names re-pointed at the ramp.
  With no hue to spend, the call to action is the ink: `--marigold` and `--jade` both map to
  the foreground, and the text on them to the background.
- `components/Theme.tsx` — one `next-themes` provider in the root layout, for every page. A
  choice made with the toggle in the app's Sidebar holds on the public site and the other way
  round; the site's header has the same toggle (`components/ThemeToggle.tsx`).
- The decorative radial glows, the button glows and the serif display face are gone.

**One decision to know about:** the **demo slip** — the guest page shown on the home, demo,
how-it-works and contact pages — keeps the venue's colours and typefaces. It is a picture of
the product, the thing a venue is buying, not part of the site's chrome; drawn in grey it
would misrepresent what a guest sees. It is marked `.venue-look`, like the table card. If the
standard's "zero hue" is meant to reach product pictures too, this is the one line to change.

Trirong and Bai Jamjuree are still loaded, with `preload: false`, because the product pictures
use them. A browser only fetches a face something on the page uses.

## The authenticated app's UI

The customer dashboard and the staff host follow [05]'s style guide for the app. The guest
page does not, on purpose: it is the venue's own page.

**How it is put together** (all in `reviewslip-website`):

- `app/app.css` — everything is scoped to `.app`, the root the shell renders. The standard's
  tokens (`--background`, `--foreground`, `--border`, `--primary` …) for light and dark, then
  **the bridge**: the marketing site's variable names (`--shade`, `--paper`, `--ink`, `--jade`,
  `--marigold`, `--cream`) re-pointed at those tokens, so every existing component follows
  without being rewritten.
- `components/app-shell/` — `AppShell` (the Sidebar, the account menu, the theme toggle),
  `PageHeader` (Back, two title lines, the action toolbar), and `nav.ts`, the one nav config.
- `app/[lang]/dashboard/layout.tsx` and `app/[lang]/admin/layout.tsx` put their screens in it.

**Two mappings in the bridge are not the obvious ones, and both matter:**

- `--marigold` was the call-to-action colour on the marketing site, but in the dashboard
  nearly every use of it means "this needs attention". It maps to `--warning`. The primary
  button takes `--primary` by name.
- Translucent washes are mixed from `--wash` and `--alert`, not from the accent. A hover tinted
  blue would be the accent used as decoration.

**`.venue-look`** (in `globals.css`) marks the things that are pictures of the product rather
than the site — the table card, the registration card, the theme preview and the demo slip —
and puts the venue's palette and typefaces back for them.

**What conforms:** one neutral scale and one accent (Thai royal blue, `#1f4fa3` / `#7fa2e6`);
light and dark following the system, with a toggle; the system font at 14px; one 8px radius;
32px buttons and 36px editors; one primary button per screen; Title Case on controls; the
Sidebar with its rail; a 56px two-line page header with Back on every screen; status colours
that pass WCAG AA on the page, on a panel and on their own tint, in both themes.

**What does not yet, and is known:**

- **No Help button** and no docs — [05] puts one on every screen.
- **The Home dashboard's first card** should be the charter's open work, unanswered reviews.
  It shows this month's count instead.
- **No Recent entry** in the Sidebar, and no Prev / Next or record summary on Edit Views.
- **Lists are plain tables.** Without DevExtreme there is no column chooser, header filter or
  saved layout (deviation 1).
- **No `/docs`.** [05] and [01] require documentation alongside the website, built with
  Fumadocs; there is none yet.

## What this means for the work in flight

- The **Reviews module brief** ([modules/reviews.md](modules/reviews.md)) is written against
  this architecture: `external_reviews`, migration 35, no DevExtreme.
- The **Settings screen** ([settings-screen.md](settings-screen.md)) is specified, including
  Listings. Neither is a module; that document explains why.
- **The spec set is complete.** Reviewslip is one module, one dashboard, one settings screen.
- **vcs-housekeeping** is a separate app and this decision does not reach it. Whether it also
  drops DevExtreme is its own decision, and its charter and form factor differ.
