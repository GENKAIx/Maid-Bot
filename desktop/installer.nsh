; Установщик с окнами (oneClick: false): одна страница выбора — ярлык на рабочем столе по галочке.
; В меню «Пуск» ярлык создаётся всегда (createStartMenuShortcut), там программу находит поиск.
; Ставим только для текущего пользователя — без вопроса «для кого установить» и без прав администратора.

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var maidDesktopBox
  Var maidDesktopWant
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customPageAfterChangeDir
  Page custom maidShortcutsPage maidShortcutsLeave

Function maidShortcutsPage
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Ярлыки" "Где будет значок «Горничной»"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateCheckbox} 0 0 100% 14u "Создать значок на рабочем столе"
  Pop $maidDesktopBox
  ${If} $maidDesktopWant == "0"
    ${NSD_Uncheck} $maidDesktopBox
  ${Else}
    ${NSD_Check} $maidDesktopBox
  ${EndIf}
  ${NSD_OnClick} $maidDesktopBox maidShortcutsClick
  ${NSD_CreateLabel} 0 24u 100% 30u "В меню «Пуск» программа будет в любом случае: откройте «Пуск» и начните набирать «Горничная»."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function maidShortcutsClick
  Pop $0
  Call maidShortcutsLeave
FunctionEnd

Function maidShortcutsLeave
  ${NSD_GetState} $maidDesktopBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $maidDesktopWant "1"
  ${Else}
    StrCpy $maidDesktopWant "0"
  ${EndIf}
FunctionEnd
!macroend


; Ярлык на столе electron-builder создаёт сам, а при переустановке оставляет как был (keepShortcuts).
; Поэтому решаем здесь: галочку сняли — убираем значок, поставили, а значка нет — создаём.
; Тихая установка (обновление по кнопке, /S): страницы не было — значок на столе не трогаем, как было, так и останется.
!macro customInstall
  ${If} ${Silent}
    ; ничего
  ${ElseIf} $maidDesktopWant == "0"
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${ElseIfNot} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
