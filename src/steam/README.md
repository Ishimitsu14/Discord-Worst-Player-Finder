# История матчей Steam

`SteamHistoryClient` читает только `GetMatchHistory` указанного Steam32. Импорт/создание инертны; ключ передаёт вызывающий код, env и БД модуль не читает. Подробности матча, нашу сторону и пригодность подтверждает OpenDota в конвейере.

```typescript
import { SteamHistoryClient } from './index.js';

async function latest(apiKey: string, accountId: number) {
  const client = new SteamHistoryClient({ apiKey });
  return client.getMatchHistory(accountId, { limit: 20 });
}
```

Публичная страница: `{ matches: [{ matchId, startTime }], nextStartAtMatchId }`. Время начала — Unix seconds, ID — положительный safe integer; Steam32 1..4294967294. `limit` 1..100, по умолчанию 20. Следующий запрос получает `startAtMatchId` из ответа. Полные duration/outcome/mode и сырые поля не возвращаются. Пустая доступная история отличается от `SteamHistoryError('history-private')` при API status=15, в том числе при HTTP 200.

Один клиент на процесс имеет собственный rolling budget 60 отправок/минуту, включая повторы, независимо от OpenDota. Это наш ограничитель, не обещание квоты Valve. Таймаут попытки 10 секунд включает тело; GET при network-error/timeout/upstream-error повторяется максимум дважды через 1 и 2 секунды плюс jitter. 401/403, status=15, плохой JSON/DTO не повторяются. 429 применяет общий Retry-After (seconds/date), fallback 60 секунд. При исчерпании квоты нет скрытой очереди: ошибка rate-limited содержит details.retryAt. Signal отменяет HTTP и ожидание повтора.

Ключ передаётся только фиксированному HTTPS-хосту Steam; redirects запрещены. `SteamHistoryError.toJSON()` содержит код/операцию и безопасные status/retryAt, без URL, ключа, ответа и raw cause. Транспорт передаётся через `{ fetcher?, clock?, random? }` для проверок без реальной сети.

Живые GET нового клиента 17 октября 2026 подтвердили доступную историю 98341323 (5 матчей, последний 9048979975) и приватный отказ 122376567 (HTTP 200, API status=15). Два GET выполнены без повторов, AI и Discord; [протокол](VERIFICATION.md). Это не измерение задержки свежей игры или подтверждение чтения всех аккаунтов/работы VPS. Сквозная настройка источника описана в `src/match-pipeline/README.md`.
