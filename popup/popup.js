import { MSG } from '../utils/constants.js';
import { getSettings, onStorageChanged } from '../utils/storage.js';
import { sendRuntimeMessage } from '../utils/messaging.js';
import {
  escapeHtml,
  formatBytes,
  formatDuration,
  getDomain,
  truncate
} from '../utils/helpers.js';
import {
  buildFormats,
  externalFormatReason,
  pickDefaultFormat
} from '../scripts/format-detector.js';
import { isYouTubeUrl } from '../scripts/url-validator.js';

const ICONS = {
  play:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  empty:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10 5-2.5v9L16 14"/><path d="m3 3 18 18"/></svg>',
  globe:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5"/><path d="M12 17.5h.01"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.2 7.6 8 9 4.8-1.4 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>'
};

const state = {
  tabId: null,
  page: null,
  videos: [],
  filter: 'all',
  query: '',
  settings: {},
  selectedFormats: new Map(),
  loading: true,
  error: '',
  unsupported: '',
  warning: ''
};

let elements = {};
let toastTimer = null;
let searchTimer = null;
const downloadTargets = new Map();

async function updateCreditsDisplay() {
  const creditsEl = document.getElementById('credits-count');
  try {
    let response;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await sendRuntimeMessage(
          { type: MSG.GET_AD_CREDITS },
          { timeout: 25000 }
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!response) throw lastError || new Error('Could not load available credits.');
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not load available credits.');
    }
    if (!creditsEl) return;
    creditsEl.textContent =
      typeof response.downloadsRemaining === 'number'
        ? String(response.downloadsRemaining)
        : response.unlocked
          ? '∞'
          : '0';
    const creditsDisplay = document.getElementById('credits-display');
    if (creditsDisplay) {
      creditsDisplay.removeAttribute('aria-busy');
      creditsDisplay.title = `${creditsEl.textContent} downloads available`;
      creditsDisplay.setAttribute('aria-label', `${creditsEl.textContent} downloads available`);
    }
  } catch (error) {
    console.error('Failed to fetch credits', error);
    if (creditsEl) creditsEl.textContent = 'N/A';
    const creditsDisplay = document.getElementById('credits-display');
    if (creditsDisplay) {
      creditsDisplay.title = error?.message || 'Could not load available credits.';
      creditsDisplay.setAttribute('aria-label', 'Credits unavailable');
      creditsDisplay.setAttribute('aria-busy', 'false');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function showToast(message, isError = false) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', Boolean(isError));
  elements.toast.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove('is-visible');
  }, 3400);
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers/contexts where the async clipboard is blocked.
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function prepareVideo(raw) {
  const formats = (
    Array.isArray(raw.formats) && raw.formats.length ? raw.formats : buildFormats(raw)
  )
    .filter((format) => format && format.url)
    .map((format, index) => ({
      ...format,
      id: format.id || `${raw.id || 'media'}:f:${index}`
    }));

  return {
    ...raw,
    id: raw.id || raw.url,
    formats,
    domain: raw.domain || getDomain(raw.pageUrl || raw.url)
  };
}

function applyDownloadedSizes(videos, history) {
  const completedEntries = (Array.isArray(history) ? history : [])
    .filter(
      (entry) =>
        entry?.status === 'complete' &&
        Number(entry.fileSize || entry.totalBytes) > 0 &&
        entry.url
    )
    .sort((a, b) => (Number(b.completedAt) || 0) - (Number(a.completedAt) || 0));

  for (const video of videos) {
    const downloaded = completedEntries.find(
      (entry) => stripMediaHash(entry.url) === stripMediaHash(video.url)
    );
    if (downloaded && !video.downloadedSize) {
      video.downloadedSize = Number(downloaded.fileSize || downloaded.totalBytes);
    }
  }
}

function stripMediaHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url || '');
  }
}

function chooseFormat(video) {
  const preferred = pickDefaultFormat(video.formats, state.settings);
  return preferred?.id || video.formats[0]?.id || null;
}

