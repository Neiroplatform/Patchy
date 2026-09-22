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
  "90° left": "90° влево",
  "90° right": "90° вправо",
  "ADJUSTMENT": "КОРРЕКЦИЯ",
  "Add Noise": "Добавить шум",
  "Adjustment layer": "Корректирующий слой",
  "Adjustment layers remain editable and are preserved through PSD save/reopen.": "Корректирующие слои остаются редактируемыми и сохраняются при записи и повторном открытии PSD.",
  "Align": "Выравнивание",
  "Allow expansion outside canvas": "Разрешить расширение за границы холста",
  "Amount": "Величина",
  "Anchor": "Опора",
  "Angle": "Угол",
  "Angle°": "Угол°",
  "Apply adjustment": "Применить коррекцию",
  "Apply commits all seven editable families as one undo step. Additional imported instances and Bevel, Gradient and Pattern effects remain intact.": "Все семь семейств эффектов применяются за один шаг отмены. Дополнительные эффекты тиснения, градиента и узора сохраняются.",
  "Apply effects": "Применить эффекты",
  "Apply filter": "Применить фильтр",
  "Apply paragraph to all": "Абзац ко всему тексту",
  "Apply paragraph to selection": "Абзац к выделению",
  "Apply style to all": "Стиль ко всему тексту",
  "Apply style to selection": "Стиль к выделению",
  "Apply transform": "Применить трансформацию",
  "Apply warp": "Применить деформацию",
  "Arc": "Дуга",
  "Arc lower": "Нижняя дуга",
  "Arc upper": "Верхняя дуга",
  "Arch": "Арка",
  "Auto leading %": "Автоинтерлиньяж %",
  "BL X": "Лев. ниж. X",
  "BL Y": "Лев. ниж. Y",
  "BR X": "Прав. ниж. X",
  "BR Y": "Прав. ниж. Y",
  "Background": "Фон",
  "Bend %": "Изгиб %",
  "Blend": "Наложение",
  "Bold": "Жирный",
  "Bottom": "Снизу",
  "Bottom left": "Снизу слева",
  "Bottom right": "Снизу справа",
  "Box Blur": "Блочное размытие",
  "Brightness / Contrast": "Яркость / Контраст",
  "Bulge": "Выпуклость",
  "Canvas operations": "Операции с холстом",
  "Canvas size": "Размер холста",
  "Center": "Центр",
  "Checker": "Шахматный",
  "Checking origin-private storage…": "Проверка локального хранилища…",
  "Choke %": "Сжатие %",
  "Clean older workspaces": "Очистить старые рабочие области",
  "Clockwise degrees": "Градусы по часовой стрелке",
  "Color Balance": "Цветовой баланс",
  "Color Overlay": "Наложение цвета",
  "Common effects": "Общие эффекты",
  "Constrain proportions": "Сохранять пропорции",
  "Content": "Содержимое",
  "Contrast": "Контраст",
  "Corner handles and preview use the same engine homography that is committed to PSD state. Editable text remains affine.": "Угловые маркеры и предпросмотр используют ту же гомографию движка, которая записывается в PSD. Текст остаётся аффинным.",
  "Could not open document": "Не удалось открыть документ",
  "Create shape": "Создать фигуру",
  "Create text": "Создать текст",
  "Create text layer": "Создать текстовый слой",
  "Create vector shape": "Создать векторную фигуру",
  "Crop": "Кадрировать",
  "Curves": "Кривые",
  "Custom gradient": "Свой градиент",
  "Custom pattern": "Свой узор",
  "Distance": "Расстояние",
  "Dots": "Точки",
  "Drop Shadow": "Тень",
  "Edit Smart Filter": "Изменить смарт-фильтр",
  "Effects visible": "Эффекты видимы",
  "Ellipse": "Эллипс",
  "Enable Color Overlay": "Включить наложение цвета",
  "Enable Drop Shadow": "Включить тень",
  "Enable Inner Glow": "Включить внутреннее свечение",
  "Enable Inner Shadow": "Включить внутреннюю тень",
  "Enable Outer Glow": "Включить внешнее свечение",
  "Enable Satin": "Включить глянец",
  "Enable Stroke": "Включить обводку",
  "End": "Конец",
  "End indent": "Конечный отступ",
  "Engine preview is live. Cancel leaves the document and history unchanged.": "Предпросмотр движка активен. Отмена не изменит документ и историю.",
  "Extension color": "Цвет расширения",
  "Family name": "Имя семейства",
  "Feather": "Растушёвка",
  "Filter": "Фильтр",
  "First indent": "Отступ первой строки",
  "Fish": "Рыба",
  "Fisheye": "Рыбий глаз",
  "Flag": "Флаг",
  "Flip horizontal": "Отразить по горизонтали",
  "Flip vertical": "Отразить по вертикали",
  "Font": "Шрифт",
  "Font file": "Файл шрифта",
  "Font files are capped at 16 MiB, validated by the browser font parser and kept only in origin-private storage.": "Файлы шрифтов ограничены 16 MiB, проверяются парсером браузера и хранятся только в локальном хранилище.",
  "Foreground": "Передний план",
  "Four-corner perspective": "Перспектива по четырём углам",
  "Free transform": "Свободная трансформация",
  "Gaussian Blur": "Размытие по Гауссу",
  "Grayscale": "Градации серого",
  "H scale %": "Масштаб по горизонтали %",
  "Height": "Высота",
  "Hexagon": "Шестиугольник",
  "High Pass": "Цветовой контраст",
  "Horizontal %": "По горизонтали %",
  "Hue / Saturation": "Цветовой тон / Насыщенность",
  "Image size": "Размер изображения",
  "Import image pixels": "Имортировать пиксели изображения",
  "Inflate": "Надуть",
  "Inner Glow": "Внутреннее свечение",
  "Inner Shadow": "Внутренняя тень",
  "Inside": "Внутри",
  "Install font": "Установить шрифт",
  "Installed assets": "Установленные ассеты",
  "Invert": "Инверсия",
  "Italic": "Курсив",
  "Justify": "По ширине",
  "Kind": "Тип",
  "LAYER": "СЛОЙ",
  "LAYER STYLE": "СТИЛЬ СЛОЯ",
  "LOCAL ASSETS": "ЛОКАЛЬНЫЕ АССЕТЫ",
  "LOCAL RECOVERY": "ЛОКАЛЬНОЕ ВОССТАНОВЛЕНИЕ",
  "Layer knocks out": "Слой выбивает",
  "Layer mask hides effects": "Маска слоя скрывает эффекты",
  "Leading": "Интерлиньяж",
  "Left": "Слева",
  "Levels": "Уровни",
  "Local font": "Локальный шрифт",
  "Median": "Медиана",
  "Mode": "Режим",
  "Mosaic": "Мозаика",
  "Opacity %": "Непрозрачность %",
  "Open PSD or PSB": "Открыть PSD или PSB",
  "Outer Glow": "Внешнее свечение",
  "Outside": "Снаружи",
  "Overprint": "Наложение краски",
  "PIXEL FILTER": "ПИКСЕЛЬНЫЙ ФИЛЬТР",
  "Paragraph": "Абзац",
  "Patchy Local Editor": "Локальный редактор Patchy",
  "Pixel Mosaic": "Пиксельная мозаика",
  "Position": "Положение",
  "Posterize": "Постеризация",
  "Precise": "Точная",
  "Presets, patterns & fonts": "Пресеты, узоры и шрифты",
  "Preview and final pixels use the same bounded engine warp. Smart Objects retain editable preset metadata.": "Предпросмотр и итоговые пиксели используют одну ограниченную деформацию движка. Смарт-объекты сохраняют редактируемые метаданные пресета.",
  "Range %": "Диапазон %",
  "Recover workspaces": "Восстановить рабочие области",
  "Rectangle": "Прямоугольник",
  "Reset ranges": "Сбросить диапазоны",
  "Resize canvas": "Изменить холст",
  "Right": "Справа",
  "Rise": "Подъём",
  "Rotate": "Поворот",
  "SELECTION": "ВЫДЕЛЕНИЕ",
  "SHAPE": "ФИГУРА",
  "SMART FILTER": "СМАРТ-ФИЛЬТР",
  "SVG (flattened)": "SVG (сведённый)",
  "Satin": "Глянец",
  "Save gradient": "Сохранить градиент",
  "Save pattern": "Сохранить узор",
  "Scale / rotate / flip": "Масштаб / поворот / отражение",
  "Scale image": "Масштабировать изображение",
  "Sepia": "Сепия",
  "Sharpen": "Резкость",
  "Shell lower": "Нижняя ракушка",
  "Shell upper": "Верхняя ракушка",
  "Shift Edge": "Сместить край",
  "Smooth": "Сглаживание",
  "Softer": "Мягкая",
  "Source": "Источник",
  "Space after": "Интервал после",
  "Space before": "Интервал перед",
  "Spread %": "Размах %",
  "Squeeze": "Сжатие",
  "Start": "Начало",
  "Start indent": "Начальный отступ",
  "Storage estimate unavailable": "Оценка хранилища недоступна",
  "Straighten angle": "Угол выравнивания",
  "Stroke": "Обводка",
  "Stroke width": "Ширина обводки",
  "Style": "Стиль",
  "TEXT": "ТЕКСТ",
  "TL X": "Лев. верх. X",
  "TL Y": "Лев. верх. Y",
  "TR X": "Прав. верх. X",
  "TR Y": "Прав. верх. Y",
  "Technique": "Метод",
  "The current selection limits the filter. Apply is one cancellable undo step.": "Текущее выделение ограничивает фильтр. Применение создаёт один отменяемый шаг.",
  "Threshold": "Порог",
  "Top": "Сверху",
  "Top left": "Сверху слева",
  "Top right": "Сверху справа",
  "Tracking": "Трекинг",
  "Transparent extension": "Прозрачное расширение",
  "Twist": "Скручивание",
  "Unsharp Mask": "Контурная резкость",
  "Untitled": "Без названия",
  "Use selection": "Из выделения",
  "V scale %": "Масштаб по вертикали %",
  "Vertical": "Вертикально",
  "Vertical %": "По вертикали %",
  "Wave": "Волна",
  "Width": "Ширина",
  "Remove": "Удалить",
  "No local assets yet.": "Локальных ассетов пока нет.",
  "Filtering selected layer locally": "Локальная фильтрация выбранного слоя",
  "Filter cancelled": "Фильтр отменён",
  "Could not apply filter": "Не удалось применить фильтр",
  "Origin-private storage is unavailable in this browser context.": "Локальное хранилище недоступно в этом контексте браузера.",
  "Recovery snapshots cannot be stored here.": "Здесь нельзя хранить снимки восстановления.",
  "Use a secure origin with persistent browser storage enabled.": "Используйте защищённый origin с включённым постоянным хранилищем браузера.",
  "No recoverable workspaces are stored on this device yet.": "На этом устройстве пока нет рабочих областей для восстановления.",
  "Completed checkpoints will appear here.": "Здесь появятся завершённые контрольные снимки.",
  "Recover": "Восстановить",
  "The browser did not report a storage quota.": "Браузер не сообщил квоту хранилища.",
  "Recovery storage could not be read.": "Не удалось прочитать хранилище восстановления.",
  "No older recovery workspaces are outside the keep-newest boundary.": "Нет старых рабочих областей за пределами сохраняемых новейших.",
  "Use bounded values and change at least one refinement setting.": "Используйте допустимые значения и измените хотя бы один параметр уточнения.",
  "Choose a non-group target layer.": "Выберите целевой слой, не являющийся группой.",
  "Rendering engine preview…": "Отрисовка предпросмотра движка…",
  "Cancelling at the next safe filter checkpoint…": "Отмена на ближайшей безопасной контрольной точке фильтра…",
  "Group": "Группа",
  "Text": "Текст",
  "Mask": "Маска",
  "Mask off": "Маска выключена",
  "Working": "Выполнение",
  "Closing document": "Закрытие документа",
  "Committing one canonical engine revision": "Запись одной канонической ревизии движка",
  "Copying editable layer": "Копирование редактируемого слоя",
  "Creating document": "Создание документа",
  "Exporting document": "Экспорт документа",
  "Navigating history": "Переход по истории",
  "Opening Smart Object contents": "Открытие содержимого Smart Object",
  "Placing Smart Object": "Помещение Smart Object",
  "Recovering document": "Восстановление документа",
  "Restarting editor engine": "Перезапуск движка редактора",
  "Switching document": "Переключение документа",
  "Could not apply adjustment": "Не удалось применить коррекцию",
  "Could not apply memory budget": "Не удалось применить лимит памяти",
  "Could not apply paragraph range": "Не удалось применить абзац к диапазону",
  "Could not apply paragraph style": "Не удалось применить стиль абзаца",
  "Could not apply text range": "Не удалось применить диапазон текста",
  "Could not apply text style": "Не удалось применить стиль текста",
  "Could not clean recovery workspaces": "Не удалось очистить рабочие области восстановления",
  "Could not close document": "Не удалось закрыть документ",
  "Could not copy editable layers": "Не удалось скопировать редактируемые слои",
  "Could not copy pixels": "Не удалось скопировать пиксели",
  "Could not create document": "Не удалось создать документ",
  "Could not delete local recovery": "Не удалось удалить локальное восстановление",
  "Could not encode layered document": "Не удалось записать слоёный документ",
  "Could not export document": "Не удалось экспортировать документ",
  "Could not import pixels": "Не удалось импортировать пиксели",
  "Could not install font": "Не удалось установить шрифт",
  "Could not open Smart Object contents": "Не удалось открыть содержимое Smart Object",
  "Could not paste pixels": "Не удалось вставить пиксели",
  "Could not place Smart Object": "Не удалось поместить Smart Object",
  "Could not prepare text": "Не удалось подготовить текст",
  "Could not recover workspace": "Не удалось восстановить рабочую область",
  "Could not remove local asset": "Не удалось удалить локальный ассет",
  "Could not reset text ranges": "Не удалось сбросить диапазоны текста",
  "Could not restart editor engine": "Не удалось перезапустить движок редактора",
  "Could not save gradient": "Не удалось сохранить градиент",
  "Could not save local preferences": "Не удалось сохранить локальные настройки",
  "Could not save pattern": "Не удалось сохранить узор",
  "Could not start engine": "Не удалось запустить движок",
  "Could not switch document": "Не удалось переключить документ",
  "Editor restarted with partial recovery": "Редактор перезапущен с частичным восстановлением",
  "History navigation failed": "Не удалось перейти по истории",
  "Local recovery checkpoint failed": "Ошибка локального снимка восстановления",
  "Raster preview failed": "Ошибка растрового предпросмотра",
  "Raster stroke cancelled": "Растровый штрих отменён",
  "Set a source first": "Сначала задайте источник",
  "Transform preview failed": "Ошибка предпросмотра трансформации",
  "Unsupported drop": "Неподдерживаемый файл",
  "Activating its canonical Worker session": "Активация канонической Worker-сессии",
  "Clone source set": "Источник клонирования задан",
  "Creating a linked canonical Worker session": "Создание связанной канонической Worker-сессии",
  "Decoding the image outside canonical document state": "Декодирование изображения вне канонического состояния",
  "Embedding source bytes and raster preview": "Встраивание исходных байтов и растрового предпросмотра",
  "Encoding the rendered composite locally": "Локальное кодирование отрисованного композита",
  "Pixels copied locally": "Пиксели скопированы локально",
  "Preparing a 1600 × 1000 RGBA workspace": "Подготовка рабочей области RGBA 1600 × 1000",
  "Releasing its canonical Worker session": "Освобождение канонической Worker-сессии",
  "Restoring confirmed local workspaces": "Восстановление подтверждённых локальных рабочих областей",
  "Transferring bytes to the isolated Worker": "Передача байтов изолированному Worker",
  "Trimming retained history if necessary": "Сокращение сохранённой истории при необходимости",
  "Validating and opening its latest complete local snapshot": "Проверка и открытие последнего полного локального снимка",
  "Worker crashed": "Worker аварийно завершился",
  "Worker crashed · recovering": "Worker аварийно завершился · восстановление",
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
    [/^Filtering selected layer · (\d+)%$/, "Фильтрация выбранного слоя · $1%"],
    [/^Applying (.+)$/, "Применение: $1"],
    [/^gradient · (.+)$/, "градиент · $1"],
    [/^pattern · (.+)$/, "узор · $1"],
    [/^font · (.+)$/, "шрифт · $1"],
    [/^Recovered (\d+) workspace(s?)$/, "Восстановлено рабочих областей: $1"],
    [/^(\d+) recoverable workspaces on this device\.$/, "Рабочих областей для восстановления: $1."],
    [/^(.+) used of approximately (.+) browser storage\.$/, "Использовано $1 из примерно $2 хранилища браузера."],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(source)) return source.replace(pattern, replacement);
  }
  if (source.includes(" · ")) {
    return source.split(" · ").map((part) => translateMessage(part, locale)).join(" · ");
  }
  return source;
}

export function chooseRovingLayerId(visibleLayers, selectedId) {
  if (!visibleLayers.length) return null;
  return visibleLayers.some((layer) => layer.id === selectedId) ? selectedId : visibleLayers[0].id;
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
  const setText = (element, value) => {
    const source = String(value ?? "");
    const rendered = translateMessage(source, locale);
    element.textContent = rendered;
    const node = element.firstChild;
    if (node) textState.set(node, { source, rendered });
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
  const setAttribute = (element, name, value) => {
    const source = String(value ?? "");
    const rendered = translateMessage(source, locale);
    let states = attributeState.get(element);
    if (!states) { states = new Map(); attributeState.set(element, states); }
    states.set(name, { source, rendered });
    element.setAttribute(name, rendered);
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
  return { localize, setLocale, setText, setAttribute,
    disconnect: () => observer?.disconnect(), get locale() { return locale; },
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
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dialog.close("cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
        .filter((item) => !item.hidden && item.getClientRects().length);
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
    dialog.addEventListener("close", () => {
      if (lastExternalFocus?.isConnected && !lastExternalFocus.disabled) {
        queueMicrotask(() => lastExternalFocus.focus({ preventScroll: true }));
      }
    });
  }
}
