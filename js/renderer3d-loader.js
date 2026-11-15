(function (global) {
  'use strict';
  const AMR = (global.AMR = global.AMR || {});
  const script = document.currentScript;
  const rendererUrl = script && script.src
    ? new URL('./renderer3d.js', script.src).href
    : null;

  AMR.loadRenderer3D = async function (canvas, sim) {
    if (!rendererUrl) throw new Error('3D 렌더러 경로를 확인할 수 없습니다.');
    const module = await import(rendererUrl);
    return module.createRenderer3D(canvas, sim);
  };
})(window);
