(function () {
  // Older iOS WebKit can ignore the viewport lock for its proprietary pinch gesture.
  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
})();
