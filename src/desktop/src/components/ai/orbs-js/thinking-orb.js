/* ============================================================
 * ThinkingOrb — 一比一移植自 orbs.jakubantalik.com
 * 原版：ThinkingOrb-CPAX2vdL.js（React 组件）
 * 这里去掉 React 外壳，算法逐字保留，改为原生 Canvas 驱动。
 * 9 种状态：working/searching/solving/listening/connecting/
 *           weaving/composing/breathing/shaping
 * ============================================================ */

// ---- 值噪声 ----
function ql(e, t) {
  const n = Math.floor(e),
    r = Math.floor(t);
  let l = e - n,
    o = t - r;
  l = l * l * (3 - 2 * l);
  o = o * o * (3 - 2 * o);
  const u = ze(n, r),
    i = ze(n + 1, r),
    s = ze(n, r + 1),
    f = ze(n + 1, r + 1);
  return u + (i - u) * l + (s - u) * o + (u - i - s + f) * l * o;
}
function ze(e, t) {
  const n = Math.sin(e * 12.9898 + t * 78.233) * 43758.5453;
  return n - Math.floor(n);
}
function pc(e) {
  return e - Math.floor(e);
}

// ---- 球面分布（斐波那契球） ----
function Wu(e, t) {
  const n = Math.PI * (3 - Math.sqrt(5)),
    r = 1 - (2 * (e + 0.5)) / t,
    l = Math.sqrt(1 - r * r),
    o = e * n;
  return [l * Math.cos(o), r, l * Math.sin(o)];
}

// ---- 角度差 ----
function Qd(e, t) {
  return Math.atan2(Math.sin(e - t), Math.cos(e - t));
}

// ---- 3D 相机投影 ----
function Bt(e, t, n, r, l) {
  const o = Math.sin(t),
    u = Math.cos(t),
    i = Math.sin(e),
    s = Math.cos(e);
  return (f, v, h) => {
    const p = f * s + h * i,
      y = -f * i + h * s,
      g = v * u - y * o,
      w = v * o + y * u;
    return [n + p * l, r - g * l, w];
  };
}

// ---- 灰度点渲染（dark 主题白色点，light 主题黑色点） ----
function Kd(e, t, n, r = 0.3) {
  for (const l of t) {
    const o = l.a ?? 1,
      u = Math.min(1, Math.max(0, l.white)),
      i = Math.round((n ? 1 - u : u) * 255);
    e.fillStyle = `rgba(${i},${i},${i},${o})`;
    e.beginPath();
    e.arc(l.x, l.y, l.r, 0, Math.PI * 2);
    e.fill();
  }
}
// ---- 灰度线渲染 ----
function Yd(e, t, n) {
  for (const r of t) {
    const l = r.a ?? 1,
      o = Math.min(1, Math.max(0, r.white)),
      u = Math.round((n ? 1 - o : o) * 255);
    e.strokeStyle = `rgba(${u},${u},${u},${l})`;
    e.lineWidth = r.w;
    e.beginPath();
    e.moveTo(r.x1, r.y1);
    e.lineTo(r.x2, r.y2);
    e.stroke();
  }
}
// ---- 收集/排序（按 z 深度） ----
function Ct(e, t, n = 0.3) {
  const r = [];
  for (const l of e) {
    if ((l.a ?? 1) < 0.02) continue;
    l.r = Math.max(n, l.r);
    r.push(l);
  }
  r.sort((l, o) => l.z - o.z);
  return { dots: r, lines: t.filter((l) => (l.a ?? 1) >= 0.02) };
}
function Xd(e, t, n) {
  if (t.lines.length) Yd(e, t.lines, n);
  Kd(e, t.dots, n);
}
function Vt(e, t) {
  return (e / 300) ** t;
}

