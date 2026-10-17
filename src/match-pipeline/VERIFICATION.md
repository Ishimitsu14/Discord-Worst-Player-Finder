# Проверки match-pipeline

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
