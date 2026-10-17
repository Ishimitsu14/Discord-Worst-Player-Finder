# Подготовка фактов

Самостоятельный модуль `match-facts` формирует без ИИ полный локальный набор и короткий отчёт для аналитика. Не читает файлы/окружение/часы, не выполняет сеть, не меняет вход и не оценивает качество игроков. Требования: [OpenSpec](../../openspec/changes/add-match-facts/specs/match-facts/spec.md), [дизайн](../../openspec/changes/add-match-facts/design.md), [сводки V2](../../openspec/changes/add-match-facts-summaries/specs/match-facts-summaries/spec.md).

## API

По умолчанию API и `lab facts` возвращают прежний `match-brief-v1`. Новый `match-brief-v2` включается только явно; текущие аналитик, pipeline и storage продолжают работать с v1. Профиль prompt v2 аналитика и формат brief v2 — разные версии разных артефактов.

```ts
import { prepareMatchFacts, verifyFactsBundle, validateFactReferences } from './index.js';

const input = { matchId, side, data: snapshot.data };
const options = { dictionary, roleOverrides: [{ playerSlot: 128, position: 5 }] };
const bundle = prepareMatchFacts(input, options);
verifyFactsBundle(bundle, input, options);
validateFactReferences(['e100'], bundle); // только ID со значением в context
```

```ts
const v2Options = { dictionary, briefFormat: 'match-brief-v2' as const };
const v2 = prepareMatchFacts(input, v2Options); // FactsBundleV2
verifyFactsBundle(v2, input, v2Options);
```

Перегрузки сохраняют тип `FactsBundle` у старого вызова; добавлены `BriefV2`, `FactsBundleV2`, `FactsOptionsV2`, `ManifestV2`. Проверка V2 требует тот же явный выбор формата; старый профиль его отклоняет. Неизвестный выбор даёт `invalid-input`, несогласованный пакет/профиль — `integrity-error`. V1 сохраняет значения, ID, digests и подготовленные запросы; старые артефакты не регенерируются автоматически.

| Версия | context | facts | factsProfile / briefProfile | factsTransform / briefTransform |
|---|---|---|---|---|
| V1 | version 1, match-brief-v1 | version 1, facts-v1 | facts-profile-1 / brief-profile-1 | normalize-1 / summarize-1 |
| V2 | version 2, match-brief-v2 | version 1, facts-v1 | facts-profile-2 / brief-profile-2 | normalize-1 / summarize-2 |

Manifest сохраняет version 1, `briefFormat` соответствует context. У V2 отдельный bundleId. Новые ID добавлены после неизменённого реестра V1; нормализация общая.

## Вычисленные сводки V2

Все группы V1 сохраняются. Дополнительный `context.summaries` и те же значения в `facts.derived.summaries` содержат:

- `fightDeaths.byFight`: index, totals с radiant/dire/allies/opponents, unavailableSlots, headerStatus. Сумма стороны доступна только при пяти известных неотрицательных целых deaths и безопасной целочисленной сумме. Неполная сторона недоступна независимо от другой; неизвестный mapping не даёт выдуманных нулей. Header и участники не исправляют друг друга.
- `fightDeaths.allCards`: sourceState, cardCount, totals, conflictingCards. Складываются наблюдения всех предоставленных карточек, только если все суммы соответствующей стороны известны. Пустой present-список даёт ноль карточек и смертей; missing/null/invalid остаются недоступными. Это не уникальные смерти всего матча: карточки могут перекрываться, отсутствовать и не описывают произвольную подгруппу.
- `buildingKillEvents`: sourceState и counts с byPlayerSlot для десяти слотов, unassigned, knownBuildingEvents, otherEvents, unclassifiedEvents, excludedByTime. Считаются записи уничтожения строения с подтверждённым actor; ноль не доказывает отсутствие вклада. Крип/конфликт/неизвестный actor идёт в unassigned. Пропущенный журнал не превращается в пустой.
- `allyMetricOrder`: восемь фактов для hero_damage, tower_damage, hero_healing, stuns, gold_per_min, xp_per_min, net_worth, participation. Значение — `{groups:[{value,slots}],unavailableSlots,complete}`. Группы возрастают по исходным числам, равные значения объединяются, слоты упорядочены канонически. При complete=false сравнение относится только к известным значениям; при отсутствии всех значений groups пуст. Ролевого фильтра, общего рейтинга, весов и выбора худшего нет.

Классификация записей объектов закреплена:

