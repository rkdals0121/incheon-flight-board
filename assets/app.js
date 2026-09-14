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

function draw() {
  const rows = visible();
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
