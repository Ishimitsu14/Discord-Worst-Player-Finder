# Discord-интерфейс

Модуль предоставляет три guild-команды, локальное формирование русского embed и Publisher для существующего MatchPipeline. Сам не подключает бота, не запускает очередь, не читает env/файлы, не открывает БД и не меняет режим анализа. Проверенные настройки, секреты и ресурсы передаёт caller.

Установлен exact `discord.js 14.27.0`; lock фиксирует REST 2.6.3. Поддерживаемый Node проекта остаётся >=22.14.0. Соседние контракты и схема Storage не менялись.

## API и сборка

| API | Контракт |
|---|---|
| buildCommandDefinitions() | чистые JSON-определения трёх команд |
| registerGuildCommands({applicationId, guildId, botToken}, {makeRequest?, signal?}) | явный upsert только собственных guild-команд; complete/partial с безопасным кодом |
| createDiscordPublisher({botToken}, {makeRequest?, signal?}) | Publisher, без сетевых действий при создании |
| renderAnalysis({job, analysis, bundle, snapshot}) | чистый проверенный APIEmbed принятого valid |
| createDiscordInterface({settings, requestTimeoutMs?}, dependencies) | создать объект обработки, не подписывать listener |
| handleInteraction(interaction) | обработать свою chat-input команду либо ignored |
| attach() / stop() | подключить один listener / запретить новые команды, снять его и дождаться доступных исходов |

`settings` — GroupSettings, копируется и замораживается. `requestTimeoutMs` по умолчанию 60000, safe integer 1..60000; неизвестные options запрещены. Сначала ACK ограничен тремя секундами, после успешного ACK действует requestTimeoutMs. Dependencies: готовые `client`, `pipeline`, `storage` с публичным getJobArtifacts, optional `clock` (now/setTimeout/clearTimeout) и `onEvent`. Client/Storage/pipeline остаются собственностью caller. Stop не вызывает destroy/close/pipeline.stop и не удаляет команды. Повторное подключение после stop требует нового объекта.

Порядок сборки: создать Publisher → передать его при создании MatchPipeline → создать Discord interface с этим pipeline. Login, регистрация, attach и pipeline.run выполняются отдельно и явно. Типизированный исполняемый пример — `test/discord-interface-example.ts`; он проверяется с поддельным REST и временной SQLite.

```ts
const publisher = createDiscordPublisher({ botToken: locallyLoadedToken });
const pipeline = createMatchPipeline(pipelineOptions, { ...pipelineDependencies, publisher });
const discord = createDiscordInterface({ settings }, { client, pipeline, storage });

// После явного решения подключить бота:
await client.login(locallyLoadedToken);
const registration = await registerGuildCommands({ applicationId, guildId: settings.guildId, botToken: locallyLoadedToken });
discord.attach();
const running = pipeline.run({ automatic: false });

// В обработчике остановки приложения:
await discord.stop();
await pipeline.stop();
await running;
await client.destroy();
storage.close();
```

Этот фрагмент требует уже загруженных зависимостей; он не является готовым bootstrap. Pipeline по умолчанию prepare-only: basic ждёт разрешения parse, parsed сохраняет запрос без MiMo. Live, бюджет, experimental и постоянную automaticSince настраивает caller по инструкции pipeline. Старый лимит лаборатории не используется.

## Настройка приложения

В Discord Developer Portal создаются приложение и bot. Токен хранится локально вне Git и не передаётся в чат. Для установки в свой сервер используются scopes `bot` и `applications.commands`; целевому каналу нужны View Channel, Send Messages и Embed Links. Запрашивать Administrator у самого бота не требуется.

Caller создаёт Client с `GatewayIntentBits.Guilds`. Message Content, Guild Members и Presence модулю не нужны. Поддерживаются обычные текстовые и announcement каналы; threads/forum/voice/category/DM не являются целями публикации v1. Доступ и type/guild перед отправкой подтверждаются GET канала и ответом Discord; права после настройки могут измениться и привести к сохранённому отказу.

Регистрация запускается отдельным явным вызовом. Она не делает bulk overwrite/global/delete и сохраняет чужие команды приложения. Если upsert части команд не удался, результат partial содержит выполненные имена и безопасный код; следующий явный запуск использует те же имена. Реальная регистрация/подключение/сообщение в этом изменении автоматически не выполняются.

## Команды

| Команда | Кто и что получает |
|---|---|
| `/worst match_id:101 [side:radiant]` | участник заданного канала; первая задача или существующая, без автоматической новой ревизии |
| `/worst-status job_id:UUID` | участник того же канала; текущая задача, причина и доступный сохранённый результат |
| `/worst-reanalyze match_id:101 side:radiant` | только Discord Administrator; явная новая ревизия |

Match ID — десятичная строка без пробелов, ссылки, leading zero, дробей и экспоненты; значение <=Number.MAX_SAFE_INTEGER. Сторона radiant/dire, в повторном анализе обязательна. Discord IDs остаются uint64 строками. Job ID использует существующий ASCII формат очереди 1..128 символов.

DM/другой guild/другой канал/thread отклоняются до очереди. Admin проверяется на каждом вызове; Manage Guild сам по себе не даёт право повтора, UI override команды проверку не обходит. Привязки Steam к Discord нет. Повтор использует requestId `discord_${interaction.id}`; повторная доставка той же interaction не создаёт вторую ревизию после reopen.

Все служебные ответы приватные, с запрещёнными mentions. До OpenDota выполняется deferReply; отказ ACK даёт ноль постановок. Ошибка editReply после commit не откатывает задачу и не повторяет запрос. Неоднозначность стороны предлагает обычную команду с явной radiant/dire. Команда не ждёт полного анализа и не вызывает worker. Итог публикуется обычным бот-сообщением независимо от 15-минутного interaction token.

