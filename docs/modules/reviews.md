# Module: Reviews

App: Reviewslip
Table prefix: none — this app predates the prefix rule and owns its whole database ([../architecture.md](../architecture.md))
App charter (this app, decided once): Guest relations manager: a guest's review is published on a platform and the fetch imports it → the venue's reply is published (Replied) — see [../app-charter.md](../app-charter.md)
Integration option (this app, decided once): **Option 1 – standalone**
Form factor (this app, decided once): **Desktop only**
Home dashboard (this app, decided once): default set — see [../app-charter.md](../app-charter.md)
Primary record name: Review
Filled by: Claude (draft for review)
Date: 2026-09-30

**Built on the existing stack, not a rebuild** ([../architecture.md](../architecture.md)).
Concretely, for this module: the table is the existing `external_reviews`; the API is
`customer.js` under `/api/customer/businesses/:slug/listing-reviews`; the screen is
`components/dashboard/ListingReviews.tsx`; **no DevExtreme**. Changes below are additive
migrations and edits to those files, never a new table or a parallel implementation.

## 1. Purpose

- **Who uses it:** the guest relations manager — the one role in the charter.
- **The job, in one sentence:** answer every guest review, oldest unanswered first.
- **Charter stages covered:** all of them. This is the charter's only operational module —
  New → Drafted → Replied / Skipped is this module's status flow.
- **When it is the wrong module:** anything a review *reveals* rather than *says*. A review
  reporting a dirty room is fixed in vcs-housekeeping, not here; this record still ends at
  Replied. Adding a room, a rate or a booking belongs to vcs-bookings. Connecting a platform
  account belongs to Listings.

## 2. The record

One List row = one Review.

- Header table: **`external_reviews`** (the existing table — not renamed)
- Line tables: **none.** A review has no lines. No child tables, so no cascade rule to record.

`external_reviews` already stores names, not IDs — `platform` is the platform's name and
`author` is the guest's name — so this module needs **one new migration adding two columns**,
and nothing else structural.

| Field | Type | Required? | On List? | On Edit? | Lookup = distinct from this table? | May type a new value? |
|---|---|---|---|---|---|---|
| `platform` | text | yes | yes | read-only | yes (`external_reviews.platform`) | no — the fetch sets it |
| `author` | text | no | yes | read-only | no | no |
| `rating` | number | no | yes | read-only | no | no |
| `body` | text | yes | yes (truncated) | read-only | no | no |
| `posted_at` | date | yes | yes | read-only | no | no |
| `approximate` | yes-no | yes | no | shown as a hint on `posted_at` | no | no |
| `status` | status | yes | yes | yes | no — fixed list below | no |
| `reply_draft` | text | no | no | **yes, editable** | no | n/a |
| `reply_body` | text | no | no | read-only once set | no | no |
| `replied_at` | date | no | yes | read-only | no | no |
| `url` | text | no | no | shown as a link | no | no |
| `external_id` | text | yes | no | no | no | no |
| `fetched_at` | date | yes | no | shown in the footer | no | no |

**The whole schema change is migration 33**, adding `status` and `reply_draft` to
`external_reviews` and backfilling `status` from `replied_at`. Append-only, under the existing
advisory lock; migrations 1–32 are untouched.

`status` is a real stored column, not derived from `replied_at`, because [02-app-model.md]'s
status groups and the List View's Status filter both need a value they can filter on — and
because **Skipped** is a decision a person made that `replied_at IS NULL` cannot express.
Today "unanswered" and "not yet dealt with" are the same bit, and they are different facts.

Rating is nullable and that is deliberate: not every platform has stars, and a missing rating
is not a zero.

Status values:

| Status | Meaning | Who sets it | Group |
|---|---|---|---|
| **New** | Imported by the fetch, nobody has looked | The fetch | Pending |
| **Drafted** | A reply is written but not published | The manager, or the AI task's Apply | Active |
| **Replied** | The reply is live on the platform | The fetch seeing a reply appear, **or** the manager's Mark As Replied | Complete |
| **Skipped** | Deliberately not answering this one | The manager | Cancelled |

