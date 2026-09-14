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
  airports: {}, airlines: {}, zones: null,
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

/* ── T2 평면도 ───────────────────────────────────────
   공항 공식 안내도(제2여객터미널 3F)의 역U자 배치를 옮긴 것이다.
   좌우 부두·부채꼴의 번호는 도면에 명시돼 있으나, 중앙 곡선(225~275)은
   도면에 주기장만 그려져 있어 개별 위치가 추정이다. 따라서 중앙 게이트는
   번호를 표시하지 않고 호버로만 노출한다.                             */

const SVGNS = "http://www.w3.org/2000/svg";
const sv = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const AM_STOPS = { 276: "E1", 280: "E2", 224: "W1", 219: "W2" };
const PX = { e: 200, w: 800 };            // 좌우 부두 x
const FAN = { ex: 110, wx: 890, cy: 448, r: 95 };

function buildT2Geo() {
  const p = [];
  // 중앙 곡선: 왼쪽 275 → 오른쪽 225 (번호 내림차순). 2차 베지에.
  for (let i = 0; i <= 50; i++) {
    const t = i / 50, m = 1 - t;
    p.push({
      g: 275 - i, grp: "c", show: false,
      x: m * m * PX.e + 2 * m * t * 500 + t * t * PX.w,
      y: m * m * 128 + 2 * m * t * 28 + t * t * 128,
    });
  }
  // 동편 수직 부두 276~282 (위→아래)
  for (let i = 0; i < 7; i++) p.push({ g: 276 + i, grp: "ep", show: true, x: PX.e, y: 172 + i * 45 });
  // 동편 부채꼴 283~291
  for (let i = 0; i < 9; i++) {
    const a = (i * 120 / 8) * Math.PI / 180;
    p.push({ g: 283 + i, grp: "ef", show: true, a,
      x: FAN.ex + FAN.r * Math.cos(a), y: FAN.cy + FAN.r * Math.sin(a) });
  }
  // 서편 수직 부두 224~216 (위→아래)
  for (let i = 0; i < 9; i++) p.push({ g: 224 - i, grp: "wp", show: true, x: PX.w, y: 172 + i * 34 });
  // 서편 부채꼴 215~208
  for (let i = 0; i < 8; i++) {
    const a = (i * 120 / 7) * Math.PI / 180;
    p.push({ g: 215 - i, grp: "wf", show: true, a,
      x: FAN.wx - FAN.r * Math.cos(a), y: FAN.cy + FAN.r * Math.sin(a) });
  }
  return p;
}

const T2_GEO = buildT2Geo();