| type | key | Категория |
|---|---|---|
| building_kill | tower, melee/range rax, fort из прежнего allowlist | строение |
| CHAT_MESSAGE_TOWER_KILL | tower | строение |
| CHAT_MESSAGE_BARRACKS_KILL | melee/range rax | строение |
| FIRSTBLOOD, ROSHAN_KILL, AEGIS / STOLEN / DENIED, COURIER_LOST с префиксом CHAT_MESSAGE_ | любой | другие события |
| неизвестные/отсутствующие type или неподходящие key | — | неклассифицированные |

Сначала проверяется время: недоступное либо вне `[0,duration]` попадает в excludedByTime. Каждая запись относится ровно к одной категории. `knownBuildingEvents = sum(byPlayerSlot) + unassigned`; сумма четырёх категорий равна длине журнала. Повторяющиеся записи не дедуплицируются по key/времени: одинаковый tower4 key может относиться к разным башням. Единица — известное событие лога, не гарантированно уникальное здание и не весь вклад в снос; tower_damage остаётся отдельным наблюдением.

Каждая сводка имеет собственный ID. Новые transforms — `fight-side-deaths-v1`, `fight-card-deaths-v1`, `building-kill-events-v1`, `ally-metric-order-v1`. Основания охватывают исходные группы и пути, count/состав коллекций, type/key/time/actor либо все пять метрик, включая неизвестные. Поэтому нулевой счётчик основан на просмотренном журнале, а не пустом наборе совпадений. Независимый coverage проверяет выборки, категории и состав групп; полное воспроизведение выявляет согласованную подмену даже с пересчитанными digests. Существование ссылки не доказывает предложение модели.

```powershell
npm.cmd run build
npm.cmd run lab -- facts --match-id 9048979975 --side dire --brief-format match-brief-v2
```

Снимок должен находиться в выбранном corpus; при необходимости используйте существующий `collect --from-file` в отдельный локальный development-корпус. Флаг доступен только для facts, обычный вызов и явный match-brief-v1 сохраняют прежний формат. API адаптера принимает такой же briefFormat. Формат/профили и формат диагностического повтора записаны в diagnostics, фактический формат виден в CLI/summary/manifest.

Для обоих форматов цель — 32768, предел — 65536 minified UTF-8 bytes. V2 добавляет данные и может не поместиться: `context-too-large` содержит bytes/limit, готовый manifest не создаётся, группы не удаляются и fallback к V1 не выполняется. Шесть артефактов и атомарная запись manifest последним сохраняются. Размер байтов и локальные timings не подтверждают скорость или качество MiMo; поддержка нового входа аналитиком вводится отдельно.

## Входы и ошибки

`side` — `radiant|dire`. Нужны совпадающий safe integer match ID, положительная конечная длительность, boolean исход, уникальные канонические слоты и пять союзников с положительными hero ID. Анонимность допустима. Недостающие соперники и неизвестные справочнику hero ID обозначаются явно. Рейтинговый режим здесь не отбирается. `version` — целое >0: parsed, иначе basic с исходным состоянием поля; parsed не гарантирует полноту журналов.

`FactsError.code`: `invalid-input`, `unusable-match`, `invalid-dictionary`, `invalid-role-override`, `context-too-large`, `integrity-error`, `unknown-fact-reference`. `details` содержит только допустимые числа (например, bytes/limit); payload и посторонние строки в ошибку не включаются. Ошибка не выпускает пригодный частичный пакет.

Справочник передаётся параметром: [dotaconstants-v1.json](../../evaluation/dictionaries/dotaconstants-v1.json). Профиль закрепляет revision `5c0242df9057848fa2036ca3fafe9f2bd4508163` и SHA-256 канонического содержания `c77d5cc3c4f60989e47f96e15065199cc484c59d01c2241eb2901890c8c1eb97`. Другой файл требует явной новой версии профиля; сеть для обновления не используется.

## Два представления

- `facts` (`facts-v1`): объявленные безопасные поля, полные журналы, вложенные карты, все подробные карточки, производные и quality. Это нормализованный профиль, а не весь JSON источника.
- `context` (`match-brief-v1`): фиксированный вход ИИ. Все пять союзников, доступные соперники, экономика обеих команд, разницы по позиции, фазы, предметы/применения, все компактные драки, объекты/выкупы, подключения и coverage.
- `evidence`: локальный реестр с value, metric/unit, playerSlot, source, paths, inputs, transform и числовыми parameters формулы. Цепочки ацикличны, ведут к снимку или options.
- `manifest`: версии обоих форматов/профилей/преобразований, входные и выходные digests, bundleId. Времён подготовки здесь нет.

