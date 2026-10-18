## Единственный повтор парсинга — production 18 октября 2026

Код `7a6d519a18775b58a8f834885657e9d34bb1df16` доставлен штатным автодеплоем из main: [PR №4](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/pull/4), [main CI/CD 39135755148](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39135755148). Все три проверки, release с production install/check и deploy успешны. Ubuntu / Node 22.14.0 и 22.23.3 — 511/511; Windows / Node 22.14.0 — 505 pass/6 Linux-only skip/0 fail. Перед main тот же код прошёл [PR CI 39134921903](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39134921903).

Скачанный runtime-архив содержит 129 записей, SHA256 `e04ef399f82862de555ccb030cb80f23b69043879bc3392bf8be63ba9a6c10e2`. REVISION и архивный digest совпали с VPS; скомпилированные pipeline/storage побайтно совпали с проверенной локальной сборкой и файлами работающего релиза. Состав архива и версии обоих семейств prompt-пакетов/словарей проверены отдельно.

Read-only проверка VPS в `2026-10-18T14:32:23Z`: revision `7a6d519`, unit active/enabled, phase ready, Discord Gateway ready. Схема 3 и `PRAGMA quick_check=ok`; 13 jobs, 195 artifacts, 29 external attempts, незавершённых внешних исходов нет. Хеши config/group/env/operations-state/receiver и automaticSince=1792270545647 совпали с исходным снимком. Сохранены Gemini/Steam/live/automatic/on-command. Штатный receiver создал cold backup `20261018T143139-30469` (manifest createdAt `2026-10-18T14:31:43.436Z`): контрольные суммы обоих файлов, схема 3, quick_check и прежнее состояние подтверждены. Рабочая БД читалась через mode=ro.

Это проверка доставки и готовности; новый реальный матч с повторным POST, платный анализ и сообщение Discord этим релизом не запускались. Ниже сохранён локальный протокол до доставки.

## Единственный повтор парсинга — локальная проверка 18 октября 2026

В live после первого принятого запроса разбора через 120000 мс выполняется fresh GET: parsed продолжает подготовку фактов, basic разрешает ровно один повторный POST. Опрос не откладывает эту границу на полный parsePollMs. replay_url не является условием. Каждый POST имеет отдельный сохранённый started; повтор содержит исходные attemptId/createdAt первой попытки. Перезапуск и противоположная сторона не создают третий допуск и не продлевают общий parseTimeoutMs (по умолчанию 15 минут от первой попытки). Неизвестный исход требует внимания; однозначный отказ второго POST завершает задачу без новой отправки.

Новые проверки: `test/storage-parse-retry.test.ts` — 3/3, `test/match-pipeline-parse-retry.test.ts` — 7/7. Проверены ранний допуск и точная граница двух минут, отдельное SQLite-соединение, общая цепочка обеих сторон, reopened DB, исходный deadline, свежий parsed до повтора, известное и неизвестное завершение второго POST, prepare-only и сбой после сохранения допуска до ответа. Счётчики HTTP сверены с сохранёнными receipts; тесты используют fake HTTP/clock и настоящие временные SQLite без реальных API/LLM/Discord.

Windows / Node.js 22.14.0 / SQLite 3.47.2: typecheck/build успешны; focused — 10/10; полный `npm test` — 511 тестов, 505 pass/6 Linux-only skip/0 fail. Первый полный прогон внутри Windows sandbox упёрся в EPERM/write-error файловых операций; полный повтор с разрешением этих операций успешен. Strict OpenSpec `add-match-pipeline` и `git diff --check` успешны. Схема БД остаётся 3, старые parse-input без retryOf читаются прежним образом. Рабочая БД, конфиг и сервис не менялись; Linux/CI/VPS и реальные POST новой логики не проверялись. Ниже сохранены исторические проверки предыдущих версий.

## Исправление одной команды — production 18 октября 2026

