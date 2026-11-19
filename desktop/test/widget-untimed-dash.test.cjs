// Лента «Дальше»: у плана без времени вместо часа прочерк. 19.11.2026: он стоял у левого края колонки времени,
// а «17:43» занимает её почти всю — прочерк выглядел сдвинутым. Теперь он по центру колонки.
const fs = require("fs");
const path = require("path");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const js = fs.readFileSync(path.join(__dirname, "..", "renderer", "widget.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");

check(/class="nx-t\$\{e\.time \? "" : " none"\}"/.test(js), "у прочерка нет своего класса nx-t none");
check(/\.w \.next \.nx-t\.none \{[^}]*text-align: center/.test(css), "прочерк не центрирован (.nx-t.none text-align: center)");
console.log(`${n - bad}/${n} проверок`);
if (bad) process.exit(1);
