// Линейные иконки меню: одна толщина, один размер, цвет — от текста.

const PATHS: Record<string, string> = {
  today: "M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  diary: "M6 4h11a1 1 0 0 1 1 1v15H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zM5 18a2 2 0 0 1 2-2h11M9 8h6M9 11h4",
  plans: "M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM4 10h16M8 4v4M16 4v4M8 14h3",
  habits: "M5 5h14v14H5zM8.5 12.2l2.3 2.3 4.7-4.9",
  health: "M12 19.5s-7-4.3-7-9.4A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.1c0 5.1-7 9.4-7 9.4z",
  money: "M4 8h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8zM4 8l11-3.5V8M16 13.5h.5",
  stats: "M5 19V11M10 19V6M15 19v-5M20 19V9M3.5 19h18",
  widget: "M4 5.5h16v11H4zM4 9h16M7.5 12.5h6M9 19.5h6M12 16.5v3",
  settings: "M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM12 3.5l1.4 2.2 2.6-.5.6 2.6 2.3 1.3-1 2.4 1 2.4-2.3 1.3-.6 2.6-2.6-.5-1.4 2.2-1.4-2.2-2.6.5-.6-2.6-2.3-1.3 1-2.4-1-2.4 2.3-1.3.6-2.6 2.6.5z",
  trash: "M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.5a2 2 0 0 0 2 1.5h5.4a2 2 0 0 0 2-1.5L17.5 7M9.5 7V4.5h5V7",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  catalog: "M12 6.5C10 5 7.5 4.5 4.5 4.5v13c3 0 5.5.5 7.5 2 2-1.5 4.5-2 7.5-2v-13c-3 0-5.5.5-7.5 2zM12 6.5v13",
};

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const thick = name === "more";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={thick ? 3 : 1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
