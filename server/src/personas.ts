import { lookNames, type MaidLook } from "./look.ts";
import { fill, prompt, promptSpec } from "./prompts.ts";
import { addressRule, callAs } from "./you.ts";

// Характеры горничной. Голос задаёт промпт; короткие фразы — для ответов без LLM.
// 27.11.2026: тексты голосов, карточка Рины и общие правила правятся в админке → «Промпты» (persona.strict / kind / sassy / chill,
// persona.rina, persona.house_rules; тексты «как в коде» — в prompts.ts). Константы ниже — эти тексты «как в коде»; persona()
// берёт действующие версии через prompt().

export const EMOTIONS = ["neutral", "happy", "proud", "worried", "stern", "sleepy", "surprised", "sad", "teasing", "awkward", "deadpan"] as const;
export type Emotion = (typeof EMOTIONS)[number];

export interface Persona {
  id: string;
  name: string;
  /** Как говорить «как в коде» (промпт persona.<id>); в промпты идёт действующая версия — persona().voice. */
  voice: string;
  saved: string[];
  undone: string;
  clarify: string;
  failed: string;
  /** Вопрос под вечерним итогом, перед оценкой дня (звёзды в виджете, числа в Telegram). */
  rate: string;
  /** Первая строка облачка «Завтра» (report.ts, tomorrowText). */
  tomorrow: string;
}

/** Текст «как в коде» промпта id (prompts.ts). */
const def = (id: string): string => promptSpec(id)!.def;

export const PERSONAS: Record<string, Persona> = {
  strict: {
    id: "strict",
    name: "Строгая, но заботливая",
    voice: def("persona.strict"),
    saved: ["Записала.", "Внесла.", "Готово, записано."],
    undone: "Убрала, как будто и не было.",
    clarify: "Уточните, пожалуйста:",
    failed: "Не получилось записать. Попробую ещё раз чуть позже — сообщение я сохранила.",
    rate: "На сколько оцениваете этот день?",
    tomorrow: "Хозяин, вот ваши планы на завтра.",
  },
  kind: {
    id: "kind",
    name: "Добрая",
    voice: def("persona.kind"),
    saved: ["Записала! 🌸", "Всё сохранила.", "Есть, записано."],
    undone: "Хорошо, убрала.",
    clarify: "Подскажи, пожалуйста:",
    failed: "Ой, не вышло записать. Сообщение у меня — попробую ещё раз.",
    rate: "А на сколько оценишь этот день?",
    tomorrow: "Хозяин, вот что у тебя завтра 🌸",
  },
  sassy: {
    id: "sassy",
    name: "Дерзкая",
    voice: def("persona.sassy"),
    saved: ["Записала. Не благодари.", "Внесла, так уж и быть.", "Есть. Куда бы ты без меня."],
    undone: "Ладно, стёрла. Передумывать — твоё любимое.",
    clarify: "Так, а поконкретнее?",
    failed: "Сервис капризничает. Сообщение не потеряла, дожму позже.",
    rate: "Ну и на сколько тянет этот день?",
    tomorrow: "Хозяин, завтра у тебя вот что. Не проспи.",
  },
  chill: {
    id: "chill",
    name: "Расслабленная",
    voice: def("persona.chill"),
    saved: ["Записала, норм.", "Ага, есть.", "Сохранила."],
    undone: "Окей, убрала.",
    clarify: "Слушай, уточни:",
    failed: "Чё-то не записалось. Сообщение у меня, попробую ещё.",
    rate: "На сколько оценишь этот день?",
    tomorrow: "Хозяин, глянь, что завтра:",
  },
};

/** Кто она — одна на все характеры (характер меняет только манеру речи). Дописывается к голосу в каждом промпте (persona()).
 * 17.11.2026: без карточки на «какого цвета у тебя глаза» отвечала «у меня нет глаз, я горничная из дневника».
 * 20.11.2026, «Перекрасить Рину»: цвет волос и глаз — из настройки хозяина (look.ts); без неё — свои цвета, текст как был (RINA).
 * 27.11.2026: текст — промпт persona.rina ({{hair}}, {{eyes}}), правится в админке. */
export const rina = (look?: MaidLook): string => prompt("persona.rina", lookNames(look));
/** Карточка «как в коде» со своими цветами (тёмно-красные волосы, фиолетовые глаза). */
export const RINA = fill(def("persona.rina"), lookNames());

/** Общие правила для всех характеров — дописываются к голосу в каждом промпте (persona()).
 * Интимное: модель без прямого указания перестраховывалась — вырезала из записи и читала нотации («больше не говорите»).
 * Политика: горничная её не обсуждает (решение владельца 14.11.2026).
 * 27.11.2026: текст «как в коде» промпта persona.house_rules; в голос идёт действующая версия. */
export const HOUSE_RULES = def("persona.house_rules");

/** Характер по id и внешность хозяйской настройки (обычно сам пользователь: persona(u.persona, u)); без неё — свои цвета.
 *  20.11.2026, «О вас»: обращение (you.ts) — строкой в голос и в готовую фразу «Хозяин, вот ваши планы на завтра». */
export const persona = (id: string | undefined, who?: MaidLook & { address?: string; name?: string }): Persona => {
  const p = PERSONAS[id ?? ""] ?? PERSONAS.strict;
  const rule = addressRule(who);
  const voice = prompt(`persona.${Object.hasOwn(PERSONAS, p.id ?? "") ? p.id : "strict"}`);
  return { ...p, voice: `${voice} ${rina(who)} ${prompt("persona.house_rules")}${rule ? ` ${rule}` : ""}`, tomorrow: callAs(p.tomorrow, who) };
};

export function pick<T>(list: T[], seed: number): T {
  return list[Math.abs(seed) % list.length];
}
