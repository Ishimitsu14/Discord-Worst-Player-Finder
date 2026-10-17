# Запуск сервиса

Operations собирает готовые модули через публичные index.ts. Сам импорт ничего не запускает. Node >=22.14.0; рабочие файлы и секреты вне Git. Для VPS предусмотрен один Linux/systemd процесс; локально на Windows также запускается один foreground процесс на dataDir.

## Локальная подготовка

```powershell
npm.cmd ci --ignore-scripts --engine-strict --no-audit --no-fund
npm.cmd run build
New-Item -ItemType Directory -Force .local/service
Copy-Item config/service.example.json .local/service/service.json
Copy-Item config/group-settings.example.json .local/service/group-settings.json
```

Заполните applicationId приложения Discord и реальные group-settings в локальных JSON. GroupSettings содержит только steamAccountIds/guildId/channelId. Пути groupSettingsPath/dataDir разрешаются относительно service.json; prompt и dictionary берутся из установленного release. Изменение конфигурации требует рестарта. В конфиг не добавляются токены.

Секреты: DISCORD_BOT_TOKEN для start/register-commands, OPENROUTER_API_KEY для live, необязательный OPENDOTA_API_KEY и STEAM_API_KEY для automatic+historySource=steam. Их передаёт окружение, либо явный `node --env-file=.local/service/service.env dist/src/operations/cli.js ...`. Файл env автоматически не загружается. В systemd используется отдельный EnvironmentFile вне release. Не передавайте ключи через аргументы CLI или чат.

Пользовательская переменная Windows, сохранённая после открытия терминала, не обновляет process.env этого терминала. Для уже сохранённого ключа в текущем PowerShell перед запуском:

```powershell
$env:STEAM_API_KEY = [Environment]::GetEnvironmentVariable('STEAM_API_KEY', 'User')
if ([string]::IsNullOrWhiteSpace($env:STEAM_API_KEY)) { throw 'STEAM_API_KEY отсутствует в User env' }
```

Значение не выводится. На Linux оператор добавляет STEAM_API_KEY в существующий приватный `/etc/discord-worst-player-finder/service.env` (root:worst-player, 0640), затем перезапускает свой unit. Этот код не переносит ключ с Windows и не меняет GitHub Secrets/VPS.

```powershell
npm.cmd run service -- check --config .local/service/service.json
npm.cmd run service -- init --config .local/service/service.json
npm.cmd run service -- register-commands --config .local/service/service.json
npm.cmd start -- --config .local/service/service.json
```

check не создаёт данные и не обращается к API. init выполняется один раз явно; повтор или частичная существующая установка отклоняются. start требует существующие app.sqlite и operations-state.json и не создаёт их взамен отсутствующих/повреждённых. При прерванном первом init сохраните частичные файлы для проверки; автоматической очистки/повторной инициализации нет.

register-commands — отдельное внешнее действие с одним upsert на собственное имя, безопасным complete/partial отчётом. Start не регистрирует команды и не отправляет тестовое сообщение. До готовности Discord worker не начинает работу.

## Режимы и расходы

`pipeline.publicationMode=on-command` отделяет автоматический анализ от публичной отправки. При automatic=true бот заранее готовит разборы новых матчей, но `/worst match_id:...` публикует готовый auto-результат только по команде; `/worst-status` остаётся чтением. Default старых конфигов — automatic publication; пример явно выбирает on-command при automatic=false/prepare-only. Постоянная automaticSince создаётся только при первом successful Gateway-ready включении automatic до discover, затем хранится в operations-state.json. Матчи, завершившиеся до границы или ровно на ней, автоматически не анализируются; рестарт/деплой не переносит границу. Никогда не сбрасывайте state/БД для запуска старой истории или обхода расходов.

Пример использует automatic=false и prepare-only: ручные запросы допустимы, MiMo и публичная публикация не выполняются. Для automatic=true первое успешное подключение сохраняет automaticSince до discover. Граница не меняется после рестарта/выключения/включения и сохраняется в backup вместе с БД. Поиск после простоя ограничен глубиной pipeline; бессрочного catch-up нет.

Live требует mode=live, оба положительных maxTotalCostUsd/maxEstimatedCostPerAttemptUsd, OPENROUTER_API_KEY и allowExperimental=true для текущего пакета. Эти лимиты выбирает оператор явно; бюджет лабораторного пилота не переносится. Новый dataDir/БД нельзя использовать для обхода расходов. Unknown и needs-attention не разрешаются автоматически. Правила и ограничения бюджета остаются в [pipeline](../match-pipeline/README.md).

Config v1 принимает существующие PipelineOptions кроме automaticSince, которой владеет состояние установки. startupTimeoutMs и shutdownTimeoutMs — 1..60000, defaults 30000/60000. Неизвестные параметры и неправильные типы запрещены.

Пример явно выбирает `historySource=steam` и `pollIntervalMs=60000`, сохраняя automatic=false/prepare-only. Рабочий service.json сам не перезаписывается. Без historySource действует OpenDota/900000; явный интервал имеет приоритет. Дополнительные параметры: discoveryRetryMs=60000, discoveryTimeoutMs=1800000 и maxDiscoveryChecksPerScan=10, диапазоны и состояния описаны в [pipeline](../match-pipeline/README.md). Смена источника сохраняет прежнюю automaticSince. Отсутствие Steam-ключа при automatic+steam отклоняется до активации и Gateway; ручной режим работает без него.

