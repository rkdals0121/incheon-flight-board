#!/usr/bin/env python3
"""
인천공항 출도착 수집기

공공데이터포털 '인천국제공항공사_여객기 운항 현황 상세 조회 서비스'에서
출발/도착 편을 받아 data/flights/YYYY-MM-DD.json 으로 저장한다.

사용법:
    export ICN_API_KEY="발급받은 디코딩 키"
    python scripts/collect.py --probe              # 응답 구조만 확인 (저장 안 함)
    python scripts/collect.py                      # 오늘~+3일 수집
    python scripts/collect.py --seed p1.json       # airport.kr 백업 형식 변환

파라미터 이름 주의:
    포털 활용가이드 docx에만 정확한 파라미터명이 있다.
    아래 PARAMS 딕셔너리 한 곳만 고치면 전체가 따라간다.
    --probe 로 먼저 응답을 확인할 것.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "flights"

# 하루치로 보기엔 너무 적은 날짜는 수집 창 경계의 자투리다. 저장하지 않는다.
MIN_ROWS_PER_DAY = 100

BASE = "https://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp"
ENDPOINTS = {
    "D": "/getPassengerDeparturesDeOdp",
    "A": "/getPassengerArrivalsDeOdp",
}

# ── 여기만 고치면 됨 ──────────────────────────────────────────────
PARAMS = {
    "key": "serviceKey",
    "rows": "numOfRows",
    "page": "pageNo",
    "begin": "search_begin_dt",   # YYYYMMDD
    "end": "search_end_dt",       # YYYYMMDD
    "type": "type",               # 응답 포맷
    "lang": "lang",               # K=한국어
}
PARAM_FIXED = {"type": "json", "lang": "K"}
# ─────────────────────────────────────────────────────────────────

# API 응답 필드 → 우리 스키마. 키가 없으면 순서대로 다음 후보를 찾는다.
FIELD_MAP = {
    "flight": ["flightId", "flightid", "airFln", "fnumber"],
    "master": ["masterFlightId", "masterflight", "masterFln"],
    "codeshare": ["codeshare", "codeShare"],
    "airline": ["airline", "airlineKorean", "airlineNameKo"],
    "gate": ["gatenumber", "gateNumber", "gate"],
    "terminal": ["terminalid", "terminalId", "terminal"],
    "scheduled": ["scheduleDateTime", "scheduledDateTime", "std", "sta"],
    "estimated": ["estimatedDateTime", "etd", "eta"],
    "airportCode": ["airportCode", "airport", "p1code", "cityCode"],
    "airportName": ["airport", "airportKorean", "airportName1"],
    "status": ["remark", "stattxt", "status"],
    "typeOfFlight": ["typeOfFlight", "flightType"],
    "carousel": ["carousel"],
    "exitnumber": ["exitnumber", "exitNumber"],
}

TERMINAL_CODE = {  # API 터미널 코드 → 우리 키
    "P01": "T1", "P1": "T1", "T1": "T1",
    "P02": "CONCOURSE", "P2": "CONCOURSE", "탑승동": "CONCOURSE",
    "P03": "T2", "P3": "T2", "T2": "T2",
}


def pick(row, key):
    for cand in FIELD_MAP[key]:
        v = row.get(cand)
        if v not in (None, ""):
            return str(v).strip()
    return ""


def fetch(kind, day, key, page=1, rows=1000, timeout=90, tries=4):
    q = {
        PARAMS["key"]: key,
        PARAMS["rows"]: rows,
        PARAMS["page"]: page,
        PARAMS["begin"]: day,
        PARAMS["end"]: day,
    }
    for k, v in PARAM_FIXED.items():
        q[PARAMS[k]] = v
    url = BASE + ENDPOINTS[kind] + "?" + urllib.parse.urlencode(q, safe="%")
    req = urllib.request.Request(url, headers={"User-Agent": "icn-board/1.0"})
    last = None
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return url, r.read().decode("utf-8", "replace")
        except Exception as e:
            last = e
            print(f"    연결 실패 {attempt}/{tries}: {e}", file=sys.stderr)
            if attempt < tries:
                time.sleep(5 * attempt)
    raise last


def parse(raw):
    """포털 표준 응답에서 items 배열을 꺼낸다."""
    data = json.loads(raw)
    body = data.get("response", {}).get("body", data.get("body", data))
    items = body.get("items", [])
    if isinstance(items, dict):
        items = items.get("item", [])
    if isinstance(items, dict):
        items = [items]
    return items, body


def normalize(row, kind):
    gate = pick(row, "gate")
    term_raw = pick(row, "terminal")
    sched = pick(row, "scheduled")
    return {
        "dir": kind,                                   # D=출발, A=도착
        "flight": pick(row, "flight"),
        "master": pick(row, "master"),
        "codeshare": pick(row, "codeshare"),
        "carrier": pick(row, "flight")[:2].upper(),
        "airline": pick(row, "airline"),
        "gate": gate if gate.isdigit() else "",
        "terminal": TERMINAL_CODE.get(term_raw.upper(), term_raw),
        "sched": sched,                                # YYYYMMDDHHmm
        "time": sched[8:12] if len(sched) >= 12 else "",
        "est": pick(row, "estimated"),
        "port": pick(row, "airportCode").upper(),
        "portName": pick(row, "airportName"),
        "status": pick(row, "status"),
        "intl": pick(row, "typeOfFlight") or "",
        "carousel": pick(row, "carousel"),
        "exit": pick(row, "exitnumber"),
    }


def collect_window(key, verbose=True):
    """API가 D-3~D+6 전체를 한 번에 주므로 한 번만 받아 날짜별로 나눈다."""
    rows = []
    anchor = date.today().strftime("%Y%m%d")
    for kind in ("D", "A"):
        page = 1
        while page <= 60:
            url, raw = fetch(kind, anchor, key, page=page)
            try:
                items, body = parse(raw)
            except json.JSONDecodeError:
                print(f"  [!] JSON 아님 ({kind} p{page}). 응답 앞부분:", file=sys.stderr)
                print("  " + raw[:400].replace("\n", " "), file=sys.stderr)
                return None
            if not items:
                break
            rows += [normalize(r, kind) for r in items]
            if verbose:
                print(f"  {kind} p{page}: {len(items)}건 (누적 {len(rows)})")
            if len(items) < 1000:
                break
            page += 1
            time.sleep(0.4)

    buckets = {}
    for r in rows:
        day = r["sched"][:8]
        if len(day) == 8 and day.isdigit():
            buckets.setdefault(day, []).append(r)

    # 수집 창 경계에 자정을 넘겨 걸친 편들이 자투리 날짜를 만든다. 저장하지 않는다.
    for day in sorted(buckets):
        if len(buckets[day]) < MIN_ROWS_PER_DAY:
            dropped = buckets.pop(day)
            if verbose:
                print(f"  [-] {day} 제외: {len(dropped)}건 (기준 {MIN_ROWS_PER_DAY}건 미만)")
    return buckets


def save(day, rows):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{day[:4]}-{day[4:6]}-{day[6:8]}.json"
    payload = {
        "date": f"{day[:4]}-{day[4:6]}-{day[6:8]}",
        "collectedAt": datetime.now().isoformat(timespec="seconds"),
        "count": len(rows),
        "flights": rows,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def update_index():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    days = sorted(p.stem for p in OUT_DIR.glob("*.json") if p.stem != "index")
    (ROOT / "data" / "index.json").write_text(
        json.dumps({"days": days, "updatedAt": datetime.now().isoformat(timespec="seconds")},
                   ensure_ascii=False, indent=2),
        encoding="utf-8")
    return days


def seed_from_airportkr(paths):
    """airport.kr 내부 조회 결과(JSON)를 같은 스키마로 변환. API 승인 전 화면 확인용."""
    buckets = {}
    for p in paths:
        blob = json.loads(Path(p).read_text(encoding="utf-8"))
        for r in blob.get("scheduleList", []):
            sched = r.get("atime") or ""
            day = sched[:8] or r.get("sdate", "")
            if not day:
                continue
            buckets.setdefault(day, []).append({
                "dir": "D" if r.get("arrivalOrDeparture") == "D" else "A",
                "flight": r.get("fnumber", ""),
                "master": r.get("masterflight", ""),
                "codeshare": r.get("codeshare", ""),
                "carrier": (r.get("flightCarrier") or r.get("fnumber", "")[:2]).upper(),
                "airline": r.get("airlineNameKo", ""),
                "gate": r.get("gatenumber", "") if str(r.get("gatenumber", "")).isdigit() else "",
                "terminal": TERMINAL_CODE.get((r.get("terminalId") or "").upper(), r.get("terminal", "")),
                "sched": sched,
                "time": (r.get("stime") or "").replace(":", ""),
                "est": "",
                "port": (r.get("p1code") or "").upper(),
                "portName": r.get("airportName1", ""),
                "status": r.get("stattxt", ""),
                "intl": r.get("typeOfFlight", ""),
                "carousel": "",
                "exit": "",
            })
    for day, rows in buckets.items():
        print("seed", save(day, rows), len(rows))
    update_index()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="응답 구조만 출력")
    ap.add_argument("--seed", nargs="*", help="airport.kr 백업 JSON 변환")
    args = ap.parse_args()

    if args.seed:
        seed_from_airportkr(args.seed)
        return

    key = os.environ.get("ICN_API_KEY", "").strip()
    if not key:
        sys.exit("ICN_API_KEY 환경변수가 없다. 포털에서 받은 '디코딩' 키를 넣을 것.")

    if args.probe:
        today = date.today().strftime("%Y%m%d")
        for kind in ("D", "A"):
            url, raw = fetch(kind, today, key, rows=3)
            print(f"\n=== {kind} ===\n{url.split('serviceKey=')[0]}serviceKey=***")
            print(raw[:2000])
        return

    buckets = collect_window(key)
    if buckets is None:
        sys.exit("수집 실패. PARAMS 확인 필요.")
    if not buckets:
        sys.exit("수집 결과가 비어 있다.")

    for day in sorted(buckets):
        print(f"  → {save(day, buckets[day])} ({len(buckets[day])}건)")
    print("index:", update_index())


if __name__ == "__main__":
    main()
