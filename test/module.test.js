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