The app never publishes a reply (the charter's decision 2), so **nothing this module does sets
Replied directly.** Two paths close a record:

1. **The fetch sees a reply.** An owner who answers in the platform's own console has changed
   something we hold, and a fetch that left the row as New would keep it on the unanswered list
   for ever. The fetch may move New → Drafted → Replied. It must never move **Skipped** back.
2. **Mark As Replied**, by the manager. Required, not a convenience: on a platform whose
   replies we cannot read, path 1 never fires, and without this the record could never close.

## 3. List View

- **Default sort:** `posted_at` ascending — **oldest first**, which is the opposite of every
  other list in the product. The oldest unanswered review is the most damaging one, and a
  newest-first default hides it below the fold on day two.
- **Default filter:** Status group in Pending + Active (the unanswered work). Not "all" — the
  charter's measure of done is the default view.
- **Columns, in order:** Platform, Posted, Author, Rating, Review (truncated), Status,
  Replied, Waiting (days between `posted_at` and `replied_at`, or today if unanswered).
- **Filters the user can apply:** Search, Date (on `posted_at`), Status group, Platform,
  Rating.
- **Opening a record:** click the row. Not double-click — there is no DevExtreme grid here and
  no selection model that a single click would otherwise mean
  ([../architecture.md](../architecture.md) deviation 1). Row actions sit on the row itself, as
  they already do today: Open On Platform, Mark Answered, Skip.
  **A row may not be deleted** — the fetch would import it again on the next run, so deleting
  is a lie that undoes itself. Skipped is the way out.
- **New:** **not offered.** A review arrives from a guest; nobody creates one. This module has
  no New button, and that is the honest design, not an omission.
- **Empty list:** "No reviews yet. Add your listings in Listings and we will read them within
  the hour."
- **Default group:** none.
- **Footer summaries:** count, average Rating, average Waiting — computed in SQL, not over a
  loaded page, so they describe the whole filtered set rather than what happens to be on
  screen.
- **Expected rows per tenant after a few years:** **hundreds.** Correcting an earlier estimate
  in this brief: a twelve-room lodge collects roughly 5–20 reviews a month across its
  platforms, so three years is a few hundred rows, not thousands. [04-api.md]'s 1,000-row
  threshold is **not** crossed by the venues we sell to today.
  - **So: no remote-operations grid.** The endpoint returns a bounded page — newest 100 by the
    current filter, with a Load More — and filtering and sorting happen in SQL because that is
    where the correct answer is, not because the list is large.
  - **Revisit when** a single venue passes ~1,000 rows, which a busy city restaurant on four
    platforms could reach in about two years. The check is one query, and the migration at
    that point is to real paging, not to a different screen.

Filter bar:

- **Search fields:** Author, Review body, Platform.
- **Date filter field:** `posted_at`.
- **Status filter:** applicable — all four groups are in use.

Additional Views: `n/a`.

## 4. Edit View

- **Shape:** transaction-shaped (a status, dates, and prose), so it uses the Status band plus
  a Header band, not a flat field list.
  - **Status band:** Status, Posted, Replied.
  - **Header band:** Platform + Rating + Author (who wrote it, and where), then the review
    body full-width beneath — the body is the record, so it is never in a column.
  - **Below:** the Reply editor.
- **Read-only:** everything the platform owns — `platform`, `author`, `rating`, `body`,
  `posted_at`, `url`, `external_id`. Only `status` and `reply_draft` are editable, and both
  become read-only once status is **Replied**: the reply is published and we cannot edit it
  from here.
- **Lines:** none.
- **Actions:**
  - **Save** — writes `reply_draft`, and sets status to **Drafted** if it was New and the
    draft is non-empty.
  - **Copy Reply** — puts `reply_draft` on the clipboard as **plain text**, and saves it. Plain
    text because it is about to be pasted into someone else's textarea, where a smart quote or
    a markdown asterisk would be published literally.
  - **Open On Platform** — opens `url` in a new tab, where the manager pastes and publishes.
    Disabled when `url` is null.
  - **Mark As Replied** — copies `reply_draft` into `reply_body`, sets `replied_at` to now and
    status **Replied**. This is how the manager closes a record the fetch cannot close for
    them. It records what we believe was published, which may differ from what they actually
    pasted; the next fetch overwrites `reply_body` with the real text where it can read it.
  - **Skip** — sets status **Skipped**, requires nothing else.
  - **Draft With AI** — the AI task in §6. Fills the editor; never publishes.

  There is **no Send**. The app does not call any platform's write API, in any version — the
  charter's decision 2.
- **Record summary** (second title line): Platform, Author, Posted. The table has
  `created_at` and `fetched_at` but **no updated user** — one role edits these, and inventing
  an audit column for a single-user app would be building for a problem nobody has.
- **Validation:** cannot Mark As Replied with an empty reply — a closed record with no reply
  text is indistinguishable from a mistake. Cannot Save or Mark As Replied when status is
  already **Replied**. Cannot Skip a review that is already **Replied**.
- **After Save:** stay on Edit. **After Mark As Replied:** return to List — the work on that
  record is finished, and the next oldest unanswered review is the point of the list.
  **After Copy Reply:** stay on Edit, because the next thing the manager does is Open On
  Platform.

Linked panels: `n/a`.

## 5. Lookups

| Field | Distinct from which column? | May type new? | Notes |
|---|---|---|---|
| `platform` | `external_reviews.platform` | no | Used for the List's Platform filter only. The fetch is the sole writer, so a typed value would describe a platform we cannot read. |

App-owned master: **none.** Nothing here needs a catalogue module.

## 6. AI tasks

| | Answer |
|---|---|
| **Task** | Draft Reply |
| **Tier** | `included`, with `byok` available — the venue's own OpenRouter key, as today |
| **Chat or command** | **Fixed one-turn command.** Not a chat: there is one job, and a chat invites the general assistant [ai.md] forbids |
| **Scope** | Write one reply to one guest review for this venue, in the venue's chosen language and tone |
| **Out-of-scope examples** | "Write my room descriptions", "reply to all of these", "what should I charge", anything not this one review |
| **Tools it may call** | None. Every input is sent in the prompt |
| **Context sent** | The venue description and reply-tone settings; this review's `platform`, `rating`, `author`, `body` |
| **Proposal** | `reply_draft` only |
| **Where Apply lands** | The Edit View's Reply editor, as an unsaved draft. **Apply never sends and never saves** — a machine-written reply is published only after a person has read it |
| **Limits** | One review per call. Counts against the tenant's included budget; measured at roughly 4,210 tokens per generation |

## 7. Help and guidance

| | Answer |
|---|---|
| **Help ids** | `reviews.list`, `reviews.edit`, plus `reviews.edit.reply`, `reviews.edit.copyReply`, `reviews.edit.markAsReplied`, `reviews.edit.skip`, `reviews.edit.draftWithAi` |
| **Docs pages** | Reference: "Reviews List", "Reviews Edit". How-to: "Reply to a review", "Draft a reply with AI", "Skip a review you will not answer", "Find reviews you have not answered". The reply how-to must be explicit that publishing happens on the platform, not here — it is the one thing a new user will get wrong |
| **Teaching tip** | Reviews List: *"Every review your guests left, oldest unanswered first. The one at the top has been waiting longest, which is the one costing you bookings. Open it, write a reply, then copy it across to the platform."* |
| **Tour** | 4 steps — `data-tour="waiting"` ("how long this guest has waited"), `data-tour="reply"` ("your reply goes here"), `data-tour="draft-ai"` ("or let us write a first draft you can edit"), `data-tour="copy-reply"` ("copy it, then publish it on the platform — we cannot post for you") |
| **Empty states** | **List:** "No reviews yet. Add your listings in Listings and we will read them within the hour." → button: Go To Listings. **Filtered to nothing:** "Nothing unanswered. Every review has a reply." → button: Show All Reviews |
| **Tooltips and hint text** | *Waiting* — "Specifies how many days this guest has been waiting for a reply." *Skip* — "Close this review without replying." *Approximate date* — hint under Posted: "The platform said 'about 3 weeks ago', so this date is our best estimate." *Draft With AI* — "Writes a first draft from your venue description. Read it before you publish it." *Copy Reply* — "Copies your reply so you can paste it on the platform." *Mark As Replied* — "Records that you have published this reply. Use it if we have not noticed your reply yet." Hint under the Reply editor: "We do not publish replies for you. Copy yours, then post it on the platform." |
| **Setup checklist item** | **Read Your First Review** — gain: "See what your guests are saying, and answer the one that has waited longest." 1 min. Not required to be *completed*, but it is the charter's start event and the checklist's last item |

## 8. First version vs later

**Must work in v1:**
- The List, oldest unanswered first, with the Status, Platform and Rating filters
- Edit View with the reply editor, Save, Copy Reply, Open On Platform, Mark As Replied, Skip
- Draft With AI
- Waiting days on both List and Edit
- The fetch closing a record it sees answered elsewhere

**Never, not "later":**
- **Publishing a reply from inside the app.** The charter's decision 2. No platform write API
  is called in any version, so there is no Send button to add later and nothing in the design
  should leave room for one

**Explicitly out of v1:**
- Reply templates and saved phrases
- Sentiment or topic tagging
- Any bulk action. Replying to several reviews with one text is the behaviour guests punish
- Pushing a maintenance issue found in a review into another app as a record

## 9. Notes

- **The date on a review is often a guess.** Platforms print "3 weeks ago", so a stored date
  that follows the page slides backwards on every fetch until the review ages out of the
  window and vanishes on its own. `approximate` marks these, and the import keeps the
  *earliest* guess rather than the newest. Do not "fix" this by re-reading the date each time.
- **The fetch is an upsert, not an insert.** `ON CONFLICT DO UPDATE`, because an owner who
  replied in Google's console has changed a row we hold.
- **The reply is public and permanent, and a person publishes it by hand.** There is no path
  from this app to a platform's write API, so there is nothing to automate and nothing to
  schedule. `reply_body` records what we believe was published, not proof of it.
- **The existing partial index is what makes the unanswered list cheap.**
  `external_reviews_unanswered ... WHERE replied_at IS NULL` is already there. Migration 33
  must add the equivalent on `status`, because `status` is what the List filters on after this
  change — and must not drop the old one, since the fetch still reads `replied_at`.
- **"Mark answered" already exists** in `ListingReviews.tsx` and
  `POST /listing-reviews/:id/replied`. This brief renames it Mark As Replied and gives it a
  stored status to write; it does not introduce it.
- **Tenant scoping is enforced in code, not by the database** ([../architecture.md](../architecture.md)
  deviation 2). Every query this module adds goes through `requireOwnVenue` and filters on
  `subscriber_id`. This is the review point that matters most in a change to this file.

## 10. Milestones

| Milestone | Reviewer | Date | Decision | Notes |
|---|---|---|---|---|
| 1. Functional spec (this brief) | | | | Ready for review — both charter decisions answered 2026-09-30 |
| 2. Marketing website | | | | Pitch site: <https://reviewslip.vibecraftedsoftware.com> |
| 3. Data structure & mockup | | | | Mockup: *not yet built* |
| 4. Standalone | | | | |
| 5. Integration: platform fetch (Google, TripAdvisor, Facebook, Wongnai) | | | | The charter's start event arrives here |
| 6. Integration: AI reply drafting (OpenRouter) | | | | Per [ai.md] |
| 7. Public API | | | `n/a` | Reviewslip publishes none |
