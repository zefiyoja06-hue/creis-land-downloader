(function initScanner(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};
  const config = CREIS.CONFIG;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function uniqueElements(elements) {
    return [...new Set(elements)];
  }

  function queryAll(selectors, scope) {
    const context = scope || document;
    return uniqueElements(selectors.flatMap((selector) => {
      try { return [...context.querySelectorAll(selector)]; }
      catch (error) {
        CREIS.logger.warn('忽略无效候选选择器', selector, error.message);
        return [];
      }
    }));
  }

  function parseDetailUrl(href) {
    try {
      const url = new URL(href, location.href);
      return {
        detailUrl: url.href,
        landId: url.searchParams.get('landId') || '',
        cityId: url.searchParams.get('cityId') || ''
      };
    } catch (error) {
      return { detailUrl: '', landId: '', cityId: '' };
    }
  }

  function findRow(anchor) {
    for (const selector of config.selectors.rowContainers) {
      const row = anchor.closest(selector);
      if (row) return row;
    }
    return anchor.parentElement || anchor;
  }

  function readHeaders(row) {
    const table = row.closest('table');
    if (!table) return [];
    return [...table.querySelectorAll('thead th')].map((cell) => normalizeText(cell.textContent));
  }

  function extractCodeFromRow(row, headers) {
    const cells = [...row.querySelectorAll(':scope > td, :scope > [role="cell"]')];
    const codeHeaderIndex = headers.findIndex((text) => /(?:地块|宗地)?编号/.test(text));
    if (codeHeaderIndex >= 0 && cells[codeHeaderIndex]) {
      const value = normalizeText(cells[codeHeaderIndex].textContent);
      if (value) return value;
    }

    // 无法依赖列序时，从同行短文本中寻找包含“编号/NO.”特征的候选值。
    const candidates = cells
      .map((cell) => normalizeText(cell.textContent))
      .filter((text) => text && text.length <= 80);
    const preferred = candidates.find((text) => /^(?:NO\.?|No\.?|no\.?|[A-Za-z]{1,6}[-.]?)[\w\u4e00-\u9fff.-]*\d[\w\u4e00-\u9fff.-]*$/.test(text));
    return preferred || '';
  }

  function scoreAnchor(anchor, parsed) {
    let score = 0;
    const text = normalizeText(anchor.textContent);
    const href = anchor.getAttribute('href') || '';
    if (parsed.landId) score += 5;
    if (/bidding-detail/i.test(href)) score += 4;
    if (/land-detail/i.test(href)) score += 2;
    if (text.length >= 4) score += 1;
    if (/周边项目|周边土地|下载为表格/.test(text)) score -= 8;
    return score;
  }

  function scanLandList() {
    const anchors = queryAll(config.selectors.detailLinks);
    const seen = new Map();

    for (const anchor of anchors) {
      const parsed = parseDetailUrl(anchor.href || anchor.getAttribute('href'));
      if (!parsed.detailUrl || !parsed.landId) continue;
      const row = findRow(anchor);
      const name = normalizeText(anchor.textContent || anchor.getAttribute('title'));
      if (!name) continue;
      const headers = readHeaders(row);
      const candidate = {
        name,
        code: extractCodeFromRow(row, headers),
        detailUrl: parsed.detailUrl,
        landId: parsed.landId,
        cityId: parsed.cityId,
        _score: scoreAnchor(anchor, parsed)
      };
      const key = `${candidate.landId}|${candidate.cityId}`;
      const previous = seen.get(key);
      if (!previous || candidate._score > previous._score) seen.set(key, candidate);
    }

    const lands = [...seen.values()].map(({ _score, ...land }) => land);
    CREIS.logger.info(`扫描完成，共识别 ${lands.length} 宗地`, lands);
    return lands;
  }

  function collectDiagnostics() {
    const anchors = queryAll(config.selectors.detailLinks).slice(0, 100);
    const buttons = queryAll(config.selectors.buttons)
      .map((element) => normalizeText(element.textContent || element.getAttribute('aria-label')))
      .filter(Boolean)
      .slice(0, 150);
    const rows = uniqueElements(anchors.map(findRow)).slice(0, 30);
    return {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      headers: queryAll(config.selectors.headers).map((el) => normalizeText(el.textContent)).filter(Boolean),
      links: anchors.map((a) => ({ text: normalizeText(a.textContent), href: a.href })),
      rowSamples: rows.map((row) => normalizeText(row.textContent).slice(0, 1000)),
      buttonTexts: [...new Set(buttons)]
    };
  }

  CREIS.scanner = { scanLandList, collectDiagnostics, parseDetailUrl };
})(globalThis);
