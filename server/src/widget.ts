import type { Store, User } from "./db.ts";
import { habitsOfDay } from "./habits.ts";
import type { Pipeline } from "./pipeline.ts";
import { dayKey } from "./time.ts";

// Виджет Telegram (Bot API 10.4) «Список на сегодня»: привычки и задачи с галочками прямо в сообщении.
// Код виджета не меняется после отправки — меняется только состояние (chat_data, до 1024 байт), его пишет бот.
// Виджет просит бота запросами (1–64 байта): «d:t12» — сделано, «u:t12» — вернуть, «s» — свежий список.
// Ответ на запрос — новое состояние целиком, бот тем же кладёт его в сообщение (editMessageWidgetData).

export const WIDGET_STATE_MAX = 1024;
/** Какие обновления просить у Telegram: без widget_query нажатия в виджете до бота не дойдут. */
export const WIDGET_UPDATES = ["message", "callback_query", "widget_query"] as unknown as ("message" | "callback_query")[];

/** Строка списка: [ключ "t12"/"h3", название, флаги: 1 — сделано, 2 — важная]. */
export type WidgetItem = [string, string, number];
/** Состояние виджета: r — ревизия (мс), a — строки, m — сколько не влезло. */
export interface WidgetState { r: number; a: WidgetItem[]; m?: number }

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Состояние на сегодня: открытые привычки и задачи, потом сделанное за день. Влезает в 1024 байта. */
export async function widgetState(store: Store, u: User, now = new Date()): Promise<string> {
  const today = dayKey(now, u.tz);
  const habits = await habitsOfDay(store, u, today);
  const all = await store.allTasks(u.id);
  const open: WidgetItem[] = [
    ...habits.filter((d) => !d.status).map((d): WidgetItem => [`h${d.habit.id}`, d.habit.title, 0]),
    ...(await store.openTasks(u.id)).map((t): WidgetItem => [`t${t.id}`, t.title, t.priority === "high" ? 2 : 0]),
  ];
  const done: WidgetItem[] = [
    ...habits.filter((d) => d.status === "done").map((d): WidgetItem => [`h${d.habit.id}`, d.habit.title, 1]),
    ...all.filter((t) => t.status === "done" && t.done_at && dayKey(new Date(t.done_at), u.tz) === today)
      .map((t): WidgetItem => [`t${t.id}`, t.title, 1 | (t.priority === "high" ? 2 : 0)]),
  ];
  return fitState(open, done, now.getTime());
}

/** Сжать под 1024 байта: сначала укоротить названия, потом убрать сделанное, потом хвост списка (m — сколько убрано). */
export function fitState(open: WidgetItem[], done: WidgetItem[], r: number): string {
  for (const len of [48, 36, 28, 22, 16]) {
    const s = JSON.stringify({ r, a: [...open, ...done].map(([k, t, f]) => [k, cut(t, len), f]) });
    if (bytes(s) <= WIDGET_STATE_MAX) return s;
  }
  const rows = open.map(([k, t, f]): WidgetItem => [k, cut(t, 16), f]);
  for (let n = rows.length; n >= 0; n--) {
    const s = JSON.stringify({ r, a: rows.slice(0, n), ...(n < rows.length ? { m: rows.length - n } : {}) });
    if (bytes(s) <= WIDGET_STATE_MAX) return s;
  }
  return JSON.stringify({ r, a: [] });
}

/** Запрос виджета: отметить, вернуть или просто обновить. Возвращает новое состояние. */
export async function widgetQuery(store: Store, pipeline: Pipeline, u: User, data: string, now = new Date()): Promise<string> {
  const m = data.match(/^([du]):([th])(\d+)$/);
  if (m) {
    const [, act, kind, raw] = m;
    const id = Number(raw);
    const today = dayKey(now, u.tz);
    if (kind === "t") {
      const t = await store.task(id);
      if (t && t.user_id === u.id && t.status !== "deleted") await store.updateTask(id, { status: act === "d" ? "done" : "open" });
    } else if (act === "d") {
      await pipeline.markHabit(u, id, today, "done", "telegram-widget");
    } else {
      // Вернуть привычку — отменить ту запись, которой её отметили (как «Отменить» у сообщения).
      const mark = (await store.marksOf(u.id, today, today)).find((k) => k.habit_id === id);
      if (mark?.message_id) await pipeline.undo(u, mark.message_id);
    }
  }
  return widgetState(store, u, now);
}

export const WIDGET_CAPTION = "📋 Список на сегодня — нажмите строку, чтобы отметить";

