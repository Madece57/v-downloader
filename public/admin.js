const API_URL = './api/index.php';
const elements = {};
let csrfToken = '';
let ads = [];

function showMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('is-error', isError);
}

async function api(action, body, method = 'POST') {
  const url = new URL(API_URL, window.location.href);
  url.searchParams.set('action', action);
  const options = { method, credentials: 'same-origin', cache: 'no-store' };
  if (body) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return result;
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setAuthenticated(isAuthenticated) {
  elements.authPanel.hidden = isAuthenticated;
  elements.dashboard.hidden = !isAuthenticated;
}

function startNewAd() {
  elements.adForm.reset();
  elements.adForm.elements.id.value = '';
  elements.adForm.elements.duration.value = '5';
  elements.adForm.elements.active.checked = true;
  elements.adFormHeading.textContent = 'Create an ad';
}

function editAd(id) {
  const ad = ads.find((item) => item.id === id);
  if (!ad) return;
  const form = elements.adForm;
  form.elements.id.value = ad.id;
  form.elements.title.value = ad.title;
  form.elements.description.value = ad.description;
  form.elements.type.value = ad.type;
  form.elements.imageUrl.value = ad.imageUrl;
  form.elements.clickUrl.value = ad.clickUrl;
  form.elements.duration.value = String(ad.duration);
  form.elements.active.checked = ad.active;
  elements.adFormHeading.textContent = 'Edit ad';
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderAds() {
  elements.adList.replaceChildren();
  if (!ads.length) {
    const empty = document.createElement('p');
    empty.className = 'muted-copy';
    empty.textContent = 'No ads yet. Create one to make it available to the extension.';
    elements.adList.append(empty);
    return;
  }
  for (const ad of ads) {
    const item = document.createElement('article');
    item.className = 'ad-item';
    const details = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = ad.title;
    const description = document.createElement('p');
    description.textContent = ad.description || 'No description';
    const status = document.createElement('span');
    status.className = 'ad-status';
    status.textContent = ad.active ? `Active · ${ad.type}` : 'Inactive';
    details.append(title, description, status);
    const actions = document.createElement('div');
    actions.className = 'ad-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => editAd(ad.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => void deleteAd(ad.id));
    actions.append(edit, remove);
    item.append(details, actions);
    elements.adList.append(item);
  }
}

async function loadDashboard() {
  const [statsResult, adsResult] = await Promise.all([
    api('stats', { csrf: csrfToken }),
    api('admin-ads', { csrf: csrfToken })
  ]);
  elements.statImpressions.textContent = statsResult.stats.impressions.toLocaleString();
  elements.statCompletions.textContent = statsResult.stats.completions.toLocaleString();
  elements.statClicks.textContent = statsResult.stats.clicks.toLocaleString();
  elements.statCredits.textContent = statsResult.stats.creditsUsed.toLocaleString();
  ads = adsResult.ads;
  renderAds();
}

async function deleteAd(id) {
  if (!window.confirm('Delete this advertisement?')) return;
  try {
    await api('delete-ad', { csrf: csrfToken, id });
    showMessage(elements.dashboardMessage, 'Advertisement deleted.');
    await loadDashboard();
  } catch (error) {
    showMessage(elements.dashboardMessage, error.message, true);
  }
}

async function initialize() {
  Object.assign(elements, {
    connectionError: document.querySelector('#connection-error'),
    authPanel: document.querySelector('#auth-panel'),
    authTitle: document.querySelector('#auth-title'),
    authDescription: document.querySelector('#auth-description'),
    authMessage: document.querySelector('#auth-message'),
    loginForm: document.querySelector('#login-form'),
    setupForm: document.querySelector('#setup-form'),
    dashboard: document.querySelector('#dashboard'),
    dashboardMessage: document.querySelector('#dashboard-message'),
    adList: document.querySelector('#ad-list'),
    adForm: document.querySelector('#ad-form'),
    adFormHeading: document.querySelector('#ad-form-heading'),
    passwordMessage: document.querySelector('#password-message'),
    statImpressions: document.querySelector('#stat-impressions'),
    statCompletions: document.querySelector('#stat-completions'),
    statClicks: document.querySelector('#stat-clicks'),
    statCredits: document.querySelector('#stat-credits')
  });

  try {
    const status = await api('status', null, 'GET');
    csrfToken = status.csrf || '';
    if (status.authenticated) {
      setAuthenticated(true);
      await loadDashboard();
      return;
    }
    setAuthenticated(false);
    elements.authPanel.hidden = false;
    if (status.setupRequired) {
      elements.authTitle.textContent = 'Create the first admin';
      elements.authDescription.textContent = status.setupEnabled
        ? 'Complete one-time setup using the token configured by the site operator.'
        : 'Admin setup is not enabled. The site operator must configure a setup token on the server.';
      elements.setupForm.hidden = !status.setupEnabled;
      elements.loginForm.hidden = true;
    } else {
      elements.authTitle.textContent = 'Admin sign in';
      elements.authDescription.textContent = 'Sign in to manage ads and view aggregate usage.';
      elements.loginForm.hidden = false;
      elements.setupForm.hidden = true;
    }
  } catch (error) {
    elements.connectionError.hidden = false;
    elements.connectionError.textContent = `Website services could not be reached: ${error.message}`;
  }
}

document.querySelector('#login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('login', formValues(event.currentTarget));
    csrfToken = result.csrf;
    setAuthenticated(true);
    await loadDashboard();
  } catch (error) {
    showMessage(document.querySelector('#auth-message'), error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#setup-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('setup', formValues(event.currentTarget));
    csrfToken = result.csrf;
    setAuthenticated(true);
    await loadDashboard();
  } catch (error) {
    showMessage(document.querySelector('#auth-message'), error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#ad-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  values.active = form.elements.active.checked;
  values.duration = Number(values.duration);
  try {
    await api('save-ad', { csrf: csrfToken, ...values });
    startNewAd();
    showMessage(document.querySelector('#dashboard-message'), 'Advertisement saved.');
    await loadDashboard();
  } catch (error) {
    showMessage(document.querySelector('#dashboard-message'), error.message, true);
  }
});

document.querySelector('#password-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('change-password', { csrf: csrfToken, ...formValues(event.currentTarget) });
    event.currentTarget.reset();
    showMessage(document.querySelector('#password-message'), 'Password updated.');
  } catch (error) {
    showMessage(document.querySelector('#password-message'), error.message, true);
  }
});

document.querySelector('#logout-button')?.addEventListener('click', async () => {
  try {
    await api('logout', { csrf: csrfToken });
    window.location.reload();
  } catch (error) {
    showMessage(document.querySelector('#dashboard-message'), error.message, true);
  }
});

document.querySelector('#new-ad-button')?.addEventListener('click', () => {
  startNewAd();
  document.querySelector('#ad-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelector('#cancel-edit')?.addEventListener('click', startNewAd);

void initialize();
