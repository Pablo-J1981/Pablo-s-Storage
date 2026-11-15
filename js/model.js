/* =========================================================
 * AMR Capa Simulator PRO — Domain Model
 * 파라미터 정의 / 레이아웃 그래프 / 프리셋
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});
  const { clamp } = AMR.util;

  /* ====== 파라미터 스키마 (UI 자동 생성 + 검증 + 스윕 대상) ====== */
  const PARAM_SPEC = [
    // --- 차량 기구 사양 ---
    { key: 'v_max',        group: 'vehicle', label: '최고 주행 속도',        unit: 'm/s',  min: 0.1, max: 3.0,  step: 0.1,  def: 1.2, dec: 1 },
    { key: 'accel',        group: 'vehicle', label: '가속도',                unit: 'm/s²', min: 0.1, max: 2.0,  step: 0.1,  def: 0.6, dec: 2 },
    { key: 'decel',        group: 'vehicle', label: '감속도',                unit: 'm/s²', min: 0.1, max: 2.5,  step: 0.1,  def: 0.8, dec: 2 },
    { key: 'turn_speed',   group: 'vehicle', label: '선회 각속도',           unit: '°/s',  min: 10,  max: 180,  step: 5,    def: 60,  dec: 0 },
    { key: 'turn_thresh',  group: 'vehicle', label: '감속 선회 판정각',      unit: '°',    min: 5,   max: 90,   step: 5,    def: 25,  dec: 0 },
    { key: 'safety_gap',   group: 'vehicle', label: '차간 안전거리',         unit: 'm',    min: 0.3, max: 6.0,  step: 0.1,  def: 1.5, dec: 1 },
    { key: 'payload',      group: 'vehicle', label: '1회 적재 수량(Payload)', unit: 'ea',   min: 1,   max: 8,    step: 1,    def: 1,   dec: 0 },

    // --- 하역 / 포트 ---
    { key: 't_pick',       group: 'port',    label: '피킹 도킹+적재 시간 (1개당)', unit: 's', min: 2, max: 180,  step: 1,    def: 14,  dec: 0 },
    { key: 't_drop',       group: 'port',    label: '드롭 도킹+하역 시간 (1개당)', unit: 's', min: 2, max: 180,  step: 1,    def: 12,  dec: 0 },
    { key: 'cv_service',   group: 'port',    label: '하역시간 변동계수(CV)', unit: '',     min: 0,   max: 0.8,  step: 0.05, def: 0.2, dec: 2 },
    { key: 'port_cap',     group: 'port',    label: '포트 동시 수용 대수',   unit: '대',   min: 1,   max: 4,    step: 1,    def: 1,   dec: 0 },

    // --- 수요 ---
    { key: 'release_interval', group: 'demand', label: '화물 배출 주기',     unit: 's',    min: 1,   max: 3600,  step: 1,    def: 25,  dec: 0 },
    { key: 'demand_cv',    group: 'demand',  label: '수요 도착 변동(CV)',    unit: '',     min: 0,   max: 1.5,  step: 0.1,  def: 0.6, dec: 1 },
    { key: 'peak_ratio',   group: 'demand',  label: '피크 시간 배율',        unit: '×',    min: 1.0, max: 3.0,  step: 0.1,  def: 1.0, dec: 1 },

    // --- 배터리 ---
    { key: 'bat_min',      group: 'battery', label: '충전 복귀 트리거',      unit: '%',    min: 5,   max: 60,   step: 1,    def: 30,  dec: 0 },
    { key: 'bat_max',      group: 'battery', label: '충전 완료 목표',        unit: '%',    min: 50,  max: 100,  step: 1,    def: 80,  dec: 0 },
    { key: 'bat_kwh',      group: 'battery', label: '배터리 용량',           unit: 'kWh',  min: 0.5, max: 20,   step: 0.5,  def: 2.4, dec: 1 },
    { key: 'p_move',       group: 'battery', label: '주행 소비전력',         unit: 'W',    min: 50,  max: 2000, step: 10,   def: 320, dec: 0 },
    { key: 'p_load_add',   group: 'battery', label: '적재 시 추가 전력',     unit: 'W',    min: 0,   max: 1500, step: 10,   def: 140, dec: 0 },
    { key: 'p_idle',       group: 'battery', label: '대기 소비전력',         unit: 'W',    min: 0,   max: 500,  step: 5,    def: 45,  dec: 0 },
    { key: 'charge_kw',    group: 'battery', label: '충전기 출력',           unit: 'kW',   min: 0.2, max: 20,   step: 0.2,  def: 1.6, dec: 1 },
    { key: 'opportunity',  group: 'battery', label: '기회충전 임계(유휴 시)',unit: '%',    min: 0,   max: 100,  step: 5,    def: 60,  dec: 0 },

    // --- 운영 / 플릿 ---
    { key: 'fleet',        group: 'ops',     label: '투입 AMR 대수',         unit: '대',   min: 1,   max: 60,   step: 1,    def: 8,   dec: 0 },
    { key: 'oee',          group: 'ops',     label: '설비 종합 효율(OEE)',   unit: '%',    min: 40,  max: 100,  step: 1,    def: 92,  dec: 0 },
    { key: 'mtbf',         group: 'ops',     label: '평균 고장 간격(MTBF)',  unit: '분',   min: 10,  max: 6000, step: 10,   def: 1200,dec: 0 },
    { key: 'mttr',         group: 'ops',     label: '평균 복구 시간(MTTR)',  unit: '분',   min: 0,   max: 120,  step: 1,    def: 6,   dec: 0 },
    { key: 'pixel_scale',  group: 'ops',     label: '축척 (100px 당 실거리)',unit: 'm',    min: 1,   max: 200,  step: 1,    def: 15,  dec: 0 },
    { key: 'shift_hours',  group: 'ops',     label: '일 가동 시간',          unit: 'h',    min: 1,   max: 24,   step: 0.5,  def: 20,  dec: 1 },

    // --- 경제성 ---
    { key: 'cost_amr',     group: 'cost',    label: 'AMR 1대 도입단가',      unit: '만원', min: 500, max: 30000,step: 100,  def: 6500,dec: 0 },
    { key: 'cost_oper',    group: 'cost',    label: '대당 연간 운영비',      unit: '만원', min: 0,   max: 5000, step: 50,   def: 450, dec: 0 },
    { key: 'labor_cost',   group: 'cost',    label: '대체 인력 연간 인건비', unit: '만원', min: 0,   max: 20000,step: 100,  def: 4800,dec: 0 },
    { key: 'labor_uph',    group: 'cost',    label: '작업자 1인 시간당 처리',unit: 'UPH',  min: 1,   max: 200,  step: 1,    def: 22,  dec: 0 }
  ];

  const PARAM_MAP = Object.fromEntries(PARAM_SPEC.map((p) => [p.key, p]));

  function defaultParams() {
    const p = {};
    PARAM_SPEC.forEach((s) => (p[s.key] = s.def));
    // 비수치 설정
    p.dispatch_algo = 'hungarian';
    p.traffic_model = 'reservation';   // 'reservation' | 'softgap' | 'none'
    p.release_mode = 'total';          // 'total' | 'per_station'
    p.destination_mode = 'random';     // 'random' | 'mapped'
    p.pick_drop_map = {};
    p.auto_release = true;
    p.charge_policy = 'threshold';     // 'threshold' | 'opportunity'
    p.bidirectional = true;            // false 면 양방향 통로를 a→b 일방통행으로 취급
    p.failures = false;                // 고장 모델
    p.seed = 20260101;
    return p;
  }

  function sanitize(params, key, raw) {
    const spec = PARAM_MAP[key];
    if (!spec) { params[key] = raw; return raw; }
    let v = parseFloat(raw);
    if (!isFinite(v)) v = spec.def;
    v = clamp(v, spec.min, spec.max);
    v = spec.step >= 1 ? Math.round(v / spec.step) * spec.step : Math.round(v * 1000) / 1000;
    params[key] = v;
    return v;
  }

  /* ====== 레이아웃 그래프 ====== */
  const NODE_TYPES = {
    pick:     { label: '피킹', color: '#10b981', w: 60, h: 40 },
    drop:     { label: '드롭', color: '#f37321', w: 56, h: 38 },
    charge:   { label: '충전', color: '#f43f5e', w: 58, h: 34 },
    park:     { label: '대기', color: '#8b5cf6', w: 50, h: 30 },
    waypoint: { label: '노드', color: '#94a3b8', w: 10, h: 10 }
  };

  class Layout {
    constructor() { this.reset(); }
    reset() {
      this.nodes = [];
      this.edges = [];       // {a,b,dir:'both'|'ab'|'ba', lanes:1, speedFactor:1}
      this.counters = { P: 0, D: 0, C: 0, K: 0, N: 0 };
      this.name = '빈 레이아웃';
    }

    /* --- 조회 인덱스 (배열이 바뀌면 자동 재생성) --- */
    _reindex() {
      if (this._src === this.nodes && this._len === this.nodes.length) return;
      this._idx = new Map(); this._types = {};
      this.nodes.forEach((n) => {
        this._idx.set(n.id, n);
        (this._types[n.type] = this._types[n.type] || []).push(n);
      });
      this._src = this.nodes; this._len = this.nodes.length;
    }
    node(id) { this._reindex(); return this._idx.get(id) || null; }
    byType(t) { this._reindex(); return this._types[t] || []; }
    edgeBetween(a, b) {
      if (this._eSrc !== this.edges || this._eLen !== this.edges.length) {
        this._eIdx = new Map(this.edges.map((e) => [this.edgeKey(e.a, e.b), e]));
        this._eSrc = this.edges; this._eLen = this.edges.length;
      }
      return this._eIdx.get(this.edgeKey(a, b)) || null;
    }
    hasEdge(a, b) { return !!this.edgeBetween(a, b); }

    nextId(type) {
      const pfx = { pick: 'P', drop: 'D', charge: 'C', park: 'K', waypoint: 'N' }[type];
      this.counters[pfx] = (this.counters[pfx] || 0) + 1;
      let id = pfx + this.counters[pfx];
      while (this.node(id)) { this.counters[pfx]++; id = pfx + this.counters[pfx]; }
      return id;
    }
    addNode(type, x, y, name) {
      const id = this.nextId(type);
      const n = {
        id, type, x, y,
        name: name || `${NODE_TYPES[type].label} ${id}`,
        occupants: [],         // 현재 점유 로봇 id
        queue: 0,              // 대기 로봇 수
        buffer: 0,             // 미처리 화물 수 (pick)
        processed: 0,          // 처리 누적
        waitAccum: 0,          // 누적 대기 시간
        priority: 1            // 수요 가중치
      };
      this.nodes.push(n);
      return n;
    }
    removeNode(id) {
      this.nodes = this.nodes.filter((n) => n.id !== id);
      this.edges = this.edges.filter((e) => e.a !== id && e.b !== id);
    }
    addEdge(a, b, dir = 'both') {
      if (a === b || this.hasEdge(a, b)) return null;
      const e = { a, b, dir, lanes: 1, speedFactor: 1, flow: 0, load: 0 };
      this.edges.push(e);
      return e;
    }
    removeEdge(e) { this.edges = this.edges.filter((x) => x !== e); }
    edgeKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
    toJSON() {
      return { name: this.name, nodes: this.nodes, edges: this.edges, counters: this.counters };
    }
    fromJSON(o) {
      if (!o || !Array.isArray(o.nodes)) return false;
      this.nodes = o.nodes.map((n) => ({
        occupants: [], queue: 0, buffer: 0, processed: 0, waitAccum: 0, priority: 1, ...n
      }));
      this.edges = (o.edges || []).map((e) =>
        Array.isArray(e)
          ? { a: e[0], b: e[1], dir: 'both', lanes: 1, speedFactor: 1, flow: 0, load: 0 }
          : { dir: 'both', lanes: 1, speedFactor: 1, flow: 0, load: 0, ...e }
      );
      this.counters = { P: 0, D: 0, C: 0, K: 0, N: 0, ...(o.counters || {}) };
      ['pick', 'drop', 'charge', 'park', 'waypoint'].forEach((t) => {
        const pfx = { pick: 'P', drop: 'D', charge: 'C', park: 'K', waypoint: 'N' }[t];
        const max = this.byType(t).reduce((m, n) => {
          const num = parseInt(String(n.id).replace(/\D/g, ''), 10);
          return isFinite(num) ? Math.max(m, num) : m;
        }, 0);
        this.counters[pfx] = Math.max(this.counters[pfx] || 0, max);
      });
      this.name = o.name || '불러온 레이아웃';
      return true;
    }
  }

  /* ====== 레이아웃 프리셋 ====== */
  const PRESETS = {
    grid_factory: {
      label: '🏭 표준 스마트공장 (그리드)',
      desc: '피킹 4 · 드롭 4 · 충전 3 · 격자 통로',
      build(L) {
        L.reset(); L.name = '표준 스마트공장';
        const W = 980, H = 620;
        const cols = 6, rows = 4;
        const grid = {};
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const n = L.addNode('waypoint', 150 + c * ((W - 280) / (cols - 1)), 90 + r * ((H - 230) / (rows - 1)));
            grid[`${r}_${c}`] = n.id;
          }
        }
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols - 1; c++) L.addEdge(grid[`${r}_${c}`], grid[`${r}_${c + 1}`]);
        for (let c = 0; c < cols; c++)
          for (let r = 0; r < rows - 1; r++) L.addEdge(grid[`${r}_${c}`], grid[`${r + 1}_${c}`]);
        for (let r = 0; r < rows; r++) {
          const p = L.addNode('pick', 62, 90 + r * ((H - 230) / (rows - 1)), `피킹 #${r + 1}`);
          L.addEdge(p.id, grid[`${r}_0`]);
          const d = L.addNode('drop', W - 52, 90 + r * ((H - 230) / (rows - 1)), `드롭 #${r + 1}`);
          L.addEdge(d.id, grid[`${r}_${cols - 1}`]);
        }
        for (let i = 0; i < 3; i++) {
          const c = L.addNode('charge', 300 + i * 190, H - 60, `충전소 #${i + 1}`);
          L.addEdge(c.id, grid[`${rows - 1}_${1 + i * 2}`]);
        }
        const k = L.addNode('park', W / 2, H - 120, '대기존');
        L.addEdge(k.id, grid[`${rows - 1}_${2}`]);
        L.addEdge(k.id, grid[`${rows - 1}_${3}`]);
      }
    },
    loop_conveyor: {
      label: '🔁 단방향 루프 (일방통행)',
      desc: '혼잡 최소화형 원형 순환 통로',
      build(L) {
        L.reset(); L.name = '단방향 루프';
        const cx = 500, cy = 320, rx = 360, ry = 220, N = 16;
        const ring = [];
        for (let i = 0; i < N; i++) {
          const t = (i / N) * Math.PI * 2;
          ring.push(L.addNode('waypoint', cx + rx * Math.cos(t), cy + ry * Math.sin(t)).id);
        }
        for (let i = 0; i < N; i++) L.addEdge(ring[i], ring[(i + 1) % N], 'ab');
        const picks = [2, 5]; const drops = [10, 13];
        picks.forEach((idx, i) => {
          const r = L.node(ring[idx]);
          const p = L.addNode('pick', r.x + 70, r.y + 70, `피킹 #${i + 1}`);
          L.addEdge(ring[idx], p.id); L.addEdge(p.id, ring[(idx + 1) % N]);
        });
        drops.forEach((idx, i) => {
          const r = L.node(ring[idx]);
          const d = L.addNode('drop', r.x - 70, r.y - 70, `드롭 #${i + 1}`);
          L.addEdge(ring[idx], d.id); L.addEdge(d.id, ring[(idx + 1) % N]);
        });
        const c1 = L.addNode('charge', cx, cy, '충전소 #1');
        L.addEdge(ring[0], c1.id); L.addEdge(c1.id, ring[8]);
      }
    },
    cross_dock: {
      label: '🚚 크로스도크 물류센터',
      desc: '입고 6 · 출고 6 · 중앙 간선 통로',
      build(L) {
        L.reset(); L.name = '크로스도크 센터';
        const W = 1000, laneY = [200, 320, 440];
        const spineIds = [];
        for (let i = 0; i < 9; i++) {
          const n = L.addNode('waypoint', 100 + i * ((W - 200) / 8), 320);
          spineIds.push(n.id);
          if (i > 0) L.addEdge(spineIds[i - 1], n.id);
        }
        for (let i = 0; i < 6; i++) {
          const x = 140 + i * ((W - 280) / 5);
          const up = L.addNode('waypoint', x, laneY[0]);
          const dn = L.addNode('waypoint', x, laneY[2]);
          const near = spineIds[Math.min(8, Math.round((x - 100) / ((W - 200) / 8)))];
          L.addEdge(up.id, near); L.addEdge(dn.id, near);
          const p = L.addNode('pick', x, 110, `입고독 #${i + 1}`);
          L.addEdge(p.id, up.id);
          const d = L.addNode('drop', x, 530, `출고독 #${i + 1}`);
          L.addEdge(d.id, dn.id);
        }
        const c1 = L.addNode('charge', 60, 320, '충전소 #1');
        L.addEdge(c1.id, spineIds[0]);
        const c2 = L.addNode('charge', W - 60, 320, '충전소 #2');
        L.addEdge(c2.id, spineIds[8]);
      }
    },
    fishbone: {
      label: '🐟 피쉬본 창고 (사선 통로)',
      desc: '대각 간선 통로 + 좌우 피킹 랙',
      build(L) {
        L.reset(); L.name = '피쉬본 창고';
        const spine = [];
        for (let i = 0; i < 7; i++) {
          const n = L.addNode('waypoint', 120 + i * 130, 540 - i * 60);
          spine.push(n.id);
          if (i > 0) L.addEdge(spine[i - 1], n.id);
        }
        for (let i = 1; i < 7; i++) {
          const s = L.node(spine[i]);
          const a = L.addNode('waypoint', s.x - 70, s.y - 90);
          L.addEdge(s.id, a.id);
          const p = L.addNode('pick', a.x - 40, a.y - 60, `피킹 #${i}`);
          L.addEdge(a.id, p.id);
        }
        for (let i = 0; i < 3; i++) {
          const d = L.addNode('drop', 760 + i * 90, 520, `출하 #${i + 1}`);
          L.addEdge(d.id, spine[Math.min(6, 4 + i)]);
        }
        const c = L.addNode('charge', 70, 560, '충전소 #1');
        L.addEdge(c.id, spine[0]);
      }
    }
  };

  AMR.model = { PARAM_SPEC, PARAM_MAP, defaultParams, sanitize, NODE_TYPES, Layout, PRESETS };
})(window);
