#!/usr/bin/env node
/*
 * 편명별 최근 게이트 기록 요약
 *
 * data/flights/*.json 을 읽어 편명마다 최근에 실제로 쓴 게이트를 모아
 * data/gate_history.json 으로 저장한다. 화면에서 게이트가 아직 배정되지 않은
 * 편에 "최근 게이트" 로 보여주기 위한 것이다. 추정값을 만들지 않고, 실제
 * 배정된 기록만 담는다.
 *
 * 매번 지난 날짜 파일을 전부 받으면 모바일에서 너무 무거워(13일치 약 10MB)
 * 수집 뒤에 미리 만들어 둔다.
 *
 * 사용법:  node scripts/build_gate_history.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLIGHTS = join(ROOT, "data", "flights");
const OUT = join(ROOT, "data", "gate_history.json");

const LOOKBACK_DAYS = 14;   // 최근 14일 파일
const KEEP = 10;            // 편명당 최근 기록 최대 10건

const files = readdirSync(FLIGHTS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const recent = files.slice(-LOOKBACK_DAYS - 7); // 미래 날짜(게이트 없음)가 섞여 있어 여유를 둔다

const hist = new Map();
for (const file of recent) {
  const day = file.slice(2, 10).replace(/-/g, ""); // YYMMDD
  const { flights } = JSON.parse(readFileSync(join(FLIGHTS, file), "utf8"));
  for (const f of flights) {
    if (f.codeshare !== "Master" || !f.gate) continue;
    // 같은 편인데 날짜에 따라 편명 끝에 영문 한 글자가 붙기도 한다(KE647Y / KE647). 떼어서 묶는다.
    const key = `${f.dir}|${f.flight.replace(/(\d)[A-Z]$/, "$1")}`;
    if (!hist.has(key)) hist.set(key, []);
    hist.get(key).push([day, String(f.gate)]);
  }
}

const out = {};
let entries = 0;
for (const [key, rows] of [...hist.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  // 같은 날 같은 편이 두 번 나오면(드묾) 마지막 것만
  const byDay = new Map(rows.map((r) => [r[0], r[1]]));
  const kept = [...byDay.entries()].slice(-KEEP);
  out[key] = kept.map(([d, g]) => `${d}:${g}`).join(",");
  entries += kept.length;
}

const doc = {
  updatedAt: new Date().toISOString().slice(0, 19) + "Z",
  note: "편명별 최근 실제 배정 게이트. 값은 'YYMMDD:게이트' 를 쉼표로 이은 문자열.",
  flights: out,
};
writeFileSync(OUT, JSON.stringify(doc));
console.log(`편명 ${Object.keys(out).length}개, 기록 ${entries}건, ${(JSON.stringify(doc).length / 1024).toFixed(0)}KB → ${OUT}`);
