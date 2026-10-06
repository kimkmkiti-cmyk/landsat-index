// Landsat 다중분광지수 분석 플랫폼 — 단계별 UI 제어
const $ = id => document.getElementById(id);

const S = {
  scenes: {}, scene: null, mtl: null,
  selected: ['NDVI'], active: 'NDVI',
  grid: null, view: null, res: null,
  bands: {},          // 밴드번호 → Float32Array(반사율)
  stretch: {},        // 밴드번호 → [lo, hi]
  results: {},        // 지수 → { data, lo, hi, min, max, hist }
  th: {},             // 지수 → { th, dir, touched }
  confirmed: {},      // 지수 → { th, dir }
  canvas: {}, overlay: {}
};

// ---------- 지도 ----------
const KOREA = [36.3, 127.8];
function tile(kind) {
  return kind === 'sat'
    ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Esri World Imagery', maxZoom: 19 })
    : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { attribution: '© OpenStreetMap contributors', maxZoom: 19 });
}
function makeMap(id) {
  const m = L.map(id, { zoomSnap: 0.25, attributionControl: id === 'mapR' }).setView(KOREA, 7);
  const base = tile('map').addTo(m);
  L.control.layers({ '일반 지도': base, '위성 지도': tile('sat') }, null, { position: 'topright' }).addTo(m);
  L.control.scale({ imperial: false }).addTo(m);
  return m;
}
const maps = { A: makeMap('mapA'), B: makeMap('mapB'), R: makeMap('mapR') };

// 세 뷰어 화면 동기화
let syncing = false;
Object.values(maps).forEach(m => m.on('move', () => {
  if (syncing) return;
  syncing = true;
  Object.values(maps).forEach(o => { if (o !== m) o.setView(m.getCenter(), m.getZoom(), { animate: false }); });
  syncing = false;
}));

// 결과 영상(overlayPane 400) 위에 행정구역(410), 그 위에 사용자가 그린 영역(420)
maps.R.createPane('adminPane').style.zIndex = 410;
maps.R.createPane('drawPane').style.zIndex = 420;
const drawn = L.featureGroup().addTo(maps.R);

// ---------- 공통 ----------
function setStatus(t) { $('status').textContent = t; }
function stepState(n, state) {
  const el = $('step' + n);
  el.classList.toggle('disabled', state === 'off');
  el.classList.toggle('done', state === 'done');
}
function setProgress(f) {
  $('progress').classList.toggle('hidden', f == null);
  $('progressBar').style.width = ((f || 0) * 100) + '%';
}
async function busy(msg, fn) {
  const el = document.createElement('div');
  el.className = 'busy'; el.textContent = '⏳ ' + msg;
  document.body.appendChild(el);
  await new Promise(r => setTimeout(r, 30));
  try { return await fn(); } finally { el.remove(); }
}
const fmt = (v, d = 3) => Number.isFinite(v) ? v.toFixed(d) : '-';
const km2 = m2 => (m2 / 1e6).toLocaleString('ko-KR', { maximumFractionDigits: 3 });
const ha = m2 => (m2 / 1e4).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const bandLabel = b => `B${b} (${BAND_NAMES[b]})`;
function neededBands() { return [...new Set(S.selected.flatMap(k => INDICES[k].bands))].sort((a, b) => a - b); }

// ---------- 1단계: 폴더 선택 ----------
$('folderInput').addEventListener('change', e => {
  const scenes = scanFiles(e.target.files);
  const ids = Object.keys(scenes);
  if (!ids.length) {
    $('sceneInfo').innerHTML = '⚠️ Landsat 밴드 파일(*_B4.TIF, *_SR_B4.TIF 등)을 찾지 못했습니다.';
    stepState(1, 'on'); stepState(2, 'off');
    return;
  }
  S.scenes = scenes;
  const sel = $('sceneSelect');
  sel.innerHTML = ids.map(id => `<option value="${id}">${scenes[id].date} · ${scenes[id].pathRow} · ${scenes[id].proc || ''}</option>`).join('');
  sel.classList.toggle('hidden', ids.length < 2);
  selectScene(ids[0]);
});
$('sceneSelect').addEventListener('change', e => selectScene(e.target.value));

