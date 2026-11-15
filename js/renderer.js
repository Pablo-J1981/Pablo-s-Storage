/* =========================================================
 * AMR Capa Simulator PRO — Canvas Renderer
 * 줌/팬 · 혼잡 히트맵 · 방향 화살표 · 로봇 궤적 · 스케일바
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});
  const { clamp } = AMR.util;

  const PALETTE = {
    pick: '#10b981', drop: '#f37321', charge: '#f43f5e', park: '#8b5cf6', waypoint: '#94a3b8'
  };

  class Renderer {
    constructor(canvas, sim) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.sim = sim;
      this.view = { x: 0, y: 0, k: 1 };
      this.show = {
        grid: true, labels: true, dist: true, heat: true,
        arrows: true, trails: false, ids: true, ranges: false
      };
      this.hover = null;
      this.hoverEdge = null;
      this.selected = null;       // 선택된 노드
      this.selectedEdge = null;   // 선택된 통로
      this.edgeStart = null;
      this.ghost = null;
      this.mouseWorld = null;
      this.dpr = Math.min(2, global.devicePixelRatio || 1);
    }

    resize() {
      const el = this.canvas.parentElement;
      const w = el.clientWidth, h = el.clientHeight;
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.w = w; this.h = h;
    }

    toWorld(sx, sy) { return { x: (sx - this.view.x) / this.view.k, y: (sy - this.view.y) / this.view.k }; }
    toScreen(wx, wy) { return { x: wx * this.view.k + this.view.x, y: wy * this.view.k + this.view.y }; }

    zoom(f, cx, cy) {
      if (cx === undefined) { cx = this.w / 2; cy = this.h / 2; }
      const k = clamp(this.view.k * f, 0.2, 5);
      const af = k / this.view.k;
      this.view.x = cx - (cx - this.view.x) * af;
      this.view.y = cy - (cy - this.view.y) * af;
      this.view.k = k;
    }

    fitToContent(pad = 70) {
      const ns = this.sim.layout.nodes;
      if (!ns.length) { this.view = { x: 0, y: 0, k: 1 }; return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      ns.forEach((n) => { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); });
      const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
      const k = clamp(Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh), 0.2, 2.5);
      this.view.k = k;
      this.view.x = (this.w - bw * k) / 2 - x0 * k;
      this.view.y = (this.h - bh * k) / 2 - y0 * k;
    }

    nodeAt(wp) {
      const ns = this.sim.layout.nodes;
      for (let i = ns.length - 1; i >= 0; i--) {
        const n = ns[i];
        const hw = n.type === 'waypoint' ? 12 : 32;
        const hh = n.type === 'waypoint' ? 12 : 22;
        if (Math.abs(n.x - wp.x) <= hw && Math.abs(n.y - wp.y) <= hh) return n;
      }
      return null;
    }

    edgeAt(wp, tol = 10) {
      const L = this.sim.layout;
      for (const e of L.edges) {
        const a = L.node(e.a), b = L.node(e.b);
        if (!a || !b) continue;
        const l2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (l2 === 0) continue;
        let t = ((wp.x - a.x) * (b.x - a.x) + (wp.y - a.y) * (b.y - a.y)) / l2;
        t = clamp(t, 0, 1);
        const px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
        if ((wp.x - px) ** 2 + (wp.y - py) ** 2 <= tol * tol) return e;
      }
      return null;
    }

    css(name, fb) {
      const v = getComputedStyle(document.body).getPropertyValue(name);
      return (v && v.trim()) || fb;
    }

    draw() {
      const ctx = this.ctx;
      const cl = document.body.classList;
      const dark = cl.contains('theme-dark') || cl.contains('theme-midnight');
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.fillStyle = this.css('--canvas-bg', dark ? '#0b1220' : '#f8fafc');
      ctx.fillRect(0, 0, this.w, this.h);

      ctx.save();
      ctx.translate(this.view.x, this.view.y);
      ctx.scale(this.view.k, this.view.k);

      if (this.show.grid) this.drawGrid(dark);
      this.drawEdges(dark);
      if (this.edgeStart) this.drawPendingEdge();
      this.drawNodes(dark);
      if (this.show.trails) this.drawPaths();
      this.drawRobots(dark);
      if (this.ghost) this.drawGhost();

      ctx.restore();
      this.drawScaleBar(dark);
      this.drawLegend(dark);
      ctx.restore();
    }

    drawGrid(dark) {
      const ctx = this.ctx, k = this.view.k;
      const step = 40;
      const x0 = Math.floor(-this.view.x / k / step) * step - step;
      const y0 = Math.floor(-this.view.y / k / step) * step - step;
      const x1 = x0 + this.w / k + step * 2;
      const y1 = y0 + this.h / k + step * 2;
      ctx.strokeStyle = dark ? 'rgba(148,163,184,0.09)' : 'rgba(100,116,139,0.13)';
      ctx.lineWidth = 1 / k;
      ctx.beginPath();
      for (let x = x0; x < x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
      for (let y = y0; y < y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
      ctx.stroke();
    }

    heatColor(v) {
      // 0 (녹) → 0.5 (황) → 1 (적)
      const c = clamp(v, 0, 1);
      const r = c < 0.5 ? Math.round(255 * (c / 0.5)) : 255;
      const g = c < 0.5 ? 190 : Math.round(190 * (1 - (c - 0.5) / 0.5));
      return `rgb(${r},${g},70)`;
    }

    drawEdges(dark) {
      const ctx = this.ctx, sim = this.sim, L = sim.layout, k = this.view.k;
      const g = sim.graph;
      L.edges.forEach((e) => {
        const a = L.node(e.a), b = L.node(e.b);
        if (!a || !b) return;
        const key = L.edgeKey(e.a, e.b);
        const cong = this.show.heat ? (g.congestion.get(key) || 0) : 0;
        const occ = sim.edgeOccupancy.get(key);
        const busy = occ ? occ.size : 0;
        const isHover = this.hoverEdge === e;
        const isSel = this.selectedEdge === e;
        const dir = g.effDir(e);   // 전역 '양방향 허용' 해제 반영

        ctx.save();
        if (cong > 0.05) {
          ctx.strokeStyle = this.heatColor(cong);
          ctx.globalAlpha = 0.28 + 0.45 * cong;
          ctx.lineWidth = (7 + 10 * cong);
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = isSel ? '#0ea5e9' : isHover ? '#f43f5e'
          : (busy > 0 ? '#f59e0b' : (dark ? 'rgba(148,163,184,0.45)' : 'rgba(100,116,139,0.5)'));
        ctx.lineWidth = isSel ? 4.5 : isHover ? 4 : (e.lanes > 1 ? 3.4 : 2.2);
        if (dir === 'both') ctx.setLineDash([7, 5]); else ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.setLineDash([]);

        // 방향 화살표 (일방통행)
        if (this.show.arrows && dir !== 'both') {
          const fwd = dir === 'ab';
          const sx = fwd ? a.x : b.x, sy = fwd ? a.y : b.y;
          const ex = fwd ? b.x : a.x, ey = fwd ? b.y : a.y;
          const ang = Math.atan2(ey - sy, ex - sx);
          // 거리 라벨과 겹치지 않도록 65% 지점에 표시
          const mx = sx + (ex - sx) * 0.68, my = sy + (ey - sy) * 0.68;
          ctx.fillStyle = '#0ea5e9';
          ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
          ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, 5.5); ctx.lineTo(-6, -5.5); ctx.closePath(); ctx.fill();
          ctx.restore();
        }

        // 거리 라벨 (+ 차선 수 / 속도 계수)
        if (this.show.dist && k > 0.55) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const m = g.pxToM(Math.hypot(a.x - b.x, a.y - b.y));
          const sf = e.speedFactor || 1;
          const txt = `${m.toFixed(1)}m${e.lanes > 1 ? ' ×' + e.lanes : ''}${sf < 1 ? ' ⏷' + Math.round(sf * 100) + '%' : ''}`;
          ctx.font = `700 ${10 / Math.max(0.7, Math.min(1.3, k))}px "Pretendard","Nanum Gothic",sans-serif`;
          const tw = ctx.measureText(txt).width;
          ctx.fillStyle = dark ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.94)';
          ctx.strokeStyle = isSel ? '#0ea5e9' : cong > 0.3 ? this.heatColor(cong) : (dark ? '#334155' : '#cbd5e1');
          ctx.lineWidth = 1.2;
          const bw = tw + 10, bh = 15;
          ctx.beginPath(); ctx.roundRect(mx - bw / 2, my - bh / 2, bw, bh, 4); ctx.fill(); ctx.stroke();
          ctx.fillStyle = dark ? '#e2e8f0' : '#1e293b';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(txt, mx, my + 0.5);
        }
        ctx.restore();
      });
    }

    drawPendingEdge() {
      const ctx = this.ctx;
      const s = this.edgeStart;
      const t = this.hover || this.mouseWorld;
      if (!s || !t) return;
      ctx.save();
      ctx.strokeStyle = '#f37321'; ctx.lineWidth = 2.6; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      ctx.restore();
    }

    drawNodes(dark) {
      const ctx = this.ctx, sim = this.sim;
      const selCol = dark ? '#38bdf8' : '#0f172a';
      sim.layout.nodes.forEach((n) => {
        const isHover = this.hover === n;
        const isSel = this.selected === n || this.edgeStart === n;
        const col = PALETTE[n.type] || '#94a3b8';
        ctx.save();

        if (n.type === 'waypoint') {
          ctx.fillStyle = isSel ? selCol : (isHover ? '#0ea5e9' : (dark ? 'rgba(148,163,184,0.6)' : '#94a3b8'));
          ctx.beginPath(); ctx.arc(n.x, n.y, isSel || isHover ? 6 : 4.2, 0, Math.PI * 2); ctx.fill();
          if (this.show.ids && this.view.k > 1.1) {
            ctx.fillStyle = dark ? '#64748b' : '#94a3b8';
            ctx.font = '600 8px "Pretendard",sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(n.id, n.x, n.y - 9);
          }
          ctx.restore();
          return;
        }

        const W = n.type === 'pick' ? 62 : n.type === 'drop' ? 58 : 56;
        const H = n.type === 'charge' ? 34 : 40;
        const occ = n.occupants.length;
        const full = occ >= sim.params.port_cap;
        const queued = n.queue > 0;

        // 그림자/글로우
        ctx.shadowColor = queued ? 'rgba(245,158,11,0.55)' : 'rgba(0,0,0,0.18)';
        ctx.shadowBlur = queued ? 14 : 6;
        ctx.shadowOffsetY = 2;

        ctx.fillStyle = dark ? 'rgba(15,23,42,0.88)' : 'rgba(255,255,255,0.96)';
        ctx.strokeStyle = isSel ? selCol : (full ? '#f43f5e' : col);
        ctx.lineWidth = isSel ? 3.4 : (full || isHover ? 3 : 2.2);
        ctx.beginPath(); ctx.roundRect(n.x - W / 2, n.y - H / 2, W, H, 8); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // 상단 컬러 바
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.roundRect(n.x - W / 2 + 1.5, n.y - H / 2 + 1.5, W - 3, 5, 3); ctx.fill();
        ctx.globalAlpha = 1;

        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (this.show.labels) {
          ctx.fillStyle = dark ? '#e2e8f0' : '#0f172a';
          ctx.font = '800 10px "Pretendard","Nanum Gothic",sans-serif';
          const label = n.name.length > 9 ? n.id : n.name;
          ctx.fillText(label, n.x, n.y - 3);
        }

        ctx.font = '700 8.6px "Pretendard",sans-serif';
        if (n.type === 'pick') {
          const over = n.buffer >= 6;
          ctx.fillStyle = over ? '#dc2626' : '#d97706';
          ctx.fillText(`📦 ${n.buffer}${queued ? ` · ⏳${n.queue}` : ''}`, n.x, n.y + 10);
        } else if (n.type === 'drop') {
          ctx.fillStyle = queued ? '#d97706' : '#64748b';
          ctx.fillText(`✔ ${n.processed}${queued ? ` · ⏳${n.queue}` : ''}`, n.x, n.y + 10);
        } else if (n.type === 'charge') {
          ctx.fillStyle = full ? '#f43f5e' : '#64748b';
          ctx.fillText(`${occ}/${sim.params.port_cap}${queued ? ` ⏳${n.queue}` : ''}`, n.x, n.y + 9);
        } else {
          ctx.fillStyle = '#64748b';
          ctx.fillText(`${occ}대`, n.x, n.y + 9);
        }
        ctx.restore();
      });
    }

    drawPaths() {
      const ctx = this.ctx, sim = this.sim;
      ctx.save();
      ctx.lineWidth = 1.8; ctx.setLineDash([3, 4]);
      sim.robots.forEach((r) => {
        if (!r.path.length) return;
        ctx.strokeStyle = r.cargo > 0 ? 'rgba(243,115,33,0.5)' : 'rgba(14,165,233,0.4)';
        ctx.beginPath(); ctx.moveTo(r.x, r.y);
        r.path.forEach((id) => { const n = sim.layout.node(id); if (n) ctx.lineTo(n.x, n.y); });
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.restore();
    }

    drawRobots(dark) {
      const ctx = this.ctx, sim = this.sim, S = AMR.STATE;
      sim.robots.forEach((r) => {
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.rotate(r.heading);

        const loaded = r.cargo > 0;
        let body = loaded ? '#f37321' : '#475569';
        if (r.state === S.CHARGING || r.state === S.TO_CHARGE) body = '#e11d48';
        if (r.state === S.FAULT) body = '#7c2d12';
        const blocked = r.speed < 0.05 && (r.state === S.TO_PICK || r.state === S.TO_DROP);

        ctx.shadowColor = blocked ? 'rgba(244,63,94,0.65)' : (loaded ? 'rgba(243,115,33,0.5)' : 'rgba(0,0,0,0.3)');
        ctx.shadowBlur = blocked ? 12 : 6;
        ctx.fillStyle = body;
        ctx.beginPath(); ctx.roundRect(-13, -9.5, 26, 19, 5); ctx.fill();
        ctx.shadowBlur = 0;

        // 바퀴
        ctx.fillStyle = 'rgba(15,23,42,0.85)';
        ctx.fillRect(-10, -11.5, 6, 2.2); ctx.fillRect(4, -11.5, 6, 2.2);
        ctx.fillRect(-10, 9.3, 6, 2.2); ctx.fillRect(4, 9.3, 6, 2.2);
        // 전방 방향 표시
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(8, 3.4); ctx.lineTo(8, -3.4); ctx.closePath(); ctx.fill();

        ctx.rotate(-r.heading);

        // 화물 (묶음 수량은 회전하지 않게 표시)
        if (loaded) {
          ctx.fillStyle = '#fbbf24';
          ctx.beginPath(); ctx.roundRect(-5.5, -5.5, 11, 11, 2); ctx.fill();
          if (r.cargo > 1) {
            ctx.fillStyle = '#78350f';
            ctx.font = '800 8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(r.cargo), 0, 0.5);
          }
        }

        // ID 라벨
        ctx.textBaseline = 'alphabetic';
        if (this.show.ids && this.view.k > 0.6) {
          ctx.fillStyle = dark ? '#e2e8f0' : '#0f172a';
          ctx.font = '800 8.5px "Pretendard",sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(r.id.replace('AMR-', 'R'), 0, 20);
        }

        // 배터리 바
        const bw = 22;
        ctx.fillStyle = dark ? 'rgba(51,65,85,0.9)' : 'rgba(226,232,240,0.95)';
        ctx.beginPath(); ctx.roundRect(-bw / 2, -17, bw, 4, 2); ctx.fill();
        const soc = clamp(r.soc, 0, 100);
        ctx.fillStyle = soc <= sim.params.bat_min ? '#ef4444' : (soc >= sim.params.bat_max ? '#10b981' : '#f59e0b');
        ctx.beginPath(); ctx.roundRect(-bw / 2, -17, (bw * soc) / 100, 4, 2); ctx.fill();

        ctx.textAlign = 'center';
        if (r.state === S.CHARGING) { ctx.font = '11px sans-serif'; ctx.fillText('⚡', 15, -12); }
        else if (r.state === S.FAULT) { ctx.font = '11px sans-serif'; ctx.fillText('🛠', 15, -12); }
        else if (String(r.state).startsWith('queue')) { ctx.font = '10px sans-serif'; ctx.fillText('⏳', 15, -12); }

        ctx.restore();
      });
    }

    drawGhost() {
      const ctx = this.ctx, g = this.ghost;
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = PALETTE[g.type] || '#94a3b8';
      if (g.type === 'waypoint') { ctx.beginPath(); ctx.arc(g.x, g.y, 5, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.roundRect(g.x - 28, g.y - 19, 56, 38, 8); ctx.fill(); }
      ctx.restore();
    }

    drawScaleBar(dark) {
      const ctx = this.ctx, sim = this.sim;
      const meters = 20;
      const px = sim.graph.mToPx(meters) * this.view.k;
      const x = 16, y = this.h - 22;
      ctx.save();
      ctx.fillStyle = dark ? 'rgba(15,23,42,0.86)' : 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = dark ? '#334155' : '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x - 8, y - 20, Math.max(170, px + 20), 30, 6); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#0ea5e9'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 2); ctx.lineTo(x + px, y - 2);
      ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 3);
      ctx.moveTo(x + px, y - 7); ctx.lineTo(x + px, y + 3);
      ctx.stroke();
      ctx.fillStyle = dark ? '#e2e8f0' : '#0f172a';
      ctx.font = '700 9.5px "Pretendard",sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`${meters} m  ·  축척 100px = ${sim.params.pixel_scale}m  ·  ${Math.round(this.view.k * 100)}%`, x, y + 7);
      ctx.restore();
    }

    drawLegend(dark) {
      if (!this.show.heat) return;
      const ctx = this.ctx;
      const w = 108, h = 9, x = this.w - w - 18, y = this.h - 26;
      ctx.save();
      const grad = ctx.createLinearGradient(x, 0, x + w, 0);
      grad.addColorStop(0, this.heatColor(0));
      grad.addColorStop(0.5, this.heatColor(0.5));
      grad.addColorStop(1, this.heatColor(1));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill();
      ctx.fillStyle = dark ? '#cbd5e1' : '#475569';
      ctx.font = '700 8.5px "Pretendard",sans-serif';
      ctx.textAlign = 'left'; ctx.fillText('여유', x, y - 4);
      ctx.textAlign = 'right'; ctx.fillText('혼잡', x + w, y - 4);
      ctx.restore();
    }
  }

  AMR.Renderer = Renderer;
  AMR.PALETTE = PALETTE;
})(window);
