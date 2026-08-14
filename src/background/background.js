// src/background/background.js
// MV3 service worker. Jobs:
//   - show a LIVE badge on the toolbar icon while a battle is being watched,
//   - forward tab-capture stream ids from the popup to the battle page (the
//     popup is the only place chrome.tabCapture.getMediaStreamId may be
//     called — it requires a user gesture),
//   - own the OCR offscreen document: create it lazily on the first OCR
//     request, keep it alive, and relay requests/results between the content
//     script and the offscreen page.

const OFFSCREEN_URL = 'offscreen.html';
let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument().catch(() => false);
    if (!has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_SCRAPING'],
        justification: 'Runs the OCR engine that reads hover tooltips from captured frames.',
      });
    }
    return true;
  })();
  return offscreenReady;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.psa === 'psa-badge') {
    if (msg.state === 'battle') {
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      chrome.action.setBadgeText({ text: 'LIVE' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
    sendResponse({ ok: true });
  } else if (msg?.psa === 'psa-capture-start' && msg.tabId != null) {
    // Report back whether the message actually reached the tab, so the popup
    // can show a real error instead of silently doing nothing.
    chrome.tabs
      .sendMessage(msg.tabId, { psa: 'psa-capture-start', streamId: msg.streamId })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: 'No assistant running on this tab — open a Showdown battle first.' }));
    return true; // async sendResponse
  } else if (msg?.psa === 'psa-capture-stop' && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, { psa: 'psa-capture-stop' }).catch(() => {});
    sendResponse({ ok: true });
  } else if (msg?.psa === 'psa-capture-status') {
    // The content script reported whether the stream started — relay it to
    // the open popup so it can stop waiting for the ack.
    chrome.runtime.sendMessage({ psa: 'psa-capture-status', ok: msg.ok, error: msg.error }).catch(() => {});
    sendResponse({ ok: true });
  } else if (msg?.psa === 'psa-ocr-req') {
    // Relay the OCR request to the offscreen document, then return its text.
    (async () => {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({
          psa: 'psa-ocr-req',
          id: msg.id,
          width: msg.width,
          height: msg.height,
          pixels: msg.pixels,
        });
        sendResponse(res ?? { psa: 'psa-ocr-res', id: msg.id, error: 'no offscreen response' });
      } catch (err) {
        sendResponse({ psa: 'psa-ocr-res', id: msg.id, error: String(err?.message ?? err) });
      }
    })();
    return true; // async sendResponse
  }
});
