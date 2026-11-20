import { navigate } from "../router";
import { settingsTab, settingsTabs } from "../nav";
import { Settings } from "./Settings";
import { desktop, Widget } from "./Widget";

// «Настройки» — один экран с вкладками (19.11.2026; раньше — три пункта меню): «Виджет» — только в программе на ПК
// (Widget); «Программа» — обновление, тема, вход, копия (Settings). Персонализация с 20.11.2026 — свой пункт меню (Persona.tsx).
// Вкладка — в адресе: /settings/widget, /settings/app; прежние /widget, /maid, /settings/persona ведут куда надо (nav.ts oldPath).

export function SettingsTabs({ tab, onLogout }: { tab?: string; onLogout: () => void }) {
  const desk = Boolean(desktop());
  const on = settingsTab(tab, desk);
  const tabs = settingsTabs(desk);
  return (
    <div className="screen">
      <h2 className="screen-title">Настройки</h2>
      {tabs.length > 1 && (
        <div className="stat-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === on} className={t.id === on ? "on" : ""} onClick={() => navigate(`/settings/${t.id}`, true)}>{t.title}</button>
          ))}
        </div>
      )}
      {on === "widget" ? <Widget /> : <Settings onLogout={onLogout} />}
    </div>
  );
}
