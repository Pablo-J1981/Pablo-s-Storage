/* =========================================================
 * AMR Capa Simulator PRO — Chart.js Wrappers
 * ========================================================= */
(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});
  const charts = {};

  function themeColors() {
    const cs = getComputedStyle(document.body);
    const g = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
    const dark = document.body.classList.contains('theme-dark') || document.body.classList.contains('theme-midnight');
    return {
      text: g('--text-dim', '#64748b'),
      grid: dark ? 'rgba(148,163,184,0.13)' : 'rgba(100,116,139,0.14)',
      accent: g('--accent', '#f37321'),
      ok: g('--ok', '#059669'),
      warn: g('--warn', '#d97706'),
      err: g('--err', '#e11d48'),
      info: g('--info', '#0284c7'),
      purple: g('--purple', '#7c3aed'),
      surface: g('--surface', '#fff')
    };
  }

  function baseOptions(extra) {
    const c = themeColors();
    const font = { family: 'Pretendard, "Nanum Gothic", sans-serif', size: 10 };
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: c.text, font, boxWidth: 11, boxHeight: 11, padding: 8, usePointStyle: true }
        },
        tooltip: {
          backgroundColor: c.surface,
          titleColor: c.text, bodyColor: c.text,
          borderColor: c.grid, borderWidth: 1,
          titleFont: font, bodyFont: font, padding: 8, displayColors: true
        }
      },
      scales: {
        x: { ticks: { color: c.text, font, maxRotation: 0, autoSkipPadding: 14 }, grid: { color: c.grid, drawTicks: false } },
        y: { ticks: { color: c.text, font }, grid: { color: c.grid, drawTicks: false }, beginAtZero: true }
      }
    }, extra || {});
  }

  function make(id, config) {
    const el = document.getElementById(id);
    if (!el || !global.Chart) return null;
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    charts[id] = new global.Chart(el.getContext('2d'), config);
    return charts[id];
  }

  function get(id) { return charts[id] || null; }

  function destroy(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

  /** 투입 대수 vs 처리량/사이클 (이중축) */
  function curveChart(id, curve, demand, currentFleet, reqFleet) {
    const c = themeColors();
    const labels = curve.map((p) => p.n);
    const cfg = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '예측 처리량 (UPH)', data: curve.map((p) => Math.round(p.uph)),
            borderColor: c.accent, backgroundColor: c.accent + '26',
            borderWidth: 2.4, fill: true, tension: 0.25, pointRadius: 0, pointHoverRadius: 4, yAxisID: 'y'
          },
          {
            label: '수요 (Demand)', data: labels.map(() => Math.round(demand)),
            borderColor: c.err, borderWidth: 1.8, borderDash: [6, 4], pointRadius: 0, fill: false, yAxisID: 'y'
          },
          {
            label: '사이클타임 (초)', data: curve.map((p) => Math.round(p.cycle)),
            borderColor: c.info, borderWidth: 1.7, borderDash: [3, 3], pointRadius: 0, fill: false, tension: 0.25, yAxisID: 'y1'
          },
          {
            label: '현재 투입', data: labels.map((n) => (n === currentFleet ? Math.round(curve.find((x) => x.n === n).uph) : null)),
            borderColor: c.ok, backgroundColor: c.ok,
            pointRadius: 6, pointStyle: 'rectRot', showLine: false, yAxisID: 'y'
          },
          {
            label: '권장 대수', data: labels.map((n) => (n === reqFleet ? Math.round(curve.find((x) => x.n === n).uph) : null)),
            borderColor: c.purple, backgroundColor: c.purple,
            pointRadius: 7, pointStyle: 'star', showLine: false, yAxisID: 'y'
          }
        ]
      },
      options: baseOptions({
        scales: {
          x: {
            title: { display: true, text: 'AMR 투입 대수', color: c.text, font: { size: 10, family: 'Pretendard' } },
            ticks: { color: c.text, font: { size: 9.5, family: 'Pretendard' } }, grid: { color: c.grid }
          },
          y: {
            position: 'left', beginAtZero: true,
            title: { display: true, text: '처리량 UPH', color: c.text, font: { size: 10, family: 'Pretendard' } },
            ticks: { color: c.text, font: { size: 9.5, family: 'Pretendard' } }, grid: { color: c.grid }
          },
          y1: {
            position: 'right', beginAtZero: true,
            title: { display: true, text: '사이클 (초)', color: c.text, font: { size: 10, family: 'Pretendard' } },
            ticks: { color: c.text, font: { size: 9.5, family: 'Pretendard' } }, grid: { drawOnChartArea: false }
          }
        }
      })
    };
    return make(id, cfg);
  }

  /** 시계열: 처리량 / WIP / 가동률 */
  function timeChart(id, sim) {
    const c = themeColors();
    const ts = sim.throughputSeries, ws = sim.wipSeries, us = sim.utilSeries;
    const labels = ts.map((p) => AMR.util.fmt.clock(p.t).slice(0, 5));
    return make(id, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '처리량 UPH', data: ts.map((p) => Math.round(p.uph)), borderColor: c.accent, backgroundColor: c.accent + '1f', borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, yAxisID: 'y' },
          { label: 'WIP (재공)', data: ws.map((p) => p.wip), borderColor: c.warn, borderWidth: 1.7, pointRadius: 0, tension: 0.3, yAxisID: 'y1' },
          { label: '가동률 %', data: us.map((p) => Math.round(p.util)), borderColor: c.ok, borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, tension: 0.3, yAxisID: 'y1' }
        ]
      },
      options: baseOptions({
        scales: {
          x: { ticks: { color: c.text, font: { size: 9, family: 'Pretendard' }, maxTicksLimit: 8 }, grid: { color: c.grid } },
          y: { position: 'left', beginAtZero: true, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { color: c.grid } },
          y1: { position: 'right', beginAtZero: true, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { drawOnChartArea: false } }
        }
      })
    });
  }

  /** 로봇 상태 분포 (도넛) */
  function stateChart(id, sim) {
    const c = themeColors();
    const S = AMR.STATE;
    const buckets = { '작업 중': 0, '유휴': 0, '포트 대기': 0, '충전': 0, '정체': 0, '고장': 0 };
    sim.robots.forEach((r) => {
      if (r.state === S.FAULT) buckets['고장']++;
      else if (r.state === S.CHARGING || r.state === S.TO_CHARGE || r.state === S.QUEUE_CHARGE) buckets['충전']++;
      else if (String(r.state).startsWith('queue')) buckets['포트 대기']++;
      else if (r.state === S.IDLE) buckets['유휴']++;
      else if (r.speed < 0.05) buckets['정체']++;
      else buckets['작업 중']++;
    });
    return make(id, {
      type: 'doughnut',
      data: {
        labels: Object.keys(buckets),
        datasets: [{
          data: Object.values(buckets),
          backgroundColor: [c.ok, '#94a3b8', c.warn, c.err, '#fb923c', '#7c2d12'],
          borderWidth: 2, borderColor: c.surface
        }]
      },
      options: baseOptions({
        cutout: '58%',
        plugins: {
          legend: { position: 'right', labels: { color: c.text, font: { size: 10, family: 'Pretendard' }, boxWidth: 10, padding: 7, usePointStyle: true } },
          tooltip: { backgroundColor: c.surface, titleColor: c.text, bodyColor: c.text, borderColor: c.grid, borderWidth: 1 }
        },
        scales: {}
      })
    });
  }

  /** 스윕 결과 (이중축) */
  function sweepChart(id, rows, spec) {
    const c = themeColors();
    return make(id, {
      type: 'line',
      data: {
        labels: rows.map((r) => r.value.toFixed(spec.dec || 1)),
        datasets: [
          { label: '처리량 UPH', data: rows.map((r) => Math.round(r.uph)), borderColor: c.accent, backgroundColor: c.accent + '22', borderWidth: 2.3, fill: true, tension: 0.25, pointRadius: 2, yAxisID: 'y' },
          { label: '수요 UPH', data: rows.map((r) => Math.round(r.demand)), borderColor: c.err, borderWidth: 1.6, borderDash: [5, 4], pointRadius: 0, yAxisID: 'y' },
          { label: '소요 대수', data: rows.map((r) => r.reqFleet), borderColor: c.purple, borderWidth: 1.8, pointRadius: 2, tension: 0.2, yAxisID: 'y1' },
          { label: '사이클 (초)', data: rows.map((r) => Math.round(r.cycle)), borderColor: c.info, borderWidth: 1.4, borderDash: [3, 3], pointRadius: 0, tension: 0.25, yAxisID: 'y1' }
        ]
      },
      options: baseOptions({
        scales: {
          x: { title: { display: true, text: `${spec.label} (${spec.unit})`, color: c.text, font: { size: 10, family: 'Pretendard' } }, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' }, maxTicksLimit: 10 }, grid: { color: c.grid } },
          y: { position: 'left', beginAtZero: true, title: { display: true, text: 'UPH', color: c.text, font: { size: 9.5, family: 'Pretendard' } }, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { color: c.grid } },
          y1: { position: 'right', beginAtZero: true, title: { display: true, text: '대수 / 초', color: c.text, font: { size: 9.5, family: 'Pretendard' } }, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { drawOnChartArea: false } }
        }
      })
    });
  }

  /** 몬테카를로 분포 */
  function mcChart(id, mc) {
    const c = themeColors();
    const data = mc.uph.p.map((v) => Math.round(v));
    const mean = mc.uph.mean;
    return make(id, {
      type: 'bar',
      data: {
        labels: data.map((_, i) => `Run ${i + 1}`),
        datasets: [
          { label: '처리량 UPH', data, backgroundColor: c.accent + 'cc', borderColor: c.accent, borderWidth: 1, borderRadius: 4 },
          { label: `평균 ${mean.toFixed(1)} UPH`, data: data.map(() => Math.round(mean)), type: 'line', borderColor: c.ok, borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
          { label: `95% CI 상한`, data: data.map(() => Math.round(mean + mc.uph.ci)), type: 'line', borderColor: c.warn, borderWidth: 1.2, borderDash: [3, 3], pointRadius: 0 },
          { label: `95% CI 하한`, data: data.map(() => Math.round(mean - mc.uph.ci)), type: 'line', borderColor: c.warn, borderWidth: 1.2, borderDash: [3, 3], pointRadius: 0 }
        ]
      },
      options: baseOptions()
    });
  }

  /** 경제성: 건당 원가 vs 회수기간 */
  function ecoChart(id, rows) {
    const c = themeColors();
    return make(id, {
      type: 'line',
      data: {
        labels: rows.map((r) => r.fleet + '대'),
        datasets: [
          { label: '건당 처리원가 (원)', data: rows.map((r) => Math.round(r.costPerTask)), borderColor: c.accent, backgroundColor: c.accent + '22', borderWidth: 2.2, fill: true, tension: 0.25, pointRadius: 2, yAxisID: 'y' },
          { label: '회수기간 (년)', data: rows.map((r) => (isFinite(r.paybackY) ? +r.paybackY.toFixed(2) : null)), borderColor: c.purple, borderWidth: 2, tension: 0.25, pointRadius: 2, yAxisID: 'y1' },
          { label: '처리량 UPH', data: rows.map((r) => Math.round(r.uph)), borderColor: c.ok, borderWidth: 1.4, borderDash: [4, 3], pointRadius: 0, tension: 0.25, yAxisID: 'y' }
        ]
      },
      options: baseOptions({
        scales: {
          x: { ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { color: c.grid } },
          y: { position: 'left', beginAtZero: true, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { color: c.grid } },
          y1: { position: 'right', beginAtZero: true, title: { display: true, text: '년', color: c.text, font: { size: 9.5, family: 'Pretendard' } }, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { drawOnChartArea: false } }
        }
      })
    });
  }

  /** 스테이션 부하 (가로 막대) */
  function portChart(id, layout) {
    const c = themeColors();
    const ns = [...layout.byType('pick'), ...layout.byType('drop')];
    return make(id, {
      type: 'bar',
      data: {
        labels: ns.map((n) => n.name),
        datasets: [
          { label: '처리 완료', data: ns.map((n) => n.processed), backgroundColor: c.ok + 'cc', borderRadius: 3 },
          { label: '적체 대기', data: ns.map((n) => n.buffer), backgroundColor: c.warn + 'cc', borderRadius: 3 },
          { label: '누적대기(분)', data: ns.map((n) => +(n.waitAccum / 60).toFixed(1)), backgroundColor: c.err + 'aa', borderRadius: 3 }
        ]
      },
      options: baseOptions({
        indexAxis: 'y',
        scales: {
          x: { stacked: false, beginAtZero: true, ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { color: c.grid } },
          y: { ticks: { color: c.text, font: { size: 9, family: 'Pretendard' } }, grid: { display: false } }
        }
      })
    });
  }

  function retheme() {
    Object.keys(charts).forEach((id) => {
      const ch = charts[id];
      if (!ch) return;
      const c = themeColors();
      if (ch.options.plugins?.legend?.labels) ch.options.plugins.legend.labels.color = c.text;
      if (ch.options.plugins?.tooltip) {
        ch.options.plugins.tooltip.backgroundColor = c.surface;
        ch.options.plugins.tooltip.titleColor = c.text;
        ch.options.plugins.tooltip.bodyColor = c.text;
        ch.options.plugins.tooltip.borderColor = c.grid;
      }
      ['x', 'y', 'y1'].forEach((ax) => {
        const s = ch.options.scales && ch.options.scales[ax];
        if (!s) return;
        if (s.ticks) s.ticks.color = c.text;
        if (s.title) s.title.color = c.text;
        if (s.grid && s.grid.color) s.grid.color = c.grid;
      });
      ch.update('none');
    });
  }

  AMR.charts = {
    make, get, destroy, themeColors, baseOptions,
    curveChart, timeChart, stateChart, sweepChart, mcChart, ecoChart, portChart, retheme
  };
})(window);
