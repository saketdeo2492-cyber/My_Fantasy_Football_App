// Squad Wire Connector — background service worker.
//
// Flow when the user clicks the extension icon while on fantasy.premierleague.com:
//  1. Run a small script INSIDE that tab to read the oidc.user:* key from
//     that page's own localStorage (this only works because we're running
//     in the context of fantasy.premierleague.com itself, via
//     chrome.scripting — a normal website could never do this).
//  2. Open/focus the Squad Wire tab.
//  3. Run the actual "send the token to Squad Wire's server" step INSIDE
//     that Squad Wire tab (again via chrome.scripting), not here in the
//     background service worker — see connectSquadWireTab()'s comment for
//     exactly why this matters. TEST-ONLY: hits /api/set-access-token, no
//     PingOne refresh_token exchange involved (temporary swap-in for the
//     real /api/login refresh_token flow, just to check that authenticated
//     FPL API calls work at all).
//  4. Reload the Squad Wire tab so it picks up the new session on a clean
//     page load, then leave it focused for the user to see the result.
//
// NOTE: a service worker has no DOM, so it can't call alert() itself.
// On any failure we inject a one-line alert() into the FPL tab so the
// real error is visible without opening DevTools.

const SQUAD_WIRE_ORIGIN = 'https://squad-wire.vercel.app';

async function showAlert(tabId, message, raw) {
  console.error('[Squad Wire Connector]', message, raw ?? '');
  const details = raw !== undefined ? `${message}\n\nFull response:\n${JSON.stringify(raw, null, 2)}` : message;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => alert(`Squad Wire Connector:\n\n${msg}`),
      args: [details],
    });
  } catch (e) {
    // If we can't even inject the alert (e.g. tab navigated away), at
    // least the console.error above is there to find.
    console.error('[Squad Wire Connector] Could not show alert:', e);
  }
}

async function extractAccessToken(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        const key = Object.keys(localStorage).find((k) => k.startsWith('oidc.user:'));
        if (!key) return { ok: false, error: 'Not logged into FPL in this tab (no oidc.user:* key in localStorage).' };
        const parsed = JSON.parse(localStorage.getItem(key));
        if (!parsed || !parsed.access_token) {
          return {
            ok: false,
            error: `Found the oidc.user key but no access_token field. Keys present: ${parsed ? Object.keys(parsed).join(', ') : 'none'}`,
          };
        }
        return { ok: true, access_token: parsed.access_token, expires_at: parsed.expires_at };
      } catch (e) {
        return { ok: false, error: `Error reading localStorage: ${String(e)}` };
      }
    },
  });
  return result;
}

// Sends the access token to Squad Wire from INSIDE the Squad Wire tab's own
// JS context (chrome.scripting.executeScript targeting that tab), not from
// this background service worker.
//
// Why: a fetch() made here in the service worker is a cross-site request
// as far as squad-wire.vercel.app is concerned (its "site" is this
// extension, chrome-extension://<id>, a different site than
// squad-wire.vercel.app — host_permissions grants the network access to
// complete that request and read the response, which is why it used to
// come back {ok:true} and show a green checkmark, but that's a CORS
// concession, not a cookie one). The browser silently drops the
// Set-Cookie header from that cross-site response rather than storing the
// sw_fpl session cookie — confirmed by testing the exact same
// cross-site-with-credentials request against the real deployed backend:
// the endpoint responds fine, but /api/session still reports not logged
// in afterward. Running the fetch from inside the Squad Wire tab instead
// makes it a same-origin, first-party request — the same kind the
// existing "paste your token" flow already uses successfully — so the
// cookie is stored correctly. Confirmed against the real backend and a
// real account: after this same-origin fetch, a fresh load of the Squad
// Wire tab shows CONNECTED with live account data.
async function connectSquadWireTab(tabId, accessToken, expiresAt) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (accessToken, expiresAt) => {
      let res;
      try {
        res = await fetch('/api/set-access-token', {
          method: 'POST',
          credentials: 'include', // same-origin here, so the session cookie actually gets set
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt }),
        });
      } catch (e) {
        return { ok: false, error: `Network error calling /api/set-access-token: ${String(e)}` };
      }

      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch (e) {
        return { ok: false, error: `/api/set-access-token returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}` };
      }

      if (!res.ok || !body.ok) {
        return { ok: false, error: body.error || `/api/set-access-token returned HTTP ${res.status}`, raw: body };
      }
      return { ok: true };
    },
    args: [accessToken, expiresAt],
  });
  return result;
}

// Waits for a tab to finish loading (chrome.scripting.executeScript needs
// a document to already be there to inject into) before returning it.
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for the Squad Wire tab to finish loading.'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function openOrFocusSquadWireTab() {
  const tabs = await chrome.tabs.query({ url: `${SQUAD_WIRE_ORIGIN}/*` });
  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    if (tab.status !== 'complete') await waitForTabComplete(tab.id);
    return tab;
  }
  const created = await chrome.tabs.create({ url: SQUAD_WIRE_ORIGIN });
  await waitForTabComplete(created.id);
  return created;
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab.url || !tab.url.startsWith('https://fantasy.premierleague.com')) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#E90052' });
      await chrome.tabs.create({ url: 'https://fantasy.premierleague.com/' });
      return;
    }

    chrome.action.setBadgeText({ text: '…' });
    chrome.action.setBadgeBackgroundColor({ color: '#04F5FF' });

    const extracted = await extractAccessToken(tab.id);
    if (!extracted || !extracted.ok) {
      chrome.action.setBadgeText({ text: '✕' });
      chrome.action.setBadgeBackgroundColor({ color: '#E90052' });
      await showAlert(tab.id, (extracted && extracted.error) || 'Unknown error extracting access token.');
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
      return;
    }

    const squadWireTab = await openOrFocusSquadWireTab();
    const result = await connectSquadWireTab(squadWireTab.id, extracted.access_token, extracted.expires_at);

    if (result && result.ok) {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#00FF85' });
      // Reload so the tab re-checks /api/session and re-pulls the team on
      // a clean load, same as the known-good manual "paste token" flow —
      // an already-open tab has no reason to notice the cookie changed
      // otherwise.
      await chrome.tabs.reload(squadWireTab.id);
    } else {
      chrome.action.setBadgeText({ text: '✕' });
      chrome.action.setBadgeBackgroundColor({ color: '#E90052' });
      await showAlert(
        tab.id,
        (result && result.error) || 'Unknown error connecting Squad Wire.',
        result && result.raw
      );
    }
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch (e) {
    // Catch-all so an unexpected exception doesn't just leave the badge
    // spinning forever with nothing logged.
    chrome.action.setBadgeText({ text: '✕' });
    chrome.action.setBadgeBackgroundColor({ color: '#E90052' });
    await showAlert(tab.id, `Unexpected error: ${String(e)}`);
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  }
});
