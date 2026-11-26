// Управление живым показом виджета в «Витрине» админки (server/src/preview.ts вставляет этот файл последним скриптом
// в настоящий desktop/renderer/widget.html). Страница админки шлёт postMessage { maidPreview: 1, cmd, … } — здесь это
// превращается в вызовы самого виджета: react() (анимация), say() (слова с характером, походка букв, превращения облачка),
// bubblefxMark(), погода (wxNow + wxDraw), праздники привычек (данные дня → load → hpSync, как настоящий опрос) и сценарии
// «Возможностей» (шаги по времени). Код виджета не меняется: скрипты страницы делят одну область имён, и отсюда видны его
// функции и переменные. Виды показа — PREVIEW_KINDS (сверяет web/test/showcase.test.ts с карточками витрины).
// Медленно: window.__preview.speed (stub.js) тормозит таймеры и CSS-анимации, а кадры фигурки (WebP идёт со своей скоростью)
// рисуются здесь на холсте поверх неё — по кадру, через ImageDecoder; сдвиг, поворот и фильтр самой фигурки (падение за
// панель, бледность, линии уныния) холст повторяет за ней каждый кадр экрана.
// Клавиши Esc, ← и → (не в строке ввода) уходят странице админки: в большом просмотре они листают карточки и закрывают его.
(() => {
  const P = window.__preview;
  const PREVIEW_KINDS = ["anim", "say", "weather", "holiday", "scene"];
  /** Поля кадра сценария (web/src/features.ts Frame), которые показ умеет; сверяет web/test/showcase.test.ts. */
  const PREVIEW_FIELDS = ["maid", "input", "mic", "bubble", "buttons", "fill", "pressed", "rows", "msgs"];
  const post = (msg) => parent.postMessage({ maidPreview: 1, ...msg }, location.origin);
  let timers = [];
  const later = (ms, f) => timers.push(setTimeout(f, ms)); // setTimeout из stub.js — уже с замедлением
  const sleep = (ms) => new Promise((ok) => later(ms, ok));
  let run = 0; // номер показа: новый показ или «стоп» — прежние шаги бросают работу

  // Тихо и спокойно: облачко убрано, эффекты остановлены, погоды нет, данные дня — обычные, горничная — в своей основе.
  async function calm() {
    run++;
    for (const t of timers) clearTimeout(t);
    timers = [];
    try { bubblefxStop(); } catch {}
    try { stopType(); } catch {}
    try { hideBubble(); } catch {}
    try { chatInput.value = ""; } catch {}
    try { chatBox.classList.remove("recording"); } catch {}
    P.weather = null;
    try { wxNow = null; wxAt = Date.now(); wxDraw(); } catch {}
    if (JSON.stringify(P.data) !== JSON.stringify(P.sample())) {
      P.data = P.sample();
      try { await load(); } catch {}
    }
    try { clearTimeout(moodTimer); moodUntil = 0; showMood(baseMood()); } catch {}
  }

  // --- виды показа ---
  const play = {
    // Анимация горничной: та же react(), что у событий виджета; ms — сколько держать (у forget — свой один показ).
    anim: (x) => { react(x.id, x.ms || 6000); },
    // Реплика в облачке: own — своя реплика с пометками [эффект]слово[/] (как из lines.js), mark — значок облачка поверх.
    say: (x) => {
      try { bubblefxSince = 99; } catch {}
      say((x.own ? WORDFX_OWN : "") + x.text, { emotion: x.emotion || "neutral", heard: x.heard || "", ms: 12000, mood: x.mood || null });
      if (x.mark) later(500, () => bubblefxMark(x.mark, 2600));
    },
    // Погода над панелью: плашка в шапке и частицы — как после ответа GET /api/weather.
    weather: (x) => {
      P.weather = { day: data?.day, kind: x.sky, sky: x.sky, icon: x.icon, temp: x.temp, text: x.text, city: "" };
      wxNow = P.weather;
      wxAt = Date.now();
      wxDraw();
    },
    // Праздник привычек: два ответа «сервера» подряд — до отметки и после, остальное делает сам hpSync в load().
    holiday: async (x, id) => {
      const tier = Number(x.tier) || 7;
      const before = x.party === "flame"
        ? [{ id: 901, title: "Зарядка", status: null, streak: tier - 1 }, { id: 902, title: "Пить воду", status: null, streak: 3 }]
        : [{ id: 901, title: "Зарядка", status: "done", streak: 5 }, { id: 902, title: "Пить воду", status: "done", streak: 12 },
          { id: 903, title: "Читать 20 минут", status: null, streak: x.party === "salute" ? 6 : 3 }];
      const after = before.map((h, i) => (i === (x.party === "flame" ? 0 : 2) ? { ...h, status: "done", streak: h.streak + 1 } : h));
      try { localStorage.removeItem(HP_KEY); hpPrev = null; } catch {}
      P.data = { ...P.sample(), habits: before };
      await load();
      await sleep(700);
      if (id !== run) return;
      P.data = { ...P.data, habits: after };
      await load();
    },
    // Сценарий «Возможностей» (web/src/features.ts): начальный кадр и шаги «в такую-то мс поменять вот это».
    scene: async (x, id) => {
      const d = x.demo;
      await frame(d.start, d.kind, id);
      for (const s of d.steps) later(s.at, () => { if (id === run) void frame(s.set, d.kind, id); });
    },
  };

  // Строки примера → данные дня: время — план (с днём недели — на завтра), задача, привычка (огонёк из «🔥 5»).
  function rowsToday(rows) {
    const tasks = [], habits = [], events = [], upcoming = [];
    rows.forEach((r, i) => {
      const id = 700 + i;
      if (r.habit) habits.push({ id, title: r.title, status: r.done ? "done" : null, streak: Number(String(r.note ?? "").match(/(\d+)/)?.[1]) || 0 });
      else if (r.task || !r.time) tasks.push({ id, title: r.title, priority: "normal", due_date: r.late ? P.dayPlus(-3) : null });
      else {
        const m = String(r.time).match(/^(?:(\S+)\s+)?(\d{1,2}:\d{2})$/);
        const ev = { id, title: r.title, time: m ? m[2].padStart(5, "0") : null, end_time: null, status: "active" };
        (m?.[1] ? upcoming : events).push({ ...ev, date_iso: m?.[1] ? P.dayPlus(1) : P.dayKey() });
      }
    });
    return { tasks, habits, events, upcoming };
  }

  let typed = 0;
  async function frame(f, kind, id) {
    if ("rows" in f && f.rows) {
      P.data = { ...P.sample(), ...rowsToday(f.rows) };
      await load();
      if (id !== run) return;
    }
    if ("input" in f) {
      const text = f.input ?? "", my = ++typed;
      chatInput.value = "";
      [...text].forEach((_, i) => later(i * 45, () => { if (my === typed) { chatInput.value = text.slice(0, i + 1); chatInput.dispatchEvent(new Event("input")); } }));
    }
    // Идёт запись голоса — строка ввода в виде записи (как micUi виджета).
    if ("mic" in f) { try { chatBox.classList.toggle("recording", !!f.mic); } catch {} }
    // Нажатая кнопка облачка — вспыхивает.
    if (f.pressed != null) {
      const btn = document.querySelector(`#bubble button[data-i="${Number(f.pressed)}"]`);
      if (btn) { btn.classList.add("pressed"); btn.animate?.([{ transform: "scale(.94)", filter: "brightness(1.5)" }, { transform: "none", filter: "none" }], 380); }
    }
    // Чат Telegram — облачком (в виджете нет окна чата): последняя реплика горничной, над ней — реплика человека, на которую
    // она отвечает (🎙 как у голосового); человек написал, а ответа ещё нет — «…» под его репликой.
    const all = kind === "chat" && f.msgs ? f.msgs : [];
    const msgs = all.filter((m) => !m.me);
    const lastIdx = all.lastIndexOf(msgs.at(-1));
    const heard = all.length && all.at(-1).me ? all.at(-1).text : all.slice(0, Math.max(0, lastIdx)).filter((m) => m.me).at(-1)?.text ?? "";
    const bubble = "bubble" in f ? f.bubble : all.length && all.at(-1).me ? "…" : msgs.length ? msgs.at(-1).text : undefined;
    const buttons = "bubble" in f ? f.buttons : msgs.at(-1)?.buttons;
    if ("bubble" in f || all.length) {
      if (!bubble) { hideBubble(); if (f.maid) react(f.maid, 60_000); return; }
      if (bubble === "…") { say("…", { ms: 0, heard }); react(f.maid || "think", 60_000); return; }
      // fill — кнопка с самонажатием (auto, как «Оставить» у пересечения планов): полоса заполняется сама.
      say(bubble, { ms: 0, mood: f.maid || null, heard, buttons: (buttons ?? []).map((t, i) => ({ text: t, data: "preview", auto: f.fill === i ? 4 : undefined })) });
      return;
    }
    if (f.maid && f.maid !== mood) react(f.maid, 60_000);
  }

  // --- медленно: кадры фигурки на холсте поверх неё ---
  let faceRun = 0;
  const face = () => document.getElementById("face");
  function faceStop() {
    faceRun++;
    document.getElementById("previewFace")?.remove();
    if (face()) face().style.opacity = "";
  }
  async function faceSlow() {
    const my = ++faceRun, f = face();
    if (!f || P.k >= 1 || typeof ImageDecoder === "undefined" || !/\/assets\/maid\//.test(f.src)) return faceStop();
    try {
      // Без своих меток адреса (у forget — ?время), но с меткой версии (P.url) — тот же файл из кэша браузера.
      const buf = await (await fetch(P.url(f.src.replace(/\?.*$/, "")))).arrayBuffer();
      if (my !== faceRun) return;
      const dec = new ImageDecoder({ data: buf, type: "image/webp" });
      await dec.tracks.ready;
      await dec.completed;
      const n = dec.tracks.selectedTrack?.frameCount ?? 0;
      let cv = document.getElementById("previewFace");
      if (!cv) {
        cv = document.createElement("canvas");
        cv.id = "previewFace";
        f.after(cv);
      }
      Object.assign(cv.style, { position: "absolute", left: `${f.offsetLeft}px`, top: `${f.offsetTop}px`, width: `${f.offsetWidth}px`, height: `${f.offsetHeight}px`, pointerEvents: "none" });
      const g = cv.getContext("2d");
      // Холст повторяет за фигуркой её место, сдвиг, поворот и фильтр (WAAPI и CSS-анимации #face, классы .maid.bfx-*).
      const follow = () => {
        if (my !== faceRun || !cv.isConnected) return;
        const cs = getComputedStyle(f);
        Object.assign(cv.style, { left: `${f.offsetLeft}px`, top: `${f.offsetTop}px`, width: `${f.offsetWidth}px`, height: `${f.offsetHeight}px`,
          transform: cs.transform, transformOrigin: cs.transformOrigin, filter: cs.filter });
        requestAnimationFrame(follow);
      };
      follow();
      for (let i = 0; my === faceRun && n; i = (i + 1) % n) {
        const { image } = await dec.decode({ frameIndex: i });
        if (my !== faceRun) { image.close(); break; }
        if (cv.width !== image.displayWidth) { cv.width = image.displayWidth; cv.height = image.displayHeight; }
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(image, 0, 0);
        f.style.opacity = "0";
        const ms = (image.duration ?? 83_000) / 1000;
        image.close();
        await new Promise((ok) => P.realTimeout(ok, ms / P.k));
      }
      dec.close();
    } catch {
      if (my === faceRun) faceStop();
    }
  }
  // Клавиши большого просмотра: фокус ушёл в виджет (щёлкнули по горничной) — Esc, ← и → всё равно доходят до админки.
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const t = e.target, tag = t?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    post({ ev: "key", key: e.key });
  });
  const watch = () => { if (face()) new MutationObserver(() => { if (P.k < 1) void faceSlow(); }).observe(face(), { attributes: true, attributeFilter: ["src"] }); };
  watch();

  // --- связь со страницей админки ---
  addEventListener("message", async (e) => {
    if (e.source !== parent || e.origin !== location.origin || !e.data || e.data.maidPreview !== 1) return;
    const m = e.data;
    if (m.cmd === "stop") { await calm(); return post({ ev: "stopped" }); }
    if (m.cmd === "speed") { P.speed(m.k); if (P.k < 1) void faceSlow(); else faceStop(); return; }
    if (m.cmd === "mute") { cfg.mute = !!m.on; return; }
    if (m.cmd === "play" && m.play && PREVIEW_KINDS.includes(m.play.kind)) {
      await calm();
      const id = run;
      try { await play[m.play.kind](m.play, id); } catch (err) { P.errors.push(String(err?.message ?? err)); }
      post({ ev: "playing", kind: m.play.kind });
    }
  });
  // Готов — когда виджет получил первые данные дня (до этого react и say ещё некуда показывать).
  (function ready() {
    if (typeof data !== "undefined" && data) return post({ ev: "ready" });
    P.realTimeout(ready, 100);
  })();
  P.kinds = PREVIEW_KINDS;
  P.fields = PREVIEW_FIELDS;
})();
