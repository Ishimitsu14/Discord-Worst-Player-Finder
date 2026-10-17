# Проверки operations

Состояние на 17 октября 2026: реализация и настройка продолжаются. Спека прошла strict validation, публичный runtime/CLI и workflow подготовлены; готовность production пока не подтверждена. Секреты, IP и SSH-ключи в этот отчёт не включаются.

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

Локальный focused operations/delivery: 23 теста, 17 pass/6 skip. Дополнительные проверки используют реальную эксклюзивную блокировку SQLite для фатального Storage error, отказ второго copyFile для прерывания backup и дочерний CLI с подменой SDK/REST. Исходная БД/предыдущий backup сохраняются, manifest прерванной копии отсутствует, явная регистрация выполняет ровно три guild-запроса и безопасно сообщает partial. Signal child-process проверки выполняются только Linux; Windows process.kill не моделирует POSIX-сигналы. Test preload не входит в release.

## Подготовленный VPS

По SSH подтверждены Ubuntu 24.04.5 LTS x86_64, glibc 2.39, systemd 255.4, 34 GB свободного места. На VPS работают другие приложения; nginx/apache2/mysql после подготовки остаются active. Системный Node не устанавливался и не заменялся.

Установлен собственный официальный Node v22.23.3, SQLite 3.51.3; SHA256 архива `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de` совпадает с официальным SHASUMS256. Созданы отдельные runtime/deploy users и code group, root-owned runtime/base/helper/current; config/env/data недоступны deploy. Его home/.ssh/authorized_keys закреплены за root. Проверки доступа подтвердили отсутствие записи deploy в эти root-owned пути и чтения env/data.

SSH выделенным ключом успешно аутентифицируется, произвольная команда отвергнута forced receiver с кодом 64. Scoped sudo проверен через sudo -l и visudo. systemd-analyze verify успешен, unit disabled/inactive, TimeoutStopSec=75s, RestartPreventExitStatus=75/78. Бот, тесты и платная генерация на VPS не запускались.

Контрольные суммы установленных root-owned control/receive/unit совпадают с проверенным исходным кодом. Доступность SSH, установленные helper/unit и прохождение CI не означают, что runtime release уже доставлен либо бот подключён.

По явному разрешению пользователя новый ограниченный deploy-ключ и проверенный known_hosts сохранены в GitHub Secrets DEPLOY_SSH_KEY/DEPLOY_KNOWN_HOSTS. Variables host/user/port заданы, секреты проверены только по именам. Root SSH-ключ не передавался. До первого deploy DEPLOY_ENABLED=false.

Проверенный CI release 1969efe установлен выделенным receiver по SSH; digest/REVISION на VPS совпадают. Первая установка npm ci вернула 243 при отсутствующем cache внутри root-owned home; отдельный deploy-owned .npm (0700) подготовлен и добавлен в setup.sh. Повтор той же установки успешен, root-owned home/.ssh не меняли владельца. Receiver завершился configuration-required до переключения current/запуска unit. Это начальная подготовка, не успешный GitHub deployment.

Discord application/guild/channel проверены read-only API, токен не выводился. Runtime env и public JSON помещены вне release с root:worst-player 0640. От app-user явно выполнены check/init: создана новая БД/state (0600), автоматическая граница null. register-commands вернул complete для worst/worst-status/worst-reanalyze; сообщений не отправляли. Unit пока disabled/inactive, первый start ожидает доставку через Actions.

Первый полный [CI/CD run](https://github.com/Ishimitsu14/Discord-Worst-Player-Finder/actions/runs/39023653500) для `2e9e3e75127a0ecb23c7b580b4e51c8b36b50fa2`: checks/release успешны, deploy failed из-за startup-failed, unit после трёх ограниченных рестартов failed. Env передан без изменений, DB/state сохранены. На production выполнялись только штатная доставка и чтение unit/status/revision/log codes.

Причина воспроизведена локальным подключением реального discord.js 14.27.0: после await login isReady=false, затем ClientReady и isReady=true. SDK Client.login ждёт ws.connect, а ClientReady приходит отдельно после готовности guilds/shards. Runtime теперь подписывается до login и ожидает готовность внутри общего startup timeout, удаляя listener при любом исходе. Два новых regression tests проверяют отсутствие discovery/команд/активации до ready и timeout/cleanup при отсутствующем ready. Полный локальный набор после исправления — 315 pass/6 skip из 321; исправленная production revision ещё ожидает CI/CD.

## Границы проверки

Unit/integration тесты используют fake Client/REST; реальное локальное Gateway подключение и регистрация команд на VPS подтверждены отдельно. Production ready после исправления ещё ожидается. Реальные сообщения и качество MiMo не проверялись. Prepare-only/manual — defaults, live требует новых явных budgets/key/experimental. Лабораторный лимит не переносился.

Cold backup требует внешней остановки и общей Linux блокировки; API не доказывает отсутствие произвольных сторонних писателей. Manifest записывается последним, restore не выполняется автоматически. После старой копии нужна сверка внешних эффектов. Тесты shutdown не обещают сохранить ответ после принудительного завершения процесса.

## Сверка requirements

| Требования operations | Код / свидетельство |
|---|---|
| Приватная история исходников | GitHub API isPrivate, main/origin, начальный push, проверка staged paths/credential formats и ignore |
| Явная конфигурация, check без эффектов, init без перезаписи | config.ts/state.ts/CLI, strict config/load/check/init tests; production JSON вне Git прошёл offline check |
| Постоянная automaticSince и допуск live | activation/reopen/disable/enable/write-failure tests; defaults manual/prepare-only, live key/budgets/experimental validation |
| Сборка после ready, явная регистрация | runtime fake Client startup/timeout/cleanup, CLI fake REST complete/partial, Linux child start без регистрации |
| Остановка и безопасные ошибки | grace/deadline/late ID, SQLite exclusive contention, SDK exception, повтор stop и Linux repeated signals |
| Проверяемая готовность версии | fresh/stale/dead PID/extra-field tests, безопасный billing; реальный production ready ещё не подтверждён |
| Проверки до доставки и доверенная main | успешный Windows/Linux CI, закреплённые actions, needs всех checks, main/non-PR gates и отдельная concurrency без cancel |
| Артефакт без рабочих данных | allowlist tests, exact digest/revision скачанного CI archive, извлечённый production install/check |
| Изолированный сервис, единственный процесс, restart | SSH inventory/permissions/forced key/helper hashes, visudo/systemd-analyze verify; Linux flock conflict/reacquire; unit grace 75s и prevent 75/78 |
| Откат кода сохраняет данные | Linux receiver fault tests: прежний current и data sentinel сохранены, failed deploy ненулевой; реальный production rollback не выполнялся |
| Backup и восстановление | копия открывается публичным Storage; second copyFile failure не создаёт manifest/не меняет source/предыдущий backup; runbook stop/lock/restore/external-effect reconciliation |
| Честное подтверждение deployment | этот отчёт разделяет CI/release, подготовку VPS и ещё не выполненные secrets/delivery/init/register/ready; production unit/integration тесты не выполняются |

## Ещё не подтверждено

- Первая успешная доставка через GitHub Actions и fresh production health нужной revision; config/env/init/register готовы, unit пока не запущен.
- Реальный service restart/backup на обновлении. Production rollback не инициируется ради теста; его fault-сценарий проверен в Linux CI.
- Реальные сообщения, платный анализ и калибровка MiMo не проверялись и не включались.
