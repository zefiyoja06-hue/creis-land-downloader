(function initDownloader(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};
  CREIS.downloader = {
    async downloadLandFiles() {
      throw new Error('第一阶段仅完成扫描和接口定位；请先提供两个真实导出请求');
    }
  };
})(globalThis);
