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

Секреты: DISCORD_BOT_TOKEN для start/register-commands, OPENROUTER_API_KEY для live, необязательный OPENDOTA_API_KEY. Их передаёт окружение, либо явный `node --env-file=.local/service/service.env dist/src/operations/cli.js ...`. Файл env автоматически не загружается. В systemd используется отдельный EnvironmentFile вне release. Не передавайте ключи через аргументы CLI или чат.

```powershell
npm.cmd run service -- check --config .local/service/service.json
npm.cmd run service -- init --config .local/service/service.json
npm.cmd run service -- register-commands --config .local/service/service.json
npm.cmd start -- --config .local/service/service.json
```

check не создаёт данные и не обращается к API. init выполняется один раз явно; повтор или частичная существующая установка отклоняются. start требует существующие app.sqlite и operations-state.json и не создаёт их взамен отсутствующих/повреждённых. При прерванном первом init сохраните частичные файлы для проверки; автоматической очистки/повторной инициализации нет.

register-commands — отдельное внешнее действие с одним upsert на собственное имя, безопасным complete/partial отчётом. Start не регистрирует команды и не отправляет тестовое сообщение. До готовности Discord worker не начинает работу.

## Режимы и расходы

Пример использует automatic=false и prepare-only: ручные запросы допустимы, MiMo и публичная публикация не выполняются. Для automatic=true первое успешное подключение сохраняет automaticSince до discover. Граница не меняется после рестарта/выключения/включения и сохраняется в backup вместе с БД. Поиск после простоя ограничен глубиной pipeline; бессрочного catch-up нет.

Live требует mode=live, оба положительных maxTotalCostUsd/maxEstimatedCostPerAttemptUsd, OPENROUTER_API_KEY и allowExperimental=true для текущего пакета. Эти лимиты выбирает оператор явно; бюджет лабораторного пилота не переносится. Новый dataDir/БД нельзя использовать для обхода расходов. Unknown и needs-attention не разрешаются автоматически. Правила и ограничения бюджета остаются в [pipeline](../match-pipeline/README.md).

Config v1 принимает существующие PipelineOptions кроме automaticSince, которой владеет состояние установки. startupTimeoutMs и shutdownTimeoutMs — 1..60000, defaults 30000/60000. Неизвестные параметры и неправильные типы запрещены.

## Статус и остановка

```powershell
npm.cmd run service -- status --config .local/service/service.json
```

Status читает только status.json, проверяет phase, PID, timestamp <=45 секунд, режим/revision и агрегаты; сеть не используется. Логи JSONL содержат safe code и нужные ID, без raw исключений, тел API, токенов и пользовательского текста. Часы хоста должны быть корректны. Разрыв Discord виден после следующего heartbeat; PID/свежесть не доказывают работоспособность всех API.

Ctrl+C/SIGTERM запускают одну остановку listener/worker/Client. БД остаётся открытой для доступного позднего исхода Publisher до завершения отслеживаемых Promise. В конце grace CLI принудительно завершает процесс с code=1; неопределённый receipt остаётся для существующего recovery, новый POST не запускается. Ошибка конфигурации/аргументов даёт code=78, runtime failure — 1. Библиотечный startService не вызывает process.exit, а возвращает Service со stop/done; caller обязан обработать shutdown-timeout.

## Резервирование

Backup выполняется только после остановки приложения и получения той же блокировки установки на Linux. Запущенные другие процессы, GUI SQLite и ручные операции с этой БД также должны быть прекращены.

```powershell
# Остановите foreground-процесс перед этой командой.
npm.cmd run service -- backup --config .local/service/service.json --output .local/service/backup-2026-10-17
```

Команда проверяет и закрывает исходную БД, создаёт новый каталог без замены прежнего, копирует app.sqlite/operations-state.json, проверяет копию и пишет manifest.json последним. Только bundle с успешным manifest считается завершённым. Скопируйте backup в отдельное защищённое хранилище; локальный каталог на том же VPS не защищает от потери диска. Config и env сохраняются отдельно с ограниченными правами, секреты не входят в bundle.

Восстановление: остановить unit, удерживать его блокировку; проверить digest manifest и копию через openStorage в отдельном каталоге; сохранить текущие данные отдельно; восстановить DB и state как согласованную пару с теми же правами. Не оставлять старые journal/WAL/SHM от другой копии рядом с восстановленной БД. Процедура не удаляет их автоматически.

Старый backup не содержит всех последующих оплаченных запросов и сообщений. До включения live/automatic нужна сверка действий после его даты, расходов и unknown. Не считайте пропавший из копии receipt доказательством отсутствия отправки. Автоматического restore поверх рабочей БД и SQL downgrade нет. Code rollback использует текущую БД, а не backup.

CI/CD и systemd описываются в deploy/README.md. Реальный запуск считается подтверждённым только после fresh status нужной revision; доставленный код без секретов ещё не означает работающего бота.
