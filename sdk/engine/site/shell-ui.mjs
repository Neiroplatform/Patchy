const RU = new Map(Object.entries({
  "Patchy editor home": "Главная редактора Patchy",
  "local editor": "локальный редактор",
  "Document actions": "Действия с документом",
  "Open PSD": "Открыть PSD",
  "New": "Новый",
  "Recovery": "Восстановление",
  "Assets": "Ассеты",
  "Undo": "Отменить",
  "Redo": "Повторить",
  "Canvas": "Холст",
  "Layered document format": "Формат слоёного документа",
  "Download PSD": "Скачать PSD",
  "Save": "Сохранить",
  "Export format": "Формат экспорта",
  "Export": "Экспорт",
  "Copy selected editable layer": "Скопировать выбранный редактируемый слой",
  "Copy selected layer": "Скопировать выбранный слой",
  "Paste layer or image": "Вставить слой или изображение",
  "Interface language": "Язык интерфейса",
  "Size": "Размер",
  "Color": "Цвет",
  "Target": "Цель",
  "Paint target": "Цель рисования",
  "Layer pixels": "Пиксели слоя",
  "Paint": "Рисование",
  "Tolerance": "Допуск",
  "Edge": "Край",
  "Enhance edge": "Улучшить край",
  "Foreground → transparent": "Основной → прозрачный",
  "Black → white": "Чёрный → белый",
  "Sunset": "Закат",
  "Ocean": "Океан",
  "Solid foreground": "Сплошной основной",
  "Checker pattern": "Шахматный узор",
  "Dot pattern": "Точечный узор",
  "Starting engine": "Запуск движка",
  "Engine ready": "Движок готов",
  "Document ready": "Документ готов",
  "Modified locally": "Изменено локально",
  "Workspace tools": "Инструменты",
  "Move layer": "Переместить слой",
  "Crop document": "Кадрировать документ",
  "Rectangular selection": "Прямоугольное выделение",
  "Freehand lasso": "Свободное лассо",
  "Polygonal lasso": "Многоугольное лассо",
  "Magic selection": "Волшебное выделение",
  "Quick Select": "Быстрое выделение",
  "Magnetic Lasso": "Магнитное лассо",
  "Quick Mask": "Быстрая маска",
  "Pan canvas": "Перемещать холст",
  "Brush": "Кисть",
  "Eraser": "Ластик",
  "Clone stamp": "Штамп",
  "Healing brush": "Восстанавливающая кисть",
  "Gradient": "Градиент",
  "Fill selection": "Залить выделение",
  "Pen path": "Контур пером",
  "Text": "Текст",
  "Select all": "Выделить всё",
  "Clear selection": "Снять выделение",
  "Toggle panels": "Показать или скрыть панели",
  "Document editor workspace": "Рабочая область редактора",
  "Open documents": "Открытые документы",
  "Document canvas": "Холст документа",
  "Rendered document": "Отрисованный документ",
  "Layer transform handles": "Маркеры трансформации слоя",
  "Top-left transform handle": "Верхний левый маркер",
  "Top-right transform handle": "Верхний правый маркер",
  "Bottom-right transform handle": "Нижний правый маркер",
  "Bottom-left transform handle": "Нижний левый маркер",
  "LOCAL-FIRST WORKSPACE": "ЛОКАЛЬНАЯ РАБОЧАЯ ОБЛАСТЬ",
  "Open a layered document.": "Откройте слоёный документ.",
  "Keep it on this device.": "Оставьте его на этом устройстве.",
  "PSD bytes stay inside the browser Worker. Editing state is owned by the Patchy engine.": "Байты PSD остаются в Worker браузера. Состоянием редактирования владеет движок Patchy.",
  "Choose a PSD": "Выбрать PSD",
  "or drop it anywhere": "или перетащите его сюда",
  "Opening document": "Открываем документ",
  "Reading layers and rendering pixels": "Читаем слои и рисуем пиксели",
  "Cancel": "Отмена",
  "Drop to open locally": "Перетащите для локального открытия",
  "No upload, no cloud copy": "Без загрузки и облачной копии",
  "Zoom out": "Уменьшить масштаб",
  "Zoom in": "Увеличить масштаб",
  "Fit": "Вписать",
  "Local session": "Локальная сессия",
  "Recovery starting": "Запуск восстановления",
  "Recovery unavailable": "Восстановление недоступно",
  "Local recovery ready": "Локальное восстановление готово",
  "Protecting revision…": "Защита ревизии…",
  "Recovery needs attention": "Восстановление требует внимания",
  "Document protected locally": "Документ защищён локально",
  "Recovery not captured yet": "Восстановление ещё не сохранено",
  "Memory ready": "Память готова",
  "History": "История",
  "History memory per document": "Память истории на документ",
  "Document panels": "Панели документа",
  "Layers": "Слои",
  "Layer actions": "Действия со слоями",
  "STRUCTURE": "СТРУКТУРА",
  "APPEARANCE": "ВНЕШНИЙ ВИД",
  "DOCUMENT": "ДОКУМЕНТ",
  "CHANNELS & PATHS": "КАНАЛЫ И КОНТУРЫ",
  "SESSION": "СЕССИЯ",
  "Import pixels": "Импорт пикселей",
  "Group": "Сгруппировать",
  "Ungroup": "Разгруппировать",
  "Delete": "Удалить",
  "Invert pixels": "Инвертировать пиксели",
  "Filters": "Фильтры",
  "Add text": "Добавить текст",
  "Edit text": "Изменить текст",
  "Add shape": "Добавить фигуру",
  "Add adjustment": "Добавить коррекцию",
  "Place Smart Object": "Поместить Smart Object",
  "Replace Smart Object": "Заменить Smart Object",
  "Open contents": "Открыть содержимое",
  "Transform": "Трансформация",
  "Warp": "Деформация",
  "Add mask": "Добавить маску",
  "Disable mask": "Отключить маску",
  "Enable mask": "Включить маску",
  "Unlink mask": "Отвязать маску",
  "Link mask": "Связать маску",
  "Remove mask": "Удалить маску",
  "Invert mask": "Инвертировать маску",
  "Vector mask": "Векторная маска",
  "Smart Filter": "Смарт-фильтр",
  "Layer alignment or distribution": "Выравнивание или распределение слоёв",
  "Layer alignment reference": "Опора выравнивания слоёв",
  "Align left": "По левому краю",
  "Align centers": "По горизонтальному центру",
  "Align right": "По правому краю",
  "Align top": "По верхнему краю",
  "Align middles": "По вертикальному центру",
  "Align bottom": "По нижнему краю",
  "Distribute horizontal gaps": "Равные горизонтальные интервалы",
  "Distribute vertical gaps": "Равные вертикальные интервалы",
  "Selection bounds": "Границы выделения",
  "Arrange layers": "Расположить слои",
  "Open a document to inspect its layers.": "Откройте документ, чтобы посмотреть слои.",
  "This document has no layers.": "В этом документе нет слоёв.",
  "Selected layer": "Выбранный слой",
  "Name": "Имя",
  "Opacity": "Непрозрачность",
  "Layer opacity": "Непрозрачность слоя",
  "Layer fill opacity": "Непрозрачность заливки слоя",
  "Blend mode": "Режим наложения",
  "Fill": "Заливка",
  "Pass through": "Пропустить сквозь",
  "Normal": "Обычный",
  "Multiply": "Умножение",
  "Screen": "Экран",
  "Overlay": "Перекрытие",
  "Darken": "Затемнение",
  "Lighten": "Осветление",
  "Difference": "Разница",
  "Dissolve": "Растворение",
  "Style preset": "Стиль",
  "None": "Нет",
  "Apply style": "Применить стиль",
  "Soft Shadow": "Мягкая тень",
  "Sticker Outline": "Контур стикера",
  "Simple Emboss": "Простое тиснение",
  "Warm Glow": "Тёплое свечение",
  "Neon Edge": "Неоновый край",
  "Letterpress": "Высокая печать",
  "Clip to layer below": "Обтравочная маска",
  "Lock layer": "Заблокировать слой",
  "Edit effects…": "Изменить эффекты…",
  "Document history": "История документа",
  "Edit the document to build history.": "Измените документ, чтобы появилась история.",
  "Opened document": "Открытый документ",
  "Structure": "Структура",
  "Invert selection": "Инвертировать выделение",
  "Expand 4 px": "Расширить на 4 px",
  "Contract 4 px": "Сжать на 4 px",
  "Border 4 px": "Граница 4 px",
  "Grow by color": "Расширить по цвету",
  "Select similar": "Выбрать похожее",
  "Save channel": "Сохранить канал",
  "Save path": "Сохранить контур",
  "Rasterize layer": "Растрировать слой",
  "Merge visible copy": "Копия видимых слоёв",
  "Channels": "Каналы",
  "Paths": "Контуры",
  "Rename channel": "Переименовать канал",
  "Invert channel": "Инвертировать канал",
  "Channel up": "Канал выше",
  "Channel down": "Канал ниже",
  "Delete channel": "Удалить канал",
  "Rename path": "Переименовать контур",
  "Toggle clipping": "Переключить обтравку",
  "Set clipping": "Задать обтравку",
  "Clear clipping": "Снять обтравку",
  "Path up": "Контур выше",
  "Path down": "Контур ниже",
  "Delete path": "Удалить контур",
  "First anchor X": "X первого узла",
  "First anchor Y": "Y первого узла",
  "Apply anchor": "Применить узел",
  "Select and Mask…": "Выделение и маска…",
  "Document": "Документ",
  "State": "Состояние",
  "Modified": "Изменён",
  "Saved": "Сохранён",
  "Format": "Формат",
  "Revision": "Ревизия",
  "No document": "Нет документа",
  "Dismiss error": "Закрыть ошибку",
  "Close": "Закрыть",
  "Apply": "Применить",
  "Select and Mask": "Выделение и маска",
  "Output to": "Вывод",
  "Selection": "Выделение",
  "Layer mask": "Маска слоя",
  "Target layer": "Целевой слой",
  "Skip to editor workspace": "Перейти к рабочей области",
  "Unnamed layer": "Безымянный слой",
  "Pixels": "Пиксели",
  "Adjustment": "Коррекция",
  "Shape": "Фигура",
  "Smart object": "Смарт-объект",
  "Importing pixels": "Импорт пикселей",
}));

