(() => {
  'use strict';
  if (window.__phantomEarlyLoaded) return;
  window.__phantomEarlyLoaded = true;

  const ps = () => window.__phantomSettings || {};

  // ── 1. Spoof focus/visibility APIs ────────────────────────────────────────
  const _visDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    || Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const _hidDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    || Object.getOwnPropertyDescriptor(document, 'hidden');
  const _realVisibility = _visDesc && _visDesc.get ? _visDesc.get.bind(document) : () => 'visible';
  const _realHidden     = _hidDesc && _hidDesc.get ? _hidDesc.get.bind(document) : () => false;
  const _realHasFocus   = document.hasFocus.bind(document);

  Object.defineProperty(document, 'visibilityState', {
    get: () => ps().focusSpoof ? 'visible' : _realVisibility(),
    configurable: true,
  });
  Object.defineProperty(document, 'hidden', {
    get: () => ps().focusSpoof ? false : _realHidden(),
    configurable: true,
  });
  document.hasFocus = () => ps().focusSpoof ? true : _realHasFocus();

  // ── 2. Spoof fullscreen APIs ───────────────────────────────────────────────
  Object.defineProperty(document, 'fullscreenElement', {
    get: () => ps().fullscreenSpoof ? document.documentElement : null, configurable: true,
  });
  Object.defineProperty(document, 'webkitFullscreenElement', {
    get: () => ps().fullscreenSpoof ? document.documentElement : null, configurable: true,
  });
  Object.defineProperty(document, 'fullscreen', {
    get: () => !!ps().fullscreenSpoof, configurable: true,
  });
  Object.defineProperty(document, 'webkitIsFullScreen', {
    get: () => !!ps().fullscreenSpoof, configurable: true,
  });

  // ── 3. EventSource — drop PrimaryTabChanged when focus spoof is active ────
  const _OrigES = window.EventSource;
  const _nativeOMDesc = Object.getOwnPropertyDescriptor(_OrigES.prototype, 'onmessage');

  function isFocusMsg(text) {
    return text.includes('PrimaryTab') || text.includes('FocusLost') ||
           text.includes('focus_lost') || text.includes('focusLost');
  }

  function patchES(es) {
    const origAEL = es.addEventListener.bind(es);
    es.addEventListener = function (type, handler, opts) {
      origAEL(type, function (event) {
        if (ps().focusSpoof) {
          const text = typeof event.data === 'string' ? event.data : '';
          if (isFocusMsg(text)) return;
        }
        handler.call(this, event);
      }, opts);
    };

    if (_nativeOMDesc && _nativeOMDesc.set) {
      let _userHandler = null;
      Object.defineProperty(es, 'onmessage', {
        get: () => _userHandler,
        set: h => {
          _userHandler = h;
          _nativeOMDesc.set.call(es, h ? function (event) {
            if (ps().focusSpoof) {
              const text = typeof event.data === 'string' ? event.data : '';
              if (isFocusMsg(text)) return;
            }
            h.call(es, event);
          } : null);
        },
        configurable: true,
      });
    }
  }
  window.EventSource = function (url, config) {
    const es = config ? new _OrigES(url, config) : new _OrigES(url);
    patchES(es);
    return es;
  };
  window.EventSource.prototype  = _OrigES.prototype;
  window.EventSource.CONNECTING = 0;
  window.EventSource.OPEN       = 1;
  window.EventSource.CLOSED     = 2;

  // ── 4. XHR intercept — spoof SubmitTaskMonitoringStatus ───────────────────
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__epUrl = typeof url === 'string' ? url : String(url);
    return _origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (ps().focusSpoof && typeof body === 'string'
        && this.__epUrl && this.__epUrl.includes('SubmitTaskMonitoringStatus')) {
      try {
        const parsed = JSON.parse(body);
        const params = parsed.params && parsed.params[0];
        if (params) {
          if (Array.isArray(params.Events)) params.Events = [];
          if (params.StatusUpdate) {
            const su = params.StatusUpdate;
            const forceObjTrue = v =>
              (typeof v === 'object' && v !== null)
                ? Object.fromEntries(Object.keys(v).map(k => [k, true]))
                : v;
            if (su.FocusStatus  !== undefined) su.FocusStatus  = forceObjTrue(su.FocusStatus);
            if (su.ActiveStatus !== undefined) su.ActiveStatus = forceObjTrue(su.ActiveStatus);
            if (su.FullScreenStatus !== undefined) {
              su.FullScreenStatus =
                (typeof su.FullScreenStatus === 'object' && su.FullScreenStatus !== null)
                  ? Object.fromEntries(Object.keys(su.FullScreenStatus).map(k => [k, ps().fullscreenSpoof]))
                  : su.FullScreenStatus;
            }
          }
          body = JSON.stringify(parsed);
        }
      } catch (_) {}
    }
    return _origSend.call(this, body);
  };

  // ── 5. fetch intercept ────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (ps().focusSpoof && url.includes('SubmitTaskMonitoringStatus') && init.body) {
      try {
        const parsed = JSON.parse(init.body);
        const params = parsed.params && parsed.params[0];
        if (params) {
          if (Array.isArray(params.Events)) params.Events = [];
          if (params.StatusUpdate) {
            const su = params.StatusUpdate;
            const forceObjTrue = v =>
              (typeof v === 'object' && v !== null)
                ? Object.fromEntries(Object.keys(v).map(k => [k, true]))
                : v;
            if (su.FocusStatus  !== undefined) su.FocusStatus  = forceObjTrue(su.FocusStatus);
            if (su.ActiveStatus !== undefined) su.ActiveStatus = forceObjTrue(su.ActiveStatus);
            if (su.FullScreenStatus !== undefined) {
              su.FullScreenStatus =
                (typeof su.FullScreenStatus === 'object' && su.FullScreenStatus !== null)
                  ? Object.fromEntries(Object.keys(su.FullScreenStatus).map(k => [k, ps().fullscreenSpoof]))
                  : su.FullScreenStatus;
            }
          }
          init = { ...init, body: JSON.stringify(parsed) };
        }
      } catch (_) {}
    }
    return _origFetch.call(this, input, init);
  };

  // ── 6. Block focus-loss events before EP's handlers see them ─────────────
  // Capture-phase listener registered before EP's Angular code; calling
  // stopImmediatePropagation() prevents the event from descending to any listener
  // below (including EP's document/element-level blur and visibilitychange handlers).
  ['blur', 'visibilitychange', 'focusout', 'pagehide'].forEach(type => {
    window.addEventListener(type, e => {
      if (ps().focusSpoof) e.stopImmediatePropagation();
    }, true);
  });

  // ── 8. sendBeacon — block monitoring pings ───────────────────────────────
  const _origBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url, data) {
    if (ps().focusSpoof && typeof url === 'string' && url.includes('Monitoring')) return true;
    return _origBeacon(url, data);
  };

  // ── 9. DevTools detection bypass ─────────────────────────────────────────
  // EP checks outerWidth/outerHeight delta to detect docked DevTools
  Object.defineProperty(window, 'outerWidth', {
    get: () => window.innerWidth,
    configurable: true,
  });
  Object.defineProperty(window, 'outerHeight', {
    get: () => window.innerHeight,
    configurable: true,
  });
})();
