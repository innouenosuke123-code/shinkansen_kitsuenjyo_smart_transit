// 号車おすすめロジック（DOM非依存。ブラウザとNodeのテストで共用）

export const CAR_LENGTH_M = 25;
const WALK_SPEED_MPS = 1.2;

const range = ([first, last]) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

/** 編成全体の号車番号（1号車から最後尾まで、並び順どおり） */
export function carList(train) {
  return train.parts.flatMap((p) => range(p.cars));
}

function stationIndex(route, id) {
  const i = route.stations.indexOf(id);
  if (i < 0) throw new Error(`${route.name}に駅 ${id} がありません`);
  return i;
}

/** 路線系統の駅の並び順から進行方向を返す。down=東京から離れる方向（東海道〜九州は博多・鹿児島中央方面） */
export function directionOf(route, fromId, toId) {
  const from = stationIndex(route, fromId);
  const to = stationIndex(route, toId);
  if (from === to) throw new Error("乗車駅と降車駅が同じです");
  return to > from ? "down" : "up";
}

/** 系統の中で、駅が区間 [a, b]（両端を含む）に入っているか */
function withinRange(route, [a, b], id) {
  const i = route.stations.indexOf(id);
  if (i < 0) return false;
  const [lo, hi] = [stationIndex(route, a), stationIndex(route, b)].sort((x, y) => x - y);
  return i >= lo && i <= hi;
}

/** 列車のうち、その区間を走る部分（併結列車は、はやぶさ側・こまち側などで行き先が違う） */
export function servingParts(data, train, fromId, toId) {
  return train.parts.filter((p) => {
    const route = data.routes[p.route];
    return withinRange(route, p.range, fromId) && withinRange(route, p.range, toId);
  });
}

/** 列車がその区間を走るか（どこかの号車で乗り通せるか） */
export function trainServes(data, train, fromId, toId) {
  return servingParts(data, train, fromId, toId).length > 0;
}

/**
 * その駅に停まるときの編成の両数（喫煙所の号車を引くキー）。
 * 併結列車は連結区間の駅では全体の両数、切り離し後は各部分の両数になる。
 */
export function formationAt(data, train, part, stationId) {
  const total = carList(train).length;
  if (train.parts.length === 1) return String(total);
  const coupledHere = train.coupled && withinRange(data.routes[part.route], train.coupled, stationId);
  return String(coupledHere ? total : range(part.cars).length);
}

/**
 * 喫煙所の号車位置は編成の長さで変わる。`cars` は {"両数": 号車} で、出典に書かれた編成だけを持つ。
 * null は喫煙所はあるが号車が未確認。6.5 は「6号車と7号車の間」。
 */
export function roomCar(room, formation) {
  const car = room.cars?.[formation];
  return typeof car === "number" ? car : null;
}

/**
 * ある駅・進行方向・編成で使える喫煙所を番線グループ単位でまとめる。
 * 発着番線は事前に分からないことが多いので、グループごとに距離を出して平均する。
 */
export function stationProfile(station, direction, formation) {
  const platform = station.rooms.filter(
    (r) => r.kind === "platform" && (r.direction === "both" || r.direction === direction),
  );
  const groups = new Map();
  for (const room of platform) {
    const key = room.tracks.length ? room.tracks.join("・") : "";
    if (!groups.has(key)) groups.set(key, { tracks: room.tracks, rooms: [] });
    groups.get(key).rooms.push(room);
  }
  const trackGroups = [...groups.values()].map((g) => ({
    ...g,
    cars: g.rooms.map((r) => roomCar(r, formation)).filter((c) => c !== null),
  }));
  return {
    station,
    direction,
    formation,
    trackGroups,
    knownGroups: trackGroups.filter((g) => g.cars.length > 0),
    unknownGroups: trackGroups.filter((g) => g.cars.length === 0),
    concourse: station.rooms.filter((r) => r.kind === "concourse"),
    unlocated: station.rooms.filter((r) => r.kind === "unknown"),
    hasData: station.rooms.length > 0,
  };
}