const excluded = ".layer-name, #documentName, .document-tab, .recovery-copy strong, .text-run-list code";

export function translateMessage(value, locale = "en") {
  const source = String(value ?? "");
  if (locale !== "ru") return source;
  if (RU.has(source)) return RU.get(source);
  const shortcut = source.match(/^(.+) \(([^)]+)\)$/);
  if (shortcut && RU.has(shortcut[1])) return `${RU.get(shortcut[1])} (${shortcut[2]})`;
  const rules = [
    [/^(\d+) selected layers$/, "$1 выбранных слоёв"],
    [/^Download (PSD|PSB)$/, "Скачать $1"],
    [/^Close (.+)$/, "Закрыть $1"],
    [/^Select (.+)$/, "Выбрать $1"],
    [/^Hide (.+)$/, "Скрыть $1"],
    [/^Show (.+)$/, "Показать $1"],
    [/^Revision (\d+)$/, "Ревизия $1"],
    [/^Live engine preview · (.+)$/, "Живое превью движка · $1"],
    [/^Recovered (\d+) workspace(s?)$/, "Восстановлено рабочих областей: $1"],
    [/^(\d+) recoverable workspaces on this device\.$/, "Рабочих областей для восстановления: $1."],
    [/^(.+) used of approximately (.+) browser storage\.$/, "Использовано $1 из примерно $2 хранилища браузера."],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(source)) return source.replace(pattern, replacement);
  }
  return source;
}

