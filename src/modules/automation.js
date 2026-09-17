(function initAutomation(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};

  function findElementByText(text, selectors, scope) {
    const target = String(text || '').trim();
    const context = scope || document;
    const candidates = (selectors || CREIS.CONFIG.selectors.buttons)
      .flatMap((selector) => [...context.querySelectorAll(selector)]);
    return candidates.find((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim().includes(target)) || null;
  }

  function waitForElement(finder, options) {
    const timeout = options && options.timeout || CREIS.CONFIG.pageTimeout;
    return new Promise((resolve, reject) => {
      const immediate = finder();
      if (immediate) return resolve(immediate);

      const observer = new MutationObserver(() => {
        const result = finder();
        if (result) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(result);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待页面元素超时（${timeout}ms）`));
      }, timeout);
    });
  }

  function waitForPageReady(options) {
    const timeout = options && options.timeout || CREIS.CONFIG.pageTimeout;
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`页面加载超时（${timeout}ms）`)), timeout);
      addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  CREIS.automation = { findElementByText, waitForElement, waitForPageReady };
})(globalThis);
