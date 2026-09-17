(function initPopup() {
  'use strict';

  const { MESSAGE, ANALYSIS_TYPE } = globalThis.CREIS;
  const state = { activeTab: null, lands: [], selected: new Set(), pollTimer: null };
  const el = (id) => document.getElementById(id);

  function setStatus(message, kind) {
    el('status').textContent = message || '';
    el('status').className = `status ${kind || ''}`;
  }

  async function sendRuntime(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.ok === false) throw new Error(response && response.error || '扩展后台没有返回结果');
    return response;
  }

  async function sendToActiveTab(message) {
    if (!state.activeTab || !state.activeTab.id) throw new Error('没有可用的 CREIS 标签页');
    try {
      const response = await chrome.tabs.sendMessage(state.activeTab.id, message);
      if (!response || response.ok === false) throw new Error(response && response.error || '页面脚本没有响应');
      return response;
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection/i.test(error.message || '')) {
        throw new Error('页面脚本尚未加载。请刷新 CREIS 页面后重试。');
      }
      throw error;
    }
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  function renderLands() {
    el('count').textContent = String(state.lands.length);
    if (!state.lands.length) {
      el('landList').innerHTML = '<div class="empty">未识别到地块，请复制 DOM 诊断后核对页面结构</div>';
      return;
    }
    el('landList').innerHTML = state.lands.map((land, index) => `
      <label class="land-item">
        <input class="land-check" type="checkbox" data-index="${index}" ${state.selected.has(index) ? 'checked' : ''}>
        <span>
          <span class="land-code">${escapeHtml(land.code || '编号待识别')}</span>
          <span class="land-name">${escapeHtml(land.name)}</span>
          <span class="land-meta">landId=${escapeHtml(land.landId)}${land.cityId ? ` · cityId=${escapeHtml(land.cityId)}` : ''}</span>
        </span>
      </label>`).join('');
    document.querySelectorAll('.land-check').forEach((checkbox) => checkbox.addEventListener('change', () => {
      const index = Number(checkbox.dataset.index);
      if (checkbox.checked) state.selected.add(index); else state.selected.delete(index);
      el('selectAll').checked = state.selected.size === state.lands.length;
    }));
  }

  async function scan() {
    setStatus('正在扫描当前页面…');
    const response = await sendToActiveTab({ type: MESSAGE.scan });
    state.lands = response.lands || [];
    state.selected = new Set(state.lands.map((_, index) => index));
    el('pageTitle').textContent = response.pageTitle || state.activeTab.title || '';
    el('pageHint').textContent = response.pageUrl || '';
    renderLands();
    await chrome.storage.local.set({ lastScan: { lands: state.lands, pageTitle: response.pageTitle, pageUrl: response.pageUrl, scannedAt: new Date().toISOString() } });
    setStatus(`扫描完成，共识别 ${state.lands.length} 宗地。`, state.lands.length ? 'success' : 'error');
  }

  function firstSelectedLand() {
    const index = [...state.selected].sort((a, b) => a - b)[0];
    if (index == null) throw new Error('请至少勾选一宗地');
    return state.lands[index];
  }

  async function openSelected(analysisType) {
    const land = firstSelectedLand();
    const response = await sendRuntime({ type: MESSAGE.openAnalysis, land, analysisType });
    setStatus(`已在复用标签页打开：${land.code || land.name}\n${response.url}`, 'success');
  }

  async function copyText(value, successMessage) {
    await navigator.clipboard.writeText(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    setStatus(successMessage, 'success');
  }

  async function refreshDebugState() {
    const backgroundState = await chrome.runtime.sendMessage({ type: MESSAGE.getState });
    el('debugToggle').checked = Boolean(backgroundState.debugMode);
    el('logCount').textContent = String((backgroundState.debugLogs || []).length);
    renderBatch(backgroundState.batchState);
    renderCalibration(backgroundState.clickTarget);
    renderCapture(backgroundState.captureState);
  }

  function selectedLands() {
    return [...state.selected].sort((a, b) => a - b).map((index) => state.lands[index]).filter(Boolean);
  }

  function selectedTypes() {
    const types = [];
    if (el('downloadHouse').checked) types.push(ANALYSIS_TYPE.house);
    if (el('downloadLand').checked) types.push(ANALYSIS_TYPE.land);
    if (el('downloadDocuments').checked) types.push(ANALYSIS_TYPE.documents);
    return types;
  }

  function analysisLabel(type) {
    return type === ANALYSIS_TYPE.house ? '周边项目'
      : type === ANALYSIS_TYPE.land ? '周边土地' : '出让资料';
  }

  function renderBatch(batch) {
    const running = Boolean(batch && batch.status === 'running');
    el('startBatch').disabled = running;
    el('cancelBatch').hidden = !running;
    el('progressCard').hidden = !batch;
    if (!batch) return;
    const tasks = batch.tasks || [];
    const success = tasks.filter((task) => task.status === 'success').length;
    const failed = tasks.filter((task) => task.status === 'failed').length;
    const pending = tasks.filter((task) => task.status === 'pending' || task.status === 'running').length;
    const cancelledTasks = tasks.filter((task) => task.status === 'cancelled');
    const cancelled = cancelledTasks.length;
    const done = success + failed;
    const current = tasks.find((task) => task.id === batch.currentTaskId);
    el('progressText').textContent = `${done} / ${tasks.length}`;
    el('progressBar').style.width = `${tasks.length ? done / tasks.length * 100 : 0}%`;
    el('successCount').textContent = String(success);
    el('failedCount').textContent = String(failed);
    el('pendingCount').textContent = String(pending);
    el('cancelledCount').textContent = String(cancelled);
    el('currentTask').textContent = current
      ? `正在处理：${current.land.code || current.land.name} · ${analysisLabel(current.analysisType)}`
      : batch.status === 'completed' ? '全部下载完成'
        : batch.status === 'completed_with_errors' ? '任务完成，存在失败项目'
          : batch.status === 'cancelled' ? '任务已停止' : '';
    el('retryFailed').hidden = failed === 0 || running;
    const failedTasks = tasks.filter((task) => task.status === 'failed');
    el('failureDetails').hidden = failedTasks.length === 0;
    el('failureDetails').textContent = failedTasks.map((task) =>
      `${task.land.code || task.land.name} · ${analysisLabel(task.analysisType)}\n${task.note || '未知错误'}`
    ).join('\n\n');
  }

  function renderCalibration(target) {
    el('calibrationState').textContent = target
      ? `已标定：${target.label || target.selector || '下载图标'} · ${target.savedAt ? new Date(target.savedAt).toLocaleString() : ''}`
      : '尚未标定；自动识别可直接使用';
  }

  function shortUrl(value) {
    const text = String(value || '');
    return text.length > 95 ? `${text.slice(0, 92)}…` : text;
  }

  function renderCapture(capture) {
    const active = Boolean(capture && capture.active);
    el('stopCapture').hidden = !active;
    el('captureHouse').disabled = active;
    el('captureLand').disabled = active;
    if (!capture) {
      el('captureState').textContent = '尚未捕获';
      el('captureProfiles').textContent = '';
      return;
    }
    el('captureState').textContent = active
      ? `正在捕获${capture.targetType === ANALYSIS_TYPE.house ? '周边项目' : '周边土地'}；已记录 ${(capture.records || []).filter((record) => record.targetType === capture.targetType).length} 条请求`
      : capture.lastMessage || '捕获已结束';
    const profiles = capture.profiles || {};
    const lines = [];
    if (profiles.house) lines.push(`✓ 周边项目（评分 ${profiles.house.score || 0}）\n${shortUrl(profiles.house.url)}`);
    if (profiles.land) lines.push(`✓ 周边土地（评分 ${profiles.land.score || 0}）\n${shortUrl(profiles.land.url)}`);
    el('captureProfiles').textContent = lines.join('\n');
  }

  async function ensureCapturePermission() {
    const permission = { origins: ['https://*.fang.com/*'] };
    const granted = await chrome.permissions.request(permission);
    if (!granted) throw new Error('需要 Fang 域名访问权限才能捕获导出请求');
  }

  async function ensureTrustedClickPermission() {
    const granted = await chrome.permissions.contains({ permissions: ['debugger'] });
    if (!granted) throw new Error('调试权限尚未生效，请在扩展管理页重新加载当前版本');
  }

  async function startCapture(analysisType) {
    await ensureCapturePermission();
    [state.activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const expectedPath = analysisType === ANALYSIS_TYPE.house ? 'analysis-comparehouse' : 'analysis-compareland';
    if (!state.activeTab || !state.activeTab.id || !/^https:\/\/creis\.fang\.com\/land\/4\.0\//i.test(state.activeTab.url || '')) {
      throw new Error('请先打开 CREIS 对应的周边分析页面');
    }
    if (!String(state.activeTab.url || '').includes(expectedPath)) {
      throw new Error(`当前页面与捕获类型不一致，请先打开${analysisType === ANALYSIS_TYPE.house ? '周边项目' : '周边土地'}页面`);
    }
    await sendRuntime({ type: MESSAGE.startCapture, analysisType, tabId: state.activeTab.id, pageUrl: state.activeTab.url });
    await refreshDebugState();
    setStatus(`捕获已开始，请回到网页点击一次${analysisType === ANALYSIS_TYPE.house ? '周边项目' : '周边土地'}下载图标。`, 'success');
  }

  async function initialize() {
    [state.activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isCreis = state.activeTab && /^https:\/\/creis\.fang\.com\/land\/4\.0\//i.test(state.activeTab.url || '');
    el('pageTitle').textContent = state.activeTab && state.activeTab.title || '未找到当前标签页';
    el('pageHint').textContent = state.activeTab && state.activeTab.url || '';
    if (!isCreis) setStatus('请先打开 CREIS 土地版页面，再使用扫描功能。', 'error');
    const stored = await chrome.storage.local.get(['lastScan', 'clickTarget']);
    if (stored.lastScan && Array.isArray(stored.lastScan.lands)) {
      state.lands = stored.lastScan.lands;
      state.selected = new Set(state.lands.map((_, index) => index));
      renderLands();
    }
    renderCalibration(stored.clickTarget);
    await refreshDebugState();
    const isReleasePage = isCreis && /\/land\/4\.0\/statistics\/release(?:[/?#]|$)/i.test(state.activeTab.url || '');
    const scanAge = stored.lastScan && stored.lastScan.scannedAt ? Date.now() - new Date(stored.lastScan.scannedAt).getTime() : Infinity;
    if (isReleasePage && (!stored.lastScan || stored.lastScan.pageUrl !== state.activeTab.url || scanAge > 10 * 60 * 1000)) {
      await scan().catch((error) => setStatus(error.message, 'error'));
    }
    state.pollTimer = setInterval(() => refreshDebugState().catch(() => {}), 800);
  }

  el('scanButton').addEventListener('click', () => scan().catch((error) => setStatus(error.message, 'error')));
  el('selectAll').addEventListener('change', (event) => {
    state.selected = event.target.checked ? new Set(state.lands.map((_, index) => index)) : new Set();
    renderLands();
  });
  el('openHouse').addEventListener('click', () => openSelected(ANALYSIS_TYPE.house).catch((error) => setStatus(error.message, 'error')));
  el('openLand').addEventListener('click', () => openSelected(ANALYSIS_TYPE.land).catch((error) => setStatus(error.message, 'error')));
  el('startBatch').addEventListener('click', async () => {
    try {
      await ensureTrustedClickPermission();
      const lands = selectedLands();
      const types = selectedTypes();
      if (!lands.length) throw new Error('请至少勾选一宗地');
      if (!types.length) throw new Error('请至少勾选一种下载内容');
      await sendRuntime({ type: MESSAGE.startBatch, lands, types });
      await refreshDebugState();
      setStatus(`已启动：${lands.length} 宗地，共 ${lands.length * types.length} 个下载任务。`, 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('cancelBatch').addEventListener('click', async () => {
    try {
      await sendRuntime({ type: MESSAGE.cancelBatch });
      await refreshDebugState();
      setStatus('批量任务已停止。', 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('retryFailed').addEventListener('click', async () => {
    try {
      await sendRuntime({ type: MESSAGE.retryFailed });
      await refreshDebugState();
      setStatus('已重新开始失败项目。', 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('calibrateButton').addEventListener('click', async () => {
    try {
      await sendToActiveTab({ type: MESSAGE.startCalibration });
      setStatus('请回到网页，单击右侧下载图标完成标定。', 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('testClickButton').addEventListener('click', async () => {
    try {
      await ensureTrustedClickPermission();
      [state.activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!state.activeTab || !state.activeTab.id) throw new Error('没有可用的 CREIS 标签页');
      const response = await sendRuntime({ type: MESSAGE.trustedClick, tabId: state.activeTab.id });
      setStatus(`已执行浏览器级点击：${response.result && response.result.label || '下载按钮'}`, 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('captureHouse').addEventListener('click', () => startCapture(ANALYSIS_TYPE.house).catch((error) => setStatus(error.message, 'error')));
  el('captureLand').addEventListener('click', () => startCapture(ANALYSIS_TYPE.land).catch((error) => setStatus(error.message, 'error')));
  el('stopCapture').addEventListener('click', async () => {
    try {
      await sendRuntime({ type: MESSAGE.stopCapture });
      await refreshDebugState();
      setStatus('捕获已结束，并保存了评分最高的候选请求。', 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('copyCapture').addEventListener('click', async () => {
    try {
      const backgroundState = await chrome.runtime.sendMessage({ type: MESSAGE.getState });
      const capture = backgroundState.captureState;
      if (!capture || !capture.profiles || (!capture.profiles.house && !capture.profiles.land)) throw new Error('尚未捕获到可复制的候选请求');
      const exportProfile = (profile) => profile ? {
        url: profile.url || '',
        method: profile.method || 'GET',
        query: profile.query || {},
        requestBody: profile.requestBody || '',
        requestHeaders: profile.requestHeaders || {},
        responseContentType: profile.responseContentType || '',
        contentDisposition: profile.contentDisposition || '',
        statusCode: profile.statusCode || null,
        score: profile.score || 0
      } : null;
      await copyText({
        exportedAt: new Date().toISOString(),
        house: exportProfile(capture.profiles.house),
        land: exportProfile(capture.profiles.land)
      }, '已复制脱敏后的捕获结果。');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('clearCapture').addEventListener('click', async () => {
    try {
      await sendRuntime({ type: MESSAGE.clearCapture });
      await refreshDebugState();
      setStatus('捕获结果已清空。', 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('debugToggle').addEventListener('change', async (event) => {
    try {
      await sendRuntime({ type: MESSAGE.setDebug, enabled: event.target.checked });
      setStatus(event.target.checked ? '调试模式已开启，请人工点击“下载为表格”。' : '调试模式已关闭。', 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('copyLogs').addEventListener('click', async () => {
    try {
      const backgroundState = await chrome.runtime.sendMessage({ type: MESSAGE.getState });
      await copyText(backgroundState.debugLogs || [], '已复制候选请求日志。');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('clearLogs').addEventListener('click', async () => {
    try {
      await sendRuntime({ type: MESSAGE.clearDebug });
      await refreshDebugState();
      setStatus('请求日志已清空。', 'success');
    } catch (error) { setStatus(error.message, 'error'); }
  });
  el('copyDiagnostics').addEventListener('click', async () => {
    try {
      const response = await sendToActiveTab({ type: MESSAGE.diagnostics });
      await copyText(response.diagnostics, '已复制 DOM、链接、href 和按钮文本诊断。');
    } catch (error) { setStatus(error.message, 'error'); }
  });

  initialize().catch((error) => setStatus(error.message, 'error'));
})();