Наблюдение — `{id,value}` либо `{unavailable:'missing'|'null'|'invalid',reason?}`. Число 0 имеет собственное основание; пропуск не получает фиктивного ID. Коллекции различают state/count/entries/excluded, в том числе `present` с пустым массивом. Частично повреждённый журнал сохраняет известные поля/элементы, исходное число и ограничения.

Для сокращения повторов сводные именованные значения объединяются в группы с одним проверяемым ID: `metrics: {id, value: {kills: 3, deaths: 8, ...}}`. Экономика и фазовые счётчики устроены так же; в драке колонка `damage.value` содержит именованные слоты `0`…`132`. Это объекты, без позиционных кортежей. Основание группы (`named-group-v1`) перечисляет ID её исходных значений; у смешанных summary/economy/comparison unit `catalog-per-member` означает единицу каждого именованного поля из каталога. Колонка драки имеет единицу своей метрики, фазовые счётчики — count. Группа и её значение также сохраняются в `facts.derived`. Модель может сослаться на ID группы целиком; ID отдельного исходного значения только из локального реестра не принимается.

Финальные слоты предметов передаются все, включая пустые; `itemTypes` содержит по одной записи каждого известного положительного типа в этих слотах. Известные плоские `ability_uses` передаются, вложенные карты остаются локально. Цель — 32768 UTF-8 bytes, предел — 65536 точных minified bytes context. Результат между целью и пределом допустим, превышение предела даёт ошибку без удаления игроков/драк или отправки полного пакета.

## Профиль и единицы

Закрытые списки в [profile.ts](profile.ts) закрепляют summary/maps/targets/series из compact-v2. Группы одинаковы у всех игроков. Чат, ники, account ID, URL, неизвестные поля и произвольные строки исключаются. Карты принимают ключи закреплённого справочника, числовые ID и перечисленные здания; `''`/`'null'` разрешены только в inflictor/healing. Неизвестные ключи исключаются с quality. JSON pointers экранируются по RFC 6901. Длинные ряды и координаты событий не входят в полный профиль: вместо рядов — точные срезы/delta, вместо координат — хронология.

Обычные счётчики и ID требуют неотрицательного safe integer; значения урона/ресурсов/контроля/лечения — конечного неотрицательного числа; события start/end/time, gold_delta/xp_delta и изменения gold_reasons/xp_reasons допускают знак (например, потерю золота). Boolean поля не приводятся из чисел/строк. Время — секунды; gold_t — earned-gold, networth_t/net_worth — отдельный net-worth; золото — gold, опыт — xp, GPM/XPM — единицы в минуту, урон/лечение — hp. `life_state_dead` и сумма журналов смерти не подменяют друг друга; `healing` карточки и `hero_healing` различаются. Контроль может суммироваться по нескольким целям.

Роли: только `position_est` 1–5 либо явное `{playerSlot,position}`. Manual получает provenance из `/roleOverrides/INDEX/position`, вытесняет автоматические конфликты; дубликаты оставшихся оценок становятся unknown. Повторные ручные слоты/позиции команды отвергаются. Имя героя и оставшийся номер не определяют роль. Сравнение по роли требует двух полных однозначных пятёрок.

## Формулы

| Transform | Правило |
|---|---|
| identity-v1 / array-length-v1 | Проверенное значение / длина существующего массива, включая пустой |
| slice-Nm-v1 | Единственный `times[i]===N*60`, достигнутое время, согласованные длины/числа, без интерполяции |
| delta-A-Bm-v1 | Корректный срез B минус A; допустим отрицательный результат |
| kill-participation-v1 | `(kills+assists)/teamScore`, score>0, числитель<=score; upstream доля отдельна |
| dead-share-v1 | `life_state_dead/duration`, только 0<=dead<=duration |
| same-position-difference-v1 | Срез союзника минус срез однозначного соперника; оба назначения роли входят в inputs |
| phase-count-v1 | Известные события в [0,600), [600,1200), [1200,1800), [1800,duration]; parameters содержат phase/from/to/log (индекс в phaseLogs) |
| phase-killer-count-v1 | Известные смерти по словарному ключу героя в фазе, без приписывания неизвестной причины |
| first-final-item-purchase-v1 | Минимальное известное время покупки типа из конечных слотов при единственном словарном token; это не история владения экземпляром |
| connection-summary-v1 | Числа disconnect/reconnect и последнее время каждого типа, без AFK duration |
| dead-window-v1 | `[max(0,time), min(duration,time+time_dead))` при известном time_dead>=0 и положительной длине; endpoint 0/1 задаёт начало/конец |
| interval-overlap-v1 | Известное пересечение окна смерти с дракой; endpoint 0/1, без реконструкции respawn/позиции |
| known-dead-overlap-v1 | Длина объединения пересечений, без двойного счёта; неполнота даёт lowerBound, пустой журнал — 0, неизвестный/непустой без окон — unavailable |
| fight-deaths-sum-v1 | Сумма десяти корректных participant.deaths, header не заменяется; mismatch явно отмечается |
| following-objectives-v1 | `end < objective.time <= end+120`; только временная близость |
| objective-actor-v1 | Подтверждённый player_slot, канонический slot либо однозначный hero-unit; противоречие/крип не назначает героя |
| unknown-type-v1 | Неподдержанный тип события заменяется фиксированным `unknown` с quality, без произвольного текста |
| named-group-v1 | Именованная группа известных значений и явных unavailable, с provenance исходных ID |

