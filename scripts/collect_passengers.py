#!/usr/bin/env python3
"""
인천공항 승객예고 수집기

공공데이터포털 '인천국제공항공사_승객예고-출·입국장별'에서 시간대별 예상
승객 수를 받아 data/passengers/YYYY-MM-DD.json 으로 저장한다.

API는 당일(D+0)과 익일(D+1)만 준다. 과거 날짜는 소급해 받을 수 없으므로
매일 돌려서 쌓아야 한다.

사용법:
    export ICN_API_KEY="발급받은 디코딩 키"     # collect.py 와 같은 계정 키
    python scripts/collect_passengers.py --probe   # 응답 구조만 확인 (저장 안 함)
    python scripts/collect_passengers.py           # D+0, D+1 저장

저장 방식:
    응답 필드의 의미를 추측해 가공하지 않는다. item 배열을 원본 그대로
    저장하고, 같은 날짜를 전날(D+1)과 당일(D+0)에 각각 받은 것을 모두
    남긴다. 예고값은 시점마다 달라지므로 덮어쓰면 비교할 수 없게 된다.

파라미터 이름 주의:
    포털 페이지에 명세가 노출되지 않아 활용가이드 docx 기준으로 확인이
    필요하다. 아래 설정 블록 한 곳만 고치면 된다. --probe 로 먼저 확인할 것.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "passengers"
KST = ZoneInfo("Asia/Seoul")   # 러너는 UTC다. 날짜를 KST로 명시해야 하루 밀리지 않는다.

# ── 여기만 고치면 됨 ──────────────────────────────────────────────
BASE = "https://apis.data.go.kr/B551177/PassengerNoticeKR"
ENDPOINT = "/getfPassengerNoticeIKR"
PARAMS = {
    "key": "serviceKey",
    "date": "selectdate",   # 0=당일, 1=익일
    "type": "type",
}
PARAM_FIXED = {"type": "json"}
OFFSETS = {"D0": "0", "D1": "1"}
# ─────────────────────────────────────────────────────────────────


def fetch(offset_value, key, timeout=90, tries=4):
    q = {PARAMS["key"]: key, PARAMS["date"]: offset_value}
    for k, v in PARAM_FIXED.items():
        q[PARAMS[k]] = v
    url = BASE + ENDPOINT + "?" + urllib.parse.urlencode(q, safe="%")
    req = urllib.request.Request(url, headers={"User-Agent": "icn-board/1.0"})
    last = None
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return url, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            # 4xx 는 요청이 틀린 것이라 재시도해도 같다. 본문에 사유가 담겨 오므로 돌려준다.
            if 400 <= e.code < 500:
                body = e.read().decode("utf-8", "replace")
                print(f"  [!] HTTP {e.code} 응답 본문: {body[:800]}", file=sys.stderr)
                return url, body
            last = e
            print(f"    연결 실패 {attempt}/{tries}: {e}", file=sys.stderr)
            if attempt < tries:
                time.sleep(5 * attempt)
        except Exception as e:
            last = e
            print(f"    연결 실패 {attempt}/{tries}: {e}", file=sys.stderr)
            if attempt < tries:
                time.sleep(5 * attempt)
    raise last


def masked(url):
    return url.split(PARAMS["key"] + "=")[0] + PARAMS["key"] + "=***"


def parse(raw):
    """포털 표준 응답에서 header 와 items 배열을 꺼낸다."""
    data = json.loads(raw)
    resp = data.get("response", data)
    header = resp.get("header", {})
    body = resp.get("body", resp)
    items = body.get("items", [])
    if isinstance(items, dict):
        items = items.get("item", [])
    if isinstance(items, dict):
        items = [items]
    return header, items


def day_of(items, offset_label):
    """파일 날짜. 응답에 8자리 날짜 필드가 있으면 그것을, 없으면 KST 기준으로 계산."""
    for cand in ("adate", "date", "searchDate"):
        v = str(items[0].get(cand, "")) if items else ""
        if len(v) == 8 and v.isdigit():
            return f"{v[:4]}-{v[4:6]}-{v[6:]}"
    base = datetime.now(KST).date() + timedelta(days=int(OFFSETS[offset_label]))
    return base.isoformat()


def save(day, label, items):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{day}.json"
    doc = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"date": day, "snapshots": {}}
    doc["snapshots"][label] = {
        "collectedAt": datetime.now(KST).isoformat(timespec="seconds"),
        "count": len(items),
        "fields": sorted({k for it in items for k in it}),
        "items": items,
    }
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true", help="응답 구조만 출력")
    args = ap.parse_args()

    key = os.environ.get("ICN_API_KEY", "").strip()
    if not key:
        sys.exit("ICN_API_KEY 환경변수가 없다.")

    failed = False
    for label, value in OFFSETS.items():
        print(f"[{label}]")
        url, raw = fetch(value, key)
        print("  " + masked(url))
        try:
            header, items = parse(raw)
        except json.JSONDecodeError:
            print("  [!] JSON 아님. 응답 앞부분:", file=sys.stderr)
            print("  " + raw[:600].replace("\n", " "), file=sys.stderr)
            failed = True
            continue

        code = str(header.get("resultCode", ""))
        print(f"  resultCode={code or '-'} resultMsg={header.get('resultMsg', '-')} items={len(items)}")
        if items:
            print(f"  필드: {', '.join(sorted(items[0]))}")
            print(f"  첫 항목: {json.dumps(items[0], ensure_ascii=False)[:600]}")

        if args.probe:
            continue
        if code not in ("", "00") or not items:
            print("  [!] 정상 응답이 아니어서 저장하지 않는다.", file=sys.stderr)
            failed = True
            continue
        day = day_of(items, label)
        print(f"  → {save(day, label, items)}")

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
