import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  carLabel,
  carList,
  directionOf,
  formationAt,
  servingParts,
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
const hayabusaKomachi = data.trains["hayabusa-komachi"];
const west = data.routes["tokaido-sanyo-kyushu"];
const run = (args) => recommend({ data, seatClass: "any", smokeBefore: true, smokeAfter: true, ...args });

test("データ整合性: 駅ID重複なし・各駅がちょうど1つの路線グループに属する・系統の駅が存在する", () => {
  const ids = data.stations.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const grouped = data.lines.flatMap((l) => l.stations);
  assert.deepEqual([...grouped].sort(), [...ids].sort());
  for (const [id, route] of Object.entries(data.routes)) {
    assert.equal(new Set(route.stations).size, route.stations.length, `${id}: 駅の重複`);
    for (const s of route.stations) assert.ok(byId(s), `${id}: 駅 ${s}`);
    assert.ok(route.directions.up && route.directions.down, `${id}: directions`);
  }
});

test("データ整合性: 喫煙所の出典・信頼度・編成別の号車が正しい", () => {
  // 編成キー（両数）ごとに、その編成に実在する号車の範囲。こまちの7両は11〜17号車
  const carsByFormation = new Map();
  for (const t of Object.values(data.trains)) {
    const entries = [[String(carList(t).length), carList(t)]];
    if (t.parts.length > 1) for (const p of t.parts) entries.push([String(p.cars[1] - p.cars[0] + 1), p.cars]);
    for (const [key, cars] of entries) {
      const [lo, hi] = [Math.min(...cars), Math.max(...cars)];
      const prev = carsByFormation.get(key) ?? [Infinity, -Infinity];
      carsByFormation.set(key, [Math.min(prev[0], lo), Math.max(prev[1], hi)]);
    }
  }
  for (const s of data.stations) {
    for (const r of s.rooms) {
      assert.ok(r.sources.length > 0, `${s.id}: 出典なし`);
      for (const src of r.sources) assert.ok(data.sources[src], `${s.id}: 出典 ${src} がありません`);
      assert.ok(["official", "unverified", "conflict"].includes(r.verification), `${s.id}: verification`);
      assert.ok(["platform", "concourse", "unknown"].includes(r.kind), `${s.id}: kind ${r.kind}`);
      if (r.kind === "unknown") assert.ok(r.note, `${s.id}: 場所未確認の喫煙所には説明が必要`);
      if (r.kind !== "platform") continue;
      assert.ok(["up", "down", "both"].includes(r.direction), `${s.id}: direction`);
      for (const [formation, car] of Object.entries(r.cars)) {
        assert.ok(carsByFormation.has(formation), `${s.id}: 編成キー ${formation} の列車がありません`);
        if (car === null) continue;
        // 号車の間は .5 で表す
        const [lo, hi] = carsByFormation.get(formation);
        assert.ok(Number.isInteger(car * 2) && car >= lo && car <= hi, `${s.id}: ${formation}両 ${car}`);
      }
    }
  }
});

test("データ整合性: 列車の号車・運転区間・連結区間・座席が正しい", () => {
  for (const [id, t] of Object.entries(data.trains)) {
    const cars = carList(t);
    assert.deepEqual(cars, cars.map((_, i) => i + 1), `${id}: 号車は1から連番`);
    for (const p of t.parts) {
      const route = data.routes[p.route];
      assert.ok(route, `${id}: 系統 ${p.route}`);
      for (const end of p.range) assert.ok(route.stations.includes(end), `${id}: 区間 ${end}`);
      if (t.coupled) for (const end of t.coupled) assert.ok(route.stations.includes(end), `${id}: 連結区間 ${end}`);
    }
    assert.equal(Boolean(t.coupled), t.parts.length > 1, `${id}: 併結列車だけが連結区間を持つ`);
    for (const car of [...t.unreserved, ...t.green, ...t.granclass, ...(t.reserved ?? [])]) {
      assert.ok(cars.includes(car), `${id}: car ${car}`);
    }
    for (const src of t.sources) assert.ok(data.sources[src], `${id}: 出典 ${src}`);
  }
});