/* ---------- braid（weaving） ---------- */
const Gd = (e, t, n) => {
  const r = e / 2,
    l = e / 2,
    o = (e / 2) * 0.76,
    u = Bt(t * 0.4, 0.3, r, l, 1),
    i = Vt(e, n.rsPow ?? 0.6),
    s = [],
    f = n.ghostN ?? 150;
  for (let p = 0; p < f; p++) {
    const y = Wu(p, f),
      [g, w, C] = u(y[0] * o, y[1] * o, y[2] * o),
      c = (C / o + 1) / 2;
    s.push({ x: g, y: w, z: C, r: 0.8 * i, white: 0.78, a: 0.1 + 0.22 * c });
  }
  const v = n.strandN ?? 52,
    h = n.turns ?? 3;
  for (let p = 0; p < 3; p++) {
    const y = (p / 3) * 2 * Math.PI;
    for (let g = 0; g < v; g++) {
      const w = (pc(g / v + t * 0.045) * 2 - 1) * 0.96,
        C = Math.sqrt(Math.max(0, 1 - w * w)),
        c = Math.min(1, (1 - Math.abs(w)) / 0.1),
        a = w * Math.PI * h + y,
        d = 1 + 0.075 * Math.sin(w * Math.PI * h * 2 + y * 2 + t * 0.8),
        m = C * o * d,
        [k, S, x] = u(Math.cos(a) * m, w * o * d, Math.sin(a) * m),
        E = (x / o + 1) / 2;
      s.push({
        x: k,
        y: S,
        z: x,
        r: ((n.rBase ?? 1.2) + (n.rDepth ?? 1.8) * E) * i,
        white: 0.55 - 0.45 * E,
        a: c * (0.45 + 0.55 * E),
      });
    }
  }
  return Ct(s, [], n.rMin);
};

/* ---------- rubik 旋转辅助 ---------- */
function Zd(e, t, n, r) {
  const l = 2 * t * n + r,
    o = e % l,
    u = new Array(t).fill(0);
  let i = -1;
  if (o < 2 * t * n) {
    const s = Math.floor(o / n),
      f = (o - s * n) / n,
      h = 1 - (1 - Math.min(1, f / 0.7)) ** 3;
    if (s < t) {
      for (let p = 0; p < s; p++) u[p] = 1;
      u[s] = h;
      i = s;
    } else {
      const p = 2 * t - 1 - s;
      for (let y = 0; y < p; y++) u[y] = 1;
      u[p] = 1 - h;
      i = p;
    }
  }
  return { amount: u, active: i };
}
function Jd(e, t, n) {
  let [r, l, o] = e,
    u = !1;
  for (let i = 0; i < t.length; i++) {
    if (n.amount[i] <= 0) continue;
    const s = t[i],
      f = s.axis === 0 ? r : s.axis === 1 ? l : o;
    if (f < s.lo || f >= s.hi) continue;
    i === n.active && (u = !0);
    const v = s.ang * n.amount[i],
      h = Math.cos(v),
      p = Math.sin(v);
    if (s.axis === 0) {
      const y = l * h - o * p;
      o = l * p + o * h;
      l = y;
    } else if (s.axis === 1) {
      const y = r * h + o * p;
      o = -r * p + o * h;
      r = y;
    } else {
      const y = r * h - l * p;
      l = r * p + l * h;
      r = y;
    }
  }
  return [r, l, o, u];
}
function qd(e) {
  const t = [];
  for (let n = 0; n < e; n++) {
    const r = Math.min(2, Math.floor(ze(n, 2.3) * 3)),
      l = -1 + 0.5 * Math.min(3, Math.floor(ze(n, 5.9) * 4)),
      o = ze(n, 7.7) < 0.5 ? 1 : -1;
    t.push({ axis: r, lo: l, hi: l + 0.5, ang: (o * Math.PI) / 2 });
  }
  return t;
}

/* ---------- globe（searching） ---------- */
const bd = (e, t, n) => {
  const l = e / 2,
    o = e / 2,
    u = (e / 2) * 0.82,
    i = 0.4 + 0.06 * Math.sin(t * 0.35),
    s = Bt(t * 0.5, i, l, o, u),
    f = t * (0.5 + (1.7 - 0.5) * (n.scanMul ?? 1)),
    v = Vt(e, n.rsPow ?? 0.6),
    h = n.dimBase ?? 1,
    p = [],
    y = n.latRings ?? 17,
    g = n.lonDensity ?? 44;
  for (let w = 0; w <= y; w++) {
    const C = -Math.PI / 2 + (w / y) * Math.PI,
      c = Math.cos(C),
      a = Math.sin(C),
      d = Math.max(1, Math.round(Math.abs(c) * g));
    for (let m = 0; m < d; m++) {
      const k = (m / d) * 2 * Math.PI,
        [S, x, E] = s(c * Math.cos(k), a, c * Math.sin(k)),
        L = (E + 1) / 2,
        N = Qd(k + t * 0.5, f),
        D = Math.exp(-(N * N) / 0.18) * Math.max(0, E);
      p.push({
        x: S,
        y: x,
        z: E,
        r: ((n.rBase ?? 0.6) + (n.rDepth ?? 1.7) * L + (n.rBoost ?? 1) * D) * v,
        white: (n.inkFar ?? 0.62) - (n.inkSpan ?? 0.54) * L,
        a: h + (1 - h) * Math.min(1, D),
      });
    }
  }
  return Ct(p, [], n.rMin);
};

