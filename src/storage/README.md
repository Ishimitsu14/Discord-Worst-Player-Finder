# Хранилище

Локальная SQLite-БД, Node.js >=22.14.0. `node:sqlite` на минимальной версии экспериментален; npm-зависимости не добавлены. Импорт не открывает БД и не читает окружение.

```ts
import { openStorage } from './index.js';
const storage = openStorage({ path: '.local/app.sqlite' });
try {
  storage.recordMatch({ matchId: 101, observedAt: Date.now() });
} finally { storage.close(); }
```

Родительский каталог создаёт вызывающий код. Рабочая БД и rollback journal должны находиться в `.local/` либо вне репозитория, на локальном диске. Не передавайте ключи, HTTP-зависимости и заголовки. Ошибки StorageError содержат только code/operation/message.

Открытие проверяет application ID, user_version, журнал миграций, checksum, quick_check и внешние ключи. Чужой, повреждённый и новый формат отклоняется без очистки. Создание схемы транзакционно. Используются DELETE/FULL, foreign_keys=ON, busy_timeout=1000 мс; busy возвращается без внутреннего повтора. Перед будущим обновлением схемы остановите сервис и сохраните согласованную копию; SQL downgrade отсутствует.

`close()` повторяем. Другие операции после закрытия возвращают closed. Пустой путь, URI и `:memory:` запрещены.

Первый запуск дедуплицируется по matchId/side независимо от origin. Повтор возвращает ревизию 1, не меняя её настроек. createRevision с постоянным requestId создаёт следующую ревизию только после завершения предыдущей. Последний job и последний допустимый результат — разные запросы.

| Состояние | Переход |
|---|---|
| queued / waiting | claimNext при nextRunAt <= now → running |
| running | renewClaim / checkpoint с текущими token/version |
| running | defer → waiting; finish → succeeded/failed либо needs-attention при неизвестном эффекте |
| needs-attention | resolveUncertain с ожидаемой version → waiting/failed |

Claim действует 60 секунд. Продлевайте его во время долгой обработки и заменяйте локальное значение возвращённым Claim: renew/checkpoint/saveInputs повышают version. Storage не запускает таймер. Истёкший токен не разрешает ни запись контрольной точки, ни внешнюю отправку.

Перед defer/finish завершите prepared-reservation исходом preflight либо завершите обработку попытки. Не оставляйте незавершённый вызов аналитика при добровольной передаче задачи другому обработчику.

Артефакты snapshot/bundle/prepared сохраняются атомарно через saveInputs. Нужен исходный MatchSnapshot для проверки manifest.dataDigest. Валидация фактов и результата использует публичные функции соседних модулей. DTO сериализуются без сортировки ключей; это сохраняет строку context, из которой аналитик проверяет точное тело запроса. После подготовки входы этой ревизии неизменяемы. Предел одного артефакта — 32 MiB UTF-8, меньшие ограничения аналитика продолжают действовать. Хранятся полные локальные приватные снимки и content; автоматического удаления нет.

| Операции | Результат |
|---|---|
| recordMatch / enqueueInitial / createRevision | обнаружение, первая задача, явная новая ревизия |
| claimNext / renewClaim / checkpoint / defer / finish | владение, контрольная точка и состояние |
| saveInputs / getJobArtifacts | неизменяемые входные DTO и ссылки |
| reserveAnalysis / startAnalysis / saveAnalysisOutcome | резерв одного вызова, одноразовый beforeSend, исход |
| beginParse / saveParseOutcome | одноразовый POST разбора, job ID либо сводка ошибки OpenDota |
| beginPublication / savePublicationOutcome | цель и точная строка сообщения, затем message ID либо not-sent/unknown |
| recoverInterrupted / resolveUncertain | локальное восстановление и решение с аудитом |
| getJob / getLatestJob / getLatestResult / listAttempts / getBillingSummary | задачи, принятый результат, журнал и расходы |

