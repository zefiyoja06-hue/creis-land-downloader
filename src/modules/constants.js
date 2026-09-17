(function initConstants(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};

  CREIS.CONFIG = Object.freeze({
    releasePath: '/land/4.0/statistics/release',
    compareHousePath: '/land/4.0/land-detail/analysis-comparehouse',
    compareLandPath: '/land/4.0/land-detail/analysis-compareland',
    concurrency: 1,
    requestDelay: 1200,
    retryCount: 1,
    pageTimeout: 30000,
    navigationTimeout: 30000,
    buttonTimeout: 8000,
    downloadTimeout: 25000,
    debugLogLimit: 200,
    filenameMaxLength: 110,
    selectors: {
      // 候选选择器集中维护；拿到真实 DOM 后只需调整这里和 scanner.js 的评分规则。
      detailLinks: [
        'a[href*="/land/4.0/land-detail/"]',
        'a[href*="landId="]'
      ],
      rowContainers: ['tr', '[role="row"]', 'li', '.list-item', '.table-row'],
      headers: ['thead th', '[role="columnheader"]'],
      buttons: ['button', 'a', '[role="button"]']
    }
  });

  CREIS.MESSAGE = Object.freeze({
    scan: 'SCAN_LANDS',
    diagnostics: 'GET_DIAGNOSTICS',
    openAnalysis: 'OPEN_ANALYSIS',
    getState: 'GET_STATE',
    setDebug: 'SET_DEBUG_MODE',
    debugChanged: 'DEBUG_MODE_CHANGED',
    debugRecord: 'RECORD_DEBUG',
    directData: 'DIRECT_API_DATA',
    clearDebug: 'CLEAR_DEBUG_LOGS',
    injectHook: 'INJECT_PAGE_HOOK',
    startBatch: 'START_CLICK_BATCH',
    cancelBatch: 'CANCEL_CLICK_BATCH',
    retryFailed: 'RETRY_FAILED_TASKS',
    startCapture: 'START_REQUEST_CAPTURE',
    stopCapture: 'STOP_REQUEST_CAPTURE',
    clearCapture: 'CLEAR_REQUEST_CAPTURE',
    trustedClick: 'TRUSTED_EXPORT_CLICK',
    locateSideNav: 'LOCATE_SIDE_NAVIGATION',
    locateDocumentBatch: 'LOCATE_DOCUMENT_BATCH_DOWNLOAD',
    validateClickPoint: 'VALIDATE_CLICK_POINT',
    clickSideNav: 'CLICK_SIDE_NAV',
    clickExport: 'CLICK_EXPORT_BUTTON',
    locateExport: 'LOCATE_EXPORT_BUTTON',
    startCalibration: 'START_CLICK_CALIBRATION',
    getClickTarget: 'GET_CLICK_TARGET'
  });

  CREIS.ANALYSIS_TYPE = Object.freeze({
    house: 'house',
    land: 'land',
    documents: 'documents'
  });
})(globalThis);
