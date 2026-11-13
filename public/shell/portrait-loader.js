/* Cover photo gate for the picker. The image stays invisible until it has loaded and decoded,
   so a progressive JPEG cannot paint scan by scan. Meanwhile the page shows the same three
   bouncing dots as the shell loading screen. Shared by the browser picker and node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PortraitLoader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function createDots(doc) {
    const dots = doc.createElement('div');
    dots.className = 'dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i += 1) dots.appendChild(doc.createElement('i'));
    return dots;
  }

  function dropDots(dots) {
    if (!dots) return;
    dots.hidden = true;
    if (dots.parentNode) dots.parentNode.removeChild(dots);
  }

  // complete + naturalWidth 0 is a broken file, not a photo we can show.
  function hasPixels(img) {
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }

  /**
   * Hide img until it is fully loaded and decoded, with the three-dot loader on page.
   * Prefers img.decode() when it exists; otherwise the load event, or img.complete when
   * the file is already cached (that load event will not fire again).
   * Resolves true when the full photo is revealed, false on failure or a missing src.
   * Failure removes the loader and leaves the page placeholder in place.
   */
  function attach(page, img, src) {
    const doc = (page && page.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    img.style.opacity = '0';
    img.classList.remove('is-ready');
    img.classList.add('is-pending');
    if (page && page.classList) page.classList.remove('is-portrait-failed');
    try { img.loading = 'eager'; } catch (_) { /* optional hint */ }

    const dots = doc ? createDots(doc) : null;
    if (dots && page) page.appendChild(dots);

    let settled = false;
    function finish(ok) {
      if (settled) return false;
      settled = true;
      img.classList.remove('is-pending');
      if (ok) {
        img.classList.add('is-ready');
        img.style.opacity = '1';
        if (page && page.classList) page.classList.remove('is-portrait-failed');
      } else {
        img.classList.remove('is-ready');
        img.style.opacity = '0';
        if (page && page.classList) page.classList.add('is-portrait-failed');
      }
      dropDots(dots);
      return true;
    }

    const url = src ? String(src) : '';
    if (!url) {
      finish(false);
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const done = (ok) => {
        if (!finish(ok)) return;
        resolve(Boolean(ok));
      };

      // Assign src only after the image is hidden, then ask it to decode.
      img.src = url;

      if (typeof img.decode === 'function') {
        // Call decode after src is set. If it never settles, the error event still ends the loader.
        img.addEventListener('error', () => done(false), { once: true });
        let decoded;
        try { decoded = img.decode(); } catch (_) { done(hasPixels(img)); return; }
        Promise.resolve(decoded)
          .then(() => done(img.naturalWidth > 0))
          .catch(() => done(hasPixels(img)));
        return;
      }

      // Already in memory: load will not fire. Settle now so the dots cannot stick.
      if (img.complete) {
        done(img.naturalWidth > 0);
        return;
      }

      img.addEventListener('load', () => done(img.naturalWidth > 0), { once: true });
      img.addEventListener('error', () => done(false), { once: true });
    });
  }

  return { createDots, attach };
});
