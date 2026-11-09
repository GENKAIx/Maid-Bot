/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);

// Свежий Chrome для рендера не скачивается (сеть) — берём уже скачанный из соседнего проекта.
Config.setBrowserExecutable(
  "C:/Users/fazek/Desktop/ИИ Мульты/6 Фейковый прогресс/node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe",
);
Config.setChromiumOpenGlRenderer("angle");
