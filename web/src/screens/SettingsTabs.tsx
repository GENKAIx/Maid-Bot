import { settingsTab } from "../nav";
import { Settings } from "./Settings";
import { desktop, Widget } from "./Widget";

// «Настройки»: вкладка по адресу — /settings/widget (только в программе на ПК, Widget) и /settings/app (обновление, тема,
// вход, копия — Settings); прежние /widget, /maid, /settings/persona ведут куда надо (nav.ts oldPath). Сами вкладки
// («Виджет», «Программа», «Корзина») — в шапке раздела «Настройки» (App.tsx, nav.ts hubs; 27.11.2026).

export function SettingsTabs({ tab, onLogout }: { tab?: string; onLogout: () => void }) {
  const on = settingsTab(tab, Boolean(desktop()));
  return <div className="screen">{on === "widget" ? <Widget /> : <Settings onLogout={onLogout} />}</div>;
}