/** その号車から最寄り喫煙所までの号車数（番線グループ平均）。号車データが無ければ null */
export function carDistance(profile, car) {
  if (profile.knownGroups.length === 0) return null;
  const perGroup = profile.knownGroups.map((g) => Math.min(...g.cars.map((c) => Math.abs(c - car))));
  return perGroup.reduce((a, b) => a + b, 0) / perGroup.length;
}

/** 最寄り喫煙所の号車（番線グループごと） */
export function nearestRoomCars(profile, car) {
  return profile.knownGroups.map((g) => {
    const nearest = g.cars.reduce((best, c) => (Math.abs(c - car) < Math.abs(best - car) ? c : best));
    return { tracks: g.tracks, car: nearest };
  });
}

export function walkEstimate(carDiff) {
  const meters = Math.round(carDiff * CAR_LENGTH_M);
  return { meters, seconds: Math.round(meters / WALK_SPEED_MPS) };
}

/** 喫煙所の号車を「6号車」「6〜7号車」のように表す */
export function carLabel(car) {
  return Number.isInteger(car) ? `${car}号車` : `${Math.floor(car)}〜${Math.ceil(car)}号車`;
}

/**
 * 号車から見て喫煙所がどちら側のデッキか（予約時のデッキ寄り座席の目安）。
 * 秋田新幹線は大曲で進行方向が変わるなど「東京寄り」では誤解を招くので、隣の号車番号で表す。
 */
export function deckSide(car, roomCar) {
  if (Math.abs(roomCar - car) < 1) return "同じ号車付近";
  return roomCar > car ? `${car + 1}号車寄り` : `${car - 1}号車寄り`;
}

export function carsForClass(train, seatClass) {
  const unreserved = new Set(train.unreserved);
  const green = new Set(train.green);
  const granclass = new Set(train.granclass ?? []);
  const cars = carList(train);
  switch (seatClass) {
    case "reserved":
      return train.reserved ?? cars.filter((c) => !unreserved.has(c) && !green.has(c) && !granclass.has(c));
    case "green":
      return cars.filter((c) => green.has(c));
    case "granclass":
      return cars.filter((c) => granclass.has(c));
    case "unreserved":
      return cars.filter((c) => unreserved.has(c));
    default:
      return cars;
  }
}

/**
 * @returns {{route, direction, train, parts, servingCars, dep, arr, ranked: Array<{car, cost, depDist, arrDist}>, carMatters: boolean}}
 */
export function recommend({ data, fromId, toId, trainId, seatClass, smokeBefore, smokeAfter }) {
  const train = data.trains[trainId];
  if (!train) throw new Error(`unknown train: ${trainId}`);
  const parts = servingParts(data, train, fromId, toId);
  if (parts.length === 0) throw new Error(`${train.name}はこの区間を走りません`);
  const routeId = parts[0].route;
  const direction = directionOf(data.routes[routeId], fromId, toId);
  const station = (id) => data.stations.find((s) => s.id === id);
  // 区間を乗り通せる号車は、どの駅でも同じ編成（連結中か切り離し後か）にそろう
  const dep = stationProfile(station(fromId), direction, formationAt(data, train, parts[0], fromId));
  const arr = stationProfile(station(toId), direction, formationAt(data, train, parts[0], toId));
  const servingCars = new Set(parts.flatMap((p) => range(p.cars)));

  const ranked = carsForClass(train, seatClass)
    .filter((car) => servingCars.has(car))
    .map((car) => {
      const depDist = smokeBefore ? carDistance(dep, car) : null;
      const arrDist = smokeAfter ? carDistance(arr, car) : null;
      return { car, depDist, arrDist, cost: (depDist ?? 0) + (arrDist ?? 0) };
    })
    .sort((a, b) => a.cost - b.cost || a.car - b.car);

  const carMatters = ranked.some((r) => r.depDist !== null || r.arrDist !== null);
  return { route: routeId, direction, train, parts, servingCars, dep, arr, ranked, carMatters };
}
