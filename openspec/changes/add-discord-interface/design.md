# Design

## Context

Мотивация — [proposal.md](proposal.md); поведение — [spec.md](specs/discord-interface/spec.md). На этом этапе исходников Discord-модуля нет, документы не означают реализацию.

Проверено по проекту 17 октября 2026:

- ESM/TypeScript strict, node:test, Node >=22.14.0; зависимости пока только ajv. Нет discord.js, bot login, listener или bootstrap.
- GroupSettings содержит steamAccountIds/guildId/channelId. Discord ID уже десятичные строки uint64; связи Steam ↔ Discord отсутствуют.
- MatchPipeline реализован, 24/24 задач, предыдущий полный набор 260/260. Есть requestMatch/requestReanalysis/getStatus и отдельный Publisher. Команды не должны вызывать processNext/run.
- PublicationContext содержит Job, принятый AnalysisAttempt, FactsBundle и исходный MatchSnapshot. PublicationInput — version/guildId/channelId/analysisAttemptId/message. Pipeline сохраняет точное message до send и message ID до succeeded, обрабатывает timeout/late outcome.
- Storage предоставляет getJobArtifacts, а getStatus возвращает Job и последний StoredResult пары. Статус новой ревизии и версия допустимого результата могут отличаться. Snapshot доступен отдельно; facts намеренно не содержат personaname.
- В FactsBundle есть герой/слот, исход, ограничения и реестр evidence; MatchAnalysis содержит selectedPlayers[0..2], 2–3 reasons и roast, либо insufficient-evidence. Выбор и ссылки проверяет публичный validateMatchAnalysis. Изменять схему ответа модели не требуется.
- Пользователь выбрал: обычная постановка — любому участнику заданного канала, повторный анализ — только администратору. Здесь Administrator означает бит Discord Administrator; ManageGuild сам по себе его не заменяет.

### Проверенные внешние ограничения

