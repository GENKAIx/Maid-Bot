import type { Store, User } from "./db.ts";
import { NOTICES_KEEP, type NoticeKind } from "./notices.ts";
import type { Emotion } from "./personas.ts";
import type { Button, Send } from "./scheduler.ts";

// Общий Send: всё, что горничная пишет первой, уходит всюду, где человек есть, — строка в ленте (notices: сайт, виджет на ПК),
// Web Push на все подписки браузеров и Telegram, если он привязан. Собирается один раз в index.ts.
// Кнопка-ссылка (Button.url — оплата подписки) показывается только в Telegram: в ленту и push она не идёт.

/** Куда письмо на деле легло: лента, сколько push-подписок его приняли, Telegram. */
export interface Delivered {
  feed: boolean;
  push: number;
  telegram: boolean;
}
/** Тот же Send, но без исключений и с ответом, куда письмо легло (письма о подписке, ответы на обращения — billing.notify). */
export type Deliver = (u: User, text: string, emotion: Emotion, buttons?: Button[], kind?: NoticeKind) => Promise<Delivered>;

export interface SendParts {
  store: Pick<Store, "addNotice" | "pruneNotices">;
  push: { send(u: User, text: string, emotion: Emotion, buttons?: Button[]): Promise<number> };
  /** Отправка в Telegram (bot.ts send); бота нет — null. */
  telegram?: Send | null;
  /** Сбой отправки в Telegram — в счёт правила send_fail (alerts.ts). */
  onTelegramFail?: (e: unknown) => void;
}

export function makeSend(p: SendParts): { send: Send; deliver: Deliver } {
  const own = (buttons?: Button[]) => buttons?.filter((b) => !b.url);
  const feed = async (u: User, text: string, emotion: Emotion, buttons?: Button[], kind?: NoticeKind) => {
    const b = own(buttons);
    await p.store.addNotice(u.id, text, emotion, b?.length ? JSON.stringify(b) : "", kind ?? "");
    await p.store.pruneNotices(u.id, NOTICES_KEEP);
  };
  const telegram = async (u: User, text: string, emotion: Emotion, buttons?: Button[]) => {
    try {
      await p.telegram!(u, text, emotion, buttons);
    } catch (e) {
      p.onTelegramFail?.(e);
      throw e;
    }
  };

  /** Не записалось в ленту или Telegram не принял — исключение (планировщик решает, что с ним делать). */
  const send: Send = async (u, text, emotion, buttons, kind) => {
    await feed(u, text, emotion, buttons, kind);
    const jobs: Promise<unknown>[] = [p.push.send(u, text, emotion, own(buttons))];
    if (p.telegram && u.chat_id) jobs.push(telegram(u, text, emotion, buttons));
    await Promise.all(jobs);
  };

  const deliver: Deliver = async (u, text, emotion, buttons, kind) => {
    const fed = await feed(u, text, emotion, buttons, kind).then(() => true, (e) => (console.error("[send] лента", u.id, (e as Error).message), false));
    const [pushed, tg] = await Promise.all([
      p.push.send(u, text, emotion, own(buttons)).catch((e) => (console.error("[send] push", u.id, (e as Error).message), 0)),
      p.telegram && u.chat_id
        ? telegram(u, text, emotion, buttons).then(() => true, (e) => (console.error("[send] telegram", u.id, (e as Error).message), false))
        : false,
    ]);
    return { feed: fed, push: pushed, telegram: tg };
  };

  return { send, deliver };
}
