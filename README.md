# Discord Worst Player Finder

Частный Discord-бот для разбора рейтинговых матчей Dota 2: OpenDota → проверяемые факты → MiMo через OpenRouter → русский Discord embed. Выбор может включать одного/двух союзников или честный отказ при недостатке данных.

Node.js >=22.14.0, TypeScript, discord.js, встроенная SQLite. Основной план и состояние модулей: [PROJECT_PLAN.md](PROJECT_PLAN.md). [Запуск и конфигурация](src/operations/README.md); CI/CD готовятся в [add-operations](openspec/changes/add-operations/proposal.md).

## Проверки

```powershell
npm.cmd ci --ignore-scripts --engine-strict --no-audit --no-fund
npm.cmd run typecheck
npm.cmd test
```

В Linux используются npm вместо npm.cmd. GitHub Actions выполняет эти проверки на Windows/Node 22.14.0 и Linux/Node 22.14.0 и закреплённой production-версии 22.23.3. Тесты работают с синтетическими данными, временными БД и поддельными API. Рабочие ключи для CI не нужны.

## Данные и доступы

Репозиторий приватный. `.local/`, `.env*` кроме пустого `.env.example`, БД, ключи, локальные настройки Codex и сборка исключены из Git. Runtime-конфиги размещаются в `.local/` либо вне репозитория. В Git не добавляются bot/API/SSH-ключи и реальные снимки матчей.

MiMo-пакет остаётся экспериментальным. Реальные прогоны и новый бюджет не включаются через тесты или обычный restart. Настройка Discord описана в [инструкции интерфейса](src/discord-interface/README.md), режимы/лимиты — в [инструкции конвейера](src/match-pipeline/README.md).
