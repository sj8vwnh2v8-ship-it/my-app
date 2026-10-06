# Today — a simple to-do app

A to-do list for today that you install on your iPhone home screen.
Everything is saved on your phone; there are no accounts.

**Open it:** https://sj8vwnh2v8-ship-it.github.io/my-app/

## What's in it (stage 1)
- Add, check off, edit and delete to-dos (tap to edit, swipe left to delete)
- Priority colors: red = high, yellow = medium, blue = low
- Repeating to-dos (daily, or weekly on days you pick)
- Unfinished items offer to carry over to the next day
- 🔥 streak of days you finished everything
- Backup and restore (Settings, the ••• button)

## Stage 2: the smart parts
- First-time questions about your hobbies and goals (edit them in Settings)
- Daily suggestions after 7 days of use, from your habits and your goals; tap ✓ to add or ✕ to dismiss
- Guessed priority colors (lighter stripe, "Guessed: High") learned from how you've colored and handled to-dos

## Stage 3: reminders (built, currently switched off)
Reminders are hidden in the app while `REMINDER_API` in `app.js` is empty.
To turn them on: add a working Cloudflare key as the `CLOUDFLARE_API_TOKEN`
GitHub secret, re-run the "Deploy reminder service" action, and put the
service's address in `REMINDER_API`.

- Set a "Remind me at" time on any to-do (repeating ones too)
- Turn reminders on in Settings (needs the app opened from the home-screen icon, iOS 16.4+)
- The reminder service lives in `worker/` and runs on Cloudflare's free plan.
  It only receives each reminder's text and time. GitHub Actions installs it
  (`.github/workflows/deploy-reminders.yml`) using the `CLOUDFLARE_API_TOKEN` secret.

## Files
- `index.html` — the page layout
- `styles.css` — colors and look
- `app.js` — how everything works
- `suggest.js` — suggestions and guessed colors
- `sw.js` — lets the app open without internet
- `manifest.webmanifest` + `icons/` — makes it installable on the home screen
- `worker/` — the reminder service (Cloudflare)
