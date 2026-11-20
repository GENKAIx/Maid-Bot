import { navigate } from "../router";
import { settingsTab, settingsTabs } from "../nav";
import { AboutYou } from "./AboutYou";
import { MaidSettings } from "./MaidSettings";
import { Settings } from "./Settings";
import { desktop, Widget } from "./Widget";

// «Настройки» — один экран с вкладками (19.11.2026; раньше — три пункта меню): «Персонализация» (20.11.2026, раньше
// «Горничная») — две части: «О вас» (AboutYou) и «Рина» — характер и когда пишет (MaidSettings); «Виджет» — только в
// программе на ПК (Widget); «Программа» — обновление, тема, вход, копия (Settings).
// Вкладка — в адресе: /settings/persona, /settings/widget, /settings/app; прежние /maid, /settings/maid и /widget ведут сюда (nav.ts oldPath).

export function SettingsTabs({ tab, onLogout }: { tab?: string; onLogout: () => void }) {
  const desk = Boolean(desktop());
  const on = settingsTab(tab, desk);
  return (
    <div className="screen">
      <h2 className="screen-title">Настройки</h2>
      <div className="stat-tabs" role="tablist">
        {settingsTabs(desk).map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === on} className={t.id === on ? "on" : ""} onClick={() => navigate(`/settings/${t.id}`, true)}>{t.title}</button>
        ))}
      </div>
      {on === "persona" ? (
        <>
          <h3 className="part-title">О вас</h3>
          <AboutYou />
          <h3 className="part-title">Рина</h3>
          <MaidSettings />
        </>
      ) : on === "widget" ? <Widget /> : <Settings onLogout={onLogout} />}
    </div>
  );
}
