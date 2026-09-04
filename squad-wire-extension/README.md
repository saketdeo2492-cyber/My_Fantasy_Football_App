# Squad Wire Connector (Chrome Extension)

One click, while on fantasy.premierleague.com, sends your FPL refresh token
directly to Squad Wire's server and opens the app — no copy/paste, no
DevTools, no bookmarklet.

## How it works

- `background.js` runs when you click the extension icon.
- It only activates on `fantasy.premierleague.com` tabs — reads the
  `oidc.user:*` key from that page's own `localStorage` (only possible
  because the extension has permission to run *inside* that page).
- Opens/focuses the Squad Wire tab, then — crucially — sends the token to
  Squad Wire's server via a script it runs **inside that Squad Wire tab**
  (`chrome.scripting.executeScript` targeting the Squad Wire tab, not a
  `fetch()` from the background service worker itself). Reloads the tab
  once that succeeds.

  This matters: `squad-wire.vercel.app`'s session cookie is set via
  `Set-Cookie`, and a request made from the background service worker is
  cross-site as far as that cookie's origin is concerned (the service
  worker's own site is this extension, not squad-wire.vercel.app) — the
  browser accepts and completes that request fine (host_permissions
  covers the CORS side of it), but silently drops the `Set-Cookie` from
  the response rather than storing it. Running the same fetch from inside
  the Squad Wire tab makes it a same-origin, first-party request instead —
  the same kind the site's own "paste your token" flow already uses
  successfully — so the cookie actually gets stored. An earlier version of
  this extension called `fetch()` straight from the background script; it
  got a `{ok:true}` response and showed a green checkmark, but the session
  cookie never persisted, so Squad Wire still showed "NOT CONNECTED"
  afterward. Confirmed against the real deployed backend with a real
  account: the cross-site version leaves `/api/session` reporting
  logged-out even on a 200 response, while the same-tab version correctly
  logs in.

Your FPL password is never touched by this extension at all — it only
ever sees the token that already exists because you're logged in normally.

## Test it locally first (before publishing anywhere)

1. Open Chrome → go to `chrome://extensions`
2. Toggle on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder (`squad-wire-extension`)
5. You'll see "Squad Wire Connector" appear in your extensions list and
   toolbar (you may need to click the puzzle-piece icon to pin it)
6. Go to fantasy.premierleague.com, make sure you're logged in
7. Click the Squad Wire Connector icon in your toolbar
8. It should briefly show a spinner-ish badge, then a green ✓, and open
   Squad Wire already connected

If it shows a red ✕, right-click the extension icon → **Inspect popup**
(or check `chrome://extensions` → the extension's "service worker" link)
to see the actual error logged.

## Publishing to the Chrome Web Store (so anyone can install with one click)

1. Go to https://chrome.google.com/webstore/devconsole
2. Sign in, pay the one-time $5 registration fee if you haven't already
3. Click **New Item**, upload a zipped version of this folder
   (`zip -r squad-wire-extension.zip squad-wire-extension`)
4. Fill in the store listing: name, short description (the one in
   manifest.json works), a couple of screenshots, and a privacy practices
   section — since this extension reads authentication data, you'll need
   to briefly explain what it does with it (sends it directly to your own
   server, never stored by the extension itself, never sold/shared)
5. Submit for review. Google's review for extensions handling login data
   can take a few days to a couple of weeks — budget accordingly
6. Once approved, you'll get a public install link
   (`chrome.google.com/webstore/detail/...`) — share that with your
   organization. Anyone clicks "Add to Chrome" and they're done.

## Icons

Placeholder icons are included (`icons/icon16.png`, `icon48.png`,
`icon128.png`) — simple purple/green squares matching Squad Wire's
branding. Replace these with a proper logo before publishing publicly if
you want something more polished.
