/* =========================================================
 * AMR Capa Simulator PRO — Graph & Pathfinding
 * 방향성 간선 · 힙 Dijkstra · 경로 캐시 · 혼잡 가중(동적 비용)
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});
  const { MinHeap } = AMR.util;

  class Graph {
    constructor(layout, params) {
      this.layout = layout;
      this.params = params;
      this.version = 0;
      this.adj = new Map();        // id -> [{to, w(px), edge}]
      this.pos = new Map();        // id -> {x,y}
      this.cache = new Map();      // "a>b" -> {path, px}
      this.congestion = new Map(); // edgeKey -> 0..1 혼잡도 (동적)
      this.rebuild();
    }

    /** 전역 '양방향 허용' 해제 시 both → a→b 일방통행으로 취급 */
    effDir(e) {
      return (e.dir === 'both' && this.params.bidirectional === false) ? 'ab' : e.dir;
    }

    /** 레이아웃 변경 시 호출 */
    rebuild() {
      const L = this.layout;
      this.adj.clear(); this.pos.clear(); this.cache.clear();
      L.nodes.forEach((n) => { this.adj.set(n.id, []); this.pos.set(n.id, { x: n.x, y: n.y }); });
      L.edges.forEach((e) => {
        const a = L.node(e.a), b = L.node(e.b);
        if (!a || !b) return;
        const w = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(0.1, e.speedFactor || 1);
        const dir = this.effDir(e);
        if (dir === 'both' || dir === 'ab') this.adj.get(a.id).push({ to: b.id, w, edge: e });
        if (dir === 'both' || dir === 'ba') this.adj.get(b.id).push({ to: a.id, w, edge: e });
      });
      this.version++;
    }

    invalidateCache() { this.cache.clear(); }

    /** 혼잡 가중치 설정 (0=자유, 1=포화) */
    setCongestion(edgeKey, v) { this.congestion.set(edgeKey, v); }

    decayCongestion(f = 0.97) {
      this.congestion.forEach((v, k) => {
        const nv = v * f;
        if (nv < 0.01) this.congestion.delete(k); else this.congestion.set(k, nv);
      });
    }

    _edgeCost(e, baseW, avoidCongestion) {
      if (!avoidCongestion) return baseW;
      const c = this.congestion.get(this.layout.edgeKey(e.a, e.b)) || 0;
      return baseW * (1 + 2.2 * c);   // 혼잡 간선은 최대 3.2배 비용
    }

    /**
     * 최단경로. avoidCongestion=true 면 동적 혼잡비용 반영(캐시 미사용).
     * @param {string|null} excludedEdge edgeKey to omit during search
     * @returns {{path:string[], px:number, ok:boolean}}
     */
    findPath(from, to, avoidCongestion = false, excludedEdge = null) {
      if (!from || !to) return { path: [], px: Infinity, ok: false };
      if (from === to) return { path: [from], px: 0, ok: true };

      const ck = from + '>' + to;
      if (!avoidCongestion && !excludedEdge) {
        const hit = this.cache.get(ck);
        if (hit) return { path: hit.path, px: hit.px, ok: hit.ok };
      }

      const dist = new Map(), prev = new Map(), done = new Set();
      const heap = new MinHeap();
      dist.set(from, 0);
      heap.push(0, from);

      while (heap.size) {
        const top = heap.pop();
        const u = top.v;
        if (done.has(u)) continue;
        done.add(u);
        if (u === to) break;
        const nbrs = this.adj.get(u) || [];
        for (const nb of nbrs) {
          if (excludedEdge && this.layout.edgeKey(u, nb.to) === excludedEdge) continue;
          if (done.has(nb.to)) continue;
          const cost = (dist.get(u) || 0) + this._edgeCost(nb.edge, nb.w, avoidCongestion);
          if (cost < (dist.has(nb.to) ? dist.get(nb.to) : Infinity)) {
            dist.set(nb.to, cost);
            prev.set(nb.to, u);
            heap.push(cost, nb.to);
          }
        }
      }

      let res;
      if (!dist.has(to)) {
        res = { path: [], px: Infinity, ok: false };
      } else {
        const path = [];
        let s = to;
        while (s !== undefined) { path.unshift(s); s = prev.get(s); }
        // 실제 기하 거리(혼잡 가중 제외)로 px 재계산
        res = { path, px: this.pathPixels(path), ok: true };
      }
      if (!avoidCongestion && !excludedEdge) this.cache.set(ck, res);
      return res;
    }

    pathPixels(path) {
      let d = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const a = this.pos.get(path[i]), b = this.pos.get(path[i + 1]);
        if (a && b) d += Math.hypot(a.x - b.x, a.y - b.y);
      }
      return d;
    }

    pxToM(px) { return px * (this.params.pixel_scale / 100); }
    mToPx(m) { return m / (this.params.pixel_scale / 100); }

    distanceM(from, to) {
      const r = this.findPath(from, to);
      return r.ok ? this.pxToM(r.px) : Infinity;
    }

    /** 경로의 누적 회전각 합(도) — 사이클타임 추정용 */
    pathTurnDegrees(path) {
      let total = 0;
      for (let i = 1; i < path.length - 1; i++) {
        const a = this.pos.get(path[i - 1]), b = this.pos.get(path[i]), c = this.pos.get(path[i + 1]);
        if (!a || !b || !c) continue;
        const a1 = Math.atan2(b.y - a.y, b.x - a.x);
        const a2 = Math.atan2(c.y - b.y, c.x - b.x);
        let d = Math.abs((a2 - a1) * 180 / Math.PI) % 360;
        if (d > 180) d = 360 - d;
        total += d;
      }
      return total;
    }

    /** 연결성 검사: 도달 불가 노드쌍 리스트 */
    connectivityReport() {
      const L = this.layout;
      const picks = L.byType('pick'), drops = L.byType('drop'), charges = L.byType('charge');
      const broken = [];
      picks.forEach((p) => drops.forEach((d) => {
        if (!this.findPath(p.id, d.id).ok) broken.push([p.id, d.id]);
        if (!this.findPath(d.id, p.id).ok) broken.push([d.id, p.id]);
      }));
      drops.forEach((d) => charges.forEach((c) => {
        if (!this.findPath(d.id, c.id).ok) broken.push([d.id, c.id]);
      }));
      const isolated = L.nodes.filter((n) => (this.adj.get(n.id) || []).length === 0).map((n) => n.id);
      return { broken, isolated };
    }

    /** From-To 전체 매트릭스 (거리 m, 경유) */
    matrix() {
      const L = this.layout;
      const picks = L.byType('pick'), drops = L.byType('drop');
      const rows = [];
      picks.forEach((p) => drops.forEach((d) => {
        const fwd = this.findPath(p.id, d.id);
        const back = this.findPath(d.id, p.id);
        rows.push({
          from: p, to: d,
          distM: fwd.ok ? this.pxToM(fwd.px) : Infinity,
          backM: back.ok ? this.pxToM(back.px) : Infinity,
          path: fwd.path,
          turns: fwd.ok ? this.pathTurnDegrees(fwd.path) : 0,
          ok: fwd.ok && back.ok
        });
      }));
      return rows;
    }

    /**
     * 사다리꼴 속도 프로파일 기반 구간 주행시간(초).
     * 거리 m, 최고속도 v, 가속 a, 감속 d.
     */
    travelTime(distM, p) {
      const v = Math.max(0.05, p.v_max), a = Math.max(0.05, p.accel), dd = Math.max(0.05, p.decel);
      const dAcc = (v * v) / (2 * a), dDec = (v * v) / (2 * dd);
      if (distM <= 0) return 0;
      if (dAcc + dDec <= distM) {
        return v / a + v / dd + (distM - dAcc - dDec) / v;
      }
      // 삼각 프로파일: 최고속 도달 전 감속 시작
      const vp = Math.sqrt((2 * distM * a * dd) / (a + dd));
      return vp / a + vp / dd;
    }

    /** 경로 전체 소요시간(초) = 주행(구간 속도계수 반영) + 회전 */
    pathTime(path, p) {
      if (!path || path.length < 2) return 0;
      let t = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const A = this.pos.get(path[i]), B = this.pos.get(path[i + 1]);
        if (!A || !B) continue;
        const e = this.layout.edgeBetween(path[i], path[i + 1]);
        const sf = e ? (e.speedFactor || 1) : 1;
        t += this.travelTime(
          this.pxToM(Math.hypot(A.x - B.x, A.y - B.y)),
          sf === 1 ? p : { ...p, v_max: p.v_max * sf }
        );
      }
      t += (this.pathTurnDegrees(path) / Math.max(5, p.turn_speed));
      return t;
    }
  }

  AMR.Graph = Graph;
})(window);
