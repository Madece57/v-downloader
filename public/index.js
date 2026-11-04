const menuButton = document.querySelector('.nav-toggle');
const navigation = document.querySelector('#nav-links');

function closeNavigation() {
  menuButton?.setAttribute('aria-expanded', 'false');
  menuButton?.setAttribute('aria-label', 'Open navigation');
  navigation?.classList.remove('is-open');
}

menuButton?.addEventListener('click', () => {
  const isExpanded = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isExpanded));
  menuButton.setAttribute('aria-label', isExpanded ? 'Open navigation' : 'Close navigation');
  navigation?.classList.toggle('is-open', !isExpanded);
});

navigation?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', closeNavigation);
});

document.querySelector('#year').textContent = String(new Date().getFullYear());

const themeToggle = document.querySelector('#theme-toggle');
const savedTheme = localStorage.getItem('vd-site-theme');

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle?.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  if (themeToggle) themeToggle.textContent = `${theme === 'dark' ? 'Light' : 'Dark'} theme`;
  localStorage.setItem('vd-site-theme', theme);
}

setTheme(savedTheme === 'light' ? 'light' : 'dark');
themeToggle?.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

const faqSearch = document.querySelector('#faq-search');
const faqItems = [...document.querySelectorAll('.faq-list details')];
const faqStatus = document.querySelector('#faq-search-status');

faqSearch?.addEventListener('input', () => {
  const query = faqSearch.value.trim().toLocaleLowerCase();
  let visibleCount = 0;
  for (const item of faqItems) {
    const matches = !query || item.textContent.toLocaleLowerCase().includes(query);
    item.hidden = !matches;
    if (matches) visibleCount += 1;
  }
  if (faqStatus) {
    faqStatus.textContent = query
      ? `${visibleCount} ${visibleCount === 1 ? 'answer' : 'answers'} found`
      : '';
  }
});
