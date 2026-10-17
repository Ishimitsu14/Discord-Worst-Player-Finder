## Production: авторазбор новых матчей — 18 октября 2026

[PR №2](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/pull/2) объединён fast-forward с main: проверенный и установленный SHA `5fa610aebbb5ee93b4b25ca6045166471b212c0e`. [Feature release CI 39067542560](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39067542560), [PR CI 39067543208](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39067543208) и [main CI/CD 39068184254](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39068184254) успешны. Typecheck/build и production install/check успешны. Обе Linux-конфигурации (Node 22.14.0/22.23.3) — 495/495; Windows/22.14.0 — 489 pass/6 Linux-only skip/0 fail. Strict OpenSpec — 15/15. Проверка 299 файлов по известным шаблонам секретов/приватных путей не нашла совпадений; это ограниченная проверка шаблонов.

[Main-артефакт](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39068184254/artifacts/12114720183) скачан независимо: 129 записей, REVISION/состав/зафиксированные prompt и словари сверены с Git; SHA256 `0422bc6bd0132d062c5963b3074be43ad17b940b2fedb9da4675fd9698887f4d` совпадает с checksum и установленным .artifact-sha256. Unit active/enabled, status ready/discordReady=true, SQLite остаётся схемы 3. Тестовая Gateway-копия остановлена до доставки; три guild-команды зарегистрированы для рабочего сервера. Секреты перенесены через SSH stdin в приватный env без вывода значений; bot token и group-settings сохранили контрольные суммы.

Настройки production: Gemini/Steam, pollIntervalMs=60000, automatic=true, live, allowExperimental=true, publicationMode=on-command; guild 498979597153730560, channel 1314691959042080888, девять Steam32. Пользователь явно снял денежный лимит для постоянной работы; оба обязательных конечных числовых потолка установлены в максимальное представимое значение. Неизвестные расходы по-прежнему требуют штатной сверки.

Первое включение сохранило постоянную automaticSince=`1792270545647` (`2026-10-17T20:55:45.647Z`, 18 октября 2026 г. в 01:55:45 Asia/Yekaterinburg). В анализ допускается только строго более позднее завершение матча; state/DB не пересоздавались. Read-only после активации: oldAnalyzed=0, matches/jobs/artifacts/external_attempts=70/0/0/0; группы обнаружения: `[{"count":10,"reason":"outside-window","state":"ignored"},{"count":60,"reason":null,"state":"pending"}]`. Known cost/reserve/unknown/uncovered unknown=0/0/0/0. Автоматический valid сохраняется без сообщения; /worst публикует готовый результат, /worst-status только читает.

Первый штатный опрос завершился: `{"accountsChecked":9,"candidates":70,"checks":10,"code":"discovery","errors":5,"pages":4,"partial":true,"pending":60,"queued":0,"rejected":10,"timestamp":"2026-10-17T20:55:52.755Z"}`. Steam отдал историю четырёх из девяти аккаунтов, для пяти вернул history-private; ready не означает полного покрытия компании. Игры, отсутствующие в доступных историях, могут пропускаться. Чтение ограничено одной страницей по 20 матчей на аккаунт и 10 подтверждениями OpenDota за цикл; записи matches/discovery — метаданные поиска, а не задачи/платный анализ старой истории.

По решению пользователя новая копия не создавалась: разовый пропуск receiver был ограничен только SHA 5fa610a; штатный root-owned receiver восстановлен (SHA256 `2d9f70643d0427949f716587140978f56f911d0c6a1106696ab177dc02211a07`, root, 0755). Состав прежних двух копий совпал до/после; nginx/apache2/mysql остаются active. На production выполнялись доставка, config check, включение штатной работы и read-only status/revision/checksum/метаданные. Тестовые production-генерации и сообщения не создавались. Следующий естественный матч и ручная публикация нового auto-результата на VPS ещё не наблюдались; это не калибровка качества. Ниже — исторические протоколы предыдущих этапов.

## Сквозной тест приложения в тестовом Discord — 18 октября 2026