test("進行方向: 東京→新大阪は下り、博多→名古屋は上り", () => {
  assert.equal(directionOf(west, "tokyo", "shinosaka"), "down");
  assert.equal(directionOf(west, "hakata", "nagoya"), "up");
  assert.throws(() => directionOf(west, "tokyo", "tokyo"));
});

test("進行方向: 東京で分かれる路線は系統ごとに判定する", () => {
  assert.equal(directionOf(data.routes.tohoku, "tokyo-east", "sendai"), "down");
  assert.equal(directionOf(data.routes.akita, "akita", "omiya"), "up");
  assert.equal(directionOf(data.routes.hokuriku, "takasaki", "kanazawa"), "down");
  assert.equal(directionOf(data.routes.joetsu, "niigata", "takasaki"), "up");
  // 高崎は上越・北陸の両方にあるが、新潟と金沢を結ぶ系統はない
  assert.throws(() => directionOf(data.routes.joetsu, "niigata", "kanazawa"));
});

test("東京駅は東海道と東北・上越・北陸で別の駅として扱い、直通列車はない", () => {
  assert.notEqual(byId("tokyo").name, byId("tokyo-east").name);
  for (const t of Object.values(data.trains)) {
    assert.equal(trainServes(data, t, "tokyo", "sendai"), false);
    assert.equal(trainServes(data, t, "tokyo-east", "shinosaka"), false);
  }
});

test("名古屋: 上りは9号車、下りは16号車の喫煙所のみ対象", () => {
  assert.deepEqual(stationProfile(byId("nagoya"), "up", "16").knownGroups.flatMap((g) => g.cars), [9]);
  assert.deepEqual(stationProfile(byId("nagoya"), "down", "16").knownGroups.flatMap((g) => g.cars), [16]);
});

test("東京: 番線不明なので番線グループの平均距離を使う", () => {
  const p = stationProfile(byId("tokyo"), "down", "16");
  assert.equal(p.knownGroups.length, 3);
  // 11号車: 14・15番線=0, 16・17番線=2, 18・19番線=2 → 平均 4/3
  assert.equal(carDistance(p, 11), 4 / 3);
});

test("コンコースのみ・データなし・場所未確認の駅は号車距離なし", () => {
  assert.equal(carDistance(stationProfile(byId("shinosaka"), "down", "16"), 5), null);
  assert.equal(carDistance(stationProfile(byId("himeji"), "down", "16"), 5), null);
  assert.equal(stationProfile(byId("himeji"), "down", "16").hasData, false);
  const tsuruga = stationProfile(byId("tsuruga"), "down", "12");
  assert.equal(carDistance(tsuruga, 5), null);
  assert.equal(tsuruga.unlocated.length, 1);
});

test("号車未確認の喫煙所は距離計算から除外", () => {
  assert.equal(carDistance(stationProfile(byId("kokura"), "up", "16"), 5), null);
});

