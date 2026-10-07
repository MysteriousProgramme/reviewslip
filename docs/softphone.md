# Calls through the Vibe Crafted softphone

Built 2026-10-08. "Call" buttons for guests and for venues go through the softphone widget
(`https://portal.vibecraftedsoftware.com/assets/voice-widget.js`): an in-browser call to a site's
Sales or Support team, or a voicemail when nobody is free. The phone number stays beside each
button as the fallback; the widget shows its button only when the browser can place a call and the
site answers its status check, and CSS hides the phone link once it does.

## Where

| Page | Site key | Team | Shown as |
|---|---|---|---|
| Marketplace venue page, "Book directly" box | the venue's | Sales | Call Reservations |
| Marketplace booking page (Manage Booking) | the venue's | Sales | Call Reservations, with guest name and reference passed to the person answering |
| Guest App call tiles (`/welcome`) | the venue's | Support | Call Front Desk, with the guest's name passed |
| Website Contact page | Reviewslip's | Sales | Call Sales |
| Dashboard Support page | Reviewslip's | Support | Call Support, with the account email passed |

LINE, WhatsApp and Email stay as they were — only phone buttons changed.

## Settings

- **A venue's key:** dashboard → Bookings → Online Booking → Contact → *Softphone Site Key*
  (`market_profile.contact.voiceSite`). Empty = phone link only, as before.
- **Reviewslip's key:** `VOICE_SITE` in the website's build environment; defaults to `reviewslip`.

## Before it shows anything

The portal decides which pages may use a site. Checked 2026-10-08:

- Site `baanponglodge` exists (Sales, 09:00 opening) but only allows calls from
  `https://baanponglodge.com`. Add `https://reviewslip.com` (marketplace pages) and
  `https://baanponglodge.reviewslip.com` (Guest App) to its allowed origins in the portal, or the
  button never appears there and guests see the phone link.
- Site `reviewslip` does not exist ("Unknown site"). Create it in the portal with Sales and Support
  lists and allow `https://reviewslip.com`, or set `VOICE_SITE` to the key you have.

## How it works

- `components/VoiceCall.tsx` (website) and `startVoice()` in `public/welcome.js` (Guest App) inject
  the script once, with the site key, `data-voice-fab="off"` (pages carry their own buttons).
- The widget reads its site once per page load. The website navigates without reloading, so a page
  needing a different site than the one loaded reloads itself once.
- The widget's own button words come from `window.VOICE_I18N`; the venue pages and the Guest App set
  "Call {team}", the team names and "Leave a message" in the guest's language. The call panel's
  other text is the widget's (English, or its Thai build).
