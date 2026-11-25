/* Front-end tests for MMM-GlassTempest.js (minimal fake DOM, no browser). */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODULE_PATH = path.join(__dirname, "..", "MMM-GlassTempest.js");
const MIN = 60 * 1000;

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._classes = new Set();
    this.textContent = "";
    this.innerHTML = "";
    this.id = "";
    this.style = { setProperty() {} };
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c)
    };
  }
  get className() {
    return [...this._classes].join(" ");
  }
  set className(v) {
    this._classes = new Set(`${v}`.split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
  }
}

function setup(overrides = {}) {
  const body = new FakeElement("body");
  const sent = [];
  const notes = [];
  const sandbox = {
    Module: { register: (n, d) => (sandbox.def = d) },
    Log: { info() {}, log() {}, warn() {}, error() {} },
    window: undefined,
    navigator: undefined,
    console,
    document: { body, createElement: (t) => new FakeElement(t) },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, "utf8"), sandbox, { filename: MODULE_PATH });
  const m = Object.assign({}, sandbox.def, {
    name: "MMM-GlassTempest",
    identifier: "module_1_MMM-GlassTempest",
    config: Object.assign({}, sandbox.def.defaults, { animateIcons: false, token: "t", deviceId: "1", stationId: "2" }, overrides),
    sendSocketNotification: (n, p) => sent.push({ n, p }),
    sendNotification: (n, p) => notes.push({ n, p }),
    updateDom() {},
    file: (f) => f
  });
  m.start();
  m.isDomReady = true;
  return { m, sent, notes, body };
}

function text(el) {
  let out = `${el.className} ${el.textContent} ${el.innerHTML}`;
  el.children.forEach((c) => (out += ` ${text(c)}`));
  return out;
}

test("start sends TEMPEST_INIT with the WeatherFlow credentials", () => {
  const { sent } = setup();
  const init = sent.find((x) => x.n === "TEMPEST_INIT");
  assert.ok(init);
  assert.equal(init.p.token, "t");
  assert.equal(init.p.deviceId, "1");
  assert.equal(init.p.stationId, "2");
});

test("TEMPEST_DATA renders the card and broadcasts conditions", () => {
  const { m, notes } = setup();
  m.socketNotificationReceived("TEMPEST_DATA", {
    lastData: { tempf: 68, humidity: 50, windspeedmph: 9, winddir: 270, baromrelin: 29.9, pressureTrend: "rising", condition: "rain", feelsLike: 66, uv: 3, lightning_day: 0, lightning_hour: 0 }
  });
  const html = text(m.getDom());
  assert.match(html, /68\.0/);
  assert.match(html, /Humidity: 50%/);
  assert.match(html, /Wind: 9\.0 mph \(W\)/);
  assert.match(html, /Pressure: 29\.90 inHg \(Rising\)/);
  assert.match(html, /fa-cloud-rain/);
  assert.ok(notes.find((x) => x.n === "AMBIENT_WEATHER_DATA"));
});

test("WeatherFlow's current condition is used unless the gauge measures rain", () => {
  const { m } = setup();
  assert.equal(m._currentCondition({ tempf: 60, humidity: 50, condition: "partly_cloudy" }), "partly_cloudy");
  assert.equal(m._currentCondition({ tempf: 60, humidity: 50, condition: "clear", hourlyrainin: 0.5 }), "rain");
  assert.equal(m._currentCondition({ tempf: 60, humidity: 50 }), "cloud", "heuristic fallback");
});

test("forecast items render with the precipitation chance", () => {
  const { m } = setup({ forecastDays: 2 });
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 68, humidity: 50 } });
  m.socketNotificationReceived("TEMPEST_FORECAST", {
    forecast: [
      { date: "2026-11-24T06:00:00Z", high: 70, low: 50, phrase: "Sunny", cond: "clear", precip: 10, isDaytime: true },
      { date: "2026-11-25T06:00:00Z", high: 60, low: 40, phrase: "Rain", cond: "rain", precip: 70, isDaytime: true }
    ]
  });
  const html = text(m.getDom());
  assert.match(html, /2-Day Forecast/);
  assert.match(html, /70°/);
  assert.match(html, /70%/);
});

test("errors show a readable message until data arrives", () => {
  const { m } = setup();
  m.socketNotificationReceived("TEMPEST_ERROR", { code: "AUTH", message: "x" });
  assert.match(text(m.getDom()), /rejected the token/);
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 70 } });
  assert.doesNotMatch(text(m.getDom()), /rejected the token/);
});

test("a new strike in the data stream raises the notification and the banner", () => {
  const { m, notes, body } = setup();
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 70, lightning_day: 0, lightning_hour: 0 } });
  m.socketNotificationReceived("TEMPEST_DATA", {
    lastData: { tempf: 70, lightning_day: 1, lightning_hour: 1, lightning_time: Date.now(), lightning_distance: 3 }
  });
  assert.equal(notes.filter((x) => x.n === "AMBIENT_LIGHTNING").length, 1);
  const banner = body.children.find((c) => c.classList.contains("gt-lightning-alert"));
  assert.ok(banner);
  assert.ok(banner.classList.contains("gt-lightning-danger"));
});