/* ---------- rubik（solving） ---------- */
const ep = (e, t, n) => {
  const r = e / 2,
    l = e / 2,
    o = (e / 2) * 0.82,
    u = Bt(t * 0.55, 0.35 + 0.1 * Math.sin(t * 0.9), r, l, o),
    i = Vt(e, n.rsPow ?? 0.6),
    s = n.moveCount ?? 14,
    f = qd(s),
    v = Zd(t, s, 0.42, 1.2),
    h = [],
    p = n.latRings ?? 15,
    y = n.lonDensity ?? 40;
  for (let g = 0; g <= p; g++) {
    const w = -Math.PI / 2 + (g / p) * Math.PI,
      C = Math.cos(w),
      c = Math.sin(w),
      a = Math.max(1, Math.round(Math.abs(C) * y));
    for (let d = 0; d < a; d++) {
      const m = (d / a) * 2 * Math.PI,
        [k, S, x, E] = Jd([C * Math.cos(m), c, C * Math.sin(m)], f, v),
        [L, N, D] = u(k, S, x),
        I = (D + 1) / 2;
      h.push({
        x: L,
        y: N,
        z: D,
        r: ((n.rBase ?? 0.6) + (n.rDepth ?? 1.7) * I + (E ? n.rActive ?? 0.3 : 0)) * i,
        white: (n.inkFar ?? 0.62) - (n.inkSpan ?? 0.54) * I - (E ? 0.14 : 0),
      });
    }
  }
  return Ct(h, [], n.rMin);
};

/* ---------- wave（listening） ---------- */
const tp = (e, t, n) => {
  const r = e / 2,
    l = e / 2,
    o = (e / 2) * 0.874,
    u = Bt(t * 0.18, 0.38, r, l, 1),
    i = Vt(e, n.rsPow ?? 0.6),
    s = [],
    f = n.rings ?? 15,
    v = n.lonDensity ?? 40;
  for (let h = 0; h <= f; h++) {
    const p = -Math.PI / 2 + (h / f) * Math.PI,
      y = Math.cos(p),
      g = Math.sin(p),
      w = 0.62 * Math.sin(t * 2.1 - h * 0.52) + 0.38 * Math.sin(t * 1.27 + h * 0.83),
      C = o * (0.88 + 0.105 * w),
      c = Math.max(1, Math.round(Math.abs(y) * v));
    for (let a = 0; a < c; a++) {
      const d = (a / c) * 2 * Math.PI,
        [m, k, S] = u(y * Math.cos(d) * C, g * C, y * Math.sin(d) * C),
        x = (S / o + 1) / 2,
        E = Math.max(0, w);
      s.push({
        x: m,
        y: k,
        z: S,
        r: ((n.rBase ?? 0.6) + (n.rDepth ?? 1.7) * x) * (1 + 0.4 * E) * i,
        white: 0.66 - 0.56 * x - 0.1 * E,
      });
    }
  }
  return Ct(s, [], n.rMin);
};

