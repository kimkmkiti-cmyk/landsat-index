// 래스터 입출력, 재투영, 렌더링, 통계 유틸리티

// ---------- 1. 폴더 스캔 ----------
// Landsat Collection 2 파일명: LC08_L2SP_116034_20230415_20230420_02_T1_SR_B4.TIF
function scanFiles(files) {
  const scenes = {};
  const get = id => (scenes[id] = scenes[id] || { id, bands: {}, mtl: null, level: 'L1' });
  for (const f of files) {
    const n = f.name;
    if (/_ST_B\d+\.tiff?$/i.test(n)) continue; // 열적외 지표온도 밴드는 제외
    let m = n.match(/^(.*?)_(SR_)?B(\d{1,2})\.tiff?$/i);
    if (m) {
      const b = +m[3];
      if (b < 1 || b > 7) continue;
      const sc = get(m[1]);
      sc.bands[b] = f;
      if (m[2]) sc.level = 'L2';
      continue;
    }
    m = n.match(/^(.*?)_MTL\.(txt|xml)$/i);
    if (m && (!get(m[1]).mtl || /txt$/i.test(n))) get(m[1]).mtl = f;
  }
  // 밴드가 하나도 없는 항목(MTL만 있는 경우) 제거
  for (const id of Object.keys(scenes)) if (!Object.keys(scenes[id].bands).length) delete scenes[id];
  for (const sc of Object.values(scenes)) Object.assign(sc, parseProductId(sc.id));
  return scenes;
}

function parseProductId(id) {
  const m = id.match(/^(L[CO]0[89])_(\w{4})_(\d{3})(\d{3})_(\d{4})(\d{2})(\d{2})/i);
  if (!m) return { sat: '알 수 없음', date: '-', pathRow: '-' };
  return {
    sat: m[1].toUpperCase().endsWith('9') ? 'Landsat 9' : 'Landsat 8',
    proc: m[2].toUpperCase(),
    pathRow: `${m[3]}/${m[4]}`,
    date: `${m[5]}-${m[6]}-${m[7]}`
  };
}

// MTL(txt/xml)에서 반사율 변환계수와 태양고도각 추출
async function parseMTL(file) {
  const text = await file.text();
  const out = { mult: {}, add: {}, sunElev: null };
  const re = /REFLECTANCE_(MULT|ADD)_BAND_(\d+)\s*(?:=\s*|>)\s*([-\d.Ee+]+)/g;
  let m;
  while ((m = re.exec(text))) out[m[1] === 'MULT' ? 'mult' : 'add'][+m[2]] = parseFloat(m[3]);
  m = text.match(/SUN_ELEVATION\s*(?:=\s*|>)\s*([-\d.Ee+]+)/);
  if (m) out.sunElev = parseFloat(m[1]);
  return out;
}

// ---------- 2. 밴드 읽기 ----------
function utmDef(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  throw new Error(`지원하지 않는 좌표계입니다 (EPSG:${epsg}). Landsat UTM(WGS84) 영상이 필요합니다.`);
}

// maxDim: 긴 변 최대 픽셀 수 (0 = 원본). COG 오버뷰가 있으면 자동으로 활용됨
async function readBand(file, maxDim, scale) {
  const tiff = await GeoTIFF.fromBlob(file);
  const img = await tiff.getImage(0);
  const W = img.getWidth(), H = img.getHeight();
  const [minX, minY, maxX, maxY] = img.getBoundingBox();
  const epsg = img.getGeoKeys().ProjectedCSTypeGeoKey;
  let w = W, h = H;
  if (maxDim && Math.max(W, H) > maxDim) {
    const s = maxDim / Math.max(W, H);
    w = Math.round(W * s); h = Math.round(H * s);
  }
  const dn = await tiff.readRasters({ width: w, height: h, samples: [0], interleave: true, resampleMethod: 'nearest' });

  // DN → 반사율 (DN = 0 은 NoData)
  const data = new Float32Array(w * h);
  const { mult, add } = scale;
  for (let i = 0; i < data.length; i++) {
    const v = dn[i];
    data[i] = v === 0 ? NaN : v * mult + add;
  }
  const grid = {
    w, h, minX, maxY, epsg, def: utmDef(epsg),
    resX: (maxX - minX) / w, resY: (maxY - minY) / h
  };
  return { data, grid };
}