async function selectScene(id) {
  const sc = S.scenes[id];
  S.scene = sc;
  S.mtl = sc.mtl ? await parseMTL(sc.mtl) : null;
  resetData();
  const bands = Object.keys(sc.bands).map(Number).sort((a, b) => a - b);
  $('sceneInfo').innerHTML =
    `<b>${sc.sat}</b> · ${sc.level === 'L2' ? 'Level-2 지표반사율' : 'Level-1'}<br>` +
    `촬영일 <b>${sc.date}</b> · Path/Row <b>${sc.pathRow}</b><br>` +
    `밴드: ${bands.map(b => 'B' + b).join(', ')}${sc.mtl ? ' · MTL ✓' : ''}`;
  stepState(1, 'done'); stepState(2, 'on');
  setStatus(`${sc.id} 영상을 찾았습니다. 2단계에서 분석할 지수를 선택하세요.`);
  updateSelection();
}

// ---------- 2단계: 지수 선택 ----------
$('indexList').innerHTML = Object.entries(INDICES).map(([k, d]) =>
  `<label title="${d.name}\n${d.formula}"><input type="radio" name="indexChoice" value="${k}" ${S.selected.includes(k) ? 'checked' : ''}> ${k} <span>${d.name}</span></label>`
).join('');
$('indexList').addEventListener('change', () => {
  const on = $('indexList').querySelector('input:checked');   // 지수는 1개만 선택
  S.selected = on ? [on.value] : [];
  updateSelection();
});

function updateSelection() {
  const sel = $('activeIndex');
  sel.innerHTML = S.selected.map(k => `<option value="${k}">${k} — ${INDICES[k].name}</option>`).join('');
  sel.disabled = !S.selected.length;
  if (!S.selected.includes(S.active)) S.active = S.selected[0] || null;
  if (S.active) sel.value = S.active;

  if (!S.scene || !S.selected.length) {
    $('bandInfo').textContent = S.selected.length ? '' : '지수를 1개 이상 선택하세요.';
    stepState(2, S.scene ? 'on' : 'off'); stepState(3, 'off');
    return;
  }
  const need = neededBands();
  const missing = need.filter(b => !S.scene.bands[b]);
  $('bandInfo').innerHTML =
    S.selected.map(k => `<b>${k}</b>: ${INDICES[k].bands.map(bandLabel).join(', ')}`).join('<br>') +
    (missing.length ? `<br>⚠️ 폴더에 없는 밴드: ${missing.map(b => 'B' + b).join(', ')}` : '') +
    (S.grid ? `<br>✅ ${S.grid.w}×${S.grid.h}px · 화소 ${Math.round(S.grid.resX)}m · EPSG:${S.grid.epsg}` : '');
  stepState(2, 'done');
  $('loadBtn').disabled = missing.length > 0;

  // 새로 필요한 밴드가 있거나 아직 계산 안 된 지수가 있으면 이후 단계 갱신
  const loaded = S.view && need.every(b => S.bands[b]);
  const computed = S.selected.every(k => S.results[k]);
  stepState(3, loaded ? 'done' : 'on');
  stepState(4, !loaded ? 'off' : computed ? 'done' : 'on');
  stepState(5, 'off'); stepState(6, 'off');
  showActive();
}

// ---------- 3단계: 밴드 영상 불러오기 ----------
$('resSelect').addEventListener('change', () => { if (Object.keys(S.bands).length) resetData(); updateSelection(); });

$('loadBtn').addEventListener('click', async () => {
  const sc = S.scene, maxDim = +$('resSelect').value;
  const need = neededBands().filter(b => !S.bands[b]);
  $('loadBtn').disabled = true;
  try {
    for (let i = 0; i < need.length; i++) {
      const b = need[i];
      setStatus(`밴드 B${b} 불러오는 중… (${i + 1}/${need.length})`);
      setProgress(i / need.length);
      const { data, grid } = await readBand(sc.bands[b], maxDim, reflectanceScale(b));
      if (S.grid && (grid.w !== S.grid.w || grid.h !== S.grid.h || grid.epsg !== S.grid.epsg)) {
        throw new Error(`B${b}의 격자 크기/좌표계가 다른 밴드와 다릅니다.`);
      }
      S.grid = S.grid || grid;
      S.bands[b] = data;
      S.stretch[b] = percentiles(data, [2, 98]);
    }
    setProgress(1);
    if (!S.view) {
      setStatus('지도 좌표계(웹 메르카토르)로 재투영 중…');
      await new Promise(r => setTimeout(r, 20));
      S.view = buildLUT(S.grid);
      for (const k of ['A', 'B', 'R']) {
        S.canvas[k] = makeCanvas(S.view);
        S.overlay[k] = new CanvasOverlay(S.canvas[k], S.view.bounds, { className: 'raster', opacity: 1 });
      }
      applyOpacity();
      maps.R.fitBounds(S.view.bounds);
    }
    updateSelection();
    setStatus('밴드 영상을 불러왔습니다. 4단계에서 분석을 실행하세요.');
  } catch (err) {
    console.error(err);
    alert('영상을 불러오지 못했습니다.\n' + err.message);
    setStatus('오류: ' + err.message);
  } finally {
    setProgress(null);
    $('loadBtn').disabled = false;
  }
});