/* ---------- morph（shaping）辅助 ---------- */
function np(e) {
  return e * e * (3 - 2 * e);
}
function hc(e) {
  const t = e.length,
    n = [];
  let r = 0;
  for (let l = 0; l < t; l++) {
    const o = e[l],
      u = e[(l + 1) % t],
      i = Math.hypot(u[0] - o[0], u[1] - o[1]);
    n.push(i);
    r += i;
  }
  return (l) => {
    let o = l * r,
      u = 0;
    for (; o > n[u] && u < t - 1; ) {
      o -= n[u];
      u++;
    }
    const i = e[u],
      s = e[(u + 1) % t],
      f = n[u] ? Math.min(1, o / n[u]) : 0;
    return [i[0] + (s[0] - i[0]) * f, i[1] + (s[1] - i[1]) * f];
  };
}
const rp = (e) => {
  const t = -Math.PI / 2 + e * 2 * Math.PI;
  return [Math.cos(t) * 0.24, Math.sin(t) * 0.24];
};
const lp = hc([
  [0, -0.26],
  [0.24, 0.16],
  [-0.24, 0.16],
]);
const op = hc([
  [0, -0.2],
  [0.2, -0.2],
  [0.2, 0.2],
  [-0.2, 0.2],
  [-0.2, -0.2],
]);
const bl = [rp, lp, op];
function up(e) {
  return Math.max(6, Math.round(34 * e));
}
const Xo = 1.4,
  mc = 0.9,
  eo = Xo + mc;
/* morph（shaping）：圆 → 三角 → 方块 → 圆 */
const ip = (e, t, n) => {
  const r = bl.length,
    l = t % (eo * r),
    o = Math.floor(l / eo),
    u = l - o * eo,
    i = u > Xo ? np((u - Xo) / mc) : 0,
    s = n.spread ?? 1,
    f = bl[o],
    v = bl[(o + 1) % r],
    h = 160,
    p = [];
  for (let S = 0; S < h; S++) {
    const x = S / h,
      E = f(x),
      L = v(x);
    p.push([(E[0] + (L[0] - E[0]) * i) * s, (E[1] + (L[1] - E[1]) * i) * s]);
  }
  const y = [];
  let g = 0;
  for (let S = 0; S < h; S++) {
    const x = p[S],
      E = p[(S + 1) % h],
      L = Math.hypot(E[0] - x[0], E[1] - x[1]);
    y.push(L);
    g += L;
  }
  const w = up(n.iconD ?? 1),
    C = (n.rDot ?? 0.021) * 1.35 * s,
    c = 1 + 0.02 * Math.sin(u * 3.1),
    a = [],
    d = e / 2;
  let m = 0,
    k = 0;
  for (let S = 0; S < w; S++) {
    const x = (S / w) * g;
    for (; k + y[m] < x && m < h - 1; ) {
      k += y[m];
      m++;
    }
    const E = p[m],
      L = p[(m + 1) % h],
      N = y[m] ? Math.min(1, (x - k) / y[m]) : 0,
      D = (E[0] + (L[0] - E[0]) * N) * c,
      I = (E[1] + (L[1] - E[1]) * N) * c;
    a.push({ x: d + D * e, y: d + I * e, z: 0, r: Math.max(0.35, C * e), white: 0.1 });
  }
  return Ct(a, [], n.rMin);
};

/* ---------- orbits（working） ---------- */
const sp = (e, t, n) => {
  const r = e / 2,
    l = e / 2,
    o = (e / 2) * 0.82,
    u = Bt(t * 0.12, 0.3, r, l, 1),
    i = Vt(e, n.rsPow ?? 0.6),
    s = [],
    f = n.orbitN ?? 12,
    v = n.ghostN ?? 40,
    h = n.particles ?? 3;
  for (let p = 0; p < f; p++) {
    const y = ze(p, 1.7),
      g = ze(p, 5.2),
      w = ze(p, 8.9),
      C = o * (0.45 + 0.52 * y),
      c = y * 2 * Math.PI,
      a = Math.acos(2 * g - 1),
      d = Math.sin(a) * Math.cos(c),
      m = Math.cos(a),
      k = Math.sin(a) * Math.sin(c);
    let S = -m,
      x = d;
    const E = 0,
      L = Math.max(1e-6, Math.sqrt(S * S + x * x));
    S /= L;
    x /= L;
    const N = m * E - k * x,
      D = k * S - d * E,
      I = d * x - m * S,
      pe = (0.25 + 0.55 * w) * (w > 0.5 ? 1 : -1);
    for (let se = 0; se < v; se++) {
      const Y = (se / v) * 2 * Math.PI,
        [Z, Ce, _] = u(
          (S * Math.cos(Y) + N * Math.sin(Y)) * C,
          (x * Math.cos(Y) + D * Math.sin(Y)) * C,
          (E * Math.cos(Y) + I * Math.sin(Y)) * C
        ),
        z = (_ / C + 1) / 2;
      s.push({
        x: Z,
        y: Ce,
        z: _,
        r: (n.ghostR ?? 0.9) * i,
        white: 0.72,
        a: (n.ghostA ?? 0.5) * (0.4 + 0.6 * z),
      });
    }
    for (let se = 0; se < h; se++) {
      const Y = t * pe + (se / h) * 2 * Math.PI + g * 6,
        [Z, Ce, _] = u(
          (S * Math.cos(Y) + N * Math.sin(Y)) * C,
          (x * Math.cos(Y) + D * Math.sin(Y)) * C,
          (E * Math.cos(Y) + I * Math.sin(Y)) * C
        ),
        z = (_ / C + 1) / 2;
      s.push({
        x: Z,
        y: Ce,
        z: _,
        r: ((n.partR ?? 1.2) + (n.partRDepth ?? 1.6) * z) * i,
        white: 0.3 - 0.22 * z,
      });
    }
  }
  return Ct(s, [], n.rMin);
};

