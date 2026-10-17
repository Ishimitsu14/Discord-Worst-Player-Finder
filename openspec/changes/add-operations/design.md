# Design

## Context

См. proposal.md. Подтверждены публичные контракты всех семи runtime-модулей и полный Windows набор 296 тестов. В package.json пока отсутствует start, БД использует SQLite DELETE/FULL и создаётся при openStorage. Storage не имеет API конфигурации процесса/backup и не запускает циклы. Pipeline требует внешнюю постоянную automaticSince; stop не владеет БД, а Publisher Promise может вернуться после остановки pipeline. Discord требует отдельный явный login/attach/register.

Пользователь запросил приватный GitHub и затем CI/CD на Linux + systemd. Репозиторий создан, isPrivate подтверждён. Git и gh доступны; Git и origin инициализированы. Указан отдельный VPS пользователя, root, порт 22 по умолчанию; SSH authentication пока не подтверждена. ОС, существующие сервисы и production Node будут проверены до изменения сервера. Адрес сервера, доступ и реальные секреты не являются файлами спецификации.

На Node v22.14.0 проверен node:sqlite: отдельного backup export нет. Официальная [документация этой версии](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html) описывает DatabaseSync; обновление минимального Node ради backup не требуется. Выбран backup после остановки приложения, в рамках той же эксклюзивной блокировки, с проверкой и закрытием Storage перед копированием.

## Goals / Non-Goals

**Goals:** собрать готовые порты без изменения их бизнес-логики; изолировать deploy от постоянных данных; проверять одну и ту же ревизию локально/в CI/после доставки; не терять доступный поздний outcome при штатной остановке.

**Non-Goals:** перенос CI секретов в runtime config, работа root-процесса бота, автоматическая регистрация команд на каждом рестарте, автоматическое признание неизвестных расходов/доставки, восстановление старой БД при откате кода, Kubernetes и распределённая блокировка.

## Decisions

### 1. Модуль и CLI

`src/operations/index.ts` экспортирует безопасные типы/ошибки и явные загрузку/запуск. Только cli.ts читает argv/env, подписывается на сигналы и выбирает exit code. Импорт не открывает файлы, БД или сеть. CLI: check, init, start, register-commands, status, backup; неизвестные команды/параметры отклоняются. npm start вызывает start, отдельный npm script предоставляет остальные команды. Env-файл загружается только явно через Node --env-file либо systemd EnvironmentFile.

Конфигурация JSON v1: applicationId, groupSettingsPath, dataDir, automatic (default false), pipeline (mode/allowExperimental/положительные budgets и существующие параметры PipelineOptions). Пути относительно файла конфигурации, а dictionary/prompt — относительно установленного release. Неизвестные ключи/неправильные типы отклоняются, конфиг не принимает токены. DISCORD_BOT_TOKEN обязателен для start/register; OPENROUTER_API_KEY только для live; OPENDOTA_API_KEY необязателен. Значения не печатаются. check выполняется без сети, создания БД и записи границы.

init явно создаёт dataDir, SQLite и operations-state.json; существующую БД/состояние не заменяет. start требует оба файла, отсутствие одного считается ошибкой, а не новой установкой. Отдельное состояние v1 содержит идентификатор установки и automaticSince (null до первого включения). Первое успешное включение automatic сохраняет now до discover; последующие рестарты/переключения сохраняют прежнюю границу. Состояние записывается атомарно с sync, ошибка запрещает запуск обнаружения. БД не очищается при отсутствии/ошибке конфигурации.

### 2. Сборка и остановка

Загрузка settings/dictionary/prompt → существующая Storage → один OpenDotaClient → собственный Publisher → Client Guilds → Discord ready с ограничением startup → постоянная граница → один pipeline → один interface/listener → один run. До готовности Discord нет обработчика очереди. register-commands — отдельный явный REST вызов с partial report, start его не вызывает.

prepare-only/manual — defaults. Live требует явных двух budgets, OPENROUTER_API_KEY и allowExperimental для текущего пакета. Лимит пилота не читается из лаборатории. Существующие правила pipeline остаются окончательными для каждого внешнего действия.

SIGINT/SIGTERM, ошибка Storage или отказ health writer запускают одну идемпотентную остановку: прекратить команды/новую работу, остановить pipeline, отключить Client. Operations отслеживает pending send Promise обёрткой Publisher без смены его результата/числа POST. Storage закрывается только после доступного завершения pipeline/публикаций; grace period ограничен. При превышении CLI завершается ненулевым кодом без выдуманного outcome; после рестарта действует существующий журнал. Нельзя обещать сохранение ответа после принудительного завершения процесса.

### 3. Диагностика

JSONL в stdout/stderr: timestamp, component, safe code и необходимые ID/агрегаты. Сырой SDK error, request/response, webhook URL, аккаунты/ники и content не логируются. Никаких debug listeners. Статус процесса пишется в dataDir отдельно от неизменяемой активации: revision, phase, timestamp, Discord ready и режим. Локальный status читает его без сети/запуска worker, проверяет свежесть; systemd active само по себе не считается подтверждением готовности приложения. Бюджет и неизвестный расход читаются через публичную Storage без разрешения unknown. Публичный HTTP endpoint не нужен.

### 4. CI и артефакт

