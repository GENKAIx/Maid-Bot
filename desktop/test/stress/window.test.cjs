// Стресс-проверки места виджета (main.js: widgetBounds, перетаскивание, вытягивание панели, смена экранов) на подменных экранах:
// два монитора, монитор слева и сверху, отключение монитора, смена разрешения, масштаб Windows 150 и 200 % (для программы это
// просто экран меньше: 1280×720 и 960×540), все углы и края. Настоящий main.js на стенде (harness.cjs).
// Стенд считает только числа: настоящие окна, прозрачность и мышь здесь не участвуют.
// Пометка todo — найденный баг (номер по отчёту docs/review/стресс-тест-ПК-2026-11-15.html).
const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, display, loggedIn } = require("./harness.cjs");

const PANEL_W = 340, PANEL_H = 400, WIDGET_W = 620;
const SERVER = "https://maid.example";
/** Панель (правый нижний угол окна) в координатах экрана. */
const panelOf = (h) => {
  const b = h.widget().getBounds();
  const ph = PANEL_H + (h.peek("extraH()"));
  return { x: b.x + b.width - PANEL_W, y: b.y + b.height - ph, width: PANEL_W, height: ph };
};
const inside = (r, a) => r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height;
const onSomeScreen = (h) => h.screen.displays.some((d) => inside(panelOf(h), d.workArea));
async function start(t, opts = {}) {
  const h = boot({ settings: loggedIn(SERVER, { widget: { show: true, ...opts.widget } }), ...opts });
  await h.ready();
  t.after(() => h.stop());
  // Виджет развёрнут, голова горничной над панелью — 170 px (как сообщает окно при обычном размере).
  h.send("widget-fold", [false, 144, opts.head ?? 170]);
  return h;
}
/** Перетащить окно: взять в точке, отпустить со сдвигом. */
function dragBy(h, dx, dy) {
  const b = h.widget().getBounds();
  h.screen.cursor = { x: b.x + b.width - 100, y: b.y + b.height - PANEL_H + 10 };
  h.send("widget-drag", ["start"]);
  h.screen.cursor = { x: h.screen.cursor.x + dx, y: h.screen.cursor.y + dy };
  h.send("widget-drag", ["move"]);
  h.send("widget-drag", ["end"]);
}

const SCREENS = { "1920×1080 (100 %)": [1920, 1080], "1280×720 (150 %)": [1280, 720], "960×540 (200 %)": [960, 540] };
for (const [name, [w, hh]] of Object.entries(SCREENS)) {
  test(`экран ${name}: первый запуск — панель целиком на экране, в правом нижнем углу`, async (t) => {
    const h = await start(t, { displays: [display(1, 0, 0, w, hh)] });
    assert.ok(onSomeScreen(h), JSON.stringify(panelOf(h)));
  });
  test(`экран ${name}: виджет утащили за каждый угол и край — панель возвращается на экран`, async (t) => {
    const h = await start(t, { displays: [display(1, 0, 0, w, hh)] });
    for (const [dx, dy] of [[-5000, -5000], [5000, -5000], [-5000, 5000], [5000, 5000], [0, -5000], [0, 5000], [-5000, 0], [5000, 0]]) {
      dragBy(h, dx, dy);
      assert.ok(onSomeScreen(h), `сдвиг ${dx},${dy}: панель ${JSON.stringify(panelOf(h))}`);
    }
  });
}

test("Б-10: экран 960×540 (200 %): голова горничной не уходит за верх экрана у верхнего края", { todo: "Б-10: панель 400 + голова 170 не помещаются в 500 px рабочей области — побеждает панель, голову срезает" }, async (t) => {
  const h = await start(t, { displays: [display(1, 0, 0, 960, 540)] });
  dragBy(h, 0, -5000);
  assert.ok(panelOf(h).y - 170 >= 0, `верх головы на ${panelOf(h).y - 170}`);
});

test("два монитора: виджет переносится на второй и запоминает его", async (t) => {
  const h = await start(t, { displays: [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 2560, 1440)] });
  dragBy(h, 2000, 100);
  assert.ok(inside(panelOf(h), h.screen.displays[1].workArea));
  assert.equal(h.disk().widget.display, 2);
});

test("монитор слева и сверху (отрицательные координаты): панель остаётся там, куда поставили", async (t) => {
  const h = await start(t, { displays: [display(1, 0, 0, 1920, 1080), display(2, -1280, -200, 1280, 1024), display(3, 0, -1080, 1920, 1080)] });
  dragBy(h, -2400, -300);
  assert.ok(inside(panelOf(h), h.screen.displays[1].workArea), JSON.stringify(panelOf(h)));
  dragBy(h, 2400, -900);
  assert.ok(inside(panelOf(h), h.screen.displays[2].workArea), JSON.stringify(panelOf(h)));
});

test("Б-13: второй монитор ниже ростом: виджет отпустили у его нижнего края — он остаётся на этом мониторе, а не прыгает на основной", { todo: "Б-13: центр панели попал в «пустоту» под маленьким монитором — widgetBounds возвращает виджет в угол основного, а не на ближайший экран" }, async (t) => {
  const h = await start(t, { displays: [display(1, 0, 0, 1920, 1080), display(2, -1280, -200, 1280, 1024)] });
  dragBy(h, -2400, 0);
  assert.ok(inside(panelOf(h), h.screen.displays[1].workArea), `панель ${JSON.stringify(panelOf(h))}`);
});