/* ---------- ribbon（composing）/ ring（breathing） ---------- */
const bi = (e, t, n) => {
  const r = e / 2,
    l = e / 2,
    o = (e / 2) * 0.78,
    u = n.spin ?? 1,
    i = 0.3,
    s = Bt(t * 0.1 * u, i, r, l, 1),
    f = Vt(e, n.rsPow ?? 0.6),
    v = [],
    h = n.ghostN ?? 150;
  for (let I = 0; I < h; I++) {
    const pe = Wu(I, h),
      [se, Y, Z] = s(pe[0] * o, pe[1] * o, pe[2] * o),
      Ce = (Z / o + 1) / 2;
    v.push({ x: se, y: Y, z: Z, r: 0.8 * f, white: 0.78, a: 0.1 + 0.22 * Ce });
  }
  const p = t * 0.24 * u,
    y = n.faceOn ? -i : 0.55 + 0.3 * Math.sin(t * 0.18) * u,
    g = Math.cos(p),
    w = 0,
    C = Math.sin(p),
    c = -C * Math.sin(y),
    a = Math.cos(y),
    d = g * Math.sin(y),
    m = w * d - C * a,
    k = C * c - g * d,
    S = g * a - w * c,
    x = 0.23 * (n.wobMul ?? 1),
    E = n.faceOn ? o / (1 + 0.85 * x) : o,
    L = n.lanes ?? 5,
    N = n.segs ?? 88,
    D = Math.max(1, Math.round(L * (n.bandMul ?? 1)));
  for (let I = 0; I < D; I++) {
    const pe = (I - (D - 1) / 2) * 0.075,
      se = Math.abs(I - (D - 1) / 2) / Math.max(1, (D - 1) / 2);
    for (let Y = 0; Y < N; Y++) {
      const Z = (Y / N) * 2 * Math.PI,
        Ce =
          (0.16 * Math.sin(Z * 3 - t * 1.7 + I * 0.22) + 0.07 * Math.sin(Z * 5 + t * 1.1)) *
          (n.wobMul ?? 1),
        _ = n.faceOn ? 1 + Ce : 1,
        z = n.faceOn ? pe : pe + Ce,
        T = g * Math.cos(Z) + c * Math.sin(Z) + m * z,
        U = w * Math.cos(Z) + a * Math.sin(Z) + k * z,
        Q = C * Math.cos(Z) + d * Math.sin(Z) + S * z,
        rt = Math.sqrt(T * T + U * U + Q * Q),
        De = E * _,
        [wn, Ke, _t] = s((T / rt) * De, (U / rt) * De, (Q / rt) * De),
        Ml = (_t / o + 1) / 2;
      v.push({
        x: wn,
        y: Ke,
        z: _t,
        r: ((n.rBase ?? 1.1) + (n.rDepth ?? 1.7) * Ml) * (1 - 0.25 * se) * f,
        white: 0.52 - 0.44 * Ml + 0.18 * se,
        a: 0.4 + 0.6 * Ml,
      });
    }
  }
  return Ct(v, [], n.rMin);
};

