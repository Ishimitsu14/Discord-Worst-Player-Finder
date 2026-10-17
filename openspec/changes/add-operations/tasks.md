# Tasks

## 1. Приватный репозиторий и CI

- [x] 1.1 Создать private GitHub repo, инициализировать main/origin, проверить ignore и индекс на секреты/БД/локальные данные; подтвердить isPrivate и начальный commit/push.
- [ ] 1.2 Добавить GitHub Actions npm ci/typecheck/full test на Windows и Linux с закреплёнными actions и Node >=22.14; проверить успешные jobs на GitHub без runtime ключей.
- [x] 1.3 Описать импорт, проверки и границы CI в корневом README; сверить команды с package scripts и workflow, записать SHA/run URL в отчёте.

## 2. Конфигурация и постоянные данные

- [x] 2.1 Создать публичный operations/index с безопасными ошибками, строгим config v1 и загрузкой публичных settings/prompt/dictionary; тестами проверить unknown/type/path/secret ошибки и отсутствие действий при импорте.
- [x] 2.2 Реализовать check и явную передачу env-секретов с prepare-only/manual defaults; проверить отсутствие сети/создания БД и отказы live без ключа/budgets/experimental; добавить пустые env и service config examples с инструкцией.
- [x] 2.3 Реализовать отдельный init без перезаписи и обязательность пары DB/state для start; тестами подтвердить повтор init, пропавшую БД, повреждённое/несовместимое состояние и сохранение исходных данных.
- [x] 2.4 Сохранять automaticSince атомарно до первого discover, переиспользовать после restart/disable/enable; тестом reopen и отказа записи подтвердить отсутствие сканирования с новой/несохранённой границей, описать перенос данных.

## 3. Сборка, управление и диагностика

- [x] 3.1 Собрать готовые public модули в один foreground runtime после Discord ready; fake Client/HTTP и временная Storage должны подтвердить один listener/run, startup timeout и очистку частично созданных ресурсов без запросов worker до ready.
- [ ] 3.2 Реализовать идемпотентную остановку/фатальную ошибку и учёт pending publisher Promise с grace; тестами проверить поздний ID до close, hanging transport/deadline, Storage error, повтор сигнала и отсутствие нового POST.
- [x] 3.3 Реализовать JSONL logger и fresh local status с revision/mode/readiness и расходами из публичного Storage; тестами проверить stale/failed status, raw secret exception и отсутствие API/генерации при чтении; описать диагностику.
- [ ] 3.4 Подключить CLI check/init/start/status/register-commands/backup и npm scripts; дочерним процессом проверить help/bad args/exit codes/сигналы, явную регистрацию fake REST и отсутствие авто-регистрации на start.
- [ ] 3.5 Реализовать cold backup DB/state с digest manifest last без перезаписи; тестом повреждения/ошибки копирования и открытия копии подтвердить целостность, написать runbook stop/lock/restore отдельно и обязательную сверку внешних эффектов после старого backup.

## 4. Linux release и systemd

- [x] 4.1 Проверить по SSH ОС/architecture/runtime/сервисы/диск указанного VPS; записать безопасную инвентаризацию, выбрать изолированный Node 22 patch и проверить официальный SHA256 без замены системного Node.
- [x] 4.2 Подготовить отдельные app/deploy users, каталоги release/data/config и scoped SSH/sudo; убедиться, что root key не загружен в GitHub, другой сервис/права не изменены; описать первоначальную настройку.
- [ ] 4.3 Создать systemd unit и общий flock wrapper для start/backup; Linux-проверкой подтвердить конфликт второго процесса до действий, restart без stale lock и systemd-analyze verify, соразмерность grace/TimeoutStopSec и отказ рестартов configuration error.
- [ ] 4.4 Создать allowlist-пакетирование Linux runtime artifact с REVISION/digest; проверить tar inventory без тестов/секретов/БД и успешный offline check распакованной сборки.
- [ ] 4.5 Реализовать deploy helper: staging release, production lock deps, offline check, stop своего unit, backup, атомарный current, запуск и health нужной revision; локальной Linux sandbox/поддельным systemctl проверить happy path и отказ до переключения.
- [ ] 4.6 Реализовать code rollback при провале health с той же БД; fault тестом подтвердить возврат прежнего release, ненулевой deploy и неизменность receipts/data; описать ручной rollback и ошибку отсутствующей runtime-конфигурации.

## 5. GitHub CD и реальная доставка

- [ ] 5.1 Подключить deploy main после всех CI jobs, manual main, отдельную concurrency без прерывания, contents:read, SSH known_hosts pin и scoped deploy key; проверить условия PR/main, YAML/shell и отсутствие секретов в артефакте/логах.
- [ ] 5.2 Задать GitHub deploy secrets/vars из локальных файлов и параметров VPS без вывода значений; gh secret/variable list должен подтвердить только имена, SSH deploy user — ограниченные права.
- [ ] 5.3 Выполнить commit/push и успешную доставку проверенной revision через GitHub Actions; подтвердить run URL, artifact digest, release/current и unit на VPS без unit/integration тестов, платной генерации или тестового сообщения на production.
- [ ] 5.4 Загрузить локальные Discord/config/env, явно init/register/start при наличии доступа; подтвердить fresh ready/revision и prepare-only/manual, без выдуманного успеха при missing config/секретах и без разрешения нового бюджета.

## 6. Итоговая интеграция

- [ ] 6.1 Выполнить focused operations и полный набор поверх 296 тестов, typecheck и строгую OpenSpec validation; записать Windows/Linux/CI/SDK/runtime/реальный deployment и оставшиеся пробелы в operations VERIFICATION.
- [ ] 6.2 Сверить все requirements с проверками/документами, проверить Git status/diff/ignore/секреты и отсутствие правок соседних контрактов; перечитать PROJECT_PLAN.md и обновить только строку модуля 9 фактическим статусом.
