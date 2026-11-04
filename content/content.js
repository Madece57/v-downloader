/**
 * Content script bridge (classic script).
 * - Feeds DOM detections to the service worker.
 * - Answers popup/background scan requests.
 * - Renders a small, dismissible "media found" pill on the top frame.
 */
(() => {
  const detector = window.__VD_DETECTOR__;
  if (!detector || window.__VD_CONTENT_READY__) return;
  window.__VD_CONTENT_READY__ = true;

  const MSG_GET_PAGE_MEDIA = 'vd:get-page-media';
  const MSG_RESCAN_PAGE = 'vd:rescan-page';
  const MSG_SET_OVERLAY = 'vd:set-overlay';
  const MSG_DETECTED_MEDIA = 'vd:detected-media';
  const MSG_OPEN_POPUP = 'vd:open-popup';
  const MSG_PING = 'vd:ping';

  const DISMISS_KEY = 'vd-overlay-dismissed';
  const settings = { showOverlay: true, autoDetect: true };

  let overlay = null;
  let countElement = null;
  let labelElement = null;
  let sendTimer = null;
  let lastSentSignature = '';
  let isTopFrame = true;

  try {
    isTopFrame = window.top === window;
  } catch {
    isTopFrame = false;
  }

  function isDismissed() {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setDismissed(value) {
    try {
      if (value) sessionStorage.setItem(DISMISS_KEY, '1');
      else sessionStorage.removeItem(DISMISS_KEY);
    } catch {
      // Storage can be blocked in some frames; the overlay simply stays.
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Overlay                                                                */
  /* ---------------------------------------------------------------------- */

  function ensureOverlay() {
    if (!isTopFrame || overlay || !document.body) return;
    overlay = document.createElement('div');
    overlay.id = 'vd-overlay';
    overlay.setAttribute('role', 'button');
    overlay.setAttribute('tabindex', '0');
    overlay.setAttribute('aria-label', 'Open Video Downloader');
    overlay.title = 'Open Video Downloader';

    const icon = document.createElement('img');
    icon.src = chrome.runtime.getURL('assets/icons/icon32.png');
    icon.alt = '';
    icon.width = 22;
    icon.height = 22;

    countElement = document.createElement('span');
    countElement.className = 'vd-overlay-count';
    countElement.textContent = '0';

    labelElement = document.createElement('span');
    labelElement.className = 'vd-overlay-label';
    labelElement.textContent = 'media';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'vd-overlay-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    overlay.append(icon, countElement, labelElement, close);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target === close) {
        setDismissed(true);
        overlay.classList.remove('vd-visible');
        return;
      }
      chrome.runtime.sendMessage({ type: MSG_OPEN_POPUP }, () => {
        void chrome.runtime.lastError;
      });
    });

    close.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        overlay.click();
      }
    });
  }

  function updateOverlay(videos) {
    if (!isTopFrame) return;
    ensureOverlay();
    if (!overlay) return;

    const count = videos.length;
    const visible = count > 0 && settings.showOverlay && !isDismissed();
    overlay.classList.toggle('vd-visible', visible);

    if (!visible) return;
    countElement.textContent = count > 99 ? '99+' : String(count);
    labelElement.textContent = 'media found';
    overlay.setAttribute(
      'aria-label',
      `${count} media item${count === 1 ? '' : 's'} found. Open Video Downloader`
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Messaging                                                              */
  /* ---------------------------------------------------------------------- */

  function sendDetections(force = false) {
    if (!settings.autoDetect && !force) return;
    const videos = detector.getVideos();
    if (!videos.length) return;

    const signature = videos.map((item) => item.url).sort().join('|');
    if (!force && signature === lastSentSignature) return;
    lastSentSignature = signature;

    try {
      chrome.runtime.sendMessage(
        {
          type: MSG_DETECTED_MEDIA,
          videos,
          pageTitle: document.title,
          pageUrl: location.href
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch {
      // The extension may have been reloaded; the next scan retries.
    }
  }

  function scheduleSend(delay = 1000) {
    if (sendTimer) return;
    sendTimer = setTimeout(() => {
      sendTimer = null;
      sendDetections();
    }, delay);
  }

  function handleDetections(videos) {
    updateOverlay(videos);
    scheduleSend();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    switch (message.type) {
      case MSG_GET_PAGE_MEDIA: {
        const videos = detector.rescan();
        updateOverlay(videos);
        sendResponse({
          ok: true,
          videos,
          pageTitle: document.title,
          pageUrl: location.href,
          count: videos.length
        });
        return false;
      }

      case MSG_RESCAN_PAGE: {
        const videos = detector.rescan({ clear: true });
        updateOverlay(videos);
        sendDetections(true);
        sendResponse({ ok: true, count: videos.length, videos });
        return false;
      }

      case MSG_SET_OVERLAY: {
        settings.showOverlay = Boolean(message.enabled);
        updateOverlay(detector.getVideos());
        sendResponse({ ok: true });
        return false;
      }

      case MSG_PING: {
        sendResponse({ ok: true, count: detector.count });
        return false;
      }

      default:
        return false;
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Startup                                                                */
  /* ---------------------------------------------------------------------- */

  function applySettings(stored) {
    if (!stored || typeof stored !== 'object') return;
    if (typeof stored.showOverlay === 'boolean') settings.showOverlay = stored.showOverlay;
    if (typeof stored.autoDetect === 'boolean') settings.autoDetect = stored.autoDetect;
    if (overlay) updateOverlay(detector.getVideos());
  }

  try {
    chrome.storage.local.get('vd_settings', (result) => {
      void chrome.runtime.lastError;
      applySettings(result?.vd_settings);
    });
  } catch {
    // Defaults remain in place.
  }

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.vd_settings) return;
      applySettings(changes.vd_settings.newValue);
    });
  } catch {
    // Storage events are optional.
  }

  detector.onChange(handleDetections);
  detector.start();

  // Give the page a moment to finish its initial hydration before reporting.
  setTimeout(() => {
    const videos = detector.getVideos();
    updateOverlay(videos);
    sendDetections(true);
  }, 1200);
})();
