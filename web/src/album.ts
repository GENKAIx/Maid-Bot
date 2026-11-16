// Альбом реакций (screens/Album.tsx): все анимации горничной в порядке альбома. Увиденные в виджете на ПК открыты и
// подписаны коротким названием, остальные — силуэты без подсказок: как их получить, человек догадывается сам.
// Список имён — тот же, что ALBUM на сервере (server/src/album.ts).

export interface AlbumCard {
  id: string;
  name: string;
}

export const ALBUM_CARDS: AlbumCard[] = [
  { id: "idle", name: "Ждёт" },
  { id: "think", name: "Думает" },
  { id: "sleep", name: "Спит" },
  { id: "offline", name: "Нет связи" },
  { id: "remind", name: "Колокольчик" },
  { id: "angry", name: "Недовольна" },
  { id: "clean", name: "Метёт" },
  { id: "hello", name: "Машет" },
  { id: "happy", name: "Радуется" },
  { id: "proud", name: "Гордится" },
  { id: "write", name: "Пишет" },
  { id: "done", name: "Галочка" },
  { id: "streak", name: "Серия" },
  { id: "sad", name: "Грустит" },
  { id: "worried", name: "Тревожится" },
  { id: "surprised", name: "Удивлена" },
  { id: "neutral", name: "Спокойна" },
  { id: "listen", name: "Слушает" },
  { id: "tea", name: "Пьёт чай" },
  { id: "bow", name: "Кланяется" },
  { id: "excited", name: "В восторге" },
  { id: "smitten", name: "Смущена" },
  { id: "giggle", name: "Хихикает" },
  { id: "gasp", name: "«Ой!»" },
  { id: "smug", name: "Довольна собой" },
  { id: "refuse", name: "Отказ" },
  { id: "forget", name: "Стирает память" },
];

/** Сколько открыто из всего альбома. */
export function albumCount(seen: Record<string, string>) {
  return ALBUM_CARDS.filter((c) => seen[c.id]).length;
}
