(function installCreisRequestHook() {
  'use strict';

  if (window.__CREIS_REQUEST_HOOK_INSTALLED__) return;
  window.__CREIS_REQUEST_HOOK_INSTALLED__ = true;

  let enabled = false;
  const KEYWORDS = /xlsx|excel|spreadsheet|export|download|blob/i;
  const SECRET_KEYS = /cookie|authorization|token|password|secret|session/i;
  const DIRECT_ENDPOINTS = Object.freeze({
    getPeripheryHouseProjectInfo: 'house',
    getlandpointinof: 'land'
  });

  function directType(url) {
    const text = String(url || '');
    const endpoint = Object.keys(DIRECT_ENDPOINTS).find((name) => text.includes(`/${name}`));
    return endpoint ? DIRECT_ENDPOINTS[endpoint] : '';
  }

  function emitDirect(url, data, pageUrl) {
    const analysisType = directType(url);
    if (!analysisType || data == null) return;
    window.postMessage({
      source: 'CREIS_LAND_DOWNLOADER',
      type: 'DIRECT_DATA',
      payload: { analysisType, data, pageUrl: safeUrl(pageUrl || location.href), capturedAt: new Date().toISOString() }
    }, location.origin);
  }

  function safeBody(body) {
    if (body == null) return '';
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        return JSON.stringify(redactObject(parsed)).slice(0, 8000);
      } catch (_) {
        return body.replace(/((?:token|authorization|cookie|password)[^=&:\s]*[=:])([^&\s]+)/ig, '$1[已脱敏]').slice(0, 8000);
      }
    }
    if (body instanceof URLSearchParams) return redactParams(body).toString().slice(0, 8000);
    if (body instanceof FormData) {
      const values = {};
      for (const [key, value] of body.entries()) values[key] = SECRET_KEYS.test(key) ? '[已脱敏]' : String(value).slice(0, 500);
      return JSON.stringify(values).slice(0, 8000);
    }
    return `[${Object.prototype.toString.call(body)}]`;
  }

  function redactObject(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(redactObject);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[已脱敏]' : redactObject(item)]));
  }

  function redactParams(params) {
    const output = new URLSearchParams();
    for (const [key, value] of params.entries()) output.append(key, SECRET_KEYS.test(key) ? '[已脱敏]' : value);
    return output;
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value), location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET_KEYS.test(key)) url.searchParams.set(key, '[已脱敏]');
      }
      return url.href;
    } catch (_) { return String(value || '').slice(0, 4000); }
  }

  function safeQuery(value) {
    try {
      const url = new URL(String(value), location.href);
      return Object.fromEntries([...url.searchParams.entries()].map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[已脱敏]' : item]));
    } catch (_) { return {}; }
  }

  function safeHeaders(value) {
    const output = {};
    try {
      for (const [key, item] of new Headers(value || {}).entries()) {
        output[key] = SECRET_KEYS.test(key) ? '[已脱敏]' : item;
      }
    } catch (_) {}
    return output;
  }

  function emit(record) {
    if (!enabled) return;
    const searchable = `${record.url || ''} ${record.requestBody || ''} ${record.responseContentType || ''}`;
    if (!KEYWORDS.test(searchable)) return;
    window.postMessage({ source: 'CREIS_LAND_DOWNLOADER', type: 'DEBUG_REQUEST', payload: record }, location.origin);
  }

  addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data && event.data.source === 'CREIS_LAND_DOWNLOADER' && event.data.type === 'SET_DEBUG') {
      enabled = Boolean(event.data.enabled);
    }
  });

  const originalFetch = window.fetch;
  window.fetch = async function hookedFetch(input, init) {
    const request = input instanceof Request ? input : null;
    const url = safeUrl(request ? request.url : input);
    const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
    const requestBody = safeBody(init && init.body);
    const requestHeaders = safeHeaders((init && init.headers) || (request && request.headers));
    const startedAt = new Date().toISOString();
    const sourcePageUrl = location.href;
    try {
      const response = await originalFetch.apply(this, arguments);
      if (directType(url)) {
        response.clone().json().then((data) => emitDirect(url, data, sourcePageUrl)).catch(() => {});
      }
      emit({ transport: 'fetch', url, method, query: safeQuery(url), requestHeaders, requestContentType: requestHeaders['content-type'] || '', requestBody, status: response.status, responseContentType: response.headers.get('content-type') || '', startedAt });
      return response;
    } catch (error) {
      emit({ transport: 'fetch', url, method, query: safeQuery(url), requestHeaders, requestContentType: requestHeaders['content-type'] || '', requestBody, error: error.message, startedAt });
      throw error;
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function hookedOpen(method, url) {
    this.__creisMeta = { method: String(method || 'GET').toUpperCase(), url: safeUrl(url), requestHeaders: {}, startedAt: new Date().toISOString(), pageUrl: location.href };
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function hookedSetRequestHeader(name, value) {
    const meta = this.__creisMeta;
    if (meta) meta.requestHeaders[String(name).toLowerCase()] = SECRET_KEYS.test(String(name)) ? '[已脱敏]' : String(value);
    return originalSetRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function hookedSend(body) {
    const xhr = this;
    const meta = xhr.__creisMeta || { method: 'GET', url: '', startedAt: new Date().toISOString() };
    meta.requestBody = safeBody(body);
    xhr.addEventListener('loadend', () => {
      if (directType(meta.url) && xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
          emitDirect(meta.url, data, meta.pageUrl);
        } catch (_) {}
      }
      emit({
        transport: 'xhr',
        url: meta.url,
        method: meta.method,
        query: safeQuery(meta.url),
        requestHeaders: meta.requestHeaders,
        requestContentType: meta.requestHeaders['content-type'] || '',
        requestBody: meta.requestBody,
        status: xhr.status,
        responseType: xhr.responseType || '',
        responseContentType: xhr.getResponseHeader('content-type') || '',
        startedAt: meta.startedAt
      });
    }, { once: true });
    return originalSend.apply(this, arguments);
  };

  window.postMessage({ source: 'CREIS_LAND_DOWNLOADER', type: 'HOOK_READY' }, location.origin);
})();
