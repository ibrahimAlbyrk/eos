(() => {
  const cs = (sel, props) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return Object.fromEntries(props.map(p => [p, s[p]])); };
  const withUrl = [...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return (s.backdropFilter || '').includes('url('); }).map(e => ({ cls: e.className.toString().slice(0, 40), filter: getComputedStyle(e).backdropFilter.slice(0, 60), rect: (r => [Math.round(r.width), Math.round(r.height)])(e.getBoundingClientRect()) }));
  const sb = (() => { const d = document.createElement('div'); d.style.cssText = 'width:100px;height:100px;overflow:scroll;position:absolute;top:-999px'; document.body.append(d); const w = d.offsetWidth - d.clientWidth; d.remove(); return w; })();
  const gl = (() => { try { const c = document.createElement('canvas').getContext('webgl2'); const x = c.getExtension('WEBGL_debug_renderer_info'); return c.getParameter(x.UNMASKED_RENDERER_WEBGL); } catch (e) { return String(e); } })();
  return {
    ua: navigator.userAgent, dpr: devicePixelRatio, inner: [innerWidth, innerHeight], origin: location.origin,
    htmlClass: document.documentElement.className, dataOs: document.documentElement.dataset.os,
    bodyFont: cs('body', ['fontFamily', 'fontSize', 'fontWeight', 'webkitFontSmoothing', 'textRendering', 'letterSpacing']),
    fontsLoaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight).sort().slice(0, 12),
    msgFont: cs('.messages-wrap', ['fontFamily', 'fontSize', 'lineHeight']),
    backdropUrlElements: withUrl, svgFilters: document.querySelectorAll('svg filter').length,
    supportsBackdropUrl: CSS.supports('backdrop-filter', 'url(#f)'),
    classicScrollbarWidth: sb, webgl: gl,
    sideWidth: document.querySelector('.side')?.getBoundingClientRect().width,
    paneHead: cs('.pane-head', ['height', 'paddingLeft']),
    composer: (r => r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null)(document.querySelector('.composer, [class*=composer]')?.getBoundingClientRect()),
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  };
})()