/* ---------- web（connecting） ---------- */
const ap = (e, t, n) => {
  const r = e / 2,
    l = e / 2,
    o = (e / 2) * 0.8 * (n.spread ?? 1),
    u = Bt(t * 0.12, 0.32, r, l, o),
    i = Vt(e, n.rsPow ?? 0.6),
    s = n.nodeN ?? 30,
    f = n.thr ?? 0.72,
    v = n.nodeR ?? 1.4,
    h = n.nodeRDepth ?? 1.8,
    p = [];
  for (let C = 0; C < s; C++) {
    const c = Wu(C, s),
      a = c[0] + 0.3 * (ql(C * 0.31 + 9, t * 0.24) - 0.5) * 2,
      d = c[1] + 0.3 * (ql(C * 0.53 + 27, t * 0.21) - 0.5) * 2,
      m = c[2] + 0.3 * (ql(C * 0.77 + 55, t * 0.27) - 0.5) * 2,
      k = Math.sqrt(a * a + d * d + m * m);
    p.push([a / k, d / k, m / k]);
  }
  const y = [],
    g = [];
  for (let C = 0; C < s; C++)
    for (let c = C + 1; c < s; c++) {
      const a = p[C][0] - p[c][0],
        d = p[C][1] - p[c][1],
        m = p[C][2] - p[c][2],
        k = Math.sqrt(a * a + d * d + m * m);
      if (k >= f) continue;
      const [S, x, E] = u(p[C][0], p[C][1], p[C][2]),
        [L, N, D] = u(p[c][0], p[c][1], p[c][2]),
        I = ((E + D) / 2 + 1) / 2;
      y.push({
        x1: S,
        y1: x,
        x2: L,
        y2: N,
        white: 0.42,
        a: (1 - k / f) * (0.3 + 0.55 * I),
        w: Math.max(0.6, (n.lineW ?? 0.8) * i),
      });
    }
  for (let C = 0; C < s; C++) {
    const [c, a, d] = u(p[C][0], p[C][1], p[C][2]),
      m = (d + 1) / 2,
      k = 1 + 0.25 * Math.sin(t * 1.4 + C * 2.7);
    g.push({ x: c, y: a, z: d, r: (v + h * m) * k * i, white: 0.55 - 0.45 * m });
  }
  const w = n.signals ?? 5;
  for (let C = 0; C < w; C++) {
    const c = Math.floor(t * 0.55 + C * 7.31),
      a = Math.floor(ze(c, C * 3.1 + 1.7) * s),
      d = Math.floor(ze(c, C * 5.7 + 4.2) * s);
    if (a === d) continue;
    const m = pc(t * 0.55 + C * 7.31),
      k = Jl(p[a][0], p[d][0], m),
      S = Jl(p[a][1], p[d][1], m),
      x = Jl(p[a][2], p[d][2], m),
      E = Math.max(1e-6, Math.sqrt(k * k + S * S + x * x)),
      [L, N, D] = u(k / E, S / E, x / E),
      I = (D + 1) / 2;
    g.push({ x: L, y: N, z: D, r: (v * 1.5 + h * I) * i, white: 0.05, a: 0.5 + 0.5 * I });
  }
  return Ct(g, y, n.rMin);
};

/* ---------- 渲染函数表 + 配置 ---------- */
const cp = {
  orbits: sp,
  globe: bd,
  rubik: ep,
  wave: tp,
  web: ap,
  braid: Gd,
  ribbon: bi,
  ring: bi,
  morph: ip,
};
const fp = Object.fromEntries(
  Object.entries(cp).map(([e, t]) => [e, (n, r, l, o, u) => Xd(n, t(r, l, u), o)])
);

const dp = [
  ['latRings', 'lonDensity'],
  ['rings', 'lonDensity'],
  ['lanes', 'segs'],
];
const pp = ['orbitN', 'ghostN', 'nodeN', 'strandN', 'signals'];
const hp = ['iconD'];
const mp = [
  'rBase',
  'rDepth',
  'rActive',
  'rDot',
  'ghostR',
  'partR',
  'partRDepth',
  'nodeR',
  'nodeRDepth',
];
function vp(e, t) {
  const n = { ...e },
    r = new Set(),
    l = Math.sqrt(t);
  for (const [o, u] of dp) {
    const i = n[o],
      s = n[u];
    if (i != null && s != null && !r.has(o) && !r.has(u)) {
      n[o] = Math.max(2, Math.round(i * l));
      n[u] = Math.max(2, Math.round(s * l));
      r.add(o);
      r.add(u);
    }
  }
  for (const o of pp) {
    const u = n[o];
    if (u != null && u !== 0 && !r.has(o)) n[o] = Math.max(1, Math.round(u * t));
  }
  for (const o of hp) {
    const u = n[o];
    if (u != null) n[o] = Math.max(0.02, u * t);
  }
  return n;
}
function yp(e, t) {
  const n = { ...e };
  for (const r of mp) {
    const l = n[r];
    if (l != null) n[r] = l * t;
  }
  n.rSizeMul = (n.rSizeMul ?? 1) * t;
  return n;
}