Диагностика передаёт безопасные accountId, коды и агрегаты pending/deferred/checks/accountsChecked. ready подтверждает процесс/Gateway, а не открытые истории всех друзей. status=15 — частный отказ истории, не пустой список; аккаунт остаётся в следующих опросах. По составу OpenDota можно подтвердить друга с закрытой историей; анонимный ID не угадывается. При всех закрытых историях используйте ручной ID. Ожидание OpenDota переживает restart и прекращается через сохранённый срок; после этого /worst может заново проверить данные, не запуская повторный анализ существующей задачи.

## Статус и остановка

```powershell
npm.cmd run service -- status --config .local/service/service.json
```

Status читает только status.json, проверяет phase, PID, timestamp <=45 секунд, режим/revision и агрегаты; сеть не используется. Логи JSONL содержат safe code и нужные ID, без raw исключений, тел API, токенов и пользовательского текста. Часы хоста должны быть корректны. Разрыв Discord виден после следующего heartbeat; PID/свежесть не доказывают работоспособность всех API.

Ctrl+C/SIGTERM запускают одну остановку listener/worker/Client. БД остаётся открытой для доступного позднего исхода Publisher до завершения отслеживаемых Promise. В конце grace CLI принудительно завершает процесс с code=1; неопределённый receipt остаётся для существующего recovery, новый POST не запускается. Ошибка конфигурации/аргументов даёт code=78, runtime failure — 1. Библиотечный startService не вызывает process.exit, а возвращает Service со stop/done; caller обязан обработать shutdown-timeout.

## Резервирование

Backup выполняется только после остановки приложения и получения той же блокировки установки на Linux. Запущенные другие процессы, GUI SQLite и ручные операции с этой БД также должны быть прекращены.

Обновление `add-steam-match-discovery` впервые открывает схему 1 как схему 2. **Cold backup выполните старым установленным релизом до первого открытия новым кодом**, с прежним совместимым конфигом; сохраните app.sqlite и operations-state.json вместе. Обычный backup новым кодом уже может мигрировать исходную БД. Offline check не открывает БД. В deploy/control.sh backup вызывается через прежний current до activate. Старый релиз схему 2 не прочитает; автоматическое переключение кода назад не восстановит совместимость данных.

```powershell
# Остановите foreground-процесс перед этой командой.
npm.cmd run service -- backup --config .local/service/service.json --output .local/service/backup-2026-10-17
```

Команда проверяет и закрывает исходную БД, создаёт новый каталог без замены прежнего, копирует app.sqlite/operations-state.json, проверяет копию и пишет manifest.json последним. Только bundle с успешным manifest считается завершённым. Скопируйте backup в отдельное защищённое хранилище; локальный каталог на том же VPS не защищает от потери диска. Config и env сохраняются отдельно с ограниченными правами, секреты не входят в bundle.

Восстановление: остановить unit, удерживать его блокировку; проверить digest manifest и копию через openStorage в отдельном каталоге; сохранить текущие данные отдельно; восстановить DB и state как согласованную пару с теми же правами. Не оставлять старые journal/WAL/SHM от другой копии рядом с восстановленной БД. Процедура не удаляет их автоматически.

Старый backup не содержит всех последующих оплаченных запросов и сообщений. До включения live/automatic нужна сверка действий после его даты, расходов и unknown. Не считайте пропавший из копии receipt доказательством отсутствия отправки. Автоматического restore поверх рабочей БД и SQL downgrade нет. Code rollback использует текущую БД только при совместимости схемы; иначе остановите сервис, сохраните новую БД отдельно и восстановите согласованную пару из совместимого backup вручную.

CI/CD и systemd описываются в deploy/README.md. Реальный запуск считается подтверждённым только после fresh status нужной revision; доставленный код без секретов ещё не означает работающего бота.

## Gemini runtime: подготовка включения

service.pipeline.analysisProfile поддерживает legacy (default старых config) и gemini; пример config/service.example.json выбирает gemini при automatic=false, mode=prepare-only, allowExperimental=false. Рабочий config не переключается. loadService всегда загружает analysis/prompts/v1 и gemini-v2, dotaconstants-v1.json и hero-metrics-v1.json. Повреждённые/отсутствующие материалы останавливают check/start до БД, активации и Gateway. Для очереди сохранённых Gemini материалы нужны и после смены новых задач на legacy.

OPENROUTER_API_KEY — inference, отдельный необязательный OPENROUTER_MANAGEMENT_KEY — сверка eligible неизвестного запроса. Совпадающие ключи отклоняются. Management key никогда не передаётся модели/Discord; его отсутствие не запрещает обычный live-анализ, но recovery требует ручной проверки. live также требует allowExperimental=true и явно заданные положительные оба лимита. Секреты не записываются в health/events.

В PowerShell сохранённый User env нужно перечитать в текущий процесс без вывода значения:

```powershell
$env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
$env:OPENROUTER_MANAGEMENT_KEY = [Environment]::GetEnvironmentVariable('OPENROUTER_MANAGEMENT_KEY', 'User')
npm.cmd run service -- check --config .local/service/service.json
```

На Linux секреты храните в приватном EnvironmentFile вне release, доступном только root/службе (600); не переносите локальные User env в Git. Необходимость и перенос management key согласуются отдельным операционным шагом.

Новый health v1 пишет reservedCostUsd/uncoveredUnknownCount наряду с известной стоимостью/unknownCount. readStatus допускает прежние v1 без этих полей. Бюджет читается из SQLite, health — только диагностика. Резерв не считается фактическим расходом.

**Схема 3:** до первого start/backup новым релизом остановите процесс и сделайте cold backup старым релизом, включая app.sqlite и operations-state.json. check не открывает БД. Старый код не читает схему 3; простой возврат symlink недостаточен — нужен совместимый backup БД/состояния/config с сохранением новой БД отдельно. Платный smoke, live-бюджет, CI/Linux и доставка текущего кода ещё не выполнялись.