Фазы после конца не достигнуты; событие ровно на границе относится к новой фазе. Финальная граничная точка может содержать событие при нулевой длине. Это counts, не rates. Время вне матча сохраняется локально с ограничением и исключается из фаз. Пропущенное время не угадывается. Buyback не используется для дорисовки окна respawn. Покупка/наличие/применение и отключение/длительность отсутствия — разные наблюдения.

Карточки сопоставляют канонические 10 индексов со слотами независимо от match.players. Массив другой длины не сопоставляется. У пустого участника нет выдуманных нулей. OpenDota выделяет лишь часть драк, возможен пропуск последней; ноль damage не доказывает AFK. Ни отставание, ни временная близость объекта не доказывают причину поражения.

## Coverage и проверка

`representations` один раз задаёт direct/aggregate/local-only для групп союзников/соперников. У каждого игрока `coverage.states` перечисляет группы по исходному present/missing/null/invalid, `sourceCounts` — известные числа элементов/полей, `reportedCounts` — числа переданных полей/строк/агрегатов. Неуказанный reportedCount равен `defaultReportedCount:0`; это объявленное локальное представление, не отсутствие действий. `excluded` отмечает недоступные/нераспределённые элементы; у фазовых журналов это события без пригодного времени в матче. Показатели count источника и число агрегатов не сравниваются как одинаковые величины.

`checkCoverage(bundle,input,options)` независимо от построителя проверяет обязательные группы/метрики, исходные безопасные scalar/maps, журналы, фазовые счётчики, все драки и наличие переданных значений в полном наборе. `verifyFactsBundle` дополнительно проверяет сериализуемую оболочку Ajv, digests, ацикличные ссылки и воспроизводит весь пакет по исходным data/options. Согласованная подмена digest не обходит повторную сборку. `validateFactReferences` допускает только ID с тем же значением в переданном context и evidence. Наличие ссылки не доказывает текстовое обвинение.

Канонизация сортирует ключи объектов по кодовым единицам, включая числовые ключи, сохраняет порядок массивов; циклы и не JSON значения отвергаются. dataDigest — SHA-256 такого JSON data, не checksum исходных HTTP bytes. Bundle ID включает сторону, закреплённый словарь, отсортированные overrides, отдельные версии и digests facts/context/evidence; ID eN действует только в этом пакете. Изменение алгоритма/профиля требует новой версии.

## Офлайн-команда

```powershell
npm.cmd run build
npm.cmd run lab -- facts --match-id 9045784658 --side dire
# --root .local/evaluation --roles .local/roles.json
```

В Linux используются `npm run build` и `npm run lab -- facts ...`. Форма файла ролей: `{ "version":1, "matchId":9045784658, "entries":[{"playerSlot":128,"position":3}] }`. ID должен совпадать с командой. Запись выбирается из corpus, точные bytes проверяются по snapshot.digest; при отсутствии/повреждении нет загрузки из сети. Ключ модели и ручной эталон не нужны.

Результат: `.local/evaluation/facts/UUID/{facts.json,context.json,evidence.json,manifest.json,summary.md,diagnostics.json}`. Context записан minified без новой строки. Summary шаблонно показывает только этот brief; подробности не подмешиваются. Все файлы атомарны и не перезаписываются; manifest записывается последним как признак завершения. Каталог без manifest — незавершённый запуск. Повтор создаёт новый каталог с тем же bundleId; диагностика с датами/временами отличается.

