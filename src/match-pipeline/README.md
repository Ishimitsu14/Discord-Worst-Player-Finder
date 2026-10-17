# Конвейер матчей

`createMatchPipeline(options, dependencies)` соединяет готовые модули через их публичные API. Импорт и создание ничего не запускают. Нужны Node >=22.14, открытый Storage, один OpenDotaClient, проверенные GroupSettings, `facts: { dictionary }` и PromptPackage. Файлы, env и БД открывает вызывающий код. Конвейер не подключён к CLI лаборатории и не создаёт Discord-команды.

Один экземпляр сервиса и один worker на БД — условие v1. БД и клиенты принадлежат caller. Новых зависимостей и миграций нет. Параметры, настройки компании, словарь и пакет копируются; изменение режима или лимитов требует нового экземпляра. Существующая задача сохраняет свои настройки и цель публикации.

## Параметры

| Поле | Значение по умолчанию / проверка |
|---|---|
| mode | `prepare-only`; либо `live` |
| automaticSince | без значения; Unix ms, неотрицательный safe integer <= now, обязателен для обнаружения |
| pollIntervalMs | 900000; safe integer >=60000 |
| pageSize / maxPagesPerAccount | 20 / 1; 1..100 / 1..10 |
| maxCandidatesPerScan | 100; 1..1000 |
| workerIdleMs / pauseMs | 1000 / 300000; >=1000 / >=60000 |
| parseTimeoutMs / parsePollMs | 900000 / 15000; положительный safe integer / >=15000 и <=timeout |
| analysisTimeoutMs / publicationTimeoutMs | 180000 / 30000; 1..2147483647 |
| maxTotalCostUsd / maxEstimatedCostPerAttemptUsd | без значения; конечные положительные числа, оба обязательны для live |
| allowExperimental | false |

Неизвестные поля отклоняются. `live` требует непустой `apiKey`; `fetcher` можно передать аналитику для теста. Часы имеют `now/setTimeout/clearTimeout`. Необязательные зависимости: Publisher и onEvent. `facts` v1 принимает только словарь, без roleOverrides.

## Ручная постановка и обнаружение

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

`requestMatch` возвращает `queued/existing` с первой задачей и доступным результатом либо `requires-side/rejected` с кодом. Ручная и автоматическая постановка используют один ключ пары matchId/side. Первый запрос после terminal не перезапускает задачу. Явный повтор: `requestReanalysis({requestId, matchId, side})`; requestId должен быть постоянным ключом команды, повтор ключа возвращает ту же ревизию. Unfinished блокирует другую ревизию. Прежний принятый результат доступен при ошибке новой.

```ts
const pipeline = createMatchPipeline({ automaticSince: persistedActivationMs }, dependencies);
const report = await pipeline.discoverOnce();
// report: queued/existing job ID, requiresSide, rejected, errors, partial.
await pipeline.stop();
```

`persistedActivationMs` bootstrap сохраняет при первом включении и передаёт после каждого перезапуска. Подстановки Date.now при отсутствии значения нет. Проверяется `(start_time + duration) * 1000 > automaticSince`: игра может начаться раньше границы. Равенство, будущее, дробные/переполненные времена не проходят. Ручной запрос допускает старый матч.

История просматривается последовательно по аккаунтам, с limit/offset до короткой страницы или предела. Нет ранней остановки только по старой строке. Кандидаты объединяются по ID; свежий полный матч подтверждает пригодность. Существующая automatic-задача с теми же настройками может пропускать повторный подробный GET. Непригодные матчи не становятся отрицательным кешем. Достижение предела или ошибка страницы/кандидата даёт `partial`; ошибки одного аккаунта не мешают другим. Это ограниченный повторный просмотр: после долгого простоя возможны пропуски, глубину увеличивают явно или ставят матч вручную. Курсора и неограниченного catch-up нет.

## Контрольные точки

| Шаг | Подтверждение |
|---|---|
| load-match | fresh GET, пригодность по настройкам задачи, snapshot |
| wait-parse | fresh GET, один beginParse до POST, job ID до ожидания |
| build-facts | публичные prepareMatchFacts/prepareAnalysis, атомарное сохранение bundle/prepared |
| analyze | reservation, beforeSend/startAnalysis до POST, final до checkpoint |
| publish | принятый valid, точное сообщение до send, message ID до succeeded |

В prepare-only basic ждёт `parse-disabled` со snapshot; parsed сохраняет prepared и ждёт `live-disabled`. POST отсутствуют, результата нет. Для продолжения остановите объект и создайте live с той же БД. До внешнего действия fresh проверяет пригодность. Существенное изменение режима, исхода, длительности, героев/слотов сохранённого prepared даёт `input-changed` и требует новой ревизии; необязательное обогащение не пересобирает body. Сохранённый пакет используется буквально, даже если текущая инструкция другая.

Lease продлевается каждые 20 секунд, все записи используют актуальный Claim. После потери владения новые действия прекращаются; известный поздний исход сохраняется без старого checkpoint. Перед claim выполняется recoverInterrupted. Журнал важнее step: valid и известный message ID не отправляются повторно. Started без исхода требует отдельного оператора через storage.resolveUncertain, конвейер сам его не вызывает.

Разбор противоположной стороны переиспользует известный job ID или ждёт fresh при unknown без второго POST. Deadline берётся из createdAt сохранённого допуска; restart его не сбрасывает. Исчезнувший job не означает parsed. После deadline свежий basic даёт `parse-timeout`, платного basic fallback нет. GET network/timeout/upstream/rate-limit откладываются минимум на минуту и учитывают retryAt; bounded retry самого клиента сохраняется. POST автоматически не повторяются.

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
