/* Reporting charts (REPORTING_SPEC.md §4) — one drawing module used twice:
 *   - in the browser (Reporting page): SVG with CSS-variable colours, hover
 *     tooltips, light/dark;
 *   - on the server (Excel export): the same SVG with fixed light colours,
 *     rasterised to PNG and embedded in the Charts sheet.
 * Pure functions: spec in, SVG string out. No dependencies.
 *
 * Marks follow the dataviz rules: thin bars (<= 24px) with 4px rounded
 * data-ends, 2px lines, 8px+ markers with a 2px surface ring, 2px surface
 * gaps between touching fills, hairline solid grid, text in ink tokens (never
 * the series colour), a legend whenever there are 2+ series, one y-axis.
 * Every axis carries a title with its unit.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ReportingCharts = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Validated reference palette (blue, orange, aqua; diverging blue <-> red).
  const LIGHT = {
    surface: "#fcfcfb", ink: "#0b0b0b", inkSoft: "#52514e", inkFaint: "#6f6e69", grid: "#e6e5e1", axis: "#c9c8c2",
    s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a",
    under: "#2a78d6", neutral: "#9b9a94", over: "#e34948",
    seq: ["#9ec5f4", "#5598e7", "#256abf", "#104281"],
    font: "DejaVu Sans, Arial, sans-serif",
  };
  // Browser: same roles, bound to CSS variables (defined in styles.css for
  // light and dark) with the light values as fallback.
  const v = (n, f) => "var(--rc-" + n + "," + f + ")";
  const CSS = {
    surface: v("surface", LIGHT.surface), ink: v("ink", LIGHT.ink), inkSoft: v("ink-soft", LIGHT.inkSoft), inkFaint: v("ink-faint", LIGHT.inkFaint),
    grid: v("grid", LIGHT.grid), axis: v("axis", LIGHT.axis),
    s1: v("s1", LIGHT.s1), s2: v("s2", LIGHT.s2), s3: v("s3", LIGHT.s3),
    under: v("under", LIGHT.under), neutral: v("neutral", LIGHT.neutral), over: v("over", LIGHT.over),
    seq: [v("q1", LIGHT.seq[0]), v("q2", LIGHT.seq[1]), v("q3", LIGHT.seq[2]), v("q4", LIGHT.seq[3])],
    font: "inherit",
  };

  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const tw = (s, size) => String(s).length * size * 0.58; // rough text width
  const clip = (s, px, size) => { s = String(s); const max = Math.max(3, Math.floor(px / (size * 0.58))); return s.length > max ? s.slice(0, max - 1) + "…" : s; };
  const fmt = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return "–";
    const r = Math.round(n * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };
  const ammanFmt = typeof Intl !== "undefined" ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }) : null;
  const ymd = (ms) => (ammanFmt ? ammanFmt.format(new Date(ms)) : new Date(ms + 3 * 3600000).toISOString().slice(0, 10));

  function niceScale(min, max, want) {
    want = want || 5;
    if (!(max > min)) { max = min + 1; }
    const raw = (max - min) / want;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
    return { min: lo, max: hi, ticks };
  }

  // top-rounded bar path (rounded at the data end only; square at baseline)
  function barPath(x, y, w, h, r, dir) { // dir: "up" (grows up from y+h), "down", "right", "left"
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (h <= 0 || w <= 0) return "";
    if (dir === "up") return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
    if (dir === "down") return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
    if (dir === "right") return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
    return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`; // left
  }

  // ------------------------------------------------------------------ frame
  function wrapText(text, maxChars, maxLines) {
    const words = String(text).split(/\s+/); const lines = []; let cur = "";
    for (const w of words) { if ((cur + " " + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { const cut = lines.slice(0, maxLines); cut[maxLines - 1] = clip(cut[maxLines - 1] + "…", maxChars * 6.2, 10.5); return cut; }
    return lines;
  }

  function newCtx(spec, opts) {
    const T = opts.theme === "css" ? CSS : LIGHT;
    const W = opts.width || 760, H = opts.height || 400;
    const ctx = { spec, opts, T, W, H, parts: [], font: T.font, top: 14, bottom: 12 };
    ctx.add = (s) => ctx.parts.push(s);
    // header (export only): title; caption goes at the bottom as a footnote
    if (opts.titleInside) {
      ctx.add(`<text x="16" y="26" font-size="15" font-weight="700" fill="${T.ink}">${esc(spec.title)}</text>`);
      ctx.top = 40;
      const lines = spec.caption ? wrapText(spec.caption, Math.floor((W - 32) / 5.9), 2) : [];
      lines.forEach((l, i) => ctx.add(`<text x="16" y="${H - 8 - (lines.length - 1 - i) * 12}" font-size="10" fill="${T.inkFaint}">${esc(l)}</text>`));
      ctx.bottom = 12 + lines.length * 12;
    }
    return ctx;
  }

  function legend(ctx, items) { // items [{name,color}] — drawn as one row, top-left of the plot
    if (!items || items.length < 2) return 0;
    let x = 16;
    const y = ctx.top + 4;
    items.forEach((it) => {
      ctx.add(`<rect x="${x}" y="${y}" width="10" height="10" rx="2" fill="${it.color}"/>`);
      ctx.add(`<text x="${x + 15}" y="${y + 9}" font-size="11.5" fill="${ctx.T.inkSoft}">${esc(it.name)}</text>`);
      x += 15 + tw(it.name, 11.5) + 18;
    });
    ctx.top += 24;
    return 24;
  }

  function finish(ctx) {
    const { W, H, T, opts, spec } = ctx;
    const css = opts.interactive
      ? `<style>.rc-m .rc-bar{transition:opacity .1s}.rc-m:hover .rc-bar{opacity:.78}.rc-col .rc-x{opacity:0}.rc-col:hover .rc-x{opacity:1}.rc-hitbox{cursor:default}.rc-m:focus,.rc-col:focus{outline:none}.rc-m:focus-visible .rc-bar,.rc-col:focus-visible .rc-x{opacity:1;outline:none}</style>`
      : "";
    const bg = opts.theme === "css" ? "" : `<rect width="${W}" height="${H}" fill="${T.surface}"/>`;
    const label = esc(spec.title + (spec.caption ? ". " + spec.caption : ""));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}" font-family="${esc(T.font)}" class="rc-svg">${css}${bg}${ctx.parts.join("")}</svg>`;
  }

  function empty(ctx, msg) {
    const { W, H, T } = ctx;
    ctx.add(`<text x="${W / 2}" y="${(H + ctx.top) / 2}" text-anchor="middle" font-size="13" fill="${T.inkFaint}">${esc(msg || "No data in this scope")}</text>`);
    return finish(ctx);
  }

  // Axes shared by the vertical (column) charts. cats = labels, maxV, returns geometry.
  function columnAxes(ctx, cats, maxV, opts2) {
    const { W, H, T, spec } = ctx;
    const o = opts2 || {};
    const scale = niceScale(o.minV || 0, maxV, 5);
    const yTickW = Math.max(...scale.ticks.map((t) => tw(fmt(t), 10.5)), 8);
    const ml = Math.round(yTickW + 46), mr = 20;
    // x labels: rotate when crowded
    const plotW = W - ml - mr;
    const maxLab = Math.max(...cats.map((c) => tw(c, 10.5)), 10);
    const rotate = cats.length * (maxLab + 10) > plotW;
    const labelH = rotate ? Math.min(90, Math.max(...cats.map((c) => tw(clip(c, 120, 10.5), 10.5))) * 0.72 + 8) : 18;
    const xTitleH = spec.xLabel ? 20 : 0;
    const mb = ctx.bottom + labelH + xTitleH + 6;
    const mt = ctx.top + 8;
    const plotH = H - mt - mb;
    const y = (val) => mt + plotH - ((val - scale.min) / (scale.max - scale.min)) * plotH;
    // grid + y ticks
    scale.ticks.forEach((t) => {
      ctx.add(`<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? T.axis : T.grid}" stroke-width="1"/>`);
      ctx.add(`<text x="${ml - 8}" y="${y(t) + 3.5}" text-anchor="end" font-size="10.5" fill="${T.inkSoft}">${fmt(t)}</text>`);
    });
    if (spec.yLabel) ctx.add(`<text transform="translate(14 ${mt + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${T.inkSoft}">${esc(spec.yLabel)}</text>`);
    if (spec.xLabel) ctx.add(`<text x="${ml + plotW / 2}" y="${H - ctx.bottom - 2}" text-anchor="middle" font-size="11" fill="${T.inkSoft}">${esc(spec.xLabel)}</text>`);
    const band = plotW / Math.max(1, cats.length);
    cats.forEach((c, i) => {
      const cx = ml + band * i + band / 2;
      const ly = mt + plotH + 15;
      if (rotate) ctx.add(`<text transform="translate(${cx + 4} ${ly - 3}) rotate(-35)" text-anchor="end" font-size="10.5" fill="${T.inkSoft}">${esc(clip(c, 120, 10.5))}</text>`);
      else ctx.add(`<text x="${cx}" y="${ly}" text-anchor="middle" font-size="10.5" fill="${T.inkSoft}">${esc(clip(c, band - 6, 10.5))}</text>`);
    });
    return { ml, mr, mt, mb, plotW, plotH, band, y, scale, x0: ml };
  }

  const tipAttr = (s) => ` data-tip="${esc(s)}" tabindex="0"`;
  const BAR_MAX = 24;

  // ------------------------------------------------------------------ grouped columns (Estimated vs Logged)
  function grouped(ctx) {
    const { spec, T } = ctx;
    if (!spec.rows || !spec.rows.length) return empty(ctx);
    const colors = [T.s1, T.s2, T.s3];
    legend(ctx, spec.series.map((s, i) => ({ name: s.name, color: colors[i] })));
    const maxV = Math.max(...spec.rows.map((r) => Math.max(...spec.series.map((s) => r[s.key] || 0))), 1);
    const g = columnAxes(ctx, spec.rows.map((r) => r.label), maxV);
    const n = spec.series.length;
    const bw = Math.min(BAR_MAX, (g.band * 0.72 - 2 * (n - 1)) / n);
    const showVals = spec.rows.length <= 6;
    spec.rows.forEach((r, i) => {
      const total = bw * n + 2 * (n - 1);
      let x = g.x0 + g.band * i + (g.band - total) / 2;
      const tip = r.label + "\n" + spec.series.map((s) => s.name + ": " + fmt(r[s.key])).join("\n") + (r.n ? "\nCompleted tickets: " + r.n : "");
      ctx.add(`<g class="rc-m"${tipAttr(tip)}><rect class="rc-hitbox" fill="#000" fill-opacity="0" x="${g.x0 + g.band * i}" y="${g.mt}" width="${g.band}" height="${g.plotH}"/>`);
      spec.series.forEach((s, k) => {
        const val = r[s.key] || 0, h = g.y(0) - g.y(val);
        ctx.add(`<path class="rc-bar" d="${barPath(x, g.y(val), bw, h, 4, "up")}" fill="${colors[k]}"/>`);
        if (showVals && val > 0) ctx.add(`<text x="${x + bw / 2}" y="${g.y(val) - 4}" text-anchor="middle" font-size="10" fill="${T.ink}">${fmt(val)}</text>`);
        x += bw + 2;
      });
      ctx.add("</g>");
    });
    return finish(ctx);
  }

  // ------------------------------------------------------------------ single-series columns (histogram, issue types)
  function bars(ctx) {
    const { spec, T } = ctx;
    if (!spec.rows || !spec.rows.length) return empty(ctx);
    const tone = { under: T.under, good: T.neutral, over: T.over };
    const maxV = Math.max(...spec.rows.map((r) => r.value || 0), 1);
    const g = columnAxes(ctx, spec.rows.map((r) => r.label), maxV);
    const bw = Math.min(BAR_MAX, g.band * 0.6);
    spec.rows.forEach((r, i) => {
      const x = g.x0 + g.band * i + (g.band - bw) / 2, h = g.y(0) - g.y(r.value || 0);
      const col = r.tone ? tone[r.tone] : T.s1;
      ctx.add(`<g class="rc-m"${tipAttr(r.label + "\n" + fmt(r.value) + " tickets")}><rect class="rc-hitbox" fill="#000" fill-opacity="0" x="${g.x0 + g.band * i}" y="${g.mt}" width="${g.band}" height="${g.plotH}"/>`);
      if (h > 0) ctx.add(`<path class="rc-bar" d="${barPath(x, g.y(r.value), bw, h, 4, "up")}" fill="${col}"/>`);
      if (spec.rows.length <= 14) ctx.add(`<text x="${x + bw / 2}" y="${g.y(r.value || 0) - 5}" text-anchor="middle" font-size="10.5" fill="${T.ink}">${fmt(r.value)}</text>`);
      ctx.add("</g>");
    });
    return finish(ctx);
  }

  // ------------------------------------------------------------------ stacked columns
  function stacked(ctx) {
    const { spec, T } = ctx;
    if (!spec.rows || !spec.rows.length) return empty(ctx);
    const colors = [T.s1, T.s2, T.s3];
    legend(ctx, spec.series.map((s, i) => ({ name: s.name, color: colors[i] })));
    const totals = spec.rows.map((r) => spec.series.reduce((s, k) => s + (r[k.key] || 0), 0));
    const g = columnAxes(ctx, spec.rows.map((r) => r.label), Math.max(...totals, 1));
    const bw = Math.min(BAR_MAX + 8, g.band * 0.6);
    spec.rows.forEach((r, i) => {
      const x = g.x0 + g.band * i + (g.band - bw) / 2;
      let acc = 0;
      const tip = r.label + "\n" + spec.series.map((s) => s.name + ": " + fmt(r[s.key])).join("\n") + "\nTotal: " + fmt(totals[i]);
      ctx.add(`<g class="rc-m"${tipAttr(tip)}><rect class="rc-hitbox" fill="#000" fill-opacity="0" x="${g.x0 + g.band * i}" y="${g.mt}" width="${g.band}" height="${g.plotH}"/>`);
      const segs = spec.series.map((s, k) => ({ k, val: r[s.key] || 0 })).filter((s) => s.val > 0);
      segs.forEach((sg, idx) => {
        const y0 = g.y(acc), y1 = g.y(acc + sg.val);
        const top = idx === segs.length - 1;
        const gap = idx === 0 ? 0 : 2; // surface gap between segments
        const h = y0 - y1 - gap;
        if (h > 0) ctx.add(`<path class="rc-bar" d="${top ? barPath(x, y1, bw, h, 4, "up") : `M${x},${y1}H${x + bw}V${y1 + h}H${x}Z`}" fill="${colors[sg.k]}"/>`);
        acc += sg.val;
      });
      if (totals[i] > 0) ctx.add(`<text x="${x + bw / 2}" y="${g.y(totals[i]) - 5}" text-anchor="middle" font-size="10.5" fill="${T.ink}">${fmt(totals[i])}</text>`);
      ctx.add("</g>");
    });
    return finish(ctx);
  }

  // ------------------------------------------------------------------ donut
  function donut(ctx) {
    const { spec, T, W, H } = ctx;
    const colors = [T.s1, T.s2, T.s3];
    const total = spec.rows.reduce((s, r) => s + (r.value || 0), 0);
    if (!total) return empty(ctx);
    const cx = Math.round(W * 0.34), cy = Math.round((H + ctx.top - ctx.bottom) / 2), R = Math.min(cx - 24, (H - ctx.top - ctx.bottom) / 2 - 8), r0 = R * 0.62;
    let a0 = -Math.PI / 2;
    const pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    const nz = spec.rows.filter((r) => r.value > 0);
    spec.rows.forEach((r, i) => {
      if (!r.value) return;
      const frac = r.value / total;
      let a1 = a0 + frac * Math.PI * 2;
      const tip = r.label + "\n" + fmt(r.value) + " tickets (" + Math.round(frac * 100) + "%)";
      let d;
      if (nz.length === 1) d = `M${cx},${cy - R}A${R},${R} 0 1 1 ${cx - 0.01},${cy - R}L${cx - 0.01},${cy - r0}A${r0},${r0} 0 1 0 ${cx},${cy - r0}Z`;
      else {
        const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        d = `M${x0},${y0}A${R},${R} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
      }
      ctx.add(`<g class="rc-m"${tipAttr(tip)}><path class="rc-bar" d="${d}" fill="${colors[i]}" stroke="${T.surface}" stroke-width="2"/></g>`);
      a0 = a1;
    });
    ctx.add(`<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="26" font-weight="700" fill="${T.ink}">${fmt(total)}</text>`);
    ctx.add(`<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="11" fill="${T.inkSoft}">tickets</text>`);
    // legend column with values — identity never relies on colour alone
    let ly = cy - spec.rows.length * 14;
    const lx = Math.round(W * 0.62);
    if (spec.yLabel) ctx.add(`<text x="${lx}" y="${ly - 14}" font-size="11" fill="${T.inkSoft}">${esc(spec.yLabel)}</text>`);
    spec.rows.forEach((r, i) => {
      ctx.add(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${colors[i]}"/>`);
      ctx.add(`<text x="${lx + 17}" y="${ly}" font-size="12.5" fill="${T.ink}">${esc(r.label)}</text>`);
      ctx.add(`<text x="${W - 24}" y="${ly}" text-anchor="end" font-size="12.5" fill="${T.inkSoft}">${fmt(r.value)} · ${Math.round(((r.value || 0) / total) * 100)}%</text>`);
      ly += 28;
    });
    return finish(ctx);
  }

  // ------------------------------------------------------------------ line (cumulative)
  function line(ctx) {
    const { spec, T, W, H } = ctx;
    if (!spec.rows || !spec.rows.length) return empty(ctx);
    const colors = [T.s1, T.s2, T.s3];
    legend(ctx, spec.series.map((s, i) => ({ name: s.name, color: colors[i] })));
    const maxV = Math.max(...spec.rows.map((r) => Math.max(...spec.series.map((s) => r[s.key] || 0))), 1);
    const n = spec.rows.length;
    const g = columnAxes(ctx, spec.rows.map(() => ""), maxV); // axes/grid only; x labels drawn below
    const xAt = (i) => g.x0 + (n === 1 ? g.plotW / 2 : (g.plotW * i) / (n - 1));
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(g.plotW / 80))));
    let lastShown = -999;
    spec.rows.forEach((r, i) => { if (i % every === 0 || (i === n - 1 && i - lastShown >= every * 0.7)) { lastShown = i; ctx.add(`<text x="${xAt(i)}" y="${g.mt + g.plotH + 15}" text-anchor="middle" font-size="10.5" fill="${T.inkSoft}">${esc(r.label)}</text>`); } });
    spec.series.forEach((s, k) => {
      const pts = spec.rows.map((r, i) => [xAt(i), g.y(r[s.key] || 0)]);
      if (n > 1) ctx.add(`<path d="M${pts.map((p) => p.join(",")).join("L")}" fill="none" stroke="${colors[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    });
    // hover columns: crosshair + markers appear per point (CSS in the browser; hidden in the PNG)
    spec.rows.forEach((r, i) => {
      const x = xAt(i), bw = n === 1 ? g.plotW : g.plotW / (n - 1);
      const tip = r.label + "\n" + spec.series.map((s) => s.name + ": " + fmt(r[s.key])).join("\n");
      ctx.add(`<g class="rc-col"${tipAttr(tip)}><rect class="rc-hitbox" fill="#000" fill-opacity="0" x="${x - bw / 2}" y="${g.mt}" width="${bw}" height="${g.plotH}"/><g class="rc-x" ${ctx.opts.interactive ? "" : 'opacity="0"'}><line x1="${x}" x2="${x}" y1="${g.mt}" y2="${g.mt + g.plotH}" stroke="${T.axis}" stroke-width="1"/>${spec.series.map((s, k) => `<circle cx="${x}" cy="${g.y(r[s.key] || 0)}" r="4" fill="${colors[k]}" stroke="${T.surface}" stroke-width="2"/>`).join("")}</g></g>`);
    });
    // end dots + end value labels (the latest point of each line)
    spec.series.forEach((s, k) => {
      const i = n - 1, x = xAt(i), yv = g.y(spec.rows[i][s.key] || 0);
      ctx.add(`<circle cx="${x}" cy="${yv}" r="4" fill="${colors[k]}" stroke="${T.surface}" stroke-width="2"/>`);
    });
    const last = spec.rows[n - 1];
    const ends = spec.series.map((s, k) => ({ y: g.y(last[s.key] || 0), text: fmt(last[s.key] || 0) })).sort((a, b) => a.y - b.y);
    // labels sit left of the end dot; skip the second when they would collide
    ends.forEach((e, idx) => { if (idx === 0 || Math.abs(e.y - ends[idx - 1].y) > 13) ctx.add(`<text x="${xAt(n - 1) - 9}" y="${e.y - 7}" text-anchor="end" font-size="10.5" font-weight="600" fill="${T.ink}">${e.text}</text>`); });
    return finish(ctx);
  }

  // ------------------------------------------------------------------ scatter (cycle time)
  function scatter(ctx) {
    const { spec, T, W, H } = ctx;
    const pts = spec.points || [];
    if (!pts.length) return empty(ctx);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), 86400000), pad = span * 0.03;
    const xmin = Math.min(...xs) - pad, xmax = Math.max(...xs) + pad;
    const g = columnAxes(ctx, [""], Math.max(...ys, 1) * 1.06);
    const xAt = (t) => g.x0 + ((t - xmin) / (xmax - xmin)) * g.plotW;
    const nT = Math.max(2, Math.min(6, Math.floor(g.plotW / 110)));
    for (let k = 0; k < nT; k++) { const t = xmin + ((xmax - xmin) * k) / (nT - 1); ctx.add(`<text x="${xAt(t)}" y="${g.mt + g.plotH + 15}" text-anchor="${k === 0 ? "start" : k === nT - 1 ? "end" : "middle"}" font-size="10.5" fill="${T.inkSoft}">${ymd(t)}</text>`); }
    const sorted = ys.slice().sort((a, b) => a - b), med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    ctx.add(`<line x1="${g.x0}" x2="${g.x0 + g.plotW}" y1="${g.y(med)}" y2="${g.y(med)}" stroke="${T.inkFaint}" stroke-width="1"/>`);
    ctx.add(`<text x="${g.x0 + g.plotW - 2}" y="${g.y(med) - 5}" text-anchor="end" font-size="10.5" fill="${T.inkSoft}">Median ${fmt(med)} days</text>`);
    pts.forEach((p) => {
      ctx.add(`<g class="rc-m"${tipAttr(p.key + (p.type ? " (" + p.type + ")" : "") + "\nCycle time: " + fmt(p.y) + " days\nCompleted: " + ymd(p.x))}><circle class="rc-bar" cx="${xAt(p.x)}" cy="${g.y(p.y)}" r="5" fill="${T.s1}" fill-opacity="0.85" stroke="${T.surface}" stroke-width="2"/></g>`);
    });
    return finish(ctx);
  }

  // ------------------------------------------------------------------ horizontal bars (aging, top variance, dependency ageing)
  function hbars(ctx) {
    const { spec, T, W, H } = ctx;
    const rows = spec.rows || [];
    if (!rows.length) return empty(ctx, spec.id === "dependency_ageing" ? "No overdue dependencies" : "No data in this scope");
    const labW = Math.min(230, Math.max(70, Math.max(...rows.map((r) => tw(r.label, 11))) + 10));
    const ml = labW + (spec.yLabel ? 30 : 12), mr = 54;
    const xTitleH = spec.xLabel ? 22 : 0;
    const mt = ctx.top + 8, mb = ctx.bottom + 22 + xTitleH;
    const plotW = W - ml - mr, plotH = H - mt - mb;
    const vals = rows.map((r) => r.value || 0);
    const lo = spec.diverging ? Math.min(0, ...vals) : 0, hi = Math.max(0, ...vals, 1);
    const sc = niceScale(lo, hi, 5);
    const x = (val) => ml + ((val - sc.min) / (sc.max - sc.min)) * plotW;
    sc.ticks.forEach((t) => {
      ctx.add(`<line x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${mt + plotH}" stroke="${t === 0 ? T.axis : T.grid}" stroke-width="1"/>`);
      ctx.add(`<text x="${x(t)}" y="${mt + plotH + 14}" text-anchor="middle" font-size="10.5" fill="${T.inkSoft}">${fmt(t)}</text>`);
    });
    if (spec.xLabel) ctx.add(`<text x="${ml + plotW / 2}" y="${H - ctx.bottom - 2}" text-anchor="middle" font-size="11" fill="${T.inkSoft}">${esc(spec.xLabel)}</text>`);
    if (spec.yLabel) ctx.add(`<text transform="translate(12 ${mt + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="11" fill="${T.inkSoft}">${esc(spec.yLabel)}</text>`);
    const band = plotH / rows.length, bh = Math.min(BAR_MAX, band * 0.62);
    rows.forEach((r, i) => {
      const cy = mt + band * i + band / 2, val = r.value || 0;
      const col = spec.diverging ? (val >= 0 ? T.over : T.under) : spec.id === "aging_wip" ? T.seq[i % 4] : T.s1;
      const x0 = x(0), x1 = x(val);
      ctx.add(`<g class="rc-m"${tipAttr(r.label + "\n" + (spec.diverging ? (val >= 0 ? "Over by " : "Under by ") + fmt(Math.abs(val)) + " h" : fmt(val) + (spec.id === "dependency_ageing" ? " days overdue" : " tickets")))}><rect class="rc-hitbox" fill="#000" fill-opacity="0" x="${ml}" y="${cy - band / 2}" width="${plotW}" height="${band}"/>`);
      ctx.add(`<text x="${ml - 8}" y="${cy + 4}" text-anchor="end" font-size="11" fill="${T.ink}">${esc(clip(r.label, labW, 11))}</text>`);
      const w = Math.abs(x1 - x0);
      if (w > 0) ctx.add(`<path class="rc-bar" d="${barPath(Math.min(x0, x1), cy - bh / 2, w, bh, 4, val >= 0 ? "right" : "left")}" fill="${col}"/>`);
      const labX = val >= 0 ? x1 + 6 : x1 - 6;
      ctx.add(`<text x="${labX}" y="${cy + 4}" text-anchor="${val >= 0 ? "start" : "end"}" font-size="10.5" fill="${T.ink}">${val > 0 && spec.diverging ? "+" : ""}${fmt(val)}</text>`);
      ctx.add("</g>");
    });
    return finish(ctx);
  }

  const DRAW = { grouped, bars, stacked, donut, line, scatter, hbars };

  function render(spec, opts) {
    const o = Object.assign({ width: 760, height: 400, theme: "light", titleInside: false, interactive: false }, opts || {});
    const draw = DRAW[spec.type];
    if (!draw) throw new Error("Unknown chart type: " + spec.type);
    return draw(newCtx(spec, o));
  }

  // The same numbers as a table (accessible view + CSV friendly).
  function table(spec) {
    const rows = spec.rows || [];
    if (spec.type === "scatter") return { columns: ["Issue", "Type", "Completed (Amman)", "Cycle time (days)"], rows: (spec.points || []).map((p) => [p.key, p.type || "", ymd(p.x), p.y]) };
    if (spec.series) return { columns: [spec.xLabel || "Label"].concat(spec.series.map((s) => s.name)), rows: rows.map((r) => [r.label].concat(spec.series.map((s) => r[s.key]))) };
    return { columns: [spec.xLabel || spec.yLabel || "Label", "Value"], rows: rows.map((r) => [r.label, r.value]) };
  }

  // Tooltip behaviour for charts rendered in the page. Idempotent per container.
  function attachTips(container, doc) {
    if (!container || container.__rcTips) return;
    container.__rcTips = true;
    const d = doc || container.ownerDocument;
    let tip = null;
    const ensure = () => { if (!tip) { tip = d.createElement("div"); tip.className = "rc-tip"; tip.setAttribute("role", "tooltip"); tip.style.position = "fixed"; tip.style.display = "none"; d.body.appendChild(tip); } return tip; };
    const show = (el, x, y) => {
      const t = ensure();
      t.textContent = "";
      String(el.getAttribute("data-tip") || "").split("\n").forEach((line, i) => { const row = d.createElement("div"); if (i === 0) row.className = "rc-tip-h"; row.textContent = line; t.appendChild(row); });
      t.style.display = "block";
      const w = t.offsetWidth || 160, h = t.offsetHeight || 40, vw = (d.defaultView && d.defaultView.innerWidth) || 1200;
      t.style.left = Math.min(Math.max(8, x + 14), vw - w - 8) + "px";
      t.style.top = Math.max(8, y - h - 12) + "px";
    };
    const hide = () => { if (tip) tip.style.display = "none"; };
    container.addEventListener("mousemove", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el) show(el, e.clientX, e.clientY); else hide(); });
    container.addEventListener("mouseleave", hide);
    container.addEventListener("focusin", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el) { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top + 8); } });
    container.addEventListener("focusout", hide);
  }

  return { render, table, attachTips, THEMES: { light: LIGHT, css: CSS }, TYPES: Object.keys(DRAW) };
});
