import { MSG } from '../utils/constants.js';
import { getHistory, getSettings, onStorageChanged } from '../utils/storage.js';
import { sendRuntimeMessage } from '../utils/messaging.js';
import {
  debounce,
  escapeHtml,
  formatBytes,
  formatDateTime,
  getDomain,
  percent,
  timeAgo,
  truncate
} from '../utils/helpers.js';

const ICONS = {
  open:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M10 11v6M14 11v6"/></svg>',
  cancel:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  play:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  empty:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
  filter:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8Z"/></svg>'
};

const STATUS_LABELS = {
  complete: 'Saved',
  in_progress: 'Downloading',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

const state = {
  entries: [],
  filter: 'all',
  query: '',
  settings: {},
  loading: true
};

let elements = {};
let toastTimer = null;
let searchTimer = null;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
}

function showToast(message, isError = false) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', Boolean(isError));
  elements.toast.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove('is-visible');
  }, 3200);
}

function normalizeStatus(entry) {
  if (!entry || !entry.status) return 'in_progress';
  if (entry.status === 'downloading') return 'in_progress';
  return entry.status;
}

function entrySize(entry) {
  return (
    Number(entry.fileSize) ||
    Number(entry.totalBytes) ||
    Number(entry.size) ||
    0
  );
}

