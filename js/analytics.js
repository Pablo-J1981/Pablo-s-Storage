/* =========================================================
 * AMR Capa Simulator PRO — Analytics
 * 해석적 Capa 모델(큐잉 이론) · 소요대수 역산 · 병목 진단 ·
 * 파라미터 스윕 / 몬테카를로 실험실 · 경제성(ROI)
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});
  const { stat, clamp } = AMR.util;

  /* =======================================================
   * 1) 해석적 사이클 타임 모델
   *    실제 레이아웃 From-To 매트릭스 + 사다리꼴 속도 프로파일
   *    payload>1 이면 "항상 가득 싣는다"는 가정의 상한 모델
   * ======================================================= */
  function cycleModel(sim) {
    const g = sim.graph, p = sim.params, L = sim.layout;
    const picks = L.byType('pick'), drops = L.byType('drop');
    if (!picks.length || !drops.length) {
      return { ok: false, loadedM: 0, emptyM: 0, tTravel: 0, tDock: 0, tCycle: 0, reachable: 0 };
    }

    let loadedSum = 0, emptySum = 0, tLoaded = 0, tEmpty = 0, pairs = 0;
    picks.forEach((pk) => drops.forEach((d) => {
      const f = g.findPath(pk.id, d.id);
      const b = g.findPath(d.id, pk.id);
      if (!f.ok || !b.ok) return;
      loadedSum += g.pxToM(f.px);
      emptySum += g.pxToM(b.px);
      tLoaded += g.pathTime(f.path, p);
      tEmpty += g.pathTime(b.path, p);
      pairs++;
    }));

    if (!pairs) return { ok: false, loadedM: 0, emptyM: 0, tTravel: 0, tDock: 0, tCycle: 0, reachable: 0 };

    const loadedM = loadedSum / pairs;
    // 공차 주행은 배차 최적화로 평균 왕복보다 짧음(최근접 효과 ≈ 0.72)
    const emptyFactor = p.dispatch_algo === 'hungarian' ? 0.66 : p.dispatch_algo === 'nearest' ? 0.72 : 0.88;
    const emptyM = (emptySum / pairs) * emptyFactor;
    const tTravel = tLoaded / pairs + (tEmpty / pairs) * emptyFactor;
    // 적재·하역 시간은 수량에 비례
    const tDock = (p.t_pick + p.t_drop) * p.payload;

    // 충전 오버헤드: 에너지 수지로 산출
    const wMove = p.p_move + p.p_load_add * 0.5;
    const whPerCycle = (wMove * tTravel + p.p_idle * tDock) / 3600;
    const usableWh = p.bat_kwh * 1000 * ((p.bat_max - p.bat_min) / 100);
    const cyclesPerCharge = Math.max(1, usableWh / Math.max(0.01, whPerCycle));
    const chargeSec = (usableWh / Math.max(1, p.charge_kw * 1000)) * 3600;
    const tCharge = chargeSec / cyclesPerCharge;

    return {
      ok: true, loadedM, emptyM, tTravel, tDock, tCharge,
      tCycle: tTravel + tDock + tCharge,
      whPerCycle, cyclesPerCharge, chargeSec, pairs
    };
  }

  /* =======================================================
   * 2) 혼잡 모델 (차량 밀도 기반 속도 저하)
   *    Greenshields 류: v_eff = v * (1 - (n/n_jam)^a)
   * ======================================================= */
  function congestionFactor(sim, fleet) {
    const g = sim.graph, p = sim.params, L = sim.layout;
    let laneM = 0;
    L.edges.forEach((e) => {
      const a = L.node(e.a), b = L.node(e.b);
      if (a && b) laneM += g.pxToM(Math.hypot(a.x - b.x, a.y - b.y)) * (e.lanes || 1);
    });
    if (laneM <= 0) return 1;
    const vehicleFootprint = p.safety_gap + 1.2;    // 차량 1대 점유 길이(m)
    const nJam = Math.max(2, laneM / vehicleFootprint);
    const density = clamp(fleet / nJam, 0, 0.95);
    // 교차점(노드) 간섭 보정
    const junctions = L.nodes.filter((n) => (g.adj.get(n.id) || []).length >= 3).length;
    const junctionPenalty = junctions > 0 ? clamp(1 - (fleet / (junctions * 6)) * 0.12, 0.55, 1) : 1;
    return clamp((1 - Math.pow(density, 1.35)) * junctionPenalty, 0.18, 1);
  }

  /* =======================================================
   * 3) 포트 큐잉 (M/M/c) — 대기시간 해석 추정
   * ======================================================= */
  function portQueueWait(arrivalUPH, serviceSec, servers) {
    if (arrivalUPH <= 0 || servers <= 0) return 0;
    const mu = 3600 / Math.max(0.5, serviceSec);   // 서버당 처리율 (/h)
    const a = arrivalUPH / mu;                      // 제공부하 (Erlang)
    if (a >= servers) return 999;                   // 포화
    const pw = stat.erlangC(servers, a);
    const wq = (pw / (servers * mu - arrivalUPH)) * 3600;  // 초
    return Math.max(0, wq);
  }

  /* =======================================================
   * 4) 투입 대수별 Throughput 예측 곡선 (혼잡 + 포트 병목 반영)
   * ======================================================= */
  function throughputCurve(sim, maxFleet) {
    const p = sim.params, L = sim.layout;
    const cm = cycleModel(sim);
    const limits = sim.portLimits();
    const picks = Math.max(1, L.byType('pick').length);
    const drops = Math.max(1, L.byType('drop').length);
    const oee = p.oee / 100;
    const avail = p.failures ? (p.mtbf / (p.mtbf + p.mttr)) : 1;

    const out = [];
    const N = Math.max(4, maxFleet);
    for (let n = 1; n <= N; n++) {
      if (!cm.ok) { out.push({ n, uph: 0, cycle: 0, wait: 0, factor: 1, bottleneck: '경로 단절' }); continue; }
      const cf = congestionFactor(sim, n);
      // 혼잡 시 주행시간만 증가
      const travel = cm.tTravel / cf;
      let cycle = travel + cm.tDock + cm.tCharge;

      // 포트 대기: 반복 수렴 (도착률 ↔ 대기시간 상호의존)
      // 포트 도착은 "운행" 단위(= 화물수/payload), 서비스시간은 payload 배
      let uph = (n * 3600 / cycle) * oee * avail * p.payload;
      let wait = 0;
      for (let it = 0; it < 12; it++) {
        const perPick = uph / picks, perDrop = uph / drops;
        const wPick = portQueueWait(perPick / p.payload, p.t_pick * p.payload, p.port_cap);
        const wDrop = portQueueWait(perDrop / p.payload, p.t_drop * p.payload, p.port_cap);
        wait = Math.min(600, wPick + wDrop);
        const c2 = travel + cm.tDock + cm.tCharge + wait;
        const u2 = (n * 3600 / c2) * oee * avail * p.payload;
        if (Math.abs(u2 - uph) < 0.4) { uph = u2; cycle = c2; break; }
        uph = uph * 0.5 + u2 * 0.5;
        cycle = c2;
      }
      // 하드 상한: 포트 물리 한계
      const hard = Math.min(limits.pick, limits.drop);
      let bottleneck = 'AMR 대수';
      if (uph >= hard * 0.985) { uph = hard; bottleneck = limits.pick <= limits.drop ? '피킹 포트' : '드롭 포트'; }
      else if (cf < 0.65) bottleneck = '통로 혼잡';
      else if (wait > cycle * 0.2) bottleneck = '포트 대기';
      out.push({ n, uph, cycle, wait, factor: cf, bottleneck });
    }
    return { curve: out, model: cm, limits };
  }

  /* =======================================================
   * 5) 목표 UPH 달성 소요 대수 역산 (곡선 위 최초 충족점)
   * ======================================================= */
  function requiredFleet(sim, targetUPH, maxFleet = 60) {
    const { curve, model, limits } = throughputCurve(sim, maxFleet);
    if (!targetUPH || targetUPH <= 0) return { n: 1, feasible: true, curve, model, limits };
    const hard = Math.min(limits.pick, limits.drop);
    if (targetUPH > hard) {
      return { n: Infinity, feasible: false, reason: 'port', hard, curve, model, limits };
    }
    for (const pt of curve) if (pt.uph >= targetUPH) return { n: pt.n, feasible: true, point: pt, curve, model, limits };
    return { n: Infinity, feasible: false, reason: 'congestion', curve, model, limits };
  }

  /* =======================================================
   * 6) 병목 진단 엔진
   * ======================================================= */
  function diagnose(sim) {
    const p = sim.params, L = sim.layout, k = sim.kpi();
    const limits = sim.portLimits();
    const demand = sim.demandUPH();
    const req = requiredFleet(sim, demand);
    const items = [];

    const conn = sim.graph.connectivityReport();
    if (conn.isolated.length) {
      items.push({ level: 'error', title: '고립 노드 존재',
        msg: `연결 간선이 없는 노드 ${conn.isolated.length}개(${conn.isolated.slice(0, 5).join(', ')}${conn.isolated.length > 5 ? '…' : ''}). 🔗 연결 도구로 통로를 이어주세요.` });
    }
    if (conn.broken.length) {
      items.push({ level: 'error', title: 'From-To 경로 단절',
        msg: `도달 불가 구간 ${conn.broken.length}쌍. 일방통행 방향이 반대이거나 통로가 끊겼습니다.` +
          (p.bidirectional === false ? ' <b>양방향 통행 허용이 꺼져 있어</b> 모든 통로가 일방통행입니다 — 통로를 클릭해 방향을 지정하세요.' : '') });
    }

    if (demand > limits.pick) {
      items.push({ level: 'error', title: '피킹 포트 물리 한계 초과',
        msg: `유입 <b>${Math.round(demand)} UPH</b> > 피킹 한계 <b>${Math.round(limits.pick)} UPH</b>. AMR을 늘려도 처리량이 증가하지 않습니다. <b>피킹 스테이션 증설</b> 또는 도킹시간 단축이 유일한 해법입니다.` });
    } else if (demand > limits.pick * 0.85) {
      items.push({ level: 'warn', title: '피킹 포트 포화 임박',
        msg: `포트 이용률 ${Math.round((demand / limits.pick) * 100)}%. 85% 초과 시 대기행렬이 급격히 증가합니다(큐잉 이론).` });
    }
    if (demand > limits.drop) {
      items.push({ level: 'error', title: '드롭 포트 한계 초과',
        msg: `드롭 한계 <b>${Math.round(limits.drop)} UPH</b>를 초과합니다. 드롭 포트 증설이 필요합니다.` });
    }

    const cf = congestionFactor(sim, p.fleet);
    if (cf < 0.6) {
      items.push({ level: 'warn', title: '통로 혼잡 심각',
        msg: `현재 ${p.fleet}대 투입 시 유효속도가 설계값의 <b>${Math.round(cf * 100)}%</b>로 저하됩니다. 통로를 클릭해 <b>차선 수</b>를 늘리거나 일방통행 루프 전환을 검토하세요.` });
    }

    if (k.blockShare > 12) {
      items.push({ level: 'warn', title: '정체 손실 과다',
        msg: `주행 시간의 <b>${k.blockShare.toFixed(1)}%</b>가 교착/감속으로 소모되고 있습니다. 차간 안전거리(${p.safety_gap}m) 축소 또는 우회 경로 추가를 권장합니다.` });
    }

    if (req.feasible && isFinite(req.n)) {
      if (p.fleet < req.n) {
        items.push({ level: 'warn', title: `AMR ${req.n - p.fleet}대 부족`,
          msg: `유입 ${Math.round(demand)} UPH 처리에는 <b>${req.n}대</b>가 필요합니다(혼잡·포트대기 반영). 현재 ${p.fleet}대.` });
      } else if (p.fleet > req.n + 2) {
        items.push({ level: 'info', title: `AMR ${p.fleet - req.n}대 과투입`,
          msg: `${req.n}대로 동일 처리량 달성 가능합니다. 감차 시 연간 약 <b>${((p.fleet - req.n) * p.cost_oper).toLocaleString()}만원</b> 운영비 절감.` });
      } else {
        items.push({ level: 'ok', title: '적정 밸런스',
          msg: `투입 ${p.fleet}대 / 권장 ${req.n}대. 가동률 ${k.util.toFixed(0)}%, 포트대기 비중 ${k.queueShare.toFixed(1)}%로 안정 구간입니다.` });
      }
    } else if (!req.feasible) {
      items.push({ level: 'error', title: '목표 달성 불가',
        msg: req.reason === 'port'
          ? `포트 물리 한계(${Math.round(req.hard)} UPH)로 인해 대수 증설만으로는 달성 불가합니다.`
          : `통로 혼잡 한계로 60대 이내에서 목표를 달성할 수 없습니다. 레이아웃 재설계가 필요합니다.` });
    }

    const chargers = L.byType('charge').length;
    if (chargers === 0) {
      items.push({ level: 'error', title: '충전소 없음', msg: '배터리 소진 시 차량이 정지합니다. ⚡ 충전 도구로 충전소를 배치하세요.' });
    } else {
      const cm = cycleModel(sim);
      if (cm.ok) {
        const chargeDuty = cm.chargeSec / (cm.cyclesPerCharge * cm.tCycle + cm.chargeSec);
        const needed = Math.ceil(p.fleet * chargeDuty * 1.25);
        if (needed > chargers * p.port_cap) {
          items.push({ level: 'warn', title: '충전기 부족',
            msg: `동시 충전 수요 약 ${needed}대 > 충전 슬롯 ${chargers * p.port_cap}개. 충전 대기가 가동률을 떨어뜨립니다.` });
        }
      }
    }

    if (k.avgSoc > 0 && k.avgSoc < p.bat_min + 6 && sim.t > 600) {
      items.push({ level: 'warn', title: '배터리 수지 적자',
        msg: `평균 SoC ${k.avgSoc.toFixed(0)}%가 지속 하락 중입니다. 충전기 출력(${p.charge_kw}kW) 상향 또는 충전 슬롯 증설이 필요합니다.` });
    }

    // 포트별 불균형
    const picks = L.byType('pick');
    if (picks.length > 1) {
      const buf = picks.map((n) => n.buffer);
      const mx = Math.max(...buf), mn = Math.min(...buf);
      if (mx - mn >= 8) {
        const hot = picks[buf.indexOf(mx)];
        items.push({ level: 'info', title: '피킹 부하 불균형',
          msg: `${hot.name} 적체 ${mx}건 vs 최소 ${mn}건. 수요 가중치 또는 배차 규칙 조정을 검토하세요.` });
      }
    }

    if (!items.length) items.push({ level: 'ok', title: '이상 없음', msg: '모든 지표가 정상 범위입니다.' });
    return { items, req, limits, demand, congestion: cf };
  }

  /* =======================================================
   * 7) 경제성 분석 (ROI / 손익분기)
   *    curveIn 을 넘기면 처리량 곡선을 다시 계산하지 않는다
   * ======================================================= */
  function economics(sim, fleetOverride, curveIn) {
    const p = sim.params;
    const fleet = fleetOverride || p.fleet;
    const curve = curveIn || throughputCurve(sim, Math.max(fleet, p.fleet) + 2).curve;
    const pt = curve.find((c) => c.n === fleet) || curve[curve.length - 1];
    const uph = pt ? pt.uph : 0;
    const annualTasks = uph * p.shift_hours * 300;        // 연 300일 가동

    const capex = fleet * p.cost_amr;                     // 만원
    const opexY = fleet * p.cost_oper;
    const laborEquivalent = Math.ceil(uph / Math.max(1, p.labor_uph));
    const laborSavingY = laborEquivalent * p.labor_cost;
    const netSaveY = laborSavingY - opexY;
    const paybackY = netSaveY > 0 ? capex / netSaveY : Infinity;
    const roi5 = netSaveY * 5 - capex;
    const costPerTask = annualTasks > 0 ? ((capex / 7 + opexY) * 10000) / annualTasks : 0;  // 원/건 (7년 상각)

    return { fleet, uph, annualTasks, capex, opexY, laborEquivalent, laborSavingY, netSaveY, paybackY, roi5, costPerTask };
  }

  /* =======================================================
   * 8) 실험실: 파라미터 스윕 (해석 모델 기반 — 즉시 응답)
   * ======================================================= */
  function sweep(sim, key, from, to, steps) {
    const p = sim.params;
    const backup = p[key];
    const rows = [];
    const n = Math.max(2, Math.min(40, steps));
    for (let i = 0; i < n; i++) {
      const v = from + ((to - from) * i) / (n - 1);
      p[key] = v;
      if (key === 'pixel_scale' || key === 'v_max' || key === 'accel') sim.graph.invalidateCache();
      const demand = sim.demandUPH();
      const { curve, limits } = throughputCurve(sim, Math.max(p.fleet, 20));
      const pt = curve.find((c) => c.n === Math.round(p.fleet)) || curve[curve.length - 1];
      const req = requiredFleet(sim, demand);
      const eco = economics(sim);
      rows.push({
        value: v,
        uph: pt ? pt.uph : 0,
        cycle: pt ? pt.cycle : 0,
        wait: pt ? pt.wait : 0,
        bottleneck: pt ? pt.bottleneck : '-',
        reqFleet: isFinite(req.n) ? req.n : null,
        demand,
        service: demand > 0 ? ((pt ? pt.uph : 0) / demand) * 100 : 100,
        costPerTask: eco.costPerTask,
        portLimit: Math.min(limits.pick, limits.drop)
      });
    }
    p[key] = backup;
    sim.graph.invalidateCache();
    return rows;
  }

  /* =======================================================
   * 9) 몬테카를로: 시드 반복 고속 시뮬레이션 (headless, async)
   *    반복마다 화면 갱신을 양보해 진행률이 실제로 표시된다
   * ======================================================= */
  async function monteCarlo(sim, opts, onProgress) {
    const runs = clamp(opts.runs || 8, 1, 40);
    const horizon = clamp(opts.horizonMin || 60, 5, 480) * 60;  // 초
    const dt = opts.dt || 0.4;
    const warmup = Math.min(horizon * 0.25, 600);
    const results = [];
    const layoutJson = JSON.stringify(sim.layout.toJSON());

    for (let r = 0; r < runs; r++) {
      const params = { ...sim.params, seed: (sim.params.seed + r * 7919) >>> 0 };
      const layout = new AMR.model.Layout();
      layout.fromJSON(JSON.parse(layoutJson));
      const s = new AMR.Simulation(layout, params);
      let t = 0, warmDone = false;
      while (t < horizon) {
        s.step(dt);
        t += dt;
        if (!warmDone && t >= warmup) {
          // 워밍업 이후 통계 리셋 (정상상태 측정)
          s.metrics.completed = 0;
          s.metrics.blockedTime = 0;
          s.metrics.portWaitEvents = 0;
          s.cycleSamples.clear(); s.queueSamples.clear(); s.travelSamples.clear();
          s.robots.forEach((rb) => { rb.tBusy = 0; rb.tIdle = 0; rb.tBlocked = 0; rb.distM = 0; rb.loadedM = 0; rb.energyWh = 0; });
          // 시계를 0으로 되돌리므로 진행 중 작업의 시각도 함께 이동 (음수 사이클 방지)
          const off = s.t;
          s.jobs.forEach((j) => { j.tCreated -= off; if (j.tAssigned) j.tAssigned -= off; });
          s.robots.forEach((rb) => { rb.tripStart -= off; });
          s.t = 0;
          warmDone = true;
        }
      }
      const k = s.kpi();
      results.push(k);
      if (onProgress) onProgress(r + 1, runs, k);
      await new Promise((res) => setTimeout(res, 16));   // 화면 갱신 양보
    }

    const agg = (f) => {
      const arr = results.map(f).filter((v) => isFinite(v));
      if (!arr.length) return { mean: 0, std: 0, min: 0, max: 0, ci: 0, p: [] };
      return { mean: stat.mean(arr), std: stat.std(arr), min: Math.min(...arr), max: Math.max(...arr), ci: stat.ci95(arr), p: arr };
    };
    return {
      runs, horizonMin: horizon / 60,
      uph: agg((k) => k.measuredUPH),
      cycle: agg((k) => k.avgCycle),
      p90: agg((k) => k.p90Cycle),
      util: agg((k) => k.util),
      queueShare: agg((k) => k.queueShare),
      blockShare: agg((k) => k.blockShare),
      wip: agg((k) => k.wip),
      energy: agg((k) => k.energyPerTask),
      raw: results
    };
  }

  /* =======================================================
   * 10) 시나리오 비교 (A/B/C)
   *     현재 레이아웃 위에서 paramPatch 를 적용해 평가
   * ======================================================= */
  function evaluateScenario(sim, paramPatch) {
    const backup = { ...sim.params };
    Object.assign(sim.params, paramPatch || {});
    sim.graph.rebuild();   // bidirectional 등 그래프에 영향을 주는 값 반영
    const demand = sim.demandUPH();
    const req = requiredFleet(sim, demand);
    const { curve, limits } = throughputCurve(sim, Math.max(sim.params.fleet, 24));
    const pt = curve.find((c) => c.n === Math.round(sim.params.fleet)) || curve[0];
    const eco = economics(sim, null, curve);
    const cm = cycleModel(sim);
    const result = {
      demand,
      uph: pt ? pt.uph : 0,
      cycle: pt ? pt.cycle : 0,
      wait: pt ? pt.wait : 0,
      bottleneck: pt ? pt.bottleneck : '-',
      reqFleet: isFinite(req.n) ? req.n : null,
      service: demand > 0 ? ((pt ? pt.uph : 0) / demand) * 100 : 100,
      portLimit: Math.min(limits.pick, limits.drop),
      loadedM: cm.loadedM, emptyM: cm.emptyM,
      capex: eco.capex, payback: eco.paybackY, costPerTask: eco.costPerTask
    };
    Object.assign(sim.params, backup);
    sim.graph.rebuild();
    return result;
  }

  AMR.analytics = {
    cycleModel, congestionFactor, portQueueWait, throughputCurve,
    requiredFleet, diagnose, economics, sweep, monteCarlo, evaluateScenario
  };
})(window);