function getSelectedFormat(video) {
  const selectedId = state.selectedFormats.get(video.id);
  return video.formats.find((format) => format.id === selectedId) || video.formats[0] || null;
}

function serializeMedia(video) {
  return {
    url: video.url,
    title: video.title,
    pageUrl: video.pageUrl,
    pageTitle: video.pageTitle,
    poster: video.poster,
    kind: video.kind,
    type: video.type,
    extension: video.extension,
    mime: video.mime,
    duration: video.duration,
    width: video.width,
    height: video.height,
    size: video.size,
    variants: video.variants,
    formats: video.formats
  };
}

function serializeFormat(format) {
  if (!format) return null;
  return {
    id: format.id,
    url: format.url,
    label: format.label,
    extension: format.extension,
    mime: format.mime,
    kind: format.kind,
    type: format.type,
    height: format.height,
    width: format.width,
    bandwidth: format.bandwidth,
    requiresExternal: format.requiresExternal,
    encrypted: format.encrypted
  };
}

function displayUrl(url) {
  try {
    return new URL(url).href.replace(/^https?:\/\//i, '');
  } catch {
    return url || '';
  }
}

function getFilteredVideos() {
  const query = state.query.trim().toLowerCase();
  return state.videos.filter((video) => {
    if (state.filter !== 'all' && video.kind !== state.filter) return false;
    if (!query) return true;
    const haystack = [
      video.title,
      video.domain,
      video.extension,
      video.pageTitle,
      ...(video.formats || []).map((format) => format.label)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function counts() {
  const result = { all: state.videos.length, video: 0, audio: 0, stream: 0 };
  for (const video of state.videos) {
    if (video.kind in result) result[video.kind] += 1;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function render() {
  if (!elements.content) return;
  renderHeader();
  renderFilters();
  renderContent();
}

function renderHeader() {
  const page = state.page || {};
  const domain = page.domain || getDomain(page.url || '');
  elements.pageDomain.textContent = domain || 'This page';

  if (state.loading && !state.videos.length) {
    elements.pageTitle.textContent = 'Scanning this page…';
  } else if (state.unsupported) {
    elements.pageTitle.textContent = 'This page cannot be inspected';
  } else {
    elements.pageTitle.textContent = page.title || 'Current page';
  }

  elements.pageUrl.textContent = page.url ? displayUrl(page.url) : '';
  elements.pageUrl.title = page.url || '';
  if (elements.copyPageUrlButton) {
    elements.copyPageUrlButton.disabled = !page.url;
  }

  const total = state.videos.length;
  let summary = 'Looking for video and audio…';
  if (state.error) {
    summary = 'Scan failed';
  } else if (!state.loading) {
    if (state.unsupported) summary = 'Not available on this page';
    else if (total === 0) summary = 'No media found yet';
    else summary = `${total} media item${total === 1 ? '' : 's'} found`;
  }
  elements.summaryCount.textContent = summary;
}

function renderFilters() {
  const stats = counts();
  for (const key of ['all', 'video', 'audio', 'stream']) {
    const countElement = elements[`count${key[0].toUpperCase()}${key.slice(1)}`];
    if (countElement) countElement.textContent = String(stats[key] || 0);
    const chip = elements.filters.querySelector(`[data-filter="${key}"]`);
    if (chip) {
      const active = state.filter === key;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  }
}

function renderContent() {
  const content = elements.content;

  if (state.loading && !state.videos.length) {
    content.innerHTML = `
      <div class="skeleton-list" aria-hidden="true">
        ${[0, 1, 2].map(() => `
          <div class="skeleton-card">
            <div class="sk-thumb"></div>
            <div class="sk-body">
              <div class="sk-line title"></div>
              <div class="sk-line meta"></div>
              <div class="sk-chips">
                <div class="sk-chip"></div>
                <div class="sk-chip"></div>
                <div class="sk-chip"></div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    return;
  }

  if (state.error) {
    content.innerHTML = renderState({
      icon: 'alert',
      tone: 'danger',
      title: 'Could not scan this page',
      message: state.error,
      actions: `<button class="btn btn-primary" type="button" data-action="retry">Try again</button>`
    });
    bindImageFallbacks();
    return;
  }

  if (state.unsupported) {
    content.innerHTML = renderState({
      icon: 'globe',
      tone: 'muted',
      title: 'This page cannot be inspected',
      message: state.unsupported,
      extra: `<ul class="tips">
        <li>Open a regular website with a video or audio player.</li>
        <li>Browser settings, extension pages and local files are off limits.</li>
      </ul>`,
      actions: `<button class="btn btn-ghost" type="button" data-action="open-options">Open settings</button>`
    });
    bindImageFallbacks();
    return;
  }

  const filtered = getFilteredVideos();
  const banner = state.warning
    ? `<div class="banner is-neutral">${ICONS.alert}<span>${escapeHtml(state.warning)}</span></div>`
    : '';

  if (!state.videos.length) {
    content.innerHTML = `${banner}${renderState({
      icon: 'empty',
      tone: 'muted',
      title: 'No media detected yet',
      message:
        'Start playing a video, then rescan. Media loaded by the page will show up here.',
      extra: `<ul class="tips">
        <li>Some sites load the video only after you press play.</li>
        <li>DRM-protected services (Netflix, Disney+, Prime Video) are not supported.</li>
        <li>Streaming manifests (HLS/DASH) can be copied and played in VLC.</li>
      </ul>`,
      actions: `<button class="btn btn-primary" type="button" data-action="retry">Rescan page</button>`
    })}`;
    bindImageFallbacks();
    return;
  }

  if (!filtered.length) {
    content.innerHTML = renderState({
      icon: 'empty',
      tone: 'muted',
      title: 'No matching media',
      message: 'Nothing matches the current filter and search.',
      actions: `<button class="btn btn-ghost" type="button" data-action="clear-filters">Clear filters</button>`
    });
    bindImageFallbacks();
    return;
  }

  content.innerHTML = `${banner}<div class="media-list">${filtered
    .map((video) => renderCard(video))
    .join('')}</div>`;
  bindImageFallbacks();
}

function renderState({ icon, tone = 'muted', title, message, extra = '', actions = '' }) {
  return `
    <div class="state">
      <div class="state-icon ${tone}">${ICONS[icon] || ICONS.globe}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      ${extra}
      ${actions ? `<div class="state-actions">${actions}</div>` : ''}
    </div>
  `;
}

function renderCard(video) {
  const selected = getSelectedFormat(video);
  const format = selected || video.formats[0] || null;
  const mediaId = escapeHtml(video.id);
  const isYouTube = [video.url, video.pageUrl, ...video.formats.map((item) => item.url)].some(
    isYouTubeUrl
  );
  const isStream = video.kind === 'stream' || Boolean(format?.requiresExternal);
  const quality =
    Number(format?.height) > 0
      ? `${Number(format.height)}p`
      : Number(video.height) > 0
        ? `${Number(video.height)}p`
        : '';
  const duration = video.duration ? formatDuration(video.duration) : '';
  const downloadedSize = Number(video.downloadedSize) || 0;
  const size = downloadedSize
    ? `Downloaded: ${formatBytes(downloadedSize)}`
    : video.kind !== 'stream' && video.size > 0
      ? `Size: ${formatBytes(video.size)}`
      : 'Size: --';
  const extension = String(format?.extension || video.extension || '').toUpperCase();
  const kindLabel =
    video.kind === 'stream'
      ? video.type === 'dash'
        ? 'DASH'
        : 'HLS'
      : video.kind === 'audio'
        ? 'Audio'
        : 'Video';

  const metaItems = [];
  metaItems.push(`<span class="kind-tag ${escapeHtml(video.kind)}">${escapeHtml(kindLabel)}</span>`);
  metaItems.push(`<span class="meta-item">${escapeHtml(video.domain || '')}</span>`);
  if (duration) metaItems.push(`<span class="meta-item">${duration}</span>`);
  metaItems.push(`<span class="meta-item">${escapeHtml(size)}</span>`);

  const chips = (isYouTube ? [] : video.formats)
    .map((item) => {
      const isSelected = format && item.id === format.id;
      const titleParts = [
        String(item.extension || '').toUpperCase(),
        item.height ? `${item.height}p` : '',
        item.bandwidth ? `${Math.round(item.bandwidth / 1000)} kbps` : '',
        item.requiresExternal ? 'Playlist only' : ''
      ].filter(Boolean);
      return `<button
        type="button"
        class="format-chip${isSelected ? ' is-selected' : ''}"
        data-action="select-format"
        data-media-id="${mediaId}"
        data-format-id="${escapeHtml(item.id)}"
        title="${escapeHtml(titleParts.join(' · '))}"
        aria-pressed="${Boolean(isSelected)}"
      >${escapeHtml(item.label || 'Original')}<span class="format-ext">${escapeHtml(
        String(item.extension || '').toUpperCase()
      )}</span></button>`;
    })
    .join('');

  let note = '';
  if (isYouTube) {
    note =
      'YouTube uses separate audio/video streams and partial requests. Direct downloads are disabled to avoid incomplete or incorrect files. Use YouTube’s built-in download option where available.';
  } else if (isStream) {
    if (video.encrypted || format?.encrypted) {
      note =
        'This stream is encrypted. Saving it would require decryption and is not supported.';
    } else if (video.type === 'dash') {
      note =
        'DASH stream · copy the link into VLC or yt-dlp to download the full video.';
    } else {
      note =
        'HLS stream · copy the link into VLC or yt-dlp. You can also save the playlist file.';
    }
  } else if (format?.requiresExternal) {
    note = externalFormatReason(format);
  }

  const poster = video.poster
    ? `<img class="thumb-image" src="${escapeHtml(
        video.poster
      )}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : '';

  const actions = isYouTube
    ? ''
    : isStream
      ? `
        <button class="btn btn-ghost" type="button" data-action="playlist" data-media-id="${mediaId}">Save playlist</button>
        <button class="btn btn-primary" type="button" data-action="copy-link" data-media-id="${mediaId}">Copy link</button>
      `
      : `
        <button class="icon-button copy-button" type="button" data-action="copy" data-media-id="${mediaId}" title="Copy link" aria-label="Copy media link">${ICONS.copy}</button>
        <button class="btn btn-primary" type="button" data-action="download" data-media-id="${mediaId}">${ICONS.download}Download</button>
      `;

  const footerLabel = isYouTube
    ? 'YouTube download unavailable'
    : isStream
      ? 'Streaming format'
      : `${extension || 'FILE'} file`;

  return `
    <article class="card" data-media-id="${mediaId}">
      <div class="card-main">
        <div class="thumb ${poster ? 'has-poster' : ''}">
          ${poster}
          <span class="thumb-play">${ICONS.play}</span>
          <span class="thumb-kind">${escapeHtml(kindLabel)}</span>
          ${quality ? `<span class="thumb-quality">${escapeHtml(quality)}</span>` : ''}
          ${duration ? `<span class="thumb-duration">${duration}</span>` : ''}
        </div>
        <div class="details">
          <h3 class="card-title" title="${escapeHtml(video.title || '')}">${escapeHtml(
            truncate(video.title || 'Untitled media', 140)
          )}</h3>
          <div class="card-meta">${metaItems.join('')}</div>
          ${chips ? `<div class="formats" role="group" aria-label="Available formats">${chips}</div>` : ''}
          ${note ? `<p class="card-note">${escapeHtml(note)}</p>` : ''}
        </div>
      </div>
      <div class="card-footer">
        <span class="footer-label" title="${escapeHtml(video.url)}">${escapeHtml(
          footerLabel
        )}</span>
        <div class="card-actions">${actions}</div>
      </div>
    </article>
  `;
}

function bindImageFallbacks() {
  if (!elements.content) return;
  for (const image of elements.content.querySelectorAll('img.thumb-image')) {
    image.addEventListener(
      'error',
      () => {
        const thumb = image.closest('.thumb');
        image.remove();
        if (thumb) thumb.classList.remove('has-poster');
      },
      { once: true }
    );
  }
}

function updateSelectedFormatInCard(mediaId, formatId) {
  const video = state.videos.find((item) => item.id === mediaId);
  if (!video) return;
  const format = video.formats.find((item) => item.id === formatId);
  if (!format) return;

  state.selectedFormats.set(mediaId, formatId);

  const card = [...elements.content.querySelectorAll('.card')].find(
    (element) => element.dataset.mediaId === mediaId
  );
  if (!card) return;

  for (const chip of card.querySelectorAll('.format-chip')) {
    const selected = chip.dataset.formatId === formatId;
    chip.classList.toggle('is-selected', selected);
    chip.setAttribute('aria-pressed', String(selected));
  }

  const quality =
    Number(format.height) > 0
      ? `${Number(format.height)}p`
      : Number(video.height) > 0
        ? `${Number(video.height)}p`
        : '';
  const thumb = card.querySelector('.thumb');
  let badge = card.querySelector('.thumb-quality');

  if (quality && !badge && thumb) {
    badge = document.createElement('span');
    badge.className = 'thumb-quality';
    thumb.appendChild(badge);
  }
  if (badge) {
    if (quality) badge.textContent = quality;
    else badge.remove();
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function loadMedia({ refresh = false } = {}) {
  if (state.loading === true && state.videos.length === 0) {
    render();
  }
  state.loading = true;
  state.error = '';
  state.unsupported = '';
  state.warning = '';

  if (elements.refreshButton) {
    elements.refreshButton.classList.add('is-spinning');
    elements.refreshButton.disabled = true;
  }

  if (!state.videos.length) render();

  try {
    if (!Number.isFinite(state.tabId)) {
      throw new Error('No active tab was found. Open a website and try again.');
    }

    const response = await sendRuntimeMessage(
      {
        type: refresh ? MSG.REFRESH_TAB_MEDIA : MSG.GET_TAB_MEDIA,
        tabId: state.tabId
      },
      { timeout: 25000 }
    );

    if (!response) throw new Error('The extension did not respond.');
    if (response.ok === false) throw new Error(response.error || 'The page could not be scanned.');

    state.page = response.page || null;
    state.unsupported = response.unsupported ? response.reason || 'This page is not supported.' : '';
    state.warning = response.warning || '';
    state.videos = (Array.isArray(response.videos) ? response.videos : []).map(prepareVideo);
    try {
      const historyResponse = await sendRuntimeMessage({ type: MSG.GET_HISTORY });
      if (historyResponse?.ok) applyDownloadedSizes(state.videos, historyResponse.history);
    } catch (error) {
      console.warn('Could not load sizes from download history', error);
    }

    state.selectedFormats.clear();
    for (const video of state.videos) {
      const choice = chooseFormat(video);
      if (choice) state.selectedFormats.set(video.id, choice);
    }
  } catch (error) {
    state.error = error?.message || 'Something went wrong while scanning this page.';
  } finally {
    state.loading = false;
    if (elements.refreshButton) {
      elements.refreshButton.classList.remove('is-spinning');
      elements.refreshButton.disabled = false;
    }
    render();
  }
}

let pendingDownload = null;
let adTimer = null;
let adCountdown = 5;

function showAdModal() {
  const modal = document.getElementById('ad-modal');
  if (modal) {
    modal.classList.add('active');
    startAdTimer();
  }
}

function hideAdModal() {
  const modal = document.getElementById('ad-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  if (adTimer) {
    clearInterval(adTimer);
    adTimer = null;
  }
}

async function startAdTimer() {
  const skipBtn = document.getElementById('ad-skip');
  const countdownSpan = document.getElementById('ad-countdown');
  const progressBar = document.getElementById('ad-progress-bar');
  const timerText = document.getElementById('ad-timer-text');
  const clickBtn = document.getElementById('ad-click');
  if (adTimer) clearInterval(adTimer);
  if (skipBtn) skipBtn.disabled = true;
  adCountdown = 0;
  if (countdownSpan) countdownSpan.textContent = adCountdown;
  if (progressBar) progressBar.style.width = '0%';
  if (timerText) timerText.textContent = 'Loading advertisement...';
  if (skipBtn) skipBtn.textContent = 'Loading ad…';
  if (clickBtn) clickBtn.disabled = true;
  
  try {
    const response = await sendRuntimeMessage({ type: MSG.REQUEST_AD });
    if (!response?.ok || !response.ad) {
      throw new Error(response?.error || 'No advertisement is available.');
    }
    const ad = response.ad;
    const adImage = document.getElementById('ad-image');
    const adText = document.getElementById('ad-text');
    const adTitle = document.getElementById('ad-title');
    const duration = Math.max(1, Math.min(60, Number(ad.duration) || 5));

    if (adTitle) adTitle.textContent = ad.title || 'Advertisement';
    if (ad.type === 'image' && ad.imageUrl && adImage) {
      adImage.src = ad.imageUrl;
      adImage.style.display = 'block';
      if (adText) adText.style.display = 'none';
    } else if (adText) {
      adText.textContent = ad.description || ad.title || 'Advertisement';
      adText.style.display = 'block';
      if (adImage) {
        adImage.removeAttribute('src');
        adImage.style.display = 'none';
      }
    }

    if (clickBtn) {
      clickBtn.disabled = !ad.clickUrl;
      clickBtn.onclick = async () => {
        if (!ad.clickUrl) return;
        try {
          await sendRuntimeMessage({ type: MSG.AD_WATCHED, clicked: true });
          await chrome.tabs.create({ url: ad.clickUrl });
        } catch (error) {
          console.warn('Could not open advertisement link', error);
          showToast('Could not open the advertisement link.', true);
        }
      };
    }

    adCountdown = duration;
    if (countdownSpan) countdownSpan.textContent = adCountdown;
    if (skipBtn) {
      skipBtn.disabled = true;
      skipBtn.textContent = `Skip in ${adCountdown}s`;
    }
    if (timerText) timerText.textContent = 'Watch ad to continue...';

    adTimer = setInterval(() => {
      adCountdown -= 1;
      if (countdownSpan) countdownSpan.textContent = adCountdown;
      if (progressBar) progressBar.style.width = `${((duration - adCountdown) / duration) * 100}%`;

      if (adCountdown <= 0) {
        clearInterval(adTimer);
        adTimer = null;
        if (skipBtn) {
          skipBtn.disabled = false;
          skipBtn.textContent = 'Continue Download';
        }
        if (timerText) timerText.textContent = 'Ad complete - you can continue';
      } else if (skipBtn) {
        skipBtn.textContent = `Skip in ${adCountdown}s`;
      }
    }, 1000);
  } catch (error) {
    console.error('Failed to load ad', error);
    if (timerText) timerText.textContent = error?.message || 'Advertisement unavailable.';
    if (skipBtn) {
      skipBtn.disabled = true;
      skipBtn.textContent = 'Ad unavailable';
    }
    if (clickBtn) clickBtn.disabled = true;
  }
}

async function handleAdComplete() {
  try {
    await sendRuntimeMessage({ type: MSG.AD_WATCHED, completed: true });
    hideAdModal();
    await updateCreditsDisplay();
    
    if (pendingDownload) {
      const { video, button } = pendingDownload;
      pendingDownload = null;
      // Retry download
      await doDownload(video, button);
    }
  } catch (error) {
    console.error('Failed to grant ad unlock', error);
    hideAdModal();
  }
}

async function doDownload(video, button) {
  const format = getSelectedFormat(video);
  if (!format) {
    showToast('No downloadable format is available for this item.', true);
    return;
  }
  if (format.requiresExternal) {
    await handleCopyLink(video);
    return;
  }

  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add('is-busy');
  button.textContent = 'Starting…';

  try {
    const response = await sendRuntimeMessage(
      {
        type: MSG.START_DOWNLOAD,
        tabId: state.tabId,
        media: serializeMedia(video),
        format: serializeFormat(format)
      },
      { timeout: 20000 }
    );

    if (!response || response.ok === false) {
      if (response?.code === 'AD_REQUIRED') {
        pendingDownload = { video, button };
        button.disabled = false;
        button.classList.remove('is-busy');
        button.innerHTML = originalHtml;
        await updateCreditsDisplay();
        showAdModal();
        return;
      }
      throw new Error(response?.error || 'The download could not be started.');
    }

    if (response.historyId) downloadTargets.set(response.historyId, video.id);
    button.textContent = 'Started';
    showToast(
      response.playlist
        ? 'Playlist saved. Open it with VLC or ffmpeg.'
        : 'Download started. Progress is available in History.'
    );
    await updateCreditsDisplay();
    setTimeout(() => {
      button.disabled = false;
      button.classList.remove('is-busy');
      button.innerHTML = originalHtml;
    }, 1800);
  } catch (error) {
    showToast(error?.message || 'The download failed.', true);
    button.disabled = false;
    button.classList.remove('is-busy');
    button.innerHTML = originalHtml;
  }
}

async function handleDownload(video, button) {
  await doDownload(video, button);
}

async function handlePlaylist(video, button) {
  const format = getSelectedFormat(video);
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add('is-busy');
  button.textContent = 'Saving…';

  try {
    const response = await sendRuntimeMessage(
      {
        type: MSG.START_DOWNLOAD,
        tabId: state.tabId,
        media: serializeMedia(video),
        format: serializeFormat(format),
        playlist: true
      },
      { timeout: 25000 }
    );

    if (!response || response.ok === false) {
      throw new Error(response?.error || 'The playlist could not be saved.');
    }
    if (response.historyId) downloadTargets.set(response.historyId, video.id);
    showToast('Playlist saved. Open it with VLC, ffmpeg or yt-dlp.');
    button.textContent = 'Saved';
    setTimeout(() => {
      button.disabled = false;
      button.classList.remove('is-busy');
      button.innerHTML = originalHtml;
    }, 1800);
  } catch (error) {
    showToast(error?.message || 'The playlist could not be saved.', true);
    button.disabled = false;
    button.classList.remove('is-busy');
    button.innerHTML = originalHtml;
  }
}

async function handleCopyLink(video) {
  const format = getSelectedFormat(video);
  const url = format?.url || video.url;
  const copied = await copyText(url);
  if (!copied) {
    showToast('The link could not be copied.', true);
    return;
  }
  showToast(
    video.kind === 'stream'
      ? 'Stream link copied. Paste it into VLC, ffmpeg or yt-dlp.'
      : 'Media link copied to the clipboard.'
  );
}

async function handleCopyPageUrl() {
  const pageUrl = state.page?.url || '';
  if (!pageUrl) {
    showToast('The current page URL is not available.', true);
    return;
  }
  const copied = await copyText(pageUrl);
  showToast(
    copied ? 'Page URL copied for yt-dlp.' : 'The page URL could not be copied.',
    !copied
  );
}

function openPage(path) {
  const url = chrome.runtime.getURL(path);
  const created = chrome.tabs.create({ url });
  if (created && typeof created.catch === 'function') {
    created.catch(() => window.open(url, '_blank'));
  }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  document.getElementById('credits-display')?.addEventListener('click', () => {
    void updateCreditsDisplay();
  });

  document.getElementById('open-options')?.addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch {
      openPage('options/options.html');
    }
  });

  document.getElementById('open-history')?.addEventListener('click', () => {
    openPage('history/history.html');
  });
  elements.copyPageUrlButton?.addEventListener('click', () => {
    void handleCopyPageUrl();
  });

  elements.refreshButton?.addEventListener('click', () => {
    if (state.loading) return;
    void loadMedia({ refresh: true });
  });

  elements.filters?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    const filter = chip.dataset.filter;
    if (!['all', 'video', 'audio', 'stream'].includes(filter)) return;
    state.filter = filter;
    render();
  });

  elements.search?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = elements.search.value || '';
      renderContent();
    }, 140);
  });

  elements.content?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;

    if (action === 'retry') {
      void loadMedia({ refresh: true });
      return;
    }

    if (action === 'clear-filters') {
      state.query = '';
      state.filter = 'all';
      if (elements.search) elements.search.value = '';
      render();
      return;
    }

    if (action === 'open-options') {
      try {
        chrome.runtime.openOptionsPage();
      } catch {
        openPage('options/options.html');
      }
      return;
    }

    const mediaId = button.dataset.mediaId;
    const video = state.videos.find((item) => item.id === mediaId);
    if (!video) return;

    switch (action) {
      case 'select-format':
        if (button.dataset.formatId) {
          updateSelectedFormatInCard(mediaId, button.dataset.formatId);
        }
        break;
      case 'download':
        void handleDownload(video, button);
        break;
      case 'playlist':
        void handlePlaylist(video, button);
        break;
      case 'copy':
      case 'copy-link':
        void handleCopyLink(video);
        break;
      default:
        break;
    }
  });

  // Ad modal events
  document.getElementById('ad-close')?.addEventListener('click', hideAdModal);
  document.querySelector('.ad-modal-backdrop')?.addEventListener('click', hideAdModal);
  document.getElementById('ad-skip')?.addEventListener('click', () => {
    const skipBtn = document.getElementById('ad-skip');
    if (skipBtn && !skipBtn.disabled) {
      handleAdComplete();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== MSG.DOWNLOAD_UPDATE) return false;
    const status = message.patch?.status;
    if (status === 'complete') {
      const mediaId = downloadTargets.get(message.historyId);
      const video = state.videos.find((item) => item.id === mediaId);
      const fileSize = Number(message.patch?.fileSize || message.patch?.totalBytes) || 0;
      if (video && fileSize > 0) video.downloadedSize = fileSize;
      downloadTargets.delete(message.historyId);
      showToast('Download complete.');
      void sendRuntimeMessage({ type: MSG.GET_HISTORY })
        .then((response) => {
          if (!response?.ok) {
            throw new Error(response?.error || 'Could not load completed download size.');
          }
          applyDownloadedSizes(state.videos, response.history);
          renderContent();
        })
        .catch((error) => console.error('Failed to update downloaded file size', error));
    } else if (status === 'failed') {
      downloadTargets.delete(message.historyId);
      showToast('A download failed. Open History for details.', true);
    }
    return false;
  });

  onStorageChanged((changes) => {
    if (!changes.vd_settings?.newValue) return;
    state.settings = { ...state.settings, ...changes.vd_settings.newValue };
    applyTheme(state.settings.theme);
    if (elements.supportLink) {
      elements.supportLink.href = state.settings.supportUrl;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Startup                                                                    */
/* -------------------------------------------------------------------------- */

async function init() {
  elements = {
    content: document.getElementById('content'),
    filters: document.querySelector('.filters'),
    search: document.getElementById('search'),
    refreshButton: document.getElementById('refresh'),
    toast: document.getElementById('toast'),
    pageTitle: document.getElementById('page-title'),
    pageDomain: document.getElementById('page-domain'),
    pageUrl: document.getElementById('page-url'),
    summaryCount: document.getElementById('summary-count'),
    countAll: document.getElementById('count-all'),
    countVideo: document.getElementById('count-video'),
    countAudio: document.getElementById('count-audio'),
    countStream: document.getElementById('count-stream'),
    copyPageUrlButton: document.getElementById('copy-page-url'),
    supportLink: document.getElementById('support-link')
  };

  bindEvents();
  render();

  try {
    state.settings = await getSettings();
    applyTheme(state.settings.theme);
    if (elements.supportLink) elements.supportLink.href = state.settings.supportUrl;
  } catch {
    state.settings = {};
  }
  
  void updateCreditsDisplay();

  const params = new URLSearchParams(window.location.search);
  const queryTabId = Number(params.get('tabId'));
  if (Number.isFinite(queryTabId) && queryTabId > 0) {
    state.tabId = queryTabId;
  } else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tabId = tab?.id ?? null;
    } catch {
      state.tabId = null;
    }
  }

  await loadMedia();
}

void init();
