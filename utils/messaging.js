/**
 * Messaging helpers with timeouts and lastError handling.
 * chrome.runtime.lastError must be read inside every callback, otherwise Chrome
 * logs "Unchecked runtime.lastError" warnings.
 */

import { MSG } from './constants.js';
import { withTimeout } from './helpers.js';
import { isInjectableUrl } from '../scripts/url-validator.js';

/** Send a message to the background service worker (or any runtime listener). */
export function sendRuntimeMessage(message, options = {}) {
  const { timeout = 10000 } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The extension did not respond in time.'));
    }, timeout);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || 'Could not reach the extension.'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

/** Send a message to a content script in a specific tab/frame. */
export function sendTabMessage(tabId, message, options = {}) {
  const { timeout = 4000, frameId } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The page did not respond in time.'));
    }, timeout);

    const callback = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || 'No content script on this page.'));
        return;
      }
      resolve(response);
    };

    try {
      if (typeof frameId === 'number') {
        chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      } else {
        chrome.tabs.sendMessage(tabId, message, callback);
      }
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * Wrap an async message handler. Returning true keeps the message channel open
 * until the promise settles.
 */
export function onMessage(handler) {
  const listener = (message, sender, sendResponse) => {
    let result;
    try {
      result = handler(message, sender);
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
      return false;
    }

    if (result && typeof result.then === 'function') {
      result
        .then((value) => sendResponse(value === undefined ? { ok: true } : value))
        .catch((error) =>
          sendResponse({ ok: false, error: error?.message || String(error) })
        );
      return true;
    }

    if (result !== undefined) {
      sendResponse(result);
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Inject the content scripts into an existing tab. Used as a fallback when the
 * extension was installed or reloaded after the page finished loading.
 */
export async function injectContentScripts(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isInjectableUrl(tab.url)) return false;

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/video-detector.js', 'content/content.js']
    });

    return true;
  } catch (error) {
    console.warn('[Video Downloader] Content script injection failed:', error);
    return false;
  }
}

/** Ask the content script for a fresh scan, injecting it if necessary. */
export async function requestPageMedia(tabId, options = {}) {
  const { timeout = 2500, rescan = false } = options;
  const message = { type: rescan ? MSG.RESCAN_PAGE : MSG.GET_PAGE_MEDIA };
  try {
    const response = await sendTabMessage(
      tabId,
      message,
      { timeout }
    );
    if (response && response.ok) return response;
  } catch {
    // Fall through to injection.
  }

  const injected = await injectContentScripts(tabId);
  if (!injected) {
    return { ok: false, videos: [], error: 'The page could not be inspected.' };
  }

  // Give the freshly injected detector a moment to run its first scan.
  try {
    return await sendTabMessage(tabId, message, { timeout: 2500 });
  } catch (error) {
    return { ok: false, videos: [], error: error.message };
  }
}

/**
 * Broadcast to extension pages. Rejections are swallowed because no page may be
 * open (the service worker only has a runtime channel when a page listens).
 */
export function broadcastToPages(message) {
  try {
    const result = chrome.runtime.sendMessage(message, () => {
      // Reading lastError prevents console noise when nobody is listening.
      void chrome.runtime.lastError;
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // No receiver; nothing to do.
  }
}

/** Notify the content script about overlay settings without failing hard. */
export function sendOverlaySetting(tabId, enabled) {
  return sendTabMessage(tabId, { type: MSG.SET_OVERLAY, enabled }, { timeout: 1500 }).catch(
    () => false
  );
}

/** Resolve once the service worker answers a ping (or after the timeout). */
export async function pingBackground(timeout = 1500) {
  try {
    return await sendRuntimeMessage({ type: MSG.PING }, { timeout });
  } catch {
    return null;
  }
}

export { withTimeout };
