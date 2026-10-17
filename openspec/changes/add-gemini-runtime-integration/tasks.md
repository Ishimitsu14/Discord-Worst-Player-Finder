# Tasks

## 1. Общие контракты и материалы

- [x] 1.1 Добавить различимые публичные варианты legacy/Gemini для входов, попыток и результата без удаления прежних типов; адаптировать необходимые callers/fixtures и проверить TypeScript на старых сигнатурах и исходных Gemini v1/v2.
- [x] 1.2 Выделить публичную чистую проверку двух словарей match-facts с существующими pinned digest-проверками; тестами подтвердить правильные/повреждённые словари, отсутствие env/файлов/сети и неизменность прежних фактов.
- [x] 1.3 Дополнить README/VERIFICATION контрактов профиля и материалов; проверить примеры публичных сигнатур и явно сохранить различие между готовым аналитиком и ещё не подключённым runtime.

## 2. Хранилище Gemini

- [x] 2.1 Добавить следующую атомарную миграцию профиля jobs и gemini_recoveries без изменения схем/checksums 1/2; временными SQLite проверить fresh, upgrade 1→3/2→3, rollback, чужую/новую схему и сохранность discovery/jobs/results/стоимости.
- [x] 2.2 Сохранять профиль при первой постановке и ревизии с default legacy; тестами проверить смену config до подготовки, общее initial по match/side, старые revision-request digests/ключи, конфликт другого профиля и отсутствие автоматической новой ревизии.
- [x] 2.3 Подключить закрытую валидацию Gemini snapshot/bundle/prepared с sourceDataDigest, точным body/пакетом и профилем; тестами проверить смешанные форматы, подмену стороны/digest, immutable prepared и точные байты после reopen при другом текущем промпте.
- [x] 2.4 Реализовать ветки started/final/StoredResult для Gemini с SSE-полями и обоими форматами ответа; тестами проверить valid, preflight без identity, оплаченный invalid, чужую quote/evidence, version mismatch, повтор сохранения и поздний исход без старого checkpoint.
- [x] 2.5 Добавить чтение/сохранение аудируемого recovery и атомарный допуск единственного потомка; SQLite-тестами проверить eligibility, три пустые проверки, точный повтор решения, неверные связи/суммы, rollback записи, два конкурирующих допуска и невозможность второго потомка/обхода generic reserve.
- [x] 2.6 Расширить сводку reservedCostUsd/uncoveredUnknownCount без переписывания исходных attempts; тестами проверить unknown/резерв/management actual отдельно, отсутствие двойного учёта, recorded без цены, расходы потомка и сохранение после reopen.
- [x] 2.7 Дополнить локальное восстановление только для полного eligible final/сохранённого решения; процессными или fault-тестами проверить started без final, прерывание сверки, решение до потомка, reserved/started потомка и отсутствие автоматической сети/третьей отправки.
- [x] 2.8 Обновить README/VERIFICATION storage и инструкции cold backup/несовместимого rollback; сверить их с фактической миграцией и перечислить непроверенные production-свойства.

## 3. Общий конвейер

- [x] 3.1 Добавить analysisProfile и необязательные совместимые Gemini-зависимости с закрытой валидацией; тестами проверить инертность, старый default, отсутствие management key, несовместимые материалы до сети и сохранённую Gemini-задачу у legacy-only caller.
- [x] 3.2 Подключить compact prepare и analyzeGeminiMatch по профилю задачи; тестами проверить prepare-only/basic→parsed, frozen prepared, пять союзников, обе стороны/исхода, отсутствие fallback и StartedAttempt до единственного inference POST.
- [x] 3.3 Подключить существующий checkGeminiRecovery с Clock/Signal wait и постоянным решением; fake API-тестами проверить точную session, 10/30/60 с, delayed recorded, partial/HTTP-response, malformed/truncated/stale, missing key, отмену и не более одного связанного повторного POST.
- [x] 3.4 Учитывать известный расход и резервы в beforeSend каждой попытки; тестами проверить uncovered legacy/child/recorded, достаточный/недостаточный остаток после резерва, изменение тарифов перед повтором и отсутствие обхода бюджета из-за restart/config.
- [x] 3.5 Проверить restore/stop/lease/race и дедупликацию на настоящей SQLite: valid до checkpoint, решение до потомка, interruption потомка, повтор команды/переключение профиля, один worker при продолжающемся Steam-discovery и отсутствие нового parse/analysis/publication POST по сохранённому исходу.
- [x] 3.6 Обновить README/VERIFICATION pipeline с профилем, состояниями сверки и резервами; сверить примеры со всеми вариантами request/status и отдельно сохранить границы непроверенных live/CI/production.

