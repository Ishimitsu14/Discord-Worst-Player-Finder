# Конвейер матчей

`createMatchPipeline(options, dependencies)` соединяет готовые модули через их публичные API. Импорт и создание ничего не запускают. Нужны Node >=22.14, открытый Storage, один OpenDotaClient, проверенные GroupSettings, `facts: { dictionary }` и PromptPackage. Файлы, env и БД открывает вызывающий код. Конвейер не подключён к CLI лаборатории и не создаёт Discord-команды.

Один экземпляр сервиса и один worker на БД — условие v1. БД и клиенты принадлежат caller. Для Steam-обнаружения Storage обновляет схему до 3; перед первым открытием нужен cold backup старым релизом, см. [storage](../storage/README.md). Параметры, настройки компании, словарь и пакет копируются; изменение режима или лимитов требует нового экземпляра. Существующая задача сохраняет свои настройки и цель публикации.

## Параметры

| Поле | Значение по умолчанию / проверка |
|---|---|
| mode | `prepare-only`; либо `live` |
| publicationMode | `automatic`; либо `on-command`: автоматические разборы сохраняются до явной команды публикации |
| automaticSince | без значения; Unix ms, неотрицательный safe integer <= now, обязателен для обнаружения |
| historySource | `opendota`; либо явно `steam` |
| pollIntervalMs | 900000 для OpenDota, 60000 для Steam; safe integer >=60000 |
| pageSize / maxPagesPerAccount | 20 / 1; 1..100 / 1..10 |
| maxCandidatesPerScan | 100; 1..1000 |
| discoveryRetryMs / discoveryTimeoutMs | 60000 / 1800000; safe integer >=60000 / >=retry, только новые кандидаты получают новый deadline |
| maxDiscoveryChecksPerScan | 10; целое 1..1000, независимо от maxCandidatesPerScan |
| workerIdleMs / pauseMs | 1000 / 300000; >=1000 / >=60000 |
| parseTimeoutMs / parsePollMs | 900000 / 15000; положительный safe integer / >=15000 и <=timeout |
| analysisTimeoutMs / publicationTimeoutMs | 180000 / 30000; 1..2147483647 |
| maxTotalCostUsd / maxEstimatedCostPerAttemptUsd | без значения; конечные положительные числа, оба обязательны для live |
| allowExperimental | false |

Неизвестные поля отклоняются. `live` требует непустой `apiKey`; `fetcher` можно передать аналитику для теста. Часы имеют `now/setTimeout/clearTimeout`. Необязательные зависимости: Publisher и onEvent. `facts` v1 принимает только словарь, без roleOverrides.

## Ручная постановка и обнаружение

При `publicationMode=on-command` автоматически найденный valid без команды сохраняется в waiting/publication-ready, step=publish, без Publisher/Discord POST и повторного выполнения worker. Обычный requestMatch при совпадающей сохранённой цели атомарно разрешает публикацию уже поставленной auto-задачи, в том числе до готовности: после valid worker сам отправляет результат. Намерение хранится отдельным неизменяемым артефактом, не меняет running lease/version и переживает checkpoint, defer и restart. Повтор команды не создаёт новую генерацию/публикацию; getStatus остаётся чтением. Терминальные состояния, needs-attention и неизвестная доставка не возобновляются. Явный первоначальный ручной запрос origin=manual сохраняет прежний анализ+публикацию. Готовый неопубликованный auto-разбор остаётся unfinished для прежнего запрета новой ревизии.

```ts
const pipeline = createMatchPipeline({}, dependencies);
const request = await pipeline.requestMatch({ matchId: 101, side: 'radiant' });
const progress = await pipeline.processNext();
if (request.status === 'queued' || request.status === 'existing') {
  const status = pipeline.getStatus({ jobId: request.job.id });
}
await pipeline.stop();
```

Match ID — положительный безопасный number. Ручная явная сторона допускается без друзей; без стороны требуется единственная команда с опознанными друзьями. Ноль или обе команды возвращают `requires-side`, без задачи. Все пять выбранных союзников обязательны; соперники могут быть неполными. Канонические уникальные слоты: 0..4 и 128..132. Повтор account ID не даёт два голоса; противоречивый ID на разных сторонах неоднозначен.

