# Design

## Context

См. [proposal.md](proposal.md) и [контракт](specs/compact-match-context/spec.md). Сейчас `prepareMatchFacts` создаёт v1 либо явно выбранный v2, оба используют `facts-v1` и старый справочник. `normalize.ts` исключает произвольные строки, benchmarks и permanent_buffs; `brief.ts` отдаёт покупки только типов из конечных слотов. Новый профиль нельзя получить простым удалением полей v2.

Проверено чтением OpenDota 17 октября 2026: у матча 9048915444 есть `net_worth`, `position_est`, benchmarks, purchase_log, permanent_buffs и текстовый чат с `slot` и `player_slot`. У LC buff 5 имеет stack_count 100; словарь OpenDota связывает 4/5/7 с Flesh Heap/Duel/Finger. Это наблюдение одного parsed-матча, не гарантия заполнения остальных игр. [API матча](https://api.opendota.com/api/matches/9048915444), [справочник buffs](https://github.com/odota/dotaconstants/blob/master/build/permanent_buffs.json).

## Goals / Non-Goals

**Goals:** отдельный детерминированный компактный пакет с происхождением, подходящий для выбранных правил Gemini и цитирования, при сохранении старого API.

**Non-Goals:** выбор стороны/худшего, нормативы хорошей игры, реконструкция отсутствующих данных, точность хуков по недоказанной формуле, автоматическое обновление справочников и переключение работающих потребителей.

## Decisions

### 1. Отдельный публичный вход и пакет

Добавить `prepareCompactMatchFacts(input, options)`, `verifyCompactFactsBundle(...)` и `validateCompactReferences(...)` через существующий публичный index. Input сохраняет `{matchId, side, data}`; options содержат прежний dictionary, дополнительный закреплённый heroMetricsDictionary и необязательные roleOverrides. Core не читает файлы и сеть.

`CompactFactsBundle` содержит `facts`, `context`, `evidence`, `manifest`, но является отдельным типом. `context.version=1`, `context.format=gemini-compact-v1`; локальный facts имеет format `gemini-facts-v1` и включает прежние нормализованные факты плюс проверенные extras. Manifest format `gemini-compact-manifest-v1` фиксирует matchId/side, sourceDataDigest, optionsDigest, оба dictionaryDigest, profile/transform, facts/context/evidenceDigest и bundleId. Старые FactsBundle/Manifest не расширяются несовместимыми полями.

Внутри модуля переиспользовать нормализацию, Registry и правила scalar/role из текущего кода. Extras — закрытый whitelist, а не сохранение произвольных player-полей. Не менять прежний путь normalize/prepare, чтобы golden v1/v2 оставались прежними. Альтернатива — заменить общий формат на месте — ломает существующие запросы и отклонена.

### 2. Форма передаваемого JSON

Корневые поля: `version`, `format`, `match_info`, `players`, `opponents`, `chat`, `coverage`. Игровые группы используют привычный `{id,value}`: одна группа на матч, основную статистику игрока, его покупки, benchmarks и special_metrics; это сокращает повторяющееся происхождение. Чат — отдельные группы, чтобы ссылки на реплики отличались от игровых оснований. ID остаются стабильными `eN`, а реестр хранит metric/playerSlot/source/paths/inputs/transform.

| Группа | Поля value |
|---|---|
| match_info | match_id, duration_sec, duration_min, side, won, total_team_kills |
| players, ровно 5 | player_slot, hero_id, hero_name, player_name, position, position_source, lane_role; kills/deaths/assists; gold_per_min/xp_per_min; networth; last_hits/denies; hero_damage/tower_damage/hero_healing/stuns; obs_placed/sen_placed/observer_kills/sentry_kills/camps_stacked; kill_participation_pct |
| key_item_timings игрока | ключи whitelist; для каждого first_purchase_sec и rounded_min |
| benchmarks игрока | gold_per_min и hero_damage_per_min: raw, pct |
| special_metrics игрока | duel_damage/finger_stacks/flesh_heap/hook_accuracy по применимости; неизвестность явная |
| opponents | доступные player_slot, hero_id/name, position/source, networth; без ников, чата и подробных журналов |
| chat | source_index, player_slot, time_sec, rounded_min, text, truncated |
| coverage | parse_state, состояния групп, недоступные поля, исходное/переданное/исключённое число реплик и причины |

Вложенные unavailable используют текущую форму `{unavailable,reason}`. Слот — идентификатор; одинаковые Anonymous не объединяют игроков. Ник берётся только из personaname, null/missing/пустая строка дают Anonymous с отметкой источника. До 64 Unicode code points; сокращение отмечается. Ники — данные для оформления, не игровые показатели. Account ID, Steam-профили, чат соперников и произвольные другие строки не передаются.

Роли сохраняют существующие position_est/manual/unknown и обработку конфликтов. lane_role — отдельная линия, не способ получить Pos 4/5. Нетворс читается из исходного `net_worth`; `networth` — лишь короткое имя выходного поля из документа Gemini.

### 3. Формулы и источники

Длительность и time хранятся точно в секундах; `Math.round(seconds/60)` используется только для минутного представления. Для KP используется radiant_score/dire_score выбранной стороны, а не сумма доступных киллов: необходимы известные неотрицательные K/A, положительный счёт, K+A<=счёта. Сохраняется rounded percent с transform/inputs; 6+1 при счёте 30 даёт 23. Невалидный знаменатель означает unavailable.

Предметы ищутся во всём purchase_log по точным tokens: `blink`, `black_king_bar`, `hand_of_midas`, `radiance`, `bfury`, `blade_mail`, `greater_crit`, `swift_blink`, `overwhelming_blink`, `arcane_blink`, `rapier`. Это явное соответствие названиям Battle Fury/Daedalus, а не поиск по свободному названию. Для каждого типа — минимальное корректное time в `[0,duration]`. Старый Blink не исчезает после апгрейда. Отсутствие записи при present-логе означает «нет подтверждённой покупки», а не доказательство отсутствия предмета. Полный локальный лог сохраняется.

Benchmark сохраняется непосредственно из player.benchmarks с finite raw>=0 и pct в `[0,1]`; без дополнительных запросов. Процентиль не равен относительному отставанию и не получает выдуманный ранг/роль выборки. Норматив «хуже среднего» относится к сравнению источника, а не ко всем игрокам вообще.

### 4. Permanent buffs

Добавить отдельный версионируемый `evaluation/dictionaries/hero-metrics-v1.json` с закреплённым источником/revision/digest: Legion Commander hero 104 → permanent_buff 5 → duel_damage; Lion 26 → 7 → finger_stacks; Pudge 14 → 4 → flesh_heap. Старый dotaconstants-v1 не редактируется. Подтверждённый источник идентификаторов — OpenDota, конкретные поддерживаемые герои — whitelist нашего профиля.

Использовать единственную корректную запись нужного типа для соответствующего героя и неотрицательный safe integer stack_count. Явный 0 известен; отсутствие, null, конфликт/дубликаты — unavailable, не сумма и не автоматический ноль. Grant time не превращается в время всех побед. Duel Damage не переводится в количество побед; hook_accuracy пока unavailable с причиной `no-verified-hit-source`: ни ability_uses, ни неподтверждённые hero_hits не дают необходимой формулы. Расширение источника точности — отдельное последующее решение.

### 5. Чат и его пределы

Выбираются только type=chat с непустой строкой key и конечным time в `[0,duration]`. Канонический player_slot принимается при подтверждении игроком снимка. slot 0–9 переводится через каноническую таблицу 0–4/128–132, независимо от порядка players. Если есть оба и они противоречат, реплика исключается; один неоднозначный/невалидный идентификатор не исправляется по нику или тексту. Только авторы выбранной команды входят в отправляемый chat.

Точные исходные реплики и индексы хранятся локально. Из пригодных сообщений выбираются последние 20 по `(time,source_index)` и возвращаются хронологически. Текст каждой ограничивается первыми 240 Unicode code points без переписывания слов, `truncated` и счётчики видимы. Полный текст/префикс, автор и время участвуют в evidence; цитировать можно только отправленный текст. Пустой чат не мешает игровому анализу.

Персональные строки передаются JSON-значениями, не конкатенируются с system prompt. Упоминания/URL не становятся инструментами; конечное экранирование Discord остаётся обязанностью renderer. Альтернатива «удалять всю ругань» лишает roast выбранной пользователем подачи и не используется.

### 6. Размер и совместимость

Цель игрового ядра без chat — 4096 UTF-8 bytes; допустимое превышение цели измеряется и показывается. Жёсткий предел всего minified context — 16384 bytes. После фиксированного выбора 20 сообщений и 240 символов не происходит адаптивного удаления игровых полей/кандидатов. Превышение — context-too-large. Цель 500–800 токенов и задержка до двух секунд из исходного текста не считаются проверенными характеристиками.

Новый coverage проверяет собственный whitelist, ссылки и объявленные сокращения, а не прежнее требование сохранять все fight cards v1/v2. Лабораторный facts-адаптер явно выбирает формат, сохраняет те же context/facts/evidence/manifest/summary/diagnostics через существующий атомарный файловый путь. V1/v2 не переключаются; output нового формата не направляется в старый аналитик.

## Risks / Trade-offs

- [Чат и ники влияют на модель] → выделенные поля/ID, явные инструкции; игровые причины не принимают chat-ID. Полной независимости скрытого выбора при одном LLM-вызове это не доказывает.
- [Короткий вход теряет боевую детализацию] → профиль осознанно следует документу пользователя, полные локальные факты сохраняются; качество сравнивается экспериментом.
- [Изменения механик/benchmarks] → версии источников и unavailable при несовместимости, без универсального превращения счётчиков в качество.
- [Слишком много текста] → фиксированные пределы и видимые сокращения; переполнение не скрывается.

## Migration Plan

Сначала реализовать и проверить новый профиль офлайн; повторно проверить golden v1/v2. Затем реализовать зависимый аналитик отдельным изменением. Для подключения runtime потребуются явный выбор профиля и поддержка нового пакета в storage/pipeline; до этого VPS продолжает прежний режим. Старые снимки и результаты не переписываются; откат выбирает прежний профиль.
