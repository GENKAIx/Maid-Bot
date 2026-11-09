import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { navigate } from "../router";

// Каталог для разработки: главы — web/src/catalog/NN-имя.md, рисуются своим маленьким Markdown.
// Кроме обычного: блоки ```flow (шаги «Название | описание») и ```maid (плитки анимаций), картинка ![…](maid:имя).

const FILES = import.meta.glob("../catalog/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

interface Chapter { slug: string; num: number; title: string; lead: string; body: string }

const CHAPTERS: Chapter[] = Object.entries(FILES)
  .map(([path, raw]) => {
    const name = path.split("/").pop()!.replace(/\.md$/, "");
    const [, num = "0", slug = name] = name.match(/^(\d+)-(.+)$/) ?? [];
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const meta: Record<string, string> = {};
    for (const line of fm?.[1].split(/\r?\n/) ?? []) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2];
    }
    return { slug, num: Number(num), title: meta.title ?? slug, lead: meta.lead ?? "", body: fm ? raw.slice(fm[0].length) : raw };
  })
  .sort((a, b) => a.num - b.num);

const slugify = (s: string) => s.toLowerCase().replace(/[`*]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

// --- Разбор Markdown в блоки ---

type Block =
  | { t: "h"; level: 2 | 3; text: string; id: string }
  | { t: "p"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "note"; text: string }
  | { t: "code"; lang: string; lines: string[] };

const cells = (line: string) =>
  line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

function parse(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```\s*(\S*)/);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      out.push({ t: "code", lang: fence[1], lines: body });
      i++;
      continue;
    }
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) { out.push({ t: "h", level: h[1].length as 2 | 3, text: h[2], id: slugify(h[2]) }); i++; continue; }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
      const [head, , ...rest] = rows;
      out.push({ t: "table", head, rows: rest });
      continue;
    }
    if (line.startsWith(">")) {
      const text: string[] = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) text.push(lines[i].replace(/^>\s?/, ""));
      out.push({ t: "note", text: text.join(" ") });
      continue;
    }
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      for (; i < lines.length && (/^\s*([-*]|\d+\.)\s/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        if (/^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        else items[items.length - 1] += " " + lines[i].trim();
      }
      out.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    const text: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{2,3}\s|\||>|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]); i++) text.push(lines[i].trim());
    out.push({ t: "p", text: text.join(" ") });
  }
  return out;
}

// --- Строчная разметка ---

function Maid({ name, size }: { name: string; size: number }) {
  return <img className="cat-maid" src={`/maid/${name}.webp`} alt={name} width={size} height={Math.round(size * 1.067)} loading="lazy" />;
}

function mark(text: string, q: string): ReactNode {
  if (!q) return text;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{mark(text.slice(at + q.length), q)}</>;
}

function Inline({ text, q }: { text: string; q: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|!\[[^\]]*\]\(maid:[\w-]+\))/g);
  return (
    <>
      {parts.map((p, k) => {
        if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return <code key={k}>{mark(p.slice(1, -1), q)}</code>;
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <b key={k}>{mark(p.slice(2, -2), q)}</b>;
        const img = p.match(/^!\[[^\]]*\]\(maid:([\w-]+)\)$/);
        if (img) return <Maid key={k} name={img[1]} size={30} />;
        return <Fragment key={k}>{mark(p, q)}</Fragment>;
      })}
    </>
  );
}

