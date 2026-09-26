const RU = new Map(Object.entries({
  "Patchy editor home": "Главная редактора Patchy",
  "local editor": "локальный редактор",
  "Document actions": "Действия с документом",
  "Open PSD": "Открыть PSD",
  "New": "Новый",
  "Recovery": "Восстановление",
  "Versions": "Версии",
  "Assets": "Ассеты",
  "Diagnostics": "Диагностика",
  "System check": "Проверка системы",
  "Getting started": "Начало работы",
  "Help": "Помощь",
  "LOCAL-FIRST BETA": "ЛОКАЛЬНАЯ BETA",
  "Start editing locally": "Начните редактировать локально",
  "Your PSD or PSB stays in this browser unless you explicitly save or download it. Editing, recovery, versions and diagnostics run locally.": "PSD или PSB остаётся в этом браузере, пока вы явно не сохраните или не скачаете его. Редактирование, восстановление, версии и диагностика работают локально.",
  "Quick start": "Быстрый старт",
  "Open a file": "Открыть файл",
  "Create blank document": "Создать пустой документ",
  "Recover local work": "Восстановить локальную работу",
  "Check this browser": "Проверить этот браузер",
  "Keyboard map": "Карта клавиш",
  "Open file": "Открыть файл",
  "New document": "Новый документ",
  "Save or download": "Сохранить или скачать",
  "Undo / redo": "Отмена / повтор",
  "Fit / actual pixels": "Вписать / реальные пиксели",
  "Pan temporarily": "Временно перемещать холст",
  "Brush / Eraser / Move": "Кисть / Ластик / Перемещение",
  "Selection / Lasso / Magic select": "Выделение / Лассо / Волшебное выделение",
  "Quick Mask / Text / Pen": "Быстрая маска / Текст / Перо",
  "Show or hide panels": "Показать или скрыть панели",
  "Open this guide": "Открыть эту справку",
  "Recovery and support": "Восстановление и поддержка",
  "Automatic recovery keeps verified local checkpoints in origin-private storage.": "Автоматическое восстановление хранит проверенные локальные снимки в закрытом хранилище origin.",
  "Named versions are immutable and restore as a new document.": "Именованные версии неизменяемы и восстанавливаются как новый документ.",
  "Diagnostics exclude names, text, pixels, paths, URLs and source bytes; nothing is uploaded.": "Диагностика не включает имена, текст, пиксели, контуры, URL и исходные байты; ничего не загружается.",
  "Known limitations": "Известные ограничения",
  "Editing is 8-bit RGB; 16/32-bit input is converted for editing.": "Редактирование идёт в 8-битном RGB; 16/32-битные входные данные преобразуются для редактирования.",
  "CMYK and Lab are converted to RGB and are not saved as native modes.": "CMYK и Lab преобразуются в RGB и не сохраняются как нативные режимы.",
  "Safari has a limited support tier; use Chrome, Edge or Firefox for large work.": "Safari имеет ограниченный уровень поддержки; для большой работы используйте Chrome, Edge или Firefox.",
  "Cloud accounts, sharing and collaboration are not available in this local build.": "Облачные аккаунты, общий доступ и совместная работа недоступны в этой локальной сборке.",
  "Photoshop warning-free and 1,000-file corpus acceptance are still external release gates.": "Открытие в Photoshop без предупреждений и приёмка корпуса из 1 000 файлов по-прежнему являются внешними release gates.",
  "Keep this guide available from Help or press ? at any time.": "Справка всегда доступна через кнопку «Помощь» или клавишу ?.",
  "Mark guide complete": "Завершить знакомство",
  "Undo": "Отменить",
  "Redo": "Повторить",
  "Canvas": "Холст",
  "Layered document format": "Формат слоёного документа",
  "Download PSD": "Скачать PSD",
  "Save": "Сохранить",
  "Save as…": "Сохранить как…",
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
  "Saved to local file": "Сохранено в локальный файл",
  "Download created · document remains modified": "Скачивание создано · документ остаётся изменённым",
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
  "Mixer Brush": "Микс-кисть",
  "Pattern Stamp": "Узорный штамп",
  "Eraser": "Ластик",
  "Clone stamp": "Штамп",
  "Healing brush": "Восстанавливающая кисть",
  "Spot Healing Brush": "Точечная восстанавливающая кисть",
  "Patch Tool": "Заплатка",
  "Smudge Brush": "Палец",
  "Dodge Brush": "Осветлитель",
  "Burn Brush": "Затемнитель",
  "Sponge Brush": "Губка",
  "Blur Brush": "Размытие",
  "Sharpen Brush": "Резкость",
  "Softness": "Мягкость",
  "Patch": "Заплатка",
  "Source": "Источник",
  "Destination": "Назначение",
  "Sample all layers": "Образец со всех слоёв",
  "Transparent": "Прозрачный",
  "Strength": "Интенсивность",
  "Tones": "Тона",
  "Shadows": "Тени",
  "Midtones": "Средние тона",
  "Highlights": "Света",
  "Protect tones": "Защищать тона",
  "Mode": "Режим",
  "Desaturate": "Уменьшить насыщенность",
  "Saturate": "Увеличить насыщенность",
  "Vibrance": "Сочность",
  "Flow": "Нажим",
  "Wet": "Влажность",
  "Load": "Загрузка",
  "Mix": "Смешивание",
  "Pattern": "Узор",
  "Pattern size": "Размер узора",
  "Secondary": "Дополнительный",
  "Aligned": "Выровненный",
  "Applying Mixer Brush": "Применение микс-кисти",
  "Applying Pattern Stamp": "Применение узорного штампа",
  "Advanced paint cancelled": "Рисование отменено",
  "Advanced paint failed": "Ошибка рисования",
  "Local brush cancelled": "Локальная кисть отменена",
  "Local brush failed": "Ошибка локальной кисти",
  "Applying Smudge Brush": "Применение кисти «Палец»",
  "Applying Dodge Brush": "Применение осветлителя",
  "Applying Burn Brush": "Применение затемнителя",
  "Applying Sponge Brush": "Применение губки",
  "Applying Blur Brush": "Применение размытия",
  "Applying Sharpen Brush": "Применение резкости",
  "Applying Spot Healing": "Применение точечного восстановления",
  "Applying Patch": "Применение заплатки",
  "Spot Healing cancelled": "Точечное восстановление отменено",
  "Patch cancelled": "Заплатка отменена",
  "Select an area before using Patch Tool.": "Перед использованием Заплатки выделите область.",
  "Retouch repair failed": "Ошибка ретуши",
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
  "Document guides": "Направляющие документа",
  "Guides and snapping": "Направляющие и привязка",
  "Add vertical guide at document center": "Добавить вертикальную направляющую по центру документа",
  "Add horizontal guide at document center": "Добавить горизонтальную направляющую по центру документа",
  "Guides": "Направляющие",
  "Snap": "Привязка",
  "Clear": "Очистить",
  "Vertical guide": "Вертикальная направляющая",
  "Horizontal guide": "Горизонтальная направляющая",
  "pixels": "пикселей",
  "drag or press Delete": "перетащите или нажмите Delete",
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
  "Create a document": "Создать документ",
  "or drop it anywhere": "или перетащите его сюда",
  "START LOCALLY": "НАЧАТЬ ЛОКАЛЬНО",
  "Create a local document": "Создать локальный документ",
  "Choose a built-in canvas or enter custom dimensions. The document is created in the browser Worker and registered for local recovery.": "Выберите встроенный холст или укажите свои размеры. Документ создаётся в Worker браузера и регистрируется для локального восстановления.",
  "Document presets": "Пресеты документов",
  "Blank": "Пустой",
  "Social square": "Квадрат для соцсетей",
  "Presentation": "Презентация",
  "Print A4-like": "Печать A4",
  "Custom canvas": "Свой холст",
  "Create custom document": "Создать документ своего размера",
  "Already have work? Continue without upload.": "Уже есть документ? Продолжите без загрузки в сеть.",
  "Other ways to start": "Другие способы начать",
  "Open from device": "Открыть с устройства",
  "Open Help": "Открыть справку",
  "Opening document": "Открываем документ",
  "Reading layers and rendering pixels": "Читаем слои и рисуем пиксели",
  "Cancel": "Отмена",
  "Drop to open locally": "Перетащите для локального открытия",
  "No upload, no cloud copy": "Без загрузки и облачной копии",
  "Zoom out": "Уменьшить масштаб",
  "Zoom in": "Увеличить масштаб",
  "Fit": "Вписать",
  "Actual pixels": "Реальный размер",
  "Canvas navigation": "Навигация по холсту",
  "Local session": "Локальная сессия",
  "Recovery starting": "Запуск восстановления",
  "Recovery unavailable": "Восстановление недоступно",
  "Local recovery ready": "Локальное восстановление готово",
  "Protecting revision…": "Защита ревизии…",
  "Recovery needs attention": "Восстановление требует внимания",
  "Document protected locally": "Документ защищён локально",
  "Recovery not captured yet": "Восстановление ещё не сохранено",
  "LOCAL VERSIONS": "ЛОКАЛЬНЫЕ ВЕРСИИ",
  "Version history": "История версий",
  "Version name": "Имя версии",
  "Before color grading": "Перед цветокоррекцией",
  "Create version": "Создать версию",
  "Restore as new": "Восстановить как новый",
  "Loading local versions…": "Загрузка локальных версий…",
  "Named versions are immutable PSD or PSB snapshots stored only on this device. Restoring opens a new document and leaves the source unchanged.": "Именованные версии — неизменяемые снимки PSD или PSB, хранящиеся только на этом устройстве. Восстановление открывает новый документ и не изменяет исходный.",
  "Local version history is unavailable here.": "Локальная история версий здесь недоступна.",
  "Open a document in a secure browser context first.": "Сначала откройте документ в безопасном контексте браузера.",
  "No named versions exist for this document yet.": "Для этого документа пока нет именованных версий.",
  "Create a named version to preserve the current layered state.": "Создайте именованную версию, чтобы сохранить текущее состояние со слоями.",
  "Local version history could not be read.": "Не удалось прочитать локальную историю версий.",
  "Creating local version": "Создание локальной версии",
  "Encoding and verifying one immutable layered snapshot": "Кодирование и проверка неизменяемого снимка со слоями",
  "Local version created": "Локальная версия создана",
  "Could not create local version": "Не удалось создать локальную версию",
  "Restoring local version": "Восстановление локальной версии",
  "Validating and opening an independent layered document": "Проверка и открытие отдельного документа со слоями",
  "Version restored as new document": "Версия восстановлена как новый документ",
  "Could not restore local version": "Не удалось восстановить локальную версию",
  "Could not delete local version": "Не удалось удалить локальную версию",
  "Enter a version name.": "Введите имя версии.",
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
  "Liquify…": "Пластика…",
  "Add text": "Добавить текст",
  "Edit text": "Изменить текст",
  "Add shape": "Добавить фигуру",
  "Add adjustment": "Добавить коррекцию",
  "Place Smart Object": "Поместить Smart Object",
  "Replace Smart Object": "Заменить Smart Object",
  "Open contents": "Открыть содержимое",
  "Transform": "Трансформация",
  "Warp": "Деформация",
  "Liquify": "Пластика",
  "Liquify layer preview. Drag to apply the selected tool.": "Предпросмотр пластики слоя. Проведите по холсту выбранным инструментом.",
  "Tool": "Инструмент",
  "Forward Warp": "Деформация вперёд",
  "Reconstruct": "Реконструкция",
  "Smooth": "Сглаживание",
  "Twirl clockwise": "Скручивание по часовой",
  "Twirl counter-clockwise": "Скручивание против часовой",
  "Pucker": "Сморщивание",
  "Bloat": "Раздувание",
  "Freeze mask": "Заморозить маску",
  "Thaw mask": "Разморозить маску",
  "Brush size": "Размер кисти",
  "Pressure %": "Нажим %",
  "Density %": "Плотность %",
  "Show freeze mask": "Показать маску заморозки",
  "Restore all": "Восстановить всё",
  "Apply Liquify": "Применить пластику",
  "Drag over the preview. Cancel leaves pixels and history unchanged.": "Проведите по предпросмотру. Отмена не изменит пиксели и историю.",
  "All Liquify strokes restored.": "Все штрихи пластики сброшены.",
  "Use bounded brush controls.": "Задайте допустимые параметры кисти.",
  "Liquify stroke limit reached.": "Достигнут лимит штрихов пластики.",
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
  "dropShadow": "Тень",
  "colorOverlay": "Наложение цвета",
  "innerShadow": "Внутренняя тень",
  "outerGlow": "Внешнее свечение",
  "innerGlow": "Внутреннее свечение",
  "stroke": "Обводка",
  "satin": "Глянец",
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
  "LOCAL SUPPORT": "ЛОКАЛЬНАЯ ПОДДЕРЖКА",
  "Export diagnostics": "Экспорт диагностики",
  "No document is open": "Документ не открыт",
  "The local JSON includes coarse browser capabilities, anonymous document dimensions and counts, Worker lifecycle, recovery outcomes and command identifiers.": "Локальный JSON содержит общие возможности браузера, анонимные размеры и счётчики документа, жизненный цикл Worker, результаты восстановления и идентификаторы команд.",
  "Excluded:": "Исключено:",
  "document and layer names, text, pixels, previews, source bytes, paths, URLs, stack traces and error messages. Nothing is uploaded.": "имена документов и слоёв, текст, пиксели, превью, исходные байты, пути, URL, стеки и сообщения об ошибках. Ничего не загружается.",
  "I understand and want to create this local file.": "Я понимаю и хочу создать этот локальный файл.",
  "Download diagnostic JSON": "Скачать диагностический JSON",
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
  "Write permission was not granted; the document remains modified.": "Разрешение на запись не получено; документ остаётся изменённым.",
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
  "Alpha channel": "Альфа-канал",
  "Create adjustment": "Создать коррекцию",
  "Create adjustment layer": "Создать корректирующий слой",
  "Edit adjustment layer": "Изменить корректирующий слой",
  "Edit text layer": "Изменить текстовый слой",
  "Edit vector points": "Изменить векторные точки",
  "Mixed": "Смешано",
  "Pattern": "Узор",
  "Saved path": "Сохранённый контур",
  "The first instance of each common family is editable.": "Первый экземпляр каждого распространённого семейства можно изменять.",
  "Update adjustment": "Обновить коррекцию",
  "Update shape": "Обновить фигуру",
  "Update text": "Обновить текст",
  "Work path": "Рабочий контур",
  "bold": "жирный",
  "italic": "курсив",
  "left": "слева",
  "right": "справа",
  "center": "по центру",
  "justify": "по ширине",
  "off": "выключена",
  "Channel name": "Имя канала",
  "Path name": "Имя контура",
  "Delete the local recovery snapshot for": "Удалить локальный снимок восстановления для",
  "older recovery workspace": "старую рабочую область восстановления",
  "older recovery workspaces": "старых рабочих областей восстановления",
  "Open workspaces and the 8 newest closed workspaces are protected.": "Открытые и 8 самых новых закрытых рабочих областей защищены.",
  "Its latest confirmed local recovery snapshot will remain available.": "Его последний подтверждённый локальный снимок останется доступен.",
  "Local recovery is not confirmed, so recent changes may be lost.": "Локальное восстановление не подтверждено, поэтому последние изменения могут быть потеряны.",
  "Aligning layers": "Выравнивание слоёв",
  "Bordering selection": "Создание границы выделения",
  "Changing blend mode": "Изменение режима наложения",
  "Changing clipping": "Изменение обтравки",
  "Changing clipping path": "Изменение обтравочного контура",
  "Changing fill opacity": "Изменение непрозрачности заливки",
  "Changing layer lock": "Изменение блокировки слоя",
  "Changing opacity": "Изменение непрозрачности",
  "Clearing selection": "Снятие выделения",
  "Closing Magnetic Lasso": "Замыкание магнитного лассо",
  "Committing Quick Mask stroke": "Применение штриха быстрой маски",
  "Committing one canonical target revision": "Запись одной канонической ревизии цели",
  "Committing one guarded parent revision": "Запись одной защищённой родительской ревизии",
  "Contracting selection": "Сжатие выделения",
  "Copying editable layers": "Копирование редактируемых слоёв",
  "Creating Pen path": "Создание контура пером",
  "Creating adjustment": "Создание коррекции",
  "Creating layer mask": "Создание маски слоя",
  "Creating text": "Создание текста",
  "Creating vector mask": "Создание векторной маски",
  "Creating vector shape": "Создание векторной фигуры",
  "Cropping document": "Кадрирование документа",
  "Deleting channel": "Удаление канала",
  "Deleting layer": "Удаление слоя",
  "Deleting layers": "Удаление слоёв",
  "Deleting path": "Удаление контура",
  "Disabling layer mask": "Отключение маски слоя",
  "Distributing layers": "Распределение слоёв",
  "Editing layer effects": "Изменение эффектов слоя",
  "Editing path anchor": "Изменение узла контура",
  "Enabling layer mask": "Включение маски слоя",
  "Erasing pixels": "Стирание пикселей",
  "Expanding selection": "Расширение выделения",
  "Filling pixels": "Заливка пикселей",
  "Grouping layer": "Группировка слоя",
  "Grouping layers": "Группировка слоёв",
  "Growing selection by color": "Расширение выделения по цвету",
  "Inverting channel": "Инверсия канала",
  "Inverting layer mask": "Инверсия маски слоя",
  "Inverting selection": "Инверсия выделения",
  "Linking layer mask": "Связывание маски слоя",
  "Loading channel selection": "Загрузка выделения из канала",
  "Loading path selection": "Загрузка выделения из контура",
  "Merging visible copy": "Сведение копии видимых слоёв",
  "Moving layer": "Перемещение слоя",
  "Moving layers": "Перемещение слоёв",
  "Painting layer mask": "Рисование по маске слоя",
  "Painting pixels": "Рисование пикселей",
  "Preparing a local browser download": "Подготовка локального скачивания в браузере",
  "Writing after permission to a local file": "Запись в локальный файл после разрешения",
  "Rasterizing layer": "Растрирование слоя",
  "Refining selection": "Уточнение выделения",
  "Refining selection to layer mask": "Уточнение выделения в маску слоя",
  "Removing layer mask": "Удаление маски слоя",
  "Renaming channel": "Переименование канала",
  "Renaming layer": "Переименование слоя",
  "Renaming path": "Переименование контура",
  "Reordering channel": "Изменение порядка канала",
  "Reordering path": "Изменение порядка контура",
  "Replacing Smart Object": "Замена Smart Object",
  "Resizing canvas": "Изменение размера холста",
  "Revealing layer mask": "Показ маски слоя",
  "Rotating canvas": "Поворот холста",
  "Saving alpha channel": "Сохранение альфа-канала",
  "Saving document path": "Сохранение контура документа",
  "Scaling image": "Масштабирование изображения",
  "Selecting all": "Выделение всего",
  "Selecting area": "Выделение области",
  "Selecting connected color": "Выделение связанного цвета",
  "Selecting freehand area": "Свободное выделение области",
  "Selecting polygonal area": "Многоугольное выделение области",
  "Selecting similar colors": "Выделение схожих цветов",
  "Subtracting with Quick Select": "Вычитание быстрым выделением",
  "Transforming layer": "Трансформация слоя",
  "Transforming layers": "Трансформация слоёв",
  "Ungrouping layers": "Разгруппировка слоёв",
  "Unlinking layer mask": "Отвязка маски слоя",
  "Updating adjustment": "Обновление коррекции",
  "Updating layer": "Обновление слоя",
  "Updating layers": "Обновление слоёв",
  "Updating text": "Обновление текста",
  "Updating vector points": "Обновление векторных точек",
  "Warping layer": "Деформация слоя",
  "Move layer up": "Переместить слой выше",
  "Move layer down": "Переместить слой ниже",
  "Choose a TTF, OTF, WOFF or WOFF2 font file.": "Выберите файл шрифта TTF, OTF, WOFF или WOFF2.",
  "Font must be between 1 byte and 16 MiB.": "Размер шрифта должен быть от 1 байта до 16 МиБ.",
  "Enter a font family name.": "Введите имя семейства шрифта.",
  "Engine returned an incomplete flattened export": "Движок вернул неполный сведённый экспорт",
  "Clipboard does not contain an image": "В буфере обмена нет изображения",
  "Image dimensions cannot be represented safely": "Размеры изображения нельзя безопасно представить",
  "Curves require 2–64 ordered input:output points in the 0–255 range": "Кривые требуют 2–64 упорядоченных точек вход:выход в диапазоне 0–255",
  "Levels white points must not precede black points": "Белые точки уровней не могут предшествовать чёрным",
  "Legacy brightness and contrast must stay in the -100–100 range": "Устаревшие яркость и контраст должны быть в диапазоне -100–100",
  "Smart Object preview exceeds the 512 MB browser editing limit": "Предпросмотр Smart Object превышает лимит редактирования в браузере 512 МБ",
  "Text style metrics are outside the supported range": "Метрики стиля текста вне поддерживаемого диапазона",
  "Select a non-empty text range first": "Сначала выделите непустой диапазон текста",
  "Paragraph metrics are outside the supported range": "Метрики абзаца вне поддерживаемого диапазона",
  "Text selection is outside the story": "Выделение текста вне материала",
  "Select a paragraph first": "Сначала выберите абзац",
  "Text raster exceeds the 512 MB browser editing limit": "Растр текста превышает лимит редактирования в браузере 512 МБ",
  "Alt-click the canvas to choose a clone/heal source.": "Alt-щелчок по холсту выбирает источник клонирования/восстановления.",
  "A stroke cannot exceed 65,536 sampled points.": "Штрих не может содержать более 65 536 точек.",
  "Drop a PSD, PSB, PNG, JPEG, WebP, AVIF, or SVG file.": "Перетащите файл PSD, PSB, PNG, JPEG, WebP, AVIF или SVG.",
  "Earlier edit": "Более раннее изменение",
  "Later edit": "Более позднее изменение",
  "New document": "Новый документ",
  "Imported image": "Импортированное изображение",
  "Black input": "Чёрная точка входа",
  "White input": "Белая точка входа",
  "Black output": "Чёрная точка выхода",
  "White output": "Белая точка выхода",
  "RGB points (input:output)": "Точки RGB (вход:выход)",
  "Hue": "Цветовой тон",
  "Saturation": "Насыщенность",
  "Lightness": "Светлота",
  "Colorize": "Тонирование",
  "Colorize hue": "Тон тонирования",
  "Colorize saturation": "Насыщенность тонирования",
  "Colorize lightness": "Светлота тонирования",
  "Cyan / Red": "Голубой / Красный",
  "Magenta / Green": "Пурпурный / Зелёный",
  "Yellow / Blue": "Жёлтый / Синий",
  "Brightness": "Яркость",
  "Gamma %": "Гамма %",
  "Legacy mode": "Устаревший режим",
  "Block size": "Размер блока",
  "Distribution": "Распределение",
  "Monochromatic": "Монохромный",
  "Radius": "Радиус",
  "Seed": "Зерно",
  "Uniform": "Равномерное",
  "Gaussian": "Гауссово",
  "The engine is updating the document": "Движок обновляет документ",
  "Engine error": "Ошибка движка",
  "Enter a finite number": "Введите конечное число",
  "Enter a signed 32-bit whole number": "Введите целое 32-битное число со знаком",
  "Enter a positive signed 32-bit whole number": "Введите положительное целое 32-битное число со знаком",
  "Color must be a six-digit hex value": "Цвет должен быть шестизначным шестнадцатеричным значением",
  "bitmap frames": "кадры bitmap",
  "RGBA fallback": "резервный RGBA",
  "frame transport waiting": "ожидание транспорта кадра",
  "filter": "фильтр",
}));