## 4. Discord-отчёт

- [x] 4.1 Добавить Gemini-renderer через существующий presentation/валидатор и диспетчеризацию сохранённого результата; тестами проверить одного игрока, 3–4 основания, own quote/time, verdict, исход/ссылку, v1 без teamFacts и три последних пункта v2 после победы/поражения.
- [x] 4.2 Сохранить cleanText/shorten/validateEmbed, nonce и allowed_mentions; граничными тестами проверить максимальные строки/emoji/инъекции/ссылки, общий предел 6000, 1024 на поле, отметку сокращения и сохранность выбранного героя/оснований/всех трёх финальных пунктов.
- [x] 4.3 Подключить смешанные valid-результаты в /worst и /worst-status; тестами проверить старый результат при ошибке новой ревизии, awaiting-data, guild/channel, admin-only reanalysis и ноль дополнительных OpenRouter/management/Discord POST при чтении.
- [x] 4.4 Добавить безопасные статусы сверки/резерва/неподтверждённой цены; тестами подтвердить, что recorded без текста не становится отчётом, резерв не называется списанием и непригодный Gemini не публикуется как insufficient-evidence.
- [x] 4.5 Обновить README/VERIFICATION Discord с Gemini-примером и ограничениями публикации; сверить вывод с валидным fixture, сохранив прежние примеры legacy и отсутствие живой отправки.

## 5. Operations и артефакт

- [x] 5.1 Передать analysisProfile, оба пакета/словаря и отдельный OPENROUTER_MANAGEMENT_KEY через CLI/ServiceInput/Secrets; тестами проверить старый config, отсутствие/совпадение ключей, bad materials до Gateway/активации/БД/сети и смешанную очередь при смене новых задач обратно на legacy.
- [x] 5.2 Расширить безопасные status/events агрегатами резерва и непокрытой неизвестности; fake runtime-тестами проверить новый/прежний health, раздельные ключи транспорта, сохранение automaticSince и отсутствие ключей/URL/content в логах.
- [x] 5.3 Добавить hero-metrics-v1.json в allowlist release и расширить тест артефакта; проверить полный состав, отсутствие рабочих данных/ключей, offline check распакованного production install и отказ отсутствующего/повреждённого словаря без открытия БД/сети.
- [x] 5.4 Обновить пример с Gemini/automatic=false/prepare-only и README/VERIFICATION operations/deploy: User env→process, приватный Linux env, cold backup старым релизом и несовместимый rollback; проверить пример валидатором и отсутствие изменений установленного config/VPS/секретов.

## 6. Сквозное подтверждение

- [x] 6.1 Добавить сквозные тесты public modules + настоящая SQLite + fake OpenDota/Gemini SSE/Discord: ручной prepare→live→valid→publication→reopen, обе стороны/исхода, смешанные ревизии, cache/status, сохранённый legacy и Steam-awaiting-data без повторных генераций.
- [x] 6.2 Добавить сквозные fault/race-сценарии management: три пустых→один повтор, delayed recorded, бюджет после резерва, child failure, crash до/после решения/started/final/message ID; подтвердить максимум два inference POST на цепочку и прежнее поведение unknown parse/publication.
- [x] 6.3 Выполнить typecheck/full tests/strict OpenSpec, git diff --check и проверку секретов/точного scope; Windows/Linux/real API/production разделить по фактической проверке, обновить итоговые VERIFICATION и только статус подключения в модуле match-analysis PROJECT_PLAN.md, не отмечая калибровку или доставку выполненной.

## Workflow follow-up

- Перед будущим archive согласованно синхронизировать baseline main specs и зависимые дельты прежних changes; отсутствие main specs сейчас не является отсутствием реализованных модулей.
- После локальной реализации отдельно выполнить CI Windows/Linux и проверить артефакт. Не выдавать наличие workflow или старый успешный CI за результат текущей версии.
- Реальный ручной smoke, перенос management key, конкретный live-бюджет и доставка требуют отдельного операционного этапа с cold backup до первого открытия БД новым релизом. Production-проверки ограничены status/revision/unit/checksums, без тестовых сообщений/генераций.
- Включение автоматического Gemini и новые эксперименты качества/latency рассматриваются после ручного пути; это не часть готовности данной спеки.
