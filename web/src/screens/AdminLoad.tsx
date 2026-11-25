import { useState } from "react";
import { ago } from "../admin";
import { AnaLegend, AnaLine, ANA_C, type AnaSeries } from "../adminCharts";
import {
  CAPACITY_NAMES, capacityHeadline, HEALTH_RANGE_NAMES, loadLabels, loadTiles, mbText, msLoad, pctText, perMin, tileNote,
  type HealthRange, type LoadSeriesKey, type ServerLoad,
} from "../serverHealth";
import { Loading, useAdmin } from "./AdminSections";

// «Здоровье сервера» → нагрузка (часть 2 «Тарифы и управление», 25.11.2026): плашки «сейчас / пик за сутки / запас», графики за
// 1 ч / 24 ч / 7 дн (снимки раз в минуту, server/src/server-metrics.ts), «Сколько выдержит». Только числа, без людей.

type ChartDef = { title: string; d: string; keys: [LoadSeriesKey, string, string][]; fmt: (v: number) => string };
const CHARTS: ChartDef[] = [
  { title: "Процессор, %", d: "процесс — % одного ядра (Node — один поток; квота контейнера меньше ядра — от квоты), машина — % всех ядер", fmt: pctText,
    keys: [["cpu_proc", "Процесс", ANA_C.c1], ["cpu_sys", "Машина", ANA_C.c3]] },
  { title: "Память, %", d: "занято на машине или от потолка контейнера", fmt: pctText, keys: [["mem_pct", "Занято", ANA_C.c4]] },
  { title: "Память процесса, МБ", d: "RSS и куча JavaScript", fmt: mbText, keys: [["rss_mb", "RSS", ANA_C.c1], ["heap_mb", "Куча", ANA_C.c5]] },
  { title: "Задержка цикла событий, мс", d: "сколько ждёт очередь колбэков; больше 100 мс — сервер подтормаживает", fmt: msLoad,
    keys: [["loop_p50", "p50", ANA_C.c3], ["loop_p99", "p99", ANA_C.c1], ["loop_max", "наибольшая", ANA_C.c2]] },
  { title: "Запросы в минуту", d: "все ответы HTTP: API, сайт, вебхук", fmt: perMin, keys: [["http", "Запросов", ANA_C.c1], ["bot", "Апдейтов бота", ANA_C.c6]] },
  { title: "Время ответа, мс", d: "от входа запроса до конца ответа (оборванный клиентом — до обрыва)", fmt: msLoad, keys: [["http_p50", "p50", ANA_C.c3], ["http_p95", "p95", ANA_C.c1]] },
  { title: "Ошибки за шаг", d: "сколько за шаг (1 / 5 / 60 мин): ответы 5xx и оборванные клиентом запросы, вызовы модели с ошибкой", fmt: perMin, keys: [["http_5xx", "5xx и обрывы", ANA_C.c2], ["llm_err", "Модель с ошибкой", ANA_C.c5]] },
  { title: "Вызовы модели в минуту", d: "каждая попытка, как в журнале llm_calls", fmt: perMin, keys: [["llm", "Вызовов", ANA_C.c4]] },
  { title: "Очередь разбора и люди", d: "наибольшая очередь за минуту и активных людей (разных за минуту)", fmt: perMin,
    keys: [["queue_peak", "Очередь", ANA_C.c2], ["active_max", "Активных", ANA_C.c3]] },
];

