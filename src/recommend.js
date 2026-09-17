// 号車おすすめロジック（DOM非依存。ブラウザとNodeのテストで共用）

export const CAR_LENGTH_M = 25;
const WALK_SPEED_MPS = 1.2;

/** 1〜n の号車番号 */
export function carList(train) {
  return Array.from({ length: train.cars }, (_, i) => i + 1);
}

function stationIndex(stations, id) {
  const i = stations.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`unknown station: ${id}`);
  return i;
}

/** 駅の並び順から進行方向を返す。down=新大阪・博多・鹿児島中央方面, up=東京方面 */
export function directionOf(stations, fromId, toId) {
  const from = stationIndex(stations, fromId);
  const to = stationIndex(stations, toId);
  if (from === to) throw new Error("乗車駅と降車駅が同じです");
  return to > from ? "down" : "up";
}

/** 列車がその区間を走るか（運転区間の両端を含む） */
export function trainServes(stations, train, fromId, toId) {
  const [lo, hi] = [stationIndex(stations, train.range[0]), stationIndex(stations, train.range[1])];
  return [fromId, toId].every((id) => {
    const i = stationIndex(stations, id);
    return i >= lo && i <= hi;
  });
}

/**
 * 喫煙所の号車位置は編成の長さで変わる。
 * `car` は16両編成、`car8` は8両編成での号車。出典に無い編成は null（未確認）。
 */
export function roomCar(room, train) {
  const car = train.cars === 8 ? room.car8 : room.car;
  return Number.isInteger(car) ? car : null;
}

/**
 * ある駅・進行方向・編成で使える喫煙所を番線グループ単位でまとめる。
 * 発着番線は事前に分からないことが多いので、グループごとに距離を出して平均する。
 */
export function stationProfile(station, direction, train) {
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
    cars: g.rooms.map((r) => roomCar(r, train)).filter((c) => c !== null),
  }));
  return {
    station,
    direction,
    trackGroups,
    knownGroups: trackGroups.filter((g) => g.cars.length > 0),
    unknownGroups: trackGroups.filter((g) => g.cars.length === 0),
    concourse: station.rooms.filter((r) => r.kind === "concourse"),
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

/** 号車から見て喫煙所がどちら側か（予約時のデッキ寄り座席の目安）。号車番号が大きい側が上り方 */
export function deckSide(train, car, roomCar) {
  if (roomCar > car) return `${train.ends.up}寄り`;
  if (roomCar < car) return `${train.ends.down}寄り`;
  return "同じ号車付近";
}

export function carsForClass(train, seatClass) {
  const unreserved = new Set(train.unreserved);
  const green = new Set(train.green);
  switch (seatClass) {
    case "reserved":
      return train.reserved ?? carList(train).filter((c) => !unreserved.has(c) && !green.has(c));
    case "green":
      return carList(train).filter((c) => green.has(c));
    case "unreserved":
      return carList(train).filter((c) => unreserved.has(c));
    default:
      return carList(train);
  }
}

/**
 * @returns {{direction, train, dep, arr, ranked: Array<{car, cost, depDist, arrDist}>, carMatters: boolean}}
 */
export function recommend({ data, fromId, toId, trainId, seatClass, smokeBefore, smokeAfter }) {
  const { stations, trains } = data;
  const train = trains[trainId];
  if (!train) throw new Error(`unknown train: ${trainId}`);
  const direction = directionOf(stations, fromId, toId);
  if (!trainServes(stations, train, fromId, toId)) {
    throw new Error(`${train.name}はこの区間を走りません`);
  }
  const dep = stationProfile(stations.find((s) => s.id === fromId), direction, train);
  const arr = stationProfile(stations.find((s) => s.id === toId), direction, train);

  const ranked = carsForClass(train, seatClass)
    .map((car) => {
      const depDist = smokeBefore ? carDistance(dep, car) : null;
      const arrDist = smokeAfter ? carDistance(arr, car) : null;
      return { car, depDist, arrDist, cost: (depDist ?? 0) + (arrDist ?? 0) };
    })
    .sort((a, b) => a.cost - b.cost || a.car - b.car);

  const carMatters = ranked.some((r) => r.depDist !== null || r.arrDist !== null);
  return { direction, train, dep, arr, ranked, carMatters };
}