// ---------- 3. 재투영 룩업테이블 (UTM → 웹 메르카토르) ----------
// 출력 캔버스의 각 픽셀이 원본 격자의 어느 픽셀인지를 저장 (-1 = 영상 밖)
function buildLUT(grid, maxOut = 4096) {
  const toLL = proj4(grid.def, 'EPSG:4326');
  const merc = L.CRS.EPSG3857;
  // 영상 외곽선을 촘촘히 샘플링해 메르카토르 범위 계산
  let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
  const N = 40, gw = grid.w * grid.resX, gh = grid.h * grid.resY;
  for (let i = 0; i <= N; i++) {
    for (const [fx, fy] of [[i / N, 0], [i / N, 1], [0, i / N], [1, i / N]]) {
      const [lon, lat] = toLL.forward([grid.minX + fx * gw, grid.maxY - fy * gh]);
      const p = merc.project(L.latLng(lat, lon));
      mx0 = Math.min(mx0, p.x); mx1 = Math.max(mx1, p.x);
      my0 = Math.min(my0, p.y); my1 = Math.max(my1, p.y);
    }
  }
  const aspect = (my1 - my0) / (mx1 - mx0);
  const longSide = Math.min(maxOut, Math.max(grid.w, grid.h));
  const W = aspect <= 1 ? longSide : Math.round(longSide / aspect);
  const H = aspect <= 1 ? Math.round(longSide * aspect) : longSide;

  // 성긴 격자에서만 proj4 계산 후 양선형 보간
  const S = 16, gx = Math.ceil(W / S) + 1, gy = Math.ceil(H / S) + 1;
  const cc = new Float64Array(gx * gy), rr = new Float64Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const x = mx0 + (i * S / W) * (mx1 - mx0);
      const y = my1 - (j * S / H) * (my1 - my0);
      const ll = merc.unproject(L.point(x, y));
      const [ux, uy] = toLL.inverse([ll.lng, ll.lat]);
      cc[j * gx + i] = (ux - grid.minX) / grid.resX;
      rr[j * gx + i] = (grid.maxY - uy) / grid.resY;
    }
  }
  const lut = new Int32Array(W * H);
  for (let y = 0; y < H; y++) {
    const j = Math.floor(y / S), fy = (y - j * S) / S;
    for (let x = 0; x < W; x++) {
      const i = Math.floor(x / S), fx = (x - i * S) / S;
      const a = j * gx + i, b = a + 1, c = a + gx, d = c + 1;
      const col = Math.floor((cc[a] * (1 - fx) + cc[b] * fx) * (1 - fy) + (cc[c] * (1 - fx) + cc[d] * fx) * fy);
      const row = Math.floor((rr[a] * (1 - fx) + rr[b] * fx) * (1 - fy) + (rr[c] * (1 - fx) + rr[d] * fx) * fy);
      lut[y * W + x] = (col >= 0 && col < grid.w && row >= 0 && row < grid.h) ? row * grid.w + col : -1;
    }
  }
  const bounds = L.latLngBounds(merc.unproject(L.point(mx0, my0)), merc.unproject(L.point(mx1, my1)));
  return { lut, W, H, bounds };
}

// ---------- 4. 캔버스 오버레이 (픽셀을 직접 갱신 가능한 ImageOverlay) ----------
const CanvasOverlay = L.ImageOverlay.extend({
  initialize(canvas, bounds, options) {
    this._canvasEl = canvas;
    L.ImageOverlay.prototype.initialize.call(this, '', bounds, options);
  },
  _initImage() {
    const c = this._image = this._canvasEl;
    L.DomUtil.addClass(c, 'leaflet-image-layer');
    if (this._zoomAnimated) L.DomUtil.addClass(c, 'leaflet-zoom-animated');
    if (this.options.className) L.DomUtil.addClass(c, this.options.className);
    c.onselectstart = L.Util.falseFn;
    c.onmousemove = L.Util.falseFn;
  }
});

function makeCanvas(view) {
  const c = document.createElement('canvas');
  c.width = view.W; c.height = view.H;
  c._img = c.getContext('2d').createImageData(view.W, view.H);
  return c;
}

// 밴드 반사율을 회색조로 표시 (2~98% 스트레치)
function renderGray(canvas, view, data, lo, hi) {
  const px = canvas._img.data, lut = view.lut, k = 255 / (hi - lo || 1);
  for (let p = 0, q = 0; p < lut.length; p++, q += 4) {
    const idx = lut[p];
    const v = idx < 0 ? NaN : data[idx];
    if (v !== v) { px[q + 3] = 0; continue; }
    const g = Math.max(0, Math.min(255, (v - lo) * k));
    px[q] = px[q + 1] = px[q + 2] = g; px[q + 3] = 255;
  }
  canvas.getContext('2d').putImageData(canvas._img, 0, 0);
}