const excluded = ".layer-name, #documentName, .document-tab, .recovery-copy strong, .text-run-list code";

export function translateMessage(value, locale = "en") {
  const source = String(value ?? "");
  if (locale !== "ru") return source;
  if (RU.has(source)) return RU.get(source);
  const shortcut = source.match(/^(.+) \(([^)]+)\)$/);
  if (shortcut && RU.has(shortcut[1])) return `${RU.get(shortcut[1])} (${shortcut[2]})`;
  let dynamic = source.match(/^Moving (\d+) state(?:s)?$/);
  if (dynamic) return `Переход на ${dynamic[1]} шаг(а)`;
  dynamic = source.match(/^Preparing a (\d+) × (\d+) RGBA workspace$/);
  if (dynamic) return `Подготовка рабочей области RGBA ${dynamic[1]} × ${dynamic[2]}`;
  dynamic = source.match(/^(Width|Height) must be a whole number from 1 to (\d+)$/);
  if (dynamic) return `${dynamic[1] === "Width" ? "Ширина" : "Высота"} должна быть целым числом от 1 до ${dynamic[2]}`;
  dynamic = source.match(/^(\d+) × (\d+) px$/);
  if (dynamic) return `${dynamic[1]} × ${dynamic[2]} пкс`;
  dynamic = source.match(/^(Gradient|Pattern): (.+)$/);
  if (dynamic) return `${translateMessage(dynamic[1], locale)}: ${dynamic[2]}`;
  dynamic = source.match(/^Applying (.+)$/);
  if (dynamic) return `Применение: ${translateMessage(dynamic[1], locale)}`;
  dynamic = source.match(/^(.+) (rejected|failed)$/);
  if (dynamic) return `${translateMessage(dynamic[1], locale)}: ${dynamic[2] === "rejected" ? "отклонено" : "ошибка"}`;
  dynamic = source.match(/^Encoding (.+)$/);
  if (dynamic) return `Кодирование ${dynamic[1]}`;
  dynamic = source.match(/^(Save|Download) (PSD|PSB)$/);
  if (dynamic) return `${dynamic[1] === "Save" ? "Сохранить" : "Скачать"} ${dynamic[2]}`;
  dynamic = source.match(/^Engine mode (\d+)$/);
  if (dynamic) return `Режим движка ${dynamic[1]}`;
  dynamic = source.match(/^Imported mode (\d+)$/);
  if (dynamic) return `Импортированный режим ${dynamic[1]}`;
  dynamic = source.match(/^Layer (\d+)$/);
  if (dynamic) return `Слой ${dynamic[1]}`;
  dynamic = source.match(/^(\d+) layers$/);
  if (dynamic) return `Слоёв: ${dynamic[1]}`;
  dynamic = source.match(/^(\d+)-bit RGB$/);
  if (dynamic) return `${dynamic[1]}-бит RGB`;
  dynamic = source.match(/^(.+): (\d+) additional$/);
  if (dynamic) return `${translateMessage(dynamic[1], locale)}: дополнительных — ${dynamic[2]}`;
  dynamic = source.match(/^Imported stacked effects preserved — (.+)\.$/);
  if (dynamic) return `Импортированные составные эффекты сохранены — ${dynamic[1].split(", ").map((part) => translateMessage(part, locale)).join(", ")}.`;
  dynamic = source.match(/^(.+); could not restore the source document$/);
  if (dynamic) return `${translateMessage(dynamic[1], locale)}; не удалось восстановить исходный документ`;
  dynamic = source.match(/^(.+) needs an estimated (.+) plus (.+) already retained, above this browser's (.+) safety limit\.$/);
  if (dynamic) return `${translateMessage(dynamic[1], locale)}: требуется примерно ${dynamic[2]} плюс ${dynamic[3]} уже занято, что выше безопасного лимита браузера ${dynamic[4]}.`;
  dynamic = source.match(/^Engine returned a (.+) frame, expected (.+)$/);
  if (dynamic) return `Движок вернул кадр ${dynamic[1]}, ожидался ${dynamic[2]}`;
  dynamic = source.match(/^Engine returned (.+) RGBA bytes, expected (.+)$/);
  if (dynamic) return `Движок вернул ${dynamic[1]} байт RGBA, ожидалось ${dynamic[2]}`;
  dynamic = source.match(/^Engine returned an unsupported frame transport: (.+)$/);
  if (dynamic) return `Движок вернул неподдерживаемый транспорт кадра: ${dynamic[1]}`;
  dynamic = source.match(/^Browser could not encode (.+)$/);
  if (dynamic) return `Браузер не смог закодировать ${dynamic[1]}`;
  dynamic = source.match(/^(.+) is outside the supported range$/);
  if (dynamic) return `${translateMessage(dynamic[1], locale)}: значение вне поддерживаемого диапазона`;
  dynamic = source.match(/^(\d+) workspace\(s\) restored from confirmed snapshots; (\d+) could not be restored(?:: ([^;]+))?(?:; (\d+) had unconfirmed changes and were rolled back)?\.$/);
  if (dynamic) return `Восстановлено из подтверждённых снимков: ${dynamic[1]}; не удалось: ${dynamic[2]}${dynamic[3] ? ` (${dynamic[3]})` : ""}${dynamic[4] ? `; откачены неподтверждённые изменения: ${dynamic[4]}` : ""}.`;
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
    [/^gradient · (.+)$/, "градиент · $1"],
    [/^pattern · (.+)$/, "узор · $1"],
    [/^font · (.+)$/, "шрифт · $1"],
    [/^indents (.+)$/, "отступы $1"],
    [/^Recovered (\d+) workspace(s?)$/, "Восстановлено рабочих областей: $1"],
    [/^(\d+) recoverable workspaces? on this device\.$/, "Рабочих областей для восстановления: $1."],
    [/^(\d+) immutable local versions?\. The newest 20 are retained\.$/, "Неизменяемых локальных версий: $1. Сохраняются 20 новейших."],
    [/^(\d+) editable layers? copied locally$/, "Редактируемых слоёв скопировано локально: $1"],
    [/^(.+) retained$/, "удерживается $1"],
    [/^(.+) history$/, "история $1"],
    [/^(.+) cache$/, "кэш $1"],
    [/^(.+) limit$/, "лимит $1"],
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

export const betaGuideStorageKey = "patchy.beta-guide.v1";

export function installBetaGuide(document, storage = globalThis.localStorage) {
  const byId = (id) => document.getElementById(id);
  const dialog = byId("helpDialog");
  const help = byId("helpButton");
  if (!dialog || !help || help.dataset.installed === "true") return null;
  help.dataset.installed = "true";
  const completed = () => {
    try { return storage?.getItem(betaGuideStorageKey) === "complete"; }
    catch { return false; }
  };
  const syncLabel = () => { help.textContent = completed() ? "Help" : "Getting started"; };
  let returnFocus = help;
  const open = (event) => {
    const invoker = event?.currentTarget ?? document.activeElement;
    returnFocus = invoker?.focus && !invoker.closest?.("dialog") ? invoker : help;
    if (!dialog.open) dialog.showModal();
  };
  dialog.addEventListener("close", () => {
    const target = returnFocus?.isConnected === false || returnFocus?.disabled ? help : returnFocus;
    queueMicrotask(() => target?.focus?.({ preventScroll: true }));
  });
  const activate = (targetId) => {
    dialog.close("action");
    const target = byId(targetId);
    if (target && !target.disabled) queueMicrotask(() => target.click());
  };
  help.addEventListener("click", open);
  byId("gettingStartedButton")?.addEventListener("click", open);
  byId("helpOpenButton")?.addEventListener("click", () => activate("openButton"));
  byId("helpNewButton")?.addEventListener("click", () => activate("newButton"));
  byId("helpRecoveryButton")?.addEventListener("click", () => activate("recoveryButton"));
  byId("completeGuideButton")?.addEventListener("click", () => {
    try { storage?.setItem(betaGuideStorageKey, "complete"); } catch { /* Help remains available. */ }
    syncLabel(); dialog.close("complete");
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey ||
        isEditableTarget(event) || document.querySelector("dialog[open]")) return;
    event.preventDefault(); open();
  });
  syncLabel();
  return { open, completed };
}

if (globalThis.document?.getElementById?.("helpDialog")) {
  queueMicrotask(() => installBetaGuide(globalThis.document));
}
