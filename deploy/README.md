# Доставка Linux + systemd

`.github/workflows/service.yml` проверяет все jobs до release/deploy. Только main и явный workflow_dispatch main могут доставлять сборку; PR не получает deploy ключ. `DEPLOY_ENABLED=true` включается после первоначальной подготовки сервера. До этого успешный CI/release не означает работающий CD или бот.

Release содержит dist/src, lock/package, prompt, dictionary, примеры и эти deploy-файлы. Сборка использует allowlist; runtime env, БД, .local и тесты не входят. REVISION и SHA256 проверяются до установки. Успех — fresh status ожидаемой revision и active unit; реальный анализ для проверки доставки не запускается.

## Первоначальная подготовка

Root проверяет ОС, architecture, systemd, Node/glibc, свободное место и существующие сервисы. Создаются отдельные worst-player (runtime, nologin) и worst-player-deploy (SSH), локальные каталоги:

- /opt/discord-worst-player-finder: root-owned base/current/runtime, releases/incoming принадлежат deploy; заранее созданный deploy.lock доступен deploy на запись, но его родитель недоступен на запись;
- /etc/discord-worst-player-finder: service.json, group-settings.json и service.env, root:worst-player, каталог 0750, файлы 0640;
- /var/lib/discord-worst-player-finder: app.sqlite/operations-state/status/backups/service.lock, worst-player, 0700.

Системный Node и другие unit не меняются. Собственный официальный Node 22 patch фиксируется проверенной версией/architecture/SHA256 и устанавливается под runtime после CI на этой ветке Node.

Root устанавливает control.sh как /usr/local/libexec/wpf-control и receive.sh как /usr/local/libexec/wpf-receive, owner root и mode 0755, а также unit из этого каталога. Скрипты не должны быть writable для deploy/runtime. Scoped sudoers разрешает worst-player-deploy только `/usr/local/libexec/wpf-control *`; helper проверяет action/SHA, меняет только current, вызывает только свой unit и выполняет CLI от worst-player. Sudoers проверяется visudo -cf. systemd unit проверяется systemd-analyze verify.

Чтение кода даётся отдельной группе worst-player-code с обоими пользователями. /opt base — 0750 root:worst-player-code, releases/incoming — 2750 deploy:worst-player-code, staging после mktemp — 0750; umask=027 даёт runtime доступ к установленным файлам. Deploy-user не добавляется в приватную группу worst-player и не читает config/env/data. Node runtime, его родитель и helper остаются root-owned; deploy не может подменить исполняемый root-helper Node. Current меняется только проверенным control activate.

В authorized_keys deploy-user помещается отдельный публичный Actions ключ с `restrict,command="/usr/local/libexec/wpf-receive"`. Его home, .ssh и authorized_keys принадлежат root: deploy не может заменить ограничение своим ключом. Внутри home отдельно создаётся .npm (deploy-owned, 0700), чтобы npm ci мог записывать cache/logs. Root ключ пользователя в GitHub не передаётся. CI отправляет tar через stdin одной команды `deploy <sha> <sha256>`, без SCP или произвольной shell-сессии. Серверный helper проверяет размер/hash/имена/типы tar; symlinks/hardlinks и выход из release запрещены.

GitHub secrets: DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS; variables: DEPLOY_HOST, DEPLOY_USER, DEPLOY_PORT и DEPLOY_ENABLED. Host key берётся из проверенного подключения и закрепляется; StrictHostKeyChecking остаётся yes. Фактические адреса, ключи и runtime env в этот репозиторий не входят.

Перед первым запуском оператор загружает service/group JSON и env через локальный SSH, выставляет права, явно выполняет init и register-commands от worst-player. Эти действия не выполняются каждым deploy. Если current ещё не установлен, используется полный путь установленного releases/<sha>/dist/src/operations/cli.js. Сначала prepare-only/manual, live/automatic и новые бюджеты задаются отдельно. Без секретов/config/init доставка сообщает причину и не объявляется готовым ботом.

## Обновление и откат

Receive сериализует доставки, устанавливает новый immutable release и production dependencies по lock без install scripts, выполняет offline check. Затем останавливает только worst-player.service, делает cold backup прежней установки под тем же app lock, атомарно меняет current и запускает unit. Health проверяется до 90 секунд. Ошибка после переключения возвращает прежний relative releases/<sha> и запускает тот же unit с текущей БД; workflow остаётся failed. При первом неудачном запуске предыдущей версии нет, сервис остаётся неготовым.

Ручной rollback: остановить свой unit, проверить совместимость прежнего release с текущей БД, заменить current на проверенный releases/<sha>, запустить и проверить fresh revision/status. БД автоматически не восстанавливается. Процедура резервирования и риски старого backup: [operations README](../src/operations/README.md). Очистка releases/incoming и off-host backup выполняются оператором; автоматического удаления в первой версии нет.

Эти файлы — deploy-контракт и шаблоны. Фактические SSH-права, установленный Node, unit, секреты, проверка rollback и первый GitHub deploy должны быть отдельно подтверждены в operations VERIFICATION; их наличие в Git не является доказательством настройки VPS.
