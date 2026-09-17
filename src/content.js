(function initContentScript() {
  'use strict';

  const { MESSAGE, logger } = globalThis.CREIS;

  function setDebug(enabled) {
    window.postMessage({ source: 'CREIS_LAND_DOWNLOADER', type: 'SET_DEBUG', enabled: Boolean(enabled) }, location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'CREIS_LAND_DOWNLOADER') return;
    if (data.type === 'HOOK_READY') {
      chrome.runtime.sendMessage({ type: MESSAGE.getState }).then((state) => setDebug(state && state.debugMode)).catch(() => {});
    }
    if (data.type === 'DEBUG_REQUEST') {
      chrome.runtime.sendMessage({ type: MESSAGE.debugRecord, record: data.payload }).catch(() => {});
    }
    if (data.type === 'DIRECT_DATA') {
      chrome.runtime.sendMessage({ type: MESSAGE.directData, payload: data.payload }).catch(() => {});
    }
  });

  // 由 service worker 使用 chrome.scripting 注入 MAIN world，避免受站点 CSP 影响。
  chrome.runtime.sendMessage({ type: MESSAGE.injectHook }).then((response) => {
    if (!response || response.ok === false) logger.error('page-hook.js 注入失败', response && response.error);
    return chrome.runtime.sendMessage({ type: MESSAGE.getState });
  }).then((state) => setDebug(state && state.debugMode)).catch((error) => logger.error('初始化调试 hook 失败', error));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (message.type === MESSAGE.scan) {
        sendResponse({ ok: true, lands: globalThis.CREIS.scanner.scanLandList(), pageTitle: document.title, pageUrl: location.href });
      } else if (message.type === MESSAGE.diagnostics) {
        sendResponse({ ok: true, diagnostics: globalThis.CREIS.scanner.collectDiagnostics() });
      } else if (message.type === MESSAGE.debugChanged) {
        setDebug(message.enabled);
        sendResponse({ ok: true });
      } else if (message.type === MESSAGE.clickSideNav) {
        globalThis.CREIS.clickAutomation.clickSideNavigation(message.analysisType)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      } else if (message.type === MESSAGE.clickExport) {
        globalThis.CREIS.clickAutomation.clickExportButton()
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      } else if (message.type === MESSAGE.locateExport) {
        globalThis.CREIS.clickAutomation.locateExportButton()
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      } else if (message.type === MESSAGE.locateSideNav) {
        globalThis.CREIS.clickAutomation.locateSideNavigation(message.analysisType)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      } else if (message.type === MESSAGE.locateDocumentBatch) {
        globalThis.CREIS.clickAutomation.locateDocumentBatchDownload()
          .then((result) => sendResponse({ ok: true, result }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      } else if (message.type === MESSAGE.validateClickPoint) {
        sendResponse({ ok: true, result: globalThis.CREIS.clickAutomation.validateClickPoint(message.point, message.expectedText) });
      } else if (message.type === MESSAGE.startCalibration) {
        sendResponse(globalThis.CREIS.clickAutomation.startCalibration());
      } else if (message.type === MESSAGE.getClickTarget) {
        globalThis.CREIS.clickAutomation.readSavedTarget()
          .then((target) => sendResponse({ ok: true, target }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }
    } catch (error) {
      logger.error('处理消息失败', error);
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  });
})();