Поддерживаются lobby_type 5/6/7 и game_mode 1/2/3/4/5/12/16/17/22, положительная длительность и boolean radiant_win. Обычный lobby=0, Turbo=23, custom=15 и неизвестные режимы отклоняются. Значения закреплены по справочникам OpenDota [lobby_type](https://raw.githubusercontent.com/odota/dotaconstants/master/build/lobby_type.json) и [game_mode](https://raw.githubusercontent.com/odota/dotaconstants/master/build/game_mode.json).

Для авто требуется ровно одна команда с >=2 разными числовыми ID из настроек в полном свежем snapshot. История не заменяет скрытый ID. Строки, null, 0, 4294967295 не подтверждают компанию. При двух подходящих командах возвращается неоднозначность, две задачи не создаются.

`requestMatch` возвращает `queued/existing` с первой задачей и доступным результатом, `requires-side/rejected` с кодом либо `awaiting-data` с matchId/code/nextCheckAt. Задача и valid-результат имеют приоритет, включая появление во время GET; без стороны две существующие стороны требуют выбора. Подтверждённое ожидание кандидата читается без API. Сырой кандидат с reason=null ещё не проверялся: ручной запрос выполняет свежий OpenDota сразу, не ожидая фонового лимита; временная ошибка/неполные данные сохраняют причину и cooldown. nextCheckAt — следующая проверка, не ETA отчёта; null означает остановленное автоматическое ожидание. Ручная и автоматическая постановка используют один ключ пары matchId/side. Первый запрос после terminal не перезапускает задачу. Явный повтор: `requestReanalysis({requestId, matchId, side})`; requestId должен быть постоянным ключом команды, повтор ключа возвращает ту же ревизию. Unfinished блокирует другую ревизию. Прежний принятый результат доступен при ошибке новой.

```ts
const pipeline = createMatchPipeline({ automaticSince: persistedActivationMs }, dependencies);
const report = await pipeline.discoverOnce();
// report: queued/existing job ID, requiresSide, rejected, errors, partial.
await pipeline.stop();
```

`persistedActivationMs` bootstrap сохраняет при первом включении и передаёт после каждого перезапуска. Подстановки Date.now при отсутствии значения нет. Проверяется `(start_time + duration) * 1000 > automaticSince`: игра может начаться раньше границы. Равенство, будущее, дробные/переполненные времена не проходят. Ручной запрос допускает старый матч.

История просматривается последовательно по аккаунтам, с limit/offset до короткой страницы или предела. Нет ранней остановки только по старой строке. Кандидаты объединяются по ID; свежий полный матч подтверждает пригодность. Существующая automatic-задача с теми же настройками может пропускать повторный подробный GET. Непригодные матчи не становятся отрицательным кешем. Достижение предела или ошибка страницы/кандидата даёт `partial`; ошибки одного аккаунта не мешают другим. Это ограниченный повторный просмотр: после долгого простоя возможны пропуски, глубину увеличивают явно или ставят матч вручную. Курсора и неограниченного catch-up нет.

## История Steam

Передайте `historySource: 'steam'` и зависимость `steam: new SteamHistoryClient({apiKey}, {fetcher, clock})`. Создание инертно; ручной режим не требует steam. discover/run automatic проверяют зависимость до работы worker. Наличие ключа не выбирает источник или режим. Описание limit/offset выше относится к прежнему OpenDota-пути; Steam использует startAtMatchId и не вызывает getPlayerMatches.

Steam даёт только ID и время начала. Никакая фильтрация по началу, duration или исходу краткой истории не применяется. Каждый новый ID сначала сохраняется в SQLite. Контекст — digest отсортированных Steam32, guild/channel и automaticSince; переупорядочение ID его не меняет. maxCandidatesPerScan ограничивает новые записи за цикл, известные ID не расходуют предел. Остальные аккаунты продолжают проверяться; отложенные новые ID могут попасть в следующий цикл.

После историй выбираются до maxDiscoveryChecksPerScan due-кандидатов по min(nextCheckAt, expiresAt), firstSeenAt, matchId. Только fresh OpenDota подтверждает завершение, режим и двух разных узнаваемых друзей на одной стороне. 404, временный сбой, неизвестное завершение и пока неполная пятёрка оставляют pending без POST. Повторы учитывают retryAt OpenDota. Истечение сохранённого срока даёт needs-attention/discovery-timeout; ошибочные данные, анонимный второй друг и неоднозначность также требуют проверки. Старое завершение и неподдерживаемый режим получают ignored. admitted/ignored/needs-attention не вызывают новый автоматический GET в том же контексте. Pending сохраняется после выпадения из страниц и перезапуска; история не продлевает deadline.

После подтверждения используются прежние enqueueInitial/worker, включая ручную задачу того же матча. Между enqueue и admitted сбой безопасен благодаря дедупликации. По истечении ожидания обычный ручной запрос может снова проверить OpenDota; при недоступных данных вернёт awaiting-data с nextCheckAt=null. Он не разрешает новый анализ существующей задачи.

DiscoveryReport дополняется pending (все ожидающие), deferred (новые ID сверх предела плюс оставшиеся due), checks (рассмотренные due, включая истёкшие) и accountsChecked (аккаунты с попыткой чтения). Ошибки имеют безопасные коды и accountId/matchId. steam-history-private отличается от пустой истории; авторизация/429 прекращает остальные отправки, они получают steam-unchecked. Закрытые аккаунты проверяются снова в следующем цикле. partial показывает ошибки/пределы/ожидание, а не полноту всех прошлых матчей.

Пауза Steam — 60 секунд **после** завершения цикла; индексация Steam/OpenDota, лимит проверок и реплей добавляют задержку. При полностью закрытых историях автообнаружение не гарантируется: помогает ручной ID. Закрытая история не исключает узнаваемый ID из состава OpenDota.

## Контрольные точки обработки

| Шаг | Подтверждение |
|---|---|
| load-match | fresh GET, пригодность по настройкам задачи, snapshot |
| wait-parse | fresh GET, beginParse до каждого из максимум двух POST, job ID до ожидания |
| build-facts | публичные prepareMatchFacts/prepareAnalysis, атомарное сохранение bundle/prepared |
| analyze | reservation, beforeSend/startAnalysis до POST, final до checkpoint |
| publish | принятый valid, точное сообщение до send, message ID до succeeded |

В prepare-only basic ждёт `parse-disabled` со snapshot; parsed сохраняет prepared и ждёт `live-disabled`. POST отсутствуют, результата нет. Для продолжения остановите объект и создайте live с той же БД. До внешнего действия fresh проверяет пригодность. Существенное изменение режима, исхода, длительности, героев/слотов сохранённого prepared даёт `input-changed` и требует новой ревизии; необязательное обогащение не пересобирает body. Сохранённый пакет используется буквально, даже если текущая инструкция другая.

Lease продлевается каждые 20 секунд, все записи используют актуальный Claim. После потери владения новые действия прекращаются; известный поздний исход сохраняется без старого checkpoint. Перед claim выполняется recoverInterrupted. Журнал важнее step: valid и известный message ID не отправляются повторно. Started без исхода требует отдельного оператора через storage.resolveUncertain, конвейер сам его не вызывает.

После принятого запроса разбора live-конвейер планирует проверку через 120000 мс от первого сохранённого допуска. Если свежий GET всё ещё basic и общий срок ожидания не истёк, отправляется ровно один повторный POST. Если данные уже parsed, задача сразу продолжает подготовку фактов. Наличие replay_url не требуется. До двух минут, в prepare-only, после неизвестного или released исхода повтор не выполняется. Транспортный OpenDotaClient по-прежнему отправляет один POST на вызов requestParse.

Разбор противоположной стороны переиспользует известное задание и общий единственный повтор. Допуск повтора атомарно сохраняет связь с первой попыткой и её createdAt в parse-input; restart, другая сторона и сбой после допуска до ответа не разрешают третий POST. Deadline остаётся привязанным к первой попытке; по умолчанию это 15 минут, повтор его не продлевает. Исчезнувший job не означает parsed. После deadline свежий basic даёт `parse-timeout`, платного basic fallback нет. GET network/timeout/upstream/rate-limit откладываются минимум на минуту и учитывают retryAt; bounded retry самого клиента сохраняется. Неизвестный исход POST требует внимания, однозначный отказ завершает задачу.

## Анализ и бюджет

```ts
const pipeline = createMatchPipeline({
  mode: 'live', allowExperimental: true,
  maxTotalCostUsd: configuredTotal, maxEstimatedCostPerAttemptUsd: configuredAttempt,
}, { ...dependencies, apiKey: locallyLoadedKey });
```

Это явная конфигурация, пример сам не разрешает расходы. Пилотный лимит $0.25 не переносится. Лимит охватывает все анализы переданной БД за всё время: в том числе invalid-output и известный ноль. Нет дневного сброса и импорта лабораторных файлов. Unknown блокирует даже новый preflight; известное превышение фактического расхода сохраняется целиком и блокирует следующий анализ. Оценка по актуальным тарифам и эвристике размера не гарантирует конечный счёт. Несколько процессов на БД нарушили бы условие последовательной проверки; v1 их не поддерживает.

Reservation создаётся непосредственно перед analyzeMatch. Его `beforeSend` сначала проверяет остановку и актуальный Claim, повторно читает getBillingSummary после metadata и в том же синхронном участке записывает startAnalysis. Только возврат callback разрешает POST; COMMIT-ошибка останавливает конвейер. Публичный конвейер не принимает замену beforeSend от caller. Проверка на поддельном fetch в тестах:

```ts
const fetcher: typeof fetch = async (url, init) => {
  if (init?.method === 'POST') {
    const receipt = storage.listAttempts(job.id).find(item => item.kind === 'analysis');
    assert.equal(receipt?.state, 'started');
    assert.equal(receipt?.unresolved, true);
    return syntheticAnalysisResponse;
  }
  return syntheticMetadataResponse;
};
```

Final сохраняется до продвижения задачи. Valid принимается буквально, включая insufficient-evidence. Отправленные invalid-output/429/timeout/transport/model-mismatch завершают задачу без повторного POST, исправляющего запроса или смены модели/max_tokens. Preflight not-sent закрывает reservation и даёт waiting с безопасной причиной; следующий допущенный preflight получает новый ID.

Started с последующим requestSent=false остаётся неопределённым: storage не разрешает его автоматически закрыть. Pipeline переводит задачу в needs-attention или оставляет для восстановления после lease-lost. Подтверждённый notSentOutcome принимает только внешний оператор через resolveUncertain.

Финальная unknown-стоимость и unresolved-действие различаются. Valid с unknown можно опубликовать, но следующая генерация блокируется. Финальная ошибка с unknown даёт failed и `billingUnknown/attention` в статусе. Allow-new-attempt не устраняет неизвестный расход. Финансовой сверки и автоматического разрешения в v1 нет. Released valid остаётся историей; если поздний valid закрывает ранее освобождённый анализ, задача завершается `released-analysis-present`, без автоматического принятия или новой генерации; для нового анализа нужна новая явная ревизия.

## Публикация и статус

Publisher — необязательный порт без Discord SDK. `prepare({job, analysis, bundle, snapshot})` локально возвращает точную JSON-строку объекта. Pipeline проверяет объект и размер сериализованного PublicationInput <=32 MiB до допуска. `send(input, {signal})` получает сохранённый тип storage: version/guildId/channelId/analysisAttemptId/message. Цель берётся из задачи. Непустой строковый uint64 messageId сохраняется до succeeded. Известный ID не вызывает prepare/send повторно.

Без адаптера или в prepare-only принятый результат ждёт `publisher-unavailable`. Некорректный локальный payload ждёт `publication-invalid` без admission. Типизированная `PublicationError(code, outcome)` допускает безопасные коды unavailable/forbidden/invalid-message/rate-limited/transport-error и not-sent/unknown. Not-sent завершает failed с доступным анализом; неизвестное исключение или неверный message ID дают needs-attention. Автоматического repost, редактирования сообщения и команды повторной публикации в v1 нет.

При таймауте/остановке ещё работающий Promise оставляет started без выдуманного unknown-final. Поздний исход сохраняется отдельно, состояние задачи старым Claim не продвигается. Остановка не доказывает отмену удалённого эффекта. После проверки позднего ID оператор может принять исход через storage.resolveUncertain; worker затем завершит задачу без повторного send.

`getStatus({jobId})` читает текущую задачу и последний принятый результат пары отдельно. Новая неудачная ревизия не прячет прежний результат. Attention учитывает needs-attention и неизвестную стоимость этой задачи. Сеть при чтении не используется; после stop чтение доступно, пока caller держит БД открытой.

`onEvent` получает только IDs/side/revision/state/step/безопасный code либо агрегаты discovery. Тела API, ключи, заголовки, Error.message/cause и списки аккаунтов в события не попадают. Чужая свободная reason из storage заменяется кодом stored-reason в событии. Sync throw/rejected Promise observer поглощаются. Сам pipeline не пишет в консоль.

## Цикл и остановка

```ts
const running = pipeline.run({ automatic: false, signal });
// В другом обработчике жизненного цикла:
await pipeline.stop();
await running;
// Теперь caller закрывает Storage, сохранив файл БД.
```

Run по умолчанию включает обнаружение и требует automaticSince. Automatic=false обрабатывает только ручную очередь без границы. Discovery и worker могут ждать одновременно через один OpenDotaClient, но каждый вид имеет один цикл. Повторный run возвращает already-running, параллельные discoverOnce/processNext — busy. Интервал discovery отсчитывается после завершения скана; при пустой очереди действует workerIdleMs, waiting освобождает lease и не создаёт быстрый цикл. Перед каждым claim выполняется recoverInterrupted, включая недавно истёкшие lease прошлого процесса.

Stop идемпотентен: запрещает новые действия, отменяет ожидание, дожидается доступных сохранений и выхода циклов. Незавершённая удалённая публикация может окончиться позже и сохранить исход. Остановленный объект нельзя запустить снова; создайте новый. Storage/клиент не закрываются и не пересоздаются. Ошибка хранения фатальна для запуска: caller получает PipelineError(storage-failure), новые задачи не берутся. Диагностика не содержит исходного исключения.

Примеры исполняются на временной SQLite и поддельных сервисах в `test/match-pipeline*.test.ts`. Отчёт: [VERIFICATION.md](VERIFICATION.md). Реальная инструкция MiMo остаётся experimental, качество/калибровка лаборатории этим модулем не подтверждаются. Настоящий Discord, bootstrap и VPS подключаются отдельными изменениями.

## Профиль Gemini и восстановление

analysisProfile по умолчанию legacy; gemini задаётся явно только для новых задач. Задачи хранят прежний профиль, settings и target. Для новых Gemini передайте geminiPrompt (v1/v2), heroMetricsDictionary и существующий facts.dictionary; оба пакета/словаря копируются и проверяются до сети. Необязательный managementKey должен отличаться от apiKey. Legacy-only caller продолжает работать: сохранённая неподготовленная Gemini-задача без материалов ждёт analysis-profile-unavailable до OpenDota/модели. Operations всегда передаёт оба семейства, даже при новых legacy-задачах.

Basic→parsed, выбор стороны по Steam ID, ручные/admin правила, общий initial и один worker сохранены. prepare-only не делает inference/management/publication и не использует basic fallback. Новая Gemini-задача строит compact bundle и frozen prepared; после reopen текущий промпт не заменяет сохранённый. beforeSend фиксирует StartedAttempt и повторно проверяет бюджет перед POST.

Полный final сохраняется до сверки. Recovery разрешён только для requestSent, transport-error/timed-out, responseReceived=false, без generation ID/content/байтов/usage. При live и отдельном managementKey существующий checkGeminiRecovery проверяет точный session_id через 10/30/60 секунд с Clock/Signal. Любой recorded (включая ответ без цены), malformed/truncated/stale/чужой session, ошибка management, partial/HTTP-response или отмена не дают inference-повтора. Три пустых допускают только один связанный ID через storage; повтор использует то же body, новую цену metadata и свежий beforeSend. Само отсутствие записи — ограниченное наблюдение журнала, а не гарантия отсутствия списания; исходная консервативная оценка остаётся резервом.

Бюджет требует uncoveredUnknownCount=0 и остаток maxTotalCostUsd−knownCostUsd−reservedCostUsd. Для каждой отправки estimate должен укладываться и в остаток, и в cap. Недостаточный бюджет после решения оставляет needs-attention; увеличение лимита само задачу не возобновляет. Дочерний unknown/сбой не порождает третью отправку. Valid с неизвестной ценой можно опубликовать, но следующие генерации блокируются. getStatus/job events отдельно сообщают известную стоимость, резерв и непокрытую неизвестность; health не является источником бюджета.

Сохранённый valid публикуется без нового анализа; чтение /worst/status не запускает management. Нужный профиль renderer выбирается по сохранённому результату. Реальный latency/качество/операционный recovery, Linux CI и VPS текущей версии требуют отдельной проверки.
