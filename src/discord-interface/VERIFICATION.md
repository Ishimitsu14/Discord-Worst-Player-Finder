# Проверки discord-interface

Проверено 17 октября 2026 на Windows x64: Node.js v22.14.0, встроенная SQLite 3.47.2. Модуль использует публичные контракты GroupSettings, MatchPipeline, match-analysis и Storage. В сквозных тестах работают настоящий Discord SDK/REST, реальные публичные модули конвейера, временная SQLite и поддельный HTTP; Discord login не выполняется.

## Результаты

| Проверка | Результат |
|---|---|
| `npm.cmd run typecheck` | успешно |
| `npm.cmd run build` | успешно |
| `node --test dist/test/discord-interface-*.test.js` | 36/36 |
| `npm.cmd test` с разрешением файловых ссылок | 296/296: исходные 260 и 36 новых |
| `openspec.cmd validate add-discord-interface --type change --strict --no-interactive` | успешно |
| README JSON selected/insufficient-evidence | точное сравнение с renderer, JSON и лимиты проходят |

В sandbox проверенный на тот момент набор дал 238/295: 57 прежних тестов лаборатории получили EPERM на fs.link во временном каталоге. Новые тесты проходили. Финальный полный набор с обычными локальными правами дал 296/296. Код файловой записи лаборатории не менялся.

Новые тесты: `test/discord-interface-commands.test.ts` — 12, `test/discord-interface-render.test.ts` — 8, `test/discord-interface-rest.test.ts` — 8, `test/discord-interface-integration.test.ts` — 8. Типизированная сборка Publisher → pipeline → interface проверяется через `test/discord-interface-example.ts`, без настоящего bot token.

## Зависимость и runtime

Установлен exact discord.js 14.27.0 с `--ignore-scripts --engine-strict --no-audit --no-fund`. До установки npm metadata подтвердили engines >=18; импорт SDK, TypeScript и тесты прошли на Node v22.14.0. Node engines проекта остались >=22.14.0, target ES2023 не менялся. package-lock.json v3 соответствует установленным версиям.

| Пакет | Установленная и lock-версия | Node engines |
|---|---|---|
| discord.js | 14.27.0 | >=18 |
| @discordjs/rest | 2.6.3 | >=18 |
| @discordjs/builders | 1.14.1 | >=16.11.0 |
| @discordjs/util | 1.2.0 | >=18 |
| @discordjs/ws | 1.2.3 | >=16.11.0 |
| undici | 6.29.1 | >=18.17 |
| discord-api-types | 0.38.56 | не указан |

Установленный REST проверен по исходникам и через makeRequest: retries=0 закрывает сетевой/5xx retry, rejectOnRateLimit закрывает отдельный путь 429. Собственный REST адаптера использует API v10, timeout 15000, отключённые hash/handler sweepers. Тест сравнивает активные Timeout ресурсы до/после создания; после остановки интерфейса управляемые таймеры отсутствуют.

## Покрытие требований