Проверен штатный operations runtime на Windows / Node.js 22.14.0 с отдельными локальными настройками и постоянной тестовой SQLite схемы 3. Guild-команды зарегистрированы явно, доступ к каналу и ViewChannel/SendMessages/EmbedLinks подтверждены через Discord API. Пользователь вызвал `/worst match_id:9048915444`: приложение определило Dire по двум аккаунтам компании, приняло задачу, получило valid Gemini v2, сохранило результат и опубликовало один embed. В рабочие и тестовые group-settings внесён присланный пользователем список из девяти Steam32 ID; это штатный JSON настроек, а не отдельная таблица аккаунтов.

Одна попытка анализа: 6085 prompt tokens, 682 completion tokens, 6767 total; первый контент через 2.943 с, полный ответ за 7.862 с, подтверждённая стоимость **$0.00712125**. Задача succeeded, обе внешние попытки analysis/publication finished, неизвестных исходов и резервов нет. GET опубликованного сообщения подтвердил канал, автора и embed. Повторная настоящая slash-команда вернула тот же job/result: одна задача, одна генерация и одна публичная публикация; стоимость не изменилась. Запросов parse и поиска Steam не потребовалось. Это сквозная проверка одного матча, а не калибровка качества модели.

Первая команда была отклонена конкурирующей VPS-копией с тем же bot token и другой целью; тестовая копия получила ack-failed до постановки задачи и платного запроса. Для продолжения рабочий unit временно остановлен: для одного токена в этом проекте проверяется только одна активная Gateway-копия. После теста восстановление VPS до active/ready и сохранность пустой рабочей БД проверены отдельно; дальнейшее оформление embed идёт отдельным тестовым этапом на сохранённом результате. Приватные настройки, БД, API receipts и эксперименты оформления находятся только в игнорируемой `.local/`.

## Доставка Steam/Gemini — 18 октября 2026

[PR №1](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/pull/1) объединён fast-forward с main без изменения проверенного SHA `9d0aca623703e4628901fe734a42e739f435de6a`. [Main CI/CD 39063354939](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39063354939) полностью успешен: Windows и обе Linux-конфигурации, release/production install/check и deploy. Исходный код не менялся после успешных release/PR CI этой же ревизии.

[Production-артефакт](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39063354939/artifacts/12111469771) скачан отдельно: 128 записей, REVISION и состав сверены с Git. SHA256 release.tar.gz `870a9cd935fb156385a63fa08f342870865d2e02ad31ddf88b1c7fcfdae4e7fa` совпадает с checksum архива и .artifact-sha256 на VPS. Сервис active/enabled, status ready/discordReady=true, revision совпадает, Node v22.23.3; SQLite перешла с 1 на 3. Настроены analysisProfile=gemini, historySource=steam, pollIntervalMs=60000, automatic=false, mode=prepare-only, allowExperimental=false. Gateway подключён; это готовность сервиса, не проверка live-разбора.

По явному решению пользователя этот выпуск выполнен **без новой резервной копии**. Перед выпуском read-only подтверждены пустая БД и нулевые расходы. В установленном root-owned receiver пропуск был ограничен только SHA 9d0aca6; CD-журнал содержит backup-skipped-for-authorized-release и deployment-ready. После доставки установлен штатный receiver из проверенного commit: SHA256 `2d9f70643d0427949f716587140978f56f911d0c6a1106696ab177dc02211a07`, root:root, 0755. Разовый пропуск удалён; постоянная политика backup не отключалась. Состав каталога прежних двух копий до/после совпадает, новая копия не создана.

Финальная read-only сверка: state/env/group-settings имеют прежние контрольные суммы, automaticSince осталась null, matches/jobs/artifacts/external_attempts — по 0. knownCostUsd/reservedCostUsd/unknownCount/uncoveredUnknownCount — 0. nginx/apache2/mysql остаются active. Рабочий public service config переключён на указанный профиль; секреты не переносились и не менялись. Steam-ключ можно обновить отдельно перед включением автоматического опроса.

На production выполнялись доставка, offline config check и чтение status/unit/revision/checksums/метаданных SQLite. Новые unit/integration тесты, реальные Steam/OpenDota запросы, платные генерации и сообщения не запускались. Ручной live smoke, бюджет, автоматический режим, management key и калибровка остаются отдельными этапами. Без сохранённой до миграции копии прежний код схему 3 не прочитает; при необходимости потребуется исправление нового релиза либо отдельно согласованная повторная инициализация. Ниже сохранены исторические протоколы подготовки и предыдущих выпусков.