// DN → 반사율 변환 계수
function reflectanceScale(b) {
  if (S.scene.level === 'L2') return { mult: 2.75e-5, add: -0.2 };   // Collection 2 Level-2 SR
  const m = S.mtl;
  if (m && m.mult[b] != null && m.add[b] != null) {
    const sin = m.sunElev ? Math.sin(m.sunElev * Math.PI / 180) : 1;  // 태양고도 보정 TOA 반사율
    return { mult: m.mult[b] / sin, add: m.add[b] / sin };
  }
  return { mult: 1e-4, add: 0 }; // MTL 없음: 상대값 (정규화 지수는 영향 적음, SAVI는 근사)
}

// ---------- 4단계: 분석 실행 ----------
$('runBtn').addEventListener('click', () => busy('지수 계산 중…', () => {
  const lines = [];
  for (const k of S.selected) {
    if (!S.results[k]) {
      const d = INDICES[k], A = S.bands[d.bands[0]], B = S.bands[d.bands[1]];
      const out = new Float32Array(A.length);
      for (let i = 0; i < out.length; i++) {
        const v = d.calc(A[i], B[i]);
        out[i] = Number.isFinite(v) ? v : NaN;
      }
      const [min, lo, hi, max] = percentiles(out, [0.5, 2, 98, 99.5]);
      S.results[k] = { data: out, lo, hi, min, max };
      if (!S.th[k]) S.th[k] = { th: INDICES[k].threshold, dir: INDICES[k].dir, touched: false };
    }
    const r = S.results[k];
    lines.push(`<b>${k}</b> 범위 ${fmt(r.min, 2)} ~ ${fmt(r.max, 2)}`);
  }
  $('runInfo').innerHTML = lines.join('<br>');
  stepState(4, 'done'); stepState(5, 'on');
  setStatus('분석 완료. 5단계에서 임계값을 조정해 결과를 분류하세요.');
  showActive();
}));

// ---------- 표시 지수 전환 / 렌더링 ----------
$('activeIndex').addEventListener('change', e => { S.active = e.target.value; showActive(); });

function showOverlay(k, on) {
  const ov = S.overlay[k];
  if (!ov) return;
  if (on && !maps[k].hasLayer(ov)) ov.addTo(maps[k]);
  if (!on && maps[k].hasLayer(ov)) maps[k].removeLayer(ov);
}

function showActive() {
  const k = S.active, d = k && INDICES[k];
  $('titleA').textContent = d ? `${k} 입력 ① — ${bandLabel(d.bands[0])}` : '밴드 A';
  $('titleB').textContent = d ? `${k} 입력 ② — ${bandLabel(d.bands[1])}` : '밴드 B';
  $('titleR').textContent = d ? `${k} 분석 결과 — ${d.formula}` : '분석 결과';

  ['A', 'B'].forEach((p, i) => {
    const b = d && d.bands[i];
    const ok = b && S.bands[b] && S.view;
    if (ok) renderGray(S.canvas[p], S.view, S.bands[b], ...S.stretch[b]);
    showOverlay(p, !!ok);
  });

  const r = k && S.results[k];
  showOverlay('R', !!r);
  $('legend').classList.toggle('hidden', !r);
  if (!r) return;
  syncSlider();
  renderResult();
}

