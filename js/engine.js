/* =========================================================
 * AMR Capa Simulator PRO — Simulation Engine
 * 물리 주행(가감속/선회) · 간선 예약 기반 교통 · 차간거리 ·
 * 에너지 기반 배터리 · 고장/복구 · 포트 큐 · 통계 수집
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});
  const { RNG, Rolling, stat, clamp } = AMR.util;

  const STATE = {
    IDLE: 'idle',
    TO_PICK: 'to_pick',
    QUEUE_PICK: 'queue_pick',
    LOADING: 'loading',
    TO_DROP: 'to_drop',
    QUEUE_DROP: 'queue_drop',
    UNLOADING: 'unloading',
    TO_CHARGE: 'to_charge',
    QUEUE_CHARGE: 'queue_charge',
    CHARGING: 'charging',
    TO_PARK: 'to_park',
    BLOCKED: 'blocked',
    FAULT: 'fault'
  };

  const STATE_LABEL = {
    idle: '⚪ 유휴', to_pick: '🔵 픽업이동', queue_pick: '🟡 픽업대기', loading: '🟢 적재중',
    to_drop: '🟠 이송중', queue_drop: '🟡 드롭대기', unloading: '🟢 하역중',
    to_charge: '🔻 충전이동', queue_charge: '🟡 충전대기', charging: '⚡ 충전중',
    to_park: '🟣 대기존이동', blocked: '🔴 정체', fault: '🛠 고장'
  };

  /* ===================== Robot ===================== */
  class Robot {
    constructor(id, node, sim) {
      this.id = id;
      this.sim = sim;
      this.x = node ? node.x : 0;
      this.y = node ? node.y : 0;
      this.heading = 0;
      this.speed = 0;                 // m/s 현재 속도
      this.atNode = node ? node.id : null;
      this.nextNode = null;
      this.path = [];
      this.state = STATE.IDLE;
      this.job = null;
      this.cargo = 0;
      this.timer = 0;
      this.soc = 60 + sim.rng.range(0, 35);  // %
      this.heldEdge = null;           // 예약 중인 간선 key
      this.heldPort = null;           // 점유 포트 id
      this.taskLabel = '유휴 대기';
      // 통계
      this.distM = 0;
      this.loadedM = 0;
      this.tBusy = 0; this.tIdle = 0; this.tBlocked = 0; this.tCharge = 0; this.tQueue = 0;
      this.jobsDone = 0;
      this.energyWh = 0;
      this.tripStart = 0; this.tripQueue = 0; this.tripTravel = 0;
      this.nextFault = sim.params.failures ? sim.rng.exp(sim.params.mtbf * 60) : Infinity;
      this.faultTimer = 0;
    }

    get p() { return this.sim.params; }
    get g() { return this.sim.graph; }

    setPath(path) {
      this.path = (path && path.length > 1) ? path.slice(1) : [];
      this.nextNode = this.path.length ? this.path[0] : null;
    }

    targetNodeObj() { return this.nextNode ? this.sim.layout.node(this.nextNode) : null; }

    /* --- 교통: 전방 간선 진입 가능 여부 --- */
    canEnterEdge(fromId, toId) {
      const p = this.p;
      if (p.traffic_model === 'none') return true;
      const key = this.sim.layout.edgeKey(fromId, toId);
      if (this.heldEdge === key) return true;
      const occ = this.sim.edgeOccupancy.get(key);
      if (!occ || occ.size === 0) return true;
      if (p.traffic_model === 'reservation') {
        const edge = this.sim.layout.edges.find(
          (e) => (e.a === fromId && e.b === toId) || (e.a === toId && e.b === fromId)
        );
        const lanes = edge ? (edge.lanes || 1) : 1;
        if (occ.size < lanes) return true;
        // 같은 방향이면 차간거리 모델로 추종 허용
        for (const rid of occ) {
          const other = this.sim.robotMap.get(rid);
          if (!other || other === this) continue;
          const sameDir = other.atNode === fromId || other.nextNode === toId;
          if (!sameDir) return false;
        }
        return occ.size < lanes + 1;
      }
      return true; // softgap: 간선 진입은 허용하고 차간거리로만 제어
    }

    /** 전방 차량과의 간격(m). 없으면 Infinity */
    frontGapM() {
      if (this.p.traffic_model === 'none' || !this.nextNode) return Infinity;
      const tgt = this.targetNodeObj();
      if (!tgt) return Infinity;
      const dirx = tgt.x - this.x, diry = tgt.y - this.y;
      const len = Math.hypot(dirx, diry) || 1;
      const ux = dirx / len, uy = diry / len;
      let gap = Infinity;
      const near = this.sim.spatial.query(this.x, this.y, 140);
      for (const o of near) {
        if (o === this) continue;
        const dx = o.x - this.x, dy = o.y - this.y;
        const proj = dx * ux + dy * uy;
        if (proj <= 0.1) continue;                    // 뒤쪽
        const lat = Math.abs(-dx * uy + dy * ux);
        if (lat > 16) continue;                       // 다른 차선
        gap = Math.min(gap, this.g.pxToM(proj));
      }
      return gap;
    }

    acquireEdge(fromId, toId) {
      const key = this.sim.layout.edgeKey(fromId, toId);
      if (this.heldEdge === key) return;
      this.releaseEdge();
      if (!this.sim.edgeOccupancy.has(key)) this.sim.edgeOccupancy.set(key, new Set());
      this.sim.edgeOccupancy.get(key).add(this.id);
      this.heldEdge = key;
    }

    releaseEdge() {
      if (!this.heldEdge) return;
      const s = this.sim.edgeOccupancy.get(this.heldEdge);
      if (s) { s.delete(this.id); if (!s.size) this.sim.edgeOccupancy.delete(this.heldEdge); }
      this.heldEdge = null;
    }

    /**
     * 경로 추종 (사다리꼴 속도 프로파일 + 차간거리 감속)
     * @returns true 면 경로 종료(도착)
     */
    drive(dt) {
      const p = this.p;
      if (!this.nextNode) {
        if (!this.path.length) { this.releaseEdge(); this.speed = 0; return true; }
        this.nextNode = this.path[0];
      }
      const tgt = this.targetNodeObj();
      if (!tgt) { this.path = []; this.nextNode = null; this.releaseEdge(); return true; }

      // 간선 진입 예약
      if (this.atNode && this.atNode !== tgt.id && Math.hypot(tgt.x - this.x, tgt.y - this.y) > 1) {
        if (!this.canEnterEdge(this.atNode, tgt.id)) {
          this.speed = Math.max(0, this.speed - p.decel * dt * 2);
          this.tBlocked += dt;
          this.sim.metrics.blockedTime += dt;
          if (this.speed < 0.02) { this.sim.metrics.blockEvents += dt; return false; }
        } else {
          this.acquireEdge(this.atNode, tgt.id);
        }
      }

      const dx = tgt.x - this.x, dy = tgt.y - this.y;
      const distPx = Math.hypot(dx, dy);
      const distM = this.g.pxToM(distPx);

      // 선회 감속
      const desired = Math.atan2(dy, dx);
      let dh = desired - this.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const turnDeg = Math.abs(dh * 180 / Math.PI);
      const maxTurn = (p.turn_speed * Math.PI / 180) * dt;
      this.heading += clamp(dh, -maxTurn, maxTurn);

      let vTarget = p.v_max;
      if (turnDeg > p.turn_thresh) vTarget = p.v_max * clamp(1 - turnDeg / 180, 0.18, 1);

      // 정지 거리 제약(다음 노드가 경로의 끝이면 감속 정지)
      const isLast = this.path.length <= 1;
      if (isLast) vTarget = Math.min(vTarget, Math.sqrt(Math.max(0, 2 * p.decel * distM)));

      // 차간거리 제약 (IDM 간이형)
      const gap = this.frontGapM();
      if (isFinite(gap)) {
        const safe = p.safety_gap;
        if (gap < safe * 0.6) vTarget = 0;
        else if (gap < safe * 3) vTarget = Math.min(vTarget, p.v_max * clamp((gap - safe * 0.6) / (safe * 2.4), 0, 1));
      }

      // 가감속 적용
      if (vTarget > this.speed) this.speed = Math.min(vTarget, this.speed + p.accel * dt);
      else this.speed = Math.max(vTarget, this.speed - p.decel * dt);
      if (this.speed < 0.015 && vTarget <= 0.02) { this.tBlocked += dt; this.sim.metrics.blockedTime += dt; }

      const stepM = this.speed * dt;
      this.distM += stepM;
      if (this.cargo > 0) this.loadedM += stepM;
      this.consume(dt, true);

      if (stepM >= distM - 1e-6) {
        this.x = tgt.x; this.y = tgt.y;
        this.atNode = tgt.id;
        this.path.shift();
        this.nextNode = this.path.length ? this.path[0] : null;
        // 혼잡 기록
        this.sim.noteEdgeFlow(this.heldEdge);
        if (!this.nextNode) { this.releaseEdge(); this.speed = Math.min(this.speed, 0.4); return true; }
        return false;
      }
      const stepPx = this.g.mToPx(stepM);
      this.x += (dx / distPx) * stepPx;
      this.y += (dy / distPx) * stepPx;
      return false;
    }

    consume(dt, moving) {
      const p = this.p;
      const w = moving ? p.p_move + (this.cargo > 0 ? p.p_load_add : 0) : p.p_idle;
      const wh = (w * dt) / 3600;
      this.energyWh += wh;
      this.soc = clamp(this.soc - (wh / (p.bat_kwh * 1000)) * 100, 0, 100);
    }

    needCharge() {
      if (this.p.charge_policy === 'opportunity')
        return this.soc < this.p.bat_min || (this.state === STATE.IDLE && this.soc < this.p.opportunity);
      return this.soc < this.p.bat_min;
    }

    /* --- 포트 점유 --- */
    tryOccupy(node) {
      const cap = this.p.port_cap;
      if (node.occupants.includes(this.id)) return true;
      if (node.occupants.length < cap) { node.occupants.push(this.id); this.heldPort = node.id; return true; }
      return false;
    }

    releasePort() {
      if (!this.heldPort) return;
      const n = this.sim.layout.node(this.heldPort);
      if (n) n.occupants = n.occupants.filter((r) => r !== this.id);
      this.heldPort = null;
    }

    goto(targetId, useCongestion) {
      const r = this.g.findPath(this.atNode, targetId, useCongestion);
      if (!r.ok) return false;
      this.setPath(r.path);
      return true;
    }

    /* ===================== 상태 머신 ===================== */
    update(dt) {
      const p = this.p, S = this.sim;

      // 고장 모델
      if (p.failures) {
        if (this.state === STATE.FAULT) {
          this.faultTimer -= dt;
          this.taskLabel = `🛠 복구 중 (${Math.max(0, this.faultTimer).toFixed(0)}s)`;
          if (this.faultTimer <= 0) { this.state = STATE.IDLE; this.nextFault = S.rng.exp(p.mtbf * 60); }
          return;
        }
        this.nextFault -= dt;
        if (this.nextFault <= 0 && this.state !== STATE.CHARGING) {
          this.state = STATE.FAULT;
          this.faultTimer = Math.max(5, S.rng.service(p.mttr * 60, 0.4));
          this.releaseEdge(); this.releasePort();
          if (this.job) { this.job.status = 'pending'; this.job.robot = null; this.job = null; }
          this.cargo = 0; this.speed = 0;
          S.metrics.faults++;
          return;
        }
      }

      switch (this.state) {
        case STATE.IDLE: {
          this.tIdle += dt;
          this.consume(dt, false);
          this.speed = Math.max(0, this.speed - p.decel * dt);
          this.taskLabel = '유휴 대기';
          if (this.needCharge() && S.layout.byType('charge').length) { this.startCharge(); break; }
          break;
        }

        case STATE.TO_PICK: {
          this.tBusy += dt;
          const node = S.layout.node(this.job?.from);
          if (!node) { this.abortJob(); break; }
          this.taskLabel = `[${this.job.id}] ${node.name} 이동`;
          if (this.drive(dt)) {
            if (this.tryOccupy(node)) {
              this.state = STATE.LOADING;
              this.timer = S.rng.service(p.t_pick, p.cv_service);
              this.job.status = 'loading';
            } else {
              this.state = STATE.QUEUE_PICK;
              node.queue++;
              this.job.status = 'queue';
              S.metrics.portWaitEvents++;
            }
          }
          break;
        }

        case STATE.QUEUE_PICK: {
          this.tQueue += dt; this.tripQueue += dt;
          this.consume(dt, false);
          const node = S.layout.node(this.job?.from);
          if (!node) { this.abortJob(); break; }
          node.waitAccum += dt;
          this.taskLabel = `⏳ ${node.name} 포트 대기`;
          if (this.tryOccupy(node)) {
            node.queue = Math.max(0, node.queue - 1);
            this.state = STATE.LOADING;
            this.timer = S.rng.service(p.t_pick, p.cv_service);
          }
          break;
        }

        case STATE.LOADING: {
          this.tBusy += dt;
          this.consume(dt, false);
          this.timer -= dt;
          this.taskLabel = `적재 중 (${Math.max(0, this.timer).toFixed(0)}s)`;
          if (this.timer <= 0) {
            const node = S.layout.node(this.job.from);
            const take = Math.min(p.payload, Math.max(1, node ? node.buffer : 1));
            this.cargo = take;
            if (node) { node.buffer = Math.max(0, node.buffer - take); node.processed += take; }
            this.releasePort();
            if (this.goto(this.job.to, p.traffic_model !== 'none')) {
              this.state = STATE.TO_DROP;
              this.job.status = 'moving';
            } else { this.abortJob(); }
          }
          break;
        }

        case STATE.TO_DROP: {
          this.tBusy += dt;
          const node = S.layout.node(this.job?.to);
          if (!node) { this.abortJob(); break; }
          this.taskLabel = `[${this.job.id}] ${node.name} 이송`;
          if (this.drive(dt)) {
            if (this.tryOccupy(node)) {
              this.state = STATE.UNLOADING;
              this.timer = S.rng.service(p.t_drop, p.cv_service);
            } else {
              this.state = STATE.QUEUE_DROP;
              node.queue++;
              this.job.status = 'queue';
              S.metrics.portWaitEvents++;
            }
          }
          break;
        }

        case STATE.QUEUE_DROP: {
          this.tQueue += dt; this.tripQueue += dt;
          this.consume(dt, false);
          const node = S.layout.node(this.job?.to);
          if (!node) { this.abortJob(); break; }
          node.waitAccum += dt;
          this.taskLabel = `⏳ ${node.name} 포트 대기`;
          if (this.tryOccupy(node)) {
            node.queue = Math.max(0, node.queue - 1);
            this.state = STATE.UNLOADING;
            this.timer = S.rng.service(p.t_drop, p.cv_service);
          }
          break;
        }

        case STATE.UNLOADING: {
          this.tBusy += dt;
          this.consume(dt, false);
          this.timer -= dt;
          this.taskLabel = `하역 중 (${Math.max(0, this.timer).toFixed(0)}s)`;
          if (this.timer <= 0) {
            const node = S.layout.node(this.job.to);
            if (node) node.processed += this.cargo;
            S.completeJob(this, this.job);
            this.cargo = 0;
            this.releasePort();
            this.job = null;
            this.jobsDone++;
            this.state = this.needCharge() && S.layout.byType('charge').length ? STATE.IDLE : STATE.IDLE;
          }
          break;
        }

        case STATE.TO_CHARGE: {
          this.taskLabel = '⚡ 충전소 이동';
          this.consume(dt, true);
          if (this.drive(dt)) {
            const node = S.layout.node(this.atNode);
            if (node && this.tryOccupy(node)) this.state = STATE.CHARGING;
            else { this.state = STATE.QUEUE_CHARGE; if (node) node.queue++; }
          }
          break;
        }

        case STATE.QUEUE_CHARGE: {
          this.tQueue += dt;
          this.consume(dt, false);
          const node = S.layout.node(this.atNode);
          this.taskLabel = '⏳ 충전기 대기';
          if (node && this.tryOccupy(node)) { node.queue = Math.max(0, node.queue - 1); this.state = STATE.CHARGING; }
          break;
        }

        case STATE.CHARGING: {
          this.tCharge += dt;
          const addWh = (p.charge_kw * 1000 * dt) / 3600;
          this.soc = clamp(this.soc + (addWh / (p.bat_kwh * 1000)) * 100, 0, 100);
          this.taskLabel = `⚡ 충전 ${this.soc.toFixed(0)}% / 목표 ${p.bat_max}%`;
          S.metrics.chargeWh += addWh;
          if (this.soc >= p.bat_max) {
            this.releasePort();
            this.state = STATE.IDLE;
          }
          break;
        }

        case STATE.TO_PARK: {
          this.tIdle += dt;
          this.consume(dt, true);
          this.taskLabel = '🅿 대기존 이동';
          if (this.drive(dt)) this.state = STATE.IDLE;
          break;
        }
      }
    }

    abortJob() {
      if (this.job) { this.job.status = 'pending'; this.job.robot = null; }
      this.job = null; this.cargo = 0;
      this.releaseEdge(); this.releasePort();
      this.path = []; this.nextNode = null;
      this.state = STATE.IDLE;
    }

    startCharge() {
      const S = this.sim;
      const chargers = S.layout.byType('charge');
      if (!chargers.length) return false;
      let best = null, bestCost = Infinity;
      chargers.forEach((c) => {
        const r = this.g.findPath(this.atNode, c.id);
        if (!r.ok) return;
        const penalty = c.occupants.length * 400 + c.queue * 300;
        const cost = r.px + penalty;
        if (cost < bestCost) { bestCost = cost; best = { c, path: r.path }; }
      });
      if (!best) return false;
      this.setPath(best.path);
      this.state = STATE.TO_CHARGE;
      return true;
    }

    assign(job) {
      job.status = 'assigned';
      job.robot = this.id;
      job.tAssigned = this.sim.t;
      this.job = job;
      this.tripStart = this.sim.t;
      this.tripQueue = 0;
      if (!this.goto(job.from, this.p.traffic_model !== 'none')) { this.abortJob(); return false; }
      this.state = STATE.TO_PICK;
      return true;
    }
  }

  /* ===================== Spatial Hash ===================== */
  class SpatialHash {
    constructor(cell = 100) { this.cell = cell; this.map = new Map(); }
    key(x, y) { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }
    rebuild(items) {
      this.map.clear();
      for (const it of items) {
        const k = this.key(it.x, it.y);
        if (!this.map.has(k)) this.map.set(k, []);
        this.map.get(k).push(it);
      }
    }
    query(x, y, r) {
      const out = [];
      const c = this.cell, n = Math.ceil(r / c);
      const cx = Math.floor(x / c), cy = Math.floor(y / c);
      for (let i = -n; i <= n; i++)
        for (let j = -n; j <= n; j++) {
          const arr = this.map.get(`${cx + i},${cy + j}`);
          if (arr) out.push(...arr);
        }
      return out;
    }
  }

  /* ===================== Simulation ===================== */
  class Simulation {
    constructor(layout, params) {
      this.layout = layout;
      this.params = params;
      this.graph = new AMR.Graph(layout, params);
      this.rng = new RNG(params.seed);
      this.spatial = new SpatialHash(110);
      this.reset(true);
    }

    reset(hard) {
      this.t = 0;
      this.robots = [];
      this.robotMap = new Map();
      this.jobs = [];
      this.jobSeq = 1;
      this.edgeOccupancy = new Map();
      this.releaseTimer = 0;
      this.stationTimers = {};
      this.pickCursor = 0;
      this.cycleSamples = new Rolling(400);
      this.queueSamples = new Rolling(400);
      this.travelSamples = new Rolling(400);
      this.throughputSeries = [];   // {t, uph}
      this.wipSeries = [];
      this.utilSeries = [];
      this.metrics = {
        completed: 0, blockedTime: 0, blockEvents: 0, portWaitEvents: 0,
        faults: 0, chargeWh: 0, released: 0
      };
      this.layout.nodes.forEach((n) => {
        n.occupants = []; n.queue = 0; n.buffer = 0; n.processed = 0; n.waitAccum = 0;
      });
      this.layout.edges.forEach((e) => { e.flow = 0; e.load = 0; });
      if (hard !== false) this.rng.reset(this.params.seed);
      this.spawnFleet();
    }

    spawnFleet() {
      const L = this.layout;
      const base = [...L.byType('park'), ...L.byType('charge'), ...L.byType('waypoint')];
      const pool = base.length ? base : L.nodes;
      this.robots = [];
      this.robotMap.clear();
      if (!pool.length) return;
      for (let i = 1; i <= this.params.fleet; i++) {
        const start = pool[(i - 1) % pool.length];
        const r = new Robot('AMR-' + String(i).padStart(2, '0'), start, this);
        this.robots.push(r);
        this.robotMap.set(r.id, r);
      }
    }

    /** 플릿 수만 조정 (리셋 없이) */
    resizeFleet(n) {
      n = Math.max(1, Math.round(n));
      if (n === this.robots.length) return;
      if (n < this.robots.length) {
        const removed = this.robots.splice(n);
        removed.forEach((r) => { r.abortJob(); this.robotMap.delete(r.id); });
      } else {
        const L = this.layout;
        const pool = [...L.byType('park'), ...L.byType('charge'), ...L.byType('waypoint')];
        const base = pool.length ? pool : L.nodes;
        if (!base.length) return;
        for (let i = this.robots.length + 1; i <= n; i++) {
          const r = new Robot('AMR-' + String(i).padStart(2, '0'), base[(i - 1) % base.length], this);
          this.robots.push(r);
          this.robotMap.set(r.id, r);
        }
      }
    }

    noteEdgeFlow(key) {
      if (!key) return;
      const [a, b] = key.split('|');
      const e = this.layout.edges.find(
        (x) => (x.a === a && x.b === b) || (x.a === b && x.b === a)
      );
      if (e) e.flow++;
    }

    /* --- 수요 생성 --- */
    createJob(fromNode, toNode) {
      const job = {
        id: 'J' + String(this.jobSeq++).padStart(4, '0'),
        from: fromNode.id, to: toNode.id,
        status: 'pending', robot: null,
        tCreated: this.t, tAssigned: 0, tDone: 0
      };
      this.jobs.push(job);
      fromNode.buffer++;
      this.metrics.released++;
      if (this.jobs.length > 4000) this.jobs = this.jobs.filter((j) => j.status !== 'done').concat(
        this.jobs.filter((j) => j.status === 'done').slice(-500)
      );
      return job;
    }

    pickDropPair() {
      const picks = this.layout.byType('pick'), drops = this.layout.byType('drop');
      if (!picks.length || !drops.length) return null;
      const d = this.rng.weighted(drops, (n) => n.priority || 1);
      return { picks, drops, d };
    }

    generateDemand(dt) {
      const p = this.params;
      if (!p.auto_release) return;
      const sel = this.pickDropPair();
      if (!sel) return;
      const { picks, drops } = sel;
      const peak = p.peak_ratio > 1
        ? 1 + (p.peak_ratio - 1) * 0.5 * (1 + Math.sin((this.t / 1800) * Math.PI * 2))
        : 1;
      const baseInterval = Math.max(0.5, p.release_interval / peak);

      if (p.release_mode === 'total') {
        this.releaseTimer -= dt;
        if (this.releaseTimer <= 0) {
          const from = this.rng.weighted(picks, (n) => n.priority || 1) || picks[this.pickCursor++ % picks.length];
          const to = this.rng.weighted(drops, (n) => n.priority || 1);
          if (from && to) this.createJob(from, to);
          this.releaseTimer += p.demand_cv > 0
            ? Math.max(0.2, this.rng.service(baseInterval, p.demand_cv))
            : baseInterval;
        }
        this.nextReleaseIn = this.releaseTimer;
        this.releaseCycle = baseInterval;
      } else {
        let minRem = Infinity;
        picks.forEach((pk) => {
          if (this.stationTimers[pk.id] == null) this.stationTimers[pk.id] = baseInterval;
          this.stationTimers[pk.id] -= dt;
          if (this.stationTimers[pk.id] <= 0) {
            const to = this.rng.weighted(drops, (n) => n.priority || 1);
            if (to) this.createJob(pk, to);
            this.stationTimers[pk.id] += p.demand_cv > 0
              ? Math.max(0.2, this.rng.service(baseInterval, p.demand_cv))
              : baseInterval;
          }
          minRem = Math.min(minRem, this.stationTimers[pk.id]);
        });
        this.nextReleaseIn = isFinite(minRem) ? minRem : 0;
        this.releaseCycle = baseInterval;
      }
    }

    addManualJobs(count, fromId, toId) {
      const picks = this.layout.byType('pick'), drops = this.layout.byType('drop');
      if (!picks.length || !drops.length) return 0;
      let n = 0;
      for (let i = 0; i < count; i++) {
        const f = fromId ? this.layout.node(fromId) : this.rng.pick(picks);
        const d = toId ? this.layout.node(toId) : this.rng.pick(drops);
        if (f && d) { this.createJob(f, d); n++; }
      }
      return n;
    }

    completeJob(robot, job) {
      job.status = 'done';
      job.tDone = this.t;
      this.metrics.completed++;
      const cycle = job.tDone - (job.tAssigned || job.tCreated);
      this.cycleSamples.push(cycle);
      this.queueSamples.push(robot.tripQueue);
      this.travelSamples.push(Math.max(0, cycle - robot.tripQueue));
    }

    /* --- 배차 --- */
    dispatch() {
      AMR.dispatch.run(this);
    }

    /* --- 메인 스텝 --- */
    step(dt) {
      this.t += dt;
      this.generateDemand(dt);
      this.spatial.rebuild(this.robots);
      this.dispatch();
      for (const r of this.robots) r.update(dt);

      // 혼잡도 갱신 (간선 점유율)
      this._congTick = (this._congTick || 0) + dt;
      if (this._congTick > 1.0) {
        this.graph.decayCongestion(0.9);
        this.edgeOccupancy.forEach((set, key) => {
          const cur = this.graph.congestion.get(key) || 0;
          this.graph.setCongestion(key, Math.min(1, cur + set.size * 0.25));
        });
        this._congTick = 0;
      }

      // 시계열 샘플링 (30초 간격)
      this._sampleTick = (this._sampleTick || 0) + dt;
      if (this._sampleTick >= 30) {
        this._sampleTick = 0;
        const uph = this.t > 0 ? (this.metrics.completed / this.t) * 3600 : 0;
        this.throughputSeries.push({ t: this.t, uph });
        this.wipSeries.push({ t: this.t, wip: this.jobs.filter((j) => j.status !== 'done').length });
        this.utilSeries.push({ t: this.t, util: this.fleetUtil() * 100 });
        const cap = 600;
        if (this.throughputSeries.length > cap) this.throughputSeries.shift();
        if (this.wipSeries.length > cap) this.wipSeries.shift();
        if (this.utilSeries.length > cap) this.utilSeries.shift();
      }
    }

    /* --- KPI --- */
    fleetUtil() {
      if (!this.robots.length || this.t <= 0) return 0;
      const busy = this.robots.reduce((a, r) => a + r.tBusy, 0);
      return clamp(busy / (this.robots.length * this.t), 0, 1);
    }

    kpi() {
      const p = this.params;
      const t = Math.max(1, this.t);
      const done = this.metrics.completed;
      const pending = this.jobs.filter((j) => j.status === 'pending').length;
      const active = this.jobs.filter((j) => j.status !== 'done' && j.status !== 'pending').length;
      const cyc = this.cycleSamples.items;
      const avgCycle = cyc.length ? stat.mean(cyc) : 0;
      const p90Cycle = cyc.length ? stat.pct(cyc, 90) : 0;
      const avgQueue = this.queueSamples.length ? this.queueSamples.mean() : 0;
      const charging = this.robots.filter((r) => r.state === STATE.CHARGING || r.state === STATE.TO_CHARGE).length;
      const faulted = this.robots.filter((r) => r.state === STATE.FAULT).length;
      const blocked = this.robots.reduce((a, r) => a + r.tBlocked, 0) / (this.robots.length * t);
      const measuredUPH = (done / t) * 3600;
      const demandUPH = this.demandUPH();
      const energy = this.robots.reduce((a, r) => a + r.energyWh, 0);
      return {
        simTime: this.t,
        completed: done,
        pending, active,
        wip: pending + active,
        measuredUPH,
        demandUPH,
        serviceRate: demandUPH > 0 ? (measuredUPH / demandUPH) * 100 : 100,
        avgCycle, p90Cycle, avgQueue,
        queueShare: avgCycle > 0 ? (avgQueue / avgCycle) * 100 : 0,
        blockShare: blocked * 100,
        util: this.fleetUtil() * 100,
        charging, faulted,
        working: this.robots.length - charging - faulted,
        fleet: this.robots.length,
        avgSoc: this.robots.length ? stat.mean(this.robots.map((r) => r.soc)) : 0,
        energyWh: energy,
        energyPerTask: done > 0 ? energy / done : 0,
        distanceM: this.robots.reduce((a, r) => a + r.distM, 0),
        loadedShare: (() => {
          const tot = this.robots.reduce((a, r) => a + r.distM, 0);
          const ld = this.robots.reduce((a, r) => a + r.loadedM, 0);
          return tot > 0 ? (ld / tot) * 100 : 0;
        })(),
        portWaitEvents: this.metrics.portWaitEvents,
        faults: this.metrics.faults,
        oeeAdjUPH: measuredUPH * (p.oee / 100)
      };
    }

    demandUPH() {
      const p = this.params;
      if (!p.auto_release) return 0;
      const picks = this.layout.byType('pick').length || 1;
      const base = 3600 / Math.max(0.5, p.release_interval);
      const peakAvg = (1 + p.peak_ratio) / 2;
      return (p.release_mode === 'total' ? base : base * picks) * (p.peak_ratio > 1 ? peakAvg : 1);
    }

    /** 포트 물리 한계 (UPH) */
    portLimits() {
      const p = this.params;
      const picks = this.layout.byType('pick').length;
      const drops = this.layout.byType('drop').length;
      const chargers = this.layout.byType('charge').length;
      return {
        pick: picks * p.port_cap * (3600 / Math.max(1, p.t_pick)) * p.payload,
        drop: drops * p.port_cap * (3600 / Math.max(1, p.t_drop)) * p.payload,
        charger: chargers
      };
    }

    snapshotRobots() {
      return this.robots.map((r) => ({
        id: r.id, state: r.state, label: STATE_LABEL[r.state] || r.state,
        soc: r.soc, node: r.atNode, task: r.taskLabel, cargo: r.cargo,
        distM: r.distM, jobs: r.jobsDone, energy: r.energyWh,
        util: this.t > 0 ? (r.tBusy / this.t) * 100 : 0,
        blocked: this.t > 0 ? (r.tBlocked / this.t) * 100 : 0
      }));
    }
  }

  AMR.STATE = STATE;
  AMR.STATE_LABEL = STATE_LABEL;
  AMR.Robot = Robot;
  AMR.Simulation = Simulation;
})(window);