## Подготовка релиза Steam/Gemini — 18 октября 2026

Для `17f5a0b9308e67f0710449e39a836a5c98c7cd49` успешно завершён [CI 39061259857](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39061259857): Ubuntu/Node 22.14.0 и 22.23.3 — 487/487, Windows/22.14.0 — 481 pass/6 Linux-only skip/0 fail. Typecheck, сборка, Bash syntax, распакованный production install/check и upload успешны. Deploy пропущен: workflow_dispatch выполнен на `feat/steam-gemini-release`. [Draft PR №1](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/pull/1) не объединён с main.

Скачанный CI-артефакт содержит 128 записей; REVISION совпадает с указанным SHA. SHA256 самого release.tar.gz: `e15762c9363fb3fec950e0a2bb972af3f891fc581a5a189517e3f27435a64c35`, совпадает с приложенным checksum. Оба семейства/версии prompt, словари, receiver и lock сверены с точными байтами Git commit; рабочих ключей/БД/настроек браузера/тестов в архиве нет. Локальная проверка 292 отслеживаемых и включаемых файлов не нашла известных форматов ключей или приватных путей; это проверка известных шаблонов, а не доказательство отсутствия любых секретов.

При ревью подготовки добавлены исключение .playwright-mcp из Git и workflow_dispatch-сборка артефакта в отдельной ветке. Проверка условий workflow подтверждает: ветка может собирать release, PR не доставляет, deploy требует main и DEPLOY_ENABLED=true. В runbook добавлена проверка установленного root-owned receiver: его прежняя allowlist не принимает hero-metrics-v1.json, а файл из архива не обновляет SSH entrypoint.

Отдельный [PR-прогон 39061363907](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39061363907) той же ревизии выявил Windows timeout одного crash-теста publication-saved: дочерний процесс не достиг контрольной точки за 15 секунд. В успешном release-прогоне все crash-сценарии прошли. Тестовый deadline увеличен до 60 секунд без повторов, пропуска SIGKILL или изменения проверок сохранённого журнала/дедупликации; production-код не менялся. Последующие CI-результаты относятся к новым SHA и указаны в PR, результат 17f5a0b выше не подменяет их.

VPS, установленный receiver/config, секреты, рабочая БД, платные вызовы и реальные сообщения этим этапом не проверялись и не изменялись. Перед merge/delivery требуется сверить/обновить receiver, затем сделать cold backup старым current до первого открытия БД новым кодом. Первая настройка остаётся manual/prepare-only; live-бюджет, отдельный ручной smoke и automatic согласуются отдельно. Результаты выше относятся к точной ревизии 17f5a0b; ниже сохранены исторические протоколы.

## Gemini runtime — 17 октября 2026

Финальный локальный прогон: Windows / Node.js 22.14.0; typecheck/build успешны; npm test — 486 тестов, 480 pass, 6 Linux-only skip, 0 fail. Strict OpenSpec и git diff --check успешны; проверка изменённых исходников/документов не нашла секретов. Offline production install/check артефакта прошёл. Linux/CI/VPS текущего diff не запускались.

Оба prompt family/словаря и отдельный management key проходят CLI→runtime. Bad materials останавливают запуск до DB/Gateway/активации; проверены разделение transport keys, старый/новый health v1, сохранение activation и безопасные агрегаты. Распакованный артефакт прошёл offline npm ci --omit=dev/check, исключает dev dependencies/рабочие данные; corrupt/missing словарь даёт CLI exit 78 без dataDir/сети (operations.test.ts, operations-delivery.test.ts).

[Полный локальный протокол](../match-pipeline/VERIFICATION.md). Реальные платные/Discord/VPS-вызовы, Linux/CI текущего diff и калибровка не выполнялись; ниже исторические результаты прежних этапов.

# Проверки operations

