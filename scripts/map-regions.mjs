const SPECIAL = new Set(['110000', '120000', '310000', '500000', '710000', '810000', '820000']);
export const codeOf = feature => String(feature.properties?.adcode ?? feature.properties?.code ?? '');

// Province-level collections include both prefectures and directly administered
// counties/cities. Their actual polygons are the selection units: a suffix or
// administrative-level filter would leave holes in the map.
export function selectProvinceRegions(province, collection) {
  const pcode = codeOf(province);
  const regions = SPECIAL.has(pcode) ? [province] : (collection?.features || []).filter(feature => {
    const code = codeOf(feature);
    return /^\d{6}$/.test(code) && code !== pcode;
  });
  if (!regions.length) throw new Error(`No administrative regions for ${pcode}; refusing a province fallback.`);
  const codes = new Set();
  for (const feature of regions) {
    const code = codeOf(feature);
    if (codes.has(code) || !code.startsWith(pcode.slice(0, 2)) || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type) || !feature.geometry.coordinates?.length) {
      throw new Error(`Invalid or duplicate administrative region ${code} for ${pcode}`);
    }
    codes.add(code);
  }
  return regions;
}

export const usesProvinceOutline = code => SPECIAL.has(code);
