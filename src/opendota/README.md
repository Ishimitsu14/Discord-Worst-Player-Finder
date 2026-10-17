# Клиент OpenDota

Самостоятельный модуль `src/opendota/`. Публичная точка входа — `index.ts`. Зависимости: встроенные fetch/AbortController и существующая TypeScript-сборка Node.js 22.14+. [Контракт](../../openspec/changes/add-opendota-client/specs/opendota-client/spec.md), [решения](../../openspec/changes/add-opendota-client/design.md), [проверки](VERIFICATION.md).

Модуль получает данные без выбора команды, рейтингового режима или худшего игрока. Он не обращается к Discord, OpenRouter и SQLite. Импорт не выполняет сетевых запросов. Лабораторный исследовательский collect пока использует собственный транспорт; его подключение к клиенту — отдельная работа.

## Создание и операции

Создайте один `OpenDotaClient` на процесс. Конструктор принимает `{ apiKey?: string }`; вызывающий код читает `OPENDOTA_API_KEY` из окружения и передаёт значение. Без ключа используется тот же публичный API. Ключ передаётся только в Bearer-заголовке. Модуль не читает окружение или `.env` самостоятельно. В `.env.example` значение пустое; CLI Node.js не загружает этот файл автоматически.

| Операция | Параметры | Результат |
|---|---|---|
| getPlayerMatches | accountId, `{ limit = 20, offset = 0, signal? }` | Одна страница PlayerMatch[], significant=0, исходный порядок и режимы |
| getMatch | matchId, `{ fresh = false, signal? }` | `{ data, parseState, retrievedAt }` |
| requestParse | matchId, `{ signal? }` | `{ matchId, jobId }`; один явный POST |
| getParseJob | jobId, `{ signal? }` | `{ state: 'present', data }` либо `{ state: 'missing' }` |
| waitForParsedMatch | matchId, jobId, `{ timeoutMs = 900000, signal? }` | ParsedMatchResult: parsed либо timed-out |

matchId — положительное безопасное целое; accountId — Steam32 от 1 до 4294967294. limit — целое 1–100, offset — неотрицательное безопасное целое. Входной jobId — десятичная строка положительного безопасного целого, числовой jobId из API приводится к строке. timeoutMs — положительное безопасное целое. retrievedAt и retryAt — Unix timestamp в миллисекундах; исходные времена OpenDota сохраняют свои единицы.

Данные сохраняют дополнительные поля, отсутствие, null, 0 и пустые массивы. Уникальный player_slot 0–255 определяет игрока независимо от account_id. Неполный состав допустим; пригодность данных проверяет следующий модуль. Положительная целая version означает parsed; отсутствие/null/0 — basic. Parsed не гарантирует полноту логов.

## Получение и ожидание разбора

Пример из `test/opendota-example.ts` компилируется общей сборкой и выполняется в тесте на подменённом API. Для приложения замените путь импорта относительно своего файла. Обёртка примера возвращает already-parsed для готового матча без создания задания; клиентский waitForParsedMatch возвращает parsed/timed-out с реальным jobId.

```ts
import { OpenDotaClient, type MatchSnapshot, type ParsedMatchResult } from '../src/opendota/index.js';

export async function loadParsedMatch(client: OpenDotaClient, matchId: number, signal?: AbortSignal): Promise<ParsedMatchResult | { state: 'already-parsed'; snapshot: MatchSnapshot }> {
  const snapshot = await client.getMatch(matchId, { signal });
  if (snapshot.parseState === 'parsed') return { state: 'already-parsed', snapshot };
  const queued = await client.requestParse(matchId, { signal });
  return client.waitForParsedMatch(matchId, queued.jobId, { timeoutMs: 900000, signal });
}
```

Вызывающий код сохраняет возвращённый jobId и после перезапуска передаёт его непосредственно в waitForParsedMatch. Ожидание не создаёт POST. Сначала выполняется свежий GET матча, затем, если он basic, GET задания; цикл повторяется через 15 секунд. Missing не означает готовность. Timed-out содержит последний успешный снимок или null и последнюю временную ошибку или null. Общий срок включает HTTP, повторы и задержки. Отмена и постоянные ошибки завершают вызов ошибкой.

## Ошибки, лимиты и отмена

OpenDotaError содержит code, operation, необязательные httpStatus/retryAt и requestMayHaveSucceeded; toJSON() возвращает безопасный OpenDotaErrorSummary. Сырые ответы ошибок, headers, URL и исходный cause не экспортируются. При отражении настроенного ключа в успешном JSON ответ отвергается.

Коды: invalid_argument, not_found, unauthorized, forbidden, bad_request, rate_limited, network_error, timeout, upstream_error, invalid_response, aborted. При неопределённом исходе отправленного POST (отмена, таймаут, обрыв, 5xx, неверный успешный ответ) requestMayHaveSucceeded=true. Это запрещает предполагать, что задание точно не создано; решение о следующем явном POST остаётся у вызывающего кода.

Одна попытка ограничена 10 секундами, включая чтение тела. GET при network_error/timeout/5xx имеет максимум два повтора: 1 и 2 секунды плюс случайные 0–250 мс. POST, 429, постоянные ошибки и неверный JSON не повторяются. Общий скользящий бюджет — 60 единиц за минуту, GET=1, POST=10. Каждая отправка, включая повтор, учитывается. При нехватке квоты возвращается rate_limited с retryAt; скрытой очереди нет. При 429 применяется общий cooldown по Retry-After (секунды/HTTP-date, fallback 60 секунд), с учётом более позднего локального ограничения. Ключ не увеличивает локальный бюджет.

Кеш хранит максимум 100 успешных проверенных чтений: история 30 секунд, basic 15 секунд, parsed 15 минут; вытесняется самая старая добавленная запись. Возвращаются копии. Fresh обходит кеш и обновляет его при успехе; ошибка не подменяется старым снимком. Job не кешируется. Параллельные одинаковые GET объединяются без пользовательского signal; запросы с signal независимы. Совместный POST отменяется до отправки, если отменены все подписчики; после отправки HTTP ограничен собственным сроком и может завершиться без подписчиков. Отмена отдельного подписчика не отменяет остальных.

## Проверка

Из корня проекта в PowerShell:

```powershell
npm.cmd run typecheck
npm.cmd run build
node --test dist/test/opendota.test.js
npm.cmd test
openspec.cmd validate add-opendota-client --type change --strict --no-interactive
```

В Linux используются npm/openspec без .cmd. Конструктор допускает отдельный второй аргумент `{ fetcher?, clock?, random? }` для изолированных тестов; production URL фиксирован: https://api.opendota.com/api. Тесты не создают живых заданий. [OpenDota OpenAPI](https://api.opendota.com/api) описывает upstream; параметры таймаутов, кеша и локального бюджета являются решениями этого клиента.