test("отключили монитор, на котором стоял виджет: он возвращается на основной", async (t) => {
  const h = await start(t, { displays: [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 2560, 1440)] });
  dragBy(h, 2500, 200);
  h.screen.displays = [h.screen.displays[0]];
  h.screen.emit("display-removed");
  assert.ok(inside(panelOf(h), h.screen.displays[0].workArea), JSON.stringify(panelOf(h)));
});

test("запуск с сохранённым местом на мониторе, которого больше нет: виджет на основном", async (t) => {
  const h = await start(t, { widget: { x: 3000, y: 500, display: 2, width: WIDGET_W } });
  assert.ok(onSomeScreen(h), JSON.stringify(panelOf(h)));
});

test("Б-11: разрешение уменьшили (или масштаб 100 → 150 %) — панель, оставшаяся за краем, возвращается на экран", { todo: "Б-11: reviveWidget смотрит на всё окно 620×760 (оно почти всё прозрачное), а не на панель" }, async (t) => {
  const h = await start(t, {});
  assert.ok(onSomeScreen(h));
  h.screen.displays = [display(1, 0, 0, 1600, 900)];
  h.screen.emit("display-metrics-changed", {}, h.screen.displays[0], ["bounds", "workArea"]);
  assert.ok(onSomeScreen(h), `панель ${JSON.stringify(panelOf(h))}, экран 1600×860`);
});

test("панель вытянута до предела — она не выше рабочей области экрана", async (t) => {
  const h = await start(t, {});
  const b = h.widget().getBounds();
  h.screen.cursor = { x: b.x + b.width - 5, y: b.y + b.height - 5 };
  h.send("widget-resize", ["start"]);
  h.screen.cursor.y -= 300; // сначала вверх, чтобы было куда тянуть вниз
  h.send("widget-resize", ["move"]);
  h.send("widget-resize", ["end"]);
  dragBy(h, 0, -400);
  const c = h.widget().getBounds();
  h.screen.cursor = { x: c.x + c.width - 5, y: c.y + c.height - 5 };
  h.send("widget-resize", ["start"]);
  h.screen.cursor.y += 5000;
  h.send("widget-resize", ["move"]);
  h.send("widget-resize", ["end"]);
  assert.ok(panelOf(h).height <= 1040, `высота панели ${panelOf(h).height}`);
  assert.ok(onSomeScreen(h), JSON.stringify(panelOf(h)));
});

test("Б-12: панель вытянули на большом экране, потом экран стал меньше — шапка панели не должна уйти за верх", { todo: "Б-12: прибавка к высоте (widget.extra) не пересчитывается под новый экран" }, async (t) => {
  const h = await start(t, { widget: { extra: 490 } });
  h.screen.displays = [display(1, 0, 0, 1280, 720)];
  h.screen.emit("display-metrics-changed", {}, h.screen.displays[0], ["bounds", "workArea"]);
  h.screen.emit("display-removed");
  assert.ok(panelOf(h).y >= 0, `верх панели (шапка, за которую её двигают) на ${panelOf(h).y}`);
});

test("С-8: страница виджета перезагрузилась посреди перетаскивания — окно не остаётся приклеенным к курсору", { todo: "С-8: «end» не придёт, а будильник followCursor никто не остановит" }, async (t) => {
  const h = await start(t, {});
  const b = h.widget().getBounds();
  h.screen.cursor = { x: b.x + 500, y: b.y + 400 };
  h.send("widget-drag", ["start"]);
  h.widget().webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  h.screen.cursor = { x: 300, y: 300 };
  await h.wait(80);
  assert.equal(h.peek("drag"), null, "перетаскивание всё ещё идёт");
});

test("сон и пробуждение, подключение экрана: окно возвращается наверх", async (t) => {
  const h = await start(t, {});
  h.widget().calls.length = 0;
  h.screen.emit("display-added");
  assert.ok(h.widget().calls.includes("moveTop") && h.widget().calls.includes("top:true:screen-saver"));
  h.electron.powerMonitor.emit("suspend");
  h.electron.powerMonitor.emit("resume");
  assert.match(h.log(), /сон ПК[\s\S]*пробуждение ПК/);
});

test("виджет выключен в настройках: горячая клавиша «взять» и события экранов ничего не роняют", async (t) => {
  const h = await start(t, { widget: { show: false } });
  assert.equal(h.widget(), undefined);
  h.screen.emit("display-removed");
  h.screen.emit("display-metrics-changed", {}, {}, ["workArea"]);
  h.send("widget-drag", ["start"]);
  h.send("widget-resize", ["reset"]);
  h.send("focus-input", [true]);
  await h.invoke("settings:set", [{ widget: { show: true } }], null);
  assert.ok(h.widget(), "включили обратно — окно создано");
});

test("свёрнутую карточку отпустили у верха экрана: панель раскроется вниз (режим «вниз»), у низа — вверх", async (t) => {
  const h = await start(t, {});
  h.send("widget-fold", [true, 144, 120]);
  dragBy(h, 0, -5000);
  await h.wait(450);
  assert.equal(h.peek("settings.widget.down"), true);
  dragBy(h, 0, 5000);
  await h.wait(450);
  assert.equal(h.peek("settings.widget.down"), false);
});