Один /worst во время auto-анализа теперь разрешает отправку после valid без повторной команды; сырой Steam-кандидат не блокирует обычный ручной ID. Исправление доставлено в `609d1e4e8f2729ced4b3f766b95f38527d87ca7d`, [main CI/CD 39071042236](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39071042236) успешен. Windows / Node 22.14.0 — 501 тест: 495 pass/6 Linux-only skip/0 fail; Ubuntu / Node 22.14.0 и 22.23.3 — 501/501. Локальные build/typecheck, focused 25/25 и strict OpenSpec 15/15 успешны. Схема 3, прежняя automaticSince=1792270545647 и рабочие данные сохранены, ready подтверждён read-only. [Полный протокол и ограничения](../operations/VERIFICATION.md). Реальную slash-команду после этой доставки ещё не повторяли; ниже — локальные/исторические этапы.

## Ручная команда во время авторазбора — локальная проверка 18 октября 2026

Исправлено ложное ожидание сырого Steam-кандидата с reason=null: ручной ID сразу проверяется через OpenDota; подтверждённые 404/неполные данные/cooldown сохраняют прежнее ожидание. Существующий job имеет приоритет и после завершения GET, включая гонку с auto-допуском. Старый готовый матч за пределом фонового лимита поставлен вручную, другие старые матчи автоматически не анализируются.

Один /worst для queued/running auto-задачи сохраняет scoped намерение отдельным immutable artifact на схеме 3 без изменения версии/lease. Checkpoint, defer и reopen сохраняют его; worker читает актуальное намерение перед публикацией, а атомарный defer закрывает потерянное пробуждение. Needs-attention/неизвестная доставка не возобновляются. Fake inference с настоящим Discord-интерфейсом подтвердил одну команду во время анализа и один пост после valid без новой генерации. Второе соединение SQLite проверило гонку записи между gate и defer. /worst-status и чужая цель не разрешают отправку.

Windows / Node.js 22.14.0: build/typecheck успешны; focused manual-publication/Steam — 25/25; полный набор — 501, 495 pass/6 Linux-only skip/0 fail. Новых реальных генераций/сообщений не запускалось. CI/артефакт/production текущего исправления ещё не проверены; ниже — исторические протоколы прежнего SHA.

## Production: авторазбор новых матчей — 18 октября 2026

Режим on-command доставлен на VPS в SHA `5fa610aebbb5ee93b4b25ca6045166471b212c0e`; [main CI/CD 39068184254](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39068184254) успешен. Typecheck/build и production install/check успешны. Обе Linux-конфигурации (Node 22.14.0/22.23.3) — 495/495; Windows/22.14.0 — 489 pass/6 Linux-only skip/0 fail. Strict OpenSpec — 15/15. Проверка 299 файлов по известным шаблонам секретов/приватных путей не нашла совпадений; это ограниченная проверка шаблонов.

Первая production-активация сохранила automaticSince=`1792270545647` (`2026-10-17T20:55:45.647Z`): старые и равные границе матчи не допускаются к анализу, state/DB не сбрасывались. После запуска read-only oldAnalyzed=0; automatic/live/Gemini/Steam/on-command и готовность сервиса подтверждены. Денежный лимит снят по явному решению пользователя. Авторазбор молчит до /worst; реальные тестовые генерации/публикации на production не выполнялись. [Полный протокол доставки и границы проверки](../operations/VERIFICATION.md). Ниже — результаты локального этапа и исторические проверки.

## Авторазбор и публикация по команде — 18 октября 2026

Режим publicationMode=on-command реализован на прежней SQLite схеме 3: auto-valid сохраняется в waiting/publication-ready, worker возвращает idle, до `/worst` нет publication receipt/POST. Scoped intent атомарен, повтор не меняет версию, claim/checkpoint/reopen сохраняют разрешение. После команды один настоящий Discord REST SDK POST использует сохранённый анализ; неизвестная отправка остаётся needs-attention без повторного POST. `/worst-status` и команда до готовности не выдают разрешение заранее, чужая цель не меняет задачу. Default automatic и первоначальный ручной origin сохраняют прежнее поведение.

