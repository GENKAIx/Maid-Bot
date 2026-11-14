import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Обновление программы для ПК: сервер отдаёт /desktop/latest.yml и установщик без входа, и больше ничего из папки.

test("/desktop/: latest.yml и установщик — без входа; чужие имена, подпапки и выход из папки — 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-desktop-"));
  fs.writeFileSync(path.join(dir, "latest.yml"), "version: 0.1.1\npath: Gornichnaya-Setup-0.1.1.exe\n");
  fs.writeFileSync(path.join(dir, "Gornichnaya-Setup-0.1.1.exe"), Buffer.from("MZexe"));
  fs.writeFileSync(path.join(dir, "secret.txt"), "нельзя");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "x.exe"), "нельзя");
  const store = await Store.open(":memory:");
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), desktopDir: dir }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const yml = await fetch(base + "/desktop/latest.yml");
    assert.equal(yml.status, 200);
    assert.match(yml.headers.get("content-type") ?? "", /yaml/);
    assert.match(await yml.text(), /version: 0\.1\.1/);
    const exe = await fetch(base + "/desktop/Gornichnaya-Setup-0.1.1.exe");
    assert.equal(exe.status, 200);
    assert.equal(Buffer.from(await exe.arrayBuffer()).toString(), "MZexe");
    for (const bad of ["/desktop/secret.txt", "/desktop/sub/x.exe", "/desktop/..%2Fsecret.txt", "/desktop/", "/desktop/nope.exe"]) {
      assert.equal((await fetch(base + bad)).status, 404, bad);
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/desktop/: без папки обновлений — 404, а не страница сайта", async () => {
  const store = await Store.open(":memory:");
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}") }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + "/desktop/latest.yml")).status, 404);
  } finally {
    server.close();
  }
});

test("/desktop/Gornichnaya-Setup.exe и старые версии — переадресация на нынешний установщик из latest.yml", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-desktop-"));
  fs.writeFileSync(path.join(dir, "latest.yml"), "version: 0.1.36\nfiles:\n  - url: Gornichnaya-Setup-0.1.36.exe\npath: Gornichnaya-Setup-0.1.36.exe\n");
  fs.writeFileSync(path.join(dir, "Gornichnaya-Setup-0.1.36.exe"), Buffer.from("MZnew"));
  const store = await Store.open(":memory:");
  const server = createApi({ store, pipeline: new Pipeline(store, async () => "{}"), desktopDir: dir }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const old of ["/desktop/Gornichnaya-Setup.exe", "/desktop/Gornichnaya-Setup-0.1.28.exe"]) {
      const r = await fetch(base + old, { redirect: "manual" });
      assert.equal(r.status, 302, old);
      assert.equal(r.headers.get("location"), "/desktop/Gornichnaya-Setup-0.1.36.exe", old);
    }
    const got = await fetch(base + "/desktop/Gornichnaya-Setup.exe");
    assert.equal(Buffer.from(await got.arrayBuffer()).toString(), "MZnew", "по постоянной ссылке скачивается не нынешний установщик");
    assert.equal((await fetch(base + "/desktop/Other-0.1.28.exe", { redirect: "manual" })).status, 404, "чужое имя переадресовано");
    // latest.yml указывает на файл, которого нет (выпуск не дописался), — 404, а не переадресация по кругу.
    fs.writeFileSync(path.join(dir, "latest.yml"), "version: 0.1.37\npath: Gornichnaya-Setup-0.1.37.exe\n");
    assert.equal((await fetch(base + "/desktop/Gornichnaya-Setup.exe", { redirect: "manual" })).status, 404);
    fs.writeFileSync(path.join(dir, "latest.yml"), "version: x\npath: ../secret.exe\n");
    assert.equal((await fetch(base + "/desktop/Gornichnaya-Setup.exe", { redirect: "manual" })).status, 404, "путь из latest.yml вне папки");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
