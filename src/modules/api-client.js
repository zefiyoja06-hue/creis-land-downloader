(function initApiClient(root) {
  'use strict';

  const CREIS = root.CREIS = root.CREIS || {};

  // 真实 Request URL、方法和参数确认前保持为空，禁止填入推测接口。
  const API_CONFIG = Object.freeze({ house: null, land: null });

  function buildAnalysisUrl(land, type) {
    if (!land || !land.landId) throw new Error('缺少 landId，无法构造分析页地址');
    if (type === CREIS.ANALYSIS_TYPE.documents) {
      if (!land.detailUrl) throw new Error('缺少地块详情页地址，无法打开出让资料');
      return land.detailUrl;
    }
    const path = type === CREIS.ANALYSIS_TYPE.house
      ? CREIS.CONFIG.compareHousePath
      : CREIS.CONFIG.compareLandPath;
    // 从真实详情页 URL 继承未知但可能必要的查询参数，再替换为分析页路径。
    const url = new URL(land.detailUrl || path, 'https://creis.fang.com');
    url.pathname = path;
    url.searchParams.set('landId', land.landId);
    if (land.cityId) url.searchParams.set('cityId', land.cityId);
    return url.href;
  }

  async function exportHouseData() {
    throw new Error('周边项目真实导出接口尚未配置');
  }

  async function exportLandData() {
    throw new Error('周边土地真实导出接口尚未配置');
  }

  CREIS.apiClient = { API_CONFIG, buildAnalysisUrl, exportHouseData, exportLandData };
})(globalThis);