Отдельно проверена старая/равная/новая граница end time в Steam-историях и reopen с той же automaticSince: до границы и на ней нет job/AI; только новый матч получает одну синтетическую генерацию и остаётся без публикации. Operations activation-тест проверяет постоянную границу также с on-command. Production state не сбрасывается.

Windows / Node.js 22.14.0: typecheck/build успешны, manual-publication + Steam — 19/19; полный набор — 495 тестов, 489 pass/6 Linux-only skip/0 fail. Strict нового change успешен. Это реальные публичные модули/SQLite/Discord SDK с fake HTTP без платных вызовов; CI/Linux, delivery и первая production-активация текущего кода ещё не выполнены. Права бота в рабочем канале и один read-only Steam GET подтверждены отдельно; значения ключей не выводились.

## Интеграция Gemini runtime — локальная проверка 17 октября 2026

Финальный локальный прогон: Windows / Node.js 22.14.0; typecheck/build успешны; npm test — 486 тестов, 480 pass, 6 Linux-only skip, 0 fail. Strict OpenSpec и git diff --check успешны; проверка изменённых исходников/документов не нашла секретов. Offline production install/check артефакта прошёл. Linux/CI/VPS текущего diff не запускались.

Изменение add-gemini-runtime-integration соединяет исходные Gemini DTO с SQLite/очередью/Discord/operations; прежние профили и API остаются. Ниже исторические результаты других этапов, они не подтверждают доставку текущего diff.

- test/storage-gemini.test.ts: схема 3, upgrade 1/2, rollback DDL/COMMIT, старые checksums/requestId, смешанные профили, frozen body, SSE/final/quote/evidence, идемпотентность, единственный потомок, эффективный actual/reserve/unknown и reopen/crash. Прежние storage/discovery/crash suites продолжают действовать.
- test/gemini-runtime.test.ts: инертность, чистые словари без env/сети/файлов, default legacy, prepare-only/basic→parsed, обе стороны/исхода/v1/v2, сохранённый пакет при смене config, 10/30/60 и точный session, recorded/partial/HTTP/malformed/stale/truncated/чужая сессия/отмена, бюджет и смена тарифов, fresh beforeSend, audited operator resume, восстановление valid/final/решения, lease loss и отдельное Steam-обнаружение. Максимум два inference POST на цепочку.
- test/discord-gemini.test.ts: hostile Unicode/mentions/URL, размеры 6000/1024, четыре основания и три отдельных финальных пункта, стабильный nonce, старый valid при сбое новой ревизии, scope/admin и статусы резерва без выдуманного отчёта. JSON-пример README сравнивается с публичным renderer.
- test/operations.test.ts и operations-delivery.test.ts: fail bad materials до DB/Gateway/активации/сети, оба семейства пакетов/словарей, отдельный management transport key, health v1 старого/нового вида и безопасные события; allowlist обоих словарей, offline production npm ci с omit=dev, check распакованного артефакта с запрещённым fetch, отсутствие dataDir, отказ missing/corrupt словарю (штатный CLI exit 78).

Используются настоящие временные SQLite и поддельные OpenDota/Gemini SSE/management/Discord. Новые runtime-зависимости не добавлены. now() в GeminiRecoveryDependencies согласует audit checkedAt с Clock/wait; production default Date.now сохранён.

Не проверены текущие Linux/CI/VPS, реальная доставка сообщения, новый платный запрос и recovery провайдера. Не выполнялась калибровка качества или latency. Рабочий config/БД/секреты не менялись. До первого открытия схемы 3 необходим cold backup старым релизом; старый код новую БД не прочитает. Архивация требует отдельного согласованного baseline sync прежних main specs.

# Проверки match-pipeline

## Steam-обнаружение, 17 октября 2026

