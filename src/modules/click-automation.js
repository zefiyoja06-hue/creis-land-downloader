(function initClickAutomation(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};
  const CLICKABLE_SELECTOR = 'button,a,[role="button"],input[type="button"],input[type="submit"],i,svg';
  let calibrationCleanup = null;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  }

  function isEnabled(element) {
    if (!(element instanceof Element)) return false;
    return !element.matches(':disabled,[disabled],[aria-disabled="true"]')
      && !/\bis-disabled\b|\bdisabled\b/i.test(String(element.className || ''));
  }

  function clickableAncestor(element) {
    if (!(element instanceof Element)) return null;
    return element.closest('button,a,[role="button"],input[type="button"],input[type="submit"],[onclick]')
      || element.closest('i,svg')
      || element;
  }

  function elementLabel(element) {
    if (!element) return '';
    return normalizeText([
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-title'),
      element.textContent,
      element.className && String(element.className)
    ].filter(Boolean).join(' '));
  }

  function safeCssEscape(value) {
    if (globalThis.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function buildSelector(element) {
    if (!element || !(element instanceof Element)) return '';
    if (element.id && document.querySelectorAll(`#${safeCssEscape(element.id)}`).length === 1) {
      return `#${safeCssEscape(element.id)}`;
    }
    for (const attribute of ['data-testid', 'aria-label', 'title']) {
      const value = element.getAttribute(attribute);
      if (value) {
        const selector = `${element.tagName.toLowerCase()}[${attribute}="${String(value).replace(/"/g, '\\"')}"]`;
        try { if (document.querySelectorAll(selector).length === 1) return selector; } catch (_) {}
      }
    }
    const parts = [];
    let current = element;
    for (let depth = 0; current && current !== document.body && depth < 5; depth += 1) {
      let part = current.tagName.toLowerCase();
      const stableClasses = [...current.classList].filter((name) => name.length < 50 && !/active|hover|focus|selected|\d{5,}/i.test(name)).slice(0, 2);
      if (stableClasses.length) part += stableClasses.map((name) => `.${safeCssEscape(name)}`).join('');
      const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const selector = parts.join(' > ');
      try { if (document.querySelectorAll(selector).length === 1) return selector; } catch (_) {}
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function triggerClick(element) {
    const target = clickableAncestor(element);
    if (!target || !isVisible(target)) throw new Error('目标按钮当前不可见');
    if (!isEnabled(target)) throw new Error('当前地块的下载按钮不可用');
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target.focus({ preventScroll: true });
    target.click();
    return { tag: target.tagName, label: elementLabel(target).slice(0, 300) };
  }

  function findTextElement(text) {
    const wanted = normalizeText(text);
    const elements = [...document.querySelectorAll('a,button,[role="button"],li,div,span')];
    const exact = elements.filter((element) => isVisible(element) && normalizeText(element.textContent) === wanted);
    return exact.sort((a, b) => a.children.length - b.children.length)[0] || null;
  }

  async function clickSideNavigation(type) {
    const text = type === CREIS.ANALYSIS_TYPE.house
      ? '周边项目'
      : type === CREIS.ANALYSIS_TYPE.land ? '周边土地' : '出让资料';
    const element = await CREIS.automation.waitForElement(() => findTextElement(text), { timeout: CREIS.CONFIG.pageTimeout });
    return triggerClick(element);
  }

  function pointForElement(element, options = {}) {
    const target = clickableAncestor(element);
    if (!target || !isVisible(target)) throw new Error('目标按钮当前不可见');
    if (!isEnabled(target)) throw new Error('目标按钮当前不可用');
    if (options.scroll !== false) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = target.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      label: elementLabel(target).slice(0, 300),
      pageUrl: location.href
    };
  }

  async function locateSideNavigation(type) {
    const text = type === CREIS.ANALYSIS_TYPE.documents ? '出让资料'
      : type === CREIS.ANALYSIS_TYPE.house ? '周边项目' : '周边土地';
    const element = await CREIS.automation.waitForElement(() => findTextElement(text), { timeout: CREIS.CONFIG.buttonTimeout });
    return pointForElement(element);
  }

  async function locateDocumentBatchDownload() {
    const element = await CREIS.automation.waitForElement(() => findTextElement('批量下载'), { timeout: CREIS.CONFIG.pageTimeout });
    const point = pointForElement(element, { scroll: false });
    if (!/批量下载/.test(point.label) || /收藏|对比/.test(point.label)) throw new Error('批量下载按钮标签校验失败');
    return point;
  }

  function validateClickPoint(point, expectedText) {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, label: '', reason: '点击坐标无效' };
    const hit = document.elementFromPoint(x, y);
    const target = clickableAncestor(hit);
    const label = elementLabel(target);
    const expected = String(expectedText || '');
    const ok = Boolean(target && isVisible(target) && isEnabled(target)
      && label.includes(expected) && !/添加收藏|添加对比/.test(label));
    return { ok, label: label.slice(0, 300), tag: target && target.tagName || '', x, y };
  }

  function exportCandidateScore(element, sortRect) {
    if (!isVisible(element)) return -Infinity;
    const target = clickableAncestor(element);
    if (!isEnabled(target)) return -Infinity;
    const rect = target.getBoundingClientRect();
    const label = elementLabel(target);
    let score = 0;
    if (/下载为表格/.test(label)) score += 200;
    if (/下载|download|export/i.test(label)) score += 120;
    if (/icon.*down|down.*icon|arrow.*down/i.test(label)) score += 40;
    if (target.hasAttribute('download')) score += 100;
    if (rect.right > innerWidth * 0.72) score += 15;
    if (rect.width <= 90 && rect.height <= 90) score += 15;
    if (sortRect) {
      const dx = Math.abs((rect.left + rect.width / 2) - sortRect.right);
      const dy = Math.abs((rect.top + rect.height / 2) - (sortRect.top + sortRect.height / 2));
      if (dx < 180 && dy < 80) score += 100 - Math.min(90, dx / 2 + dy);
    }
    if (/详情|显示全部|返回旧版|意见反馈|绘图|测距/.test(label)) score -= 150;
    return score;
  }

  function findExportButton() {
    const directSelectors = [
      '[title*="下载"]', '[aria-label*="下载"]', '[data-title*="下载"]',
      '[class*="download" i]', '[class*="export" i]', 'a[download]'
    ];
    const direct = directSelectors.flatMap((selector) => {
      try { return [...document.querySelectorAll(selector)]; } catch (_) { return []; }
    }).map(clickableAncestor).filter(Boolean);

    const textMatch = findTextElement('下载为表格');
    if (textMatch) direct.push(clickableAncestor(textMatch));

    const sortNode = [...document.querySelectorAll('body *')]
      .find((element) => element.children.length <= 2 && isVisible(element) && normalizeText(element.textContent) === '距离由近及远');
    const sortRect = sortNode ? sortNode.getBoundingClientRect() : null;
    const nearby = [...document.querySelectorAll(CLICKABLE_SELECTOR)].map(clickableAncestor).filter(Boolean);
    const candidates = [...new Set([...direct, ...nearby])]
      .map((element) => ({ element, score: exportCandidateScore(element, sortRect) }))
      .filter((item) => item.score >= 70)
      .sort((a, b) => b.score - a.score);
    if (candidates.length) return candidates[0].element;
    return null;
  }

  async function readSavedTarget() {
    const stored = await chrome.storage.local.get('clickTarget');
    return stored.clickTarget || null;
  }

  async function findSavedTargetElement() {
    const saved = await readSavedTarget();
    if (!saved) return null;
    if (saved.selector) {
      try {
        const bySelector = document.querySelector(saved.selector);
        const label = elementLabel(bySelector);
        const samePage = saved.pagePath === location.pathname;
        if (isVisible(bySelector) && isEnabled(bySelector) && (samePage || /下载|download|export/i.test(label))) return bySelector;
      } catch (_) {}
    }
    if (saved.pagePath && saved.pagePath !== location.pathname) return null;
    const x = Math.max(1, Math.min(innerWidth - 1, saved.xRatio * innerWidth));
    const y = Math.max(1, Math.min(innerHeight - 1, saved.yRatio * innerHeight));
    const byPoint = clickableAncestor(document.elementFromPoint(x, y));
    return isVisible(byPoint) && isEnabled(byPoint) ? byPoint : null;
  }

  async function clickExportButton() {
    let element = await findSavedTargetElement();
    if (!element) {
      try {
        element = await CREIS.automation.waitForElement(findExportButton, { timeout: CREIS.CONFIG.buttonTimeout });
      } catch (_) {}
    }
    if (!element) throw new Error('没有找到下载按钮，请先在插件中标定下载图标');
    const clicked = triggerClick(element);
    return { ...clicked, pageUrl: location.href };
  }

  async function locateExportButton() {
    let element = await findSavedTargetElement();
    if (!element) {
      try {
        element = await CREIS.automation.waitForElement(findExportButton, { timeout: CREIS.CONFIG.buttonTimeout });
      } catch (_) {}
    }
    if (!element) throw new Error('没有找到下载按钮，请重新标定下载图标');
    const target = clickableAncestor(element);
    if (!target || !isVisible(target)) throw new Error('下载按钮当前不可见');
    if (!isEnabled(target)) throw new Error('当前地块的下载按钮不可用');
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) throw new Error('下载按钮尺寸无效');
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      label: elementLabel(target).slice(0, 300),
      pageUrl: location.href
    };
  }

  function showToast(text, kind) {
    const old = document.getElementById('__creis_click_toast__');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.id = '__creis_click_toast__';
    toast.textContent = text;
    Object.assign(toast.style, {
      position: 'fixed', zIndex: '2147483647', top: '18px', left: '50%', transform: 'translateX(-50%)',
      padding: '11px 18px', borderRadius: '7px', color: '#fff', fontSize: '14px', fontWeight: '700',
      background: kind === 'error' ? '#b91c1c' : '#166534', boxShadow: '0 4px 18px rgba(0,0,0,.25)'
    });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 2400);
  }

  function startCalibration() {
    if (calibrationCleanup) calibrationCleanup();
    const banner = document.createElement('div');
    banner.textContent = '请单击右侧“下载为表格”图标进行标定；按 Esc 取消';
    Object.assign(banner.style, {
      position: 'fixed', zIndex: '2147483646', top: '0', left: '0', right: '0', padding: '12px',
      color: '#fff', background: '#4f46e5', textAlign: 'center', fontSize: '15px', fontWeight: '700'
    });
    document.documentElement.appendChild(banner);
    let highlighted = null;

    const onMove = (event) => {
      const target = clickableAncestor(event.target);
      if (highlighted && highlighted !== target) highlighted.style.outline = '';
      highlighted = target;
      if (highlighted) highlighted.style.outline = '3px solid #4f46e5';
    };
    const cleanup = () => {
      removeEventListener('mousemove', onMove, true);
      removeEventListener('click', onClick, true);
      removeEventListener('keydown', onKey, true);
      if (highlighted) highlighted.style.outline = '';
      banner.remove();
      calibrationCleanup = null;
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { cleanup(); showToast('已取消标定', 'error'); }
    };
    const onClick = async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = clickableAncestor(event.target);
      const rect = target.getBoundingClientRect();
      const clickTarget = {
        selector: buildSelector(target),
        xRatio: event.clientX / innerWidth,
        yRatio: event.clientY / innerHeight,
        tag: target.tagName,
        label: elementLabel(target).slice(0, 500),
        pagePath: location.pathname,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        savedAt: new Date().toISOString()
      };
      await chrome.storage.local.set({ clickTarget });
      cleanup();
      showToast('下载按钮位置已保存');
    };
    addEventListener('mousemove', onMove, true);
    addEventListener('click', onClick, true);
    addEventListener('keydown', onKey, true);
    calibrationCleanup = cleanup;
    return { ok: true };
  }

  CREIS.clickAutomation = {
    clickSideNavigation,
    clickExportButton,
    locateExportButton,
    locateSideNavigation,
    locateDocumentBatchDownload,
    validateClickPoint,
    findExportButton,
    startCalibration,
    readSavedTarget
  };
})(globalThis);
