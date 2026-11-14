/* =========================================================
 * AMR Capa Simulator PRO — Dispatching
 * nearest / battery / roundrobin / fifo / edd(마감우선) /
 * hungarian(전역 최적 비용 매칭)
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});

  const ALGOS = {
    hungarian:  { label: '전역 최적 매칭 (Hungarian)', desc: '유휴 차량×대기 작업 전체를 하나의 할당 문제로 풀어 <strong>총 공차 주행 비용을 최소화</strong>합니다. 국소 탐욕 배차 대비 공차거리 10~25% 절감.' },
    nearest:    { label: '최근접 탐욕 (Greedy Nearest)', desc: '각 유휴 차량이 <strong>가장 가까운 대기 작업</strong>을 즉시 선점합니다. 계산은 가장 빠르나 전역 최적성은 보장되지 않습니다.' },
    battery:    { label: '배터리 우선 (Max SoC)',       desc: '잔량이 가장 높은 차량부터 투입해 <strong>작업 중 방전 리스크</strong>를 최소화합니다.' },
    roundrobin: { label: '균등 순환 (Round-Robin)',     desc: '차량에 <strong>균등하게 순차 배차</strong>하여 주행거리·마모 편중을 방지합니다.' },
    fifo:       { label: '선입선출 (FIFO)',             desc: '작업 등록 순서를 <strong>엄격히 보장</strong>합니다. 공정성 최우선, 효율은 낮습니다.' },
    edd:        { label: '대기시간 우선 (EDD/최장대기)', desc: '가장 오래 대기한 작업부터 처리해 <strong>최대 대기시간(P95 Tail)</strong>을 억제합니다.' }
  };

  /* ---------- Hungarian (Jonker-Volgenant 스타일 O(n³)) ---------- */
  /**
   * cost: n×m 행렬 (n≤m 아니어도 내부 패딩)
   * @returns Array<number> assign[i] = j (또는 -1)
   */
  function hungarian(cost) {
    const n0 = cost.length;
    if (!n0) return [];
    const m0 = cost[0].length;
    const N = Math.max(n0, m0);
    const BIG = 1e9;
    const a = [];
    for (let i = 0; i < N; i++) {
      a.push(new Array(N).fill(0));
      for (let j = 0; j < N; j++) a[i][j] = (i < n0 && j < m0) ? cost[i][j] : BIG;
    }
    const u = new Array(N + 1).fill(0);
    const v = new Array(N + 1).fill(0);
    const p = new Array(N + 1).fill(0);
    const way = new Array(N + 1).fill(0);

    for (let i = 1; i <= N; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(N + 1).fill(Infinity);
      const used = new Array(N + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= N; j++) {
          if (used[j]) continue;
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= N; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
          else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }

    const assign = new Array(n0).fill(-1);
    for (let j = 1; j <= N; j++) {
      const i = p[j] - 1;
      if (i >= 0 && i < n0 && j - 1 < m0 && a[i][j - 1] < BIG) assign[i] = j - 1;
    }
    return assign;
  }

  /* ---------- 작업-차량 비용 ---------- */
  function cost(sim, robot, job) {
    const g = sim.graph;
    const r = g.findPath(robot.atNode, job.from);
    if (!r.ok) return Infinity;
    const emptyM = g.pxToM(r.px);
    const travelT = g.pathTime(r.path, sim.params);

    // 포트 혼잡 페널티
    const fromNode = sim.layout.node(job.from);
    const portPenalty = fromNode ? (fromNode.occupants.length + fromNode.queue) * sim.params.t_pick * 0.7 : 0;

    // 배터리 여유 페널티: 작업 수행 후 SoC 부족 예상 시 큰 비용
    const p = sim.params;
    const toR = g.findPath(job.from, job.to);
    const totalM = emptyM + (toR.ok ? g.pxToM(toR.px) : emptyM);
    const estWh = ((p.p_move + p.p_load_add * 0.5) * (totalM / Math.max(0.1, p.v_max))) / 3600;
    const estSocDrop = (estWh / (p.bat_kwh * 1000)) * 100;
    const socPenalty = (robot.soc - estSocDrop) < p.bat_min ? 600 : 0;

    // 대기시간 가중(기아 방지)
    const aging = Math.min(240, (sim.t - job.tCreated) * 0.55);

    return travelT + portPenalty + socPenalty - aging;
  }

  function idleRobots(sim) {
    const p = sim.params;
    return sim.robots.filter(
      (r) => r.state === AMR.STATE.IDLE && r.soc >= p.bat_min && !r.job
    );
  }

  function pendingJobs(sim) {
    return sim.jobs.filter((j) => j.status === 'pending');
  }

  let rrCursor = 0;

  function run(sim) {
    const algo = sim.params.dispatch_algo;
    const robots = idleRobots(sim);
    if (!robots.length) return;
    let jobs = pendingJobs(sim);
    if (!jobs.length) return;

    switch (algo) {
      case 'hungarian': {
        // 행렬 크기 제한 (성능)
        const R = robots.slice(0, 40);
        const J = jobs.slice(0, 40);
        const mat = R.map((r) => J.map((j) => {
          const c = cost(sim, r, j);
          return isFinite(c) ? c : 1e8;
        }));
        const assign = hungarian(mat);
        assign.forEach((jIdx, rIdx) => {
          if (jIdx < 0) return;
          if (mat[rIdx][jIdx] >= 1e8) return;
          const job = J[jIdx];
          if (job.status !== 'pending') return;
          R[rIdx].assign(job);
        });
        break;
      }

      case 'nearest': {
        for (const r of robots) {
          let best = null, bc = Infinity;
          for (const j of jobs) {
            if (j.status !== 'pending') continue;
            const c = cost(sim, r, j);
            if (c < bc) { bc = c; best = j; }
          }
          if (best && isFinite(bc)) r.assign(best);
        }
        break;
      }

      case 'battery': {
        const sorted = [...robots].sort((a, b) => b.soc - a.soc);
        const q = [...jobs].sort((a, b) => a.tCreated - b.tCreated);
        for (const r of sorted) {
          const j = q.find((x) => x.status === 'pending');
          if (!j) break;
          if (!r.assign(j)) j.status = 'pending';
        }
        break;
      }

      case 'roundrobin': {
        const q = [...jobs].sort((a, b) => a.tCreated - b.tCreated);
        let qi = 0;
        for (let k = 0; k < robots.length && qi < q.length; k++) {
          const r = robots[(rrCursor + k) % robots.length];
          if (r.job) continue;
          const j = q[qi++];
          if (j.status === 'pending') r.assign(j);
        }
        rrCursor = (rrCursor + 1) % Math.max(1, robots.length);
        break;
      }

      case 'edd': {
        const q = [...jobs].sort((a, b) => a.tCreated - b.tCreated);
        for (const j of q) {
          if (j.status !== 'pending') continue;
          let best = null, bc = Infinity;
          for (const r of robots) {
            if (r.job) continue;
            const c = cost(sim, r, j);
            if (c < bc) { bc = c; best = r; }
          }
          if (best && isFinite(bc)) best.assign(j);
        }
        break;
      }

      case 'fifo':
      default: {
        const q = [...jobs].sort((a, b) => a.tCreated - b.tCreated);
        let qi = 0;
        for (const r of robots) {
          while (qi < q.length && q[qi].status !== 'pending') qi++;
          if (qi >= q.length) break;
          r.assign(q[qi++]);
        }
        break;
      }
    }
  }

  AMR.dispatch = { run, hungarian, cost, ALGOS };
})(window);
