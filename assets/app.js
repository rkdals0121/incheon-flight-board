(() => {
"use strict";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const S = {
  airports: {}, airlines: {}, zones: null, geo: null,
  days: [], flights: [],
  zoneFilter: null, gateFilter: null,
};

const cache = new Map();

async function j(path) {
  if (cache.has(path)) return cache.get(path);
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  const data = await r.json();
  cache.set(path, data);
  return data;
}

/* ── 분류 ───────────────────────────────────────────── */

function enrich(f) {
  const ap = S.airports[f.port] || null;
  const al = S.airlines[f.carrier] || null;
  return {
    ...f,
    city: ap ? ap.ko : (f.portName || f.port),
    country: ap ? ap.country : "",
    region: ap ? ap.region : "",
    km: ap ? ap.km : null,
    band: ap ? ap.band : "",
    airlineName: f.airline || (al ? al.ko : f.carrier),
    carrierType: al ? al.type : "",
    alliance: al ? al.alliance : "",
    carrierCountry: al ? al.country : "",
  };
}

function zoneOf(term, gate) {
  const t = S.zones.terminals[term];
  if (!t) return null;
  const g = parseInt(gate, 10);
  return t.zones.find((z) => g >= z.from && g <= z.to) || null;
}

function termOfGate(gate) {
  const g = parseInt(gate, 10);
  for (const [k, t] of Object.entries(S.zones.terminals)) {
    if (g >= t.gateRange[0] && g <= t.gateRange[1]) return k;
  }
  return "";
}

const top = (arr, n) => {
  const c = new Map();
  for (const v of arr) if (v) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
};

/* ── 필터 ───────────────────────────────────────────── */

function visible() {
  const term = $("#sel-term").value;
  const dir = $("#sel-dir").value;
  const share = $("#sel-share").value;
  const q = $("#q").value.trim().toLowerCase();

  return S.flights.filter((f) => {
    if (f.dir !== dir) return false;
    if (!f.gate) return false;
    if (share === "master" && f.codeshare && f.codeshare !== "Master") return false;
    const t = f.terminal || termOfGate(f.gate);
    if (term !== "ALL" && t !== term) return false;
    if (S.zoneFilter) {
      const z = zoneOf(t, f.gate);
      if (!z || z.id !== S.zoneFilter) return false;
    }
    if (S.gateFilter && f.gate !== S.gateFilter) return false;
    if (q) {
      const hay = `${f.flight} ${f.city} ${f.country} ${f.airlineName} ${f.gate} ${f.port} ${f.band} ${f.alliance}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ── 터미널 평면도 ───────────────────────────────────
   data/geo.json (OpenStreetMap 추출) 의 건물 외곽선과 게이트 좌표를
   그대로 투영해 그린다. 손으로 그린 도형이 아니라 실측 좌표다.
   좌표는 [경도, 위도] 순서이고, 지리 방위 기준이라 오른쪽이 동쪽이다.   */

const SVGNS = "http://www.w3.org/2000/svg";
const sv = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const AM_STOPS = { 276: "E1", 280: "E2", 224: "W1", 219: "W2" };
const AM_LEGS = [["276", "280"], ["224", "219"]];
const VB_W = 1000, VB_PAD = 58;

/* 위경도를 평면에 올린다. 한국 위도에서 경도 1도는 위도 1도보다 짧으므로
   cos(중심위도) 로 가로를 보정하지 않으면 건물이 옆으로 늘어난다.
   터미널마다 독립적으로 bounding box 를 잡는다. 셋은 서로 멀어서
   한 좌표계에 놓으면 각각이 점처럼 작아진다. */
/* 볼록껍질 (monotone chain). 최소 외접 사각형을 구하는 전 단계다. */
function convexHull(p) {
  const pts = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

const spanOf = (hull, t) => {
  const c = Math.cos(t), s = Math.sin(t);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of hull) {
    const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x1 - x0, y1 - y0];
};

/* 최소 넓이 외접 사각형의 장축이 수평이 되는 회전각.
   최소 사각형의 한 변은 반드시 볼록껍질의 한 변과 평행하므로 변마다 검사한다. */
function minAreaAngle(hull) {
  let best = 0, bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const t = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    const [w, h] = spanOf(hull, t);
    if (w * h < bestArea) { bestArea = w * h; best = t; }
  }
  const [w, h] = spanOf(hull, best);
  if (w < h) best += Math.PI / 2;      // 장축을 가로로
  return best;
}

function projector(terminal) {
  const geo = S.geo.terminals[terminal];
  if (!geo) return null;
  const gates = terminalGates(terminal);
  const all = geo.ring.concat(gates.map((g) => g.ll));
  const k = Math.cos(all.reduce((s, p) => s + p[1], 0) / all.length * Math.PI / 180);
  const proj = (ll) => [ll[0] * k, -ll[1]];

  // 회전 행렬만 쓴다. 스케일은 항상 양수이므로 거울 반전이 생기지 않는다.
  const th = minAreaAngle(convexHull(geo.ring.map(proj)));
  const ct = Math.cos(th), st = Math.sin(th);
  const rot = ([x, y]) => [x * ct - y * st, x * st + y * ct];

  const pts = all.map((ll) => rot(proj(ll)));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const bw = Math.max(...xs) - x0 || 1, bh = Math.max(...ys) - y0 || 1;

  const H = Math.max(300, Math.min(700, Math.round(VB_W * bh / bw)));
  const s = Math.min((VB_W - 2 * VB_PAD) / bw, (H - 2 * VB_PAD) / bh);
  const ox = (VB_W - bw * s) / 2, oy = (H - bh * s) / 2;
  return {
    H,
    at: (ll) => { const [x, y] = rot(proj(ll)); return [ox + (x - x0) * s, oy + (y - y0) * s]; },
    center: [VB_W / 2, H / 2],
    // 투영 공간에서 북쪽은 (0,-1). 같은 각도로 돌려 화면상 북쪽 방향을 얻는다.
    north: [st, -ct],
    deg: Math.round(((th * 180 / Math.PI) % 360 + 360) % 360),
  };
}

function terminalGates(terminal) {
  const range = S.zones.terminals[terminal];
  if (!range || !S.geo) return [];
  const [lo, hi] = range.gateRange;
  const out = [];
  for (const [g, ll] of Object.entries(S.geo.gates)) {
    const n = parseInt(g, 10);
    if (n >= lo && n <= hi) out.push({ g, n, ll });
  }
  return out.sort((a, b) => a.n - b.n);
}

function renderMap(rows) {
  const wrap = $("#map-wrap");
  const term = $("#sel-term").value;
  const isMap = term !== "ALL" && S.geo && S.geo.terminals[term];
  $("#spine-hint").textContent = isMap
    ? "평면도의 점 크기와 막대 높이는 모두 게이트별 편수입니다. 게이트나 구역을 누르면 아래 목록이 좁혀집니다."
    : "막대 높이는 게이트별 편수입니다. 구역이나 게이트를 누르면 아래 목록이 좁혀집니다.";
  if (!isMap) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const host = $("#map");
  host.replaceChildren();

  const byGate = new Map();
  for (const f of rows) {
    const k = String(parseInt(f.gate, 10));
    byGate.set(k, (byGate.get(k) || 0) + 1);
  }
  const peak = Math.max(1, ...byGate.values());

  const P = projector(term);
  const gates = terminalGates(term);
  const svg = sv("svg", {
    viewBox: `0 0 ${VB_W} ${P.H}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": `${S.zones.terminals[term].label} 게이트 배치도`,
  });

  const defs = sv("defs");
  const mk = sv("marker", { id: "am-arrow", viewBox: "0 0 10 10", refX: "8", refY: "5",
    markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
  mk.append(sv("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--mark)" }));
  defs.append(mk);
  const nmk = sv("marker", { id: "n-arrow", viewBox: "0 0 10 10", refX: "8", refY: "5",
    markerWidth: "5", markerHeight: "5", orient: "auto" });
  nmk.append(sv("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--ink)" }));
  defs.append(nmk);
  svg.append(defs);

  // 건물 외곽선
  svg.append(sv("polygon", { class: "m-ring",
    points: S.geo.terminals[term].ring.map((ll) => P.at(ll).map((v) => v.toFixed(1)).join(",")).join(" ") }));

  // AM 운행 구간 — T2 에서만. 좌표는 geo.json 의 게이트 위치를 그대로 쓴다.
  if (term === "T2") {
    const am = sv("g", { class: "m-am" });
    for (const [a, b] of AM_LEGS) {
      const ga = S.geo.gates[a], gb = S.geo.gates[b];
      if (!ga || !gb) continue;
      const [x1, y1] = P.at(ga), [x2, y2] = P.at(gb);
      am.append(sv("line", { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1),
        "marker-start": "url(#am-arrow)", "marker-end": "url(#am-arrow)" }));
      const t = sv("text", { class: "m-amlab", "text-anchor": "middle",
        x: ((x1 + x2) / 2).toFixed(1), y: ((y1 + y2) / 2 - 6).toFixed(1) });
      t.textContent = "AM";
      am.append(t);
    }
    svg.append(am);
  }

  // 실측 좌표라 게이트가 몰린 구간이 있다. 라벨이 겹치면 읽을 수 없으므로
  // 편수가 많은 쪽부터 자리를 잡고, 겹치는 라벨은 생략한다(호버로 확인 가능).
  const placed = [];
  const fits = (x, y, n) => {
    const w = n.length * 6 + 3, box = [x - w / 2, y - 6, x + w / 2, y + 5];
    if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return false;
    placed.push(box);
    return true;
  };
  const order = gates.slice().sort((a, b) => (byGate.get(b.g) || 0) - (byGate.get(a.g) || 0));
  const labelled = new Set();
  for (const { g, ll } of order) {
    const [x, y] = P.at(ll);
    const dx = x - P.center[0], dy = y - P.center[1], d = Math.hypot(dx, dy) || 1;
    if (fits(x + dx / d * 15, y + dy / d * 15, g)) labelled.add(g);
  }

  // 게이트
  const gg = sv("g", { class: "m-gates" });
  for (const { g, ll } of gates) {
    const [x, y] = P.at(ll);
    const c = byGate.get(g) || 0;
    const on = S.gateFilter === g;
    const r = c ? 3 + 4.6 * (c / peak) : 2.4;
    const stop = AM_STOPS[g];

    const node = sv("g", { class: "m-g", tabindex: "0", role: "button",
      "data-has": c ? "1" : "0", "data-am": stop ? "1" : "0", "data-on": on ? "1" : "0",
      "aria-label": `${g}번 게이트 ${c}편${stop ? ` · AM ${stop}` : ""}` });

    node.append(sv("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 11, class: "m-hit" }));
    const dot = sv("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(1), class: "m-dot" });
    if (c) dot.style.setProperty("--o", (0.4 + 0.55 * (c / peak)).toFixed(2));
    node.append(dot);

    const ttl = sv("title");
    ttl.textContent = `${g}번 · ${c}편${stop ? ` · AM ${stop} 승하차` : ""}`;
    node.append(ttl);

    // 라벨은 건물 중심에서 바깥쪽으로 밀어낸다
    if (labelled.has(g)) {
      const dx = x - P.center[0], dy = y - P.center[1];
      const d = Math.hypot(dx, dy) || 1;
      const t = sv("text", { class: "m-num", "text-anchor": "middle",
        x: (x + dx / d * 15).toFixed(1), y: (y + dy / d * 15 + 3.5).toFixed(1) });
      t.textContent = g;
      node.append(t);
    }

    if (stop) {
      node.append(sv("rect", { x: (x - 15).toFixed(1), y: (y - 24).toFixed(1),
        width: 30, height: 16, rx: 4, class: "m-ambadge" }));
      const b = sv("text", { class: "m-amtag", "text-anchor": "middle",
        x: x.toFixed(1), y: (y - 12).toFixed(1) });
      b.textContent = stop;
      node.append(b);
    }

    const hit = () => {
      S.gateFilter = S.gateFilter === g ? null : g;
      S.zoneFilter = null;
      draw();
    };
    node.addEventListener("click", hit);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hit(); }
    });
    gg.append(node);
  }
  svg.append(gg);

  // 나침반 — 회전했으므로 북쪽을 반드시 표시한다
  const [nx, ny] = P.north;
  const cx = VB_W - 52, cy = 46, L = 21;
  const rose = sv("g", { class: "m-rose" });
  rose.append(sv("circle", { cx, cy, r: 25, class: "m-rose-bg" }));
  rose.append(sv("line", { x1: (cx - nx * L * 0.55).toFixed(1), y1: (cy - ny * L * 0.55).toFixed(1),
    x2: (cx + nx * L).toFixed(1), y2: (cy + ny * L).toFixed(1), "marker-end": "url(#n-arrow)" }));
  const nl = sv("text", { class: "m-rose-n", "text-anchor": "middle",
    x: (cx + nx * (L + 11)).toFixed(1), y: (cy + ny * (L + 11) + 3.5).toFixed(1) });
  nl.textContent = "N";
  rose.append(nl);
  svg.append(rose);
  host.append(svg);

  // 좌표가 없는 게이트는 지어내지 않는다. 그날 실제로 편이 있는 번호만 알린다.
  const [lo, hi] = S.zones.terminals[term].gateRange;
  const missing = [...byGate.keys()]
    .filter((g) => +g >= lo && +g <= hi && !S.geo.gates[g])
    .sort((a, b) => +a - +b);

  const cap = $("#map-cap");
  cap.replaceChildren();
  const used = gates.filter((x) => byGate.get(x.g)).length;
  cap.append(el("span", null,
    `점 크기는 편수에 비례합니다. 편수 0인 게이트는 흐리게 표시했습니다 (이날 운항 ${used}/${gates.length}개).`));
  cap.append(el("span", "m-warn",
    `도형을 가로로 회전해 표시했습니다. 실제 방위는 나침반 표시를 참고하세요 (북쪽 기준 ${P.deg}° 회전).`));
  if (missing.length) {
    cap.append(el("span", "m-warn", `위치 정보 없음: ${missing.join(", ")}`));
  }
  cap.append(el("span", "m-src", "건물 윤곽·게이트 위치: © OpenStreetMap contributors (ODbL)"));
}

/* ── 렌더: 게이트 배치 ───────────────────────────────── */

function renderSpine(rows) {
  const host = $("#spine");
  host.replaceChildren();

  const term = $("#sel-term").value;
  const terms = term === "ALL" ? Object.keys(S.zones.terminals) : [term];

  const byGate = new Map();
  for (const f of rows) byGate.set(f.gate, (byGate.get(f.gate) || 0) + 1);
  const peak = Math.max(1, ...byGate.values());

  for (const tk of terms) {
    const t = S.zones.terminals[tk];
    const pier = el("div", "pier");
    const head = el("div", "pier-head");
    head.append(el("b", null, t.label));
    const n = rows.filter((f) => (f.terminal || termOfGate(f.gate)) === tk).length;
    head.append(el("span", null, `${n}편 · 게이트 ${t.gateRange[0]}~${t.gateRange[1]}`));
    pier.append(head);

    const bands = el("div", "bands");
    for (const z of t.zones) {
      const b = el("button", "band");
      b.type = "button";
      b.setAttribute("aria-pressed", String(S.zoneFilter === z.id));
      if (z.am) b.dataset.am = "1";
      const bars = el("div", "band-bars");
      for (let g = z.from; g <= z.to; g++) {
        const c = byGate.get(String(g)) || 0;
        const tick = el("button", "tick" + (z.am ? " am" : ""));
        tick.type = "button";
        tick.dataset.has = c ? "1" : "0";
        tick.style.height = `${Math.max(3, Math.round((c / peak) * 100))}%`;
        tick.title = `${g}번 · ${c}편`;
        tick.setAttribute("aria-label", `${g}번 게이트 ${c}편`);
        tick.onclick = (e) => {
          e.stopPropagation();
          S.gateFilter = S.gateFilter === String(g) ? null : String(g);
          S.zoneFilter = null;
          draw();
        };
        bars.append(tick);
      }
      b.append(bars, el("div", "band-label", z.label));
      b.onclick = () => {
        S.zoneFilter = S.zoneFilter === z.id ? null : z.id;
        S.gateFilter = null;
        draw();
      };
      bands.append(b);
    }
    pier.append(bands);
    host.append(pier);
  }

  const note = $("#filter-note");
  if (S.zoneFilter || S.gateFilter) {
    note.replaceChildren();
    let label = "";
    if (S.gateFilter) label = `${S.gateFilter}번 게이트만 보는 중`;
    else {
      for (const t of Object.values(S.zones.terminals)) {
        const z = t.zones.find((x) => x.id === S.zoneFilter);
        if (z) label = `${t.label} ${z.label}만 보는 중`;
      }
    }
    note.append(el("span", null, label));
    const b = el("button", "ghost", "전체 보기");
    b.type = "button";
    b.onclick = () => { S.zoneFilter = null; S.gateFilter = null; draw(); };
    note.append(b);
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

/* ── AM 운영시간 커버리지 ─────────────────────────────
   AM은 출국여객 전용이다(안내문: 이용대상 모든 출국여객). 따라서 화면의
   출발/도착 선택과 무관하게 항상 출발편만 센다. 운영시간·정원·휴무일·
   AM 게이트 구간은 전부 data/zones.json 에서 읽는다.                    */

const hhmm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

// zones.json 의 closedWeekdays 는 월=0 기준이다. Date.getDay() 는 일=0 이므로 맞춰준다.
const monIndex = (d) => (d.getDay() + 6) % 7;

function amGateRanges() {
  return (S.zones.terminals.T2.zones || []).filter((z) => z.am);
}

function inAmZone(gate) {
  const g = parseInt(gate, 10);
  return amGateRanges().some((z) => g >= z.from && g <= z.to);
}

function renderAM() {
  const wrap = $("#am-wrap");
  if ($("#sel-term").value !== "T2") { wrap.hidden = true; return; }
  wrap.hidden = false;

  const am = S.zones.am;
  const host = $("#am-body");
  host.replaceChildren();

  const day = $("#sel-date").value;
  const dow = monIndex(new Date(day + "T00:00:00"));
  const ranges = amGateRanges().map((z) => `${z.from}~${z.to}`).join(", ");
  $("#am-hint").textContent =
    `출발편 기준 · 코드쉐어 제외 · AM 구간 ${ranges} · ${am.days} · ` +
    am.hours.map((h) => `${h.from}~${h.to}`).join(", ");

  // 휴무일 안내는 집계 가능 여부와 별개로 먼저 보여준다
  if ((am.closedWeekdays || []).includes(dow)) {
    host.append(el("div", "am-closed", "이 날은 AM 정기 휴무일입니다"));
  }

  // 화면 필터와 무관하게 그날 T2 출발편 전체로 계산한다
  const deps = S.flights.filter(
    (f) => f.dir === "D" && f.codeshare === "Master" &&
           (f.terminal || termOfGate(f.gate)) === "T2");
  const withGate = deps.filter((f) => /^\d+$/.test(String(f.gate).trim()));
  const rate = deps.length ? withGate.length / deps.length : 0;

  if (rate < 0.8) {
    host.append(el("div", "am-na", "게이트 배정이 확정되지 않아 집계할 수 없습니다"));
    return;
  }

  const zoneDeps = withGate.filter((f) => inAmZone(f.gate));
  const mins = (f) => {
    const t = String(f.time || "").padStart(4, "0");
    return +t.slice(0, 2) * 60 + +t.slice(2);
  };
  const open = (m) => am.hours.some((h) => m >= hhmm(h.from) && m < hhmm(h.to));
  const inside = zoneDeps.filter((f) => open(mins(f)));
  const outside = zoneDeps.length - inside.length;

  const pct = (n, d) => (d ? `${(n / d * 100).toFixed(1)}%` : "—");
  const sum = el("div", "am-sum");
  const row = (k, n, note) => {
    const r = el("div", "am-row");
    r.append(el("span", "am-k", k));
    r.append(el("b", "am-v", `${n.toLocaleString()}편`));
    r.append(el("span", "am-p", note));
    sum.append(r);
  };
  row("AM 구간 출발편", zoneDeps.length, `T2 출발편 ${withGate.length.toLocaleString()}편의 ${pct(zoneDeps.length, withGate.length)}`);
  row("운영시간 내", inside.length, `AM 구간의 ${pct(inside.length, zoneDeps.length)}`);
  row("운영시간 밖", outside, `AM 구간의 ${pct(outside, zoneDeps.length)}`);
  host.append(sum);

  // 시간대 분포. 막대를 편 단위로 쪼개 쌓으므로, 빨간 부분의 총합이
  // 위 "운영시간 내" 편수와 정확히 일치한다.
  const byHour = Array.from({ length: 24 }, () => ({ in: 0, out: 0, total: 0 }));
  for (const f of zoneDeps) {
    const b = byHour[Math.floor(mins(f) / 60)];
    if (open(mins(f))) b.in++; else b.out++;
    b.total++;
  }
  const peak = Math.max(1, ...byHour.map((b) => b.total));
  const covered = (h) => am.hours.some((w) => hhmm(w.from) < (h + 1) * 60 && hhmm(w.to) > h * 60);

  const W = 960, x0 = 26, x1 = 934, top = 30, base = 168;
  const slot = (x1 - x0) / 24, bw = slot * 0.56;
  const svg = sv("svg", { viewBox: `0 0 ${W} 200`, preserveAspectRatio: "xMidYMid meet",
    role: "img", "aria-label": "시간대별 AM 구간 출발편 분포" });

  for (let h = 0; h < 24; h++) {
    const cx = x0 + slot * (h + 0.5);
    if (covered(h)) {
      svg.append(sv("rect", { x: (x0 + slot * h).toFixed(1), y: top - 10,
        width: slot.toFixed(1), height: base - top + 10, class: "am-shade" }));
    }
    const b = byHour[h];
    if (b.total) {
      const bh = Math.max(2, (b.total / peak) * (base - top));
      const inH = b.total ? bh * (b.in / b.total) : 0;
      const g = sv("g", { class: "am-col" });
      // 아래가 운영시간 내(--mark), 위가 운영시간 밖(--rule)
      if (b.out) {
        g.append(sv("rect", { x: (cx - bw / 2).toFixed(1), y: (base - bh).toFixed(1),
          width: bw.toFixed(1), height: (bh - inH).toFixed(1), class: "am-bar" }));
      }
      if (b.in) {
        g.append(sv("rect", { x: (cx - bw / 2).toFixed(1), y: (base - inH).toFixed(1),
          width: bw.toFixed(1), height: inH.toFixed(1), class: "am-bar on" }));
      }
      const n = sv("text", { x: cx.toFixed(1), y: (base - bh - 5).toFixed(1),
        class: "am-n", "text-anchor": "middle" });
      n.textContent = b.total;
      g.append(n);
      const ttl = sv("title");
      ttl.textContent = `${h}시 · 총 ${b.total}편 (운영시간 내 ${b.in}편)`;
      g.append(ttl);
      svg.append(g);
    }
    const lab = sv("text", { x: cx.toFixed(1), y: base + 17, class: "am-h", "text-anchor": "middle" });
    lab.textContent = String(h).padStart(2, "0");
    svg.append(lab);
  }
  svg.append(sv("line", { x1: x0, y1: base, x2: x1, y2: base, class: "am-axis" }));
  host.append(svg);

  const total = am.hours.reduce((s, h) => s + (hhmm(h.to) - hhmm(h.from)), 0);
  const dur = `${Math.floor(total / 60)}시간${total % 60 ? ` ${total % 60}분` : ""}`;
  host.append(el("p", "am-foot", `AM 1대 정원 ${am.capacity}명 · 운영시간 하루 ${dur}`));
}

/* ── 렌더: 구역 성격 ─────────────────────────────────── */

function renderZones(rows) {
  const host = $("#zones");
  host.replaceChildren();

  const term = $("#sel-term").value;
  const terms = term === "ALL" ? Object.keys(S.zones.terminals) : [term];
  const table = el("div", "ztable");
  let any = false;

  for (const tk of terms) {
    const t = S.zones.terminals[tk];
    for (const z of t.zones) {
      const sub = rows.filter((f) => {
        const ft = f.terminal || termOfGate(f.gate);
        if (ft !== tk) return false;
        const g = parseInt(f.gate, 10);
        return g >= z.from && g <= z.to;
      });
      if (!sub.length) continue;
      any = true;

      const row = el("div", "zrow");
      if (z.am) row.dataset.am = "1";
      row.append(el("div", "zrow-n", String(sub.length)));

      const body = el("div", "zrow-b");
      const title = el("div", "zrow-t");
      title.append(el("b", null, (terms.length > 1 ? t.label + " " : "") + z.label));
      if (z.am) title.append(el("em", null, "AM 운행 구간"));
      const km = sub.filter((f) => f.km).map((f) => f.km);
      if (km.length) {
        const avg = Math.round(km.reduce((a, b) => a + b, 0) / km.length);
        title.append(el("em", null, `평균 ${avg.toLocaleString()}km`));
      }
      body.append(title);

      const mix = el("div", "mix");
      for (const b of ["장거리", "중거리", "단거리", "국내"]) {
        const c = sub.filter((f) => f.band === b).length;
        if (!c) continue;
        const i = el("i");
        i.dataset.b = b;
        i.style.width = `${(c / sub.length) * 100}%`;
        i.title = `${b} ${c}편`;
        mix.append(i);
      }
      body.append(mix);

      const facts = el("div", "facts");
      const add = (k, pairs) => {
        if (!pairs.length) return;
        const s = el("span");
        s.append(document.createTextNode(k + " "));
        s.append(el("b", null, pairs.map(([v, c]) => `${v} ${c}`).join(", ")));
        facts.append(s);
      };
      add("항공사", top(sub.map((f) => f.airlineName), 3));
      add("국가", top(sub.map((f) => f.country), 3));
      add("권역", top(sub.map((f) => f.region), 3));
      add("유형", top(sub.map((f) => f.carrierType), 3));
      body.append(facts);

      row.append(body);
      table.append(row);
    }
  }

  host.append(any ? table : el("div", "empty", "해당 조건에 운항 편이 없습니다."));
}

/* ── 렌더: 게이트별 목록 ─────────────────────────────── */

function renderGates(rows) {
  const host = $("#gates");
  host.replaceChildren();

  if (!rows.length) {
    host.append(el("div", "empty", "해당 조건에 운항 편이 없습니다. 조건을 바꿔 보세요."));
    return;
  }

  const by = new Map();
  for (const f of rows) {
    if (!by.has(f.gate)) by.set(f.gate, []);
    by.get(f.gate).push(f);
  }
  const gates = [...by.keys()].sort((a, b) => +a - +b);
  const dir = $("#sel-dir").value;

  for (const g of gates) {
    const list = by.get(g).sort((a, b) => a.time.localeCompare(b.time));
    const tk = list[0].terminal || termOfGate(g);
    const z = zoneOf(tk, g);

    const card = el("div", "gate");
    if (z && z.am) card.dataset.am = "1";

    const head = el("div", "gate-n");
    head.append(el("b", null, g));
    head.append(el("small", null, `${list.length}편`));
    card.append(head);

    const body = el("div", "gate-body");
    for (const f of list) {
      const r = el("div", "fl");
      const t = f.time ? `${f.time.slice(0, 2)}:${f.time.slice(2)}` : "--:--";
      r.append(el("div", "fl-t", t));
      r.append(el("div", "fl-f", f.flight));

      const d = el("div", "fl-d");
      d.append(document.createTextNode(f.city || f.port || "-"));
      const meta = [f.airlineName, f.country].filter(Boolean).join(" · ");
      if (meta) d.append(el("small", null, meta));
      r.append(d);

      const tag = el("span", "tag", f.km ? `${f.band} ${f.km.toLocaleString()}km` : (f.band || "미분류"));
      if (f.band) tag.dataset.b = f.band;
      r.append(tag);

      r.title = `${dir === "D" ? "출발" : "도착"} ${t} ${f.flight} ${f.city}`;
      body.append(r);
    }
    card.append(body);
    host.append(card);
  }
}

/* ── 흐름 ───────────────────────────────────────────── */

/* 날짜는 전부 로컬 기준으로 다룬다. toISOString() 은 UTC라 한국(UTC+9)에서
   00:00~08:59 사이에 열면 하루 전 날짜가 나온다. */
const KO_DOW = "일월화수목금토";
const pad2 = (n) => String(n).padStart(2, "0");
function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`;
}
function dayOffset(d) {
  const n = new Date();
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((new Date(d + "T00:00:00") - today) / 86400000);
}
/* 게이트·터미널은 운항 1~2일 전에 확정된다. D+2 이후는 API가 잠정값을 준다.
   실측: D+2 이후는 게이트 배정률 0%대이고, T1 편의 약 13%가 탑승동으로 기록된다. */
const isTentative = (d) => dayOffset(d) >= 2;
const dowOf = (d) => KO_DOW[new Date(d + "T00:00:00").getDay()];

function renderDateNote() {
  const note = $("#date-note");
  const d = $("#sel-date").value;
  if (!d) { note.hidden = true; return; }
  if (isTentative(d)) {
    note.textContent = "게이트·터미널 정보가 확정되지 않은 날짜입니다.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

/* ── 조회 조건 ↔ URL ─────────────────────────────────
   조건을 쿼리스트링에 담아 링크로 공유할 수 있게 한다. 뒤로가기가 조건
   변경 하나하나를 되짚지 않도록 pushState 가 아니라 replaceState 를 쓴다.
   잘못된 값은 조용히 무시하고 기본값을 유지한다. */
const TERMS = ["ALL", "T1", "CONCOURSE", "T2"];

function applyQuery() {
  const q = new URLSearchParams(location.search);
  const d = q.get("d");
  if (d && S.days.includes(d)) $("#sel-date").value = d;
  const t = q.get("t");
  if (TERMS.includes(t)) $("#sel-term").value = t;
  const dir = q.get("dir");
  if (dir === "D" || dir === "A") $("#sel-dir").value = dir;
  const share = q.get("share");
  if (share === "master" || share === "all") $("#sel-share").value = share;
  if (q.get("q")) $("#q").value = q.get("q").slice(0, 60);

  const gate = q.get("gate"), zone = q.get("zone");
  if (gate && /^\d{1,3}$/.test(gate)) {
    S.gateFilter = String(parseInt(gate, 10));
  } else if (zone && Object.values(S.zones.terminals).some((t) => t.zones.some((z) => z.id === zone))) {
    S.zoneFilter = zone;
  }
}

function syncQuery() {
  const q = new URLSearchParams();
  q.set("d", $("#sel-date").value);
  q.set("t", $("#sel-term").value);
  q.set("dir", $("#sel-dir").value);
  if ($("#sel-share").value !== "master") q.set("share", $("#sel-share").value);
  const s = $("#q").value.trim();
  if (s) q.set("q", s);
  if (S.gateFilter) q.set("gate", S.gateFilter);
  else if (S.zoneFilter) q.set("zone", S.zoneFilter);
  const next = `${location.pathname}?${q}`;
  if (next !== location.pathname + location.search) history.replaceState(null, "", next);
}

function draw() {
  const rows = visible();
  renderDateNote();
  renderMap(rows);
  renderSpine(rows);
  renderAM();
  renderZones(rows);
  renderGates(rows);
  const d = $("#sel-date").value;
  $("#meta").textContent = `${d} 기준 ${rows.length}편 표시 · 저장된 날짜 ${S.days.length}일`;
  syncQuery();
}

async function loadDay(day) {
  const blob = await j(`data/flights/${day}.json`);
  S.flights = blob.flights.map(enrich);
}

/* 당일 운항 파일이 750KB 안팎이라 모바일에서는 몇 초가 걸린다.
   그동안 화면이 비어 있지 않도록 표시한다. */
function setBusy(on) {
  const n = $("#loading");
  if (n) n.hidden = !on;
  $("main").setAttribute("aria-busy", on ? "true" : "false");
}

async function boot() {
  setBusy(true);
  try {
    const [ap, al, zn, ge, idx] = await Promise.all([
      j("data/airports.json"), j("data/airlines.json"),
      j("data/zones.json"), j("data/geo.json"), j("data/index.json"),
    ]);
    S.airports = ap; S.airlines = al; S.zones = zn; S.geo = ge;
    S.days = idx.days.slice().sort().reverse();

    if (!S.days.length) {
      $("#gates").append(el("div", "empty", "저장된 운항 데이터가 없습니다. scripts/collect.py 를 먼저 실행하세요."));
      return;
    }

    // 확정된 날짜를 최신순으로 먼저, 미확정 날짜를 가까운 순으로 뒤에 둔다
    const sel = $("#sel-date");
    const firm = S.days.filter((d) => !isTentative(d)).sort().reverse();
    const soft = S.days.filter(isTentative).sort();
    for (const d of firm.concat(soft)) {
      sel.append(new Option(`${d} (${dowOf(d)})${isTentative(d) ? " · 미확정" : ""}`, d));
    }
    const today = localToday();
    sel.value = S.days.includes(today) ? today : firm[0] || S.days[0];
    applyQuery();   // 공유 링크의 조건이 있으면 기본값 위에 덮어쓴다

    await loadDay(sel.value);

    sel.onchange = async () => {
      S.zoneFilter = null; S.gateFilter = null;
      setBusy(true);
      try { await loadDay(sel.value); } finally { setBusy(false); }
      draw();
    };
    for (const id of ["#sel-term", "#sel-dir", "#sel-share"]) {
      $(id).onchange = () => { S.zoneFilter = null; S.gateFilter = null; draw(); };
    }
    let t;
    $("#q").oninput = () => { clearTimeout(t); t = setTimeout(draw, 180); };
    $("#reset").onclick = () => {
      S.zoneFilter = null; S.gateFilter = null;
      $("#q").value = "";
      $("#sel-term").value = "T2"; $("#sel-dir").value = "D"; $("#sel-share").value = "master";
      draw();
    };

    draw();
  } catch (e) {
    console.error(e);
    $("#gates").append(el("div", "empty", `데이터를 불러오지 못했습니다: ${e.message}`));
  } finally {
    setBusy(false);
  }
}

boot();
})();
