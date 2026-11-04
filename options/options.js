import {
  DEFAULT_SETTINGS,
  FORMAT_PRESETS,
  QUALITY_PRESETS
} from '../utils/constants.js';
import {
  clearHistory,
  getHistory,
  getSettings,
  onStorageChanged,
  resetSettings,
  saveSettings
} from '../utils/storage.js';
import {
  clamp,
  debounce,
  formatBytes
} from '../utils/helpers.js';
import { buildFilename } from '../scripts/download-manager.js';

const SAMPLE_MEDIA = {
  title: 'Sample video',
  url: 'https://example.com/sample-video.mp4',
  pageUrl: 'https://example.com/watch'
};
const SAMPLE_FORMAT = {
  extension: 'mp4',
  height: 1080,
  label: '1080p'
};

let currentSettings = { ...DEFAULT_SETTINGS };
let statusTimer = null;

const elements = {};

/* -------------------------------------------------------------------------- */
/* Theme and status                                                           */
/* -------------------------------------------------------------------------- */

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
}

function setStatus(text = 'Saved', mode = 'saved') {
  if (!elements.saveStatus) return;
  elements.saveStatus.textContent = text;
  elements.saveStatus.classList.toggle('is-saving', mode === 'saving');
  elements.saveStatus.classList.remove('is-idle');
  if (statusTimer) clearTimeout(statusTimer);
  if (mode === 'saved') {
    statusTimer = setTimeout(() => {
      elements.saveStatus.classList.add('is-idle');
    }, 2200);
  }
}

/* -------------------------------------------------------------------------- */
/* Form helpers                                                               */
/* -------------------------------------------------------------------------- */

function populateSelects() {
  elements.defaultQuality.innerHTML = QUALITY_PRESETS.map(
    (preset) => `<option value="${preset.value}">${preset.label}</option>`
  ).join('');

  elements.preferredFormat.innerHTML = FORMAT_PRESETS.map(
    (preset) => `<option value="${preset.value}">${preset.label}</option>`
  ).join('');
}

function applySettingsToForm(settings) {
  elements.autoDetect.checked = Boolean(settings.autoDetect);
  elements.showOverlay.checked = Boolean(settings.showOverlay);
  elements.showBadge.checked = Boolean(settings.showBadge);
  elements.notifyComplete.checked = Boolean(settings.notifyOnComplete);

  elements.downloadFolder.value = settings.downloadFolder || '';
  elements.filenameTemplate.value =
    settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;
  elements.defaultQuality.value = settings.defaultQuality || 'best';
  elements.preferredFormat.value = settings.preferredFormat || 'any';
  elements.askWhere.checked = Boolean(settings.askWhereToSave);
  elements.historyLimit.value = String(
    settings.historyLimit || DEFAULT_SETTINGS.historyLimit
  );
  elements.supportUrl.value = settings.supportUrl || DEFAULT_SETTINGS.supportUrl;
  elements.supportPreview.href = settings.supportUrl || DEFAULT_SETTINGS.supportUrl;
  elements.adApiUrl.value = settings.adApiUrl || '';

  const theme = settings.theme || 'system';
  const radio = document.querySelector(`input[name="theme"][value="${theme}"]`);
  if (radio) radio.checked = true;

  applyTheme(theme);
  renderPreview();
}

function readForm() {
  const themeRadio = document.querySelector('input[name="theme"]:checked');
  const template = elements.filenameTemplate.value.trim();

  return {
    autoDetect: elements.autoDetect.checked,
    showOverlay: elements.showOverlay.checked,
    showBadge: elements.showBadge.checked,
    notifyOnComplete: elements.notifyComplete.checked,
    downloadFolder: elements.downloadFolder.value.trim(),
    filenameTemplate: template || DEFAULT_SETTINGS.filenameTemplate,
    defaultQuality: elements.defaultQuality.value,
    preferredFormat: elements.preferredFormat.value,
    askWhereToSave: elements.askWhere.checked,
    theme: themeRadio?.value || 'system',
    historyLimit: clamp(
      Number(elements.historyLimit.value) || DEFAULT_SETTINGS.historyLimit,
      20,
      1000
    ),
    supportUrl: elements.supportUrl.value.trim() || DEFAULT_SETTINGS.supportUrl,
    adApiUrl: elements.adApiUrl.value.trim()
  };
}