export function createLocalizer(document, initialLocale = "en") {
  let locale = initialLocale === "ru" ? "ru" : "en";
  const NodeType = document.defaultView?.Node ?? globalThis.Node;
  const NodeFilterType = document.defaultView?.NodeFilter ?? globalThis.NodeFilter;
  const textState = new WeakMap();
  const attributeState = new WeakMap();
  const eligible = (node) => !node.parentElement?.closest?.(excluded);
  const localizeText = (node) => {
    if (!eligible(node) || !node.nodeValue?.trim()) return;
    const state = textState.get(node);
    const current = node.nodeValue;
    const source = !state || current !== state.rendered ? current : state.source;
    const leading = source.match(/^\s*/)?.[0] || "";
    const trailing = source.match(/\s*$/)?.[0] || "";
    const core = source.trim();
    const rendered = core ? `${leading}${translateMessage(core, locale)}${trailing}` : source;
    textState.set(node, { source, rendered });
    if (current !== rendered) node.nodeValue = rendered;
  };
  const localizeAttributes = (element) => {
    if (element.closest?.(excluded)) return;
    let states = attributeState.get(element);
    if (!states) { states = new Map(); attributeState.set(element, states); }
    for (const name of ["aria-label", "title", "placeholder"]) {
      if (!element.hasAttribute?.(name)) continue;
      const current = element.getAttribute(name);
      const state = states.get(name);
      const source = !state || current !== state.rendered ? current : state.source;
      const rendered = translateMessage(source, locale);
      states.set(name, { source, rendered });
      if (current !== rendered) element.setAttribute(name, rendered);
    }
  };
  const localize = (root = document) => {
    if (root.nodeType === NodeType.TEXT_NODE) localizeText(root);
    else {
      if (root.nodeType === NodeType.ELEMENT_NODE) localizeAttributes(root);
      const walker = document.createTreeWalker(root, NodeFilterType.SHOW_ELEMENT | NodeFilterType.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.nodeType === NodeType.TEXT_NODE) localizeText(walker.currentNode);
        else localizeAttributes(walker.currentNode);
      }
    }
  };
  const setLocale = (next) => {
    locale = next === "ru" ? "ru" : "en";
    document.documentElement.lang = locale;
    localize(document);
    document.dispatchEvent(new CustomEvent("patchy:localechange", { detail: { locale } }));
    return locale;
  };
  const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = Observer ? new Observer((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") localizeText(mutation.target);
      else if (mutation.type === "attributes") localizeAttributes(mutation.target);
      else for (const node of mutation.addedNodes) localize(node);
    }
  }) : null;
  observer?.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["aria-label", "title", "placeholder"] });
  return { localize, setLocale, disconnect: () => observer?.disconnect(), get locale() { return locale; },
    text: (value) => translateMessage(value, locale) };
}

