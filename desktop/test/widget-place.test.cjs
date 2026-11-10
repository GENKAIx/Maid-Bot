// Проверка расчёта места окна виджета (main.js: widgetBounds, wantDown) на разных экранах — без Electron.
const fs = require("fs");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = [
  cut("const WIDGET_W", "const extraH"), "const extraH = () => 0;",
  cut("function widgetBounds", "function rememberWidget"),
  cut("const panelInWindow", "function settleWidget"),
].join("\n");
let settings, fold, displays;
const screen = { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] };
const api = new Function("settings", "fold", "screen", code + "; return { widgetBounds, wantDown, panelInWindow, WIDGET_H, PANEL_W };");
const screens = [["1920×1080 100%", 1920, 1040], ["1920×1080 125%", 1536, 824], ["1920×1080 150%", 1280, 680], ["1366×768 125%", 1093, 574], ["1280×720 150%", 853, 440]];
let bad = 0, n = 0;
const fail = (m) => { bad++; console.log("FAIL", m); };
for (const [name, W, H] of screens) for (const side of ["right", "left"]) for (const folded of [false, true])
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
    displays = [{ id: 1, bounds: { x: 0, y: 0, width: W, height: H + 40 }, workArea: { x: 0, y: 0, width: W, height: H } }];
    fold = { folded, miniH: 144, head: 131 };
    settings = { widget: { side, x: Math.round(cx * W) - 300, y: Math.round(cy * H) - 500, display: 1 } };
    const A = api(settings, fold, screen);
    // down решает wantDown по месту карточки (как settleWidget для неподвижного окна, не в режиме «вниз»)
    let b = A.widgetBounds();
    const area = displays[0].workArea, tag = `${name} side=${side} ${folded ? "свёрнут" : "развёрнут"} @${cx},${cy}`;
    const panelL = b.x + b.width - A.PANEL_W, panelT = b.y + b.height - 400;
    n++;
    if (panelL < area.x - 0.5 || panelL + A.PANEL_W > area.x + area.width + 0.5) fail(`${tag}: панель по x ${panelL}..${panelL + A.PANEL_W}`);
    if (b.y + b.height > area.y + area.height + 0.5) fail(`${tag}: низ окна за экраном`);
    if (!folded) {
      if (b.x + 8 < area.x - 0.5 && area.width >= 620) fail(`${tag}: планы за левым краем (x ${b.x + 8})`);
      if (panelT - fold.head < area.y - 0.5 && area.height >= 400 + 8 + fold.head) fail(`${tag}: голова за верхом`);
    } else {
      const cardBottom = b.y + b.height - 8;
      const down = A.wantDown(cardBottom, A.panelInWindow(b.height), area);
      const top = down ? cardBottom - 144 + 76 - fold.head : cardBottom - A.panelInWindow(b.height) - fold.head;
      if (!down && top < area.y - 0.5) fail(`${tag}: вверх, голова за верхом (${top})`);
    }
  }
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
