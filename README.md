# Baanpong Lodge review helper

A single page a departing guest opens from a QR code. It writes a short 5-star
review, they tweak it if they want, copy it, and go straight to the Google
listing to post.

## Run it

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000, click the gear, and paste in an
[OpenRouter key](https://openrouter.ai/keys). That's the whole setup — the key
is checked against OpenRouter as you save it, so you know straight away whether
it works.

If you would rather not click through, copy `.env.example` to `.env` and fill it
in before starting. Both work; see below.

## Settings

The key, the model, and the Google review link resolve in this order:

```
settings.json  ->  .env  ->  built-in default
```

`settings.json` is what the Settings panel writes. Anything saved there wins,
and the panel shows where each value currently comes from, so a leftover `.env`
value is never a mystery. Clearing a field falls back to `.env`, then the
default. `PORT` is the exception — it is `.env` only, since changing it needs a
restart anyway.

The panel never receives the key back, only a masked hint like
`sk-or-v1••••4f2a`, so a guest who taps the gear cannot read it. It is stored in
plain text in `settings.json` (gitignored), so keep that file on the machine
that runs the app.

## Where things live

| File               | What it holds                                                   |
| ------------------ | --------------------------------------------------------------- |
| `config.js`        | The venue, the category buttons, the prompt. Edit this to move the app to another property — nothing else needs to change. |
| `settings.js`      | Resolves and saves the OpenRouter settings.                       |
| `server.js`        | Serves the page, calls OpenRouter, cleans up the completion.      |
| `public/`           | The page itself.                                                 |
| `settings.json`     | Saved settings. Created by the panel, gitignored.                |
| `.env`              | Optional seed values, plus `PORT`.                               |

## Notes

- The model slug is checked against OpenRouter's live catalogue — on boot, and
  again whenever you save it — so a typo warns instead of failing on first tap.
  The Model field offers the catalogue as a picker.
- The client sends its last three generations back with each request so
  Regenerate produces something genuinely different, not a reshuffle.
- The prompt forbids inventing details. Anything the writer is allowed to
  mention is in `VENUE.safeDetails` in `config.js`.
- Clipboard access needs a secure context. On `localhost` that's fine; when you
  put this on a phone-facing URL, serve it over HTTPS or Copy falls back to a
  less reliable path.