Diagnostics разделяет чтение/проверку bytes, полный public prepare, нормализацию и построение brief (отдельный повтор для диагностики), verify, сериализацию и запись. WriteMs охватывает сериализацию/запись до summary и исключает commit diagnostics/manifest; это явно записано в файле. Миллисекунды не становятся CI порогом. Facts/evidence/diagnostics не отправляются модели автоматически. Существующие планы, эталоны, v1/v2 и их контракты не изменяются.

Результаты: [VERIFICATION.md](VERIFICATION.md). Размер байтов не является токенами или проверкой скорости/качества MiMo. Подключение аналитика — отдельный модуль.

## Отдельный профиль Gemini

`prepareCompactMatchFacts({matchId,side,data},{dictionary,heroMetricsDictionary,roleOverrides?})` готовит `gemini-compact-v1`. Второй словарь — `evaluation/dictionaries/hero-metrics-v1.json`; оба закреплены digest. Форматы facts/manifest отдельные, прежний prepareMatchFacts и golden v1/v2 сохранены. Core не выполняет сеть или файловые операции, не выбирает сторону либо худшего.

`verifyCompactFactsBundle(bundle,input,options)` повторяет сборку по исходному снимку; `validateCompactBundle(bundle)` проверяет форму, состав, версии, digests и переданные ссылки без исходника. Для проверки происхождения нужен первый вариант. `validateCompactReferences(ids,bundle)` допускает только переданные игровые/чат-группы; аналитик дополнительно разделяет их назначение.

| Выход | Источник / правило |
|---|---|
| networth | player.net_worth, без подстановки total_gold |
| position/source | существующие position_est/manual/unknown; lane_role отдельно |
| kill_participation_pct | Math.round((kills+assists)/team_score*100), где team_score — radiant_score/dire_score выбранной стороны; при нуле/неизвестности/невозможном числителе unavailable |
| key_item_timings | первая корректная покупка каждого объявленного типа из всего purchase_log, секунды и Math.round(seconds/60) |
| benchmarks | исходные GPM/hero_damage_per_min raw>=0 и pct в [0,1], без придуманной ранговой выборки |
| special_metrics | только применимые LC buff 5 / Lion 7 / Pudge 4; уникальный неотрицательный stack_count; отсутствие не равно нулю |
| hook_accuracy | у Pudge unavailable: no-verified-hit-source; число выигранных дуэлей не рассчитывается |

Передаются пять своих одинаковых игровых сводок, краткие соперники и собственный type=chat. Personaname ограничен 64 Unicode code points; пустое/недоступное имя даёт Anonymous с name_source. Чат проверяет slot 0–9 против канонического player_slot и состава снимка; противоречивый автор исключается. Последние 20 пригодных реплик по времени/исходному индексу отправляются хронологически, до 240 code points каждая. Сокращение и исключения объявлены; полные пригодные строки остаются в facts.extras.chat. Произвольные остальные строки и account ID в контекст не попадают. Ники и чат — данные, а не инструкция; экранирование Discord выполняет потребитель.

`checkCompactSize` измеряет minified UTF-8 bytes: цель ядра без chat 4096, жёсткий предел всего контекста 16384. Цель не является гарантией; targetMet и фактический coreBytes сообщаются. Переполнение отклоняется без удаления показателей. Coverage показывает состояния исходных групп, недоступные поля и причины исключения реплик.

```powershell
npm.cmd run lab -- facts --match-id 9048915444 --side dire --brief-format gemini-compact-v1
```

Команда читает только существующий локальный corpus и создаёт те же шесть атомарных артефактов с manifest последним. Старый аналитик новый формат не принимает. Следующий потребитель — отдельный пакет Gemini; storage/pipeline/Discord/runtime подключены отдельным профилем gemini.

## Проверка материалов runtime

validateCompactDictionaries({ dictionary, heroMetricsDictionary }) — публичная синхронная чистая проверка тех же закреплённых версий/digest, которые применяются при prepareCompactMatchFacts. Она не читает env/файлы и не вызывает сеть. Runtime загрузчик читает оба JSON заранее и проверяет их до открытия БД/Gateway. Изменение объекта словаря не создаёт новый поддерживаемый формат автоматически. Legacy-факты и их digest не изменены.

Compact bundle подключён к storage/pipeline/Discord/operations отдельным профилем gemini; прежний prepareMatchFacts продолжает возвращать legacy-формат.