function BlockView({ b, q }: { b: Block; q: string }) {
  switch (b.t) {
    case "h": {
      const H = b.level === 2 ? "h2" : "h3";
      return <H id={b.id} className="cat-h"><Inline text={b.text} q={q} /></H>;
    }
    case "p": return <p><Inline text={b.text} q={q} /></p>;
    case "ul": return <ul>{b.items.map((t, k) => <li key={k}><Inline text={t} q={q} /></li>)}</ul>;
    case "ol": return <ol>{b.items.map((t, k) => <li key={k}><Inline text={t} q={q} /></li>)}</ol>;
    case "note": return <aside className="cat-note"><Inline text={b.text} q={q} /></aside>;
    case "table":
      return (
        <div className="cat-table">
          <table>
            <thead><tr>{b.head.map((c, k) => <th key={k}><Inline text={c} q={q} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}><Inline text={c} q={q} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "code":
      if (b.lang === "flow") {
        return (
          <ol className="cat-flow">
            {b.lines.filter((l) => l.trim()).map((l, k) => {
              const [title, ...rest] = cells(l);
              return <li key={k}><b><Inline text={title} q={q} /></b><span><Inline text={rest.join(" | ")} q={q} /></span></li>;
            })}
          </ol>
        );
      }
      if (b.lang === "maid") {
        return (
          <div className="cat-gallery">
            {b.lines.filter((l) => l.trim()).map((l, k) => {
              const [name, title, when] = cells(l);
              return (
                <figure key={k}>
                  <Maid name={name} size={96} />
                  <figcaption><b>{mark(title, q)}</b><code>{name}</code><span>{mark(when ?? "", q)}</span></figcaption>
                </figure>
              );
            })}
          </div>
        );
      }
      return <pre className="cat-pre">{b.lines.join("\n")}</pre>;
  }
}

// --- Поиск: разделы глав, где встречается запрос ---

interface Hit { chapter: Chapter; id: string; heading: string; snippet: string }

function search(q: string): Hit[] {
  const hits: Hit[] = [];
  for (const ch of CHAPTERS) {
    let id = "", heading = ch.title, text = ch.lead;
    const flush = () => {
      const at = text.toLowerCase().indexOf(q);
      if (at >= 0 || heading.toLowerCase().includes(q)) {
        const from = Math.max(0, at - 40);
        const snippet = at >= 0 ? (from ? "…" : "") + text.slice(from, at + q.length + 60).replace(/[`*|]/g, " ").replace(/\s+/g, " ") + "…" : "";
        hits.push({ chapter: ch, id, heading, snippet });
      }
    };
    for (const line of ch.body.split(/\r?\n/)) {
      const h = line.match(/^#{2,3}\s+(.*)$/);
      if (h) { flush(); heading = h[1]; id = slugify(h[1]); text = ""; } else text += " " + line;
    }
    flush();
  }
  return hits;
}

export function Catalog({ chapter }: { chapter?: string }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const ch = CHAPTERS.find((c) => c.slug === chapter) ?? CHAPTERS[0];
  const blocks = useMemo(() => parse(ch.body), [ch]);
  const toc = blocks.filter((b): b is Extract<Block, { t: "h" }> => b.t === "h" && b.level === 2);
  const hits = useMemo(() => (q.length > 1 ? search(q) : []), [q]);

  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = id && document.getElementById(id);
    if (el) el.scrollIntoView({ block: "start" });
    else document.querySelector(".content")?.scrollTo({ top: 0 });
    // На телефоне главы — лентой: показать в ней текущую.
    const on = document.querySelector<HTMLElement>(".cat-chapters a.on");
    on?.parentElement?.scrollTo({ left: on.offsetLeft - 16, behavior: "smooth" });
  }, [ch]);

  const go = (c: Chapter, id = "") => {
    navigate(`/catalog/${c.slug}`);
    if (id) {
      history.replaceState(null, "", `/catalog/${c.slug}#${id}`);
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
  };

  return (
    <div className="catalog">
      <aside className="cat-side">
        <input type="search" placeholder="Поиск по каталогу" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск по каталогу" />
        {q.length > 1 ? (
          <div className="cat-hits">
            {hits.length ? hits.map((h, k) => (
              <button key={k} className="cat-hit" onClick={() => go(h.chapter, h.id)}>
                <span className="small muted">{h.chapter.title}</span>
                <b>{mark(h.heading, q)}</b>
                {h.snippet && <span className="small">{mark(h.snippet, q)}</span>}
              </button>
            )) : <p className="small muted">Ничего не нашлось. Попробуйте имя функции или файла.</p>}
          </div>
        ) : (
          <nav className="cat-chapters">
            {CHAPTERS.map((c) => (
              <a key={c.slug} href={`/catalog/${c.slug}`} className={c === ch ? "on" : ""} onClick={(e) => { e.preventDefault(); go(c); }}>
                <span className="cat-num">{c.num}</span>{c.title}
              </a>
            ))}
          </nav>
        )}
      </aside>

      <article className="cat-doc">
        <header className="cat-head">
          <span className="cat-big">{ch.num}</span>
          <div>
            <h1 className="screen-title">{ch.title}</h1>
            {ch.lead && <p className="cat-lead">{ch.lead}</p>}
          </div>
        </header>
        {toc.length > 2 && (
          <nav className="cat-toc" aria-label="Разделы главы">
            {toc.map((h) => (
              <a key={h.id} href={`#${h.id}`} onClick={(e) => { e.preventDefault(); go(ch, h.id); }}>{h.text.replace(/[`*]/g, "")}</a>
            ))}
          </nav>
        )}
        <div className="cat-body">{blocks.map((b, k) => <BlockView key={k} b={b} q={q} />)}</div>
        <footer className="cat-foot">
          {CHAPTERS[CHAPTERS.indexOf(ch) - 1] && <button className="ghost" onClick={() => go(CHAPTERS[CHAPTERS.indexOf(ch) - 1])}>← {CHAPTERS[CHAPTERS.indexOf(ch) - 1].title}</button>}
          <span className="grow" />
          {CHAPTERS[CHAPTERS.indexOf(ch) + 1] && <button className="ghost" onClick={() => go(CHAPTERS[CHAPTERS.indexOf(ch) + 1])}>{CHAPTERS[CHAPTERS.indexOf(ch) + 1].title} →</button>}
        </footer>
      </article>
    </div>
  );
}