| Requirement | Реализация и наблюдение | Тесты |
|---|---|---|
| Явное подключение интерфейса | создание без env/файлов/сети, копия настроек, отдельные handle/attach/stop, нет login/run | commands: config, listener; rest: inert factories; integration: example |
| Регистрация собственных команд в заданном сервере | три STRING-команды, radiant/dire, admin default; upsert собственных имён, чужая команда сохраняется, partial без retry | rest: definitions, registration |
| Доступ участников заданного канала | обычный участник может запросить анализ; DM/другой guild/channel/thread отклоняются до очереди | commands: access |
| Повторный анализ только администратором | runtime Administrator, ManageGuild и отсутствующие права не подходят, явная side обязательна | commands: access, invalid input, admin revision |
| Приватное подтверждение до долгой работы | deferReply ephemeral до OpenDota, ACK failure даёт ноль постановок, edit failure не повторяет commit | commands: ACK, failed edit; integration: SDK ephemeral callback |
| Проверка идентификаторов без потери точности | строгий match/job parser, ссылки/дроби/экспоненты/leading zero/overflow/missing отклоняются; uint64 остаётся строкой | commands: invalid input; rest: response IDs |
| Общий путь ручной постановки | requestMatch, queued/existing/requires-side/rejected; команды не запускают worker | commands: manual, ambiguity; integration: manual |
| Постоянный ключ команды повторного анализа | discord_interactionID, одна ревизия при повторной доставке и после reopen, unfinished conflict без отмены | commands: admin revision с настоящей Storage |
| Чтение статуса и прежнего результата | readonly status, failed новая версия рядом с прежним valid, billingUnknown/attention и ссылка по сохранённому ID; без генерации/публичной копии | commands: status, billing; integration: status/refusal/fault |
| Изоляция сохранённых задач по серверу и каналу | проверка frozen целей job и result; unknown/чужой ID дают одинаковый ответ; старый другой канал скрыт | commands: status, old target |
| Русский разбор одного или двух выбранных игроков | только принятый resultAttemptId/valid, публичная validateMatchAnalysis, slot/hero identity, metadata snapshot/facts; ник/герой/roast/2–3 причины, Radiant/Dire и оба исхода | render: identity, one/two, unknown hero, anonymous; integration: selected |
| Честное сообщение о недостаточных данных | ограничения и исход без selected/roast; сохранённый анализ не меняется | render: insufficient; integration: insufficient-evidence |
| Безопасное отображение внешнего текста | Markdown/URL/mentions/control/bidi нейтрализуются, lone surrogate заменяется; ник ограничен до regex; explicit empty allowed_mentions в JSON и приватных ответах | render: hostile strings, million-character nickname, mutations; integration: mentions |
| Ограниченный размер одного сообщения | один embed, индивидуальные лимиты и сумма <=6000 UTF-16, безопасное сокращение, герой и минимум два основания сохраняются, числовой токен не обрезается до другого числа | render: max strings, Unicode, numeric boundary, two selected |
| Только принятый результат и исходная цель публикации | prepare локален, invalid/unaccepted/identity mismatch отклоняются; frozen guild/channel, GET type/guild, точные сохранённые байты через passThroughBody | render: invalid; rest: target/body; commands: old target |
| Одноразовая публикация без скрытого повтора | nonce стабилен по attempt и меняется для новой версии; один wire POST при 429/5xx/network/timeout/abort, started receipt до POST, known ID без повторной отправки | rest: errors/retry; integration: full/fault/reopen |
| Подтверждённый отказ и неизвестный исход различаются | GET refusal даёт 0 POST; 400/401/403/404/429 not-sent, 408/5xx/network/неверный success unknown; valid остаётся читаемым | rest: outcome matrix; integration: confirmed 403/refusal |
| Отмена без ложного подтверждения доставки | signal передан SDK, отмена во время GET блокирует POST; живой Promise может вернуть поздний ID, без старого checkpoint/нового POST | rest: abort/late; integration: pipeline timeout/late ID |
| Безопасная диагностика и отделённый жизненный цикл | safe code/ID, без raw SDK ошибок; observer sync/async изолирован; один listener, active дедупликация, stop во время ACK/работы; Storage failure отключает listener, caller ресурсы остаются открыты | commands: observer/lifecycle/storage; rest: raw error token |

В таблице commands/render/rest/integration обозначают соответствующие `test/discord-interface-*.test.ts`.

## Сквозные сценарии и сбои

Manual и automatic проходят через реальный pipeline: постановка/обнаружение → сохранённый accepted анализ → started publication receipt с точным body → настоящий REST SDK с fake HTTP → сохранённый message ID → succeeded. На сценарий приходится один поддельный запрос MiMo и один публичный Discord POST; счётчики сопоставлены с журналом. Дополнительно проходит insufficient-evidence. Настоящий ChatInputCommandInteraction подтверждает ephemeral ACK и приватный status; проверка прав/ревизий выполняется отдельно через тот же public API и реальную SQLite.

Fault-тесты вызывают исключение после сохранения сообщения до send, имитируют потерю ответа после возможного удалённого эффекта и сбой между сохранением ID и finish. После reopen неизвестная отправка требует внимания, известный ID завершает задачу без POST. Сохранённый анализ остаётся читаемым. Подтверждённый Discord 403 записывается not-sent/forbidden и после reopen не запускает повтор. Поздний ID незавершённого REST Promise сохраняется, но не продвигает устаревший job checkpoint.

Эти проверки моделируют ошибки внутри процесса и переоткрытие БД; они не доказывают поведение настоящего Discord или всей инфраструктуры при отключении питания.

## Границы изменения

Новый код расположен в `src/discord-interface/`, импортирует соседей только через публичные index.ts. Соседние исходники, контракты, миграции, prompt и настройки live/budget не менялись. Общие изменения: exact dependency/lock, checkbox выбранного OpenSpec и строка модуля 6 в PROJECT_PLAN.md. Тестовые данные синтетические, БД создаются во временных каталогах и очищаются. Просмотр нового scope и поиск характерных форматов OpenRouter/Discord/private-key не обнаружили рабочих секретов; реальные снимки, local env и production БД не добавлялись.

## Непроверенное

- Linux runtime не запускался: `wsl.exe --list --quiet` сообщил, что WSL не установлен. Windows/TypeScript проверки не заменяют Linux прогон.
- Рабочая папка не содержит .git. Проверка рабочего git diff/check-ignore недоступна, Git не инициализировался; существующие ignore-правила не менялись.
- Реальная регистрация, login, gateway, права сервера и внешний вид сообщения в Discord не проверялись. Поддельный HTTP не отправляет сообщений и не расходует бюджет MiMo.
- Bootstrap, постоянная конфигурация automaticSince, VPS, supervision и backup относятся к operations. Здесь предоставлены модуль и пример явной сборки.
- MiMo остаётся experimental; синтетические тесты не подтверждают качество выбора худшего и не завершают лабораторную калибровку. Новый платный эксперимент не запускался.
