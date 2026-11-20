// «Перекрасить Рину» в виджете: цвета волос и глаз выбираются на сайте (Настройки → Горничная, users.maid_hair / maid_eyes),
// виджет узнаёт их из /api/today (опрос раз в 5 с, lookSync из load в widget.js) и перекрашивает все 41 анимацию сам
// (lookRender из look.js), в фоне, по кадру с паузой — окно не замирает. Пока набор не готов целиком, она в прежних
// цветах; готов — подменяется разом. Готовые анимации лежат в userData/maid-look/<lookKey>/<имя>.webp (main.js, look:*):
// следующий запуск берёт их оттуда за секунду; хранится только нынешний набор. Свои цвета — исходные файлы assets/maid.
// Без программы (страница на стенде serve.cjs) — читает файлы по адресу и ничего не хранит.

let lookWant = null; // ключ набора, который нужен ("" — свои цвета; null — ещё не спрашивали: первый опрос всегда наводит порядок в кэше)
let lookShown = ""; // ключ набора, что сейчас на экране
let lookFailed = ""; // ключ, на котором перекраска сломалась: не повторять каждые 5 с, пока цвет не сменят
let lookJob = 0; // номер сборки: сменили цвет посреди — старая бросает работу
let lookUrls = {}; // имя анимации → blob: URL перекрашенной
let lookBlobs = {}; // имя → Blob (для forget: каждый показ — новый адрес, чтобы шла с первого кадра)
let lookFresh = ""; // последний одноразовый адрес forget — отпустить при следующем
const LOOK_STOP = "перекраска отменена";

/** Адрес анимации n: перекрашенная, если готова, иначе своя. */
function maidSrc(n) {
  return lookUrls[n] ?? `../assets/maid/${n}.webp`;
}
/** То же, но адрес новый при каждом вызове — картинка начинается с первого кадра (forget). */
function maidSrcFresh(n) {
  const blob = lookBlobs[n];
  if (!blob) return `../assets/maid/${n}.webp?${Date.now()}`;
  if (lookFresh) URL.revokeObjectURL(lookFresh);
  lookFresh = URL.createObjectURL(blob);
  return lookFresh;
}

/** Цвета с сервера (data.maid_hair / maid_eyes; нет поля — свои). Повторный вызов с теми же цветами ничего не делает. */
function lookSync(hair, eyes) {
  // Нет поля (старый сервер) или цвет, которого эта версия не знает (сервер новее), — свой цвет этой части.
  if (!LOOK_HAIR.some((o) => o.id === hair)) hair = "red";
  if (!LOOK_EYES.some((o) => o.id === eyes)) eyes = "violet";
  const key = lookIsDefault(hair, eyes) ? "" : lookKey(hair, eyes);
  if (key === lookWant || (key && key === lookFailed)) return;
  lookWant = key;
  lookFailed = "";
  const job = ++lookJob;
  if (!key) {
    lookSwap({}, job);
    void maid.look?.keep(null).catch(() => {});
    return;
  }
  lookBuild(job, key, hair, eyes).catch((err) => {
    if (job !== lookJob || err?.message === LOOK_STOP) return;
    console.warn("Перекраска:", err?.message ?? err);
    lookFailed = key; // остаётся в прежних цветах — их и считаем нужными: смена на любые другие (и на свои) сработает
    lookWant = lookShown;
    void maid.look?.keep(lookShown || null).catch(() => {}); // недоделанный набор — с диска
  });
}

async function lookBuild(job, key, hair, eyes) {
  const pause = async () => {
    await new Promise((ok) => setTimeout(ok, 4));
    if (job !== lookJob) throw new Error(LOOK_STOP);
  };
  const store = maid.look;
  const made = {};
  for (const n of MOODS) {
    await pause();
    let bytes = store ? await store.get(key, n).catch(() => null) : null;
    if (!bytes) {
      const src = store ? await store.asset(n, false) : `../assets/maid/${n}.webp`;
      if (!src) throw new Error(`нет анимации ${n}`);
      const keep = store ? await store.asset(n, true) : `../assets/maid-keep/${n}.webp`;
      ({ bytes } = await lookRender({ src, keep: keep || null, hair, eyes, pause }));
      if (job !== lookJob) throw new Error(LOOK_STOP);
      if (store) await store.put(key, n, bytes).catch(() => false);
    }
    made[n] = new Blob([bytes], { type: "image/webp" });
  }
  if (job !== lookJob) throw new Error(LOOK_STOP);
  lookSwap(made, job);
  void store?.keep(key).catch(() => {});
}

/** Подменить набор разом: новые адреса, старые отпустить, нынешнюю картинку показать в новых цветах. */
function lookSwap(blobs, job) {
  if (job !== lookJob) return;
  const old = Object.values(lookUrls);
  lookShown = lookWant;
  if (!old.length && !Object.keys(blobs).length) return; // свои и были — картинку не трогать
  if (lookFresh) URL.revokeObjectURL(lookFresh); // forget уже загружена — адрес больше не нужен
  lookFresh = "";
  lookBlobs = blobs;
  lookUrls = {};
  for (const [n, b] of Object.entries(blobs)) lookUrls[n] = URL.createObjectURL(b);
  for (const u of Object.values(lookUrls)) new Image().src = u; // как у своих (widget.js): переключение без мигания
  const face = document.getElementById("face");
  const now = typeof mood !== "undefined" ? mood || "idle" : "idle"; // ещё ничего не показано — в разметке idle
  if (face && now !== "forget") face.src = maidSrc(now); // forget доиграет свой раз, следующий — уже в новых
  for (const u of old) URL.revokeObjectURL(u);
}