Дополнение `add-steam-match-discovery`, 17 октября 2026: два новых сценария в operations.test.ts прошли с fake Gateway/fetcher/clock и настоящей временной SQLite. Проверены отсутствие ключа до login/активации/сети, manual-only без Steam-ключа, закрытая конфигурация и безопасный пример, сохранение прежней automaticSince при смене источника, независимый cooldown OpenDota при продолжающемся Steam-опросе и безопасные агрегаты/приватный отказ. ready не объявляет полное покрытие. На Windows sandbox блокирует fs.link атомарного состояния; повтор focused-проверок с разрешением файловых операций прошёл. Production/VPS/секреты этим изменением не затрагивались; ниже — исторический протокол прежнего релиза, не подтверждение доставки текущего кода. Linux-матрица в service.yml существует; локальные изменения ещё не проверены на CI/Linux.

Итог локального полного прогона со Steam-изменением: typecheck/build успешны; 426 тестов, 420 pass/6 Linux-only skip/0 fail. Strict OpenSpec успешен. Linux/deploy текущего diff не запускались; схема 2 требует backup старым релизом до первого открытия новым кодом.

Историческое состояние до Steam-изменения, 17 октября 2026: 24/24 задач operations реализованы и проверены. Приватный GitHub, Windows/Linux CI, release и доставка на VPS работают; production ready подтверждён для проверенной revision. Секреты, IP и SSH-ключи в этот отчёт не включаются.

## Репозиторий и первый CI

- Создан [приватный репозиторий](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder); `isPrivate=true`, main/origin подтверждены API.
- Начальный commit `8ec66ff6add8e4b09d00e848fa402e1e5858d6b1`: 183 файла, индекс проверен на рабочие ключи/БД/.local/.codex/.agents/node_modules/dist; совпадений форматов секретов нет. Ignore проверен командой git check-ignore.
- [Первый CI](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39020563399): Ubuntu/Node 22.14.0 и 22.x — успешно, Windows/22.14.0 — 295/296. Причина: существующий race-тест захвата позволял одному процессу начать транзакцию до завершения openStorage второго; допустимый busy срывал проверку владельцев.
- В test/storage-crash.test.ts и test/storage-worker.ts добавлен IPC-барьер после открытия обеих БД и перед race claim/revision. Реальные процессы продолжают конкурировать за задачу/ревизию; исходники/контракт хранилища и внутренние повторы не менялись.

## Локально подтверждено

Windows x64, Node v22.14.0, SQLite 3.47.2, discord.js 14.27.0/REST 2.6.3. Node engines и зависимости не менялись; package scripts дополнены start/service.

| Проверка | Результат |
|---|---|
| npm.cmd run typecheck / build | успешно |
| Новый operations runtime/config/CLI | 19 тестов: config, live opt-in, init/state/cutoff, backup/fault, ready/status, отложенный/отсутствующий ClientReady, startup error/timeout, safe fatal/SQLite busy, grace/deadline/поздний ID, CLI fake REST и Linux signals |
| Runtime artifact | 2 теста: allowlist, exact digest/revision, отказ плохому SHA и перезаписи |
| Полный npm.cmd test с обычными локальными правами | 321 тест: 315 pass, 6 Linux-only skip, 0 fail |
| Bash syntax receive/control | проверка запускается локально с обычными правами и в Linux release job |
| openspec.cmd validate add-operations --type change --strict --no-interactive | успешно |

Windows sandbox запрещает msys namespace и rename временного JSON: первичный focused дал write-error, с обычными правами init/state/runtime проходят. Ограничение не обходится неатомарной записью. Временные БД/архивы очищаются; в тестах нет реальных bot/OpenRouter/OpenDota ключей и платных API.

Дополнены Linux-only тесты delivery: реальный flock с конфликтом второго процесса и освобождением после завершения, tar/checksum/staging, fake NPM/control/systemctl boundary, успешная смена кода, возврат прежнего current при health failure и отказ некорректному архиву до управляющих действий. Они выполняются в Linux CI, а Windows явно пропускает эти четыре сценария.

Для commit `fdc9fdba6600a1015f557417c197a227f8ea3fb9` в [CI](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39022637093) успешны все три jobs (Windows, Linux Node 22.14.0/22.23.3), включая четыре Linux delivery-сценария, и release с распакованным production install/check. Deploy штатно skipped до первоначальной настройки. Скачанный CI archive проверен отдельно: SHA256 `8b2461978ac162a2e7aeeb8ef8dad436922a8406b09e601a7713504043e6e6ac`, правильный REVISION, 91 запись без рабочих секретов/БД/тестов.

