/* =========================================================
 * AMR Capa Simulator PRO — Utilities
 * 재현 가능한 난수(시드), 통계, 포맷터, 경량 자료구조
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});

  /* ---------- Deterministic PRNG (mulberry32) ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class RNG {
    constructor(seed = 20260101) { this.reset(seed); }
    reset(seed) { this.seed = seed >>> 0; this._r = mulberry32(this.seed); this._spare = null; }
    next() { return this._r(); }
    range(a, b) { return a + (b - a) * this._r(); }
    int(a, b) { return Math.floor(this.range(a, b + 1)); }
    pick(arr) { return arr.length ? arr[Math.floor(this._r() * arr.length)] : null; }
    bool(p = 0.5) { return this._r() < p; }
    /** 표준정규 (Box–Muller, 캐시 사용) */
    normal(mu = 0, sigma = 1) {
      if (this._spare !== null) { const s = this._spare; this._spare = null; return mu + sigma * s; }
      let u = 0, v = 0, s = 0;
      do { u = this._r() * 2 - 1; v = this._r() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
      const f = Math.sqrt((-2 * Math.log(s)) / s);
      this._spare = v * f;
      return mu + sigma * u * f;
    }
    /** 평균 mean, 변동계수 cv 의 양수 서비스시간 (로그정규) */
    service(mean, cv) {
      if (cv <= 0.001 || mean <= 0) return Math.max(0, mean);
      const s2 = Math.log(1 + cv * cv);
      const mu = Math.log(mean) - s2 / 2;
      return Math.exp(mu + Math.sqrt(s2) * this.normal(0, 1));
    }
    /** 지수분포 (평균 mean) */
    exp(mean) { return -Math.log(1 - this._r()) * mean; }
    /** 가중 선택 */
    weighted(items, weightFn) {
      let total = 0;
      for (const it of items) total += Math.max(0, weightFn(it));
      if (total <= 0) return this.pick(items);
      let r = this._r() * total;
      for (const it of items) { r -= Math.max(0, weightFn(it)); if (r <= 0) return it; }
      return items[items.length - 1];
    }
  }

  /* ---------- Binary Min-Heap (Dijkstra 용) ---------- */
  class MinHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(key, val) {
      const a = this.a; a.push({ k: key, v: val });
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].k <= a[i].k) break;
        const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
      }
    }
    pop() {
      const a = this.a; if (!a.length) return null;
      const top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l].k < a[m].k) m = l;
          if (r < a.length && a[r].k < a[m].k) m = r;
          if (m === i) break;
          const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
        }
      }
      return top;
    }
  }

  /* ---------- 통계 ---------- */
  const stat = {
    mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; },
    sum(arr) { return arr.reduce((a, b) => a + b, 0); },
    std(arr) {
      if (arr.length < 2) return 0;
      const m = stat.mean(arr);
      return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
    },
    pct(arr, p) {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const idx = Math.min(s.length - 1, Math.max(0, Math.round(((s.length - 1) * p) / 100)));
      return s[idx];
    },
    ci95(arr) { return arr.length > 1 ? 1.96 * (stat.std(arr) / Math.sqrt(arr.length)) : 0; },
    /** Erlang-C: c개 서버, 제공부하 a(Erlang) 일 때 대기확률 */
    erlangC(c, a) {
      if (c <= 0) return 1;
      if (a >= c) return 1;
      let sum = 0, term = 1;
      for (let k = 0; k < c; k++) { if (k > 0) term *= a / k; sum += term; }
      const last = (term * a) / c;
      const pc = last / (1 - a / c);
      return pc / (sum + pc);
    }
  };

  /* ---------- 롤링 윈도 ---------- */
  class Rolling {
    constructor(limit = 200) { this.limit = limit; this.items = []; }
    push(v) { this.items.push(v); if (this.items.length > this.limit) this.items.shift(); }
    get length() { return this.items.length; }
    mean() { return stat.mean(this.items); }
    clear() { this.items.length = 0; }
  }

  /* ---------- 포맷 ---------- */
  const fmt = {
    clock(sec) {
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },
    dur(sec) {
      if (!isFinite(sec)) return '-';
      if (sec < 60) return `${sec.toFixed(0)}초`;
      const m = Math.floor(sec / 60), s = Math.round(sec % 60);
      if (m < 60) return `${m}분 ${s}초`;
      return `${Math.floor(m / 60)}시간 ${m % 60}분`;
    },
    n(v, d = 1) { return (isFinite(v) ? v : 0).toFixed(d); },
    int(v) { return Math.round(isFinite(v) ? v : 0).toLocaleString('ko-KR'); },
    pct(v, d = 1) { return `${(isFinite(v) ? v : 0).toFixed(d)}%`; }
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist2d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const uid = (p) => `${p}${Math.random().toString(36).slice(2, 7)}`;

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function toCSV(headers, rows) {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return '\uFEFF' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  }

  AMR.util = { mulberry32, RNG, MinHeap, stat, Rolling, fmt, clamp, lerp, dist2d, uid, downloadBlob, toCSV };
})(window);
