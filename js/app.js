/* =========================================================
 * AMR Capa Simulator PRO — Application Controller
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = global.AMR;
  const { fmt, clamp, downloadBlob, toCSV, stat } = AMR.util;
  const M = AMR.model;
  const A = AMR.analytics;
  const C = AMR.charts;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const STORE_KEY = 'amr_pro_state_v1';
  const SNAP = 20;                                   // 격자 스냅 간격(px)
  const NODE_TOOLS = ['pick', 'drop', 'charge', 'park', 'waypoint'];

  /* ================= State ================= */
  const app = {
    params: M.defaultParams(),
    layout: new M.Layout(),
    sim: null, rend: null, rend3d: null,
    view3D: false, view3DLoading: false,
    running: true, speed: 120, tool: 'select',
    lastFrame: 0, uiTick: 0, slowTick: 0,
    drag: null, dragFrom: null, panning: false, panStart: null,
    snap: true,
    snapshots: {},
    sweepRows: null, sweepSpec: null,
    mc: null, mcRunning: false,
    videoExport: null,
    activeRightPane: 'r-overview'
  };

  /* ================= 헬퍼 ================= */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function clonePickDropMap(mapping) {
    return Object.fromEntries(Object.entries(mapping || {}).map(([pickId, dropIds]) => [
      pickId, Array.isArray(dropIds) ? dropIds.slice() : dropIds
    ]));
  }

  function allowedDropIds(pickId) {
    const drops = app.layout.byType('drop');
    const mapping = app.params.pick_drop_map && typeof app.params.pick_drop_map === 'object'
      ? app.params.pick_drop_map : (app.params.pick_drop_map = {});
    const configured = mapping[pickId];
    const ids = Array.isArray(configured) ? configured : (configured ? [configured] : []);
    const valid = [...new Set(ids.filter((id) => drops.some((drop) => drop.id === id)))].slice(0, 2);
    if (!valid.length && drops.length) valid.push(drops[0].id);
    mapping[pickId] = valid;
    return valid;
  }

  const snapPt = (wp, e) => (app.snap && !(e && e.altKey))
    ? { x: Math.round(wp.x / SNAP) * SNAP, y: Math.round(wp.y / SNAP) * SNAP }
    : { x: wp.x, y: wp.y };

  const cursorFor = (t) => (t === 'pan' ? 'grab' : t === 'select' ? 'default' : 'crosshair');

  /** 저장용 레이아웃 (실행 중 상태 제외) */
  function layoutData() {
    const L = app.layout;
    return {
      name: L.name,
      nodes: L.nodes.map((n) => ({
        id: n.id, type: n.type, x: n.x, y: n.y, name: n.name, priority: n.priority,
        ...(n.type === 'park' ? { parking_capacity: n.parking_capacity } : {})
      })),
      edges: L.edges.map((e) => ({ a: e.a, b: e.b, dir: e.dir, lanes: e.lanes || 1, speedFactor: e.speedFactor || 1 })),
      counters: { ...L.counters }
    };
  }

  /* ================= Toast ================= */
  function toast(msg, type) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0'; el.style.transform = 'translateY(10px)';
      setTimeout(() => el.remove(), 320);
    }, type === 'err' ? 4200 : 2600);
  }

  function resizeRenderers() {
    if (app.rend) app.rend.resize();
    if (app.rend3d) app.rend3d.resize();
  }

  /* ================= Undo / Redo (맵 편집) ================= */
  const hist = { undo: [], redo: [] };

  function snapshotLayout() { return JSON.stringify(layoutData()); }

  function updateHistoryButtons() {
    const u = $('#btnUndo'), r = $('#btnRedo');
    if (u) u.style.opacity = hist.undo.length ? '1' : '.4';
    if (r) r.style.opacity = hist.redo.length ? '1' : '.4';
  }

  /** 맵을 바꾸기 직전에 호출 */
  function pushHistory(snap) {
    hist.undo.push(snap || snapshotLayout());
    if (hist.undo.length > 50) hist.undo.shift();
    hist.redo.length = 0;
    updateHistoryButtons();
  }

  function restoreLayout(json) {
    app.layout.fromJSON(JSON.parse(json));
    app.rend.edgeStart = null; app.drag = null; app.dragFrom = null;
    closeInspector();
    app.sim.graph.rebuild();
    app.sim.reset();
    refreshStations();
    refreshLive();
    refreshAnalytics();
    updateHistoryButtons();
  }

  function undo() {
    if (!hist.undo.length) { toast('되돌릴 작업이 없습니다.', 'warn'); return; }
    hist.redo.push(snapshotLayout());
    restoreLayout(hist.undo.pop());
    toast('↩ 실행 취소');
  }

  function redo() {
    if (!hist.redo.length) { toast('다시 실행할 작업이 없습니다.', 'warn'); return; }
    hist.undo.push(snapshotLayout());
    restoreLayout(hist.redo.pop());
    toast('↪ 다시 실행');
  }

  /* ================= Param UI 생성 ================= */
  function buildParamUI() {
    $$('[data-param]').forEach((host) => {
      const key = host.dataset.param;
      const spec = M.PARAM_MAP[key];
      if (!spec) return;
      host.className = 'param';
      host.innerHTML = `
        <div class="param-head">
          <span class="param-label">${spec.label}</span>
          <span class="param-value" id="pv_${key}"></span>
        </div>
        <div class="param-input">
          <input type="range" id="pr_${key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" aria-label="${spec.label}">
          <input type="number" id="pn_${key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" aria-label="${spec.label} 직접 입력">
        </div>`;
      const rng = $('#pr_' + key), num = $('#pn_' + key);
      rng.addEventListener('input', () => setParam(key, rng.value));
      num.addEventListener('change', () => setParam(key, num.value));
      syncParamUI(key);
    });
  }

  function syncParamUI(key) {
    const spec = M.PARAM_MAP[key];
    if (!spec) return;
    const v = app.params[key];
    const rng = $('#pr_' + key), num = $('#pn_' + key), lbl = $('#pv_' + key);
    if (rng) rng.value = v;
    if (num) num.value = +(+v).toFixed(spec.dec);
    if (lbl) lbl.textContent = `${(+v).toFixed(spec.dec)} ${spec.unit}`.trim();
  }

  function setParam(key, raw, silent) {
    const old = app.params[key];
    const v = M.sanitize(app.params, key, raw);
    syncParamUI(key);
    if (v === old) return;

    if (key === 'reservation_pick_limit') app.params.reservation_pick_limit_customized = true;
    if (key === 'release_interval') {
      if (app.params.release_mode === 'total') app.sim.releaseTimer = 0;
      else {
        app.layout.byType('pick').forEach((pick) => {
          if (pick.release_interval == null) delete app.sim.stationTimers[pick.id];
        });
      }
    }
    if (key === 'pixel_scale') app.sim.graph.invalidateCache();
    if (key === 'fleet') app.sim.resizeFleet(v);
    if (key === 'mtbf' || key === 'mttr') {
      app.sim.robots.forEach((r) => { r.nextFault = app.params.failures ? app.sim.rng.exp(app.params.mtbf * 60) : Infinity; });
    }
    if (!silent) refreshAnalytics();
  }

  /* ================= 초기화 ================= */
  function init() {
    buildParamUI();
    buildPresetSelect();
    buildDispatchSelect();
    buildSweepSelect();

    app.sim = new AMR.Simulation(app.layout, app.params);
    app.rend = new AMR.Renderer($('#simCanvas'), app.sim);
    resizeRenderers();

    const restored = loadState();
    if (!restored) {
      M.PRESETS.grid_factory.build(app.layout);
      app.sim.graph.rebuild();
      app.sim.reset();
    }
    $('#selTraffic').value = app.params.traffic_model;

    bindEvents();
    resizeRenderers();
    app.rend.fitToContent();
    refreshStations();
    refreshAnalytics();
    renderScenarios();
    updateHistoryButtons();
    requestAnimationFrame(loop);
    setInterval(saveState, 12000);
  }

  function buildPresetSelect() {
    const sel = $('#presetSelect');
    sel.innerHTML = Object.entries(M.PRESETS)
      .map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
    sel.value = 'grid_factory';
  }

  function buildDispatchSelect() {
    const sel = $('#selDispatch');
    sel.innerHTML = Object.entries(AMR.dispatch.ALGOS)
      .map(([k, a]) => `<option value="${k}">${a.label}</option>`).join('');
    sel.value = app.params.dispatch_algo;
    updateDispatchDesc();
  }

  function updateDispatchDesc() {
    const a = AMR.dispatch.ALGOS[app.params.dispatch_algo];
    $('#dispatchDesc').innerHTML = a ? `📌 ${a.desc}` : '';
  }

  function buildSweepSelect() {
    const sel = $('#sweepKey');
    const groups = {};
    M.PARAM_SPEC.forEach((s) => { (groups[s.group] = groups[s.group] || []).push(s); });
    const names = { vehicle: '차량', port: '포트', demand: '수요', battery: '배터리', ops: '운영', cost: '비용' };
    sel.innerHTML = Object.entries(groups).map(([g, arr]) =>
      `<optgroup label="${names[g] || g}">` +
      arr.map((s) => `<option value="${s.key}">${s.label} (${s.unit})</option>`).join('') +
      `</optgroup>`).join('');
    sel.value = 'fleet';
    syncSweepRange();
    sel.addEventListener('change', syncSweepRange);
  }

  function syncSweepRange() {
    const spec = M.PARAM_MAP[$('#sweepKey').value];
    if (!spec) return;
    const cur = app.params[spec.key];
    $('#sweepFrom').value = +Math.max(spec.min, cur * 0.4).toFixed(spec.dec);
    $('#sweepTo').value = +Math.min(spec.max, Math.max(cur * 1.8, cur + spec.step * 8)).toFixed(spec.dec);
  }

  /* ================= 메인 루프 ================= */
  function loop(ts) {
    if (!app.lastFrame) app.lastFrame = ts;
    const real = Math.min(0.08, (ts - app.lastFrame) / 1000);
    app.lastFrame = ts;

    if (app.running) {
      const total = real * app.speed;
      // 큰 배속에서도 물리 안정성 유지: 0.25초 이하 서브스텝
      const steps = Math.min(240, Math.ceil(total / 0.25));
      const dt = total / Math.max(1, steps);
      for (let i = 0; i < steps; i++) app.sim.step(dt);
    }

    if (app.view3D && app.rend3d) {
      app.rend3d.draw();
      if (app.videoExport && app.videoExport.recording) app.rend.draw();
    } else {
      app.rend.draw();
    }

    app.uiTick += real;
    if (app.uiTick >= 0.3) { app.uiTick = 0; refreshLive(); }
    app.slowTick += real;
    if (app.slowTick >= 2.2) { app.slowTick = 0; refreshAnalytics(); }

    requestAnimationFrame(loop);
  }

  /* ================= 라이브 갱신 ================= */
  function refreshLive() {
    const sim = app.sim, k = sim.kpi();

    $('#hudTime').textContent = fmt.clock(sim.t);
    $('#hudSpeed').textContent = app.speed + '×';
    $('#hudUph').textContent = Math.round(k.measuredUPH);
    $('#hudActive').textContent = k.working;
    $('#hudCharge').textContent = k.charging;

    $('#stTime').textContent = fmt.clock(sim.t);
    $('#stUph').textContent = Math.round(k.measuredUPH) + ' UPH';
    $('#stService').textContent = k.demandUPH > 0 ? fmt.pct(Math.min(999, k.serviceRate), 0) : '—';
    $('#stService').style.color = k.serviceRate >= 98 ? 'var(--ok)' : k.serviceRate >= 85 ? 'var(--warn)' : 'var(--err)';
    $('#stCycle').textContent = k.avgCycle > 0 ? fmt.n(k.avgCycle, 0) + 's' : '—';
    $('#stUtil').textContent = fmt.pct(k.util, 0);
    $('#stBlock').textContent = fmt.pct(k.blockShare, 1);
    $('#stWip').textContent = fmt.int(k.wip);
    $('#stDone').textContent = `${fmt.int(k.completed)} / ${fmt.int(sim.metrics.released)}`;

    // 배출 카운트다운
    if (sim.releaseCycle > 0 && app.params.auto_release) {
      const rem = Math.max(0, sim.nextReleaseIn || 0);
      $('#txtCountdown').textContent = fmt.n(rem, 1) + ' 초';
      $('#barRelease').style.width = clamp(((sim.releaseCycle - rem) / sim.releaseCycle) * 100, 0, 100) + '%';
    } else {
      $('#txtCountdown').textContent = '정지';
      $('#barRelease').style.width = '0%';
    }

    const pane = app.activeRightPane;
    if (pane === 'r-fleet') renderFleetTable();
    if (pane === 'r-overview') renderPortTable();
    renderJobTable();
  }

  /* ================= 분석 갱신 ================= */
  function refreshAnalytics() {
    const sim = app.sim, p = app.params;
    const k = sim.kpi();
    const demand = sim.demandUPH();
    const limits = sim.portLimits();

    $('#txtDemandUph').textContent = Math.round(demand) + ' UPH';
    $('#txtPickLimit').textContent = `${Math.round(limits.pick)} UPH (${sim.layout.byType('pick').length}포트)`;
    $('#txtDropLimit').textContent = `${Math.round(limits.drop)} UPH (${sim.layout.byType('drop').length}포트)`;

    // 교통 정보
    let laneM = 0;
    sim.layout.edges.forEach((e) => {
      const a = sim.layout.node(e.a), b = sim.layout.node(e.b);
      if (a && b) laneM += sim.graph.pxToM(Math.hypot(a.x - b.x, a.y - b.y)) * (e.lanes || 1);
    });
    const cf = A.congestionFactor(sim, p.fleet);
    $('#txtLaneLen').textContent = fmt.n(laneM, 0) + ' m';
    $('#txtDensity').textContent = laneM > 0 ? fmt.n(p.fleet / (laneM / 100), 2) + ' 대/100m' : '—';
    $('#txtCongFactor').textContent = fmt.pct(cf * 100, 0);
    $('#txtCongFactor').style.color = cf > 0.8 ? 'var(--ok)' : cf > 0.6 ? 'var(--warn)' : 'var(--err)';

    const diag = A.diagnose(sim);
    const curveData = A.throughputCurve(sim, Math.max(p.fleet + 8, 22));
    const req = diag.req;

    /* --- KPI Hero --- */
    const reqN = isFinite(req.n) ? req.n : null;
    $('#kpiReqFleet').innerHTML = reqN ? `${reqN} <small>대</small>` : `— <small>불가</small>`;
    const curPt = curveData.curve.find((c) => c.n === Math.round(p.fleet));
    $('#kpiReqSub').innerHTML = reqN
      ? `현재 <b>${p.fleet}대</b> · 예측 처리량 <b>${Math.round(curPt ? curPt.uph : 0)} UPH</b> / 수요 <b>${Math.round(demand)} UPH</b>`
      : `포트/통로 물리 한계로 달성 불가 — 레이아웃 개선 필요`;

    $('#kpiCycle').textContent = k.avgCycle > 0 ? fmt.n(k.avgCycle, 0) + 's' : (curPt ? fmt.n(curPt.cycle, 0) + 's' : '—');
    $('#kpiCycleSub').textContent = k.avgCycle > 0 ? `실측 ${sim.cycleSamples.length}회 운행` : '해석 모델 추정';
    $('#kpiP90').textContent = k.p90Cycle > 0 ? fmt.n(k.p90Cycle, 0) + 's' : '—';
    $('#kpiQueue').textContent = fmt.pct(k.queueShare, 1);
    $('#kpiBlock').textContent = fmt.pct(k.blockShare, 1);
    $('#kpiService').textContent = demand > 0 ? fmt.pct(Math.min(999, k.serviceRate), 0) : '—';
    $('#kpiService').style.color = k.serviceRate >= 98 ? 'var(--ok)' : k.serviceRate >= 85 ? 'var(--warn)' : 'var(--err)';
    $('#kpiServiceSub').textContent = `실측 ${Math.round(k.measuredUPH)} / 수요 ${Math.round(demand)}`;
    $('#kpiLoaded').textContent = fmt.pct(k.loadedShare, 0);

    /* --- 진단 --- */
    const icons = { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '🚨' };
    $('#diagList').innerHTML = diag.items.map((d) =>
      `<div class="diag-item ${d.level}"><span class="ic">${icons[d.level]}</span>
       <span><span class="tt">${d.title}</span><span class="ms">${d.msg}</span></span></div>`).join('');

    /* --- 에너지 진단 --- */
    const cm = curveData.model;
    if (cm.ok) {
      const chargeDuty = cm.chargeSec / (cm.cyclesPerCharge * cm.tCycle + cm.chargeSec);
      $('#energyDiag').innerHTML = `
        <div class="row between"><span>사이클당 소비</span><b>${fmt.n(cm.whPerCycle, 1)} Wh</b></div>
        <div class="row between"><span>1회 충전 당 처리 가능</span><b>${fmt.n(cm.cyclesPerCharge, 0)} 사이클</b></div>
        <div class="row between"><span>1회 충전 소요시간</span><b>${fmt.dur(cm.chargeSec)}</b></div>
        <div class="row between"><span>충전 점유율 (Duty)</span><b style="color:${chargeDuty > 0.25 ? 'var(--err)' : 'var(--ok)'}">${fmt.pct(chargeDuty * 100, 1)}</b></div>
        <div class="row between"><span>동시 충전 수요</span><b>${Math.ceil(p.fleet * chargeDuty * 1.25)} 대 / 슬롯 ${sim.layout.byType('charge').length * p.port_cap}</b></div>
        <div class="row between"><span>실측 평균 SoC</span><b>${fmt.pct(k.avgSoc, 0)}</b></div>
        <div class="row between"><span>건당 에너지</span><b>${k.energyPerTask > 0 ? fmt.n(k.energyPerTask, 1) + ' Wh' : '—'}</b></div>`;
    } else {
      $('#energyDiag').textContent = '피킹↔드롭 경로가 연결되면 계산됩니다.';
    }

    /* --- 비용 요약 --- */
    const eco = A.economics(sim, null, curveData.curve);
    $('#costQuick').innerHTML = `
      <div class="row between"><span>CAPEX (${p.fleet}대)</span><b>${fmt.int(eco.capex)} 만원</b></div>
      <div class="row between"><span>연간 순절감</span><b style="color:${eco.netSaveY > 0 ? 'var(--ok)' : 'var(--err)'}">${fmt.int(eco.netSaveY)} 만원</b></div>
      <div class="row between"><span>회수기간</span><b>${isFinite(eco.paybackY) ? fmt.n(eco.paybackY, 2) + ' 년' : '회수 불가'}</b></div>`;

    /* --- 보이는 탭만 갱신 --- */
    const pane = app.activeRightPane;
    const studio = $('#studioModal').classList.contains('open');
    if (pane === 'r-matrix' || studio) renderMatrix();
    renderCurve(curveData, demand, reqN);
    if (pane === 'r-eco') renderEco();
    if (pane === 'r-overview') renderPortTable();
    if (pane === 'r-fleet' || studio) renderFleetTable();

    if (pane === 'r-overview') {
      C.curveChart('chartMini', curveData.curve, demand, Math.round(p.fleet), reqN);
      C.timeChart('chartTime', sim);
    }
    if (pane === 'r-fleet') C.stateChart('chartState', sim);
  }

  /* ================= 거리 매트릭스 ================= */
  function renderMatrix() {
    const sim = app.sim, p = app.params;
    const rows = sim.graph.matrix();
    const okRows = rows.filter((r) => r.ok);
    const avg = okRows.length ? stat.mean(okRows.map((r) => r.distM)) : 0;
    const mn = okRows.length ? Math.min(...okRows.map((r) => r.distM)) : 0;
    const mx = okRows.length ? Math.max(...okRows.map((r) => r.distM)) : 0;

    $('#matrixChips').innerHTML = `
      <span class="chip">피킹 <b>${sim.layout.byType('pick').length}</b></span>
      <span class="chip">드롭 <b>${sim.layout.byType('drop').length}</b></span>
      <span class="chip">링크 <b>${rows.length}</b></span>
      <span class="chip ok">평균 <b>${fmt.n(avg, 1)}m</b></span>
      <span class="chip">최단 <b>${fmt.n(mn, 1)}m</b></span>
      <span class="chip warn">최장 <b>${fmt.n(mx, 1)}m</b></span>
      ${rows.length - okRows.length > 0 ? `<span class="chip err">단절 <b>${rows.length - okRows.length}</b></span>` : ''}`;
    $('#matrixSummary').textContent =
      `${rows.length}개 구간 · 평균 ${fmt.n(avg, 1)}m · 축척 100px = ${p.pixel_scale}m`;

    $('#mxAcc').textContent = p.accel + ' m/s²';
    $('#mxVel').textContent = p.v_max + ' m/s';
    $('#mxDec').textContent = p.decel + ' m/s²';
    $('#mxTurn').textContent = p.turn_speed + ' °/s';

    // 행별 시간 계산은 한 번만
    rows.forEach((r) => {
      r.tF = r.ok ? sim.graph.pathTime(r.path, p) : 0;
      r.cycle = r.ok
        ? r.tF + sim.graph.pathTime(sim.graph.findPath(r.to.id, r.from.id).path, p) + p.t_pick + p.t_drop
        : 0;
    });

    const cells = (r) => `
        <td class="strong" style="color:var(--ok)">${esc(r.from.name)}</td>
        <td class="strong" style="color:var(--accent)">${esc(r.to.name)}</td>
        <td class="num strong">${isFinite(r.distM) ? fmt.n(r.distM, 1) + 'm' : '—'}</td>
        <td class="num">${isFinite(r.backM) ? fmt.n(r.backM, 1) + 'm' : '—'}</td>
        <td class="num">${r.ok ? fmt.n(r.tF, 1) + 's' : '—'}</td>
        <td class="num">${r.ok ? fmt.n(r.cycle, 1) + 's' : '—'}</td>
        <td class="num">${fmt.n(r.turns, 0)}°</td>`;
    const status = (r) => (r.ok ? '<span class="badge green">연결</span>' : '<span class="badge red">단절</span>');

    $('#matrixTable').innerHTML = rows.map((r) => `<tr>${cells(r)}<td>${status(r)}</td></tr>`).join('')
      || '<tr><td colspan="8" class="empty-row">피킹/드롭 스테이션을 배치하세요</td></tr>';

    $('#studioMatrix').innerHTML = rows.map((r) => `<tr>${cells(r)}
        <td class="tiny muted">${r.ok ? r.path.join(' → ') : '경로 없음'}</td>
        <td>${status(r)}</td></tr>`).join('')
      || '<tr><td colspan="9" class="empty-row">데이터 없음</td></tr>';

    app._matrixRows = rows;
  }

  /* ================= 감도 곡선 ================= */
  function renderCurve(data, demand, reqN) {
    const { curve, limits } = data;
    const p = app.params;
    const hard = Math.min(limits.pick, limits.drop);

    $('#curveTable').innerHTML = curve.map((c) => {
      const cur = c.n === Math.round(p.fleet);
      const bn = c.bottleneck;
      const badge = bn === 'AMR 대수' ? 'blue' : bn.includes('포트') ? 'amber' : bn.includes('혼잡') ? 'red' : 'gray';
      return `<tr class="${cur ? 'hl' : ''}">
        <td class="strong">${c.n}대${cur ? ' <span class="badge purple">현재</span>' : ''}${c.n === reqN ? ' <span class="badge green">권장</span>' : ''}</td>
        <td class="num strong" style="color:var(--accent)">${Math.round(c.uph)}</td>
        <td class="num">${fmt.n(c.cycle, 0)}s</td>
        <td class="num" style="color:${c.wait > 20 ? 'var(--err)' : 'var(--text-dim)'}">${fmt.n(c.wait, 1)}s</td>
        <td class="num" style="color:${c.factor < 0.7 ? 'var(--err)' : c.factor < 0.85 ? 'var(--warn)' : 'var(--ok)'}">${fmt.pct(c.factor * 100, 0)}</td>
        <td><span class="badge ${badge}">${bn}</span></td>
      </tr>`;
    }).join('');

    $('#studioCurve').innerHTML = curve.map((c) => {
      const cur = c.n === Math.round(p.fleet);
      return `<tr class="${cur ? 'hl' : ''}">
        <td class="strong">${c.n}대</td>
        <td class="num strong">${Math.round(c.uph)} UPH</td>
        <td class="num">${fmt.n(c.cycle, 1)}s</td>
        <td class="num">${fmt.n(c.wait, 1)}s</td>
        <td class="num">${fmt.pct(c.factor * 100, 0)}</td>
        <td>${c.bottleneck}</td>
        <td class="num">${hard > 0 ? fmt.pct((c.uph / hard) * 100, 0) : '—'}</td>
      </tr>`;
    }).join('');

    // 한계 효용 분석
    let kneeN = null;
    const firstGain = curve[1] ? curve[1].uph - curve[0].uph : 0;
    for (let i = 1; i < curve.length && !kneeN; i++) {
      const gain = curve[i].uph - curve[i - 1].uph;
      if (firstGain > 0 && gain / firstGain < 0.35) kneeN = curve[i].n;
    }
    $('#curveInsight').innerHTML =
      `📌 <b>한계 효용 변곡점: ${kneeN ? kneeN + '대' : '미도달'}</b> — 이 지점을 넘으면 1대 추가당 처리량 증가가 초기 대비 35% 미만으로 떨어집니다. ` +
      `포트 물리 한계는 <b>${Math.round(hard)} UPH</b>(${limits.pick <= limits.drop ? '피킹' : '드롭'} 측)이며, ` +
      `현재 수요 <b>${Math.round(demand)} UPH</b>는 한계의 <b>${hard > 0 ? fmt.pct((demand / hard) * 100, 0) : '—'}</b> 수준입니다.` +
      (p.payload > 1 ? ` <br>※ Payload ${p.payload}개 기준 예측은 <b>항상 가득 싣는다</b>는 상한 가정입니다. 실측은 묶을 화물이 모자라면 이보다 낮습니다.` : '');

    if (app.activeRightPane === 'r-curve') C.curveChart('chartCurve', curve, demand, Math.round(p.fleet), reqN);
    if ($('#studioModal').classList.contains('open')) C.curveChart('chartCurveBig', curve, demand, Math.round(p.fleet), reqN);

    app._curve = curve;
    app._limits = limits;
  }

  /* ================= 경제성 ================= */
  function renderEco() {
    const sim = app.sim, p = app.params;
    const maxN = Math.max(12, Math.round(p.fleet) + 6);
    const { curve } = A.throughputCurve(sim, maxN + 2);   // 곡선은 한 번만 계산
    const eco = A.economics(sim, null, curve);

    $('#ecoPayback').innerHTML = isFinite(eco.paybackY)
      ? `${fmt.n(eco.paybackY, 2)} <small>년</small>`
      : `— <small>회수 불가</small>`;
    $('#ecoPaybackSub').innerHTML = isFinite(eco.paybackY)
      ? `${p.fleet}대 투입 시 CAPEX <b>${fmt.int(eco.capex)}만원</b>을 연간 순절감 <b>${fmt.int(eco.netSaveY)}만원</b>으로 회수`
      : `연간 운영비가 인력 대체 효과를 초과합니다. 처리량 또는 인건비 가정을 확인하세요.`;

    $('#ecoCapex').textContent = fmt.int(eco.capex) + ' 만원';
    $('#ecoOpex').textContent = fmt.int(eco.opexY) + ' 만원';
    $('#ecoSave').textContent = fmt.int(eco.netSaveY) + ' 만원';
    $('#ecoSave').style.color = eco.netSaveY > 0 ? 'var(--ok)' : 'var(--err)';
    $('#ecoRoi').textContent = fmt.int(eco.roi5) + ' 만원';
    $('#ecoRoi').style.color = eco.roi5 > 0 ? 'var(--ok)' : 'var(--err)';
    $('#ecoCpt').textContent = fmt.int(eco.costPerTask) + ' 원';
    $('#ecoLabor').textContent = eco.laborEquivalent + ' 명';

    const rows = [];
    for (let n = 1; n <= maxN; n++) rows.push(A.economics(sim, n, curve));
    $('#ecoTable').innerHTML = rows.map((r) => `
      <tr class="${r.fleet === Math.round(p.fleet) ? 'hl' : ''}">
        <td class="strong">${r.fleet}대</td>
        <td class="num">${Math.round(r.uph)}</td>
        <td class="num">${fmt.int(r.capex)}</td>
        <td class="num" style="color:${r.netSaveY > 0 ? 'var(--ok)' : 'var(--err)'}">${fmt.int(r.netSaveY)}</td>
        <td class="num">${isFinite(r.paybackY) ? fmt.n(r.paybackY, 2) + '년' : '—'}</td>
        <td class="num strong">${fmt.int(r.costPerTask)}원</td>
      </tr>`).join('');

    const best = rows.filter((r) => isFinite(r.paybackY)).sort((a, b) => a.costPerTask - b.costPerTask)[0];
    $('#ecoInsight').innerHTML = best
      ? `💡 <b>건당 처리원가 최소 구성: ${best.fleet}대</b> (${fmt.int(best.costPerTask)}원/건, 회수 ${fmt.n(best.paybackY, 2)}년). ` +
        `현재 ${p.fleet}대 대비 ${best.fleet === Math.round(p.fleet) ? '<b>이미 최적</b>입니다.' :
        `건당 <b>${fmt.int(Math.abs(eco.costPerTask - best.costPerTask))}원</b> 차이가 발생합니다.`}`
      : `💡 현재 가정에서는 투자 회수가 성립하지 않습니다. 처리량·인건비 입력값을 점검하세요.`;

    C.ecoChart('chartEco', rows);
  }

  /* ================= 테이블들 ================= */
  function renderPortTable() {
    const L = app.sim.layout;
    const ns = [...L.byType('pick'), ...L.byType('drop'), ...L.byType('charge')];
    $('#portTable').innerHTML = ns.map((n) => {
      const t = n.type === 'pick' ? 'green' : n.type === 'drop' ? 'amber' : 'red';
      return `<tr>
        <td><span class="badge ${t}">${M.NODE_TYPES[n.type].label}</span> <b>${esc(n.name)}</b></td>
        <td class="num" style="color:${n.buffer > 6 ? 'var(--err)' : 'inherit'}">${n.buffer}</td>
        <td class="num">${n.processed}</td>
        <td class="num">${n.occupants.length}/${app.params.port_cap}${n.queue ? ` <span style="color:var(--warn)">+${n.queue}</span>` : ''}</td>
        <td class="num">${fmt.n(n.waitAccum / 60, 1)}분</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="empty-row">스테이션 없음</td></tr>';
  }

  function renderFleetTable() {
    const sim = app.sim, p = app.params, k = sim.kpi();
    const snaps = sim.snapshotRobots();

    $('#fleetChips').innerHTML = `
      <span class="chip">총 <b>${k.fleet}대</b></span>
      <span class="chip ok">가동 <b>${k.working}</b></span>
      <span class="chip warn">충전 <b>${k.charging}</b></span>
      ${k.faulted ? `<span class="chip err">고장 <b>${k.faulted}</b></span>` : ''}
      <span class="chip">가동률 <b>${fmt.pct(k.util, 0)}</b></span>
      <span class="chip">평균 SoC <b>${fmt.pct(k.avgSoc, 0)}</b></span>
      <span class="chip">총 주행 <b>${fmt.n(k.distanceM / 1000, 1)}km</b></span>`;

    const socBar = (s) => {
      const col = s <= p.bat_min ? 'var(--err)' : s >= p.bat_max ? 'var(--ok)' : 'var(--warn)';
      return `<div class="bar bar-inline"><span style="width:${clamp(s, 0, 100)}%;background:${col}"></span></div><b style="color:${col}">${Math.round(s)}%</b>`;
    };

    $('#fleetTable').innerHTML = snaps.map((r) => `
      <tr>
        <td class="strong">${r.id.replace('AMR-', 'R')}</td>
        <td class="nowrap" style="font-size:10.5px">${r.label}</td>
        <td class="nowrap">${socBar(r.soc)}</td>
        <td class="num">${fmt.pct(r.util, 0)}</td>
        <td class="num">${r.jobs}</td>
        <td class="tiny muted">${esc(r.task)}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty-row">차량 없음</td></tr>';

    if ($('#studioModal').classList.contains('open')) {
      $('#studioFleet').innerHTML = snaps.map((r) => `
        <tr>
          <td class="strong">${r.id}</td>
          <td class="nowrap">${r.label}</td>
          <td class="nowrap">${socBar(r.soc)}</td>
          <td class="num">${fmt.pct(r.util, 1)}</td>
          <td class="num" style="color:${r.blocked > 10 ? 'var(--err)' : 'inherit'}">${fmt.pct(r.blocked, 1)}</td>
          <td class="num">${fmt.n(r.distM / 1000, 2)} km</td>
          <td class="num">${fmt.n(r.energy, 0)} Wh</td>
          <td class="num">${r.jobs}</td>
          <td class="tiny muted">${esc(r.task)}</td>
        </tr>`).join('');
    }
  }

  function renderJobTable() {
    const sim = app.sim;
    let pend = 0, act = 0;
    const open = [];
    for (const j of sim.jobs) {
      if (j.status === 'done') continue;
      open.push(j);
      if (j.status === 'pending') pend++; else act++;
    }
    $('#jobChips').innerHTML = `
      <span class="chip">대기 <b>${pend}</b></span>
      <span class="chip warn">진행 <b>${act}</b></span>
      <span class="chip ok">완료 <b>${sim.metrics.completed}</b></span>
      <span class="chip">누적발생 <b>${sim.metrics.released}</b></span>`;

    const show = open.slice(-40).reverse();
    const badge = { pending: 'gray', assigned: 'blue', queue: 'amber', loading: 'green', moving: 'purple' };
    const label = { pending: '대기', assigned: '배차', queue: '포트대기', loading: '적재', moving: '이송' };
    $('#jobTable').innerHTML = show.map((j) => `
      <tr>
        <td class="strong" style="color:var(--accent)">${j.id}</td>
        <td class="tiny">${j.from} → ${j.to}</td>
        <td><span class="badge ${badge[j.status] || 'gray'}">${label[j.status] || j.status}</span></td>
        <td class="tiny">${j.robot ? j.robot.replace('AMR-', 'R') : '—'}</td>
        <td class="num tiny">${fmt.n(sim.t - j.tCreated, 0)}s</td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty-row">대기 작업 없음</td></tr>';
  }

  function refreshStations() {
    const L = app.layout;
    const fill = (sel, nodes) => {
      const keep = sel.value;
      sel.innerHTML = nodes.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')
        || '<option value="">없음</option>';
      if (keep && nodes.some((n) => n.id === keep)) sel.value = keep;
    };
    fill($('#selFrom'), L.byType('pick'));
    fill($('#selTo'), L.byType('drop'));
    refreshPickDropRules();
  }

  function refreshPickDropRules() {
    const mode = app.params.destination_mode === 'mapped' ? 'mapped' : 'random';
    const modeSelect = $('#selDestinationMode');
    modeSelect.value = mode;
    const box = $('#pickDropRules');
    box.style.display = mode === 'mapped' ? '' : 'none';

    const picks = app.layout.byType('pick'), drops = app.layout.byType('drop');
    const list = $('#pickDropRuleList');
    if (!picks.length || !drops.length) {
      list.innerHTML = '<div class="tiny muted">픽업대와 드롭대를 각각 하나 이상 추가하세요.</div>';
      return;
    }

    list.innerHTML = picks.map((pick) => {
      const ids = allowedDropIds(pick.id);
      const names = ids.map((id) => drops.find((drop) => drop.id === id)?.name).filter(Boolean);
      return `<div class="row between tiny" style="gap:8px;margin:5px 0">
        <b>${esc(pick.name)}</b>
        <span style="color:var(--text-faint)">→ ${esc(names.join(', ') || '미지정')}</span>
      </div>`;
    }).join('');
  }

  /* ================= 시나리오 ================= */
  function renderScenarios() {
    const keys = ['A', 'B', 'C'];
    keys.forEach((k) => {
      const s = app.snapshots[k];
      // 구버전 저장분(결과 없음)은 현재 맵 기준으로 한 번만 평가
      if (s && !s.result) s.result = A.evaluateScenario(app.sim, s.params);
    });
    const valid = keys.map((k) => app.snapshots[k]).filter(Boolean);
    const bestUph = valid.length ? Math.max(...valid.map((s) => s.result.uph)) : 0;

    $('#scenarioGrid').innerHTML = keys.map((k) => {
      const snap = app.snapshots[k];
      if (!snap) {
        return `<div class="scenario"><h4>시나리오 ${k}</h4><div class="tiny muted">저장된 설정 없음</div></div>`;
      }
      const r = snap.result;
      const best = r.uph >= bestUph - 0.5;
      const pay = r.payback != null && isFinite(r.payback) ? fmt.n(r.payback, 2) + '년' : '—';
      return `<div class="scenario ${best ? 'best' : ''}">
        <h4>시나리오 ${k}${best ? ' <span class="badge green">최고</span>' : ''}</h4>
        <div class="row"><span>맵</span><span>${snap.layout ? esc(snap.layout.name || '-') : '미포함'}</span></div>
        <div class="row"><span>AMR</span><span>${snap.params.fleet}대</span></div>
        <div class="row"><span>처리량</span><span>${Math.round(r.uph)} UPH</span></div>
        <div class="row"><span>수요</span><span>${Math.round(r.demand)} UPH</span></div>
        <div class="row"><span>서비스율</span><span style="color:${r.service >= 98 ? 'var(--ok)' : 'var(--warn)'}">${fmt.pct(Math.min(999, r.service), 0)}</span></div>
        <div class="row"><span>사이클</span><span>${fmt.n(r.cycle, 0)}s</span></div>
        <div class="row"><span>소요대수</span><span>${r.reqFleet || '—'}</span></div>
        <div class="row"><span>제약</span><span>${r.bottleneck}</span></div>
        <div class="row"><span>건당원가</span><span>${fmt.int(r.costPerTask)}원</span></div>
        <div class="row"><span>회수</span><span>${pay}</span></div>
        <button class="btn xs" data-load-snap="${k}" style="width:100%;margin-top:6px">↩ 불러오기</button>
      </div>`;
    }).join('');
  }

  /* ================= 이벤트 ================= */
  function bindEvents() {
    /* --- 탭 --- */
    $$('.tabs').forEach((nav) => {
      nav.addEventListener('click', (e) => {
        const t = e.target.closest('.tab');
        if (!t || !t.dataset.pane) return;
        const scope = nav.parentElement;
        $$('.tab', nav).forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        $$('.pane', scope).forEach((p) => p.classList.remove('active'));
        const pane = $('#' + t.dataset.pane, scope);
        if (pane) pane.classList.add('active');
        if (t.dataset.pane.startsWith('r-')) { app.activeRightPane = t.dataset.pane; refreshAnalytics(); }
        if (t.dataset.pane.startsWith('s-')) setTimeout(refreshAnalytics, 50);
        if (t.dataset.pane === 's-time') { C.timeChart('chartTimeBig', app.sim); C.portChart('chartPort', app.layout); }
      });
    });

    /* --- 접기 --- */
    document.addEventListener('click', (e) => {
      const h = e.target.closest('[data-collapse]');
      if (h) h.parentElement.classList.toggle('closed');
    });

    /* --- 테마 --- */
    $('#themeSelect').addEventListener('change', (e) => {
      document.body.className = e.target.value;
      C.retheme();
      saveState();
    });

    /* --- 프리셋 --- */
    $('#btnLoadPreset').addEventListener('click', () => {
      const key = $('#presetSelect').value;
      const preset = M.PRESETS[key];
      if (!preset) return;
      pushHistory();
      closeInspector();
      preset.build(app.layout);
      app.sim.graph.rebuild();
      app.sim.reset();
      app.rend.fitToContent();
      refreshStations();
      refreshLive();
      refreshAnalytics();
      toast(`🏭 <b>${preset.label}</b> 레이아웃 적용 — ${preset.desc} (Ctrl+Z로 되돌리기)`, 'ok');
    });

    /* --- 저장/불러오기 --- */
    $('#btnSave').addEventListener('click', () => {
      const data = {
        version: 3, params: app.params, layout: layoutData(),
        theme: document.body.className, snapshots: app.snapshots
      };
      downloadBlob(JSON.stringify(data, null, 2), `amr_pro_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      toast('💾 설정 파일을 저장했습니다.', 'ok');
    });
    $('#btnLoad').addEventListener('click', () => $('#fileLayout').click());
    $('#fileLayout').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const d = JSON.parse(r.result);
          const before = snapshotLayout();
          if (applyState(d)) { pushHistory(before); toast('📂 설정을 불러왔습니다.', 'ok'); }
          else toast('⚠️ 레이아웃 정보가 없는 파일입니다.', 'err');
        } catch (err) { toast('⚠️ JSON 파싱 실패: ' + err.message, 'err'); }
      };
      r.readAsText(f);
      e.target.value = '';
    });

    /* --- 리포트 / 모달 --- */
    $('#btnReport').addEventListener('click', exportReport);
    $('#btnVideoExport').addEventListener('click', toggleVideoExport);
    $('#btnHelp').addEventListener('click', () => $('#helpModal').classList.add('open'));
    $$('[data-close-modal]').forEach((b) => b.addEventListener('click', (e) => e.target.closest('.modal').classList.remove('open')));
    $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); }));
    $('#btnStudio').addEventListener('click', () => {
      $('#studioModal').classList.add('open');
      setTimeout(() => { refreshAnalytics(); C.timeChart('chartTimeBig', app.sim); C.portChart('chartPort', app.layout); }, 60);
    });
    $('#btnStudioCsv').addEventListener('click', exportAllCsv);

    /* --- 수요 --- */
    $('#chkAutoRelease').addEventListener('change', (e) => {
      app.params.auto_release = e.target.checked;
      syncAutoReleaseLabel();
      refreshAnalytics();
    });
    $('#chkSameReleaseInterval').addEventListener('change', (e) => {
      app.params.release_mode = e.target.checked ? 'total' : 'per_station';
      app.sim.stationTimers = {};
      app.sim.releaseTimer = 0;
      refreshAnalytics();
      saveState();
    });
    $('#selDestinationMode').addEventListener('change', (e) => {
      app.params.destination_mode = e.target.value;
      refreshPickDropRules();
      saveState();
    });
    $('#btnAdd20').addEventListener('click', () => {
      const n = app.sim.addManualJobs(20);
      toast(n ? `🎲 랜덤 작업 ${n}건 추가` : '⚠️ 피킹/드롭 스테이션이 필요합니다', n ? 'ok' : 'warn');
      renderJobTable();
    });
    $('#btnAddJob').addEventListener('click', () => {
      const f = $('#selFrom').value, t = $('#selTo').value;
      if (!f || !t) { toast('⚠️ 스테이션을 선택하세요', 'warn'); return; }
      app.sim.addManualJobs(1, f, t);
      renderJobTable();
      toast(`✅ ${f} → ${t} 작업 등록`, 'ok');
    });
    $('#btnClearJobs').addEventListener('click', () => {
      const L = app.layout;
      app.sim.jobs.forEach((j) => {
        if (j.status !== 'pending') return;
        const n = L.node(j.from);
        if (n) n.buffer = Math.max(0, n.buffer - 1);
      });
      app.sim.jobs = app.sim.jobs.filter((j) => j.status !== 'pending');
      renderJobTable();
      toast('대기 작업을 비웠습니다.');
    });
    $('#btnCsvUp').addEventListener('click', () => $('#fileCsv').click());
    $('#fileCsv').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        let added = 0, skipped = 0;
        String(r.result).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
          if (!line.trim()) return;
          if (i === 0 && /from/i.test(line)) return;
          const [a, b, qty] = line.split(',').map((s) => (s || '').trim().replace(/^"|"$/g, ''));
          const fn = app.layout.node(a), tn = app.layout.node(b);
          if (fn && tn && fn.type === 'pick' && tn.type === 'drop') {
            const q = clamp(parseInt(qty, 10) || 1, 1, 500);
            for (let n = 0; n < q; n++) { app.sim.createJob(fn, tn); added++; }
          } else skipped++;
        });
        renderJobTable();
        toast(added ? `📥 ${added}건 등록${skipped ? ` (${skipped}행 무시)` : ''}` : '⚠️ 유효한 행이 없습니다', added ? 'ok' : 'warn');
      };
      r.readAsText(f);
      e.target.value = '';
    });
    $('#btnCsvSample').addEventListener('click', () => {
      const picks = app.layout.byType('pick'), drops = app.layout.byType('drop');
      const rows = [];
      picks.slice(0, 4).forEach((p, i) => drops.slice(0, 4).forEach((d, j) => rows.push([p.id, d.id, (i + j) % 3 + 1])));
      downloadBlob(toCSV(['From', 'To', 'Qty'], rows.length ? rows : [['P1', 'D1', 1]]), 'amr_schedule_sample.csv', 'text/csv;charset=utf-8;');
      toast('📄 CSV 샘플 다운로드', 'ok');
    });

    /* --- 배차/교통 --- */
    $('#selDispatch').addEventListener('change', (e) => {
      app.params.dispatch_algo = e.target.value;
      updateDispatchDesc();
      refreshAnalytics();
    });
    $('#selTraffic').addEventListener('change', (e) => { app.params.traffic_model = e.target.value; refreshAnalytics(); });
    $('#selPortDispatchPolicy').addEventListener('change', (e) => {
      app.params.dispatch_port_policy = e.target.value;
      refreshAnalytics();
    });
    $('#chkBidir').addEventListener('change', (e) => {
      app.params.bidirectional = e.target.checked;
      app.sim.graph.rebuild();
      refreshAnalytics();
      if (app.rend.selectedEdge) showEdgeInspector(app.rend.selectedEdge);
      const broken = app.sim.graph.connectivityReport().broken.length;
      if (!e.target.checked) {
        toast(broken
          ? `➡ 모든 양방향 통로를 일방통행(A→B)으로 전환 — <b>경로 단절 ${broken}쌍</b>. 통로를 클릭해 방향을 지정하세요.`
          : '➡ 모든 양방향 통로를 일방통행(A→B)으로 전환했습니다.', broken ? 'warn' : 'ok');
      } else toast('↔ 양방향 통행을 허용합니다.', 'ok');
    });
    $('#selChargePolicy').addEventListener('change', (e) => { app.params.charge_policy = e.target.value; });
    $('#chkFailures').addEventListener('change', (e) => {
      app.params.failures = e.target.checked;
      app.sim.robots.forEach((r) => { r.nextFault = e.target.checked ? app.sim.rng.exp(app.params.mtbf * 60) : Infinity; });
      refreshAnalytics();
    });
    $('#btnReseed').addEventListener('click', () => {
      let v = parseInt($('#inpSeed').value, 10);
      // 값을 바꾸지 않고 누르면 새 시드를 뽑는다
      if (!isFinite(v) || v === app.params.seed) v = Math.floor(Math.random() * 1e8);
      app.params.seed = v >>> 0;
      $('#inpSeed').value = app.params.seed;
      app.sim.reset();                        // 시드부터 다시 시작해야 재현성이 보장됨
      refreshLive(); refreshAnalytics();
      toast(`🎲 시드 ${app.params.seed} 적용 — 시뮬레이션을 처음부터 다시 시작합니다.`, 'ok');
    });

    /* --- 재생 제어 --- */
    $('#btnPlay').addEventListener('click', togglePlay);
    $('#btnStep').addEventListener('click', () => {
      for (let i = 0; i < 4; i++) app.sim.step(0.25);
      refreshLive(); refreshAnalytics();
    });
    $('#btnResetSim').addEventListener('click', () => {
      app.sim.reset();
      refreshLive(); refreshAnalytics();
      toast('🔄 시뮬레이션을 초기화했습니다.');
    });
    $$('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));

    /* --- 보기 토글 --- */
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.view;
      app.rend.show[k] = !app.rend.show[k];
      b.classList.toggle('active', app.rend.show[k]);
    }));
    $('#btnZoomIn').addEventListener('click', () => {
      if (app.view3D) { if (app.rend3d) app.rend3d.zoom(1.22); }
      else app.rend.zoom(1.22);
    });
    $('#btnZoomOut').addEventListener('click', () => {
      if (app.view3D) { if (app.rend3d) app.rend3d.zoom(0.82); }
      else app.rend.zoom(0.82);
    });
    $('#btnFit').addEventListener('click', () => {
      if (app.view3D) { if (app.rend3d) app.rend3d.fitToContent(); }
      else app.rend.fitToContent();
    });
    $('#btn3DView').addEventListener('click', toggle3DView);

    /* --- 도구 --- */
    $$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);
    $('#btnSnap').addEventListener('click', (ev) => {
      app.snap = !app.snap;
      ev.currentTarget.classList.toggle('active', app.snap);
    });

    $('#btnAutoLink').addEventListener('click', autoLink);
    $('#btnClearMap').addEventListener('click', () => {
      if (!app.layout.nodes.length) return;
      pushHistory();
      closeInspector();
      app.layout.reset();
      app.sim.graph.rebuild();
      app.sim.reset();
      refreshStations(); refreshLive(); refreshAnalytics();
      toast('🧹 맵을 초기화했습니다. (Ctrl+Z로 되돌리기)');
    });

    /* --- 플릿 조정 --- */
    $('#btnFleetPlus').addEventListener('click', () => setParam('fleet', app.params.fleet + 1));
    $('#btnFleetMinus').addEventListener('click', () => setParam('fleet', app.params.fleet - 1));

    /* --- 패널 --- */
    $('#btnWide').addEventListener('click', () => {
      $('#mainGrid').classList.toggle('right-wide');
      setTimeout(resizeRenderers, 240);
    });
    $('#btnCollapseSettings').addEventListener('click', toggleSide);
    $('#btnCollapseRight').addEventListener('click', toggleSide);
    $('#floatRight').addEventListener('click', toggleSide);
    $$('[data-side-view]').forEach((button) => button.addEventListener('click', () => {
      setPanelView(button.dataset.sideView);
    }));

    /* --- CSV --- */
    $('#btnMatrixCsv').addEventListener('click', exportMatrixCsv);
    $('#btnCurveCsv').addEventListener('click', exportCurveCsv);
    $('#btnSweepCsv').addEventListener('click', exportSweepCsv);

    /* --- 실험실 --- */
    $('#btnSweep').addEventListener('click', runSweep);
    $('#btnMonteCarlo').addEventListener('click', runMonteCarlo);
    $$('[data-snap]').forEach((b) => b.addEventListener('click', () => {
      app.snapshots[b.dataset.snap] = {
        params: { ...app.params, pick_drop_map: clonePickDropMap(app.params.pick_drop_map) },
        layout: layoutData(),
        result: A.evaluateScenario(app.sim, {})
      };
      renderScenarios();
      saveState();
      toast(`📌 시나리오 ${b.dataset.snap}에 현재 설정과 맵을 저장했습니다.`, 'ok');
    }));
    $('#btnClearSnap').addEventListener('click', () => { app.snapshots = {}; renderScenarios(); saveState(); });
    $('#scenarioGrid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-load-snap]');
      const snap = b && app.snapshots[b.dataset.loadSnap];
      if (!snap) return;
      pushHistory();
      applyState({ params: snap.params, layout: snap.layout || layoutData() });
      toast(`↩ 시나리오 ${b.dataset.loadSnap}를 불러왔습니다.${snap.layout ? '' : ' (구버전 저장분이라 맵은 현재 것을 유지)'}`, 'ok');
    });

    /* --- 인스펙터 --- */
    $('#inspClose').addEventListener('click', closeInspector);
    $('#inspDelete').addEventListener('click', deleteSelection);
    $('#inspBody').addEventListener('change', (ev) => {
      const pickId = ev.target.dataset.pickDrop;
      if (pickId) {
        const n = app.layout.node(pickId);
        if (!n) return;
        const ids = allowedDropIds(pickId);
        const dropId = ev.target.dataset.dropId;
        let next;
        if (ev.target.checked) {
          if (ids.length >= 2 && !ids.includes(dropId)) {
            ev.target.checked = false;
            toast('픽업대당 드롭대는 최대 2곳까지 지정할 수 있습니다.', 'warn');
            return;
          }
          next = ids.includes(dropId) ? ids : [...ids, dropId];
        } else {
          next = ids.filter((id) => id !== dropId);
          if (!next.length) {
            ev.target.checked = true;
            toast('픽업대마다 드롭대를 최소 1곳 지정해야 합니다.', 'warn');
            return;
          }
        }
        app.params.pick_drop_map[pickId] = next;
        refreshPickDropRules();
        showInspector(n);
        saveState();
        return;
      }
      const key = ev.target.dataset.insp;
      const n = app.rend.selected, e = app.rend.selectedEdge;
      if (!key || (!n && !e)) return;
      const v = ev.target.value;
      if (n && key === 'releaseInterval') {
        const raw = v.trim();
        if (raw === '') {
          if (n.release_interval == null) return;
          pushHistory();
          delete n.release_interval;
        } else {
          const seconds = Number(raw);
          if (!Number.isFinite(seconds)) {
            toast('배출 주기를 1~3600초 사이로 입력하세요.', 'warn');
            ev.target.value = Number.isFinite(n.release_interval) ? n.release_interval : '';
            return;
          }
          const interval = clamp(Math.round(seconds), 1, 3600);
          if (n.release_interval === interval) return;
          pushHistory();
          n.release_interval = interval;
        }
        delete app.sim.stationTimers[n.id];
        refreshAnalytics();
        showInspector(n);
        saveState();
        return;
      }
      pushHistory();
      if (n) {
        if (key === 'name') n.name = v.trim().slice(0, 24) || n.id;
        if (key === 'priority') n.priority = clamp(parseFloat(v) || 1, 0.1, 10);
        refreshStations(); refreshAnalytics(); showInspector(n);
      } else {
        if (key === 'dir') e.dir = v;
        if (key === 'lanes') e.lanes = clamp(Math.round(parseFloat(v) || 1), 1, 4);
        if (key === 'speedFactor') e.speedFactor = clamp(parseFloat(v) || 1, 0.2, 1);
        afterLayoutChange(); showEdgeInspector(e);
      }
    });
    $('#inspBody').addEventListener('click', (ev) => {
      const button = ev.target.closest('[data-clear-pick-release]');
      if (!button) return;
      const pick = app.layout.node(button.dataset.clearPickRelease);
      if (!pick || pick.release_interval == null) return;
      pushHistory();
      delete pick.release_interval;
      delete app.sim.stationTimers[pick.id];
      refreshAnalytics();
      showInspector(pick);
      saveState();
    });

    bindCanvas();
    bindPanelSplitters();
    bindKeyboard();
    global.addEventListener('resize', () => {
      const main = $('#mainGrid');
      if (main.dataset.panelWidthsCustomized === 'true') {
        setPanelWidth(readPanelWidth());
      }
      resizeRenderers();
    });
  }

  function syncAutoReleaseLabel() {
    const on = !!app.params.auto_release;
    const t = $('#txtAutoRelease');
    t.textContent = on ? 'ON' : 'OFF';
    t.style.color = on ? 'var(--ok)' : 'var(--text-faint)';
  }

  function togglePlay() {
    app.running = !app.running;
    const b = $('#btnPlay');
    b.textContent = app.running ? '⏸ 일시정지' : '▶ 재생';
    b.classList.toggle('primary', app.running);
  }

  function setView3D(enabled) {
    app.view3D = enabled;
    $('#canvasWrap').classList.toggle('view-3d', enabled);
    const button = $('#btn3DView');
    button.innerHTML = enabled ? '↩ 2D 편집' : '🧊 3D 보기';
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    $$('[data-map-edit]').forEach((control) => { control.disabled = enabled; });
    if (enabled) {
      app.drag = null;
      app.dragFrom = null;
      app.panning = false;
      closeInspector();
    }
    resizeRenderers();
  }

  async function toggle3DView() {
    if (app.view3D) {
      setView3D(false);
      toast('2D 편집 화면으로 돌아왔습니다.');
      return;
    }

    setView3D(true);
    const button = $('#btn3DView');
    button.disabled = true;
    app.view3DLoading = true;
    try {
      if (!app.rend3d) {
        if (typeof AMR.loadRenderer3D !== 'function') {
          throw new Error('3D 모듈 로더를 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
        }
        app.rend3d = await AMR.loadRenderer3D($('#simCanvas3D'), app.sim);
      }
      app.rend3d.invalidateMap();
      resizeRenderers();
      app.rend3d.fitToContent();
      app.rend3d.draw();
      toast('3D 보기 전용 모드입니다. 맵 편집은 2D 화면에서만 가능합니다.', 'ok');
    } catch (error) {
      setView3D(false);
      const detail = error && error.message ? `: ${esc(error.message)}` : '';
      toast(`3D 보기를 초기화하지 못했습니다${detail}`, 'err');
    } finally {
      app.view3DLoading = false;
      button.disabled = false;
    }
  }

  function setSpeed(s) {
    app.speed = s;
    $$('[data-speed]').forEach((b) => b.classList.toggle('active', +b.dataset.speed === s));
  }

  function setTool(t) {
    if (app.view3D) return;
    app.tool = t;
    app.rend.edgeStart = null;
    app.rend.ghost = null;
    app.rend.hoverEdge = null;
    $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('#simCanvas').style.cursor = cursorFor(t);
  }

  function toggleSide() {
    const g = $('#mainGrid');
    g.classList.toggle('right-off');
    const collapsed = g.classList.contains('right-off');
    const settingsActive = g.classList.contains('settings-mode');
    $('#leftPanel').classList.toggle('hidden', collapsed || !settingsActive);
    $('#rightPanel').classList.toggle('hidden', collapsed || settingsActive);
    $('#floatRight').classList.toggle('show', collapsed);
    const expanded = String(!collapsed);
    ['#btnCollapseSettings', '#btnCollapseRight', '#floatRight'].forEach((selector) => {
      $(selector).setAttribute('aria-expanded', expanded);
    });
    const activeLabel = settingsActive ? '변수 설정' : '분석';
    const actionLabel = collapsed ? '펼치기' : '접기';
    $('#btnCollapseSettings').setAttribute('aria-label', `${activeLabel} 패널 ${actionLabel}`);
    $('#btnCollapseRight').setAttribute('aria-label', `${activeLabel} 패널 ${actionLabel}`);
    $('#floatRight').setAttribute('aria-label', `우측 ${activeLabel} 패널 ${actionLabel}`);
    setTimeout(resizeRenderers, 240);
  }

  function setPanelView(view) {
    const settingsActive = view === 'settings';
    const main = $('#mainGrid');
    main.classList.toggle('settings-mode', settingsActive);
    const collapsed = main.classList.contains('right-off');
    $('#leftPanel').classList.toggle('hidden', collapsed || !settingsActive);
    $('#rightPanel').classList.toggle('hidden', collapsed || settingsActive);
    $$('[data-side-view]').forEach((button) => {
      const active = button.dataset.sideView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const activeLabel = settingsActive ? '변수 설정' : '분석';
    const actionLabel = collapsed ? '펼치기' : '접기';
    $('#btnCollapseSettings').setAttribute('aria-label', `${activeLabel} 패널 ${actionLabel}`);
    $('#btnCollapseRight').setAttribute('aria-label', `${activeLabel} 패널 ${actionLabel}`);
    $('#floatRight').setAttribute('aria-label', `우측 ${activeLabel} 패널 ${actionLabel}`);
    setTimeout(resizeRenderers, 240);
  }

  function readPanelWidth() {
    return parseFloat(getComputedStyle($('#mainGrid')).getPropertyValue('--right-panel-width')) || 400;
  }

  function setPanelWidth(width) {
    const main = $('#mainGrid');
    let rightWidth = Number(width);
    if (!Number.isFinite(rightWidth)) rightWidth = 400;

    if (global.matchMedia('(min-width: 1201px)').matches) {
      const styles = getComputedStyle(main);
      const innerWidth = main.clientWidth -
        parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const maxWidth = Math.max(280, Math.min(680, innerWidth - 369));
      rightWidth = clamp(rightWidth, 280, maxWidth);
    }

    rightWidth = Math.round(clamp(rightWidth, 280, 680));
    main.style.setProperty('--right-panel-width', `${rightWidth}px`);
    main.dataset.panelWidthsCustomized = 'true';
    $('#splitRight').setAttribute('aria-valuenow', String(rightWidth));
  }

  function bindPanelSplitters() {
    const main = $('#mainGrid');
    let resizeFrame = 0;
    const initialWidth = readPanelWidth();
    $('#splitRight').setAttribute('aria-valuenow', String(initialWidth));
    const prepareResize = () => {
      if (!main.classList.contains('right-wide')) return;
      const current = readPanelWidth();
      main.classList.remove('right-wide');
      if (!main.classList.contains('right-off')) {
        const wideWidth = global.matchMedia('(max-width: 1500px)').matches ? 500 : 560;
        setPanelWidth(wideWidth);
      }
    };
    const resizeCanvas = () => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        resizeRenderers();
      });
    };

    const handle = $('#splitRight');
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !global.matchMedia('(min-width: 1201px)').matches) return;
      ev.preventDefault();
      prepareResize();
      const startWidth = readPanelWidth();
      const startX = ev.clientX;
      main.classList.add('is-resizing');
      handle.setPointerCapture(ev.pointerId);

      const onMove = (moveEv) => {
        setPanelWidth(startWidth - (moveEv.clientX - startX));
        resizeCanvas();
      };
      const finish = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
        main.classList.remove('is-resizing');
        saveState();
        resizeCanvas();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });

    handle.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      ev.stopPropagation();
      prepareResize();
      setPanelWidth(readPanelWidth() + (ev.key === 'ArrowLeft' ? 16 : -16));
      saveState();
      resizeCanvas();
    });
  }

  /* ================= 캔버스 상호작용 ================= */
  function bindCanvas() {
    const cv = $('#simCanvas');

    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      app.rend.zoom(e.deltaY < 0 ? 1.13 : 0.885, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    cv.addEventListener('mousedown', (e) => {
      // 인스펙터에서 입력 중이던 값을 먼저 확정
      const ae = document.activeElement;
      if (ae && ae.closest && ae.closest('#inspBody')) ae.blur();

      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const wp = app.rend.toWorld(sx, sy);

      if (e.button === 2 || e.button === 1 || app.tool === 'pan') {
        app.panning = true;
        app.panStart = { x: sx - app.rend.view.x, y: sy - app.rend.view.y };
        cv.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;

      const hit = app.rend.nodeAt(wp);

      switch (app.tool) {
        case 'select':
          if (hit) {
            app.drag = hit;
            app.dragFrom = { x: hit.x, y: hit.y, sx, sy, moved: false, snap: snapshotLayout() };
            showInspector(hit);
          } else {
            const ed = app.rend.edgeAt(wp, 10);
            if (ed) showEdgeInspector(ed); else closeInspector();
          }
          break;

        case 'delete':
          if (hit) deleteNode(hit);
          else {
            const ed = app.rend.edgeAt(wp, 12);
            if (ed) {
              pushHistory();
              if (app.rend.selectedEdge === ed) closeInspector();
              app.layout.removeEdge(ed);
              app.rend.hoverEdge = null;
              afterLayoutChange();
              toast('통로를 삭제했습니다.');
            }
          }
          break;

        case 'edge':
          if (!hit) { app.rend.edgeStart = null; break; }            // 빈 곳 클릭 = 종료
          if (!app.rend.edgeStart) { app.rend.edgeStart = hit; break; }
          if (app.rend.edgeStart.id !== hit.id) {
            const dir = e.shiftKey ? 'ab' : 'both';
            if (!app.layout.hasEdge(app.rend.edgeStart.id, hit.id)) {
              pushHistory();
              app.layout.addEdge(app.rend.edgeStart.id, hit.id, dir);
              afterLayoutChange();
              toast(dir === 'ab' ? '➡ 일방통행 통로 생성' : '🔗 양방향 통로 생성', 'ok');
            }
            app.rend.edgeStart = hit;                                 // 연속 연결
          }
          break;

        case 'pick': case 'drop': case 'charge': case 'park': case 'waypoint': {
          if (hit) { toast('이미 노드가 있는 위치입니다.', 'warn'); break; }
          pushHistory();
          const sp = snapPt(wp, e);
          const n = app.layout.addNode(app.tool, sp.x, sp.y);
          // 가장 가까운 노드에 자동 연결
          let best = null, bd = Infinity;
          app.layout.nodes.forEach((o) => {
            if (o === n) return;
            const d = Math.hypot(o.x - n.x, o.y - n.y);
            if (d < bd) { bd = d; best = o; }
          });
          if (best && bd < 320) app.layout.addEdge(n.id, best.id);
          afterLayoutChange();
          showInspector(n);
          toast(`${M.NODE_TYPES[app.tool].label} <b>${n.id}</b> 배치`, 'ok');
          break;
        }
      }
    });

    cv.addEventListener('mousemove', (e) => {
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;

      if (app.panning) {
        app.rend.view.x = sx - app.panStart.x;
        app.rend.view.y = sy - app.panStart.y;
        return;
      }
      const wp = app.rend.toWorld(sx, sy);
      app.rend.mouseWorld = wp;

      if (app.drag && app.tool === 'select') {
        const f = app.dragFrom;
        // 단순 클릭의 미세한 떨림으로 노드가 격자에 튀지 않도록 4px 이상 움직였을 때만 이동
        if (!f.moved && Math.hypot(sx - f.sx, sy - f.sy) < 4) return;
        f.moved = true;
        const sp = snapPt(wp, e);
        if (sp.x !== app.drag.x || sp.y !== app.drag.y) {
          app.drag.x = sp.x; app.drag.y = sp.y;
          app.sim.graph.rebuild();
        }
        return;
      }

      app.rend.hover = app.rend.nodeAt(wp);
      app.rend.hoverEdge = (!app.rend.hover && app.tool === 'delete') ? app.rend.edgeAt(wp, 12) : null;
      app.rend.ghost = NODE_TOOLS.includes(app.tool) ? { type: app.tool, ...snapPt(wp, e) } : null;
      if (app.tool === 'select') {
        cv.style.cursor = (app.rend.hover || app.rend.edgeAt(wp, 10)) ? 'pointer' : 'default';
      }
    });

    cv.addEventListener('mouseleave', () => {
      app.rend.ghost = null; app.rend.hover = null; app.rend.hoverEdge = null;
    });

    global.addEventListener('mouseup', () => {
      if (app.panning) {
        app.panning = false;
        $('#simCanvas').style.cursor = cursorFor(app.tool);
      }
      if (app.drag) {
        const d = app.drag, f = app.dragFrom;
        app.drag = null; app.dragFrom = null;
        if (f && (d.x !== f.x || d.y !== f.y)) {
          pushHistory(f.snap);
          afterLayoutChange();
          if (app.rend.selected === d) showInspector(d);
        }
      }
    });

    // 터치
    let lastTouch = null, pinchDist = 0;
    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const r = cv.getBoundingClientRect();
        lastTouch = { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
      } else if (e.touches.length === 2) {
        pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    cv.addEventListener('touchmove', (e) => {
      const r = cv.getBoundingClientRect();
      if (e.touches.length === 1 && lastTouch) {
        const x = e.touches[0].clientX - r.left, y = e.touches[0].clientY - r.top;
        app.rend.view.x += x - lastTouch.x;
        app.rend.view.y += y - lastTouch.y;
        lastTouch = { x, y };
        e.preventDefault();
      } else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (pinchDist > 0) {
          const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
          const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
          app.rend.zoom(d / pinchDist, cx, cy);
        }
        pinchDist = d;
        e.preventDefault();
      }
    }, { passive: false });
    cv.addEventListener('touchend', () => { lastTouch = null; pinchDist = 0; }, { passive: true });
  }

  function afterLayoutChange() {
    app.sim.graph.rebuild();
    refreshStations();
    refreshAnalytics();
  }

  function deleteNode(n) {
    pushHistory();
    const safe = app.layout.nodes.find((x) => x !== n);
    app.sim.robots.forEach((r) => {
      const touches = r.atNode === n.id || r.nextNode === n.id || r.path.includes(n.id)
        || (r.job && (r.job.from === n.id || r.job.to === n.id));
      if (!touches) return;
      r.abortJob();
      if (r.atNode === n.id && safe) { r.atNode = safe.id; r.x = safe.x; r.y = safe.y; }
    });
    app.sim.jobs = app.sim.jobs.filter((j) => j.status === 'done' || (j.from !== n.id && j.to !== n.id));
    app.layout.removeNode(n.id);
    if (app.rend.edgeStart === n) app.rend.edgeStart = null;
    if (app.rend.hover === n) app.rend.hover = null;
    if (app.rend.selected === n || app.rend.selectedEdge) closeInspector();
    afterLayoutChange();
    toast(`🗑 <b>${n.id}</b> 삭제`);
  }

  /** 인스펙터에 열려 있는 노드 또는 통로 삭제 */
  function deleteSelection() {
    const n = app.rend.selected, e = app.rend.selectedEdge;
    if (n) deleteNode(n);
    else if (e) {
      pushHistory();
      app.layout.removeEdge(e);
      afterLayoutChange();
      toast('통로를 삭제했습니다.');
    }
    closeInspector();
  }

  function autoLink() {
    const L = app.layout, ns = L.nodes;
    if (ns.length < 2) { toast('노드가 부족합니다.', 'warn'); return; }
    const before = snapshotLayout();
    let added = 0;
    const R = 230;
    ns.forEach((a, i) => {
      const cand = ns.slice(i + 1)
        .map((b) => ({ b, d: Math.hypot(a.x - b.x, a.y - b.y) }))
        .filter((o) => o.d <= R)
        .sort((x, y) => x.d - y.d)
        .slice(0, 3);
      cand.forEach((o) => { if (L.addEdge(a.id, o.b.id)) added++; });
    });
    // 고립 노드는 최근접 1개와 강제 연결
    app.sim.graph.rebuild();
    ns.forEach((a) => {
      if ((app.sim.graph.adj.get(a.id) || []).length) return;
      let best = null, bd = Infinity;
      ns.forEach((b) => { if (b === a) return; const d = Math.hypot(a.x - b.x, a.y - b.y); if (d < bd) { bd = d; best = b; } });
      if (best && L.addEdge(a.id, best.id)) added++;
    });
    if (added) pushHistory(before);
    afterLayoutChange();
    toast(added ? `🪄 통로 ${added}개 자동 생성` : '추가할 통로가 없습니다.', added ? 'ok' : 'warn');
  }

  /* ================= 인스펙터 ================= */
  function showInspector(n) {
    const sim = app.sim;
    app.rend.selected = n; app.rend.selectedEdge = null;
    $('#inspector').classList.add('show');
    $('#inspTitle').textContent = `${M.NODE_TYPES[n.type].label} · ${n.id}`;
    const deg = (sim.graph.adj.get(n.id) || []).length;
    const isPort = n.type === 'pick' || n.type === 'drop';
    const parkingClaims = n.type === 'park'
      ? sim.robots.filter((robot) => robot.parkTarget === n.id && Number.isInteger(robot.parkSlot)).length
      : 0;
    $('#inspBody').innerHTML = `
      <div class="field mb"><label>이름</label>
        <input type="text" data-insp="name" maxlength="24" value="${esc(n.name)}"></div>
      ${isPort ? `<div class="field mb"><label>수요 가중치 (1=기본, 2=2배 빈도)</label>
        <input type="number" data-insp="priority" min="0.1" max="10" step="0.1" value="${n.priority}"></div>` : ''}
      ${n.type === 'pick' ? `<div class="field mb"><label>화물 배출 주기 (초)</label>
        <div class="row" style="gap:6px">
          <input type="number" data-insp="releaseInterval" min="1" max="3600" step="1"
            value="${Number.isFinite(n.release_interval) ? n.release_interval : ''}"
            placeholder="${app.params.release_interval}" aria-label="${esc(n.name)} 배출 주기" style="width:90px;flex:0 0 90px">
          <button type="button" class="btn xs" data-clear-pick-release="${esc(n.id)}">공통값</button>
        </div>
        <div class="tiny muted" style="margin-top:3px">${app.params.release_mode === 'total'
          ? '동일 적용이 켜져 있어 개별 주기는 현재 사용되지 않습니다.'
          : '비워두면 좌측 공통 배출 주기를 사용합니다.'}</div>
      </div>` : ''}
      ${n.type === 'pick' ? `<div class="field mb"><label>허용 드롭대 (1~2곳)</label>
        ${app.layout.byType('drop').length ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px">
          ${app.layout.byType('drop').map((drop) =>
            `<label class="switch" style="font-size:10px"><input type="checkbox" data-pick-drop="${esc(n.id)}" data-drop-id="${esc(drop.id)}"${allowedDropIds(n.id).includes(drop.id) ? ' checked' : ''}>${esc(drop.name)}</label>`
          ).join('')}
        </div><div class="tiny muted" style="margin-top:3px">두 곳을 지정하면 두 드롭대 중 하나를 무작위 선택합니다.</div>`
          : '<div class="tiny muted">드롭대를 먼저 추가하세요.</div>'}</div>` : ''}
      ${n.type === 'park' ? `<div class="field mb"><label>대기존 수용 차량 수</label>
        <div class="strong">1대 (고정)</div>
        <div class="tiny muted" style="margin-top:3px">대기 중 차량과 진입 예약 차량을 함께 셉니다. 만석이면 포트를 비운 가까운 경유 노드에서 대기합니다.</div>
      </div>` : ''}
      <div class="insp-row"><span>좌표</span><b>${Math.round(n.x)}, ${Math.round(n.y)}</b></div>
      <div class="insp-row"><span>나가는 통로</span><b>${deg}개</b></div>
      ${n.type === 'park' ? `<div class="insp-row"><span>점유/진입 예약</span><b>${parkingClaims}/1</b></div>` : ''}
      ${n.type !== 'waypoint' && n.type !== 'park' ? `<div class="insp-row"><span>현재 점유</span><b>${n.occupants.length}/${app.params.port_cap}${n.queue ? ` (대기 ${n.queue})` : ''}</b></div>
      <div class="insp-row"><span>누적 대기</span><b>${fmt.n(n.waitAccum / 60, 1)}분</b></div>` : ''}
      ${n.type === 'pick' ? `<div class="insp-row"><span>적체 화물</span><b>${n.buffer}건</b></div>` : ''}
      ${isPort ? `<div class="insp-row"><span>처리 누적</span><b>${n.processed}건</b></div>` : ''}`;
  }

  function showEdgeInspector(e) {
    const L = app.layout, a = L.node(e.a), b = L.node(e.b);
    if (!a || !b) return;
    app.rend.selected = null; app.rend.selectedEdge = e;
    $('#inspector').classList.add('show');
    $('#inspTitle').textContent = `통로 · ${e.a} ↔ ${e.b}`;
    const m = app.sim.graph.pxToM(Math.hypot(a.x - b.x, a.y - b.y));
    const opt = (v, t) => `<option value="${v}" ${e.dir === v ? 'selected' : ''}>${t}</option>`;
    const forced = e.dir === 'both' && app.params.bidirectional === false;
    $('#inspBody').innerHTML = `
      <div class="insp-row"><span>길이</span><b>${fmt.n(m, 1)} m</b></div>
      <div class="insp-row mb"><span>누적 통과</span><b>${e.flow || 0}회</b></div>
      <div class="field mb"><label>통행 방향</label>
        <select data-insp="dir">${opt('both', '양방향')}${opt('ab', `${e.a} → ${e.b}`)}${opt('ba', `${e.b} → ${e.a}`)}</select></div>
      ${forced ? `<div class="tiny mb" style="color:var(--warn)">양방향 허용이 꺼져 있어 현재 <b>${e.a} → ${e.b}</b>로만 통행합니다.</div>` : ''}
      <div class="field mb"><label>차선 수 (동시 통행 대수)</label>
        <input type="number" data-insp="lanes" min="1" max="4" step="1" value="${e.lanes || 1}"></div>
      <div class="field"><label>속도 계수 (1=제한 없음, 0.5=절반 속도)</label>
        <input type="number" data-insp="speedFactor" min="0.2" max="1" step="0.1" value="${e.speedFactor || 1}"></div>`;
  }

  function closeInspector() {
    $('#inspector').classList.remove('show');
    app.rend.selected = null; app.rend.selectedEdge = null;
  }

  /* ================= 키보드 ================= */
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (app.view3D) {
        if (e.key === 'Escape' && !app.view3DLoading) {
          e.preventDefault();
          setView3D(false);
        }
        return;
      }
      if (/input|select|textarea/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();

      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
        else if (k === 'y') { e.preventDefault(); redo(); }
        return;                       // Ctrl+C 등이 도구를 바꾸지 않도록
      }
      if (e.altKey) return;

      if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
      if (e.key === 'Escape') {
        $$('.modal.open').forEach((m) => m.classList.remove('open'));
        app.rend.edgeStart = null; closeInspector();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (app.rend.selected || app.rend.selectedEdge)) {
        e.preventDefault(); deleteSelection(); return;
      }
      const speeds = { '1': 1, '2': 4, '3': 10, '4': 30, '5': 120 };
      if (speeds[e.key]) { setSpeed(speeds[e.key]); return; }
      const tools = { v: 'select', h: 'pan', p: 'pick', d: 'drop', c: 'charge', k: 'park', n: 'waypoint', e: 'edge', x: 'delete' };
      if (tools[k]) { setTool(tools[k]); return; }
      if (k === 'f') { app.rend.fitToContent(); return; }
      if (e.key === '[') { setPanelView('settings'); return; }
      if (e.key === ']') { toggleSide(); return; }
    });
  }

  /* ================= 실험실 ================= */
  function runSweep() {
    const key = $('#sweepKey').value;
    const spec = M.PARAM_MAP[key];
    const from = parseFloat($('#sweepFrom').value);
    const to = parseFloat($('#sweepTo').value);
    const steps = parseInt($('#sweepSteps').value, 10) || 14;
    if (!spec || !isFinite(from) || !isFinite(to) || from === to) { toast('⚠️ 범위를 확인하세요', 'warn'); return; }

    const rows = A.sweep(app.sim, key, from, to, steps);
    app.sweepRows = rows; app.sweepSpec = spec;
    $('#sweepBox').style.display = '';
    $('#sweepTitle').textContent = `${spec.label} 민감도`;
    C.sweepChart('chartSweep', rows, spec);

    // 인사이트: 탄력도 계산
    const first = rows[0], last = rows[rows.length - 1];
    const dU = last.uph - first.uph;
    const dV = last.value - first.value;
    const elasticity = (first.uph > 0 && first.value !== 0 && dV !== 0)
      ? ((dU / first.uph) / (dV / first.value)) : 0;
    const bestRow = rows.reduce((b, r) => (r.uph > b.uph ? r : b), rows[0]);
    const bottlenecks = [...new Set(rows.map((r) => r.bottleneck))];
    $('#sweepInsight').innerHTML =
      `<b>탄력도 ${fmt.n(elasticity, 2)}</b> — ${spec.label} 1% 변화당 처리량 ${fmt.n(Math.abs(elasticity), 2)}% ` +
      `${elasticity >= 0 ? '증가' : '감소'}. ` +
      `범위 내 최대 처리량은 <b>${spec.label} ${fmt.n(bestRow.value, spec.dec)}${spec.unit}</b>에서 <b>${Math.round(bestRow.uph)} UPH</b>. ` +
      `관측된 제약 요인: ${bottlenecks.join(', ')}. ` +
      (Math.abs(elasticity) < 0.12 ? '<b style="color:var(--warn)">영향이 매우 작습니다 — 다른 변수를 먼저 개선하세요.</b>' :
       Math.abs(elasticity) > 0.75 ? '<b style="color:var(--ok)">영향이 매우 큽니다 — 최우선 개선 레버입니다.</b>' : '');
    toast(`⚡ ${spec.label} 스윕 ${rows.length}포인트 완료`, 'ok');
  }

  async function runMonteCarlo() {
    if (app.mcRunning) return;
    const runs = clamp(parseInt($('#mcRuns').value, 10) || 6, 1, 30);
    const horizon = clamp(parseInt($('#mcHorizon').value, 10) || 45, 5, 300);
    const est = runs * horizon;
    if (est > 900 && !confirm(`총 ${runs}회 × ${horizon}분 시뮬레이션은 수 초~수십 초가 걸릴 수 있습니다. 진행할까요?`)) return;

    const btn = $('#btnMonteCarlo');
    const bar = $('#mcProgress').firstElementChild;
    app.mcRunning = true;
    btn.disabled = true; btn.textContent = '⏳ 계산 중...';
    $('#mcProgress').style.display = '';
    bar.style.width = '0%';
    $('#mcStatus').textContent = '초기화 중...';

    try {
      const mc = await A.monteCarlo(app.sim, { runs, horizonMin: horizon, dt: 0.5 }, (i, n, k) => {
        bar.style.width = (i / n) * 100 + '%';
        $('#mcStatus').textContent = `Run ${i}/${n} — ${Math.round(k.measuredUPH)} UPH`;
      });
      app.mc = mc;
      renderMc(mc);
      toast(`🎲 몬테카를로 ${runs}회 완료 — 평균 ${fmt.n(mc.uph.mean, 1)} ± ${fmt.n(mc.uph.ci, 1)} UPH`, 'ok');
    } catch (err) {
      $('#mcStatus').textContent = '';
      toast('⚠️ 실행 실패: ' + err.message, 'err');
      console.error(err);
    } finally {
      app.mcRunning = false;
      btn.disabled = false; btn.textContent = '🎲 몬테카를로 실행';
      $('#mcProgress').style.display = 'none';
    }
  }

  function renderMc(mc) {
    $('#mcResult').style.display = '';
    const cell = (label, v, unit, dec) =>
      `<div class="kpi"><div class="kpi-label">${label}</div>
       <div class="kpi-value sm">${fmt.n(v.mean, dec)}${unit}</div>
       <div class="kpi-delta">± ${fmt.n(v.ci, dec)} (95% CI) · σ ${fmt.n(v.std, dec)}</div></div>`;
    $('#mcKpis').innerHTML =
      cell('평균 처리량', mc.uph, ' UPH', 1) +
      cell('평균 사이클', mc.cycle, ' s', 1) +
      cell('P90 사이클', mc.p90, ' s', 1) +
      cell('가동률', mc.util, ' %', 1) +
      cell('포트대기 비중', mc.queueShare, ' %', 1) +
      cell('정체 손실', mc.blockShare, ' %', 1);
    $('#mcStatus').innerHTML =
      `${mc.runs}회 × ${mc.horizonMin}분 · 워밍업 제외 정상상태 측정 · ` +
      `변동계수 <b>${fmt.pct((mc.uph.std / Math.max(0.001, mc.uph.mean)) * 100, 1)}</b> ` +
      `(10% 미만이면 결과가 안정적입니다)`;
    C.mcChart('chartMc', mc);
  }

  /* ================= 내보내기 ================= */
  function exportMatrixCsv() {
    renderMatrix();                       // 거리 탭을 열지 않았어도 최신 데이터로
    const rows = app._matrixRows || [];
    if (!rows.length) { toast('내보낼 데이터가 없습니다.', 'warn'); return; }
    const data = rows.map((r) => [
      r.from.id, r.from.name, r.to.id, r.to.name,
      isFinite(r.distM) ? r.distM.toFixed(2) : '', isFinite(r.backM) ? r.backM.toFixed(2) : '',
      r.ok ? r.tF.toFixed(2) : '', r.ok ? r.cycle.toFixed(2) : '',
      r.turns.toFixed(0), r.ok ? r.path.join(' > ') : '', r.ok ? '연결' : '단절'
    ]);
    downloadBlob(toCSV(
      ['출발ID', '출발명', '도착ID', '도착명', '적재거리(m)', '복귀거리(m)', '적재주행(s)', '왕복사이클(s)', '누적선회(deg)', '경유경로', '상태'],
      data), `AMR_거리매트릭스_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
    toast('📥 거리 매트릭스 CSV 다운로드', 'ok');
  }

  function exportCurveCsv() {
    const curve = app._curve || [];
    if (!curve.length) { toast('내보낼 데이터가 없습니다.', 'warn'); return; }
    downloadBlob(toCSV(
      ['투입대수', '예측처리량(UPH)', '사이클(s)', '포트대기(s)', '유효속도계수', '제약요인'],
      curve.map((c) => [c.n, c.uph.toFixed(1), c.cycle.toFixed(1), c.wait.toFixed(1), c.factor.toFixed(3), c.bottleneck])),
      `AMR_감도분석_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
    toast('📥 감도 분석 CSV 다운로드', 'ok');
  }

  function exportSweepCsv() {
    if (!app.sweepRows) return;
    const s = app.sweepSpec;
    downloadBlob(toCSV(
      [`${s.label}(${s.unit})`, '처리량(UPH)', '수요(UPH)', '서비스율(%)', '사이클(s)', '포트대기(s)', '소요대수', '제약요인', '건당원가(원)'],
      app.sweepRows.map((r) => [r.value.toFixed(3), r.uph.toFixed(1), r.demand.toFixed(1), r.service.toFixed(1),
        r.cycle.toFixed(1), r.wait.toFixed(1), r.reqFleet || '', r.bottleneck, r.costPerTask.toFixed(0)])),
      `AMR_스윕_${s.key}.csv`, 'text/csv;charset=utf-8;');
    toast('📥 스윕 결과 CSV 다운로드', 'ok');
  }

  function exportAllCsv() {
    exportMatrixCsv();
    setTimeout(exportCurveCsv, 350);
  }

  function toggleVideoExport() {
    if (app.videoExport && app.videoExport.recording) {
      app.videoExport.stop();
      return;
    }

    const button = $('#btnVideoExport');
    const exporter = new AMR.VideoExporter();
    app.videoExport = exporter;
    if (app.view3D) app.rend.draw();
    const started = exporter.start({
      mapCanvas: $('#simCanvas'),
      getSnapshot: () => ({ sim: app.sim, layoutName: app.layout.name }),
      onState: (recording) => {
        button.innerHTML = recording
          ? '⏹ <span class="lbl">녹화 종료</span>'
          : '🎥 <span class="lbl">영상</span>';
        button.classList.toggle('danger', recording);
        if (!recording && app.videoExport === exporter) app.videoExport = null;
      },
      onComplete: (blob) => {
        const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
        downloadBlob(blob, `AMR_시뮬레이션_${stamp}.webm`, blob.type || 'video/webm');
        toast('🎥 결과 영상(WebM)을 저장했습니다.', 'ok');
      },
      onError: (message) => toast(`🎥 영상 내보내기 실패: ${esc(message)}`, 'err')
    });

    if (started) toast('🎥 녹화 중입니다. 종료 버튼을 누르면 WebM을 저장합니다. 긴 녹화는 메모리 사용량이 커질 수 있습니다.', 'ok');
    else app.videoExport = null;
  }

  function exportReport() {
    const sim = app.sim, p = app.params, k = sim.kpi();
    const diag = A.diagnose(sim);
    const eco = A.economics(sim);
    const cm = A.cycleModel(sim);
    const curve = app._curve || [];
    const limits = sim.portLimits();

    const L = [];
    L.push('═'.repeat(66));
    L.push('  AGV/AMR Capa 시뮬레이션 분석 리포트');
    L.push(`  생성 ${new Date().toLocaleString('ko-KR')}`);
    L.push('═'.repeat(66));
    L.push('');
    L.push('【1. 레이아웃 구성】');
    L.push(`  레이아웃명        : ${app.layout.name}`);
    L.push(`  피킹 / 드롭 / 충전 : ${sim.layout.byType('pick').length} / ${sim.layout.byType('drop').length} / ${sim.layout.byType('charge').length}개`);
    L.push(`  경유 노드 / 통로   : ${sim.layout.byType('waypoint').length} / ${sim.layout.edges.length}개`);
    L.push(`  축척              : 100px = ${p.pixel_scale}m`);
    L.push(`  양방향 통행        : ${p.bidirectional === false ? '불허 (전 통로 일방통행)' : '허용'}`);
    L.push('');
    L.push('【2. 설계 파라미터】');
    L.push(`  최고속/가속/감속   : ${p.v_max} m/s / ${p.accel} / ${p.decel} m/s²`);
    L.push(`  1회 적재 수량      : ${p.payload} 개 (같은 피킹→드롭 화물 묶음 운반)`);
    L.push(`  도킹 (픽/드롭)     : 1개당 ${p.t_pick}s / ${p.t_drop}s (CV ${p.cv_service})`);
    L.push(`  배차 알고리즘      : ${AMR.dispatch.ALGOS[p.dispatch_algo].label}`);
    L.push(`  교통 모델          : ${p.traffic_model}`);
    L.push(`  포트 배차 정책      : ${p.dispatch_port_policy === 'throughput' ? '처리량 우선' : '교착 방지 우선'}`);
    L.push(`  투입 대수 / OEE    : ${p.fleet}대 / ${p.oee}%`);
    L.push(`  배터리             : ${p.bat_kwh}kWh, ${p.bat_min}~${p.bat_max}%, 충전 ${p.charge_kw}kW`);
    L.push(`  난수 시드          : ${p.seed} (재현 가능)`);
    L.push('');
    L.push('【3. 수요 vs 물리 한계】');
    L.push(`  설계 유입량        : ${Math.round(sim.demandUPH())} UPH`);
    L.push(`  피킹 포트 한계     : ${Math.round(limits.pick)} UPH`);
    L.push(`  드롭 포트 한계     : ${Math.round(limits.drop)} UPH`);
    L.push(`  통로 유효속도 계수 : ${fmt.pct(diag.congestion * 100, 0)}`);
    L.push('');
    L.push('【4. 해석 모델 사이클 분해】' + (p.payload > 1 ? ` (1회 운행 = 화물 ${p.payload}개, 만재 가정)` : ''));
    if (cm.ok) {
      L.push(`  평균 적재거리      : ${fmt.n(cm.loadedM, 1)} m`);
      L.push(`  평균 공차거리      : ${fmt.n(cm.emptyM, 1)} m`);
      L.push(`  주행 시간          : ${fmt.n(cm.tTravel, 1)} s`);
      L.push(`  도킹 시간          : ${fmt.n(cm.tDock, 1)} s`);
      L.push(`  충전 분할 상각     : ${fmt.n(cm.tCharge, 1)} s`);
      L.push(`  → 이론 사이클      : ${fmt.n(cm.tCycle, 1)} s`);
      L.push(`  사이클당 에너지    : ${fmt.n(cm.whPerCycle, 1)} Wh (1충전 ${fmt.n(cm.cyclesPerCharge, 0)}사이클)`);
    } else {
      L.push('  경로 단절로 산출 불가');
    }
    L.push('');
    L.push('【5. 시뮬레이션 실측 결과】');
    L.push(`  시뮬레이션 시간    : ${fmt.clock(sim.t)}`);
    L.push(`  완료 / 발생        : ${k.completed} / ${sim.metrics.released} 건`);
    L.push(`  실측 처리량        : ${fmt.n(k.measuredUPH, 1)} UPH`);
    L.push(`  서비스율           : ${fmt.pct(k.serviceRate, 1)}`);
    L.push(`  평균 사이클        : ${fmt.n(k.avgCycle, 1)} s (P90 ${fmt.n(k.p90Cycle, 1)} s, 운행 단위)`);
    L.push(`  포트 대기 비중     : ${fmt.pct(k.queueShare, 1)}`);
    L.push(`  교통 정체 손실     : ${fmt.pct(k.blockShare, 1)}`);
    L.push(`  플릿 가동률        : ${fmt.pct(k.util, 1)}`);
    L.push(`  적재 주행 비율     : ${fmt.pct(k.loadedShare, 1)}`);
    L.push(`  평균 SoC           : ${fmt.pct(k.avgSoc, 1)}`);
    L.push(`  건당 에너지        : ${fmt.n(k.energyPerTask, 1)} Wh`);
    L.push(`  총 주행거리        : ${fmt.n(k.distanceM / 1000, 2)} km`);
    L.push('');
    L.push('【6. 소요 대수 산정】');
    L.push(`  권장 투입 대수     : ${isFinite(diag.req.n) ? diag.req.n + ' 대' : '달성 불가'}`);
    L.push(`  현재 투입 대수     : ${p.fleet} 대`);
    L.push('');
    L.push('【7. 투입 대수별 예측】');
    L.push('  대수 | 처리량(UPH) | 사이클(s) | 포트대기(s) | 제약 요인');
    L.push('  ' + '-'.repeat(60));
    curve.slice(0, 20).forEach((c) => {
      L.push(`  ${String(c.n).padStart(4)} | ${String(Math.round(c.uph)).padStart(11)} | ${fmt.n(c.cycle, 0).padStart(9)} | ${fmt.n(c.wait, 1).padStart(11)} | ${c.bottleneck}`);
    });
    L.push('');
    L.push('【8. 자동 병목 진단】');
    diag.items.forEach((d, i) => {
      const tag = { ok: '[정상]', info: '[정보]', warn: '[주의]', error: '[경고]' }[d.level];
      L.push(`  ${i + 1}. ${tag} ${d.title}`);
      L.push(`     ${d.msg.replace(/<[^>]+>/g, '')}`);
    });
    L.push('');
    L.push('【9. 경제성 분석】');
    L.push(`  초기 투자비(CAPEX) : ${fmt.int(eco.capex)} 만원`);
    L.push(`  연간 운영비(OPEX)  : ${fmt.int(eco.opexY)} 만원`);
    L.push(`  대체 인력 환산     : ${eco.laborEquivalent} 명 (연 ${fmt.int(eco.laborSavingY)} 만원)`);
    L.push(`  연간 순절감        : ${fmt.int(eco.netSaveY)} 만원`);
    L.push(`  투자 회수 기간     : ${isFinite(eco.paybackY) ? fmt.n(eco.paybackY, 2) + ' 년' : '회수 불가'}`);
    L.push(`  5년 누적 ROI       : ${fmt.int(eco.roi5)} 만원`);
    L.push(`  건당 처리 원가     : ${fmt.int(eco.costPerTask)} 원`);
    if (app.mc) {
      L.push('');
      L.push('【10. 몬테카를로 통계 검증】');
      L.push(`  반복 조건          : ${app.mc.runs}회 × ${app.mc.horizonMin}분`);
      L.push(`  처리량             : ${fmt.n(app.mc.uph.mean, 2)} ± ${fmt.n(app.mc.uph.ci, 2)} UPH (95% CI)`);
      L.push(`  사이클             : ${fmt.n(app.mc.cycle.mean, 2)} ± ${fmt.n(app.mc.cycle.ci, 2)} s`);
      L.push(`  가동률             : ${fmt.n(app.mc.util.mean, 2)} ± ${fmt.n(app.mc.util.ci, 2)} %`);
    }
    L.push('');
    L.push('═'.repeat(66));
    L.push('  본 리포트는 시뮬레이션 모델 기반 추정치입니다.');
    L.push('  실제 도입 시 현장 실측 검증을 병행하시기 바랍니다.');
    L.push('═'.repeat(66));

    downloadBlob(L.join('\n'), `AMR_분석리포트_${new Date().toISOString().slice(0, 10)}.txt`, 'text/plain;charset=utf-8;');
    toast('📑 종합 분석 리포트를 다운로드했습니다.', 'ok');
  }

  /* ================= 상태 저장/복원 ================= */
  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 3,
        params: app.params,
        layout: layoutData(),
        theme: document.body.className,
        snapshots: app.snapshots,
        panelWidths: $('#mainGrid').dataset.panelWidthsCustomized === 'true'
          ? { right: readPanelWidth() } : null
      }));
    } catch (e) { /* 용량 초과 시 무시 */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      return applyState(JSON.parse(raw));
    } catch (e) { console.warn('저장된 상태 복원 실패', e); return false; }
  }

  function applyState(d) {
    if (!d || !d.layout || !Array.isArray(d.layout.nodes)) return false;
    if (d.params) {
      Object.keys(d.params).forEach((k) => {
        if (M.PARAM_MAP[k]) M.sanitize(app.params, k, d.params[k]);   // 범위 검증
        else app.params[k] = d.params[k];
      });
    }
    if (!d.params || d.params.reservation_pick_limit_customized !== true) {
      M.sanitize(app.params, 'reservation_pick_limit', 1);
      app.params.reservation_pick_limit_customized = false;
    }
    if (!['reservation', 'softgap', 'none'].includes(app.params.traffic_model)) app.params.traffic_model = 'none';
    if (!['total', 'per_station'].includes(app.params.release_mode)) app.params.release_mode = 'total';
    if (!['random', 'mapped'].includes(app.params.destination_mode)) app.params.destination_mode = 'random';
    if (!['reservation', 'throughput'].includes(app.params.dispatch_port_policy)) app.params.dispatch_port_policy = 'reservation';
    if (!app.params.pick_drop_map || typeof app.params.pick_drop_map !== 'object' ||
      Array.isArray(app.params.pick_drop_map)) app.params.pick_drop_map = {};
    else app.params.pick_drop_map = clonePickDropMap(app.params.pick_drop_map);
    app.layout.fromJSON(d.layout);
    if (d.panelWidths) setPanelWidth(d.panelWidths.right);
    if (d.theme) { document.body.className = d.theme; $('#themeSelect').value = d.theme; }
    if (d.snapshots) app.snapshots = d.snapshots;

    M.PARAM_SPEC.forEach((s) => syncParamUI(s.key));
    $('#chkAutoRelease').checked = !!app.params.auto_release;
    syncAutoReleaseLabel();
    $('#chkSameReleaseInterval').checked = app.params.release_mode === 'total';
    $('#selDestinationMode').value = app.params.destination_mode;
    $('#selDispatch').value = app.params.dispatch_algo;
    $('#selTraffic').value = app.params.traffic_model;
    $('#selPortDispatchPolicy').value = app.params.dispatch_port_policy;
    $('#selChargePolicy').value = app.params.charge_policy;
    $('#chkBidir').checked = app.params.bidirectional !== false;
    $('#chkFailures').checked = !!app.params.failures;
    $('#inpSeed').value = app.params.seed;
    updateDispatchDesc();
    syncSweepRange();

    closeInspector();
    app.rend.edgeStart = null;
    app.sim.graph.rebuild();
    app.sim.reset();
    app.rend.fitToContent();
    refreshStations();
    refreshLive();
    refreshAnalytics();
    renderScenarios();
    C.retheme();
    return true;
  }

  global.addEventListener('beforeunload', saveState);

  /* ================= 부팅 ================= */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  AMR.app = app;
})(window);
