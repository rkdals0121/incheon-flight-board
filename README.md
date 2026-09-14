# 인천공항 출도착 조회

터미널과 게이트 단위로 인천공항 운항 편을 보고, 각 구역이 어떤 성격의 노선을 받는지 확인하는 도구.

빌드 과정이 없는 정적 사이트라 Vercel에 그대로 올라가고, GitHub Actions가 매일 데이터를 받아 레포에 커밋한다.

## 기능

| | |
|---|---|
| 터미널 구분 | 제1여객터미널 · 탑승동 · 제2여객터미널 · 전체 |
| 날짜 구분 | 저장된 날짜 중 선택 |
| 게이트별 운항 편 | 게이트별로 묶인 시각·편명·도시·항공사 목록 |
| 노선 특성 분류 | 거리 구간, 권역, 국가, 항공사, 항공사 유형(FSC/LCC), 얼라이언스 |
| 저장 | `data/flights/YYYY-MM-DD.json` 로 레포에 누적 |

제2여객터미널의 자율주행 운송차량(AM) 운행 구간(219~224, 276~280)은 화면에서 따로 표시된다.

## 설치

### 1. 레포 만들고 올리기

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/<사용자명>/incheon-flight-board.git
git push -u origin main
```

### 2. API 키 등록

공공데이터포털 [여객기 운항 현황 상세 조회 서비스](https://www.data.go.kr/data/15112968/openapi.do)에서 활용신청 후 키를 받는다.
**인코딩 키가 아니라 디코딩 키**를 쓴다.

레포 → Settings → Secrets and variables → Actions → New repository secret
- Name: `ICN_API_KEY`
- Secret: 디코딩 키

### 3. 파라미터 이름 확인 (최초 1회 필수)

포털 웹페이지에는 파라미터 이름이 안 나오고 첨부된 활용가이드 docx에만 있다.
`scripts/collect.py` 상단 `PARAMS` 에 추정값을 넣어 뒀으니 먼저 확인할 것.

```bash
export ICN_API_KEY="디코딩 키"
python scripts/collect.py --probe
```

정상이면 운항 편 JSON이 찍힌다. `INVALID_REQUEST_PARAMETER_ERROR`가 나오면
docx의 요청변수 표를 보고 `PARAMS` 의 값만 고치면 된다. 필드 이름이 다르면
`FIELD_MAP` 에 후보를 추가한다. 두 딕셔너리 말고는 손댈 곳이 없다.

### 4. 수집

```bash
python scripts/collect.py                       # 오늘~+3일
python scripts/collect.py --days 2026-09-14     # 특정 날짜
```

API가 D-3~D+6만 주기 때문에 과거 데이터는 쌓아 두는 수밖에 없다.
Actions가 매일 23:40 KST에 돌면서 자동으로 커밋한다.
첫 실행은 Actions 탭에서 "운항 데이터 수집" → Run workflow 로 직접 돌려도 된다.

### 5. Vercel 연결

New Project → 레포 선택 → Framework Preset은 **Other**, 빌드 명령과 출력 디렉터리는 비워 둔다.
Actions가 `data/` 를 커밋할 때마다 자동으로 재배포된다.

### 로컬 확인

```bash
python -m http.server 8000
# http://localhost:8000
```

## 데이터

```
data/
  airports.json   공항 168곳: 한글명, 국가, 권역, 좌표, 인천 기준 거리, 거리 구간
  airlines.json   항공사 100여 곳: 한글명, 국적, FSC/LCC, 얼라이언스
  zones.json      터미널별 게이트 구역, AM 운행 정보
  index.json      저장된 날짜 목록 (수집 시 자동 갱신)
  flights/        날짜별 운항 편
```

거리 구간은 인천공항 기준 대권거리로 계산한다. 단거리 1,500km 미만,
중거리 1,500~4,000km, 장거리 4,000km 이상.

### 알아 둘 것

- `data/flights/2026-09-14.json`, `2026-09-15.json` 은 화면 확인용 시드 데이터다.
  공항 홈페이지 운항 조회에서 받은 것이라 필드 구성이 API와 완전히 같지는 않다.
  API 수집이 정상 동작하면 같은 날짜로 덮어쓰면 된다.
- **제2여객터미널 구역 경계는 공항 홈페이지 AM 안내 지도(219·224·276·280번 승하차지점)를
  근거로 확정한 값이다. 제1여객터미널과 탑승동 구역 경계는 게이트 번호 순서에 따른 추정치이므로
  인용하기 전에 확인이 필요하다.** `data/zones.json` 의 `verified` 필드로 구분해 두었다.
- 게이트 배정은 목적지별로 고정되지 않는다. 같은 편명도 날짜마다 게이트가 바뀌므로,
  구역별 성격은 경향으로만 읽어야 한다. 며칠 치로 단정하지 말 것.
- 기종(광동체/협동체)은 이 API가 제공하지 않는다.

## 나중에 DB로 옮길 때

지금은 정적 JSON을 그대로 읽는다. 옮길 자리는 두 군데다.

- 쓰기: `scripts/collect.py` 의 `save()` 를 INSERT로 교체
- 읽기: `assets/app.js` 의 `loadDay()` 가 `data/flights/*.json` 대신 API를 호출하도록 교체

나머지 코드는 손댈 필요가 없다.

## 출처

- 운항 데이터: 공공데이터포털 인천국제공항공사 여객기 운항 현황 상세 조회 서비스
- AM 운행 정보: 인천국제공항 자율주행 운송차량(AM) 안내
