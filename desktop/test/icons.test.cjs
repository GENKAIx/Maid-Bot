// Значки программ (icons.js): у программ из Microsoft Store — логотип из AppxManifest.xml (свой exe без значка).
// Без Electron: разбор манифеста, выбор файла логотипа, путь к нему по пути exe в папке WindowsApps.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { manifestLogo, pickLogo, storeLogoPath } = require("../src/icons.js");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const xml = String.raw`<Package><Applications>
<Application Id="Svc" Executable="app\resources\svc.exe"><uap:VisualElements Square44x44Logo="Assets\Svc44.png"/></Application>
<Application Id="App" Executable="app\Claude.exe"><uap:VisualElements Square150x150Logo="Assets\S150.png" Square44x44Logo="Assets\Square44x44Logo.png"/></Application>
</Applications></Package>`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "maid-icons-"));
try {
  check(manifestLogo(xml, String.raw`app\Claude.exe`) === String.raw`Assets\Square44x44Logo.png`, "логотип не своего приложения");
  check(manifestLogo(xml, "app/claude.EXE") === String.raw`Assets\Square44x44Logo.png`, "путь exe с другими косыми или регистром не узнан");
  check(manifestLogo(xml, "нет.exe") === String.raw`Assets\Svc44.png`, "нет такого exe — не первый логотип");
  check(manifestLogo("<Package/>", "x.exe") === "", "нет логотипа — не пусто");

  const files = ["Square44x44Logo.png", "Square44x44Logo.scale-200.png", "Square44x44Logo.targetsize-48.png", "square44x44logo.targetsize-32_altform-unplated.png"];
  check(pickLogo(files, "Square44x44Logo") === "square44x44logo.targetsize-32_altform-unplated.png", "выбран не прозрачный 32 px");
  check(pickLogo(files.slice(0, 3), "Square44x44Logo") === "Square44x44Logo.targetsize-48.png", "без прозрачного — не 48 px");
  check(pickLogo(["Square44x44Logo.png"], "Square44x44Logo") === "Square44x44Logo.png", "нет размеров — не основной файл");
  check(pickLogo(["Other.png"], "Square44x44Logo") === "", "чужой файл выбран");

  const pkg = path.join(root, "WindowsApps", "Claude_1.0_x64__abc");
  fs.mkdirSync(path.join(pkg, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "app"));
  fs.writeFileSync(path.join(pkg, "AppxManifest.xml"), xml);
  for (const f of files) fs.writeFileSync(path.join(pkg, "Assets", f), "png");
  const got = storeLogoPath(path.join(pkg, "app", "Claude.exe"));
  check(got === path.join(pkg, "Assets", "square44x44logo.targetsize-32_altform-unplated.png"), `путь логотипа: ${got}`);
  check(storeLogoPath(String.raw`C:\Program Files\Google\Chrome\chrome.exe`) === "", "программа не из Store получила логотип");
  check(storeLogoPath(path.join(root, "WindowsApps", "нет_пакета", "a.exe")) === "", "без манифеста — не пусто");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