let rafPending = false;
function renderResult() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const k = S.active, r = S.results[k], t = S.th[k];
    if (!r) return;
    const conf = S.confirmed[k];
    const type = conf && $('binaryChk').checked ? 'binary' : (t.touched || conf ? 'threshold' : 'continuous');
    const d = INDICES[k], rgb = `rgb(${d.color.join(',')})`, op = t.dir === 'ge' ? '≥' : '≤';
    const { lo, hi } = renderIndex(S.canvas.R, S.view, r.data, { type, th: t.th, dir: t.dir, lo: r.lo, hi: r.hi, color: d.color });
    $('legendTitle').textContent = type === 'binary'
      ? `${k} ${op} ${t.th.toFixed(2)} 분류 결과`
      : type === 'threshold' ? `${k} ${op} ${t.th.toFixed(2)} (회색 = 제외)` : `${k} 지수값`;
    $('legMin').textContent = type === 'binary' ? '그 외 지역' : lo.toFixed(2);
    $('legMax').textContent = type === 'binary' ? d.target : hi.toFixed(2);
    document.querySelector('.legend-bar').style.background = type === 'binary'
      ? `linear-gradient(to right, #fff 50%, ${rgb} 50%)` : '';
    updateClassInfo();
    drawHistogram();
    updateAdminTable();
  });
}

// ---------- 5단계: 임계값 분류 ----------
function syncSlider() {
  const k = S.active, r = S.results[k], t = S.th[k];
  const sl = $('thSlider');
  sl.min = Math.floor(r.min * 100) / 100;
  sl.max = Math.ceil(r.max * 100) / 100;
  sl.value = t.th;
  $('dirSelect').value = t.dir;
  $('thVal').textContent = t.th.toFixed(2);
  $('binaryChk').disabled = !S.confirmed[k];
  stepState(5, S.confirmed[k] ? 'done' : 'on');
  stepState(6, S.confirmed[k] ? 'on' : 'off');
}

function onThresholdChange() {
  const k = S.active, t = S.th[k];
  t.th = parseFloat($('thSlider').value);
  t.dir = $('dirSelect').value;
  t.touched = true;
  $('thVal').textContent = t.th.toFixed(2);
  const c = S.confirmed[k];
  if (c && (c.th !== t.th || c.dir !== t.dir)) {   // 확정 후 다시 움직이면 미확정 상태로
    delete S.confirmed[k];
    $('binaryChk').checked = false;
    syncSlider();
  }
  renderResult();
}
$('thSlider').addEventListener('input', onThresholdChange);
$('dirSelect').addEventListener('change', onThresholdChange);
$('binaryChk').addEventListener('change', renderResult);

// 결과 영상 투명도
function applyOpacity() {
  const v = +$('opacitySlider').value;
  $('opacityVal').textContent = v + '%';
  if (S.overlay.R) S.overlay.R.setOpacity(v / 100);
}
$('opacitySlider').addEventListener('input', applyOpacity);

$('confirmBtn').addEventListener('click', () => {
  const k = S.active, t = S.th[k];
  t.touched = true;
  S.confirmed[k] = { th: t.th, dir: t.dir };
  $('binaryChk').checked = true;   // 확정 즉시 분류색으로 표시
  syncSlider();
  renderResult();
  setStatus(`${k} 임계값 ${t.dir === 'ge' ? '≥' : '≤'} ${t.th.toFixed(2)} 확정. 6단계에서 영역을 그려 면적을 확인하세요.`);
});

function updateClassInfo() {
  const k = S.active, r = S.results[k], t = S.th[k], conf = S.confirmed[k];
  const { valid, cls } = countClass(r.data, t.th, t.dir);
  const pa = S.grid.resX * S.grid.resY;
  $('classInfo').innerHTML =
    `${conf ? '✅ <b>확정</b>' : '미확정'} · ${INDICES[k].target} 화소 <b>${(cls / valid * 100 || 0).toFixed(1)}%</b><br>` +
    `영상 전체 분류 면적 <b>${km2(cls * pa)} km²</b>`;
}

function drawHistogram() {
  const k = S.active, r = S.results[k], t = S.th[k], cv = $('histCanvas');
  if (!r.hist) r.hist = histogram(r.data, r.min, r.max, 100);
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, h = r.hist;
  const mx = Math.max(...h) || 1, bw = W / h.length;
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < h.length; i++) {
    const v = r.min + (i + 0.5) / h.length * (r.max - r.min);
    const pass = t.dir === 'ge' ? v >= t.th : v <= t.th;
    const ci = Math.round((i / (h.length - 1)) * 255) * 3;
    ctx.fillStyle = pass ? `rgb(${RAMP[ci]},${RAMP[ci + 1]},${RAMP[ci + 2]})` : '#c8ccd2';
    const bh = (h[i] / mx) * (H - 4);
    ctx.fillRect(i * bw, H - bh, Math.ceil(bw), bh);
  }
  const x = (t.th - r.min) / (r.max - r.min) * W;
  ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
}