`test/match-pipeline-steam.test.ts`: **13/13** с настоящими SteamHistoryClient/OpenDotaClient/Storage, временными SQLite, управляемыми часами и поддельными API. Проверены старые defaults/ручной режим без Steam, строгие параметры, status=15/ошибки/авторизация/429, пагинация и продвижение следующих аккаунтов при пределе новых ID, terminal без повторных GET, canonical context, 404→готовность после выпадения из страниц и reopen, нулевое/неизвестное завершение, неполные союзники, граница равенства, скрытый второй ID, конфликт/две стороны, deadline/Retry-After, manual race и сбой между enqueue/admitted. Остановка отменяет незавершённый HTTP и не создаёт второй loop/worker.

Сквозной сценарий: 10 Steam32, три разные пары, приватная история одного участника, две проверки за цикл, запаздывающие OpenDota-данные, reopen и последующая выдача трёх valid-результатов без дополнительных HTTP/генераций. POST анализа здесь поддельные; реальные модель и Discord не вызываются. Реальная миграция проверена отдельно в storage. Прежние тесты parse/analysis/publication оставлены в полном наборе.

Живой read-only прогон нового SteamHistoryClient 17 октября 2026 подтвердил доступную историю 98341323 (5 матчей, последний 9048979975) и status=15 для 122376567: два GET без повторов, 979/252 мс. [Протокол клиента](../steam/VERIFICATION.md). Конвейер/SQLite/OpenDota/AI/Discord этим прогоном не запускались; задержка появления новой игры не измерялась. Linux CI этой локальной версии, миграция production, перенос ключа, включение automatic и подключение Gemini к runtime не выполнены. Итоговый полный прогон указан ниже отдельным дополнением; старый протокол относится к исходному конвейеру.

### Итоговый прогон текущей реализации

Windows x64, Node v22.14.0: `npm.cmd run typecheck` и build успешны; `npm.cmd test` с разрешением файловых операций — **426 тестов: 420 pass, 0 fail, 6 Linux-only skip**. Добавлено 32 теста: Steam 9, storage 6, pipeline 13, operations 2, Discord 2. Полный набор включает прежние parse/analysis/publication и процессные crash/race-проверки. Изначальный запуск operations в sandbox получал write-error на fs.link; focused и полный повтор с разрешением файловых операций успешны.

`openspec.cmd validate add-steam-match-discovery --type change --strict --no-interactive` успешен. CLI отдельно сообщает, что MODIFIED дельту match-pipeline нельзя архивировать до появления baseline main spec; базовые контракты пока находятся в предыдущих changes. Архивирование и перенос чужих изменений не выполнялись. `git diff --check` успешен; проверка 56 файлов выбранных модулей/документов/тестов не нашла текущих известных секретов или хвостовых пробелов. Рабочие локальные настройки не перезаписывались.

Существующая `.github/workflows/service.yml` включает Ubuntu 22.04/Node 22.14.0 и 22.23.3, Windows/Node 22.14.0. Этот локальный diff не отправлен на CI: Linux flock, три receive-сценария и SIGINT/SIGTERM остаются непроверенными для текущей версии. Живые GET нового Steam-клиента проверены отдельно выше; latency свежего матча, Gemini runtime, production backup/миграция/доставка и новая публикация не проверялись. Конфигурационный пример сохраняет automatic=false/prepare-only.

## Исходный конвейер

Проверено 17 октября 2026 на Windows x64: Node.js v22.14.0, встроенная SQLite 3.47.2. Использованы реальные публичные GroupSettings/OpenDota/match-facts/match-analysis/Storage контракты, временные SQLite-файлы и поддельные HTTP/Publisher. Новых npm-зависимостей, миграций или правок соседних модулей нет.

| Проверка | Результат |
|---|---|
| `npm.cmd run typecheck` | успешно |
| Новые `test/match-pipeline*.test.ts` | 48/48 в полном наборе; первоначальные focused-прогоны также успешны |
| `npm.cmd test` с разрешением файловых ссылок | 260/260, включая прежние 212 тестов |
| `openspec.cmd validate add-match-pipeline --type change --strict --no-interactive` | успешно |
| Node/SQLite runtime | win32/x64, v22.14.0 / 3.47.2 |