// Сам виджет. Цвета — только переменные темы Telegram; приглушение — цветом, не прозрачностью (лимит 16 элементов).
export const WIDGET_HTML = `<style>
body{margin:0;padding:10px 14px max(8px,env(safe-area-inset-bottom))}
h3{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:1em}
#c{border:0;border-radius:9px;padding:1px 8px;font-size:.8em;font-weight:600;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color);font-variant-numeric:tabular-nums}
#c.on{color:var(--tg-theme-text-color)}
#c.all{background:#f2c14e;color:#2a2000}
#c.pop{animation:pop .35s}
ul{list-style:none;margin:0;padding:0}
li{position:relative;display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--tg-theme-section-separator-color);overflow:hidden}
li:first-child{border:0}
li>*{position:relative;z-index:1}
li::after{content:"";position:absolute;inset:0;background:var(--tg-theme-secondary-bg-color);transform:scaleX(0);transform-origin:left}
li.go::after{transform:scaleX(1);transition:transform .45s ease-out}
li.go{animation:fly .35s .5s cubic-bezier(.5,0,.9,.4) forwards}
i{flex:none;display:grid;place-items:center;width:18px;height:18px;border:2px solid var(--tg-theme-hint-color);border-radius:6px;font-style:normal;font-size:12px;font-weight:700;color:var(--tg-theme-button-text-color)}
.h i{border-radius:50%}
.d i,.go i{background:var(--tg-theme-button-color);border-color:var(--tg-theme-button-color)}
.d span{text-decoration:line-through;color:var(--tg-theme-hint-color)}
b{color:var(--tg-theme-destructive-text-color)}
#n{min-height:1.2em;padding-top:4px;font-size:.85em;color:var(--tg-theme-hint-color)}
#n.ok{color:#f2c14e;font-weight:600}
#n a{color:var(--tg-theme-link-color)}
@keyframes fly{to{transform:translateX(110%)}}
@keyframes pop{40%{transform:scale(1.2)}}
@media (prefers-reduced-motion:reduce){li.go,li.go::after,#c.pop{animation:none;transition:none}}
</style>
<h3>Сегодня <button id="c" hidden></button></h3><ul id="l"></ul><div id="n"></div>
<script>
const W=window.TelegramWidget,$=(i)=>document.getElementById(i);
let S={r:0,a:[]},peek=0,busy=0,undo=null,note='',last=-1;
const take=(s)=>{try{const v=JSON.parse(s);if(v&&v.r>=S.r)S=v}catch(e){}};
take(W&&W.chatData);
const esc=(s)=>s.replace(/[&<>]/g,(c)=>'&#'+c.charCodeAt(0)+';');
function draw(){
  const open=S.a.filter((x)=>!(x[2]&1)),done=S.a.length-open.length,c=$('c');
  c.hidden=!done;c.textContent=done+'/'+S.a.length;
  c.className=(peek?'on ':'')+(open.length?'':'all ')+(last>=0&&done>last?'pop':'');last=done;
  $('l').innerHTML=S.a.filter((x)=>peek||!(x[2]&1)).map((x)=>'<li data-k="'+x[0]+'" class="'+x[0][0]+(x[2]&1?' d':'')+'"><i>'+(x[2]&1?'✓':'')+'</i><span>'+(x[2]&2?'<b>!</b> ':'')+esc(x[1])+'</span></li>').join('');
  const n=$('n');n.className='';
  if(note)n.innerHTML=note;
  else if(undo)n.innerHTML='Отмечено · <a id="u">↶ Вернуть</a>';
  else if(!open.length&&done){n.className='ok';n.textContent='Всё на сегодня ✨'}
  else if(!S.a.length)n.textContent='Пусто. Напишите боту, что сделать.';
  else n.textContent=S.m?'Ещё '+S.m+' — в приложении':'';
}
function ask(d,row){
  if(!W){return}
  if(busy){note='Секунду…';draw();return}
  busy=1;note='';
  W.request(d).then((r)=>{busy=0;take(r&&r.result);setTimeout(draw,row?850:0)},(e)=>{
    busy=0;note=e.code==='NOT_ALLOWED'?'Отмечать можно в чате с ботом':e.code==='RATE_LIMITED'?'Слишком часто, подождите пару секунд':'Не получилось ('+e.code+')';
    undo=null;draw();
  });
}
document.addEventListener('click',(e)=>{
  if(e.target.id==='c'){peek=!peek;draw();return}
  if(e.target.id==='u'&&undo){const k=undo;undo=null;ask('u:'+k);return}
  const li=e.target.closest('li');if(!li||busy)return;
  const k=li.dataset.k;
  if(li.classList.contains('d')){ask('u:'+k);return}
  li.classList.add('go');
  W&&W.HapticFeedback&&W.HapticFeedback.notificationOccurred('success');
  undo=k;clearTimeout(ask.t);ask.t=setTimeout(()=>{undo=null;draw()},5000);
  ask('d:'+k,li);
});
if(W){W.onEvent('chatDataChanged',()=>{take(W.chatData);busy||draw()});if(W.viewer)W.request('s').then((r)=>{take(r&&r.result);draw()},()=>{})}
draw();
W&&W.ready();
</script>`;