Финальный набор для `1969efe60886599dc7afaffa0fdb3f7bacc492f8` в [CI](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39022904299) тоже успешен: Linux Node 22.14.0 и 22.23.3 — 319/319, Windows — 313 pass/6 Linux-only skip. SIGINT/SIGTERM child tests и все delivery/fault сценарии подтверждены. Release/extracted production install/check/upload успешны. SHA256 скачанного артефакта `2a5a1dbbf4b447ef6b765a4f3c019d4c54b190a5479d0c240206c8bba1594f8b` и REVISION совпадают.

До исправления ClientReady локальный focused operations/delivery: 23 теста, 17 pass/6 skip. Дополнительные проверки используют реальную эксклюзивную блокировку SQLite для фатального Storage error, отказ второго copyFile для прерывания backup и дочерний CLI с подменой SDK/REST. Исходная БД/предыдущий backup сохраняются, manifest прерванной копии отсутствует, явная регистрация выполняет ровно три guild-запроса и безопасно сообщает partial. Signal child-process проверки выполняются только Linux; Windows process.kill не моделирует POSIX-сигналы. Test preload не входит в release.

## Подготовленный VPS

По SSH подтверждены Ubuntu 24.04.5 LTS x86_64, glibc 2.39, systemd 255.4, 34 GB свободного места. На VPS работают другие приложения; nginx/apache2/mysql после подготовки остаются active. Системный Node не устанавливался и не заменялся.

Установлен собственный официальный Node v22.23.3, SQLite 3.51.3; SHA256 архива `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de` совпадает с официальным SHASUMS256. Созданы отдельные runtime/deploy users и code group, root-owned runtime/base/helper/current; config/env/data недоступны deploy. Его home/.ssh/authorized_keys закреплены за root. Проверки доступа подтвердили отсутствие записи deploy в эти root-owned пути и чтения env/data.

SSH выделенным ключом успешно аутентифицируется, произвольная команда отвергнута forced receiver с кодом 64. Scoped sudo проверен через sudo -l и visudo. systemd-analyze verify успешен, при подготовке unit disabled/inactive, TimeoutStopSec=75s, RestartPreventExitStatus=75/78. Unit/integration тесты и платная генерация на VPS не запускались.

Контрольные суммы установленных root-owned control/receive/unit совпадают с проверенным исходным кодом. Доступность SSH, установленные helper/unit и прохождение CI не означают, что runtime release уже доставлен либо бот подключён.

По явному разрешению пользователя новый ограниченный deploy-ключ и проверенный known_hosts сохранены в GitHub Secrets DEPLOY_SSH_KEY/DEPLOY_KNOWN_HOSTS. Variables host/user/port заданы, секреты проверены только по именам. Root SSH-ключ не передавался. До первого deploy DEPLOY_ENABLED=false.

Проверенный CI release 1969efe установлен выделенным receiver по SSH; digest/REVISION на VPS совпадают. Первая установка npm ci вернула 243 при отсутствующем cache внутри root-owned home; отдельный deploy-owned .npm (0700) подготовлен и добавлен в setup.sh. Повтор той же установки успешен, root-owned home/.ssh не меняли владельца. Receiver завершился configuration-required до переключения current/запуска unit. Это начальная подготовка, не успешный GitHub deployment.

Discord application/guild/channel проверены read-only API, токен не выводился. Runtime env и public JSON помещены вне release с root:worst-player 0640. От app-user явно выполнены check/init: создана новая БД/state (0600), автоматическая граница null. register-commands вернул complete для worst/worst-status/worst-reanalyze; сообщений не отправляли. После подготовки unit оставался disabled/inactive до доставки через Actions.

Первый полный [CI/CD run](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39023653500) для `2e9e3e75127a0ecb23c7b580b4e51c8b36b50fa2`: checks/release успешны, deploy failed из-за startup-failed, unit после трёх ограниченных рестартов failed. Env передан без изменений, DB/state сохранены. На production выполнялись только штатная доставка и чтение unit/status/revision/log codes.

Причина воспроизведена локальным подключением реального discord.js 14.27.0: после await login isReady=false, затем ClientReady и isReady=true. SDK Client.login ждёт ws.connect, а ClientReady приходит отдельно после готовности guilds/shards. Runtime теперь подписывается до login и ожидает готовность внутри общего startup timeout, удаляя listener при любом исходе. Два новых regression tests проверяют отсутствие discovery/команд/активации до ready и timeout/cleanup при отсутствующем ready. Полный локальный набор после исправления — 315 pass/6 skip из 321.

