import type { MatchData } from '../src/opendota/index.js';

export const fixtureOrigin = 'Обезличенная проекция реальных снимков; basic в тестах является производной фикстурой, не прежним ответом API.';
const fixtures = [
  {
    "sourceMatchId": 9044556864,
    "sourceDigest": "6f3d657884be3509a01cb8aa7dfb57b1bee1a1094e56cb7bf455b3c652533a30",
    "data": {
      "match_id": 9044556864,
      "start_time": 1791979844,
      "duration": 1513,
      "game_mode": 22,
      "lobby_type": 7,
      "radiant_win": true,
      "version": 22,
      "players": [
        {
          "player_slot": 0,
          "hero_id": 25,
          "kills": 15,
          "deaths": 1,
          "assists": 9,
          "hero_damage": 24873,
          "hero_healing": 0,
          "tower_damage": 7718
        },
        {
          "player_slot": 1,
          "hero_id": 71,
          "kills": 8,
          "deaths": 5,
          "assists": 23,
          "hero_damage": 11622,
          "hero_healing": 897,
          "tower_damage": 1714
        },
        {
          "player_slot": 2,
          "hero_id": 87,
          "kills": 3,
          "deaths": 5,
          "assists": 32,
          "hero_damage": 10647,
          "hero_healing": 0,
          "tower_damage": 239
        },
        {
          "player_slot": 3,
          "hero_id": 49,
          "kills": 6,
          "deaths": 5,
          "assists": 19,
          "hero_damage": 14592,
          "hero_healing": 0,
          "tower_damage": 8200
        },
        {
          "player_slot": 4,
          "hero_id": 12,
          "kills": 11,
          "deaths": 2,
          "assists": 10,
          "hero_damage": 19336,
          "hero_healing": 0,
          "tower_damage": 5169
        },
        {
          "player_slot": 128,
          "hero_id": 46,
          "kills": 3,
          "deaths": 9,
          "assists": 4,
          "hero_damage": 9872,
          "hero_healing": 0,
          "tower_damage": 0
        },
        {
          "player_slot": 129,
          "hero_id": 42,
          "kills": 3,
          "deaths": 8,
          "assists": 3,
          "hero_damage": 12203,
          "hero_healing": 0,
          "tower_damage": 1775
        },
        {
          "player_slot": 130,
          "hero_id": 52,
          "kills": 6,
          "deaths": 8,
          "assists": 5,
          "hero_damage": 20540,
          "hero_healing": 0,
          "tower_damage": 22
        },
        {
          "player_slot": 131,
          "hero_id": 31,
          "kills": 4,
          "deaths": 10,
          "assists": 3,
          "hero_damage": 9899,
          "hero_healing": 0,
          "tower_damage": 0
        },
        {
          "player_slot": 132,
          "hero_id": 75,
          "kills": 2,
          "deaths": 9,
          "assists": 8,
          "hero_damage": 10894,
          "hero_healing": 0,
          "tower_damage": 0
        }
      ]
    }
  },
  {
    "sourceMatchId": 9046778399,
    "sourceDigest": "ddf80c66734f540954e339c9bab72b174dffb31f5e48705ec966b416ea46f657",
    "data": {
      "match_id": 9046778399,
      "start_time": 1792098141,
      "duration": 2964,
      "game_mode": 22,
      "lobby_type": 7,
      "radiant_win": false,
      "version": 22,
      "players": [
        {
          "player_slot": 0,
          "hero_id": 120,
          "kills": 13,
          "deaths": 11,
          "assists": 13,
          "hero_damage": 39716,
          "hero_healing": 0,
          "tower_damage": 1394
        },
        {
          "player_slot": 1,
          "hero_id": 128,
          "kills": 3,
          "deaths": 9,
          "assists": 20,
          "hero_damage": 28558,
          "hero_healing": 1953,
          "tower_damage": 540
        },
        {
          "player_slot": 2,
          "hero_id": 8,
          "kills": 10,
          "deaths": 7,
          "assists": 16,
          "hero_damage": 47465,
          "hero_healing": 11065,
          "tower_damage": 9200
        },
        {
          "player_slot": 3,
          "hero_id": 31,
          "kills": 4,
          "deaths": 13,
          "assists": 25,
          "hero_damage": 19667,
          "hero_healing": 0,
          "tower_damage": 0
        },
        {
          "player_slot": 4,
          "hero_id": 135,
          "kills": 12,
          "deaths": 8,
          "assists": 17,
          "hero_damage": 34976,
          "hero_healing": 6960,
          "tower_damage": 794
        },
        {
          "player_slot": 128,
          "hero_id": 63,
          "kills": 25,
          "deaths": 9,
          "assists": 11,
          "hero_damage": 82208,
          "hero_healing": 0,
          "tower_damage": 14505
        },
        {
          "player_slot": 129,
          "hero_id": 87,
          "kills": 2,
          "deaths": 8,
          "assists": 35,
          "hero_damage": 17666,
          "hero_healing": 1800,
          "tower_damage": 459
        },
        {
          "player_slot": 130,
          "hero_id": 28,
          "kills": 6,
          "deaths": 9,
          "assists": 19,
          "hero_damage": 19899,
          "hero_healing": 0,
          "tower_damage": 2470
        },
        {
          "player_slot": 131,
          "hero_id": 17,
          "kills": 11,
          "deaths": 8,
          "assists": 21,
          "hero_damage": 41786,
          "hero_healing": 0,
          "tower_damage": 5123
        },
        {
          "player_slot": 132,
          "hero_id": 131,
          "kills": 4,
          "deaths": 9,
          "assists": 18,
          "hero_damage": 19740,
          "hero_healing": 125,
          "tower_damage": 294
        }
      ]
    }
  }
];

export const matchFixture = (index = 0): MatchData => structuredClone(fixtures[index].data);