CI на push/PR выполняет npm ci, typecheck, npm test на Windows и Linux, минимум на Node 22.14.0; supported Node 22 patch дополнительно проверяется для VPS. Actions закрепляются commit SHA. Тесты используют синтетику, не получают runtime API keys. Linux artifact содержит dist/src, package/lock, analysis/prompts, dictionary, deploy и REVISION, без dist/test, .local, env/SSH/config рабочих файлов.

CD выполняется только после всех CI jobs на push main либо явном workflow_dispatch main; permissions contents:read, отдельная concurrency production без отмены действующего deploy. SSH key и pinned known_hosts хранятся GitHub secrets, host/user/port — vars или secrets; пользовательские тексты не подставляются в shell как код. PR не может вызвать deploy. Root key пользователя в GitHub не копируется: создаётся отдельный deploy key/аккаунт с правами только приложения. Не добавляется требование повторного пользовательского approve на каждый push.

### 5. Linux + systemd и доставка

По результатам SSH-инвентаризации выбирается отдельный `/opt/discord-worst-player-finder` с releases/<sha>, current, runtime; постоянные `/var/lib/discord-worst-player-finder` и `/etc/discord-worst-player-finder` вне checkout. User бота и user доставки раздельны; у доставки ограниченный sudo на проверенный deploy helper и управление только своим unit. Системный Node и другие сервисы не меняются. Вспомогательные скрипты проверяют пути и SHA, не выполняют произвольную строку команд из workflow.

Свой Node 22 runtime фиксируется проверенной версией и SHA256 официального архива после определения architecture/glibc; не скачивается latest при каждом старте. Поддержанный production start/backup используют один [flock](https://raw.githubusercontent.com/util-linux/util-linux/master/sys-utils/flock.1.adoc) на локальном диске, удерживаемый процессом; конфликт завершается до работы. Lock-файл не удаляется при рестарте. Локальный Windows foreground предназначен для одного процесса; системная Linux блокировка проверяется отдельно.

Unit: обычный непривилегированный User, WorkingDirectory current, EnvironmentFile вне release, UMask=0077, Restart=on-failure с паузой и пределом частоты, RestartPreventExitStatus для configuration error, TimeoutStopSec больше app grace. systemd [Type=exec](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.service.xml) контролирует exec, готовность приложения проверяется дополнительно. Ограничения filesystem разрешают запись только данных/нужных runtime-каталогов; конкретные директивы проверяются установленным systemd-analyze verify.

Доставка распаковывает только собственный проверенный артефакт в новый release, ставит production зависимости из lock без install scripts, выполняет offline check. Затем останавливает только свой unit, получает lock, сохраняет backup, меняет current, запускает unit и ждёт fresh health с нужной revision. При неудаче переключает код обратно и перезапускает с той же рабочей БД. Нет SQL downgrade/автоматического восстановления данных. Если runtime-config отсутствует, deploy сообщает configuration-required и не объявляет бота работающим. Host-настройка и секреты в Git не коммитятся.

### 6. Резервирование и восстановление

Перед заменой кода делается cold backup под тем же lock: Storage открывается/проверяется и закрывается для завершения SQLite recovery; копируются DB и operations-state, проверяется копия публичным openStorage, manifest с digest/installation ID записывается последним. Неполный bundle не считается backup, существующий не перезаписывается. Ключи не включаются. Обычный архив живого app.sqlite без согласованной остановки не используется.

Runbook объясняет отдельное хранение config/secret, защищённый off-host вынос backup, ручное резервирование, проверку в отдельном каталоге и восстановление при выключенном unit. Старая копия может не содержать уже выполненных удалённых эффектов: после restore нельзя автоматически включать live/auto без сверки расходов/публикаций. Code rollback всегда сохраняет текущие данные. Периодическое off-host резервирование и автоматическая финансовая сверка не имитируются готовыми без настройки внешнего хранилища.

## Risks / Trade-offs

- [SSH/Discord configuration отсутствует] → CI и шаблоны готовятся независимо; реальные шаги и статус остаются незавершёнными до доступа, ключи в чате не запрашиваются.
- [Предыдущая сборка несовместима с будущей схемой] → offline check и fail-closed; автоматического DB downgrade нет.
- [Timeout удалённого действия] → grace + журнал; принудительное завершение оставляет unknown для проверки, не даёт нового допуска.
- [CI прошёл на иной ОС/runtime] → Linux и Windows jobs, runtime pin и production verify без тестовой генерации/сообщений.
- [Новая директория данных случайно сбрасывает расходы] → явный init, start не создаёт БД, данные вне release, installation identity в состоянии/backup; оператор не должен выполнять init для обхода бюджета.
- [Повреждение backup при сбое] → уникальный staging, проверка копии и manifest last; off-host копия остаётся обязанностью оператора до её настройки.

## Migration Plan

Проверить ignore/секреты → начальный commit/push private main → CI Linux/Windows → подтверждённая SSH-инвентаризация → отдельные пользователи/runtime/каталоги → GitHub deploy key/known_hosts → проверка unit → первая доставка. Секреты Discord и реальные guild/channel загружаются локально на VPS; до них запуск бота не объявляется успешным. По окончании фиксируются workflow run, commit SHA, revision/health/unit и непроверенные реальные API. Откат кода использует тот же dataDir, доступы не меняют приватность репозитория.
