(function initZipManager(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};
  CREIS.zipManager = {
    async createArchive() {
      throw new Error('ZIP 将在真实导出接口确认后接入本地 JSZip');
    }
  };
})(globalThis);
