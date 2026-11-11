import type { ReactNode } from "react";

// Рисунки экрана «Профиль»: значки дебафов и бафов (заливкой, как иконки эффектов в MMORPG), значки характеристик (контуром)
// и значки характеристик (контуром). Всё — SVG 24×24 в currentColor, цвет задаёт CSS.

const fill = (d: string) => <path d={d} fill="currentColor" fillRule="evenodd" />;
const line = (children: ReactNode) => (
  <g fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">{children}</g>
);

export const AURA: Record<string, ReactNode> = {
  skull: fill("M12 2C7 2 3.5 5.6 3.5 10.2c0 2.7 1.2 4.6 3 5.8V19a1 1 0 0 0 1 1H9v-2.2h2V20h2v-2.2h2V20h1.5a1 1 0 0 0 1-1v-3c1.8-1.2 3-3.1 3-5.8C20.5 5.6 17 2 12 2ZM8.4 9.2a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Zm7.2 0a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4ZM12 13.6l1.2 2.2h-2.4l1.2-2.2Z"),
  heart: fill("M12 21s-7.5-4.6-9.5-9.4C1.2 8.4 3.2 4.5 6.9 4.5c2.1 0 3.9 1.2 5.1 3 1.2-1.8 3-3 5.1-3 3.7 0 5.7 3.9 4.4 7.1C19.5 16.4 12 21 12 21Z"),
  heartBreak: <>
    {fill("M11.1 6.4C9.9 5.2 8.4 4.5 6.9 4.5c-3.7 0-5.7 3.9-4.4 7.1 1.6 3.9 6.6 7.5 8.6 8.8l-1.3-4.9 2.3-2.7-2.4-3 1.4-3.4Z")}
    {fill("M12.9 20.4c2-1.3 7-4.9 8.6-8.8 1.3-3.2-.7-7.1-4.4-7.1-1.6 0-3 .6-4.1 1.8l-1.2 3.4 2.4 3-2.3 2.8 1 4.9Z")}
  </>,
  statDown: fill("M5.6 3h2.6v10.6h3L6.9 19 2.6 13.6h3V3ZM13 6.5h8.5V9H13V6.5Zm0 5h7V14h-7v-2.5Zm0 5h5.5V19H13v-2.5Z"),
  statUp: fill("M15.8 21h2.6V10.4h3L17.1 5l-4.3 5.4h3V21ZM2.5 6.5H11V9H2.5V6.5Zm1.5 5h7V14H4v-2.5Zm1.5 5H11V19H5.5v-2.5Z"),
  sleep: line(<><path d="M3 13.5h5.5L3 20.5h5.5" /><path d="M10 7.5h4.5l-4.5 6h4.5" /><path d="M16.5 3h4.5l-4.5 5.5H21" /></>),
  drop: fill("M12 2.5S5.5 9.6 5.5 14.6a6.5 6.5 0 0 0 13 0C18.5 9.6 12 2.5 12 2.5Zm-3 12.3c0-1 .3-2 .9-3 .2-.3.6-.1.6.2-.1 1.6.4 3.1 1.6 4.1.3.2.1.7-.3.6A3 3 0 0 1 9 14.8Z"),
  eyeOff: line(<><path d="M2.5 12s3.5-6.2 9.5-6.2 9.5 6.2 9.5 6.2-3.5 6.2-9.5 6.2S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /><path d="M4 4l16 16" /></>),
  shield: fill("M12 2 4 5v6.2c0 5 3.4 9.4 8 10.8 4.6-1.4 8-5.8 8-10.8V5l-8-3Zm0 3.2-5 1.9v4.1c0 3.4 2.1 6.4 5 7.6V5.2Z"),
  shieldBreak: <>
    {fill("M11.2 2.3 4 5v6.2c0 4.6 2.9 8.7 7 10.4l-.9-5.1 2.3-3-2.5-3.3 1.3-7.9Z")}
    {fill("M12.9 2.4 20 5v6.2c0 4.7-3 8.8-7.2 10.5l.9-5.6-2.1-3 2.4-3.3-1.1-7.4Z")}
  </>,
  fire: fill("M12 2s1 3.4-1.4 6.2C8.8 10.3 6 12 6 15.6a6 6 0 0 0 12 0c0-2.6-1.4-4.4-2.3-5.3.1 1.7-.6 3-1.7 3.5.6-3.4-.6-7.9-2-11.8Zm0 18.5a3 3 0 0 1-3-3c0-1.8 1.4-2.9 2.3-4.1.2 1.3.9 2 1.7 2.3.7-.6 1-1.4 1-2.3.7.8 1 1.8 1 2.9a3 3 0 0 1-3 3.2Z"),
  plus: fill("M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5V3Z"),
  bolt: fill("M13.5 2 4 13.6h6.5L9 22l11-12.6h-6.7L13.5 2Z"),
  muscle: fill("M7.2 20.5c-2.3 0-3.7-1.7-3.7-3.8 0-2.5 1.5-4.9 2.4-7.6.6-1.9.9-4.1 2.7-5.4 1.3-.9 3-.7 3.7.4.7 1.1-.1 2.3-1.2 2.7l-1.3.5c-.2 1.6-.7 3.2-.7 4.7 1.4-1.8 3.5-2.7 5.8-2.7 3.7 0 6.6 2.8 6.6 5.8 0 3-2.5 5.4-5.8 5.4H7.2Z"),
  wing: fill("M2.5 21c3.7-.3 7-1.8 9.6-4.4L9 16.4l4.5-1.9 1.8-2.5-3.6.4 4.6-2.6 1.4-2.5-3 .4 4.4-2.7L21.5 2c-4.7 1.6-9.2 3.6-12.8 6.8C6 11.2 3.6 15.4 2.5 21Z"),
  target: line(<><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.2" fill="currentColor" /><path d="M12 1.8v4M12 18.2v4M1.8 12h4M18.2 12h4" /></>),
  pill: <>
    {fill("M8.6 3.4a5 5 0 0 1 7.1 0 5 5 0 0 1 0 7.1L13 13.2 6 6.1l2.6-2.7Z")}
    <path d="M13 13.2 10.4 15.9a5 5 0 0 1-7.1-7.1L6 6.1l7 7.1Z" fill="currentColor" opacity={0.45} />
  </>,
  sneeze: fill("M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM8.6 9.2l2.4 1.2-2.4 1.2-.6-1.2.6-1.2Zm6.8 0 .6 1.2-.6 1.2-2.4-1.2 2.4-1.2ZM9 15.2c.8-1.2 1.8-1.8 3-1.8s2.2.6 3 1.8l-1 .7c-.6-.8-1.2-1.2-2-1.2s-1.4.4-2 1.2l-1-.7Z"),
  leaf: fill("M20.5 3.5C11 3.6 4.6 7.6 4.6 14c0 1.5.4 2.9 1 4.1L3 20.7 4.3 22l2.6-2.6c1.2.7 2.6 1.1 4.1 1.1 6.4 0 10.4-6.4 9.5-17Zm-4.3 4.3-8.4 8.4-.8-.8 8.4-8.4.8.8Z"),
};

/** Значок дебафа или бафа: сначала по словам в названии и заметке, иначе — по виду. */
export function auraIcon(kind: "debuff" | "buff", category: string, text: string): string {
  const t = text.toLowerCase().replace(/ё/g, "е");
  const rules: [RegExp, string, string][] = [
    [/сон|сплю|спать|бессонн|недосып|устал/, "sleep", "sleep"],
    [/кров|давлен|сахар|вод[аые]|пить/, "drop", "drop"],
    [/глаз|зрен|экран/, "eyeOff", "target"],
    [/сердц|пульс|тревог|стресс|настроен/, "heartBreak", "heart"],
    [/изжог|воспал|температур|жар|остр|пожар/, "fire", "fire"],
    [/иммун|простуд|болею|защит/, "shieldBreak", "shield"],
    [/кофе|энерг|бодр|сил[аы]?\b/, "statDown", "bolt"],
    [/спорт|трениров|зал|мышц|отжим|присед/, "statDown", "muscle"],
    [/бег|прогул|ходьб|легк|свеж/, "statDown", "wing"],
    [/фокус|концентрац|внимани|работ/, "eyeOff", "target"],
    [/таблет|лекарств|ибупроф|аспирин|антибиот/, "pill", "pill"],
    [/аллерг|чих|насморк|пыльц/, "sneeze", "plus"],
    [/яд|отрав|алкогол|вин[оа]|пив|курен|сигарет/, "skull", "plus"],
  ];
  for (const [re, bad, good] of rules) if (re.test(t)) return kind === "debuff" ? bad : good;
  const byCat: Record<string, [string, string]> = {
    allergy: ["sneeze", "plus"], food: ["skull", "leaf"], med: ["pill", "pill"], condition: ["heartBreak", "heart"],
    body: ["shieldBreak", "muscle"], habit: ["statDown", "statUp"], other: ["statDown", "statUp"],
  };
  const [bad, good] = byCat[category] ?? byCat.other;
  return kind === "debuff" ? bad : good;
}

export function AuraGlyph({ name }: { name: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{AURA[name] ?? AURA.statDown}</svg>;
}

const STAT: Record<string, ReactNode> = {
  age: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4M8.8 15l2.2 2.2 4.4-4.4" /></>,
  height: <><path d="M3.8 15.6 15.6 3.8l4.6 4.6L8.4 20.2z" /><path d="M7.4 12l1.8 1.8M10 9.4l1.2 1.2M12.6 6.8l1.8 1.8" /></>,
  weight: <><path d="M9.2 7.5a2.8 2.8 0 1 1 5.6 0" /><path d="M6.4 7.5h11.2l2 12.5H4.4z" /><path d="M10.2 12.5l1.8 3 1.8-3" /></>,
  bmi: <><path d="M4 16.5a8 8 0 0 1 16 0" /><path d="M12 16.5l3.6-5" /><circle cx="12" cy="16.5" r="1" /></>,
  sleep: <path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1Z" />,
  steps: <><path d="M7.5 4.5c1.7 0 2.6 1.7 2.6 4 0 2-1 3.6-2.6 3.6S5 10.5 5 8.5c0-2.3.8-4 2.5-4Z" /><path d="M5.6 15h3.8v1.6a1.9 1.9 0 0 1-3.8 0z" /><path d="M16.5 8.5c1.7 0 2.5 1.7 2.5 4 0 2-1 3.6-2.5 3.6s-2.6-1.6-2.6-3.6c0-2.3.9-4 2.6-4Z" /><path d="M14.6 19h3.8v1a1.9 1.9 0 0 1-3.8 0z" /></>,
  water: <path d="M12 3.5S6.5 9.6 6.5 14a5.5 5.5 0 0 0 11 0c0-4.4-5.5-10.5-5.5-10.5Z" />,
  deeds: <><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4.5v1.5A3 3 0 0 0 7.4 10.5M17 6h2.5v1.5a3 3 0 0 1-2.9 3" /><path d="M12 14v3.5M8.5 20.5h7M9.5 17.5h5" /></>,
};

export function StatGlyph({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {STAT[name] ?? STAT.deeds}
    </svg>
  );
}