Первый полный прогон в песочнице дал 203/260: 57 существующих тестов лаборатории получили EPERM на fs.link во временном каталоге. Все новые тесты проходили в песочнице. Повтор того же полного npm test с разрешениями дал 260/260. Код лаборатории для обхода ограничения не менялся.

## Покрытие требований

| Requirement | Реализация и наблюдение | Проверки |
|---|---|---|
| Явный запуск и передаваемые зависимости | конфигурация без чтения env/файлов/сети; копии и freeze; prepare-only по умолчанию; неизвестные параметры/плохие зависимости отклоняются | contract: inert creation, validation; статическая проверка отсутствия файловых/env/console действий |
| Поддерживаемый рейтинговый матч | общий classify, все комбинации lobby/game_mode, Turbo/normal/unknown/null/duration=0 не создают задачу | contract: supported modes |
| Ручной запуск и явная сторона | валидация ID до сети, один/ноль друзей, явная сторона, requires-side без admission | contract: manual boundary, classifier |
| Подтверждение автоматической стороны | два уникальных числовых аккаунта; повтор/анонимный/строка не подтверждают компанию; обе стороны не создают две задачи; полная своя пятёрка | contract: automatic sides, canonical slots |
| Постоянная граница автоматического запуска | строгий endAt > cutoff, секунды в ms, равенство/будущее/дроби/overflow; сохранённая caller граница после reopen, ручная старая игра | contract: persistent cutoff |
| Ограниченное обнаружение с отчётом о полноте | limit/offset, объединение повторов/противоречивых строк, изоляция недоступного аккаунта/детального GET, caps и partial, busy | contract: bounded discovery, concurrent discovery |
| Постоянная дедупликация и явный повторный анализ | общая initial задача, первый job после новых ревизий, постоянный requestId, unfinished conflict, прежний результат при failed новой | contract: deduplication, reanalysis; integration: reopen |
| Последовательная обработка контрольных точек | один processNext, busy, журнал важнее step, актуальный mutable Claim | worker: heartbeat; publication: recovery; crash |
| Свежие данные и журнал разбора | fresh пригодность до POST, already-parsed без parse, admission до POST, job ID до defer, общий parse двух сторон, поздний известный released parse ID также переиспользуется | worker: basic parse, opposite sides, unknown; integration: late parse |
| Ограниченное ожидание расширенных данных | deadline от receipt.createdAt после reopen; missing job не означает parsed; GET cooldown учитывает retryAt; known/shared unknown timeout; платного basic fallback нет | worker: deadline, opposite sides; integration: cooldown, prepared basic |
| Неизменяемые входы анализа | все пять союзников/quality/coverage, публичный verifyFactsBundle подтверждает исходный dataDigest, атомарный bundle/prepared; исходное body после reopen/смены текущей инструкции; существенное изменение требует ревизии | worker: prepare-only, immutable body, changed input, invalid facts/size |
| Явный допуск реального и экспериментального режима | basic prepare-only хранит snapshot, parsed хранит prepared без результата; отсутствие live/experimental разрешения даёт ноль POST/preflight | worker: prepare-only, experimental gate; contract: configuration |
| Проверка бюджета перед каждой генерацией | обязательные отдельные лимиты; известный ноль/invalid-output/overrun/unknown; unknown блокирует даже preflight и после allow-new-attempt; повторное чтение в beforeSend | worker: budget, estimate, after-metadata denial |
| Допуск и сохранение исхода анализа | реальный analyzeMatch с поддельным fetch; reservation/start до POST, настоящий COMMIT fault/rollback даёт ноль POST; null preflight закрывается; started+not-sent остаётся uncertain; sent errors без retry; exact model/body/max_tokens | worker: commit failure, final handling; integration: full path |
| Владение во время ожидания и отмена | renew раз в 20s обновляет version; устаревший Claim отвергается; lease loss блокирует дальнейшую отправку; valid сохраняется до проверки потерянного владения; abort до/после started различаются | worker: heartbeat, lease loss, not-sent after start; publication: late valid, stop |
| Восстановление по сохранённым исходам | prepared без started закрывается и используется с новым ID/тем же body; valid до checkpoint принимается без MiMo; released valid не принимается; known message ID не пересылается; unresolved требует оператора | crash: все 6 фаз; integration: released history; publication: late outcome |
| Публикация через переданный адаптер | исходная цель, точное сообщение, envelope <=32 MiB до admission, uint64 ID до succeeded; insufficient-evidence буквально; нет адаптера/плохой payload waiting; not-sent failed, unknown attention; timeout оставляет живой Promise started, поздний ID не двигает старый job | publication: все сценарии; integration: manual/automatic; crash: publication phases |
| Безопасные статусы и ошибки | readonly getStatus без сети; прежний принятый результат рядом с failed; billingUnknown/attention; whitelist кодов observer; sync/async observer ошибки изолированы, API error payload не попадает в журнал/события | contract: history error/reanalysis; publication: status, observers, unknown |
| Управляемый жизненный цикл | явные run/stop; manual-only без cutoff; duplicate run; один цикл каждого вида; idle/pause/интервалы; периодическое recovery; stop снимает таймеры и сохраняет доступный исход; storage failure останавливает оба цикла; ресурсы caller остаются открыты | publication: run/stop/recovery; integration: final write failure |

