import { AboutYou } from "./AboutYou";
import { MaidSettings } from "./MaidSettings";

// «Персонализация» — свой пункт меню под «Профилем» (20.11.2026; до этого — вкладка «Настроек»): две части —
// «О вас» (AboutYou: что Рине знать о человеке) и «Рина» (MaidSettings: характер, внешность, когда пишет).
// Счётчик «2/7» в меню — App.tsx по /api/you; onChanged после сохранения «О вас» его обновляет.

export function Persona({ onChanged }: { onChanged: () => void }) {
  return (
    <div className="screen persona">
      <h2 className="screen-title">Персонализация</h2>
      <h3 className="part-title">О вас</h3>
      <AboutYou onChanged={onChanged} />
      <h3 className="part-title">Рина</h3>
      <MaidSettings />
    </div>
  );
}
