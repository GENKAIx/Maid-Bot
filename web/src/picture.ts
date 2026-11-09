// Картинка к сообщению (чек, билет, скриншот): взять из буфера или перетаскивания и уменьшить перед отправкой.

export interface Picture {
  mime: string;
  /** base64 без префикса data: */
  data: string;
  /** Для миниатюры. */
  url: string;
}

/** Первая картинка из буфера обмена или перетаскивания. */
export function imageFrom(dt: DataTransfer | null): File | null {
  return [...(dt?.files ?? [])].find((f) => f.type.startsWith("image/")) ??
    [...(dt?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile() ?? null;
}

/** До 1600 px по большей стороне и в JPEG: на сервер уходят сотни килобайт, а не мегабайты с телефона. */
export async function shrinkImage(file: File, max = 1600): Promise<Picture> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff"; // прозрачный PNG — на белом, как бумага чека
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const url = c.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1), url };
}