function basename(path) {
  return String(path || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function canRedownload(entry) {
  if (!entry?.url) return false;
  if (entry.mediaType === 'hls' || entry.mediaType === 'dash') return false;
  if (entry.kind === 'stream') return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function render() {
  renderStats();
  renderFilters();
  renderList();
}

function renderStats() {
  const total = state.entries.length;
  const completed = state.entries.filter((entry) => normalizeStatus(entry) === 'complete');
  const active = state.entries.filter((entry) => normalizeStatus(entry) === 'in_progress').length;
  const totalSize = completed.reduce((sum, entry) => sum + entrySize(entry), 0);

  elements.statTotal.textContent = String(total);
  elements.statComplete.textContent = String(completed.length);
  elements.statSize.textContent = formatBytes(totalSize);
  elements.statActive.textContent = String(active);

  elements.statCompleteNote.textContent = completed.length
    ? `${percent(completed.length, total)}% of downloads finished`
    : 'nothing saved yet';
}

function renderFilters() {
  const counts = { all: state.entries.length, complete: 0, in_progress: 0, failed: 0, cancelled: 0 };
  for (const entry of state.entries) {
    const status = normalizeStatus(entry);
    if (status in counts) counts[status] += 1;
  }

  const targets = {
    all: elements.countAll,
    complete: elements.countComplete,
    in_progress: elements.countProgress,
    failed: elements.countFailed,
    cancelled: elements.countCancelled
  };

  for (const [key, element] of Object.entries(targets)) {
    if (element) element.textContent = String(counts[key] || 0);
    const chip = elements.filters.querySelector(`[data-filter="${key}"]`);
    if (chip) {
      const active = state.filter === key;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  }
}

function getFilteredEntries() {
  const query = state.query.trim().toLowerCase();
  return state.entries.filter((entry) => {
    if (state.filter !== 'all' && normalizeStatus(entry) !== state.filter) return false;
    if (!query) return true;
    const haystack = [
      entry.title,
      entry.filename,
      entry.domain,
      entry.url,
      entry.pageTitle,
      entry.formatLabel,
      basename(entry.filename)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function renderList() {
  const scrollY = window.scrollY;

  if (state.loading) {
    elements.list.innerHTML = `
      <div class="state">
        <div class="state-icon">${ICONS.download}</div>
        <h3>Loading history…</h3>
        <p>Reading locally stored download records.</p>
      </div>
    `;
    return;
  }

  if (!state.entries.length) {
    elements.list.innerHTML = `
      <div class="state">
        <div class="state-icon">${ICONS.empty}</div>
        <h3>No downloads yet</h3>
        <p>
          Open the extension on a page with a video and choose Download. Completed
          downloads, active transfers and failures will all appear here.
        </p>
        <div class="state-actions">
          <button class="btn btn-ghost" type="button" data-action="open-options">Settings</button>
        </div>
      </div>
    `;
    return;
  }

  const filtered = getFilteredEntries();
  if (!filtered.length) {
    elements.list.innerHTML = `
      <div class="state">
        <div class="state-icon">${ICONS.filter}</div>
        <h3>No matching downloads</h3>
        <p>Nothing matches the current status filter and search.</p>
        <div class="state-actions">
          <button class="btn btn-ghost" type="button" data-action="clear-filters">Clear filters</button>
        </div>
      </div>
    `;
    return;
  }

  elements.list.innerHTML = filtered.map((entry) => renderEntry(entry)).join('');
  bindImageFallbacks();

  if (scrollY > 0) window.scrollTo(0, scrollY);
}

function renderEntry(entry) {
  const status = normalizeStatus(entry);
  const id = escapeHtml(entry.id);
  const size = entrySize(entry);
  const domain = entry.domain || getDomain(entry.pageUrl || entry.url);
  const fileName = basename(entry.filename) || basename(entry.requestedFilename);
  const formatLabel =
    entry.formatLabel ||
    (entry.height ? `${entry.height}p` : '') ||
    String(entry.extension || '').toUpperCase();
  const when = entry.startedAt ? timeAgo(entry.startedAt) : '';
  const fullDate = entry.startedAt ? formatDateTime(entry.startedAt) : '';
  const isActive = status === 'in_progress';
  const downloadId = Number(entry.downloadId);
  const hasDownload = Number.isFinite(downloadId) && downloadId > 0;

  const meta = [];
  if (formatLabel) meta.push(`<span>${escapeHtml(formatLabel)}</span>`);
  if (size) meta.push(`<span>${formatBytes(size)}</span>`);
  if (domain) meta.push(`<span>${escapeHtml(domain)}</span>`);
  if (when) meta.push(`<span title="${escapeHtml(fullDate)}">${escapeHtml(when)}</span>`);
  if (isActive && Number(entry.totalBytes) > 0) {
    meta.push(
      `<span>${percent(entry.bytesReceived, entry.totalBytes)}%</span>`
    );
  }

  const poster = entry.poster
    ? `<img src="${escapeHtml(
        entry.poster
      )}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : '';

  const progress = isActive
    ? `<div class="progress ${
        Number(entry.totalBytes) > 0 ? '' : 'indeterminate'
      }"><span style="width:${percent(entry.bytesReceived, entry.totalBytes)}%"></span></div>`
    : '';

  const error =
    status === 'failed' && entry.error
      ? `<p class="entry-error">${escapeHtml(truncate(entry.error, 180))}</p>`
      : '';

  const actions = [];

  if (isActive) {
    actions.push(actionButton('cancel', 'cancel', 'Cancel download', id, { danger: true }));
  } else {
    if (status === 'complete' && hasDownload) {
      actions.push(actionButton('open', 'open', 'Open file', id));
    }
    if (hasDownload) {
      actions.push(actionButton('folder', 'folder', 'Show in folder', id));
    }
    if (canRedownload(entry)) {
      actions.push(actionButton('redownload', 'download', 'Download again', id));
    }
  }
  actions.push(actionButton('remove', 'trash', 'Remove from history', id, { danger: true }));

  return `
    <article class="entry" data-id="${id}">
      <div class="entry-thumb ${poster ? 'has-poster' : ''}">
        ${poster}
        <span class="play">${ICONS.play}</span>
      </div>
      <div class="entry-main">
        <div class="entry-top">
          <h3 class="entry-title" title="${escapeHtml(entry.title || '')}">${escapeHtml(
            truncate(entry.title || fileName || 'Untitled media', 160)
          )}</h3>
          <span class="status ${escapeHtml(status)}">${escapeHtml(
            STATUS_LABELS[status] || status
          )}</span>
        </div>
        <div class="entry-meta">${meta.join('')}</div>
        <p class="entry-file" title="${escapeHtml(entry.filename || '')}">${escapeHtml(
          fileName || entry.url || ''
        )}</p>
        ${error}
        ${progress}
      </div>
      <div class="entry-actions">${actions.join('')}</div>
    </article>
  `;
}

function actionButton(action, icon, label, id, options = {}) {
  return `<button
    class="icon-button ${options.danger ? 'danger' : ''}"
    type="button"
    data-action="${action}"
    data-id="${id}"
    title="${escapeHtml(label)}"
    aria-label="${escapeHtml(label)}"
    ${options.disabled ? 'disabled' : ''}
  >${ICONS[icon] || ''}</button>`;
}

function bindImageFallbacks() {
  for (const image of elements.list.querySelectorAll('.entry-thumb img')) {
    image.addEventListener(
      'error',
      () => {
        const thumb = image.closest('.entry-thumb');
        image.remove();
        if (thumb) thumb.classList.remove('has-poster');
      },
      { once: true }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

async function load() {
  try {
    state.entries = await getHistory();
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    elements.list.innerHTML = `
      <div class="state">
        <div class="state-icon">${ICONS.filter}</div>
        <h3>Could not load history</h3>
        <p>${escapeHtml(error?.message || 'Local storage is unavailable.')}</p>
        <div class="state-actions">
          <button class="btn btn-ghost" type="button" data-action="reload">Try again</button>
        </div>
      </div>
    `;
  }
}

const scheduleLoad = debounce(load, 300);

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

function findEntry(id) {
  return state.entries.find((entry) => entry.id === id);
}

async function handleOpen(entry) {
  if (!entry?.downloadId) return;
  const response = await sendRuntimeMessage(
    { type: MSG.OPEN_DOWNLOAD, downloadId: entry.downloadId },
    { timeout: 8000 }
  ).catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    showToast(response?.error || 'The file could not be opened.', true);
  }
}

async function handleFolder(entry) {
  if (!entry?.downloadId) return;
  const response = await sendRuntimeMessage(
    { type: MSG.SHOW_IN_FOLDER, downloadId: entry.downloadId },
    { timeout: 8000 }
  ).catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    showToast(response?.error || 'The folder could not be opened.', true);
  }
}

async function handleCancel(entry) {
  if (!entry?.downloadId) return;
  const response = await sendRuntimeMessage(
    { type: MSG.CANCEL_DOWNLOAD, downloadId: entry.downloadId },
    { timeout: 8000 }
  ).catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    showToast(response?.error || 'The download could not be cancelled.', true);
    return;
  }
  showToast('Download cancelled.');
}

async function handleRemove(entry) {
  if (!entry) return;
  const previous = state.entries;
  state.entries = state.entries.filter((item) => item.id !== entry.id);
  render();

  try {
    const response = await sendRuntimeMessage(
      { type: MSG.REMOVE_HISTORY_ITEM, id: entry.id },
      { timeout: 8000 }
    );
    if (!response?.ok) throw new Error(response?.error || 'The entry could not be removed.');
    showToast('Removed from history.');
  } catch (error) {
    state.entries = previous;
    render();
    showToast(error?.message || 'The entry could not be removed.', true);
  }
}

async function handleRedownload(entry) {
  const media = {
    url: entry.url,
    title: entry.title,
    pageUrl: entry.pageUrl,
    pageTitle: entry.pageTitle,
    poster: entry.poster,
    kind: entry.kind,
    type: entry.mediaType || entry.type,
    extension: entry.extension,
    height: entry.height
  };

  const format = {
    url: entry.url,
    extension: entry.extension,
    label: entry.formatLabel || 'Original',
    height: entry.height,
    kind: entry.kind,
    type: entry.mediaType || entry.type || 'file',
    requiresExternal: false
  };

  try {
    const response = await sendRuntimeMessage(
      {
        type: MSG.START_DOWNLOAD,
        media,
        format
      },
      { timeout: 20000 }
    );
    if (!response || response.ok === false) {
      throw new Error(response?.error || 'The download could not be started.');
    }
    showToast('Download started.');
    setTimeout(scheduleLoad, 600);
  } catch (error) {
    showToast(error?.message || 'The download could not be started.', true);
  }
}

async function handleClear() {
  try {
    const response = await sendRuntimeMessage({ type: MSG.CLEAR_HISTORY }, { timeout: 8000 });
    if (!response?.ok) throw new Error(response?.error || 'History could not be cleared.');
    state.entries = [];
    render();
    showToast('History cleared. Downloaded files were not deleted.');
  } catch (error) {
    showToast(error?.message || 'History could not be cleared.', true);
  }
}

function exportHistory() {
  const payload = {
    exportedAt: new Date().toISOString(),
    extension: 'Video Downloader',
    version: chrome.runtime.getManifest().version,
    entries: state.entries
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `video-downloader-history-${date}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('History exported as JSON.');
}

function resetClearButton() {
  if (!elements.clearButton) return;
  if (elements.clearButton.dataset.timer) {
    clearTimeout(Number(elements.clearButton.dataset.timer));
  }
  elements.clearButton.textContent = 'Clear history';
  elements.clearButton.classList.remove('is-confirming');
  delete elements.clearButton.dataset.confirming;
  delete elements.clearButton.dataset.timer;
}

function armClearButton() {
  if (elements.clearButton.dataset.confirming === '1') {
    resetClearButton();
    void handleClear();
    return;
  }
  elements.clearButton.dataset.confirming = '1';
  elements.clearButton.textContent = 'Click again to confirm';
  elements.clearButton.classList.add('is-confirming');
  elements.clearButton.dataset.timer = String(setTimeout(resetClearButton, 3500));
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  elements.filters?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    const filter = chip.dataset.filter;
    if (!['all', 'complete', 'in_progress', 'failed', 'cancelled'].includes(filter)) return;
    state.filter = filter;
    render();
  });

  elements.search?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = elements.search.value || '';
      renderList();
    }, 150);
  });

  elements.list?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;

    if (action === 'open-options') {
      try {
        chrome.runtime.openOptionsPage();
      } catch {
        window.open(chrome.runtime.getURL('options/options.html'), '_blank');
      }
      return;
    }

    if (action === 'clear-filters') {
      state.filter = 'all';
      state.query = '';
      if (elements.search) elements.search.value = '';
      render();
      return;
    }

    if (action === 'reload') {
      state.loading = true;
      renderList();
      void load();
      return;
    }

    const entry = findEntry(button.dataset.id);
    if (!entry) return;

    switch (action) {
      case 'open':
        void handleOpen(entry);
        break;
      case 'folder':
        void handleFolder(entry);
        break;
      case 'cancel':
        void handleCancel(entry);
        break;
      case 'remove':
        void handleRemove(entry);
        break;
      case 'redownload':
        void handleRedownload(entry);
        break;
      default:
        break;
    }
  });

  elements.exportButton?.addEventListener('click', exportHistory);
  elements.clearButton?.addEventListener('click', armClearButton);

  document.getElementById('open-options')?.addEventListener('click', () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch {
      window.open(chrome.runtime.getURL('options/options.html'), '_blank');
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== MSG.DOWNLOAD_UPDATE) return false;
    const patch = message.patch || {};
    const entry = state.entries.find(
      (item) =>
        item.id === message.historyId ||
        (message.downloadId && Number(item.downloadId) === Number(message.downloadId))
    );

    if (!entry) {
      scheduleLoad();
      return false;
    }

    Object.assign(entry, patch);
    if (patch.status === 'complete') {
      showToast(`Saved: ${truncate(entry.title || 'download', 60)}`);
    } else if (patch.status === 'failed') {
      showToast('A download failed. See the entry for details.', true);
    }
    render();
    return false;
  });

  onStorageChanged((changes) => {
    if (changes.vd_settings?.newValue) {
      state.settings = { ...state.settings, ...changes.vd_settings.newValue };
      applyTheme(state.settings.theme);
    }
    if (changes.vd_history) scheduleLoad();
  });
}

/* -------------------------------------------------------------------------- */
/* Startup                                                                    */
/* -------------------------------------------------------------------------- */

async function init() {
  elements = {
    list: document.getElementById('list'),
    filters: document.querySelector('.filters'),
    search: document.getElementById('search'),
    toast: document.getElementById('toast'),
    exportButton: document.getElementById('export-history'),
    clearButton: document.getElementById('clear-history'),
    statTotal: document.getElementById('stat-total'),
    statComplete: document.getElementById('stat-complete'),
    statCompleteNote: document.getElementById('stat-complete-note'),
    statSize: document.getElementById('stat-size'),
    statActive: document.getElementById('stat-active'),
    countAll: document.getElementById('count-all'),
    countComplete: document.getElementById('count-complete'),
    countProgress: document.getElementById('count-progress'),
    countFailed: document.getElementById('count-failed'),
    countCancelled: document.getElementById('count-cancelled')
  };

  document.getElementById('version').textContent =
    chrome.runtime.getManifest().version;

  try {
    state.settings = await getSettings();
    applyTheme(state.settings.theme);
  } catch {
    state.settings = {};
  }

  bindEvents();
  render();
  await load();
}

void init();
