// «Перекрасить Рину» (20.11.2026): цвет волос и глаз горничной выбирают на сайте («Настройки → Горничная → Внешность»),
// хранится в users.maid_hair / users.maid_eyes, виджет ПК перекрашивает по нему анимации (desktop/renderer/look.js), а сама
// Рина знает свой цвет: он подставляется в её карточку (personas.ts, rina) — в каждом промпте с её голосом.
// id, порядок и названия — те же, что LOOK_HAIR / LOOK_EYES в desktop/renderer/look.js (сверяет test/look.test.ts);
// первый — свой цвет (он же DEFAULT у столбцов в db.ts, шаг 19).

/** Волосы: id для z.enum в POST /api/settings. */
export const MAID_HAIR = ["red", "brown", "gold", "silver", "violet", "black"] as const;
/** Глаза: id для z.enum в POST /api/settings. */
export const MAID_EYES = ["violet", "green", "blue", "amber"] as const;
export type MaidHair = (typeof MAID_HAIR)[number];
export type MaidEyes = (typeof MAID_EYES)[number];

/** Как цвет звучит в карточке Рины («… волосы», «… глаза») — названия кнопок на сайте те же. */
export const HAIR_NAMES: Record<MaidHair, string> = {
  red: "тёмно-красные", brown: "каштановые", gold: "золотистые", silver: "серебристые", violet: "фиолетовые", black: "чёрные",
};
export const EYES_NAMES: Record<MaidEyes, string> = { violet: "фиолетовые", green: "зелёные", blue: "синие", amber: "янтарные" };

/** Внешность из строки пользователя (User подходит целиком). */
export interface MaidLook {
  maid_hair?: string | null;
  maid_eyes?: string | null;
}

const isHair = (x: unknown): x is MaidHair => (MAID_HAIR as readonly unknown[]).includes(x);
const isEyes = (x: unknown): x is MaidEyes => (MAID_EYES as readonly unknown[]).includes(x);

/** Названия цветов для карточки; нет поля или незнакомый id — свой цвет (тёмно-красные, фиолетовые). */
export function lookNames(look?: MaidLook): { hair: string; eyes: string } {
  const h = look?.maid_hair, e = look?.maid_eyes;
  return { hair: HAIR_NAMES[isHair(h) ? h : MAID_HAIR[0]], eyes: EYES_NAMES[isEyes(e) ? e : MAID_EYES[0]] };
}