// ---------- 6단계: 폴리곤 통계 ----------
L.drawLocal.draw.handlers.polygon.tooltip = {
  start: '클릭하여 영역 그리기를 시작하세요.',
  cont: '클릭하여 계속 그리세요.',
  end: '첫 점을 클릭하면 영역이 완성됩니다.'
};
L.drawLocal.draw.handlers.rectangle.tooltip.start = '드래그하여 사각형 영역을 그리세요.';
L.drawLocal.draw.handlers.simpleshape.tooltip.end = '마우스를 놓으면 영역이 완성됩니다.';
let drawer = null;
function startDraw(Handler, msg) {
  if (drawer) drawer.disable();
  drawer = new Handler(maps.R, {
    showArea: false, allowIntersection: false,
    shapeOptions: { color: '#1565c0', weight: 2, fillOpacity: 0.08, pane: 'drawPane' }
  });
  drawer.enable();
  setStatus(msg);
}
$('drawBtn').addEventListener('click', () => startDraw(L.Draw.Polygon, '오른쪽 화면에서 폴리곤을 그리세요. (ESC: 취소)'));
$('rectBtn').addEventListener('click', () => startDraw(L.Draw.Rectangle, '오른쪽 화면에서 드래그하여 사각형을 그리세요. (ESC: 취소)'));
$('clearBtn').addEventListener('click', () => { drawn.clearLayers(); maps.R.closePopup(); });

maps.R.on(L.Draw.Event.CREATED, e => {
  const layer = e.layer;
  lastDrawEnd = Date.now();
  drawn.addLayer(layer);
  layer.bindPopup(() => statsPopup(layer), { maxWidth: 360 });
  layer.openPopup(layer.getBounds().getCenter());
  stepState(6, 'done');
  setStatus('영역 통계를 계산했습니다. 영역을 클릭하면 결과를 다시 볼 수 있습니다.');
});

function statsPopup(layer) {
  const k = S.active, c = S.confirmed[k], r = S.results[k];
  if (!r || !c) return `<div class="stat-popup"><b>${k}</b>의 임계값이 확정되지 않았습니다.<br>5단계에서 임계값을 확정하세요.</div>`;
  const ring = layer.getLatLngs()[0].map(ll => [ll.lng, ll.lat]);
  const st = polygonStats([[ring]], S.grid, r.data, c.th, c.dir);
  const ratio = st.valid ? st.cls / st.valid * 100 : 0;
  return `<div class="stat-popup">
    <h3>📊 ${k} 통계분석 결과</h3>
    <table>
      <tr><td>분류 조건</td><td>${k} ${c.dir === 'ge' ? '≥' : '≤'} ${c.th.toFixed(2)} (${INDICES[k].target})</td></tr>
      <tr><td>지정 영역 면적</td><td>${km2(st.polyArea)} km² (${ha(st.polyArea)} ha)</td></tr>
      <tr><td>영상 유효 면적</td><td>${km2(st.validArea)} km²</td></tr>
      <tr class="hl"><td>분류 영역 면적</td><td>${km2(st.clsArea)} km² (${ha(st.clsArea)} ha)</td></tr>
      <tr><td>분류 비율</td><td>${ratio.toFixed(1)} %</td></tr>
      <tr><td>평균 ${k} (전체 / 분류)</td><td>${fmt(st.mean)} / ${fmt(st.clsMean)}</td></tr>
      <tr><td>화소 수 (분류/유효)</td><td>${st.cls.toLocaleString()} / ${st.valid.toLocaleString()}</td></tr>
      <tr><td>화소 크기</td><td>${S.grid.resX.toFixed(1)} m × ${S.grid.resY.toFixed(1)} m</td></tr>
    </table></div>`;
}

// ---------- 6단계: 행정구역(시·군) 선택 통계 ----------
const ADMIN_STYLE = { color: '#000', weight: 1, fill: true, fillOpacity: 0 };       // 투명 + 검정 테두리
const ADMIN_SEL = { color: '#000', weight: 2, fill: true, fillColor: '#ff8c00', fillOpacity: 0.45 };  // 선택: 반투명 오렌지
let adminLayer = null, lastDrawEnd = 0;
const adminSel = new Map();   // code → layer (선택 순서 유지)

