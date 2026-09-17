/*
 * 서비스 워커 — 연결이 끊겼을 때 마지막으로 받은 화면과 데이터를 보여준다.
 *
 * 항상 네트워크를 먼저 쓴다. 캐시를 먼저 쓰면 배포 직후 구버전 JS·데이터가
 * 남는 문제(assets 캐시 1시간 문제와 같은 종류)가 다시 생긴다. 네트워크 요청이
 * 실패했을 때만 캐시에 저장해 둔 사본을 돌려준다.
 */
const CACHE = "icn-board-v2";   // 캐시 구조를 바꾸면 올린다. 활성화 때 이전 캐시를 지운다.
const SHELL = ["./", "index.html", "manifest.webmanifest"];
const MAX_FLIGHT_FILES = 4;   // 날짜별 운항 파일은 크다(약 750KB). 최근 본 것만 남긴다.

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // 페이지 이동은 조회 조건(?d=&t=…)마다 주소가 달라 사본이 끝없이 쌓인다. 하나로 저장한다.
  const nav = req.mode === "navigate";
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) {
        await cache.put(nav ? "index.html" : req, res.clone());
        if (url.pathname.includes("/data/flights/")) await pruneFlights(cache);
      }
      return res;
    } catch (err) {
      const hit = nav
        ? await cache.match("index.html")
        : await cache.match(req, { ignoreSearch: url.pathname.includes("/assets/") });
      if (hit) return hit;
      throw err;
    }
  })());
});

async function pruneFlights(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.includes("/data/flights/"));
  // 캐시에 넣은 순서대로 쌓이므로 앞쪽이 오래된 것
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FLIGHT_FILES))) await cache.delete(k);
}