export function LoadView({ v, range, setRange }: { v: ServerLoad; range: HealthRange; setRange?: (r: HealthRange) => void }) {
  const labels = loadLabels(v.t, v.range);
  const head = capacityHeadline(v.capacity);
  const c = v.capacity;
  return (
    <>
      <h2 className="adm-h2">Нагрузка <span className="adm-muted">· сейчас / пик за сутки / запас</span></h2>
      {!v.samples && <p className="adm-muted">Снимков ещё нет: сервер пишет их раз в минуту — первые появятся через минуту после запуска.</p>}
      {v.samples > 0 && !v.now && <p className="adm-err" role="alert">Свежего снимка нет: последний — {v.last_at ? ago(v.last_at) : "—"}. Сервер не работал или такт стоит.</p>}
      <div className="adm-kpis">
        {loadTiles(v).map((t) => (
          <div key={t.id} className={`adm-kpi ${t.warn ? "warn" : ""}`}>
            <span>{t.title}</span><b className="adm-num">{t.now}</b><i>{tileNote(t)}</i>
          </div>
        ))}
      </div>
      <div className="adm-toolbar" style={{ marginTop: 18 }}>
        <div className="adm-seg-ctl" role="tablist" aria-label="Интервал">
          {HEALTH_RANGE_NAMES.map(([id, t]) => (
            <button key={id} role="tab" aria-selected={range === id} className={range === id ? "on" : ""} onClick={() => setRange?.(id)}>{t}</button>
          ))}
        </div>
        <span className="adm-muted adm-small">
          шаг {v.step_min} мин · снимки раз в минуту, хранятся {v.keep_days} дн.{v.since ? ` · с ${ago(v.since)}` : ""}{v.now ? ` · снимок занял ${msLoad(v.now.tick_ms)}` : ""}
        </span>
      </div>
      <div className="adm-two">
        {CHARTS.map((ch) => {
          const series: AnaSeries[] = ch.keys.map(([k, name, color]) => ({ name, color, values: v.series[k] ?? [] }));
          return (
            <section key={ch.title} className="ana-card">
              <h3>{ch.title}</h3>
              <p className="ana-d">{ch.d}</p>
              <AnaLine labels={labels} series={series} fmt={ch.fmt} label={ch.title} height={180} />
              {series.length > 1 && <AnaLegend items={series} />}
            </section>
          );
        })}
      </div>
      <h2 className="adm-h2">Сколько выдержит <span className="adm-muted">· оценка по замерам, не нагрузочный тест</span></h2>
      <div className="adm-kpis">
        <div className={`adm-kpi ${c.status === "few" ? "dim" : ""}`}><span>Одновременно активных людей</span><b className="adm-num">{head.value}</b><i>{head.hint}</i></div>
        <div className="adm-kpi"><span>Активных за минуту, больше всего</span><b className="adm-num">{c.max_active}</b><i>за 7 дней · минут с людьми {c.minutes}</i></div>
      </div>
      {c.status === "ok" && (
        <div className="adm-scroll" style={{ marginTop: 12 }}><table className="adm-table">
          <thead><tr><th>Ограничение</th><th className="num">На одного активного</th><th className="num">Потолок</th><th className="num">Выдержит</th><th>Как считали</th></tr></thead>
          <tbody>{c.limits.map((l) => (
            <tr key={l.id}>
              <td>{CAPACITY_NAMES[l.id].title}{c.bottleneck === l.id ? " · первым" : ""}</td>
              <td className="num adm-num">{CAPACITY_NAMES[l.id].per(l.per)}</td>
              <td className="num adm-num">{CAPACITY_NAMES[l.id].budget(l.budget)}</td>
              <td className="num adm-num">{l.people == null ? "—" : `${l.people} чел.`}</td>
              <td className="adm-muted adm-small">{l.note}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="adm-muted adm-small adm-note">
        Оценка по замерам, не нагрузочный тест. Час пик — 10% самых людных минут за 7 дней (не меньше 10); нагрузка на человека — разница
        с минутами без людей, делённая на число активных. Активный — сделал запрос или написал боту в эту минуту (хранится только число).
        Процессор считается от одного ядра (или квоты контейнера, если она меньше) до 85% (как оповещение «Процессор или память»), память — до 85%, модель — по потолку провайдера
        LLM_RPM, если он задан. Рост нелинейный (база, сеть, сама модель), поэтому число — ориентир, а не обещание.
      </p>
    </>
  );
}

/** Блок нагрузки в «Здоровье сервера»: данные по выбранному интервалу (сервер — GET /api/admin/health/load?range=). */
export function AdminLoad() {
  const [range, setRange] = useState<HealthRange>("24h");
  const [v, err] = useAdmin<ServerLoad>(`/api/admin/health/load?range=${range}`);
  if (!v) return <Loading err={err} />;
  return <LoadView v={v} range={range} setRange={setRange} />;
}
