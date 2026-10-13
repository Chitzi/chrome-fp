'use strict';

// Everything below runs inside the page via Page.addScriptToEvaluateOnNewDocument,
// i.e. before any site script, in the main world, for every tab/iframe.
function pageScript(CFG, SELF_SRC) {
  'use strict';
  // Runs in windows, iframes AND workers, so nothing may assume `document`.
  const G = globalThis;
  if (!SELF_SRC) {
    // Rebuild our own bootstrap source; it gets prepended to worker scripts.
    try {
      SELF_SRC =
        '(function(){var CFG=' + JSON.stringify(CFG) + ';var FN=' + pageScript.toString() +
        ';FN(CFG,null);})();';
    } catch (e) {}
  }
  if (G.__fpPatched) return;
  try {
    Object.defineProperty(G, '__fpPatched', { value: true, enumerable: false, configurable: false });
  } catch (e) {}

  const origToString = Function.prototype.toString;
  const nativeSignatures = new WeakMap();

  function markNative(fn, name) {
    nativeSignatures.set(fn, 'function ' + name + '() { [native code] }');
    return fn;
  }

  const patchedToString = function toString() {
    const sig = nativeSignatures.get(this);
    return sig !== undefined ? sig : origToString.call(this);
  };
  markNative(patchedToString, 'toString');
  Function.prototype.toString = patchedToString;

  function replaceGetter(proto, prop, getValue) {
    try {
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc) return;
      if (desc.get) {
        const getter = function () {
          return getValue.call(this);
        };
        markNative(getter, 'get ' + prop);
        Object.defineProperty(proto, prop, {
          configurable: desc.configurable,
          enumerable: desc.enumerable,
          get: getter,
          set: desc.set,
        });
      } else if ('value' in desc && desc.configurable) {
        Object.defineProperty(proto, prop, {
          configurable: true,
          enumerable: desc.enumerable,
          writable: desc.writable,
          value: getValue.call(proto),
        });
      }
    } catch (e) {}
  }

  function replaceMethod(proto, name, factory) {
    try {
      if (!proto) return;
      const original = proto[name];
      if (typeof original !== 'function') return;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      const patched = factory(original);
      markNative(patched, name);
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: desc ? desc.enumerable : false,
        writable: true,
        value: patched,
      });
    } catch (e) {}
  }

  // Deterministic noise: same input always yields the same perturbation within a run.
  function hash32(seed, a, b) {
    let h = (seed ^ Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  function unit(seed, a, b) {
    return hash32(seed, a, b) / 4294967296;
  }

  /* ---------- navigator (Navigator in pages, WorkerNavigator in workers) ---------- */
  const NavProto = G.navigator ? Object.getPrototypeOf(G.navigator) : null;
  replaceGetter(NavProto, 'platform', () => CFG.navigatorPlatform);
  replaceGetter(NavProto, 'hardwareConcurrency', () => CFG.hardwareConcurrency);
  replaceGetter(NavProto, 'deviceMemory', () => CFG.deviceMemory);
  replaceGetter(NavProto, 'maxTouchPoints', () => CFG.maxTouchPoints);
  replaceGetter(NavProto, 'webdriver', () => false);
  const frozenLanguages = Object.freeze(CFG.languages.slice());
  replaceGetter(NavProto, 'languages', () => frozenLanguages);
  replaceGetter(NavProto, 'language', () => CFG.languages[0]);

  try {
    if (G.navigator && G.navigator.connection) {
      const ConnProto = Object.getPrototypeOf(G.navigator.connection);
      replaceGetter(ConnProto, 'downlink', () => CFG.connection.downlink);
      replaceGetter(ConnProto, 'rtt', () => CFG.connection.rtt);
      replaceGetter(ConnProto, 'effectiveType', () => CFG.connection.effectiveType);
    }
  } catch (e) {}

  /* ---------- screen (windows only) ---------- */
  const S = CFG.screen;
  if (G.screen) {
    const ScreenProto = Object.getPrototypeOf(G.screen);
    replaceGetter(ScreenProto, 'width', () => S.width);
    replaceGetter(ScreenProto, 'height', () => S.height);
    replaceGetter(ScreenProto, 'availWidth', () => S.availWidth);
    replaceGetter(ScreenProto, 'availHeight', () => S.availHeight);
    replaceGetter(ScreenProto, 'availLeft', () => S.availLeft);
    replaceGetter(ScreenProto, 'availTop', () => S.availTop);
    replaceGetter(ScreenProto, 'colorDepth', () => S.colorDepth);
    replaceGetter(ScreenProto, 'pixelDepth', () => S.pixelDepth);
    try {
      if (G.screen.orientation) {
        const OrientationProto = Object.getPrototypeOf(G.screen.orientation);
        const landscape = S.width >= S.height;
        replaceGetter(OrientationProto, 'type', () =>
          landscape ? 'landscape-primary' : 'portrait-primary'
        );
        replaceGetter(OrientationProto, 'angle', () => 0);
      }
    } catch (e) {}
  }

  /* ---------- WebGL vendor / renderer ---------- */
  const UNMASKED_VENDOR = 0x9245;
  const UNMASKED_RENDERER = 0x9246;
  const glProtos = [G.WebGLRenderingContext, G.WebGL2RenderingContext]
    .filter(Boolean)
    .map((C) => C.prototype);
  for (const proto of glProtos) {
    replaceMethod(proto, 'getParameter', (original) =>
      function getParameter(pname) {
        if (pname === UNMASKED_VENDOR) return CFG.webglVendor;
        if (pname === UNMASKED_RENDERER) return CFG.webglRenderer;
        return original.call(this, pname);
      }
    );
  }

  /* ---------- workers ---------- */
  // Dedicated/shared workers are a favourite escape hatch: they expose WebGL via
  // OffscreenCanvas and are not covered by page-level injection. Chrome cannot
  // inject into a paused dedicated worker over CDP without deadlocking it, so the
  // constructor is wrapped instead and the worker bootstraps with these patches.
  if (G.__fpWorkerUrl && G.URL) {
    // Keep self.location pointing at the real script URL, not the shim blob.
    try {
      const u = new G.URL(G.__fpWorkerUrl);
      const fake = {
        href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
        hostname: u.hostname, port: u.port, pathname: u.pathname,
        search: u.search, hash: u.hash,
        toString() { return u.href; },
      };
      Object.defineProperty(G, 'location', { configurable: true, get: () => fake });

      // The worker really runs from a blob: URL, so the platform would resolve
      // relative subresources against that instead of the script's own URL.
      const resolve = (value) => {
        try {
          return new G.URL(String(value), u.href).href;
        } catch (e) {
          return value;
        }
      };

      if (typeof G.importScripts === 'function') {
        const originalImportScripts = G.importScripts;
        const patchedImportScripts = function importScripts() {
          const urls = Array.prototype.map.call(arguments, resolve);
          return originalImportScripts.apply(this, urls);
        };
        markNative(patchedImportScripts, 'importScripts');
        G.importScripts = patchedImportScripts;
      }

      if (typeof G.fetch === 'function') {
        const originalFetch = G.fetch;
        const patchedFetch = function fetch(input, init) {
          if (typeof input === 'string') return originalFetch.call(this, resolve(input), init);
          return originalFetch.call(this, input, init);
        };
        markNative(patchedFetch, 'fetch');
        G.fetch = patchedFetch;
      }

      if (G.XMLHttpRequest) {
        replaceMethod(G.XMLHttpRequest.prototype, 'open', (original) =>
          function open(method, url) {
            const args = Array.prototype.slice.call(arguments);
            if (typeof url === 'string') args[1] = resolve(url);
            return original.apply(this, args);
          }
        );
      }
    } catch (e) {}
  }

  if (SELF_SRC && G.URL && G.Blob) {
    const wrapWorker = (OriginalWorker, name) => {
      const Wrapped = function (scriptUrl, options) {
        try {
          const base = (G.location && G.location.href) || undefined;
          const abs = new G.URL(scriptUrl, base).href;
          // A module worker loads asynchronously, so messages sent before its
          // handlers exist would be dropped: queue and replay them.
          const loader =
            options && options.type === 'module'
              ? 'var __fpQ=[],__fpH=function(e){__fpQ.push(e)};' +
                'self.addEventListener("message",__fpH);' +
                'import(' + JSON.stringify(abs) + ').then(function(){' +
                'self.removeEventListener("message",__fpH);' +
                '__fpQ.forEach(function(e){try{self.dispatchEvent(new MessageEvent("message",' +
                '{data:e.data,origin:e.origin,lastEventId:e.lastEventId,source:e.source,ports:e.ports}))}catch(x){}});' +
                '__fpQ.length=0;});'
              : 'importScripts(' + JSON.stringify(abs) + ');';
          const bootstrap =
            'self.__fpWorkerUrl=' + JSON.stringify(abs) + ';\n' + SELF_SRC + '\n' + loader;
          const blobUrl = G.URL.createObjectURL(
            new G.Blob([bootstrap], { type: 'text/javascript' })
          );
          return new OriginalWorker(blobUrl, options);
        } catch (e) {
          return new OriginalWorker(scriptUrl, options);
        }
      };
      Wrapped.prototype = OriginalWorker.prototype;
      Object.defineProperty(Wrapped, 'name', { value: name, configurable: true });
      markNative(Wrapped, name);
      return Wrapped;
    };
    try {
      if (G.Worker) G.Worker = wrapWorker(G.Worker, 'Worker');
    } catch (e) {}
    try {
      if (G.SharedWorker) G.SharedWorker = wrapWorker(G.SharedWorker, 'SharedWorker');
    } catch (e) {}
  }

  if (!CFG.noise.enabled) return;

  /* ---------- canvas noise (HTMLCanvasElement and OffscreenCanvas) ---------- */
  const canvasSeed = CFG.noise.canvas;
  const ctx2dProtos = [G.CanvasRenderingContext2D, G.OffscreenCanvasRenderingContext2D]
    .filter(Boolean)
    .map((C) => C.prototype);
  const originalGetImageData = new Map();
  for (const proto of ctx2dProtos) originalGetImageData.set(proto, proto.getImageData);

  function rawGetImageData(ctx, w, h) {
    const original = originalGetImageData.get(Object.getPrototypeOf(ctx));
    return (original || ctx.getImageData).call(ctx, 0, 0, w, h);
  }

  function makeCanvas(w, h) {
    if (G.document && G.document.createElement) {
      const c = G.document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    if (G.OffscreenCanvas) return new G.OffscreenCanvas(w, h);
    return null;
  }

  function perturbPixels(data, width, seed) {
    // Touch a sparse, seed-dependent set of pixels: invisible to the eye,
    // but enough to change every canvas hash.
    const pixels = data.length >>> 2;
    const stride = 11 + (seed % 23);
    for (let p = seed % stride; p < pixels; p += stride) {
      const i = p << 2;
      const n = hash32(seed, p, width);
      if (data[i + 3] === 0) continue;
      data[i] = Math.max(0, Math.min(255, data[i] + ((n & 3) - 1)));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + (((n >>> 2) & 3) - 1)));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + (((n >>> 4) & 3) - 1)));
    }
    return data;
  }

  function noisyCopy(canvas) {
    try {
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h || w * h > 24000000) return null;
      const copy = makeCanvas(w, h);
      if (!copy) return null;
      const ctx = copy.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      const img = rawGetImageData(ctx, w, h);
      perturbPixels(img.data, w, canvasSeed);
      ctx.putImageData(img, 0, 0);
      return copy;
    } catch (e) {
      return null;
    }
  }

  if (G.HTMLCanvasElement) {
    replaceMethod(G.HTMLCanvasElement.prototype, 'toDataURL', (original) =>
      function toDataURL() {
        const copy = noisyCopy(this);
        return original.apply(copy || this, arguments);
      }
    );
    replaceMethod(G.HTMLCanvasElement.prototype, 'toBlob', (original) =>
      function toBlob() {
        const copy = noisyCopy(this);
        return original.apply(copy || this, arguments);
      }
    );
  }

  if (G.OffscreenCanvas) {
    replaceMethod(G.OffscreenCanvas.prototype, 'convertToBlob', (original) =>
      function convertToBlob() {
        const copy = noisyCopy(this);
        return original.apply(copy || this, arguments);
      }
    );
  }

  for (const proto of ctx2dProtos) {
    replaceMethod(proto, 'getImageData', (original) =>
      function getImageData(sx, sy, sw) {
        const result = original.apply(this, arguments);
        try {
          perturbPixels(result.data, sw, canvasSeed);
        } catch (e) {}
        return result;
      }
    );
  }

  /* ---------- WebGL pixel noise ---------- */
  const webglSeed = CFG.noise.webgl;
  for (const proto of glProtos) {
    replaceMethod(proto, 'readPixels', (original) =>
      function readPixels(x, y, width, height, format, type, pixels) {
        const result = original.apply(this, arguments);
        try {
          if (pixels && pixels.length) {
            const step = 17 + (webglSeed % 31);
            for (let i = webglSeed % step; i < pixels.length; i += step) {
              const n = hash32(webglSeed, i, width) & 1;
              const v = pixels[i];
              if (typeof v === 'number' && v > 0 && v < 255) pixels[i] = v - n;
            }
          }
        } catch (e) {}
        return result;
      }
    );
  }

  /* ---------- audio noise ---------- */
  const audioSeed = CFG.noise.audio;
  const noisedChannels = new WeakSet();

  if (G.AudioBuffer) {
    replaceMethod(G.AudioBuffer.prototype, 'getChannelData', (original) =>
      function getChannelData(channel) {
        const data = original.apply(this, arguments);
        try {
          // Mutate in place once: keeps array identity and stays stable across reads.
          if (!noisedChannels.has(data)) {
            noisedChannels.add(data);
            const step = 97 + (audioSeed % 53);
            for (let i = audioSeed % step; i < data.length; i += step) {
              data[i] += (unit(audioSeed, i, channel | 0) - 0.5) * 1e-7;
            }
          }
        } catch (e) {}
        return data;
      }
    );
    replaceMethod(G.AudioBuffer.prototype, 'copyFromChannel', (original) =>
      function copyFromChannel(destination, channelNumber) {
        this.getChannelData(channelNumber);
        return original.apply(this, arguments);
      }
    );
  }

  if (G.AnalyserNode) {
    replaceMethod(G.AnalyserNode.prototype, 'getFloatFrequencyData', (original) =>
      function getFloatFrequencyData(array) {
        const result = original.apply(this, arguments);
        try {
          for (let i = 0; i < array.length; i += 1) {
            array[i] += (unit(audioSeed, i, 7) - 0.5) * 1e-4;
          }
        } catch (e) {}
        return result;
      }
    );
  }

  /* ---------- client rects & text metrics ---------- */
  const rectSeed = CFG.noise.rects;
  const textSeed = CFG.noise.text;

  function noisyNumber(value, seed) {
    if (!isFinite(value) || value === 0) return value;
    const q = Math.round(value * 1000);
    return value + (unit(seed, q, q >>> 16) - 0.5) * 1e-3;
  }

  // DOMRect redeclares x/y/width/height, so both prototypes need patching.
  for (const Rect of [G.DOMRectReadOnly, G.DOMRect]) {
    if (!Rect) continue;
    for (const prop of ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']) {
      const desc = Object.getOwnPropertyDescriptor(Rect.prototype, prop);
      if (!desc || !desc.get) continue;
      const origGet = desc.get;
      replaceGetter(Rect.prototype, prop, function () {
        return noisyNumber(origGet.call(this), rectSeed);
      });
    }
  }

  if (G.TextMetrics) {
    for (const prop of [
      'width',
      'actualBoundingBoxLeft',
      'actualBoundingBoxRight',
      'actualBoundingBoxAscent',
      'actualBoundingBoxDescent',
    ]) {
      const desc = Object.getOwnPropertyDescriptor(G.TextMetrics.prototype, prop);
      if (!desc || !desc.get) continue;
      const origGet = desc.get;
      replaceGetter(G.TextMetrics.prototype, prop, function () {
        return noisyNumber(origGet.call(this), textSeed);
      });
    }
  }
}

function buildScript(fp) {
  const config = {
    navigatorPlatform: fp.navigatorPlatform,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    maxTouchPoints: fp.maxTouchPoints,
    languages: fp.languages,
    screen: fp.screen,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
    connection: fp.connection,
    noise: fp.noise,
  };
  // Named function expression: the script can stringify itself to build the
  // bootstrap that gets prepended to worker scripts (including nested ones).
  return (
    '(function(){var CFG=' + JSON.stringify(config) + ';var FN=' + pageScript.toString() +
    ';FN(CFG,null);})();'
  );
}

module.exports = { buildScript };
