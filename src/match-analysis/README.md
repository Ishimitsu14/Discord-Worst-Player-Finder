# Аналитик MiMo

Самостоятельный модуль поверх публичного `FactsBundle`. Контракт: [OpenSpec](../../openspec/changes/add-match-analysis/specs/match-analysis/spec.md), решения: [design.md](../../openspec/changes/add-match-analysis/design.md).

Core не читает окружение/файлы и не вызывает сеть при импорте. Зависимости — существующие TypeScript, Node.js 22.14+ и Ajv. Ключ, fetch, отмену и приёмник `started` передаёт вызывающая сторона; очередь, постоянное хранение, уникальность attemptId, повторный запуск и общий бюджет остаются у неё.

Вход получают через `prepareMatchFacts` либо проверяют `verifyFactsBundle` с исходным снимком/options. Аналитик проверяет форму и целостность; заново вычисленный злоумышленником hash не доказывает подлинность данных OpenDota. Модели предназначен только `context`, полные `facts` и `evidence` остаются локально.

Первый пакет инструкции экспериментальный. Изолированные тесты проверяют контракт, а реальное качество выбора, интерпретации и roast требует пользовательского ревью лаборатории.

## Пакет и офлайн-запрос

`loadPromptPackage('analysis/prompts/v1')` читает четыре UTF-8 файла явно. `createPromptPackage(files, calibrationEvidence?)` делает то же из строк без файловой системы; core не обращается к диску. Digest учитывает точные bytes каждого файла и его имя; пробел или новая строка меняют digest. Схема формата v1 закреплена в коде; её ослабление под тем же форматом не принимается. Функции возвращают собственные копии входного пакета.

Начальные параметры: temperature 0.2, max_tokens 8192, reasoning upstream-default. Строгая схема и allowlist deepinfra/gmicloud/xiaomi сохраняются в точном теле. Пакет experimental имеет calibrationReport null. Для candidate требуется ссылка/digest существующего отчёта и его bytes со stage candidate, рекомендацией candidate и ревизией ручного ревью; загрузчик читает путь относительно каталога пакета. Эти признаки проверяют целостность заявления, а смысл и применимость отчёта подтверждает владелец пакета.

`examples.json` начинается пустым. Каждый будущий пример содержит context, analysis и provenance с matchId/side, snapshotDigest/contextDigest, split development, labelRevision/reviewRevision. Пример проходит проверку формы Brief/ответа, digest, происхождения и запрета целевого match ID, включая другую сторону. Подлинность ручного вердикта не доказывается строкой ревизии. Модель получает только context и analysis примера; происхождение и эталон целевого матча не отправляются.

```ts
import { loadPromptPackage, prepareAnalysis } from './src/match-analysis/index.js';

const prompt = await loadPromptPackage('analysis/prompts/v1');
const prepared = prepareAnalysis(bundle, prompt);
// prepared.body — точный JSON без ключа, prepared.requestDigest — SHA-256 этих bytes.
```

Исполнимый пример читает четыре файла пакета, сохранённые командой `lab facts`, и выводит только идентичность/размеры. Из корня проекта в PowerShell:

```powershell
npm.cmd run build
node analysis/examples/prepare.mjs .local/evaluation/facts/<UUID>
```

В Linux используется `npm run build`; Node-команда та же. Пример не требует ключа, не обращается к сети, не записывает файлы и не загружает отсутствующий снимок. Каталог подставляется существующий; ввод raw OpenDota вместо FactsBundle не поддерживается.

Предел Brief — 65536 bytes точного minified UTF-8, запроса — не более 262144 bytes (профиль может уменьшить). Переполнение даёт ошибку без удаления игроков, драк и примеров. `ceil(requestBytes / 2)` — маркированная эвристика utf8-bytes-div-2-v1; это не токенизатор, гарантия контекстного окна или измерение расходов/скорости.

## Ответ и ручное ревью

`validateMatchAnalysis(json, bundle)` проверяет формат match-analysis-v1, пять уникальных союзников и их position/source, один/два выбора, статус, альтернативу и ссылки. У выбранного ровно 2–3 reasons и roast. У Claim/roast предел 600 Unicode символов; contributions/concerns до трёх, evidenceIds от 1 до 12 уникальных ID; limitations до восьми строк по 300 символов. Любой пропуск ресурса/контраргумента/вклада/проблем объясняется limitations игрока.

`insufficient-evidence` — пригодный содержательный ответ: пять оценок, пустой выбор, null comparison/alternative, low confidence и ограничения. Ошибка API или провайдера этим статусом не маскируется.

