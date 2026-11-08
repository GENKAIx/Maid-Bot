import { hashPassword, issueToken } from "./auth.ts";
import { config } from "./config.ts";
import { Store } from "./db.ts";

// Учётные записи из командной строки:
//   npm run user -- create <логин> --password <пароль> [--chat <chat id>] [--name <имя>]
//   npm run user -- password <логин> --password <новый>
//   npm run user -- link <логин> --chat <chat id>     привязать Telegram (или взять запись бота как есть)
//   npm run user -- token <логин> [--label <устройство>]   ключ для десктопа или айфона
//   npm run user -- list

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const [cmd, loginName] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const store = await Store.open(config.databaseUrl || config.dbFile);

try {
  if (cmd === "list") {
    for (const u of await store.users()) console.log(`#${u.id}  ${u.login ?? "(без логина)"}  ${u.chat_id ? "telegram ✓" : ""}  ${u.tz}`);
  } else if (!loginName) {
    throw new Error("укажите логин");
  } else if (cmd === "create") {
    const password = arg("password");
    if (!password || password.length < 8) throw new Error("пароль — от 8 символов: --password …");
    const chat = arg("chat");
    const existing = chat ? await store.userByChat(chat) : undefined;
    if (existing) {
      // У бота уже есть запись по этому чату — даём ей логин, данные не теряются.
      await store.updateUser(existing.id, { login: loginName.toLowerCase(), password_hash: await hashPassword(password) });
      console.log(`Логин «${loginName}» выдан записи #${existing.id} (Telegram уже привязан).`);
    } else {
      const u = await store.createUser({
        login: loginName, passwordHash: await hashPassword(password), name: arg("name"), tz: config.defaultTimezone, chatId: chat ?? null,
      });
      console.log(`Создан #${u.id} «${u.login}».`);
    }
  } else {
    const u = await store.userByLogin(loginName);
    if (!u) throw new Error(`нет пользователя «${loginName}»`);
    if (cmd === "password") {
      const password = arg("password");
      if (!password || password.length < 8) throw new Error("пароль — от 8 символов: --password …");
      await store.updateUser(u.id, { password_hash: await hashPassword(password) });
      console.log("Пароль обновлён.");
    } else if (cmd === "link") {
      const chat = arg("chat");
      if (!chat) throw new Error("нужен --chat <chat id>");
      await store.updateUser(u.id, { chat_id: chat });
      console.log("Telegram привязан.");
    } else if (cmd === "token") {
      console.log(await issueToken(store, u.id, arg("label") ?? "cli"));
    } else throw new Error(`не знаю команду «${cmd}»`);
  }
} catch (e) {
  console.error("Ошибка:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await store.close();
}
