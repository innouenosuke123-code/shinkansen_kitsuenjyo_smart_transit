import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  directionOf,
  stationProfile,
  carDistance,
  deckSide,
  carsForClass,
  recommend,
  trainServes,
} from "../src/recommend.js";

const data = JSON.parse(readFileSync(new URL("../data/stations.json", import.meta.url), "utf8"));
const byId = (id) => data.stations.find((s) => s.id === id);
const { nozomi, sakura } = data.trains;

test("データ整合性: 駅ID重複なし・出典IDが存在・号車は編成の範囲内", () => {
  const ids = data.stations.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of data.stations) {
    for (const r of s.rooms) {
      for (const src of r.sources) assert.ok(data.sources[src], `${s.id}: 出典 ${src} がありません`);
      assert.ok(["official", "unverified", "conflict"].includes(r.verification), `${s.id}: verification`);
      if (r.kind === "platform") {
        for (const [key, max] of [["car", 16], ["car8", 8]]) {
          const car = r[key];
          if (car === null || car === undefined) continue;
          assert.ok(Number.isInteger(car) && car >= 1 && car <= max, `${s.id}: ${key} ${car}`);
        }
      }
    }
  }
});

test("データ整合性: 列車の運転区間・座席の号車が正しい", () => {
  for (const [id, t] of Object.entries(data.trains)) {
    for (const end of t.range) assert.ok(byId(end), `${id}: 区間 ${end}`);
    for (const car of [...t.unreserved, ...t.green, ...(t.reserved ?? [])]) {
      assert.ok(car >= 1 && car <= t.cars, `${id}: car ${car}`);
    }
    for (const src of t.sources) assert.ok(data.sources[src], `${id}: 出典 ${src}`);
  }
});

test("進行方向: 東京→新大阪は下り、博多→名古屋は上り", () => {
  assert.equal(directionOf(data.stations, "tokyo", "shinosaka"), "down");
  assert.equal(directionOf(data.stations, "hakata", "nagoya"), "up");
  assert.throws(() => directionOf(data.stations, "tokyo", "tokyo"));
});

test("名古屋: 上りは9号車、下りは16号車の喫煙所のみ対象", () => {
  assert.deepEqual(stationProfile(byId("nagoya"), "up", nozomi).knownGroups.flatMap((g) => g.cars), [9]);
  assert.deepEqual(stationProfile(byId("nagoya"), "down", nozomi).knownGroups.flatMap((g) => g.cars), [16]);
});

test("東京: 番線不明なので番線グループの平均距離を使う", () => {
  const p = stationProfile(byId("tokyo"), "down", nozomi);
  assert.equal(p.knownGroups.length, 3);
  // 11号車: 14・15番線=0, 16・17番線=2, 18・19番線=2 → 平均 4/3
  assert.equal(carDistance(p, 11), 4 / 3);
});

test("コンコースのみ・データなしの駅は号車距離なし", () => {
  assert.equal(carDistance(stationProfile(byId("shinosaka"), "down", nozomi), 5), null);
  assert.equal(carDistance(stationProfile(byId("himeji"), "down", nozomi), 5), null);
  assert.equal(stationProfile(byId("himeji"), "down", nozomi).hasData, false);
});

test("号車未確認の喫煙所は距離計算から除外", () => {
  assert.equal(carDistance(stationProfile(byId("kokura"), "up", nozomi), 5), null);
});

test("座席種別で候補号車を絞り込む", () => {
  assert.deepEqual(carsForClass(nozomi, "green"), [8, 9, 10]);
  assert.deepEqual(carsForClass(nozomi, "unreserved"), [1, 2]);
  assert.deepEqual(carsForClass(nozomi, "reserved"), [3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16]);
  // 8両編成の6号車は半室グリーン・半室指定
  assert.deepEqual(carsForClass(sakura, "green"), [6]);
  assert.deepEqual(carsForClass(sakura, "reserved"), [4, 5, 6, 7, 8]);
  assert.deepEqual(carsForClass(sakura, "any"), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("静岡→名古屋(下り)の乗車前・降車後: 両駅16号車なので16号車が最良", () => {
  const r = recommend({
    data, fromId: "shizuoka", toId: "nagoya", trainId: "hikari",
    seatClass: "reserved", smokeBefore: true, smokeAfter: true,
  });
  assert.equal(r.ranked[0].car, 16);
  assert.equal(r.ranked[0].cost, 0);
});

test("名古屋→東京(上り)の乗車前のみ: 指定席なら7号車が最良(9号車はグリーン)", () => {
  const r = recommend({
    data, fromId: "nagoya", toId: "tokyo", trainId: "nozomi",
    seatClass: "reserved", smokeBefore: true, smokeAfter: false,
  });
  assert.equal(r.ranked[0].car, 7);
  assert.equal(r.ranked[0].arrDist, null);
});

test("コンコース駅同士なら号車による差なし", () => {
  const r = recommend({
    data, fromId: "shinagawa", toId: "kyoto", trainId: "nozomi",
    seatClass: "any", smokeBefore: true, smokeAfter: true,
  });
  assert.equal(r.carMatters, false);
});

test("デッキ側の目安は編成ごとの両端の駅名で表す", () => {
  assert.equal(deckSide(nozomi, 12, 16), "東京寄り");
  assert.equal(deckSide(nozomi, 12, 9), "新大阪・博多寄り");
  assert.equal(deckSide(nozomi, 9, 9), "同じ号車付近");
  assert.equal(deckSide(sakura, 5, 8), "新大阪寄り");
});

test("運転区間: さくらは東京に行かず、のぞみは熊本に行かない", () => {
  assert.equal(trainServes(data.stations, sakura, "shinosaka", "kumamoto"), true);
  assert.equal(trainServes(data.stations, sakura, "tokyo", "hakata"), false);
  assert.equal(trainServes(data.stations, nozomi, "tokyo", "kumamoto"), false);
  assert.throws(() =>
    recommend({ data, fromId: "tokyo", toId: "hakata", trainId: "sakura", seatClass: "any", smokeBefore: true, smokeAfter: true }),
  );
});

test("8両編成は car8 を使う: 博多12番線は16両なら12号車、8両なら8号車", () => {
  const hakata = byId("hakata");
  const p16 = stationProfile(hakata, "down", nozomi);
  const p8 = stationProfile(hakata, "up", sakura);
  assert.deepEqual(p16.knownGroups.find((g) => g.tracks.join() === "12").cars, [12]);
  assert.deepEqual(p8.knownGroups.find((g) => g.tracks.join() === "12").cars, [8]);
  // 8両での位置が未確認の番線は距離計算から外し、未確認として残す
  assert.deepEqual(p8.unknownGroups.map((g) => g.tracks.join("・")), ["13・14", "15・16"]);
});

test("博多→新大阪のさくら(自由席除く): 博多の喫煙所に近い8号車が最良", () => {
  const r = recommend({
    data, fromId: "hakata", toId: "shinosaka", trainId: "sakura",
    seatClass: "reserved", smokeBefore: true, smokeAfter: true,
  });
  assert.equal(r.ranked[0].car, 8);
  assert.equal(r.carMatters, true);
});

test("16両の位置しか分からない駅は8両編成では号車差なし扱い", () => {
  const r = recommend({
    data, fromId: "hiroshima", toId: "kumamoto", trainId: "mizuho",
    seatClass: "any", smokeBefore: true, smokeAfter: true,
  });
  assert.equal(r.carMatters, false);
  assert.ok(r.dep.unknownGroups.length > 0);
});
