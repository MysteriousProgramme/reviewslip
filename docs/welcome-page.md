# The welcome page

A guest scans a QR code in the room or on the table, gives their name and email, and gets
the venue's links — Wi-Fi, menu, website, a phone number — and the steps to keep the page on
their phone like an app. The venue sets the links in the dashboard and downloads the guests who
agreed to be emailed as a mailing list.

Built 2026-10-06. Decisions by Zac on the same day.

## Where it lives

| | |
|---|---|
| Guest page | `https://<slug>.reviewslip.com/welcome` — `public/welcome.html` + `welcome.js`, in the venue's own colours via the same three stylesheets as the review page |
| Install | `/welcome.webmanifest`, per venue. An Install button where the browser offers one (Chrome and Edge on Android); written steps for iPhone and Android everywhere else |
| Dashboard | **Welcome Page** in the Sidebar — `/dashboard/<slug>/welcome`: the QR code, the links, the guests |
| Rules | `welcome.js` (pure, tested): links, sign-ups, the mailing list file, the guest's pass |
| Storage | `subscribers.welcome_links` (JSON) and `guest_signups` — migration 32 |

## Decisions

- **Name and email are required** before the links show. Chosen knowing it costs some guests.
- **Marketing is a separate, unticked box.** An email given to see the Wi-Fi is not permission
  to send newsletters; Thailand's PDPA asks for that to be its own clear yes. Consent only moves
  forward: a returning guest who does not tick it again has not withdrawn anything.
- **The mailing list holds only the guests who ticked it.** It is a CSV the venue imports into
  its own newsletter tool. Dates are the venue's calendar day.
- **Emails are kept in Reviewslip**, per venue, one row per address. No Mailchimp or Brevo
  integration.
- **Links are a free-form list:** label and address, in order, at most 20. Web addresses,
  `tel:` and `mailto:` only — never `javascript:` or `data:`, which on a page every guest opens
  would run script in their browser.

## How the gate works

The links are not in the page. `/api/welcome` tells the guest whose page it is; the links come
back only with a sign-up, or with the **pass** that sign-up returned. The pass is signed with
`SECRET_KEY` under its own derived key, names the venue and the sign-up, and lasts a year, so a
guest who saved the page to their phone is not asked again.

Deleting a guest in the dashboard ends their pass — the next time they open the page they see
the form. A guest is entitled to ask a venue to delete their details, and this is how a venue
does it.

The sign-up shares the guest page's throttle: 30 a minute per venue and address.

## Not done, and should be

- **The privacy policy** says nothing about guests' names and emails. Each venue is the
  controller of its guests' data and Reviewslip processes it for them; the policy, and probably
  the terms a venue agrees to, need a paragraph saying so. That is legal text, not code.
- **The table card** still carries only the review QR. A printed welcome card would reuse it.
- **Strings in ten languages besides English** were written without a native speaker — have
  someone read the Thai at least before a venue prints the code.

## Outside the charter

Collecting guests' details for marketing is not the guest relations manager's job
([app-charter.md](app-charter.md)): it is marketing, before the guest ever writes a review.
Built here by decision rather than drift, and recorded in the charter's Outside table.