test("座席種別で候補号車を絞り込む", () => {
  assert.deepEqual(carsForClass(nozomi, "green"), [8, 9, 10]);
  assert.deepEqual(carsForClass(nozomi, "unreserved"), [1, 2]);
  assert.deepEqual(carsForClass(nozomi, "reserved"), [3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(carsForClass(nozomi, "granclass"), []);
  // 8両編成の6号車は半室グリーン・半室指定
  assert.deepEqual(carsForClass(sakura, "green"), [6]);
  assert.deepEqual(carsForClass(sakura, "reserved"), [4, 5, 6, 7, 8]);
  assert.deepEqual(carsForClass(sakura, "any"), [1, 2, 3, 4, 5, 6, 7, 8]);
  // グランクラス・グリーン車は指定席から除く
  assert.deepEqual(carsForClass(hayabusaKomachi, "granclass"), [10]);
  assert.deepEqual(carsForClass(hayabusaKomachi, "green"), [9, 11]);
  assert.deepEqual(carsForClass(hayabusaKomachi, "reserved"), [1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17]);
});

test("静岡→名古屋(下り)の乗車前・降車後: 両駅16号車なので16号車が最良", () => {
  const r = run({ fromId: "shizuoka", toId: "nagoya", trainId: "hikari", seatClass: "reserved" });
  assert.equal(r.ranked[0].car, 16);
  assert.equal(r.ranked[0].cost, 0);
});

test("名古屋→東京(上り)の乗車前のみ: 指定席なら7号車が最良(9号車はグリーン)", () => {
  const r = run({ fromId: "nagoya", toId: "tokyo", trainId: "nozomi", seatClass: "reserved", smokeAfter: false });
  assert.equal(r.ranked[0].car, 7);
  assert.equal(r.ranked[0].arrDist, null);
});

test("コンコース駅同士なら号車による差なし", () => {
  assert.equal(run({ fromId: "shinagawa", toId: "kyoto", trainId: "nozomi" }).carMatters, false);
});

test("デッキ側の目安は隣の号車番号で表す", () => {
  assert.equal(deckSide(12, 16), "13号車寄り");
  assert.equal(deckSide(12, 9), "11号車寄り");
  assert.equal(deckSide(9, 9), "同じ号車付近");
  assert.equal(deckSide(8, 8.5), "同じ号車付近");
  assert.equal(deckSide(8, 9.5), "9号車寄り");
});

test("号車の間にある喫煙所は「8〜9号車」と表す", () => {
  assert.equal(carLabel(8.5), "8〜9号車");
  assert.equal(carLabel(12), "12号車");
});

test("運転区間: さくらは東京に行かず、のぞみは熊本に行かない", () => {
  assert.equal(trainServes(data, sakura, "shinosaka", "kumamoto"), true);
  assert.equal(trainServes(data, sakura, "tokyo", "hakata"), false);
  assert.equal(trainServes(data, nozomi, "tokyo", "kumamoto"), false);
  assert.throws(() => run({ fromId: "tokyo", toId: "hakata", trainId: "sakura" }));
});

test("編成別の号車: 博多12番線は16両なら12号車、8両なら8号車", () => {
  const hakata = byId("hakata");
  const p16 = stationProfile(hakata, "down", "16");
  const p8 = stationProfile(hakata, "up", "8");
  assert.deepEqual(p16.knownGroups.find((g) => g.tracks.join() === "12").cars, [12]);
  assert.deepEqual(p8.knownGroups.find((g) => g.tracks.join() === "12").cars, [8]);
  // 8両での位置が未確認の番線は距離計算から外し、未確認として残す
  assert.deepEqual(p8.unknownGroups.map((g) => g.tracks.join("・")), ["13・14", "15・16"]);
});

test("博多→新大阪のさくら(自由席除く): 博多の喫煙所に近い8号車が最良", () => {
  const r = run({ fromId: "hakata", toId: "shinosaka", trainId: "sakura", seatClass: "reserved" });
  assert.equal(r.ranked[0].car, 8);
  assert.equal(r.carMatters, true);
});

test("16両の位置しか分からない駅は8両編成では号車差なし扱い", () => {
  const r = run({ fromId: "hiroshima", toId: "kumamoto", trainId: "mizuho" });
  assert.equal(r.carMatters, false);
  assert.ok(r.dep.unknownGroups.length > 0);
});

test("併結列車: 行き先によって乗れる号車が変わる", () => {
  const carsOf = (from, to) => servingParts(data, hayabusaKomachi, from, to).flatMap((p) => p.name);
  assert.deepEqual(carsOf("tokyo-east", "sendai"), ["はやぶさ", "こまち"]);
  assert.deepEqual(carsOf("tokyo-east", "akita"), ["こまち"]);
  assert.deepEqual(carsOf("sendai", "shinaomori"), ["はやぶさ"]);
  assert.deepEqual(carsOf("shinaomori", "akita"), []);
  const r = run({ fromId: "tokyo-east", toId: "akita", trainId: "hayabusa-komachi" });
  assert.deepEqual(r.ranked.map((c) => c.car).sort((a, b) => a - b), [11, 12, 13, 14, 15, 16, 17]);
});

test("併結列車: 連結区間の駅は17両、切り離し後の駅は各部分の両数で号車を引く", () => {
  const [hayabusa, komachi] = hayabusaKomachi.parts;
  assert.equal(formationAt(data, hayabusaKomachi, hayabusa, "sendai"), "17");
  assert.equal(formationAt(data, hayabusaKomachi, komachi, "morioka"), "17");
  assert.equal(formationAt(data, hayabusaKomachi, komachi, "akita"), "7");
  assert.equal(formationAt(data, hayabusaKomachi, hayabusa, "shinaomori"), "10");
  assert.equal(formationAt(data, data.trains.hayabusa, data.trains.hayabusa.parts[0], "sendai"), "10");
});

test("停車位置が編成でずれる駅: 白石蔵王は17両なら8号車、10両なら6号車", () => {
  const station = byId("shiroishizao");
  assert.deepEqual(stationProfile(station, "up", "17").knownGroups.flatMap((g) => g.cars), [8]);
  assert.deepEqual(stationProfile(station, "up", "10").knownGroups.flatMap((g) => g.cars), [6]);
  // 下りホームには無い
  assert.equal(stationProfile(station, "down", "17").hasData, true);
  assert.equal(stationProfile(station, "down", "17").trackGroups.length, 0);
});

test("盛岡→秋田のこまち: 秋田の16号車付近の喫煙所に近い号車が最良", () => {
  const r = run({ fromId: "morioka", toId: "akita", trainId: "hayabusa-komachi", smokeBefore: false });
  assert.equal(r.arr.formation, "7");
  assert.equal(r.ranked[0].car, 16);
  assert.equal(r.ranked[0].arrDist, 0);
});

test("東京→盛岡のはやぶさ＋こまち(乗車前・降車後): 両駅の喫煙所に近いこまちの13号車", () => {
  const r = run({ fromId: "tokyo-east", toId: "morioka", trainId: "hayabusa-komachi", seatClass: "reserved" });
  // 東京: 20・21番線[1,14]→1, 22・23番線[11,13]→0 で平均0.5 / 盛岡: [3,13]→0
  assert.equal(r.ranked[0].car, 13);
  assert.equal(r.ranked[0].cost, 0.5);
});

test("10両のはやぶさは盛岡の位置が未確認なので、東京の1号車付近だけで判定する", () => {
  const r = run({ fromId: "tokyo-east", toId: "morioka", trainId: "hayabusa", seatClass: "reserved" });
  assert.equal(r.dep.formation, "10");
  assert.deepEqual(r.dep.unknownGroups.map((g) => g.tracks.join("・")), ["22・23"]);
  assert.equal(r.arr.knownGroups.length, 0);
  assert.equal(r.ranked[0].car, 1);
});

test("号車の間の喫煙所: 上田→東京のあさまは8号車・9号車が同じくらい近い", () => {
  const r = run({ fromId: "ueda", toId: "tokyo-east", trainId: "asama", seatClass: "reserved", smokeAfter: false });
  assert.deepEqual(r.ranked.slice(0, 2).map((c) => [c.car, c.depDist]), [[8, 0.5], [9, 0.5]]);
});

test("北陸新幹線: つるぎは富山〜敦賀のみ、あさまは長野より先に行かない", () => {
  const { tsurugi, asama } = data.trains;
  assert.equal(trainServes(data, tsurugi, "toyama", "tsuruga"), true);
  assert.equal(trainServes(data, tsurugi, "nagano", "kanazawa"), false);
  assert.equal(trainServes(data, asama, "tokyo-east", "nagano"), true);
  assert.equal(trainServes(data, asama, "tokyo-east", "toyama"), false);
});