const gp = {
  globe: {
    latRings: 17,
    lonDensity: 44,
    rBase: 0.6,
    rDepth: 1.7,
    rBoost: 1,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  orbits: {
    orbitN: 12,
    ghostN: 40,
    ghostR: 0.9,
    ghostA: 0.5,
    particles: 3,
    partR: 1.2,
    partRDepth: 1.6,
    rsPow: 0.6,
    rMin: 0.3,
  },
  rubik: {
    latRings: 15,
    lonDensity: 40,
    moveCount: 14,
    rBase: 0.6,
    rDepth: 1.7,
    rActive: 0.3,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  wave: { rings: 15, lonDensity: 40, rBase: 0.6, rDepth: 1.7, rsPow: 0.6, rMin: 0.3 },
  web: {
    nodeN: 30,
    thr: 0.72,
    signals: 5,
    nodeR: 1.4,
    nodeRDepth: 1.8,
    lineW: 0.8,
    rsPow: 0.6,
    rMin: 0.3,
  },
  braid: { strandN: 52, turns: 3, ghostN: 150, rBase: 1.2, rDepth: 1.8, rsPow: 0.6, rMin: 0.3 },
  ribbon: { lanes: 5, segs: 88, ghostN: 150, rBase: 1.1, rDepth: 1.7, rsPow: 0.6, rMin: 0.3 },
  ring: {
    lanes: 5,
    segs: 88,
    ghostN: 0,
    faceOn: 1,
    rBase: 1.1,
    rDepth: 1.7,
    rsPow: 0.6,
    rMin: 0.3,
  },
  morph: { rDot: 0.021, iconD: 1, rMin: 0.25 },
};

const wp = {
  working: 'orbits',
  searching: 'globe',
  solving: 'rubik',
  listening: 'wave',
  connecting: 'web',
  weaving: 'braid',
  composing: 'ribbon',
  breathing: 'ring',
  shaping: 'morph',
};

const kp = {
  orbits: {
    64: { speed: 1.885, count: 1, size: 1 },
    20: { speed: 3.9, count: 0.238, size: 2.4 },
  },
  globe: {
    64: { speed: 2.015, count: 0.42, size: 1.15, extra: { scanMul: 4.08, dimBase: 0.45 } },
    20: { speed: 2.665, count: 0.105, size: 1.75, extra: { scanMul: 4.335, dimBase: 0.45 } },
  },
  rubik: {
    64: { speed: 1.82, count: 0.35, size: 1.05 },
    20: { speed: 1.95, count: 0.088, size: 1.9 },
  },
  wave: {
    64: { speed: 4.388, count: 0.341, size: 1 },
    20: { speed: 3.998, count: 0.105, size: 1.6 },
  },
  web: {
    64: { speed: 3.315, count: 1.35, size: 0.95 },
    20: { speed: 6.63, count: 0.25, size: 1.52 },
  },
  braid: {
    64: { speed: 1.625, count: 0.5, size: 1 },
    20: { speed: 2.75, count: 0.1125, size: 1.36 },
  },
  ribbon: {
    64: { speed: 2.34, count: 0.25, size: 0.85, extra: { spin: 0, bandMul: 3.9, wobMul: 1 } },
    20: { speed: 3.12, count: 0.051, size: 1.073, extra: { spin: 0, bandMul: 4.94, wobMul: 1 } },
  },
  ring: {
    64: {
      speed: 3.24,
      count: 0.25,
      size: 0.956,
      extra: { spin: 0, bandMul: 3.627, wobMul: 0.368 },
    },
    20: {
      speed: 3.78,
      count: 0.028,
      size: 1.622,
      extra: { spin: 0, bandMul: 3.968, wobMul: 0.565 },
    },
  },
  morph: {
    64: { speed: 2.405, count: 0.702, size: 0.395, extra: { spread: 1.45 } },
    20: { speed: 2.08, count: 0.53, size: 1.011, extra: { spread: 1.45 } },
  },
};

const _es = new Map();
// 尺寸归一：所有显示尺寸 ≥24 都归 64 档（用完整粒子密度 = 看起来像原版 breathing 那种密集环）
// ≤22 才用 20 档（适合极小指示点）
// 避免 24~40 区间被分到 20 档导致 count 被砍 76%（粒子稀疏 = "虚线圈"）
function nz(e) {
  return e <= 22 ? 20 : 64;
}
function Sp(e, t) {
  const s = nz(t),
    n = `${e}-${s}`,
    r = _es.get(n);
  if (r) return r;
  const l = wp[e],
    o = kp[l][s];
  let u = { ...gp[l] };
  if (o.count !== 1) u = vp(u, o.count);
  if (o.size !== 1) u = yp(u, o.size);
  if (o.extra) u = { ...u, ...o.extra };
  // 按实际 canvas 尺寸缩放粒子半径（保证 24px/48px 下密度与 20/64 一致观感）
  const i = { mode: l, speed: o.speed, opts: u, scale: t / s };
  _es.set(n, i);
  return i;
}

function Jl(e, t, n) {
  return e + (t - e) * n;
}

/* ============================================================
 * 原生驱动（替代 React 组件 Pp）
 * 与原版行为一致：
 *  - canvas 尺寸 = size × dpr（dpr 封顶 2）
 *  - 灰度点按主题反色（dark=白点，light=黑点）
 *  - requestAnimationFrame 循环
 *  - IntersectionObserver 不可见即停
 *  - visibilitychange 隐藏即停
 *  - prefers-reduced-motion 渲染静态帧
 * ============================================================ */
class ThinkingOrb {
  constructor(canvas, { state = 'working', size = 64, speed = 1, paused = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.size = size;
    this.speedMul = speed;
    this.paused = paused;
    this._raf = 0;
    this._running = false;
    this._visible = true;
    this._reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * this._dpr);
    canvas.height = Math.round(size * this._dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';

    this._cfg = Sp(state, size);
    this._renderer = fp[this._cfg.mode];
    this._isDark = this._detectDark();

    this._io =
      'IntersectionObserver' in window
        ? new IntersectionObserver(([entry]) => {
            this._visible = entry.isIntersecting;
            this._visible && document.visibilityState !== 'hidden' ? this._start() : this._stop();
          })
        : null;
    if (this._io) this._io.observe(canvas);
    document.addEventListener('visibilitychange', this._onVis);

    if (this._reduce) {
      this._draw(0.6);
    } else {
      this._start();
    }
  }

  _detectDark() {
    const pref = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return pref;
  }

  _onVis = () => {
    if (document.visibilityState === 'hidden') this._stop();
    else if (this._visible) this._start();
  };

  _draw(time) {
    const ctx = this.ctx;
    const t = this.size;
    const dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, t, t);
    // scale 修正：opts 按 20/64 档配置，实际 canvas 尺寸不同时缩放半径类参数，保证观感一致
    // ⚠️ 不做粒子数补偿：demo 版经用户验收为基准，改动曾导致 42px orb 粒子被砍成"虚线圈"
    if (this._cfg.scale === 1) {
      this._renderer(ctx, t, time, this._isDark, this._cfg.opts);
    } else {
      const s = this._cfg.scale;
      const o = { ...this._cfg.opts };
      for (const k of ['rBase', 'rDepth', 'rActive', 'rDot', 'ghostR', 'partR', 'partRDepth', 'nodeR', 'nodeRDepth', 'rSizeMul']) {
        if (o[k] != null) o[k] = o[k] * s;
      }
      this._renderer(ctx, t, time, this._isDark, o);
    }
  }

  _start() {
    if (this._running || this.paused || this._reduce) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._draw((performance.now() / 1000) * this._cfg.speed * this.speedMul);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this._cfg = Sp(state, this.size);
    this._renderer = fp[this._cfg.mode];
  }

  setTheme(dark) {
    this._isDark = dark;
  }

  destroy() {
    this._stop();
    if (this._io) this._io.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
  }
}

window.ThinkingOrb = ThinkingOrb;

export { ThinkingOrb };