function renderPreview() {
  if (!elements.filenamePreview) return;
  const settings = readForm();
  try {
    const path = buildFilename(SAMPLE_MEDIA, SAMPLE_FORMAT, settings);
    elements.filenamePreview.textContent = `Downloads/${path}`;
    elements.filenamePreview.title = `Downloads/${path}`;
  } catch {
    elements.filenamePreview.textContent = 'Downloads/Sample video - 1080p.mp4';
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

const persist = debounce(async () => {
  try {
    const draft = readForm();
    currentSettings = await saveSettings(draft);
    setStatus('Saved');
  } catch (error) {
    console.error('[Video Downloader] Could not save settings', error);
    setStatus('Could not save', 'saving');
  }
}, 400);

function queueSave() {
  setStatus('Saving…', 'saving');
  renderPreview();
  persist();
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

async function updateHistorySummary() {
  if (!elements.historySummary) return;
  try {
    const history = await getHistory();
    if (!history.length) {
      elements.historySummary.textContent = 'No downloads recorded.';
      return;
    }

    const completed = history.filter((entry) => entry.status === 'complete');
    const totalSize = completed.reduce(
      (sum, entry) => sum + (Number(entry.fileSize) || Number(entry.totalBytes) || 0),
      0
    );
    const parts = [
      `${history.length} entr${history.length === 1 ? 'y' : 'ies'}`,
      `${completed.length} completed`
    ];
    if (totalSize > 0) parts.push(`${formatBytes(totalSize)} saved`);
    elements.historySummary.textContent = parts.join(' · ');
  } catch {
    elements.historySummary.textContent = 'History is unavailable.';
  }
}

/* -------------------------------------------------------------------------- */
/* Confirm-to-act buttons                                                     */
/* -------------------------------------------------------------------------- */

function resetConfirm(button) {
  if (!button) return;
  if (button.dataset.timer) clearTimeout(Number(button.dataset.timer));
  if (button.dataset.original) button.textContent = button.dataset.original;
  button.classList.remove('is-confirming');
  delete button.dataset.confirming;
  delete button.dataset.timer;
  delete button.dataset.original;
}

function confirmThen(button, action, confirmLabel = 'Click again to confirm') {
  if (button.dataset.confirming === '1') {
    resetConfirm(button);
    void action();
    return;
  }
  button.dataset.confirming = '1';
  button.dataset.original = button.textContent;
  button.textContent = confirmLabel;
  button.classList.add('is-confirming');
  button.dataset.timer = String(
    setTimeout(() => resetConfirm(button), 3500)
  );
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  const form = document.querySelector('.main');

  form?.addEventListener('input', (event) => {
    if (event.target.name === 'theme') return;
    queueSave();
  });

  form?.addEventListener('change', (event) => {
    if (event.target.name === 'theme') {
      applyTheme(event.target.value);
    }
    if (event.target.id === 'history-limit') {
      const value = clamp(Number(event.target.value) || 300, 20, 1000);
      event.target.value = String(value);
    }
    queueSave();
  });

  elements.filenameTemplate?.addEventListener('blur', () => {
    if (!elements.filenameTemplate.value.trim()) {
      elements.filenameTemplate.value = DEFAULT_SETTINGS.filenameTemplate;
      queueSave();
    }
  });

  elements.downloadFolder?.addEventListener('blur', () => {
    elements.downloadFolder.value = elements.downloadFolder.value.trim();
  });

  for (const token of document.querySelectorAll('.token')) {
    token.addEventListener('click', () => {
      const input = elements.filenameTemplate;
      if (!input) return;
      const value = input.value;
      const start = input.selectionStart ?? value.length;
      const end = input.selectionEnd ?? value.length;
      input.setRangeText(token.dataset.token || '', start, end, 'end');
      input.focus();
      queueSave();
    });
  }

  document.getElementById('open-history')?.addEventListener('click', openHistory);
  document.getElementById('open-history-data')?.addEventListener('click', openHistory);
  elements.supportUrl?.addEventListener('input', () => {
    const entered = elements.supportUrl.value.trim();
    try {
      const parsed = new URL(entered);
      elements.supportPreview.href =
        parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? parsed.href
          : DEFAULT_SETTINGS.supportUrl;
    } catch {
      elements.supportPreview.href = DEFAULT_SETTINGS.supportUrl;
    }
  });

  elements.clearHistoryButton?.addEventListener('click', () => {
    confirmThen(
      elements.clearHistoryButton,
      async () => {
        await clearHistory();
        await updateHistorySummary();
        setStatus('History cleared');
        setTimeout(() => setStatus('Saved'), 1800);
      },
      'Click again to clear'
    );
  });

  elements.resetButton?.addEventListener('click', () => {
    confirmThen(
      elements.resetButton,
      async () => {
        currentSettings = await resetSettings();
        applySettingsToForm(currentSettings);
        setStatus('Defaults restored');
        setTimeout(() => setStatus('Saved'), 1800);
      },
      'Click again to reset'
    );
  });

  document.getElementById('dismiss-welcome')?.addEventListener('click', () => {
    if (elements.welcome) elements.welcome.hidden = true;
  });

  onStorageChanged((changes) => {
    if (changes.vd_history) void updateHistorySummary();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Flush pending edits when the tab is hidden. Best effort by design.
      void saveSettings(readForm()).then((next) => {
        currentSettings = next;
      });
    }
  });
}

function openHistory() {
  try {
    void chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
  } catch {
    window.open(chrome.runtime.getURL('history/history.html'), '_blank');
  }
}

/* -------------------------------------------------------------------------- */
/* Startup                                                                    */
/* -------------------------------------------------------------------------- */

async function init() {
  elements.saveStatus = document.getElementById('save-status');
  elements.autoDetect = document.getElementById('auto-detect');
  elements.showOverlay = document.getElementById('show-overlay');
  elements.showBadge = document.getElementById('show-badge');
  elements.notifyComplete = document.getElementById('notify-complete');
  elements.downloadFolder = document.getElementById('download-folder');
  elements.filenameTemplate = document.getElementById('filename-template');
  elements.filenamePreview = document.getElementById('filename-preview');
  elements.defaultQuality = document.getElementById('default-quality');
  elements.preferredFormat = document.getElementById('preferred-format');
  elements.askWhere = document.getElementById('ask-where');
  elements.historyLimit = document.getElementById('history-limit');
  elements.historySummary = document.getElementById('history-summary');
  elements.clearHistoryButton = document.getElementById('clear-history');
  elements.resetButton = document.getElementById('reset-settings');
  elements.welcome = document.getElementById('welcome');
  elements.supportUrl = document.getElementById('support-url');
  elements.supportPreview = document.getElementById('support-preview');
  elements.adApiUrl = document.getElementById('ad-api-url');

  const versionElement = document.getElementById('version');
  if (versionElement) {
    versionElement.textContent = chrome.runtime.getManifest().version;
  }

  populateSelects();

  try {
    currentSettings = await getSettings();
  } catch {
    currentSettings = { ...DEFAULT_SETTINGS };
  }
  applySettingsToForm(currentSettings);

  bindEvents();
  setStatus('Saved');
  void updateHistorySummary();

  const params = new URLSearchParams(window.location.search);
  if (params.get('welcome') === '1' && elements.welcome) {
    elements.welcome.hidden = false;
    try {
      history.replaceState(null, '', window.location.pathname);
    } catch {
      // Cosmetic only.
    }
  }
}

void init();
