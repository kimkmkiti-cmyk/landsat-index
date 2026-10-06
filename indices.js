// Landsat 8/9 OLI 밴드 정보와 다중분광지수 정의
const BAND_NAMES = {
  1: 'Coastal/Aerosol', 2: 'Blue', 3: 'Green', 4: 'Red',
  5: 'NIR', 6: 'SWIR1', 7: 'SWIR2'
};

// bands[0] = 왼쪽 위 뷰어, bands[1] = 왼쪽 아래 뷰어
// threshold = 분류 기본 임계값, target = 임계값 이상(ge)/이하(le)일 때 분류 대상
const INDICES = {
  NDVI: {
    name: '정규식생지수', bands: [5, 4], formula: '(NIR − Red) / (NIR + Red)',
    calc: (nir, red) => (nir - red) / (nir + red),
    threshold: 0.3, dir: 'ge', target: '식생', color: [26, 152, 80]
  },
  GNDVI: {
    name: '녹색정규식생지수', bands: [5, 3], formula: '(NIR − Green) / (NIR + Green)',
    calc: (nir, green) => (nir - green) / (nir + green),
    threshold: 0.3, dir: 'ge', target: '식생(엽록소)', color: [26, 152, 80]
  },
  SAVI: {
    name: '토양보정식생지수', bands: [5, 4], formula: '1.5 × (NIR − Red) / (NIR + Red + 0.5)',
    calc: (nir, red) => 1.5 * (nir - red) / (nir + red + 0.5),
    threshold: 0.2, dir: 'ge', target: '식생', color: [26, 152, 80]
  },
  NBR: {
    name: '정규탄화지수', bands: [5, 7], formula: '(NIR − SWIR2) / (NIR + SWIR2)',
    calc: (nir, swir2) => (nir - swir2) / (nir + swir2),
    threshold: 0.1, dir: 'le', target: '산불 피해(탄화)지역', color: [215, 25, 28]
  },
  NDWI: {
    name: '정규수분지수', bands: [3, 5], formula: '(Green − NIR) / (Green + NIR)',
    calc: (green, nir) => (green - nir) / (green + nir),
    threshold: 0.0, dir: 'ge', target: '수체', color: [33, 102, 172]
  },
  NDBI: {
    name: '정규시가화지수', bands: [6, 5], formula: '(SWIR1 − NIR) / (SWIR1 + NIR)',
    calc: (swir1, nir) => (swir1 - nir) / (swir1 + nir),
    threshold: 0.0, dir: 'ge', target: '시가지/건물', color: [245, 130, 32]
  }
};

// 빨강(낮은 값) → 노랑 → 녹색(높은 값) 연속 색상표 (RdYlGn)
const RAMP_STOPS = [
  [0.0, [215, 48, 39]],
  [0.2, [252, 141, 89]],
  [0.4, [254, 224, 139]],
  [0.6, [217, 239, 139]],
  [0.8, [145, 207, 96]],
  [1.0, [26, 152, 80]]
];
const RAMP = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < RAMP_STOPS.length - 2 && t > RAMP_STOPS[k + 1][0]) k++;
    const [t0, c0] = RAMP_STOPS[k], [t1, c1] = RAMP_STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
  }
  return lut;
})();