Статус переводит состояния на русский: «в очереди», «обрабатывается», «ожидание», «нужна проверка», «завершена», «ошибка». Причины подготовки, бюджета, реплея и отсутствующего Publisher показаны отдельно. Неизвестный reason не выводится сырым текстом. Valid с неизвестной стоимостью остаётся доступным, но статус предупреждает о расходе; автоматически разрешать неизвестность через Discord нельзя.

Проверяются сохранённые guild/channel и задачи, и результата. Старая цель другого канала скрывается, для неизвестного/недоступного job одинаковый ответ. При failed новой версии прежний valid отображается с собственным номером. Чтение не вызывает OpenDota/MiMo и не отправляет публичную копию; известный message ID даёт построенную ссылку Discord без проверки существования или восстановления удалённого сообщения.

## Вид результата

Selected: `Разбор #101 — Radiant: победа`, сравнение/длительность, отдельное поле `Наш игрок — Anti-Mage` с сохранённым roast и 2–3 поля оснований. При двоих выбранных оба сохраняются. Nick берётся из сохранённого snapshot по slot/hero; fallback `Игрок, слот N`, герой — facts или `Герой #ID`. Поиска профилей/аватаров и выбора худшего в коде нет.

Синтетический JSON embed, проверяемый тестом renderer:

```json
{
  "title": "Разбор #101 — Radiant: победа",
  "url": "https://www.opendota.com/matches/101",
  "description": "Синтетическое основание, не оценка реальной игры. • 25:00",
  "fields": [
    { "name": "Наш игрок — Anti-Mage", "value": "Синтетическая игровая шутка для теста." },
    { "name": "Основание 1 — Anti-Mage", "value": "Синтетическое основание, не оценка реальной игры." },
    { "name": "Основание 2 — Anti-Mage", "value": "Синтетическое основание, не оценка реальной игры." },
    { "name": "Ограничения", "value": "Синтетическая фикстура." }
  ],
  "color": 5793266,
  "footer": { "text": "Версия 1 • уверенность низкая • экспериментально" }
}
```

Insufficient-evidence: `Недостаточно данных #101 — Radiant: победа`, сообщение об отсутствии обоснованного выбора и сохранённые ограничения. Худший и обвиняющий roast не придумываются. В приватном статусе рядом с ошибкой новой версии видно `Сохранённый результат: версия 1`.

```json
{
  "title": "Недостаточно данных #101 — Radiant: победа",
  "url": "https://www.opendota.com/matches/101",
  "description": "Недостаточно данных для обоснованного выбора. • 25:00",
  "fields": [{ "name": "Ограничения", "value": "Недостаточно журналов." }],
  "color": 5793266,
  "footer": { "text": "Версия 1 • уверенность низкая • экспериментально" }
}
```

Один embed, до 6000 суммарных UTF-16 единиц и в пределах индивидуальных лимитов Discord. Тексты детерминированно сокращаются с многоточием и отметкой; минимум два основания и герой каждого выбранного игрока сохраняются. Unicode обрезается без половинок surrogate, незавершённый числовой токен не превращается в другое число. Исходный анализ не меняется.

Внешние тексты очищаются от управляющих/bidi символов, mentions/Markdown/посторонние ссылки нейтрализуются. В body всегда explicit allowed_mentions с пустыми parse/users/roles. Приложение строит только OpenDota/Discord ссылки. Модельный roast не перефразируется; experimental явно обозначен. Синтетические примеры проверяют формат, внешний вид на настоящем сервере и качество выбора MiMo пока не подтверждены.

## Publisher и исходы

Prepare — только локальная проверка/JSON. Send не пересобирает сохранённую строку: REST passThroughBody передаёт точные байты в исходный channel задачи после GET проверки guild/type. Текущее переназначение канала команды не перенаправляет старую публикацию. Успех — строковый uint64 ID с правильным channel_id, затем ID сохраняет pipeline до succeeded.

Свой REST API v10 использует retries=0, rejectOnRateLimit и timeout=15000, sweepers выключены. На один send — максимум один транспортный POST, в том числе при 429/5xx/network/abort; channel.send и отдельного retry loop нет. Nonce из SHA-256 analysisAttemptId и enforce_nonce — дополнительная краткая серверная защита. Постоянную дедупликацию и допуск обеспечивает Storage.

| Исход | Что возвращается конвейеру |
|---|---|
| Некорректное тело/цель, GET отказ или отмена до POST | not-sent с безопасным кодом |
| Подтверждённые 400/401/403/404/429 | not-sent, без повторной отправки |
| 408/5xx/сеть/abort после начала POST, неверный success | unknown |
| Promise ещё жив после отмены | pipeline может перестать ждать; адаптер сохраняет возможность позднего ID |
| Известный сохранённый message ID | pipeline завершает задачу без нового send |

Отказ не стирает valid-анализ. Исправление прав не пересылает старое сообщение автоматически; команды repost/edit в v1 нет. Unknown требует внешней аудируемой проверки через существующий storage; `/worst-status` сам не разрешает её. Остановка не гарантирует отмену физического удалённого эффекта. Caller должен сохранять БД при остановке/откате.

Диагностика — только safe code и необходимые ID. Raw SDK errors/debug/response, bot/interaction token, webhook URL, модельный content, ники и снимки не выводятся. Ошибка observer не меняет исход запроса. Протокол и ограничения проверены поддельным HTTP; реальные API-вызовы требуют отдельного запуска с локальной конфигурацией.
