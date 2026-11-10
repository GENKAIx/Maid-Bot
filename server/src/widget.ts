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
      if (t && t.user_id === u.id && t.status !== "deleted") {
        await store.updateTask(id, { status: act === "d" ? "done" : "open" }, now);
        pipeline.changed(u);
      }
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

/** Сообщение — просьба показать список на сегодня («что на сегодня?», «что осталось», «мои дела»). */
export function asksForList(text: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 40) return false;
  return /^(покажи |дай |а )?(что|че|чо|чего)( у меня| мне)?( на| еще на)? сегодня( делать| по планам)?$/.test(t)
    || /^(что|че|чо|чего)( у меня| мне)? (осталось|еще осталось)( на сегодня| сделать| сегодня)?$/.test(t)
    || /^(покажи |дай )?(мой |мои )?(список|список дел|список на сегодня|дела|дела на сегодня|мои дела|план на сегодня|планы на сегодня)$/.test(t);
}

export const WIDGET_CAPTION = "📋 Список на сегодня — нажмите строку, чтобы отметить";

// Сам виджет. Цвета — только переменные темы Telegram; приглушение — цветом, не прозрачностью (лимит 16 элементов).
export const WIDGET_HTML = `<style>
body{margin:0;padding:10px 14px max(8px,env(safe-area-inset-bottom))}
h3{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:1em}
#m{position:relative;flex:none;width:44px;height:44px;animation:bob 3s ease-in-out infinite}
#m img{display:block;width:44px;height:44px}
#m.zz{animation-duration:6s}#m.zz img{transform:rotate(-10deg)}
#m.hop{animation:hop .5s}#m.yay{animation:yay .5s 3}
#e{position:absolute;right:-8px;top:-8px;font-style:normal;font-size:15px}#e.go{animation:up .6s}
@keyframes bob{50%{transform:translateY(-2px)}}
@keyframes hop{35%{transform:translateY(-9px) scale(1.05,.95)}70%{transform:scale(1.08,.9)}}
@keyframes yay{25%{transform:rotate(-10deg) translateY(-4px)}75%{transform:rotate(10deg) translateY(-4px)}}
@keyframes up{from{transform:translateY(5px) scale(.5)}50%{transform:translateY(-4px) scale(1.2)}}
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
@media (prefers-reduced-motion:reduce){li.go,li.go::after,#c.pop,#m,#e{animation:none!important;transition:none}}
</style>
<h3><span id="m"><img alt="" src="data:image/webp;base64,UklGRqwEAABXRUJQVlA4WAoAAAAQAAAAKwAAKwAAQUxQSJ4BAAABkGvbtmlLc+OVbdu2bRupEdqIbGfVKrJTG6Ft23Xv49l7zXKdu78gIiYA/6ssAGPwRwMoxK60AvJVzgPUWrJ/19wasBraqngMgDwrn2c+7tvxG0lmjAM0ABWHQoHq+Y/wz5FzOczutfb+6SkGafp/lMbM51kP6Lx4ESFJ4R/PlQaU+TeLjSTp+c/inXcRH61qC2j1N2UxgDlePOP0JE/1BcxfgGJHJGLcPhJyXznY35TOd+hTFlPqHF+0w+8Gm5j6iMn+ABRKJZxPGT1zABh0p2eAQgAajbNEAqAAgMUBuhAIwGJMpmcgBt08JRCty7wRz0AMDjFioAZ9GDFUbS6LCwY96BnODonCKfhKfDidGPIEfv5GCWUWD7wOaWoOgx3zdDh9ME23D6YLJnf50QEZDAzI6uEhYRujYFAuIRLOQZ/DYC+RlGAW7dk6IYMShgdQLDsQoU2z5RNhOF6AQv43FIqkKuLbKgBwjZ6kS41noh0Ag8OMmMgkncQnvNMCBrBYzCyerH8oi/E7OVsABoBBD2ZzP9Bs3Y2c2HgRFgBWUDgg6AIAADANAJ0BKiwALAA+6WanT6kloyIquqwBIB0JbAC/a3by2AFdtXarvMb7ZrLGPuI7SazRvI99RewKrtEml+YZIdLAm+ZJeN+guVvuxJL0HQzvQsQ6qopniEJB1E+9ojLjBK8dy79U8orBuaERVhO/u9TgAAD+/dtGmUSk4xZ6VvxjWPdcknRZl/XP6eqb99Cdo661z8n0/0+7A/Z4+dswhnC4Y0UD/D7SFpo6TFD0+VQk/df7fv/n4rr5do0jOx+GNIq60+oUfU6dvGgir8Pua8DKOTmSTD82XKAKTu+vhQiXGlzIOU3KLtBGFb+fgWsKGu7vuCehPB+UFuu7rNuEr//Hxmkl7PXTeD8h4Y5YosppxiqH7569XZv3/cxPauvJoT9uXB/Y7FFKyLpg36zGdCxfM4rtWhUWV04jWjHu4JXkJjQ9APteIwuv5BnQJIYvC+eEXgBUw7kxC61zfAa3UTakznCrA6QhenO+N25QDRRMRuYXxo+lpmQYcwT8Xp2fqMdcuQ8JPmm+1HuNXqz6QQI29lYlPARGFMBTIPSCeU/UgSdfuTOUtq94j9964uPOBRjJOo2QS7u/MWy08STEV0Uvf3wevo1ZfBm5UV2+yXjdubNi177DFDsF7xvI91MscneOOfnGzXomjPh6CzOvr56V41ljvk6igKlQ1A1i6EYbVkTV1ls/YAHRyDX8ULnbdQaQ5ddMULiT18xD/AGbr0A2Ahb36RCiw/pg/h31b8Nr2k64/DopJ6Z0usi6GuDUGm5onjVf1AKO8lH6ZzCXrjIwg/a9V3fe7kOcU+HiqtbQJ5v58+hND59jsEDaaj5BRHjCqIGDh+nr0NxpbaiXLJes9pAmqeD/RnaCD32MZqKUSCwN21Qqrn7DidIbGJWJ8Gu27qRqYLBfseox0khAaIdIHTsuRZeb8tI6qzK0MCFLtiyUl3Ig1nGgxybr4D/5nUOTuzGHZ/Huhziv0Y+VhNgCG92AUl0AAA=="><em id="e"></em></span>Сегодня <button id="c" hidden></button></h3><ul id="l"></ul><div id="n"></div>
<script>
const W=window.TelegramWidget,$=(i)=>document.getElementById(i);
let S={r:0,a:[]},peek=0,busy=0,undo=null,note='',last=-1,fx='';
function pulse(k,em){const m=$('m'),e=$('e');fx=k;m.className=k;e.textContent=em;e.className='';void m.offsetWidth;e.className='go'}
$('m').addEventListener('animationend',(ev)=>{if(ev.target.id==='m'&&fx){fx='';draw()}});
const take=(s)=>{try{const v=JSON.parse(s);if(v&&v.r>=S.r)S=v}catch(e){}};
take(W&&W.chatData);
const esc=(s)=>s.replace(/[&<>]/g,(c)=>'&#'+c.charCodeAt(0)+';');
function draw(){
  const open=S.a.filter((x)=>!(x[2]&1)),done=S.a.length-open.length,c=$('c');
  c.hidden=!done;c.textContent=done+'/'+S.a.length;
  const won=last>=0&&done>last&&!open.length&&done;
  c.className=(peek?'on ':'')+(open.length?'':'all ')+(last>=0&&done>last?'pop':'');last=done;
  if(won)pulse('yay','🎉');else if(!fx){$('m').className=S.a.length?'':'zz';$('e').textContent=S.a.length?(open.length?'':'✨'):'💤'}
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
  if(e.target.closest('#m')){pulse('hop','💕');return}
  if(e.target.id==='u'&&undo){const k=undo;undo=null;ask('u:'+k);return}
  const li=e.target.closest('li');if(!li||busy)return;
  const k=li.dataset.k;
  if(li.classList.contains('d')){ask('u:'+k);return}
  li.classList.add('go');pulse('hop','✨');
  W&&W.HapticFeedback&&W.HapticFeedback.notificationOccurred('success');
  undo=k;clearTimeout(ask.t);ask.t=setTimeout(()=>{undo=null;draw()},5000);
  ask('d:'+k,li);
});
if(W){W.onEvent('chatDataChanged',()=>{take(W.chatData);busy||draw()});if(W.viewer)W.request('s').then((r)=>{take(r&&r.result);draw()},()=>{})}
draw();
W&&W.ready();
</script>`;
