(function initFilename(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};
  const WINDOWS_RESERVED = /[\\/:*?"<>|]/g;
  const TRAILING_DOTS_SPACES = /[.\s]+$/g;

  function sanitizeFilename(value, maxLength) {
    const limit = maxLength || (CREIS.CONFIG && CREIS.CONFIG.filenameMaxLength) || 110;
    const cleaned = String(value || '')
      .replace(WINDOWS_RESERVED, '_')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(TRAILING_DOTS_SPACES, '');
    return (cleaned || '未命名').slice(0, limit).replace(TRAILING_DOTS_SPACES, '');
  }

  function buildFolderName(land) {
    return sanitizeFilename(`${land.code || '未识别编号'}_${land.name || '未识别地块'}`);
  }

  CREIS.filename = { sanitizeFilename, buildFolderName };
})(globalThis);