## Успешный production запуск

[CI/CD run 39024302798](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39024302798) для `cc7485750900509676d7811438b936e8a639e2f0` полностью успешен: Windows/Linux checks, release и deploy (27 секунд). Исправление прошло все обязательные проверки перед доставкой.

Скачанный CI archive и установленный release совпадают по SHA256 `4362ce181494f14365b4e24c73b29d0b99e11ca3a1851de058e67e14b851f89f`; current/REVISION указывают на cc7485750900509676d7811438b936e8a639e2f0. Unit active/running, NRestarts=0; после подтверждения ready включён автозапуск, UnitFileState=enabled.

Штатный local status: phase=ready, discordReady=true, mode=prepare-only, automatic=false, knownCostUsd=0, unknownCount=0, свежий timestamp и живой PID. Discord channel permissions ViewChannel/SendMessages/EmbedLinks проверены read-only с учётом ролей и overwrites. Автоматическая граница остаётся null. При доставке создан cold backup; SHA256 исходного operations-state.json и его backup совпадают. Чужие nginx/apache2/mysql остаются active.

## Границы проверки

Unit/integration тесты используют fake Client/REST; реальное локальное Gateway подключение, регистрация команд на VPS и production ready подтверждены отдельно. Реальные сообщения и качество MiMo не проверялись. Prepare-only/manual — defaults, live требует новых явных budgets/key/experimental. Лабораторный лимит не переносился.

Cold backup требует внешней остановки и общей Linux блокировки; API не доказывает отсутствие произвольных сторонних писателей. Manifest записывается последним, restore не выполняется автоматически. После старой копии нужна сверка внешних эффектов. Тесты shutdown не обещают сохранить ответ после принудительного завершения процесса.

## Сверка requirements

| Требования operations | Код / свидетельство |
|---|---|
| Приватная история исходников | GitHub API isPrivate, main/origin, начальный push, проверка staged paths/credential formats и ignore |
| Явная конфигурация, check без эффектов, init без перезаписи | config.ts/state.ts/CLI, strict config/load/check/init tests; production JSON вне Git прошёл offline check |
| Постоянная automaticSince и допуск live | activation/reopen/disable/enable/write-failure tests; defaults manual/prepare-only, live key/budgets/experimental validation |
| Сборка после ready, явная регистрация | runtime fake Client startup/timeout/cleanup, CLI fake REST complete/partial, Linux child start без регистрации |
| Остановка и безопасные ошибки | grace/deadline/late ID, SQLite exclusive contention, SDK exception, повтор stop и Linux repeated signals |
| Проверяемая готовность версии | fresh/stale/dead PID/extra-field tests, безопасный billing; реальный production ready нужной revision подтверждён |
| Проверки до доставки и доверенная main | успешный Windows/Linux CI, закреплённые actions, needs всех checks, main/non-PR gates и отдельная concurrency без cancel |
| Артефакт без рабочих данных | allowlist tests, exact digest/revision скачанного CI archive, извлечённый production install/check |
| Изолированный сервис, единственный процесс, restart | SSH inventory/permissions/forced key/helper hashes, visudo/systemd-analyze verify; Linux flock conflict/reacquire; unit grace 75s и prevent 75/78 |
| Откат кода сохраняет данные | Linux receiver fault tests: прежний current и data sentinel сохранены, failed deploy ненулевой; реальный production rollback не выполнялся |
| Backup и восстановление | копия открывается публичным Storage; second copyFile failure не создаёт manifest/не меняет source/предыдущий backup; runbook stop/lock/restore/external-effect reconciliation |
| Честное подтверждение deployment | этот отчёт разделяет CI/release, подготовку VPS и успешные secrets/delivery/init/register/ready; production unit/integration тесты не выполняются |

## Ещё не подтверждено

- Production rollback и reboot VPS не инициировались ради проверки; rollback проверен fault-сценарием Linux CI, автозапуск подтверждён enabled unit.
- Реальные сообщения, платный анализ и калибровка MiMo не проверялись и не включались.
