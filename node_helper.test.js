/* Tests for node_helper.js: Tempest obs_st + Better Forecast -> Ambient-style payload. */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("module");

const HELPER_PATH = path.join(__dirname, "..", "node_helper.js");
const MIN = 60 * 1000;

function makeHelper() {
  const src = fs.readFileSync(HELPER_PATH, "utf8");
  const script = vm.runInThisContext(Module.wrap(src), { filename: HELPER_PATH });
  const fakeModule = { exports: {} };
  const fakeRequire = (request) => {
    if (request === "node_helper") return { create: (obj) => obj };
    if (request === "logger") return { info() {}, log() {}, warn() {}, error() {} };
    return require(request);
  };
  script(fakeModule.exports, fakeRequire, fakeModule, HELPER_PATH, path.dirname(HELPER_PATH));
  const notifications = [];
  const helper = Object.assign({}, fakeModule.exports, {
    name: "MMM-GlassTempest",
    sendSocketNotification: (n, p) => notifications.push({ n, p })
  });
  helper.start();
  helper.config = { token: "t", deviceId: "1", stationId: "2", units: "imperial", forecastDays: 3 };
  const last = (name) => [...notifications].reverse().find((x) => x.n === name);
  return { helper, notifications, last };
}

// obs_st: time lull avg gust dir sample pressure temp RH lux UV solar rain type strikeKm strikes battery interval
function obs(overrides = {}) {
  const o = Object.assign(
    { time: Math.floor(Date.now() / 1000), avg: 4, gust: 7, dir: 270, pressure: 980, tempC: 20, rh: 50, uv: 3, solar: 400, rain: 0, strikeKm: 0, strikes: 0 },
    overrides
  );
  return [o.time, 1, o.avg, o.gust, o.dir, 3, o.pressure, o.tempC, o.rh, 50000, o.uv, o.solar, o.rain, 0, o.strikeKm, o.strikes, 2.6, 1];
}

const restData = (extra = {}) => ({
  current_conditions: Object.assign(
    {
      air_temperature: 68, relative_humidity: 50, wind_avg: 9, wind_direction: 270,
      sea_level_pressure: 1013, station_pressure: 980, pressure_trend: "rising",
      feels_like: 66, uv: 3, solar_radiation: 400, precip_accum_local_day: 0.12,
      conditions: "Partly Cloudy", icon: "partly-cloudy-day"
    },
    extra
  ),
  forecast: {
    daily: [
      { day_start_local: 1795500000, air_temp_high: 70, air_temp_low: 50, conditions: "Sunny", icon: "clear-day", precip_probability: 10, sunrise: 1795520000, sunset: 1795560000 },
      { day_start_local: 1795586400, air_temp_high: 60, air_temp_low: 40, conditions: "Rain", icon: "possibly-rainy-day", precip_probability: 70 }
    ]
  }
});

test("a live observation becomes an Ambient-style payload", () => {
  const { helper, last } = makeHelper();
  helper._onObservation(obs());
  const p = last("TEMPEST_DATA").p.lastData;
  assert.ok(Math.abs(p.tempf - 68) < 0.01);
  assert.equal(p.humidity, 50);
  assert.ok(Math.abs(p.windspeedmph - 4 * 2.236936) < 0.01);
  assert.equal(p.winddir, 270);
  assert.equal(p.uv, 3);
  assert.equal(p.lightning_day, 0);
  assert.equal(p.lightning_hour, 0);
  assert.equal(p.baromrelin, undefined, "no sea-level pressure until REST supplies the offset");
});

test("REST adds sea-level pressure, trend, feels-like, sun times and condition", () => {
  const { helper, last } = makeHelper();
  helper._onObservation(obs());
  helper._onForecast(restData());
  const p = last("TEMPEST_DATA").p.lastData;
  assert.ok(Math.abs(p.baromrelin - 1013 * 0.0295299830714) < 0.001);
  assert.equal(p.pressureTrend, "rising");
  assert.ok(Math.abs(p.feelsLike - 66) < 0.01);
  assert.equal(p.condition, "partly_cloudy");
  assert.equal(p.dailyrainin, 0.12);
  assert.ok(p.sunrise && p.sunset);
});

