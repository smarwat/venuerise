(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var venueId = script.getAttribute('data-venue-id');
  if (!venueId) {
    console.warn('[VenueRise] Missing data-venue-id attribute on widget script.');
    return;
  }

  var APP_URL = 'https://app.venuerise.com';

  // ---- Styles ----
  var style = document.createElement('style');
  style.textContent = [
    '#vr-widget-btn{position:fixed;bottom:24px;right:24px;z-index:99998;width:56px;height:56px;border-radius:50%;background:#1A7FFF;border:none;cursor:pointer;box-shadow:0 4px 24px rgba(26,127,255,0.4);display:flex;align-items:center;justify-content:center;transition:transform 0.2s,box-shadow 0.2s;}',
    '#vr-widget-btn:hover{transform:scale(1.08);box-shadow:0 8px 32px rgba(26,127,255,0.5);}',
    '#vr-widget-btn svg{width:28px;height:28px;fill:white;}',
    '#vr-widget-frame{display:none;position:fixed;bottom:96px;right:24px;z-index:99999;width:380px;height:580px;border:none;border-radius:20px;box-shadow:0 20px 80px rgba(0,0,0,0.5);overflow:hidden;transition:opacity 0.2s,transform 0.2s;opacity:0;transform:translateY(8px) scale(0.98);}',
    '#vr-widget-frame.vr-open{display:block;opacity:1;transform:translateY(0) scale(1);}',
    '@media(max-width:440px){#vr-widget-frame{width:calc(100vw - 32px);height:70vh;right:16px;bottom:88px;}}',
  ].join('');
  document.head.appendChild(style);

  // ---- Button ----
  var btn = document.createElement('button');
  btn.id = 'vr-widget-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
  document.body.appendChild(btn);

  // ---- iFrame ----
  var frame = document.createElement('iframe');
  frame.id = 'vr-widget-frame';
  frame.src = APP_URL + '/widget/' + venueId;
  frame.title = 'VenueRise Chat';
  document.body.appendChild(frame);

  // ---- Toggle ----
  var open = false;
  btn.addEventListener('click', function () {
    open = !open;
    if (open) {
      frame.classList.add('vr-open');
      btn.setAttribute('aria-label', 'Close chat');
    } else {
      frame.classList.remove('vr-open');
      btn.setAttribute('aria-label', 'Open chat');
    }
  });
})();