Названия файлов в таблице сокращены: contract — `test/match-pipeline-contract.test.ts`, worker — `test/match-pipeline-worker.test.ts`, publication — `test/match-pipeline-publication.test.ts`, integration — `test/match-pipeline-integration.test.ts`, crash — `test/match-pipeline-crash.test.ts` и `test/match-pipeline-crash-worker.ts`.

## Аварийные и сквозные сценарии

Шесть отдельных дочерних процессов прерваны SIGKILL после сохранения prepared reservation, после final анализа до checkpoint, до publication admission, после admission до send, после поддельной отправки до ID и после сохранения ID до succeeded. Использованы настоящие SQLite-файлы; поддельный внешний эффект записывается в отдельный временный файл. После reopen подтверждены отсутствие второго платного POST/сообщения и неизменное body. Задачи с неизвестной отправкой не получают нового admission автоматически.

Сквозные manual и automatic проходят basic → parse job → fresh parsed → facts/prepared → настоящий analyzeMatch с поддельным HTTP → сохранённый accepted result → Publisher → message ID → succeeded → reopen. В каждом сценарии ровно один parse POST, один analysis POST и одна публикация; счётчики совпадают с receipt. Дополнительно проверены already-parsed, ambiguous side, selected/insufficient-evidence, known/unknown billing и поздние исходы.

Все тестовые данные синтетические; ключи — явные тестовые строки. Реальных OpenDota/OpenRouter/Discord запросов, платных генераций и сообщений не было. Новые исходники импортируют соседние модули только через публичные index.ts; единственные общие изменения — checkbox этого OpenSpec и строка модуля 3 в PROJECT_PLAN.md. БД и журналы тестов создаются во временных каталогах и очищаются. В новом scope нет рабочих секретов, локальных настроек, сохранённых реальных ответов или production БД.

## Пробелы и границы

- Linux runtime не запускался: `wsl.exe --list --quiet` сообщил, что подсистема Windows для Linux не установлена. Совместимость типов и Windows проверки не заменяют Linux прогон.
- В рабочей папке нет Git-репозитория (`git rev-parse` вернул not a git repository), поэтому git diff/check-ignore здесь не выполнялись. Git не инициализировался. Существующие ignore-правила не менялись.
- Настоящий Discord SDK, permissions/mentions/embeds, bootstrap, постоянный файл automaticSince и VPS не реализованы этим модулем.
- MiMo-пакет остаётся experimental. Синтетическая интеграция не доказывает качество выбора худшего, не завершает калибровку лаборатории и не разрешает новый платный пилот.
- История ограничена configured глубиной; распределённый worker, финансовая сверка unknown и гарантия жёсткого фактического счёта вне v1. Эксплуатация требует одного процесса на БД.