test("live station pressure is shifted by the REST sea-level offset", () => {
  const { helper, last } = makeHelper();
  helper._onForecast(restData()); // offset = 33 mb
  helper._onObservation(obs({ pressure: 990 }));
  const p = last("TEMPEST_DATA").p.lastData;
  assert.ok(Math.abs(p.baromrelin - 1023 * 0.0295299830714) < 0.001);
});

test("forecast items are converted and mapped to animation keys", () => {
  const { helper, last } = makeHelper();
  helper._onForecast(restData());
  const f = last("TEMPEST_FORECAST").p.forecast;
  assert.equal(f.length, 2);
  assert.equal(f[0].cond, "clear");
  assert.equal(f[1].cond, "rain");
  assert.equal(f[1].precip, 70);
  assert.equal(f[0].high, 70);
  helper.config.units = "metric";
  assert.ok(Math.abs(helper._forecastItems()[0].high - 21.11) < 0.01);
});

test("rain accumulates over the last hour only", () => {
  const { helper, last } = makeHelper();
  const t = Math.floor(Date.now() / 1000);
  helper._onObservation(obs({ time: t - 70 * 60, rain: 5 }));
  helper._onObservation(obs({ time: t - 60, rain: 2.54 }));
  helper._onObservation(obs({ time: t, rain: 2.54 }));
  const p = last("TEMPEST_DATA").p.lastData;
  assert.ok(Math.abs(p.hourlyrainin - 0.2) < 0.001);
});

test("a replayed observation is not counted twice", () => {
  const { helper, last } = makeHelper();
  const t = Math.floor(Date.now() / 1000);
  helper._onObservation(obs({ time: t, rain: 2.54 }));
  helper._onObservation(obs({ time: t, rain: 2.54 }));
  assert.ok(Math.abs(last("TEMPEST_DATA").p.lastData.hourlyrainin - 0.1) < 0.001);
});

test("lightning strikes are counted and the last strike distance is converted to miles", () => {
  const { helper, last } = makeHelper();
  const t = Math.floor(Date.now() / 1000);
  helper._onObservation(obs({ time: t - 60, strikes: 2, strikeKm: 10 }));
  helper._onObservation(obs({ time: t, strikes: 1, strikeKm: 5 }));
  const p = last("TEMPEST_DATA").p.lastData;
  assert.equal(p.lightning_hour, 3);
  assert.equal(p.lightning_day, 3);
  assert.equal(p.lightning_time, t * 1000);
  assert.ok(Math.abs(p.lightning_distance - 5 * 0.621371192) < 0.001);
});

test("implausible observations are ignored", () => {
  const { helper, notifications } = makeHelper();
  helper._onObservation(obs({ tempC: 500 }));
  helper._handleMessage("not json");
  helper._handleMessage(JSON.stringify({ type: "obs_st", obs: [[1, 2]] }));
  assert.equal(notifications.length, 0);
});

test("obs_st websocket messages are routed to _onObservation", () => {
  const { helper, last } = makeHelper();
  helper._handleMessage(JSON.stringify({ type: "obs_st", obs: [obs()] }));
  assert.ok(last("TEMPEST_DATA"));
});

test("missing credentials produce a CONFIG error", () => {
  const { helper, last } = makeHelper();
  helper._initialize({ token: "", deviceId: "", stationId: "" });
  assert.equal(last("TEMPEST_ERROR").p.code, "CONFIG");
});

test("_conditionFromIcon maps Tempest icon names", () => {
  const { helper } = makeHelper();
  assert.equal(helper._conditionFromIcon("possibly-thunderstorm-night"), "thunderstorm");
  assert.equal(helper._conditionFromIcon("foggy"), "fog");
  assert.equal(helper._conditionFromIcon("cloudy"), "cloud");
  assert.equal(helper._conditionFromIcon("clear-night"), "clear");
  assert.equal(helper._conditionFromIcon(undefined), null);
});

test("the dew point is plausible", () => {
  const { helper } = makeHelper();
  assert.ok(Math.abs(helper._dewPointF(20, 50) - 48.7) < 0.3);
});