test("the first packet only baselines the lightning counters", () => {
  const { m, notes } = setup();
  m.socketNotificationReceived("TEMPEST_DATA", {
    lastData: { tempf: 70, lightning_day: 5, lightning_hour: 2, lightning_time: Date.now() - MIN }
  });
  assert.equal(notes.filter((x) => x.n === "AMBIENT_LIGHTNING").length, 0);
});

test("metric units convert temperature and wind", () => {
  const { m } = setup({ units: "metric" });
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 212, windspeedmph: 10, winddir: 0, humidity: 40 } });
  const html = text(m.getDom());
  assert.match(html, /100\.0/);
  assert.match(html, /16\.1 km\/h/);
});

test("reduced motion adds the class that stops the background animation", () => {
  const { m } = setup({ reduceMotion: true });
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 70 } });
  assert.ok(m.getDom().classList.contains("gt-reduced"));
  const full = setup({ reduceMotion: false, performanceProfile: "full" });
  full.m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 70 } });
  assert.ok(!full.m.getDom().classList.contains("gt-reduced"));
});

test("dayMode: day / night are fixed; none leaves it to the theme", () => {
  assert.ok(setup({ dayMode: "day" }).m.getDom().classList.contains("gt-light"));
  assert.ok(!setup({ dayMode: "night" }).m.getDom().classList.contains("gt-light"));
  const { m } = setup();
  assert.equal(m.isDay, null);
  assert.ok(!m.getDom().classList.contains("gt-light"));
});

test("dayMode auto follows the station's own sunrise and sunset, card and banner", () => {
  const { m, body } = setup({ dayMode: "auto" });
  const now = Date.now();
  // Sun up: sunrise an hour ago, sunset in an hour
  m.socketNotificationReceived("TEMPEST_DATA", {
    lastData: { tempf: 60, lightning_day: 0, lightning_hour: 0,
      sunrise: new Date(now - 60 * MIN).toISOString(), sunset: new Date(now + 60 * MIN).toISOString() }
  });
  assert.equal(m.isDay, true);
  const card = m.getDom();
  assert.ok(card.classList.contains("gt-light"));
  // A strike while it is light: the banner gets the light look too
  m.socketNotificationReceived("TEMPEST_DATA", {
    lastData: { tempf: 60, lightning_day: 1, lightning_hour: 1, lightning_time: now, lightning_distance: 20,
      sunrise: new Date(now - 60 * MIN).toISOString(), sunset: new Date(now + 60 * MIN).toISOString() }
  });
  const banner = body.children.find((c) => c.classList.contains("gt-lightning-alert"));
  assert.ok(banner.classList.contains("gt-light"));
  // Sunset has passed: the live card and banner flip back without a re-render
  m.weatherData.sunset = new Date(now - 1 * MIN).toISOString();
  m.weatherData.sunrise = new Date(now - 10 * 60 * MIN).toISOString();
  m._updateDayMode();
  assert.equal(m.isDay, false);
  assert.ok(!card.classList.contains("gt-light"));
  assert.ok(!banner.classList.contains("gt-light"));
});

test("dayMode auto uses dayStart/dayEnd until sun times are known", () => {
  const { m } = setup({ dayMode: "auto", dayStart: "07:00", dayEnd: "19:00" });
  assert.equal(m._computeIsDay(new Date(2026, 10, 24, 6, 59)), false);
  assert.equal(m._computeIsDay(new Date(2026, 10, 24, 12, 0)), true);
  assert.equal(m._computeIsDay(new Date(2026, 10, 24, 19, 0)), false);
});

test("the lightning row shows only today's strikes", () => {
  const { m } = setup();
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 70, lightning_day: 3, lightning_hour: 2 } });
  const html = text(m.getDom());
  assert.match(html, /Lightning: 3 strikes today/);
  assert.doesNotMatch(html, /last hr/);
});

test("the strike banner no longer reports a last-hour count", () => {
  const { m, body } = setup();
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 70, lightning_day: 0, lightning_hour: 0 } });
  m.socketNotificationReceived("TEMPEST_DATA", {
    lastData: { tempf: 70, lightning_day: 4, lightning_hour: 4, lightning_time: Date.now(), lightning_distance: 3 }
  });
  const banner = body.children.find((c) => c.classList.contains("gt-lightning-alert"));
  assert.ok(banner);
  assert.doesNotMatch(text(banner), /last hour/);
});

test("rain today is shown in inches, or millimetres when metric", () => {
  const imperial = setup();
  imperial.m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 60, dailyrainin: 0.12 } });
  assert.match(text(imperial.m.getDom()), /Rain today: 0\.12 in/);
  const metric = setup({ units: "metric" });
  metric.m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 60, dailyrainin: 0.2 } });
  assert.match(text(metric.m.getDom()), /Rain today: 5\.1 mm/);
});

test("rain today shows a dash until the daily total arrives, and can be switched off", () => {
  const { m } = setup();
  m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 60 } });
  assert.match(text(m.getDom()), /Rain today: -/);
  const off = setup({ showRainToday: false });
  off.m.socketNotificationReceived("TEMPEST_DATA", { lastData: { tempf: 60, dailyrainin: 0.12 } });
  assert.doesNotMatch(text(off.m.getDom()), /Rain today/);
});
