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

  /* ================= State ================= */
  const app = {
    params: M.defaultParams(),
    layout: new M.Layout(),
    sim: null, rend: null,
    running: true, speed: 4, tool: 'select',
    lastFrame: 0, uiTick: 0, slowTick: 0,
    drag: null, panning: false, panStart: null,
    snapshots: {},
    sweepRows: null, sweepSpec: null,
    mc: null,
    activeRightPane: 'r-overview'
  };

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

    const restored = loadState();
    if (!restored) {
      M.PRESETS.grid_factory.build(app.layout);
      app.sim.graph.rebuild();
      app.sim.reset();
    }

    bindEvents();
    app.rend.resize();
    app.rend.fitToContent();
    refreshStations();
    refreshAnalytics();
    requestAnimationFrame(loop);
    setInterval(saveState, 12000);
  }

  function buildPresetSelect() {
    const sel = $('#presetSelect');
    sel.innerHTML = Object.entries(M.PRESETS)
      .map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
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

    app.rend.draw();

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
    if (pane === 'r-overview') { renderJobChipsOnly(); renderPortTable(); }
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
    $('#kpiCycleSub').textContent = k.avgCycle > 0 ? `실측 ${sim.cycleSamples.length}건` : '해석 모델 추정';
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
    }

    /* --- 비용 요약 --- */
    const eco = A.economics(sim);
    $('#costQuick').innerHTML = `
      <div class="row between"><span>CAPEX (${p.fleet}대)</span><b>${fmt.int(eco.capex)} 만원</b></div>
      <div class="row between"><span>연간 순절감</span><b style="color:${eco.netSaveY > 0 ? 'var(--ok)' : 'var(--err)'}">${fmt.int(eco.netSaveY)} 만원</b></div>
      <div class="row between"><span>회수기간</span><b>${isFinite(eco.paybackY) ? fmt.n(eco.paybackY, 2) + ' 년' : '회수 불가'}</b></div>`;

    renderMatrix();
    renderCurve(curveData, demand, reqN);
    renderEco();
    renderPortTable();
    renderFleetTable();
    renderScenarios();

    if (app.activeRightPane === 'r-overview') {
      C.curveChart('chartMini', curveData.curve, demand, Math.round(p.fleet), reqN);
      C.timeChart('chartTime', sim);
    }
    if (app.activeRightPane === 'r-fleet') C.stateChart('chartState', sim);
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

    const body = rows.map((r) => {
      const tF = r.ok ? sim.graph.pathTime(r.path, p) : 0;
      const cycle = r.ok ? tF + sim.graph.pathTime(sim.graph.findPath(r.to.id, r.from.id).path, p) + p.t_pick + p.t_drop : 0;
      return `<tr>
        <td class="strong" style="color:var(--ok)">${r.from.name}</td>
        <td class="strong" style="color:var(--accent)">${r.to.name}</td>
        <td class="num strong">${r.ok ? fmt.n(r.distM, 1) + 'm' : '—'}</td>
        <td class="num">${isFinite(r.backM) ? fmt.n(r.backM, 1) + 'm' : '—'}</td>
        <td class="num">${r.ok ? fmt.n(tF, 1) + 's' : '—'}</td>
        <td class="num">${r.ok ? fmt.n(cycle, 1) + 's' : '—'}</td>
        <td class="num">${fmt.n(r.turns, 0)}°</td>
        <td>${r.ok ? '<span class="badge green">연결</span>' : '<span class="badge red">단절</span>'}</td>
      </tr>`;
    }).join('');
    $('#matrixTable').innerHTML = body || '<tr><td colspan="8" class="empty-row">피킹/드롭 스테이션을 배치하세요</td></tr>';

    $('#studioMatrix').innerHTML = rows.map((r) => {
      const tF = r.ok ? sim.graph.pathTime(r.path, p) : 0;
      const cycle = r.ok ? tF + sim.graph.pathTime(sim.graph.findPath(r.to.id, r.from.id).path, p) + p.t_pick + p.t_drop : 0;
      return `<tr>
        <td class="strong" style="color:var(--ok)">${r.from.name}</td>
        <td class="strong" style="color:var(--accent)">${r.to.name}</td>
        <td class="num strong">${r.ok ? fmt.n(r.distM, 1) + 'm' : '—'}</td>
        <td class="num">${isFinite(r.backM) ? fmt.n(r.backM, 1) + 'm' : '—'}</td>
        <td class="num">${r.ok ? fmt.n(tF, 1) + 's' : '—'}</td>
        <td class="num">${r.ok ? fmt.n(cycle, 1) + 's' : '—'}</td>
        <td class="num">${fmt.n(r.turns, 0)}°</td>
        <td class="tiny muted">${r.ok ? r.path.join(' → ') : '경로 없음'}</td>
        <td>${r.ok ? '<span class="badge green">연결</span>' : '<span class="badge red">단절</span>'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="9" class="empty-row">데이터 없음</td></tr>';

    app._matrixRows = rows;
  }

  /* ================= 감도 곡선 ================= */
  function renderCurve(data, demand, reqN) {
    const { curve, limits } = data;
    const p = app.params;
    const hard = Math.min(limits.pick, limits.drop);

    const rows = curve.map((c) => {
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
    $('#curveTable').innerHTML = rows;

    $('#studioCurve').innerHTML = curve.map((c) => {
      const cur = c.n === Math.round(p.fleet);
      return `<tr class="${cur ? 'hl' : ''}">
        <td class="strong">${c.n}대</td>
        <td class="num strong">${Math.round(c.uph)} UPH</td>
        <td class="num">${fmt.n(c.cycle, 1)}s</td>
        <td class="num">${fmt.n(c.wait, 1)}s</td>
        <td class="num">${fmt.pct(c.factor * 100, 0)}</td>
        <td>${c.bottleneck}</td>
        <td class="num">${fmt.pct((c.uph / hard) * 100, 0)}</td>
      </tr>`;
    }).join('');

    // 한계 효용 분석
    let kneeN = null;
    for (let i = 1; i < curve.length; i++) {
      const gain = curve[i].uph - curve[i - 1].uph;
      const firstGain = curve[1] ? curve[1].uph - curve[0].uph : 1;
      if (firstGain > 0 && gain / firstGain < 0.35 && !kneeN) kneeN = curve[i].n;
    }
    $('#curveInsight').innerHTML =
      `📌 <b>한계 효용 변곡점: ${kneeN ? kneeN + '대' : '미도달'}</b> — 이 지점을 넘으면 1대 추가당 처리량 증가가 초기 대비 35% 미만으로 떨어집니다. ` +
      `포트 물리 한계는 <b>${Math.round(hard)} UPH</b>(${limits.pick <= limits.drop ? '피킹' : '드롭'} 측)이며, ` +
      `현재 수요 <b>${Math.round(demand)} UPH</b>는 한계의 <b>${fmt.pct((demand / hard) * 100, 0)}</b> 수준입니다.`;

    if (app.activeRightPane === 'r-curve') C.curveChart('chartCurve', curve, demand, Math.round(p.fleet), reqN);
    if ($('#studioModal').classList.contains('open')) C.curveChart('chartCurveBig', curve, demand, Math.round(p.fleet), reqN);

    app._curve = curve;
    app._limits = limits;
  }

  /* ================= 경제성 ================= */
  function renderEco() {
    const sim = app.sim, p = app.params;
    const eco = A.economics(sim);
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
    const maxN = Math.max(12, Math.round(p.fleet) + 6);
    for (let n = 1; n <= maxN; n++) rows.push(A.economics(sim, n));
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

    if (app.activeRightPane === 'r-eco') C.ecoChart('chartEco', rows);
  }

  /* ================= 테이블들 ================= */
  function renderPortTable() {
    const L = app.sim.layout;
    const ns = [...L.byType('pick'), ...L.byType('drop'), ...L.byType('charge')];
    $('#portTable').innerHTML = ns.map((n) => {
      const t = n.type === 'pick' ? 'green' : n.type === 'drop' ? 'amber' : 'red';
      return `<tr>
        <td><span class="badge ${t}">${M.NODE_TYPES[n.type].label}</span> <b>${n.name}</b></td>
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
      <span class="chip">총 주행 <b>${fmt.int(k.distanceM / 1000)}km</b></span>`;

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
        <td class="tiny muted">${r.task}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty-row">차량 없음</td></tr>';

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
        <td class="tiny muted">${r.task}</td>
      </tr>`).join('');
  }

  function renderJobChipsOnly() {
    const sim = app.sim;
    const pend = sim.jobs.filter((j) => j.status === 'pending').length;
    const act = sim.jobs.filter((j) => j.status !== 'done' && j.status !== 'pending').length;
    const done = sim.metrics.completed;
    $('#jobChips').innerHTML = `
      <span class="chip">대기 <b>${pend}</b></span>
      <span class="chip warn">진행 <b>${act}</b></span>
      <span class="chip ok">완료 <b>${done}</b></span>
      <span class="chip">누적발생 <b>${sim.metrics.released}</b></span>`;
  }

  function renderJobTable() {
    const sim = app.sim;
    renderJobChipsOnly();
    const show = sim.jobs.filter((j) => j.status !== 'done').slice(-40).reverse();
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
      sel.innerHTML = nodes.map((n) => `<option value="${n.id}">${n.name}</option>`).join('')
        || '<option value="">없음</option>';
    };
    fill($('#selFrom'), L.byType('pick'));
    fill($('#selTo'), L.byType('drop'));
  }

  /* ================= 시나리오 ================= */
  function renderScenarios() {
    const keys = ['A', 'B', 'C'];
    const host = $('#scenarioGrid');
    const results = {};
    keys.forEach((k) => {
      const snap = app.snapshots[k];
      if (snap) results[k] = A.evaluateScenario(app.sim, snap.params);
    });
    const valid = Object.values(results).filter((r) => r);
    const bestUph = valid.length ? Math.max(...valid.map((r) => r.uph)) : 0;

    host.innerHTML = keys.map((k) => {
      const snap = app.snapshots[k], r = results[k];
      if (!snap || !r) {
        return `<div class="scenario"><h4>시나리오 ${k}</h4><div class="tiny muted">저장된 설정 없음</div></div>`;
      }
      const best = r.uph >= bestUph - 0.5;
      return `<div class="scenario ${best ? 'best' : ''}">
        <h4>시나리오 ${k}${best ? ' <span class="badge green">최고</span>' : ''}</h4>
        <div class="row"><span>AMR</span><span>${snap.params.fleet}대</span></div>
        <div class="row"><span>처리량</span><span>${Math.round(r.uph)} UPH</span></div>
        <div class="row"><span>수요</span><span>${Math.round(r.demand)} UPH</span></div>
        <div class="row"><span>서비스율</span><span style="color:${r.service >= 98 ? 'var(--ok)' : 'var(--warn)'}">${fmt.pct(Math.min(999, r.service), 0)}</span></div>
        <div class="row"><span>사이클</span><span>${fmt.n(r.cycle, 0)}s</span></div>
        <div class="row"><span>소요대수</span><span>${r.reqFleet || '—'}</span></div>
        <div class="row"><span>제약</span><span>${r.bottleneck}</span></div>
        <div class="row"><span>건당원가</span><span>${fmt.int(r.costPerTask)}원</span></div>
        <div class="row"><span>회수</span><span>${isFinite(r.payback) ? fmt.n(r.payback, 2) + '년' : '—'}</span></div>
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
        if (t.dataset.pane === 's-curve' || t.dataset.pane === 's-time') setTimeout(refreshAnalytics, 50);
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
      preset.build(app.layout);
      app.sim.graph.rebuild();
      app.sim.reset();
      app.rend.fitToContent();
      refreshStations();
      refreshAnalytics();
      toast(`🏭 <b>${preset.label}</b> 레이아웃 적용 — ${preset.desc}`, 'ok');
    });

    /* --- 저장/불러오기 --- */
    $('#btnSave').addEventListener('click', () => {
      const data = { version: 2, params: app.params, layout: app.layout.toJSON(), theme: document.body.className };
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
          applyState(d);
          toast('📂 설정을 불러왔습니다.', 'ok');
        } catch (err) { toast('⚠️ JSON 파싱 실패: ' + err.message, 'err'); }
      };
      r.readAsText(f);
      e.target.value = '';
    });

    /* --- 리포트 --- */
    $('#btnReport').addEventListener('click', exportReport);
    $('#btnHelp').addEventListener('click', () => $('#helpModal').classList.add('open'));
    $$('[data-close-modal]').forEach((b) => b.addEventListener('click', (e) => e.target.closest('.modal').classList.remove('open')));
    $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); }));
    $('#btnStudio').addEventListener('click', () => {
      $('#studioModal').classList.add('open');
      setTimeout(() => { refreshAnalytics(); C.timeChart('chartTimeBig', app.sim); }, 60);
    });
    $('#btnStudioCsv').addEventListener('click', exportAllCsv);

    /* --- 수요 --- */
    $('#chkAutoRelease').addEventListener('change', (e) => {
      app.params.auto_release = e.target.checked;
      const t = $('#txtAutoRelease');
      t.textContent = e.target.checked ? 'ON' : 'OFF';
      t.style.color = e.target.checked ? 'var(--ok)' : 'var(--text-faint)';
      refreshAnalytics();
    });
    $('#selReleaseMode').addEventListener('change', (e) => {
      app.params.release_mode = e.target.value;
      app.sim.stationTimers = {};
      app.sim.releaseTimer = 0;
      refreshAnalytics();
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
      app.sim.jobs = app.sim.jobs.filter((j) => j.status !== 'pending');
      app.layout.byType('pick').forEach((n) => (n.buffer = 0));
      renderJobTable();
      toast('대기 작업을 비웠습니다.');
    });
    $('#btnCsvUp').addEventListener('click', () => $('#fileCsv').click());
    $('#fileCsv').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        let added = 0, skipped = 0;
        r.result.split(/\r?\n/).forEach((line, i) => {
          if (!line.trim()) return;
          if (i === 0 && /from/i.test(line)) return;
          const [a, b, qty] = line.split(',').map((s) => (s || '').trim());
          const fn = app.layout.node(a), tn = app.layout.node(b);
          if (fn && tn) {
            const q = Math.max(1, parseInt(qty, 10) || 1);
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
    $('#chkBidir').addEventListener('change', (e) => {
      app.params.bidirectional = e.target.checked;
      app.sim.graph.rebuild();
      refreshAnalytics();
    });
    $('#selChargePolicy').addEventListener('change', (e) => { app.params.charge_policy = e.target.value; });
    $('#chkFailures').addEventListener('change', (e) => {
      app.params.failures = e.target.checked;
      app.sim.robots.forEach((r) => { r.nextFault = e.target.checked ? app.sim.rng.exp(app.params.mtbf * 60) : Infinity; });
      refreshAnalytics();
    });
    $('#btnReseed').addEventListener('click', () => {
      const v = parseInt($('#inpSeed').value, 10);
      app.params.seed = isFinite(v) ? v : Date.now() % 1e8;
      $('#inpSeed').value = app.params.seed;
      app.sim.rng.reset(app.params.seed);
      toast(`🎲 시드를 ${app.params.seed}로 설정했습니다.`, 'ok');
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
    $('#btnZoomIn').addEventListener('click', () => app.rend.zoom(1.22));
    $('#btnZoomOut').addEventListener('click', () => app.rend.zoom(0.82));
    $('#btnFit').addEventListener('click', () => app.rend.fitToContent());

    /* --- 도구 --- */
    $$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

    $('#btnAutoLink').addEventListener('click', autoLink);
    $('#btnClearMap').addEventListener('click', () => {
      if (!confirm('맵의 모든 노드와 통로를 삭제할까요?')) return;
      app.layout.reset();
      app.sim.graph.rebuild();
      app.sim.reset();
      refreshStations(); refreshAnalytics();
      toast('🧹 맵을 초기화했습니다.');
    });

    /* --- 플릿 조정 --- */
    $('#btnFleetPlus').addEventListener('click', () => setParam('fleet', app.params.fleet + 1));
    $('#btnFleetMinus').addEventListener('click', () => setParam('fleet', app.params.fleet - 1));

    /* --- 패널 --- */
    $('#btnWide').addEventListener('click', () => {
      $('#mainGrid').classList.toggle('right-wide');
      setTimeout(() => app.rend.resize(), 240);
    });
    $('#btnCollapseRight').addEventListener('click', () => toggleSide('right'));
    $('#floatRight').addEventListener('click', () => toggleSide('right'));
    $('#floatLeft').addEventListener('click', () => toggleSide('left'));

    /* --- CSV --- */
    $('#btnMatrixCsv').addEventListener('click', exportMatrixCsv);
    $('#btnCurveCsv').addEventListener('click', exportCurveCsv);
    $('#btnSweepCsv').addEventListener('click', exportSweepCsv);

    /* --- 실험실 --- */
    $('#btnSweep').addEventListener('click', runSweep);
    $('#btnMonteCarlo').addEventListener('click', runMonteCarlo);
    $$('[data-snap]').forEach((b) => b.addEventListener('click', () => {
      app.snapshots[b.dataset.snap] = { params: { ...app.params } };
      renderScenarios();
      toast(`📌 시나리오 ${b.dataset.snap}에 현재 설정을 저장했습니다.`, 'ok');
    }));
    $('#btnClearSnap').addEventListener('click', () => { app.snapshots = {}; renderScenarios(); });

    /* --- 인스펙터 --- */
    $('#inspClose').addEventListener('click', closeInspector);
    $('#inspRename').addEventListener('click', () => {
      const n = app.rend.selected; if (!n) return;
      const v = prompt('스테이션 이름', n.name);
      if (v) { n.name = v.slice(0, 24); refreshStations(); refreshAnalytics(); showInspector(n); }
    });
    $('#inspPriority').addEventListener('click', () => {
      const n = app.rend.selected; if (!n) return;
      const v = prompt('수요 가중치 (1=기본, 2=2배 빈도)', n.priority);
      const f = parseFloat(v);
      if (isFinite(f) && f > 0) { n.priority = clamp(f, 0.1, 10); showInspector(n); toast(`⚖ ${n.name} 가중치 ${n.priority}`); }
    });
    $('#inspDelete').addEventListener('click', () => {
      const n = app.rend.selected; if (!n) return;
      deleteNode(n);
      closeInspector();
    });

    bindCanvas();
    bindKeyboard();
    global.addEventListener('resize', () => { app.rend.resize(); });
  }

  function togglePlay() {
    app.running = !app.running;
    const b = $('#btnPlay');
    b.textContent = app.running ? '⏸ 일시정지' : '▶ 재생';
    b.classList.toggle('primary', app.running);
  }

  function setSpeed(s) {
    app.speed = s;
    $$('[data-speed]').forEach((b) => b.classList.toggle('active', +b.dataset.speed === s));
  }

  function setTool(t) {
    app.tool = t;
    app.rend.edgeStart = null;
    $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    const cv = $('#simCanvas');
    cv.style.cursor = t === 'pan' ? 'grab' : t === 'delete' ? 'crosshair' : t === 'select' ? 'default' : 'crosshair';
  }

  function toggleSide(side) {
    const g = $('#mainGrid');
    const cls = side + '-off';
    g.classList.toggle(cls);
    const on = g.classList.contains(cls);
    $('#' + side + 'Panel').classList.toggle('hidden', on);
    $('#float' + (side === 'left' ? 'Left' : 'Right')).classList.toggle('show', on);
    setTimeout(() => app.rend.resize(), 240);
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
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const wp = app.rend.toWorld(sx, sy);

      if (e.button === 2 || e.button === 1 || app.tool === 'pan') {
        app.panning = true;
        app.panStart = { x: sx - app.rend.view.x, y: sy - app.rend.view.y };
        cv.style.cursor = 'grabbing';
        return;
      }

      const hit = app.rend.nodeAt(wp);

      switch (app.tool) {
        case 'select':
          if (hit) { app.drag = hit; app.rend.selected = hit; showInspector(hit); }
          else { app.rend.selected = null; closeInspector(); }
          break;
        case 'delete':
          if (hit) deleteNode(hit);
          else {
            const ed = app.rend.edgeAt(wp, 12);
            if (ed) { app.layout.removeEdge(ed); afterLayoutChange(); toast('통로를 삭제했습니다.'); }
          }
          break;
        case 'edge':
          if (hit) {
            if (!app.rend.edgeStart) { app.rend.edgeStart = hit; }
            else if (app.rend.edgeStart.id !== hit.id) {
              const dir = e.shiftKey ? 'ab' : 'both';
              const ed = app.layout.addEdge(app.rend.edgeStart.id, hit.id, dir);
              app.rend.edgeStart = null;
              if (ed) { afterLayoutChange(); toast(dir === 'ab' ? '➡ 일방통행 통로 생성' : '🔗 양방향 통로 생성', 'ok'); }
              else toast('이미 연결된 구간입니다.', 'warn');
            }
          }
          break;
        case 'pick': case 'drop': case 'charge': case 'park': case 'waypoint': {
          const n = app.layout.addNode(app.tool, wp.x, wp.y);
          // 가장 가까운 노드에 자동 연결
          const others = app.layout.nodes.filter((x) => x !== n);
          if (others.length) {
            let best = others[0], bd = Infinity;
            others.forEach((o) => { const d = Math.hypot(o.x - n.x, o.y - n.y); if (d < bd) { bd = d; best = o; } });
            if (bd < 320) app.layout.addEdge(n.id, best.id);
          }
          afterLayoutChange();
          app.rend.selected = n;
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
        app.drag.x = wp.x; app.drag.y = wp.y;
        app.sim.graph.rebuild();
        return;
      }
      app.rend.hover = app.rend.nodeAt(wp);
      app.rend.hoverEdge = (!app.rend.hover && app.tool === 'delete') ? app.rend.edgeAt(wp, 12) : null;
      app.rend.ghost = ['pick', 'drop', 'charge', 'park', 'waypoint'].includes(app.tool)
        ? { type: app.tool, x: wp.x, y: wp.y } : null;
    });

    global.addEventListener('mouseup', () => {
      if (app.panning) {
        app.panning = false;
        $('#simCanvas').style.cursor = app.tool === 'pan' ? 'grab' : 'default';
      }
      if (app.drag) { app.drag = null; afterLayoutChange(); }
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
    app.sim.robots.forEach((r) => {
      if (r.atNode === n.id || r.nextNode === n.id || (r.job && (r.job.from === n.id || r.job.to === n.id))) {
        r.abortJob();
        const safe = app.layout.nodes.find((x) => x !== n);
        if (safe) { r.atNode = safe.id; r.x = safe.x; r.y = safe.y; }
      }
    });
    app.sim.jobs = app.sim.jobs.filter((j) => j.from !== n.id && j.to !== n.id);
    app.layout.removeNode(n.id);
    if (app.rend.selected === n) { app.rend.selected = null; closeInspector(); }
    afterLayoutChange();
    toast(`🗑 <b>${n.id}</b> 삭제`);
  }

  function autoLink() {
    const L = app.layout, ns = L.nodes;
    if (ns.length < 2) { toast('노드가 부족합니다.', 'warn'); return; }
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
    afterLayoutChange();
    toast(added ? `🪄 통로 ${added}개 자동 생성` : '추가할 통로가 없습니다.', added ? 'ok' : 'warn');
  }

  function showInspector(n) {
    const sim = app.sim;
    $('#inspector').classList.add('show');
    $('#inspTitle').textContent = `${M.NODE_TYPES[n.type].label} · ${n.id}`;
    const deg = (sim.graph.adj.get(n.id) || []).length;
    let extra = '';
    if (n.type === 'pick') extra = `<div class="insp-row"><span>적체 화물</span><b>${n.buffer}건</b></div>`;
    if (n.type === 'pick' || n.type === 'drop') {
      extra += `<div class="insp-row"><span>처리 누적</span><b>${n.processed}건</b></div>
                <div class="insp-row"><span>수요 가중치</span><b>${n.priority}×</b></div>`;
    }
    $('#inspBody').innerHTML = `
      <div class="insp-row"><span>이름</span><b>${n.name}</b></div>
      <div class="insp-row"><span>좌표</span><b>${Math.round(n.x)}, ${Math.round(n.y)}</b></div>
      <div class="insp-row"><span>연결 통로</span><b>${deg}개</b></div>
      <div class="insp-row"><span>현재 점유</span><b>${n.occupants.length}/${app.params.port_cap}${n.queue ? ` (대기 ${n.queue})` : ''}</b></div>
      <div class="insp-row"><span>누적 대기</span><b>${fmt.n(n.waitAccum / 60, 1)}분</b></div>
      ${extra}`;
  }

  function closeInspector() { $('#inspector').classList.remove('show'); app.rend.selected = null; }

  /* ================= 키보드 ================= */
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (/input|select|textarea/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
      if (e.key === 'Escape') {
        $$('.modal.open').forEach((m) => m.classList.remove('open'));
        app.rend.edgeStart = null; closeInspector();
        return;
      }
      const speeds = { '1': 1, '2': 4, '3': 10, '4': 30, '5': 120 };
      if (speeds[e.key]) { setSpeed(speeds[e.key]); return; }
      const tools = { v: 'select', h: 'pan', p: 'pick', d: 'drop', c: 'charge', n: 'waypoint', e: 'edge', x: 'delete' };
      if (tools[k]) { setTool(tools[k]); return; }
      if (k === 'f') { app.rend.fitToContent(); return; }
      if (e.key === '[') { toggleSide('left'); return; }
      if (e.key === ']') { toggleSide('right'); return; }
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

  function runMonteCarlo() {
    const runs = clamp(parseInt($('#mcRuns').value, 10) || 6, 1, 30);
    const horizon = clamp(parseInt($('#mcHorizon').value, 10) || 45, 5, 300);
    const est = runs * horizon;
    if (est > 900 && !confirm(`총 ${runs}회 × ${horizon}분 시뮬레이션은 수 초~수십 초가 걸릴 수 있습니다. 진행할까요?`)) return;

    const btn = $('#btnMonteCarlo');
    btn.disabled = true; btn.textContent = '⏳ 계산 중...';
    $('#mcProgress').style.display = '';
    $('#mcStatus').textContent = '초기화 중...';

    setTimeout(() => {
      try {
        const mc = A.monteCarlo(app.sim, { runs, horizonMin: horizon, dt: 0.5 }, (i, n, k) => {
          $('#mcProgress').firstElementChild.style.width = (i / n) * 100 + '%';
          $('#mcStatus').textContent = `Run ${i}/${n} — ${Math.round(k.measuredUPH)} UPH`;
        });
        app.mc = mc;
        renderMc(mc);
        toast(`🎲 몬테카를로 ${runs}회 완료 — 평균 ${fmt.n(mc.uph.mean, 1)} ± ${fmt.n(mc.uph.ci, 1)} UPH`, 'ok');
      } catch (err) {
        toast('⚠️ 실행 실패: ' + err.message, 'err');
        console.error(err);
      } finally {
        btn.disabled = false; btn.textContent = '🎲 몬테카를로 실행';
        $('#mcProgress').style.display = 'none';
      }
    }, 60);
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
    const rows = app._matrixRows || [];
    if (!rows.length) { toast('내보낼 데이터가 없습니다.', 'warn'); return; }
    const p = app.params, g = app.sim.graph;
    const data = rows.map((r) => {
      const tF = r.ok ? g.pathTime(r.path, p) : 0;
      const back = r.ok ? g.pathTime(g.findPath(r.to.id, r.from.id).path, p) : 0;
      return [r.from.id, r.from.name, r.to.id, r.to.name,
        r.ok ? r.distM.toFixed(2) : '', isFinite(r.backM) ? r.backM.toFixed(2) : '',
        tF.toFixed(2), (tF + back + p.t_pick + p.t_drop).toFixed(2),
        r.turns.toFixed(0), r.ok ? r.path.join(' > ') : '', r.ok ? '연결' : '단절'];
    });
    downloadBlob(toCSV(
      ['출발ID', '출발명', '도착ID', '도착명', '적재거리(m)', '복귀거리(m)', '적재주행(s)', '왕복사이클(s)', '누적선회(deg)', '경유경로', '상태'],
      data), `AMR_거리매트릭스_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
    toast('📥 거리 매트릭스 CSV 다운로드', 'ok');
  }

  function exportCurveCsv() {
    const curve = app._curve || [];
    if (!curve.length) return;
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

  function exportReport() {
    const sim = app.sim, p = app.params, k = sim.kpi();
    const diag = A.diagnose(sim);
    const eco = A.economics(sim);
    const cm = A.cycleModel(sim);
    const curve = app._curve || [];
    const limits = sim.portLimits();
    const theme = document.body.className;

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
    L.push('');
    L.push('【2. 설계 파라미터】');
    L.push(`  최고속/가속/감속   : ${p.v_max} m/s / ${p.accel} / ${p.decel} m/s²`);
    L.push(`  도킹 (픽/드롭)     : ${p.t_pick}s / ${p.t_drop}s (CV ${p.cv_service})`);
    L.push(`  배차 알고리즘      : ${AMR.dispatch.ALGOS[p.dispatch_algo].label}`);
    L.push(`  교통 모델          : ${p.traffic_model}`);
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
    L.push('【4. 해석 모델 사이클 분해】');
    if (cm.ok) {
      L.push(`  평균 적재거리      : ${fmt.n(cm.loadedM, 1)} m`);
      L.push(`  평균 공차거리      : ${fmt.n(cm.emptyM, 1)} m`);
      L.push(`  주행 시간          : ${fmt.n(cm.tTravel, 1)} s`);
      L.push(`  도킹 시간          : ${fmt.n(cm.tDock, 1)} s`);
      L.push(`  충전 분할 상각     : ${fmt.n(cm.tCharge, 1)} s`);
      L.push(`  → 이론 사이클      : ${fmt.n(cm.tCycle, 1)} s`);
      L.push(`  사이클당 에너지    : ${fmt.n(cm.whPerCycle, 1)} Wh (1충전 ${fmt.n(cm.cyclesPerCharge, 0)}사이클)`);
    }
    L.push('');
    L.push('【5. 시뮬레이션 실측 결과】');
    L.push(`  시뮬레이션 시간    : ${fmt.clock(sim.t)}`);
    L.push(`  완료 / 발생        : ${k.completed} / ${sim.metrics.released} 건`);
    L.push(`  실측 처리량        : ${fmt.n(k.measuredUPH, 1)} UPH`);
    L.push(`  서비스율           : ${fmt.pct(k.serviceRate, 1)}`);
    L.push(`  평균 사이클        : ${fmt.n(k.avgCycle, 1)} s (P90 ${fmt.n(k.p90Cycle, 1)} s)`);
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
        version: 2,
        params: app.params,
        layout: app.layout.toJSON(),
        theme: document.body.className,
        snapshots: app.snapshots
      }));
    } catch (e) { /* 용량 초과 시 무시 */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      return applyState(JSON.parse(raw));
    } catch (e) { return false; }
  }

  function applyState(d) {
    if (!d || !d.layout) return false;
    if (d.params) Object.keys(d.params).forEach((k) => { app.params[k] = d.params[k]; });
    app.layout.fromJSON(d.layout);
    if (d.theme) { document.body.className = d.theme; $('#themeSelect').value = d.theme; }
    if (d.snapshots) app.snapshots = d.snapshots;

    M.PARAM_SPEC.forEach((s) => syncParamUI(s.key));
    $('#chkAutoRelease').checked = app.params.auto_release;
    $('#txtAutoRelease').textContent = app.params.auto_release ? 'ON' : 'OFF';
    $('#selReleaseMode').value = app.params.release_mode;
    $('#selDispatch').value = app.params.dispatch_algo;
    $('#selTraffic').value = app.params.traffic_model;
    $('#selChargePolicy').value = app.params.charge_policy;
    $('#chkBidir').checked = app.params.bidirectional !== false;
    $('#chkFailures').checked = !!app.params.failures;
    $('#inpSeed').value = app.params.seed;
    updateDispatchDesc();

    app.sim.graph.rebuild();
    app.sim.reset();
    app.rend.fitToContent();
    refreshStations();
    refreshAnalytics();
    C.retheme();
    return true;
  }

  global.addEventListener('beforeunload', saveState);

  /* ================= 부팅 ================= */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  AMR.app = app;
})(window);
