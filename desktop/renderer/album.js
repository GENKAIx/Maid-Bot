// Альбом реакций: анимацию, показанную впервые, виджет называет серверу (/api/album) — сайт рисует альбом «Ещё → Альбом»:
// увиденное открыто, остальное — силуэты с подсказкой. Отправленное помнится в localStorage «maid.album», чтобы не слать
// одно и то же; не дошло (нет связи) — повтор через минуту и при следующем показе.
const ALBUM_KEY = "maid.album";
let albumSent = {};
try { albumSent = JSON.parse(localStorage.getItem(ALBUM_KEY) ?? "{}") ?? {}; } catch { albumSent = {}; }
const albumWait = new Set();
let albumTimer = 0;

function albumSee(n) {
  if (albumSent[n] || albumWait.has(n)) return;
  albumWait.add(n);
  clearTimeout(albumTimer);
  albumTimer = setTimeout(albumFlush, 3000); // несколько реакций подряд — одним запросом
}
async function albumFlush() {
  const moods = [...albumWait];
  if (!moods.length) return;
  try {
    await maid.api("POST", "/api/album", { moods });
    for (const m of moods) { albumSent[m] = 1; albumWait.delete(m); }
    try { localStorage.setItem(ALBUM_KEY, JSON.stringify(albumSent)); } catch {}
  } catch {
    clearTimeout(albumTimer);
    albumTimer = setTimeout(albumFlush, 60_000);
  }
}

// --- погладить ---
// Тычок — щелчок, а если зажать левую кнопку на горничной на секунду (и не тащить окно) — она смущается (shy).
// Обижена на тычки — прощает сразу.
const PET_HOLD = 900;
let petTimer = 0;
let pettedAt = 0; // щелчок сразу после — не тычок (widget.js)
function pet() {
  pettedAt = Date.now();
  pokes = 0;
  boop("boop");
  popTone(5, { vol: 0.18, soft: true });
  if (Date.now() < sulkUntil) {
    clearTimeout(sulkTimer);
    sulkUntil = 0;
    quip(line("forgive"), "bow", 3500);
    return;
  }
  quip(line("pet"), "shy", 4000);
}
