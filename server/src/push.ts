import crypto from "node:crypto";
import * as webpush from "web-push";
import type { Store, User } from "./db.ts";
import type { Emotion } from "./personas.ts";
import type { Button } from "./scheduler.ts";

// Web Push на телефон и ПК: сервер шлёт короткий JSON, service worker показывает уведомление с кнопками.
// Кнопка без открытого приложения — подписанная ссылка (HMAC): браузер шлёт её на /api/push/act без входа,
// сервер проверяет подпись, срок и что кнопка была в этом уведомлении.

export interface PushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  actions: { action: string; title: string }[];
  /** Подписанный список кнопок; действие — номер в нём. */
  act: string;
}

const ACTION_TTL_MS = 36 * 60 * 60_000;
const SNOOZE_MIN = 30;

export const stripHtml = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export class Push {
  constructor(private store: Store, private keys: PushKeys) {
    if (this.ready) webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  }

  get ready() {
    return Boolean(this.keys.publicKey && this.keys.privateKey);
  }
  get publicKey() {
    return this.keys.publicKey;
  }

  /** Подпись действий для кнопок: кому, до какого времени, список data кнопок. */
  sign(userId: number, buttons: Button[], now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ u: userId, e: now + ACTION_TTL_MS, b: buttons.map((b) => b.data) })).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }
  verify(token: string, now = Date.now()): { userId: number; buttons: string[] } | null {
    const [body, mac] = token.split(".");
    if (!body || !mac || mac.length !== this.mac(body).length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(this.mac(body)))) return null;
    try {
      const d = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u: number; e: number; b: string[] };
      if (typeof d.u !== "number" || typeof d.e !== "number" || !Array.isArray(d.b) || d.e < now) return null;
      return { userId: d.u, buttons: d.b };
    } catch {
      return null;
    }
  }
  private mac(body: string) {
    return crypto.createHmac("sha256", this.keys.privateKey || "no-key").update(body).digest("base64url");
  }

  /** Что показать: заголовок — первая строка, остальное — тело; кнопки + «Через 30 мин» у напоминаний с кнопками. */
  payload(u: User, text: string, buttons: Button[] = []): PushPayload {
    const plain = stripHtml(text).trim();
    const nl = plain.indexOf("\n");
    const title = (nl > 0 ? plain.slice(0, nl) : plain).slice(0, 80) || "Горничная";
    const body = (nl > 0 ? plain.slice(nl + 1).trim() : "").slice(0, 600);
    const all = buttons.length ? [...buttons, { text: `⏰ Через ${SNOOZE_MIN} мин`, data: "snooze" }] : [];
    return {
      title, body, tag: `maid-${Date.now()}`, url: "/",
      actions: all.slice(0, 3).map((b, i) => ({ action: String(i), title: b.text })),
      act: all.length ? this.sign(u.id, all) : "",
    };
  }

  /** Разослать на все подписки пользователя; мёртвые (404/410) удалить. */
  async send(u: User, text: string, _emotion: Emotion, buttons?: Button[]): Promise<number> {
    if (!this.ready) return 0;
    const subs = await this.store.pushSubsOf(u.id);
    if (!subs.length) return 0;
    const payload = JSON.stringify(this.payload(u, text, buttons));
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json) }, payload, { TTL: 6 * 3600, urgency: "high" });
        await this.store.touchPushSub(s.endpoint);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await this.store.dropPushSub(s.endpoint);
        else console.error("[push]", u.id, s.label, code ?? e);
      }
    }
    return sent;
  }

  /** Кнопка из уведомления: data выбранной кнопки, если подпись верна. */
  action(token: string, index: number): { userId: number; data: string; all: string[] } | null {
    const v = this.verify(token);
    if (!v || !v.buttons[index]) return null;
    return { userId: v.userId, data: v.buttons[index], all: v.buttons };
  }

  static readonly snoozeMinutes = SNOOZE_MIN;
}