export function isEditableTarget(event) {
  return Boolean(event.isComposing || event.target?.isContentEditable ||
    event.target?.matches?.("input, select, textarea, [contenteditable]"));
}

export function installRovingToolbar(container, selector = "button:not([hidden])") {
  const ownerDocument = container.ownerDocument;
  const items = () => [...container.querySelectorAll(selector)].filter((item) => !item.disabled);
  const sync = (preferred = ownerDocument.activeElement) => {
    const available = items();
    if (!available.length) return;
    const active = available.includes(preferred) ? preferred :
      available.find((item) => item.getAttribute("aria-pressed") === "true") || available[0];
    for (const item of container.querySelectorAll(selector)) item.tabIndex = item === active ? 0 : -1;
  };
  container.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const available = items(); const current = available.indexOf(ownerDocument.activeElement);
    if (current < 0 || !available.length) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 :
      (current + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
    sync(available[index]); available[index].focus();
  });
  container.addEventListener("focusin", (event) => sync(event.target));
  sync();
  return sync;
}

export function installDialogFocusReturn(document) {
  let lastExternalFocus = null;
  document.addEventListener("focusin", (event) => {
    if (!event.target.closest?.("dialog")) lastExternalFocus = event.target;
  });
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("close", () => {
      if (lastExternalFocus?.isConnected && !lastExternalFocus.disabled) {
        queueMicrotask(() => lastExternalFocus.focus({ preventScroll: true }));
      }
    });
  }
}