Ссылки проверяются во всех Claim: оценки пятерых, reasons, comparison и альтернатива. Допустим ID переданной именованной группы; ID её члена, оставшийся лишь в локальном реестре, не принимается. Структурная проверка не доказывает смысл: правильность метрики/слота, причинности, русского языка, выбора и шутки проверяется вручную.

`analysisClaims(analysis)` возвращает `{address:{section,playerSlot,index},fact}` по стабильным адресам. Ревью отдельно фиксирует: согласие с выбором; верность каждого Claim и ограничения роли/причинности; пригодность roast и отсутствие в нём новых обвинений. Форматы Review v2 лаборатории не меняются и не становятся совместимыми с новым списком автоматически.

## Сетевое выполнение

`analyzeMatch(prepared, bundle, options, dependencies)` возвращает AnalysisAttempt. Options: уникальный `attemptId` из 1–128 букв/цифр/`_`/`-`, явный положительный `maxEstimatedCostUsd`, необязательные timeoutMs (по умолчанию 180000, от 1 до 2147483647 мс) и notBefore (ISO UTC). Dependencies: apiKey, обязательный асинхронный beforeSend, необязательные fetcher и signal. Ключ получает точка сборки из `OPENROUTER_API_KEY`; модуль не читает его самостоятельно.

Перед сетевым выполнением повторно проверяются запрос/пакет/вход, затем один GET актуальных endpoint и оценка цены по максимальным применимым тарифам всех разрешённых маршрутов. Если хотя бы один достижимый маршрут не подтверждает схему/параметры/контекст/цену, генерации нет. Тело не меняется под доступный маршрут; нужен явно подготовленный другой профиль. System-сообщение включает ID и digest пакета, поэтому любая правка его четырёх файлов меняет digest запроса.

После preflight beforeSend получает собственную копию StartedAttempt с плоской идентичностью и оценкой стоимости. Только после успешного завершения callback выполняется один POST. Вызывающая сторона обязана сохранить started постоянно и затем сохранить возвращённый итог. Пример подключения к будущему хранилищу:

```ts
const result = await analyzeMatch(prepared, bundle, {
  attemptId, maxEstimatedCostUsd,
}, {
  apiKey, signal,
  beforeSend: started => storage.saveStarted(started),
});
await storage.saveAttempt(result);
```

storage здесь — интерфейс caller, собственной БД у модуля нет. Неизвестная стоимость предыдущих попыток, общий бюджет серии, cooldown и постоянная дедупликация решаются caller. Новый явный запуск получает новый ID. Callback не является техническим доказательством постоянной записи — её обеспечивает реализация caller.

Общий таймаут охватывает metadata, beforeSend, POST и чтение ответа. При истечении callback POST не произойдёт, даже если callback завершится позднее. Отмена/таймаут после отправки допускают состоявшуюся генерацию и списание. Retry-After возвращается как retryAt (секунды/HTTP date; при 429/503 с невалидным заголовком — 60 секунд); notBefore отклоняет преждевременный новый запуск без ожидания. Автоматического повторного POST, исправления JSON, дозагрузки фактов и смены модели нет.

## Итог попытки и ошибки

Identity содержит назначенные кодом matchId/side, bundleId/contextDigest, packageId/packageDigest/calibration, responseFormat/requestDigest. В AnalysisAttempt она находится в поле identity, а в StartedAttempt — плоско. При ошибке до проверки входа identity/attemptId могут быть null; непроверенные строки входа не отражаются в диагностике.

Статусы: preflight-failed, valid, invalid-output, api-error, transport-error, timed-out, aborted. `valid` означает структурную проверку, а не ручное подтверждение качества. Техническая ошибка имеет analysis null. Error содержит только закрытый code, допустимый httpStatus и известный apiType, без сырого сообщения провайдера. Офлайн-функции выбрасывают AnalysisError; сетевой вызов возвращает ожидаемые ошибки в результате.

Результат содержит UTC/elapsedMs, requestSent, доступные generationId/model/provider/finishReason, оценку/rates и usage. Метрики токенов и costUsd независимо равны null, когда неизвестны; известный ноль сохраняется. BillingState — not-sent, known или unknown. Известный usage сохраняется и для ошибочного/невалидного платного ответа; эвристическая цена не подставляется вместо фактической. Отдельного GET по generation ID нет.

Content и responseDigest доступны для локального ревью. При отражении ключа в content или экспортируемых строковых метаданных они не возвращаются; ошибка secret-in-output не содержит ключа. Headers, reasoning, произвольные provider metadata и сырые API errors не экспортируются. Запросы и реальные результаты сохраняет caller вне Git; модуль файлы не пишет.

Проверки и оставшиеся живые ограничения: [VERIFICATION.md](VERIFICATION.md).
