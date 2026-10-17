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
| Новый operations runtime/config/CLI | 12 тестов: config, live opt-in, init/state/cutoff, backup, ready/status, startup error/timeout, safe fatal, grace/deadline и поздний ID |
| Runtime artifact | 2 теста: allowlist, exact digest/revision, отказ плохому SHA и перезаписи |
| Полный npm.cmd test с обычными локальными правами | 310/310 до добавления трёх Linux-only deploy-сценариев |
| Bash syntax receive/control | проверка запускается локально с обычными правами и в Linux release job |
| openspec.cmd validate add-operations --type change --strict --no-interactive | успешно |

Windows sandbox запрещает msys namespace и rename временного JSON: первичный focused дал write-error, с обычными правами init/state/runtime проходят. Ограничение не обходится неатомарной записью. Временные БД/архивы очищаются; в тестах нет реальных bot/OpenRouter/OpenDota ключей и платных API.

Дополнены Linux-only тесты delivery: реальный flock с конфликтом второго процесса и освобождением после завершения, tar/checksum/staging, fake NPM/control/systemctl boundary, успешная смена кода, возврат прежнего current при health failure и отказ некорректному архиву до управляющих действий. Они выполняются в Linux CI, а Windows явно пропускает эти четыре сценария. Их результат ещё нужно подтвердить новым GitHub run.

## Подготовленный VPS

По SSH подтверждены Ubuntu 24.04.5 LTS x86_64, glibc 2.39, systemd 255.4, 34 GB свободного места. На VPS работают другие приложения; nginx/apache2/mysql после подготовки остаются active. Системный Node не устанавливался и не заменялся.

Установлен собственный официальный Node v22.23.3, SQLite 3.51.3; SHA256 архива `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de` совпадает с официальным SHASUMS256. Созданы отдельные runtime/deploy users и code group, root-owned runtime/base/helper/current; config/env/data недоступны deploy. Его home/.ssh/authorized_keys закреплены за root. Проверки доступа подтвердили отсутствие записи deploy в эти root-owned пути и чтения env/data.

SSH выделенным ключом успешно аутентифицируется, произвольная команда отвергнута forced receiver с кодом 64. Scoped sudo проверен через sudo -l и visudo. systemd-analyze verify успешен, unit disabled/inactive, TimeoutStopSec=75s, RestartPreventExitStatus=75/78. Бот, тесты и платная генерация на VPS не запускались.

Новый приватный deploy-ключ остаётся только локально. Автоматическая проверка разрешений отклонила его отправку в GitHub Secrets до явного разрешения пользователя; отклонённая команда не выполнялась. Root SSH-ключ не передавался. Application ID и channel ID получены, guild ID и локальный env-файл ещё требуются.

## Границы проверки

Runtime действительно собирает публичные модули, но Client login и REST в тестах поддельные; реальный gateway/регистрация/сообщения и качество MiMo не проверены. Prepare-only/manual — defaults, live требует новых явных budgets/key/experimental. Лабораторный лимит не переносился.

Cold backup требует внешней остановки и общей Linux блокировки; API не доказывает отсутствие произвольных сторонних писателей. Manifest записывается последним, restore не выполняется автоматически. После старой копии нужна сверка внешних эффектов. Тесты shutdown не обещают сохранить ответ после принудительного завершения процесса.

## Ещё не подтверждено

- Новый полный CI после исправления race и добавления runtime/release, проверка production install извлечённого артефакта и успешная загрузка artifact.
- Реальные service restart/backup/rollback; базовая установка, права и systemd-analyze verify подтверждены выше.
- Scoped deploy key/known_hosts и GitHub secrets/vars; DEPLOY_ENABLED не включён. Подготовленный deploy job ещё не означает действующую доставку.
- Реальные Discord application/guild/channel/settings/token, явные init/register/start и fresh production health нужной revision. Ключи в чат не запрашиваются.
- Signal CLI child-process и полный Storage-fatal fault matrix, отказ записи backup посреди копирования и полный requirement-to-test audit ещё требуют завершения перед отметкой всего модуля готовым.
