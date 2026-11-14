(function () {
  // Older iOS WebKit can ignore the viewport lock for its proprietary pinch gesture.
  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });

  if (/MicroMessenger/i.test(navigator.userAgent) && !document.querySelector('.wechat-browser-guide')) {
    const guide = document.createElement('aside');
    guide.className = 'wechat-browser-guide';
    guide.setAttribute('role', 'alert');
    guide.innerHTML = '<strong>请在浏览器中打开</strong><span>点击右上角菜单，选择「在浏览器打开」；iPhone 请使用 Safari，安卓请使用 Chrome。微信内无法安装到主屏幕。</span>';
    document.body.appendChild(guide);
  }
})();
