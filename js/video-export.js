(function (global) {
  'use strict';

  const WIDTH = 1920;
  const HEIGHT = 1080;
  const FPS = 30;
  const COLORS = {
    bg: '#0b1321',
    panel: '#111d2e',
    panelAlt: '#162338',
    border: '#2a3a50',
    text: '#e8eef7',
    muted: '#9aabc0',
    accent: '#f37321',
    green: '#34d399',
    blue: '#60a5fa',
    yellow: '#fbbf24',
    red: '#fb7185'
  };

  function number(value, digits = 0) {
    return Number.isFinite(value)
      ? value.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : '—';
  }

  function clock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function text(ctx, value, x, y, font, color, align = 'left') {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value), x, y);
  }

  function panel(ctx, x, y, w, h, fill = COLORS.panel) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }

  class VideoExporter {
    constructor() {
      this.recording = false;
      this.recorder = null;
      this.stream = null;
      this.frameId = 0;
      this.chunks = [];
      this.failed = false;
    }

    start(options) {
      if (this.recording) return false;
      if (!global.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
        options.onError('이 브라우저는 캔버스 영상 녹화를 지원하지 않습니다.');
        return false;
      }

      const formats = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? formats.find((type) => MediaRecorder.isTypeSupported(type))
        : 'video/webm';
      if (!mimeType) {
        options.onError('지원되는 WebM 영상 인코더를 찾을 수 없습니다.');
        return false;
      }

      this.options = options;
      this.canvas = document.createElement('canvas');
      this.canvas.width = WIDTH;
      this.canvas.height = HEIGHT;
      this.ctx = this.canvas.getContext('2d');
      if (!this.ctx) {
        options.onError('영상 합성용 캔버스를 초기화하지 못했습니다.');
        return false;
      }

      try {
        this.stream = this.canvas.captureStream(FPS);
        this.recorder = new MediaRecorder(this.stream, {
          mimeType,
          videoBitsPerSecond: 4000000
        });
        this.mimeType = mimeType;
        this.chunks = [];
        this.failed = false;
        this.recorder.ondataavailable = (event) => {
          if (event.data && event.data.size) this.chunks.push(event.data);
        };
        this.recorder.onerror = (event) => {
          this.failed = true;
          this.recording = false;
          this.stopDrawing();
          options.onError(event.error && event.error.message
            ? event.error.message : '영상 녹화 중 오류가 발생했습니다.');
          if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
        };
        this.recorder.onstop = () => {
          const blob = new Blob(this.chunks, { type: this.mimeType });
          this.releaseStream();
          this.recorder = null;
          this.recording = false;
          options.onState(false);
          if (this.failed) return;
          if (!blob.size) {
            options.onError('녹화된 영상 데이터가 없습니다. 다시 시도해 주세요.');
            return;
          }
          options.onComplete(blob);
        };
        this.startedAt = performance.now();
        this.recording = true;
        this.drawFrame();
        this.recorder.start(1000);
        options.onState(true);
        this.drawLoop();
        return true;
      } catch (error) {
        this.recording = false;
        this.stopDrawing();
        this.releaseStream();
        this.recorder = null;
        options.onState(false);
        options.onError(error && error.message ? error.message : '영상 녹화를 시작하지 못했습니다.');
        return false;
      }
    }

    stop() {
      if (!this.recording || !this.recorder) return;
      this.recording = false;
      this.stopDrawing();
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    }

    stopDrawing() {
      if (this.frameId) global.cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }

    releaseStream() {
      if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    drawLoop() {
      if (!this.recording) return;
      this.drawFrame();
      this.frameId = global.requestAnimationFrame(() => this.drawLoop());
    }

    drawFrame() {
      const ctx = this.ctx;
      const snapshot = this.options.getSnapshot();
      const sim = snapshot.sim;
      const kpi = sim.kpi();
      const elapsed = (performance.now() - this.startedAt) / 1000;
      const map = this.options.mapCanvas;

      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = COLORS.panel;
      ctx.fillRect(0, 0, WIDTH, 112);
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(0, 108, WIDTH, 4);
      text(ctx, 'AGV / AMR 시뮬레이션 결과', 54, 43, '700 32px "Malgun Gothic", sans-serif', COLORS.text);
      text(ctx, snapshot.layoutName || '레이아웃', 56, 80, '400 20px "Malgun Gothic", sans-serif', COLORS.muted);
      text(ctx, `시뮬레이션 ${clock(sim.t)}`, WIDTH - 330, 42,
        '600 23px "Malgun Gothic", sans-serif', COLORS.text);
      text(ctx, `녹화 ${clock(elapsed)}`, WIDTH - 56, 80,
        '400 18px "Malgun Gothic", sans-serif', COLORS.muted, 'right');

      panel(ctx, 48, 132, 1194, 734);
      text(ctx, '시뮬레이션 맵', 72, 163, '600 20px "Malgun Gothic", sans-serif', COLORS.text);
      if (map && map.width && map.height) {
        const area = { x: 68, y: 188, w: 1154, h: 658 };
        const scale = Math.min(area.w / map.width, area.h / map.height);
        const w = map.width * scale, h = map.height * scale;
        ctx.drawImage(map, area.x + (area.w - w) / 2, area.y + (area.h - h) / 2, w, h);
      }

      panel(ctx, 1264, 132, 608, 734);
      text(ctx, '주요 지표', 1290, 164, '600 20px "Malgun Gothic", sans-serif', COLORS.text);
      this.drawMetric(ctx, 1288, 188, 276, 126, '완료 작업', number(kpi.completed), '건', COLORS.green);
      this.drawMetric(ctx, 1572, 188, 276, 126, '실측 처리량', number(kpi.measuredUPH), 'UPH', COLORS.blue);
      this.drawMetric(ctx, 1288, 324, 276, 126, '서비스율', number(kpi.serviceRate, 1), '%', COLORS.yellow);
      this.drawMetric(ctx, 1572, 324, 276, 126, '차량 가동률', number(kpi.util, 1), '%', COLORS.accent);

      panel(ctx, 1288, 468, 560, 370, COLORS.panelAlt);
      text(ctx, '운영 현황', 1314, 501, '600 19px "Malgun Gothic", sans-serif', COLORS.text);
      const rows = [
        ['WIP (재공)', `${number(kpi.wip)} 건`],
        ['진행 작업', `${number(kpi.active)} 건`],
        ['평균 사이클', `${number(kpi.avgCycle, 1)} 초`],
        ['완료 / 발생', `${number(kpi.completed)} / ${number(sim.metrics.released)} 건`],
        ['가동 / 충전', `${number(kpi.working)} / ${number(kpi.charging)} 대`],
        ['투입 차량', `${number(kpi.fleet)} 대`],
        ['수요', `${number(kpi.demandUPH)} UPH`]
      ];
      rows.forEach((row, i) => {
        const y = 543 + i * 40;
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(1314, y + 20);
        ctx.lineTo(1822, y + 20);
        ctx.stroke();
        text(ctx, row[0], 1314, y, '400 16px "Malgun Gothic", sans-serif', COLORS.muted);
        text(ctx, row[1], 1822, y, '600 17px "Malgun Gothic", sans-serif', COLORS.text, 'right');
      });

      this.drawThroughputChart(ctx, sim);
      text(ctx, `생성 ${new Date().toLocaleString('ko-KR')}`, WIDTH - 56, 1054,
        '400 13px "Malgun Gothic", sans-serif', COLORS.muted, 'right');
    }

    drawMetric(ctx, x, y, w, h, label, value, unit, color) {
      panel(ctx, x, y, w, h, COLORS.panelAlt);
      text(ctx, label, x + 20, y + 26, '400 16px "Malgun Gothic", sans-serif', COLORS.muted);
      text(ctx, value, x + 20, y + 76, '700 36px "Malgun Gothic", sans-serif', color);
      text(ctx, unit, x + w - 18, y + 77, '400 16px "Malgun Gothic", sans-serif', COLORS.muted, 'right');
    }

    drawThroughputChart(ctx, sim) {
      panel(ctx, 48, 884, 1824, 150);
      text(ctx, '처리량 추이 (UPH)', 72, 910, '600 17px "Malgun Gothic", sans-serif', COLORS.text);
      const plot = { x: 270, y: 905, w: 1574, h: 92 };
      const points = sim.throughputSeries.slice(-80);
      if (!points.length) {
        text(ctx, '시뮬레이션 데이터 수집 중', plot.x, plot.y + plot.h / 2,
          '400 15px "Malgun Gothic", sans-serif', COLORS.muted);
        return;
      }
      const max = Math.max(1, ...points.map((point) => point.uph));
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const y = plot.y + (plot.h * i) / 3;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
      }
      ctx.beginPath();
      points.forEach((point, i) => {
        const x = plot.x + (points.length > 1 ? (i / (points.length - 1)) * plot.w : plot.w);
        const y = plot.y + plot.h - (point.uph / max) * (plot.h - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      text(ctx, `최대 ${number(max)} UPH`, plot.x + plot.w, plot.y - 5,
        '400 13px "Malgun Gothic", sans-serif', COLORS.muted, 'right');
    }
  }

  global.AMR = global.AMR || {};
  global.AMR.VideoExporter = VideoExporter;
})(window);