function renderMap(rows) {
  const wrap = $("#map-wrap");
  const isT2 = $("#sel-term").value === "T2";
  $("#spine-hint").textContent = isT2
    ? "평면도의 점 크기와 막대 높이는 모두 게이트별 편수입니다. 게이트나 구역을 누르면 아래 목록이 좁혀집니다."
    : "막대 높이는 게이트별 편수입니다. 구역이나 게이트를 누르면 아래 목록이 좁혀집니다.";
  if (!isT2) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const host = $("#map");
  host.replaceChildren();

  const byGate = new Map();
  for (const f of rows) byGate.set(String(parseInt(f.gate, 10)), (byGate.get(String(parseInt(f.gate, 10))) || 0) + 1);
  const peak = Math.max(1, ...byGate.values());

  const svg = sv("svg", {
    viewBox: "0 0 1000 600",
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": "제2여객터미널 게이트 배치도",
  });

  const defs = sv("defs");
  const mk = sv("marker", { id: "am-arrow", viewBox: "0 0 10 10", refX: "8", refY: "5",
    markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
  mk.append(sv("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--mark)" }));
  defs.append(mk);
  svg.append(defs);

  // 안내선: 중앙 곡선 + 부두 + 부채꼴
  const guide = sv("g", { class: "m-guide" });
  guide.append(sv("path", { d: `M${PX.e},128 Q500,28 ${PX.w},128` }));
  guide.append(sv("path", { d: `M${PX.e},128 L${PX.e},442` }));
  guide.append(sv("path", { d: `M${PX.w},128 L${PX.w},444` }));
  const arc = (cx, cy, r, a0, a1, sweep) => {
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
    const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    return `M${p0[0].toFixed(1)},${p0[1].toFixed(1)} A${r},${r} 0 0 ${sweep} ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
  };
  guide.append(sv("path", { d: arc(FAN.ex, FAN.cy, FAN.r, 0, 120 * Math.PI / 180, 1) }));
  guide.append(sv("path", { d: arc(FAN.wx, FAN.cy, FAN.r, Math.PI, 60 * Math.PI / 180, 0) }));
  svg.append(guide);

  // AM 운행 구간 (E1↔E2, W1↔W2)
  const am = sv("g", { class: "m-am" });
  // 게이트 번호 라벨 바깥쪽으로 빼서 겹치지 않게 한다
  am.append(sv("line", { x1: 145, y1: 172, x2: 145, y2: 352,
    "marker-start": "url(#am-arrow)", "marker-end": "url(#am-arrow)" }));
  am.append(sv("line", { x1: 855, y1: 172, x2: 855, y2: 342,
    "marker-start": "url(#am-arrow)", "marker-end": "url(#am-arrow)" }));
  const amLab = (x, y, t, anchor) => {
    const n = sv("text", { x, y, class: "m-amlab", "text-anchor": anchor });
    n.textContent = t;
    return n;
  };
  am.append(amLab(137, 267, "AM", "end"));
  am.append(amLab(863, 262, "AM", "start"));
  svg.append(am);

  // 게이트 점
  const gg = sv("g", { class: "m-gates" });
  for (const p of T2_GEO) {
    const key = String(p.g);
    const c = byGate.get(key) || 0;
    const on = S.gateFilter === key;
    // 중앙 곡선은 51개가 좁은 호에 몰려 있다. 반경이 크면 덩어리로 뭉쳐 보이므로
    // 선형 스케일로 작게 잡고, 편수 차이는 채도로도 함께 표현한다.
    const r = c ? 2.8 + 4.2 * (c / peak) : 2.2;

    const node = sv("g", { class: "m-g", tabindex: "0", role: "button",
      "data-has": c ? "1" : "0", "data-am": AM_STOPS[p.g] ? "1" : "0",
      "data-on": on ? "1" : "0",
      "aria-label": `${p.g}번 게이트 ${c}편${AM_STOPS[p.g] ? ` · AM ${AM_STOPS[p.g]}` : ""}` });

    node.append(sv("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 11, class: "m-hit" }));
    const dot = sv("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: r.toFixed(1), class: "m-dot" });
    // 인라인 opacity로 주면 hover·선택 상태 규칙을 이기므로 변수로 넘긴다
    if (c) dot.style.setProperty("--o", (0.4 + 0.55 * (c / peak)).toFixed(2));
    node.append(dot);

    const ttl = sv("title");
    ttl.textContent = `${p.g}번 · ${c}편${AM_STOPS[p.g] ? ` · AM ${AM_STOPS[p.g]} 승하차` : ""}`;
    node.append(ttl);

    // 도면에 번호가 명시된 구역만 라벨을 단다. 중앙 곡선은 호버로만.
    if (p.show) {
      let lx = p.x, ly = p.y, anchor = "middle";
      if (p.grp === "ep") { lx = p.x - 17; ly = p.y + 4; anchor = "end"; }
      else if (p.grp === "wp") { lx = p.x + 17; ly = p.y + 4; anchor = "start"; }
      else if (p.grp === "ef") { lx = FAN.ex + (FAN.r + 21) * Math.cos(p.a); ly = FAN.cy + (FAN.r + 21) * Math.sin(p.a) + 4; }
      else if (p.grp === "wf") { lx = FAN.wx - (FAN.r + 21) * Math.cos(p.a); ly = FAN.cy + (FAN.r + 21) * Math.sin(p.a) + 4; }
      const t = sv("text", { x: lx.toFixed(1), y: ly.toFixed(1), class: "m-num", "text-anchor": anchor });
      t.textContent = p.g;
      node.append(t);
    }
    if (AM_STOPS[p.g]) {
      const t = sv("text", { class: "m-amtag", "text-anchor": p.grp === "ep" ? "start" : "end",
        x: (p.grp === "ep" ? p.x + 15 : p.x - 15).toFixed(1), y: (p.y - 9).toFixed(1) });
      t.textContent = AM_STOPS[p.g];
      node.append(t);
    }

    const hit = () => {
      S.gateFilter = S.gateFilter === key ? null : key;
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

  // 중앙 곡선 캡션 — 개별 위치가 추정임을 도면 안에 명시한다
  const cap = sv("text", { x: 500, y: 168, class: "m-cap", "text-anchor": "middle" });
  cap.textContent = "중앙 (225~275) — 개별 위치는 추정";
  svg.append(cap);

  host.append(svg);

  const used = T2_GEO.filter((p) => byGate.get(String(p.g))).length;
  $("#map-cap").textContent =
    `점 크기는 편수에 비례합니다. 편수 0인 게이트는 흐리게 표시했습니다 (이날 운항 ${used}/${T2_GEO.length}개). ` +
    `좌우 부두와 부채꼴 번호는 공항 공식 안내도를 따랐고, 중앙 곡선의 개별 게이트 위치는 번호 순서에 따른 추정입니다. ` +
    `빨간 표시는 AM 승하차지점과 운행 구간입니다.`;
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

/* 게이트·터미널은 운항 1~2일 전에 확정된다. 그 전 날짜는 API가 잠정값을 준다.
   실측: D+2 이후는 게이트 배정률 0%대이고, T1 편의 약 13%가 탑승동으로 기록된다. */
function renderDateNote() {
  const note = $("#date-note");
  const d = $("#sel-date").value;
  if (!d) { note.hidden = true; return; }
  const sel = new Date(d + "T00:00:00");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((sel - today) / 86400000);
  if (diff >= 2) {
    note.textContent = "게이트·터미널 정보가 확정되지 않은 날짜입니다.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function draw() {
  const rows = visible();
  renderDateNote();
  renderMap(rows);
  renderSpine(rows);
  renderZones(rows);
  renderGates(rows);
  const d = $("#sel-date").value;
  $("#meta").textContent = `${d} 기준 ${rows.length}편 표시 · 저장된 날짜 ${S.days.length}일`;
}

async function loadDay(day) {
  const blob = await j(`data/flights/${day}.json`);
  S.flights = blob.flights.map(enrich);
}

async function boot() {
  try {
    const [ap, al, zn, idx] = await Promise.all([
      j("data/airports.json"), j("data/airlines.json"),
      j("data/zones.json"), j("data/index.json"),
    ]);
    S.airports = ap; S.airlines = al; S.zones = zn;
    S.days = idx.days.slice().sort().reverse();

    if (!S.days.length) {
      $("#gates").append(el("div", "empty", "저장된 운항 데이터가 없습니다. scripts/collect.py 를 먼저 실행하세요."));
      return;
    }

    const sel = $("#sel-date");
    for (const d of S.days) sel.append(new Option(d, d));
    const today = new Date().toISOString().slice(0, 10);
    sel.value = S.days.includes(today) ? today : S.days[0];

    await loadDay(sel.value);

    sel.onchange = async () => {
      S.zoneFilter = null; S.gateFilter = null;
      await loadDay(sel.value);
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
  }
}

boot();
})();