1. Discord требует первоначальный ответ в течение 3 секунд; interaction token действует 15 минут. Долгий разбор не должен зависеть от этого токена: [официальная документация interactions](https://docs.discord.com/developers/interactions/receiving-and-responding).
2. Сообщение допускает до 10 embeds, но суммарный текст ограничен 6000 символами; отдельные title/description/field name/field value/footer — 256/4096/256/1024/2048. Allowed mentions нужно передавать явно. Create-message поддерживает nonce/enforce_nonce, но уникальность проверяется лишь за последние несколько минут: [Message Resource](https://docs.discord.com/developers/resources/message).
3. Default member permissions задаются целой команде. Guild upsert по имени не требует bulk overwrite; bulk overwrite удаляет отсутствующие в списке команды: [Application Commands](https://docs.discord.com/developers/interactions/application-commands).
4. Исходники тега discord.js 14.27.0 указывают Node >=18; это совместимо с целевой версией проекта по заявленному engine. Документацию main нельзя механически применять к этому тегу: [package.json](https://github.com/discordjs/discord.js/blob/14.27.0/packages/discord.js/package.json).
5. REST SDK по умолчанию повторяет timeout/5xx, а 429 имеет отдельную ветку повторного исполнения. `retries: 0` недостаточно без rejectOnRateLimit. RequestData поддерживает signal и passThroughBody: [REST types](https://github.com/discordjs/discord.js/blob/14.27.0/packages/rest/src/lib/utils/types.ts), [Shared](https://github.com/discordjs/discord.js/blob/14.27.0/packages/rest/src/lib/handlers/Shared.ts), [SequentialHandler](https://github.com/discordjs/discord.js/blob/14.27.0/packages/rest/src/lib/handlers/SequentialHandler.ts).

Сведения проверены чтением документации и исходников, не реальным ботом. `npm view` из текущей песочницы завершился ENOTFOUND registry.npmjs.org; npm metadata и конкретный транзитивный lock пока не подтверждены. Это отдельная проверка установки при реализации, не причина изменять Node или устанавливать пакет на этапе документов.

## Goals / Non-Goals

**Goals:**

- Добавить тонкий Discord-слой поверх существующего конвейера и его журналов.
- Иметь детерминированный offline renderer и отдельно тестируемые команды/REST publisher.
- Сохранить различие между приватным ответом команды, публичным результатом и неизвестным внешним эффектом.

**Non-Goals:**

- Компоненты с долгоживущими custom_id, кнопки согласования, выбор стороны через collector, редактирование старых сообщений и публичный repost.
- Новый HTTP interactions endpoint, webhook receiver, привилегированные intents, поиск Steam/Discord профилей и профильные аватары.
- Изменение storage/pipeline/модели, автоматическое разрешение unknown, новые API-пилоты, загрузка env, startup/VPS.

## Decisions

### 1. Граница файлов и явная сборка

Новый `src/discord-interface/index.ts` экспортирует публичные типы, безопасные ошибки, определения команд, регистрацию, фабрику обработчика и фабрику Publisher. Небольшие внутренние файлы разделяют команды, представление и REST. Импортов соседних private-файлов нет.

Предлагаемые публичные операции:

| API | Ответственность |
|---|---|
| buildCommandDefinitions() | чистые JSON-определения трёх guild-команд |
| registerGuildCommands({applicationId, guildId, botToken}, dependencies?) | явные upsert только своих команд; возвращает безопасный отчёт о выполненном/частичном результате |
| createDiscordPublisher({botToken}, dependencies?) | создать Publisher без сетевых действий; внутри отдельный настроенный REST manager |
| createDiscordInterface({settings, requestTimeoutMs?}, dependencies) | проверить/скопировать настройки, передать caller-owned Client/MatchPipeline/чтение Storage |
| handleInteraction(interaction) | awaitable обработка только трёх известных chat-input команд; неизвестные — ignored |
| attach() | явно подписать один interactionCreate listener; повторный attach не добавляет второй |
| stop() | снять listener, запретить новые вызовы, отменить и дождаться обработчиков; не закрывать caller-owned ресурсы |

Dependencies обработчика: готовые Client, MatchPipeline, публичный reader getJobArtifacts из Storage, clock и необязательный безопасный onEvent. Зависимости REST принимают makeRequest для поддельного HTTP. Default requestTimeoutMs=60000, safe integer 1..60000; неизвестные options отклоняются. Clock имеет now/setTimeout/clearTimeout. Если dependency getter или конфигурация некорректны, возвращается безопасный invalid-config, без сырого исключения. Секретные строки не включаются в сериализуемые объекты/ошибки.

Композиция устраняет цикл pipeline ↔ commands: сначала создать Publisher, передать его при создании pipeline, затем создать Discord interface с уже готовым pipeline. Caller отдельно управляет Client.login, регистрацией, interface.attach и pipeline.run. Module stop не вызывает pipeline.stop/client.destroy/storage.close; порядок общей остановки задаст operations. Приём interactions через Gateway с минимальным Guilds intent; MessageContent, GuildMembers и Presence не запрашиваются.

Альтернатива с созданием своего второго worker или HTTP-сервера увеличивает границы и дублирует жизненный цикл — здесь не нужна.

### 2. Зависимость и граница транспорта

При реализации закрепить `discord.js: 14.27.0` без caret и обновить package-lock. Проверить опубликованные dependency engines и реальный resolved lock на Node v22.14.0; не считать GitHub workspace-версии доказанным npm lock. Если resolver обнаружит несовместимость, остановиться и согласовать исправление плана, не поднимать engines молча. Соседние модули и Node baseline остаются прежними.

Для публичной публикации используется отдельный REST manager, создаваемый фабрикой Publisher: API v10, retries=0, rejectOnRateLimit=() => true, timeout=15000. Он не разделяет изменяемую retry-конфигурацию с caller-owned Gateway Client. Командные ACK/editReply используют его Client; их отказ не вызывает новую постановку. В модуле нет собственного fetch-retry loop и channel.send для публичного результата. В своих REST manager отключить периодические sweepers (hashSweepInterval/handlerSweepInterval=0): [конструктор REST этого тега](https://github.com/discordjs/discord.js/blob/14.27.0/packages/rest/src/lib/REST.ts) поддерживает 0. Для v1 с одним адресом это убирает фоновый жизненный цикл SDK-кеша при создании объектов; отдельные сетевые таймауты остаются ограниченными.

Publisher передаёт сохранённую строку message через rest.post(Routes.channelMessages(channelId), {body: message, passThroughBody: true, headers: {'Content-Type': 'application/json'}, signal}). Это сохраняет точные UTF-8 байты и позволяет передать отмену, без пересборки MessagePayload. Внутренний makeRequest подменяется в тестах настоящего REST manager; проверки считают транспортные POST, включая 429/5xx/abort, а не только вызовы фасада.

Альтернатива с default SDK retries допускает повтор после неизвестного эффекта. Один лишь retries=0 не закрывает 429; оба параметра обязательны. Новый отдельный fetch-клиент не нужен.

### 3. Команды и допуск

| Команда | Ввод | Допуск / эффект |
|---|---|---|
| `/worst` | match_id: STRING required, side: STRING optional с choices radiant/dire | участник заданного канала; requestMatch |
| `/worst-status` | job_id: STRING required | тот же контекст; readonly getStatus и при необходимости getJobArtifacts |
| `/worst-reanalyze` | match_id: STRING required, side: STRING required | тот же контекст + Administrator; requestReanalysis |

Названия команд/параметров — технические ключи, описания и ответы — русские. Повтор вынесен отдельной командой, поскольку default_member_permissions применяется к top-level команде. Для неё указывается Administrator; две остальные не требуют административного разрешения. Runtime проверяет бит заново, даже если Discord UI разрешил команду через override.

Проверка контекста опирается на interaction.guildId/channelId, а не имя/категорию/родительский канал. DM и thread не совпадают. Неполные данные о правах администратора означают отказ. В списке компании нет Discord users; обычный участник определяется разрешённым контекстом команды, не Steam-привязкой.

Match ID принимается строкой по `^[1-9][0-9]{0,15}$`, затем проверяется safe integer и точное обратное представление. Нет trim, URL parser, экспоненты, leading zero или Steam64-конвертации. Job ID соответствует публичному storage формату: 1..128 ASCII букв/цифр/underscore/hyphen, первый символ буква/цифра. Discord IDs проверяются как положительные uint64 строки. Числа не используются для guild/channel/message/interaction ID.

Регистрация вызывает upsert каждого из трёх собственных имён в одном guild. Никаких bulk overwrite/global/delete. Повтор регистрации идемпотентен по имени; частичная ошибка сохраняет отчёт без rollback удалением команд. Неизвестный transport исход регистрации не запускает автоматический повтор в этом вызове. Следующий явный вызов безопасно выполняет те же upsert. У приложения могут оставаться другие команды.

### 4. Interaction не является задачей очереди

Обработчик сначала определяет, относится ли chat-input команда к модулю. Для своих команд быстро проверяет контекст/формат/права и отвечает приватно; перед любым OpenDota-зависимым запросом обязательно успешно await deferReply с Ephemeral. Первоначальный ответ должен начаться в пределах 3 секунд, без файлов и медленной сети до него. Нельзя ретроспективно сделать публичный ACK приватным.

Если ACK отклонён или его исход неизвестен, постановка не начинается. Повторный Gateway event не должен давать два бизнес-вызова: внутри процесса используется набор обрабатываемых interaction ID только на время активного handler; после рестарта duplicate ACK отклонит Discord, а постоянство ревизии дополнительно обеспечивает requestId=`discord_${interaction.id}`. Interaction tokens не сохраняются в БД/логах. Завершённые interaction ID не образуют бесконечный кеш.

После ACK запрос ограничен requestTimeoutMs. Контроллеры отменяются при stop; signal передаётся pipeline.requestMatch/requestReanalysis. В успешном editReply: job ID, ревизия, текущий этап/причина и инструкция `/worst-status job_id`. Полный parse/MiMo/publish не ожидаются. Worker запускает caller, команды не вызывают run/processNext и не включают live/experimental.

Requires-side даёт пример повторного обычного вызова с Radiant/Dire. Это новый явный запрос с аргументом; кнопок/collectors и фонового выбора нет. Rejected объясняет неподдерживаемый/непригодный матч. Unfinished conflict объясняет существующую обработку, без отмены или новой ревизии. Повтор обычной пары возвращает первую задачу конвейера, а не новую генерацию.

Ошибка ответа после успешной постановки не откатывает job и не повторяет pipeline-вызов. При неоднозначном подтверждении сохранения текст не утверждает «задача не создана»: пользователь может повторить обычный запрос, который найдёт initial job. Для новой ревизии сохраняется interaction-derived requestId. Никакого fire-and-forget повторного analyze.

Альтернатива с ожиданием полного результата на interaction token ненадёжна: очередь, parse и бюджетная пауза могут занять дольше 15 минут. Итог отправляется обычным бот-сообщением через Publisher независимо от interaction.

### 5. Чтение и приватность сохранённого результата

`/worst-status` использует pipeline.getStatus({jobId}). Сразу после чтения сравнить job.settings.guildId/channelId с разрешёнными настройками и текущим контекстом. Для неизвестного и недоступного ID один ответ «Задача не найдена или недоступна»; поля чужой задачи не передавать ни в reply, ни в observer. Никаких запросов OpenDota или профилей.

StoredResult проверяется отдельно по settings его job. Последний результат пары может относиться к старому каналу; такой результат скрывается целиком. Если новая задача текущего канала доступна, её состояние остаётся видимым без утечки прежнего результата. После обычного requestMatch те же проверки применяются к возвращённому existing job: общая дедупликация может найти задачу прежних настроек, её нельзя раскрыть или перенаправить. Явная новая ревизия остаётся единственным способом создать новый анализ с текущими настройками, если это разрешено storage.

При доступном результате прочитать артефакты именно result.job.id. В приватном ответе отдельно указать состояние запрошенной ревизии и номер принятой ревизии, затем приложить сохранённый embed и при наличии известного message ID построенную ссылку https://discord.com/channels/{guildId}/{channelId}/{messageId}. Существование сообщения по ссылке не проверяется и удалённое сообщение не создаётся вновь. Если артефакты повреждены, показать безопасную ошибку чтения, не переподготавливать факты и не запускать генерацию.

Состояния queued/running/waiting/needs-attention/succeeded/failed переводятся на русский. Для шагов — получение матча, ожидание реплея, подготовка фактов, анализ, публикация. Кодам live-disabled/experimental-disabled/budget-unknown/budget-exhausted/parse-disabled/parse-timeout/publisher-unavailable соответствует понятная причина. Unknown reason даёт общее сообщение, не сырую строку из storage. BillingUnknown/attention отображаются отдельно от успешности анализа; наличие valid не доказывает доставку или известность счёта.

### 6. Чистое представление результата

Один pure renderer принимает PublicationContext. Он требует valid AnalysisAttempt, соответствие attemptId принятому job.resultAttemptId, match/side/bundle identity и публичную проверку validateMatchAnalysis по сохранённому bundle. Для nick сопоставить snapshot.players по player_slot, подтвердить hero_id по фактам и не использовать порядок массива. Основные сведения берутся из сохранённых фактов/снимка; модель не получает ник через этот модуль.

Personaname — пригодная непустая строка; иначе «Игрок, слот N». HeroName — сохранённое имя из facts; иначе `Герой #heroId`. Нет lookup Steam/Discord, аватаров или догадок. Исход вычисляется по side и radiant_win; duration — сохранённые секунды в mm:ss. Победа не меняет выбор. Никаких нормализаций или пересчёта «худшего» здесь нет.

Формат v1 — один embed с построенной OpenDota-ссылкой:

- Title: match ID, сторона и победа/поражение.
- Description: краткое сохранённое сравнение, без дополнительных обвинений.
- Для каждого selectedPlayers: поле «ник — герой» с roast и 2–3 отдельных поля оснований в исходном порядке. Не публиковать все пять полных assessments и внутренние payload.
- Отдельное поле с сохранёнными ограничениями; footer содержит ревизию, уверенность и метку experimental, если применима.
- Для insufficient-evidence — заголовок о недостатке данных и ограничения; нет выбранного игрока/roast, исход и ссылка сохраняются.

Исходные строки не перефразируются. Детерминированная очистка убирает управляющие/bidi символы, нормализует переносы/пробелы, экранирует Markdown и нейтрализует `@`/mention и посторонние URL. Построенные приложением OpenDota/Discord ссылки проходят отдельную проверку. Рендер не добавляет user-generated URL, аватары, attachments, embeds с внешними изображениями или reply-reference.

Размер считается в UTF-16 code units консервативно после очистки/экранирования; обрезка проходит по Unicode code points, без отрезанного surrogate. Предлагаемый бюджет: title <=128; description <=450; footer <=128; имена полей игроков <=96; имена оснований <=40; roast <=400; каждое основание <=600; поле ограничений с именем <=400. Для двоих и трёх оснований на каждого это укладывается в 6000. В любом случае финальная валидация всех individual/aggregate лимитов обязательна.

Обрезанное поле заканчивается многоточием; footer/поле ограничений отмечает сокращение текста. Предпочтительна граница слова/предложения; незавершённый числовой токен удаляется целиком перед многоточием, числа не округляются и не переписываются. Слоты, ID, исход и количество выбранных игроков не обрезаются. Минимум два основания на каждого остаются отдельными полями. Если после очистки нельзя получить непустые обязательные тексты или лимиты не проходят, renderer возвращает безопасную ошибку до beginPublication. Сохранённый полный анализ не меняется.

Альтернатива с разбивкой на несколько сообщений требует нескольких ID и частичных исходов, которых нет в PublicationInput/receipt v1. Один embed позволяет сохранить существующий протокол.

### 7. Точное сообщение и Publisher

Prepare — только renderer/валидация/JSON.stringify, без Discord вызовов. Выходной объект ограничен `embeds: [embed]`, `allowed_mentions: {parse: [], users: [], roles: [], replied_user: false}`, nonce и enforce_nonce. Nonce — 25 hex-символов SHA-256 от analysisAttemptId, enforce_nonce=true. Он стабилен для одного принятого анализа и различается между ревизиями. Серверная дедупликация действует недолго и не разрешает повтор после рестарта: основной барьер — storage.

Send не вызывает renderer и не меняет message. Снова проверить JSON-объект, разрешённые поля, размеры, запрет mentions/посторонних URL, nonce по input.analysisAttemptId и uint64 target ID. Это проверка сохранённого тела, а не замена его байтов.

До POST выполняется GET целевого канала через тот же REST manager: канал должен иметь input.guildId и быть GuildText или GuildAnnouncement. Thread, forum/voice/category/DM отклоняются без создания сообщения. Используется цель PublicationInput, а не текущие настройки commands. Любой отказ в предварительной проверке подтверждает not-sent; новый канал не выбирается. Права ViewChannel/SendMessages/EmbedLinks должны быть настроены владельцем приложения. Вручную воспроизводить вычисление permission overwrites не нужно: доступ проверяется Discord, окончательный отказ 403 сохраняется.

После проверок — не более одного rest.post с сохранённым body и signal. Допуск beginPublication и сохранение исхода остаются в pipeline; адаптер не вызывает методы журнала и не помечает job succeeded. Успех требует строковый uint64 response.id и совпадающий response.channel_id. Возвращается только messageId. Запись ID выполняет конвейер.

| Место/исход | PublicationError |
|---|---|
| неверное сохранённое тело/ID до POST | invalid-message / not-sent |
| отсутствующий/чужой/неподдерживаемый канал, GET отказ | unavailable или forbidden / not-sent |
| ошибка сети/отмена до вызова create-message | transport-error / not-sent |
| подтверждённый Discord 400/401/403/404 на create-message | invalid-message/forbidden/unavailable / not-sent |
| RateLimitError до dispatch или подтверждённый 429 | rate-limited / not-sent, без SDK retry |
| timeout/network/abort/5xx после начала create-message, неверный success | transport-error / unknown |

Неизвестные 4xx без надёжно распознанного ответа также консервативно unknown; HTTP 408 не считается доказанным not-sent. Равенство Error.message, строковый парсинг raw body и original cause не используются. Предварительный отказ после beginPublication может завершить job failed, но результат остаётся сохранённым; исправление прав не приводит к скрытому repost. Команда ручной повторной публикации вне v1.

Если transport не завершил Promise после abort, адаптер не подделывает быстрый unknown-final. Pipeline перестаёт ждать по собственному timeout, сохраняет started и слушает поздний исход. Если REST/fetch уже завершился отменой, вернуть unknown; последующий raw сетевой ответ не заменяет принятый финал. Exactly-once удалённого эффекта не обещается.

### 8. Диагностика и остановка

DiscordInterfaceError содержит стабильный code и безопасный operation, без cause, raw errors, request body и bot/interaction token. Observer получает только тип события, разрешённые guild/channel/interaction/job IDs и safe code; payload/model content/ники/список Steam IDs туда не передаются. Sync throw и rejected Promise observer поглощаются. Сырой SDK Debug/Response event не подключается к логам.

Stop запрещает новые handleInteraction/attach этого объекта, снимает собственный listener, abort-ит активные команды и ждёт доступных исходов. Не удаляет команды и не отзывает токен. Повторный stop безопасен; повторное подключение — новым объектом. Standalone регистрация принимает собственный caller signal и не зависит от stop обработчика. Standalone Publisher управляется pipeline signal; interface.stop не останавливает его самостоятельно, общую последовательность остановки выполняет bootstrap. Новая команда после отключения не должна привести к pipeline-вызову.

### 9. Проверки и документы

Тесты — существующий node:test, временная настоящая Storage и публичный pipeline. Счётчики fake OpenDota/OpenRouter/Discord разделяются. SDK установлен и используется реально; подменяются HTTP makeRequest и interaction/client boundary, а не production-аналитик или публикационный журнал.

Проверить manifest/upsert без уничтожения чужой команды, Administrator runtime check, wrong guild/channel/DM/thread, ACK до network, duplicate interaction/постоянный requestId, timeout/failed reply после commit и отсутствие worker из команды. Readonly статус проверяет и текущую задачу, и result target, прежнюю версию и отсутствие OpenDota/MiMo/public POST.

Renderer fixtures: выбран один/два, обе стороны/исходы, недостаток данных, анонимный ник, переставленные slots, отсутствующий heroName, максимум 600-символьных claims, emoji, mentions, markdown/URL, invalid references/identity. Проверить individual/aggregate лимиты и неизменность исходного объекта.

Настоящий REST path: transport POST count <=1 при 429/5xx/network/abort; exact stored bytes, signal, headers, nonce; неправильный channel guild/type и invalid payload дают 0 POST. Протокол pipeline: accepted result → beginPublication → один HTTP POST → ID → succeeded; потеря ответа/поздний ID/reopen не повторяют сообщение. Никаких реальных токенов и сообщений при этих тестах.

README описывает создание Discord-приложения, scopes bot/applications.commands, минимальные права и intent, явную регистрацию/attach, приватные команды, experimental-метку и безопасную композицию. Реальная регистрация/login/send требует отдельного запроса пользователя и локального токена, который не запрашивается в чате. VERIFICATION фиксирует фактический Node/SQLite/SDK lock, focused/full/strict проверки, ENOTFOUND/EPERM и платформенные пробелы.

## Risks / Trade-offs

- [SDK повторяет отправку скрыто] → отдельный REST с retries=0 и rejectOnRateLimit, тест настоящего transport count для 429 и 5xx.
- [Неизвестная отправка или поздний ответ] → журнал pipeline и отсутствие repost; nonce только дополнительный короткий барьер.
- [Устаревшая цель в БД] → команды проверяют обе цели до показа, publisher не перенаправляет исходную цель.
- [Очередь живёт дольше interaction] → быстрый приватный ACK, job ID и отдельный status; публичный результат не зависит от webhook token.
- [Ник/модельная строка управляет разметкой] → экранирование, нейтрализация URL/mentions, explicit allowed_mentions и лимиты после очистки.
- [Потеря части текста при лимитах] → детерминированное сокращение с отметкой, выбор и минимум два основания остаются, полный анализ хранится прежним.
- [Experimental-пакет не откалиброван] → явная метка, отсутствие скрытой смены профиля или увеличения лимита; интерфейс не утверждает доказанность обвинения.
- [Registry или новые транзитивные engines] → exact SDK/lock и проверка baseline при установке, без молчаливого обновления Node. Реальный npm lock на этапе документов не проверен.

## Migration Plan

1. По отдельному запросу реализовать только модуль 6 и проверки, установить закреплённый SDK и lock. Из соседних общих файлов затрагиваются package/lock и строка модуля 6; контракты/миграции не меняются.
2. Выполнить offline интеграцию с поддельным HTTP и настоящей SQLite, typecheck, полный набор и strict OpenSpec. При Windows fs.link EPERM перепроверить файловую проверку с нужными разрешениями, не менять лабораторию.
3. Отдельно при разрешённой runtime-проверке caller загружает токен локально, создаёт/логинит Client, регистрирует guild-команды, создаёт Publisher/pipeline/interface и запускает их. Бюджет/live/automaticSince остаются в operations/pipeline.
4. Для остановки сначала прекратить новые команды, затем остановить pipeline, сохранить БД и закрыть caller-owned Client/Storage. Откат не удаляет jobs/receipts/сообщения и не повторяет известные публикации; удаление зарегистрированных команд выполняется только отдельным явным действием.