function admPolys(f) {
  const g = f.geometry;
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

$('adminBtn').addEventListener('click', () => {
  const on = !$('adminBtn').classList.contains('active');
  $('adminBtn').classList.toggle('active', on);
  if (on) {
    if (!adminLayer) {
      adminLayer = L.geoJSON(SGG_GEOJSON, {
        pane: 'adminPane', style: ADMIN_STYLE,
        onEachFeature: (f, layer) => {
          layer.bindTooltip(`${f.properties.sido} ${f.properties.sgg}`, { sticky: true });
          layer.on('click', () => toggleAdmin(f, layer));
        }
      });
    }
    adminLayer.addTo(maps.R);
    setStatus('오른쪽 화면에서 시·군을 클릭해 선택하세요. 다시 클릭하면 선택이 해제됩니다.');
  } else {
    clearAdmin();
    maps.R.removeLayer(adminLayer);
  }
});

function toggleAdmin(f, layer) {
  if (Date.now() - lastDrawEnd < 400) return;   // 사각형 드래그를 마친 클릭은 무시
  const code = f.properties.code;
  if (adminSel.has(code)) { adminSel.delete(code); layer.setStyle(ADMIN_STYLE); }
  else { adminSel.set(code, layer); layer.setStyle(ADMIN_SEL); }
  updateAdminTable();
}

function clearAdmin() {
  adminSel.forEach(layer => layer.setStyle(ADMIN_STYLE));
  adminSel.clear();
  updateAdminTable();
}
$('adminClear').addEventListener('click', clearAdmin);

function updateAdminTable() {
  const panel = $('adminPanel');
  panel.classList.toggle('hidden', !adminSel.size);
  if (!adminSel.size) return;
  const k = S.active, c = S.confirmed[k], r = S.results[k];
  if (!r || !c) {
    $('adminTable').innerHTML = `<tr><td>${k || '지수'}의 임계값을 5단계에서 확정하세요.</td></tr>`;
    return;
  }
  const d = INDICES[k];
  $('adminTitle').textContent = `📊 행정구역별 ${k} 분석 (${k} ${c.dir === 'ge' ? '≥' : '≤'} ${c.th.toFixed(2)}, ${d.target})`;
  let tot = { area: 0, valid: 0, cls: 0 }, rows = '';
  for (const layer of adminSel.values()) {
    const p = layer.feature.properties;
    const st = polygonStats(admPolys(layer.feature), S.grid, r.data, c.th, c.dir);
    // 화소 경계 오차로 화소 합이 경계 면적을 살짝 넘는 경우 보정
    st.validArea = Math.min(st.validArea, st.polyArea);
    st.clsArea = Math.min(st.clsArea, st.validArea);
    tot.area += st.polyArea; tot.valid += st.validArea; tot.cls += st.clsArea;
    rows += `<tr><td>${p.sido}</td><td>${p.sgg}</td><td>${km2(st.polyArea)}</td><td>${km2(st.validArea)}</td>` +
      `<td class="hl">${km2(st.clsArea)}</td><td>${st.polyArea ? (st.clsArea / st.polyArea * 100).toFixed(1) : '-'}</td></tr>`;
  }
  $('adminTable').innerHTML =
    `<thead><tr><th>시·도</th><th>시·군·구</th><th>행정구역 면적<br>(km²)</th><th>영상 포함 면적<br>(km²)</th>` +
    `<th>분석 면적<br>(km²)</th><th>분석 비율<br>(%)</th></tr></thead><tbody>${rows}</tbody>` +
    (adminSel.size > 1 ? `<tfoot><tr><td colspan="2">합계 (${adminSel.size}개)</td><td>${km2(tot.area)}</td><td>${km2(tot.valid)}</td>` +
      `<td class="hl">${km2(tot.cls)}</td><td>${(tot.cls / tot.area * 100).toFixed(1)}</td></tr></tfoot>` : '');
  stepState(6, 'done');
}

// ---------- 초기화 ----------
// 불러온 밴드와 분석 결과를 모두 초기화 (영상/해상도 변경 시)
function resetData() {
  ['A', 'B', 'R'].forEach(k => showOverlay(k, false));
  Object.assign(S, { bands: {}, stretch: {}, grid: null, view: null, overlay: {}, canvas: {},
    results: {}, th: {}, confirmed: {} });
  stepState(3, S.scene ? 'on' : 'off');
  stepState(4, 'off'); stepState(5, 'off'); stepState(6, 'off');
  $('runInfo').textContent = ''; $('classInfo').textContent = '';
  drawn.clearLayers();
  clearAdmin();
  $('legend').classList.add('hidden');
}

stepState(1, 'on');
['2', '3', '4', '5', '6'].forEach(n => stepState(n, 'off'));
