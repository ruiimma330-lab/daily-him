/* Wordmark name lives here so it can be swapped in one place. */
(function () {
  const NAME = 'Daily Him';

  function mount(root) {
    (root || document).querySelectorAll('[data-brand]').forEach((el) => {
      el.classList.add('dh-wordmark');
      if (el.hasAttribute('data-brand-bar')) el.classList.add('dh-wordmark--bar');
      const label = el.getAttribute('data-brand-label');
      [...el.childNodes].forEach((node) => {
        if (node.nodeType === 3) node.remove();
      });
      let visual = el.querySelector('.dh-name');
      if (!visual) {
        visual = document.createElement('span');
        visual.className = 'dh-name';
        el.append(visual);
      }
      visual.textContent = NAME;
      if (label) visual.setAttribute('aria-hidden', 'true');
      else visual.removeAttribute('aria-hidden');
      if (label) {
        let sr = el.querySelector('.dh-sr');
        if (!sr) {
          sr = document.createElement('span');
          sr.className = 'dh-sr';
          el.append(sr);
        }
        sr.textContent = label;
      }
    });
    if (!document.title || document.title === 'Idol Chat' || document.title === '选爱豆' || document.title === '백현') {
      document.title = NAME;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount());
  } else {
    mount();
  }
})();