// 지수 표시
// mode.type: 'continuous' (lo~hi 연속색) | 'threshold' (임계 통과 픽셀만 연속색) | 'binary' (mode.color / 흰색)
const WHITE = [255, 255, 255];
function renderIndex(canvas, view, data, mode) {
  const px = canvas._img.data, lut = view.lut;
  const { type, th, dir } = mode;
  let lo = mode.lo, hi = mode.hi;
  if (type === 'threshold') { if (dir === 'ge') lo = th; else hi = th; }
  const k = 255 / (hi - lo || 1e-6);
  for (let p = 0, q = 0; p < lut.length; p++, q += 4) {
    const idx = lut[p];
    const v = idx < 0 ? NaN : data[idx];
    if (v !== v) { px[q + 3] = 0; continue; }
    if (type !== 'continuous') {
      const pass = dir === 'ge' ? v >= th : v <= th;
      if (type === 'binary') {   // 분류 지역 = 지수별 색, 나머지 = 흰색
        const c = pass ? mode.color : WHITE;
        px[q] = c[0]; px[q + 1] = c[1]; px[q + 2] = c[2]; px[q + 3] = 255;
        continue;
      }
      if (!pass) { px[q] = px[q + 1] = px[q + 2] = 150; px[q + 3] = 70; continue; }
    }
    const t = Math.max(0, Math.min(255, Math.round((v - lo) * k))) * 3;
    px[q] = RAMP[t]; px[q + 1] = RAMP[t + 1]; px[q + 2] = RAMP[t + 2]; px[q + 3] = 255;
  }
  canvas.getContext('2d').putImageData(canvas._img, 0, 0);
  return { lo, hi };
}

// ---------- 5. 통계 ----------
function percentiles(data, ps) {
  const step = Math.max(1, Math.floor(data.length / 300000));
  const s = [];
  for (let i = 0; i < data.length; i += step) { const v = data[i]; if (v === v && isFinite(v)) s.push(v); }
  if (!s.length) return ps.map(() => 0);
  const arr = Float32Array.from(s).sort();
  return ps.map(p => arr[Math.min(arr.length - 1, Math.floor(p / 100 * arr.length))]);
}

function histogram(data, lo, hi, bins = 100) {
  const h = new Uint32Array(bins), step = Math.max(1, Math.floor(data.length / 500000));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (v !== v || v < lo || v > hi) continue;
    h[Math.min(bins - 1, Math.floor((v - lo) / (hi - lo) * bins))]++;
  }
  return h;
}

function countClass(data, th, dir) {
  let valid = 0, cls = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) continue;
    valid++;
    if (dir === 'ge' ? v >= th : v <= th) cls++;
  }
  return { valid, cls };
}

// 위경도 폴리곤 내부 픽셀 통계 — 원본 UTM 격자에서 스캔라인(짝홀 규칙) 방식으로 계산
// polys: GeoJSON MultiPolygon 좌표 형식 [[외곽링, 구멍링...], ...], 각 링은 [[lon, lat], ...]
function polygonStats(polys, grid, data, th, dir) {
  const fwd = proj4('EPSG:4326', grid.def);
  const ringArea = r => {  // 신발끈 공식 (m²)
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(a) / 2;
  };
  let polyArea = 0;
  const rings = [];
  for (const poly of polys) {
    poly.forEach((ring, n) => {
      const utm = ring.map(p => fwd.forward([p[0], p[1]]));
      polyArea += (n === 0 ? 1 : -1) * ringArea(utm);
      rings.push(utm.map(([x, y]) => [(x - grid.minX) / grid.resX, (grid.maxY - y) / grid.resY]));
    });
  }

  let ymin = Infinity, ymax = -Infinity;
  for (const ring of rings) for (const p of ring) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const r0 = Math.max(0, Math.floor(ymin)), r1 = Math.min(grid.h - 1, Math.ceil(ymax));
  let total = 0, valid = 0, cls = 0, sum = 0, clsSum = 0;
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5, xs = [];
    for (const pts of rings) {
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + (y - yi) / (yj - yi) * (xj - xi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(grid.w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) {
        total++;
        const v = data[r * grid.w + c];
        if (v !== v) continue;
        valid++; sum += v;
        if (dir === 'ge' ? v >= th : v <= th) { cls++; clsSum += v; }
      }
    }
  }
  const pa = grid.resX * grid.resY;
  return {
    polyArea, pixelArea: pa, total, valid, cls,
    validArea: valid * pa, clsArea: cls * pa,
    mean: valid ? sum / valid : NaN, clsMean: cls ? clsSum / cls : NaN
  };
}