Подготовка анализа не разрешает сеть. Новый attemptId передаётся в reserveAnalysis один раз; её id используется для startAnalysis/saveAnalysisOutcome. Для каждого следующего вызова analyzeMatch требуется новый ID. Ошибка допуска означает отсутствие права на POST; тот же допуск повторно не выдаётся. Начала parse/publication тоже одноразовые. Сохранение одинакового исхода повторяемо; противоречивое завершение возвращает conflict. Зафиксированные job ID и message ID запрещают повторную отправку в этой ревизии. После valid требуется новая ревизия для нового анализа.

Фрагмент обработки; `claim` должен оставаться действующим, продление выполняет вызывающий pipeline:

```ts
const reservation = storage.reserveAnalysis(claim, { attemptId, preparedRef });
const attempt = await analyzeMatch(prepared, bundle, { attemptId, maxEstimatedCostUsd }, {
  apiKey,
  beforeSend: async started => storage.startAnalysis(claim, reservation.id, started),
});
storage.saveAnalysisOutcome(reservation.id, attempt);
if (attempt.status === 'valid') {
  const current = storage.checkpoint(claim, { step: 'publish', resultAttemptId: reservation.id });
  claim = current.claim;
}
```

Компилируемый и проверяемый на поддельном транспорте пример находится в `test/storage-example.ts`. Ключ передаётся только аналитику и не входит в параметры storage.

Сохранение final не требует действующего Claim, поэтому поздний ответ не теряется. Принятие его в контрольную точку требует нового действующего владения. Для requestSent=false после уже сохранённого started обычное сохранение возвращает conflict: отказ повторному callback не доказывает отсутствие первой отправки. Этот случай требует явного accept-outcome с notSentOutcome и подтверждением, а не автоматического обнуления расхода.

recoverInterrupted вызывается явно и проверяет только истёкшие running. Prepared без допуска закрывается без выдуманного AnalysisAttempt; безопасная задача становится waiting. Started без ответа, неизвестный parse или publication дают needs-attention. Действующие токены не затрагиваются, сеть не вызывается.

```ts
const recovered = storage.recoverInterrupted();
const job = storage.getJob(jobId);
// Только после явного решения вызывающего:
storage.resolveUncertain({
  resolutionId, jobId, expectedVersion: job.version, attemptId,
  decision: 'allow-new-attempt', state: 'waiting',
  reason: 'Решение повторить после проверки исхода', evidenceRef: 'local-review:decision-id',
});
```

resolveUncertain не запускает повтор сам и не считает прежний запрос бесплатным. Оно хранит исходный attempt, решение, причину, время и ссылку на подтверждение. Повтор resolutionId с другим содержимым отклоняется. Для уже сохранённого достоверного позднего исхода используйте accept-outcome. Не заменяйте неизвестность нулём по предположению.

getBillingSummary возвращает knownCostUsd, unknownCount и unfinishedEstimatedCostUsd раздельно. Некорректный оплаченный ответ учитывается; unknown не равен 0. Оценка незавершённой отправки не является фактической ценой и не прибавляется к ней. Общий бюджет и разрешение новых расходов остаются обязанностью вызывающего. Сервис автоматической сверки расходов не реализован.

getLatestResult возвращает принятый valid selected/insufficient-evidence с исходной calibration и ревизией; неудачная новая задача его не удаляет. Receipt содержит input и inputRef, StartedAttempt, финальный DTO и решения, без их смешивания. Для Discord storage проверяет JSON-объект, цель и размер строки сообщения; Discord-модуль должен отдельно проверить payload и mentions.

Локальная транзакция не гарантирует ровно один эффект у удалённого сервиса. При потере ответа неизвестность остаётся до явного решения. Ошибка COMMIT не разрешает отправку; после переоткрытия читайте журнал, не повторяйте start как проверку его состояния. Проверки: `npm.cmd run typecheck`, `npm.cmd test`; фактические результаты и ограничения — в VERIFICATION.md.
