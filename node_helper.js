/* MagicMirror Module: MMM-GlassTempest - Node Helper
 *
 * Talks to WeatherFlow (Tempest):
 *   - live observations over the WebSocket API (obs_st, about one per minute)
 *   - current conditions, sea-level pressure/trend, feels-like, sun times and the daily forecast
 *     over the Better Forecast REST API
 * and merges both into one "Ambient-style" payload (tempf, humidity, windspeedmph, baromrelin,
 * lightning_day, ...) so the glass-card front end can render it.
 *
 * Needs Node.js 22+ (global WebSocket and fetch). No npm dependencies.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");

const WS_URL = "wss://ws.weatherflow.com/swd/data";
const FORECAST_URL = "https://swd.weatherflow.com/swd/rest/better_forecast";
const MINUTE = 60 * 1000;
const MPS_TO_MPH = 2.236936;
const MB_TO_INHG = 0.0295299830714;
const KM_TO_MI = 0.621371192;
const ERROR_THROTTLE_MS = 5 * MINUTE;
const FORECAST_TIMEOUT_MS = 15 * 1000;
const MAX_FORECAST_DAYS = 7;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inRange(n, min, max) {
  return n !== null && n >= min && n <= max ? n : null;
}

module.exports = NodeHelper.create({
  start() {
    Log.info(`[${this.name}] Node helper started.`);
    this.config = null;
    this.generation = 0; // bumped on every (re)initialisation; stale async results are dropped

    this.socket = null;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.forecastTimer = null;
    this.reconnectAttempts = 0;
    this.connectionStarted = 0;
    this.lastObservationTime = 0;
    this.forecastInFlight = false;
    this.errorSentAt = {};

    this.obs = null; // latest live observation (normalised)
    this.rest = null; // latest REST current conditions (normalised)
    this.forecast = null; // daily forecast, Fahrenheit
    this.sun = null; // { sunrise, sunset } ISO strings for today
    this.seaOffsetMb = null; // sea-level minus station pressure, from REST
    this.rainLog = []; // { t, mm } per observation, last 60 minutes
    this.lastRainTime = 0;
    this.strikeLog = []; // { t, count }, last 24 hours
    this.lastStrikeLogged = 0;
    this.lastStrike = null; // { t, mi }
    this.strikeSeeded = false;
  },

  stop() {
    this._stopAll();
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "TEMPEST_INIT") this._initialize(payload);
    else if (notification === "TEMPEST_STOP") this._stopAll();
  },

  // ---- lifecycle ---------------------------------------------------------------------------

  _initialize(config) {
    this._stopAll();
    this.generation += 1;
    this.config = Object.assign({}, config || {});
    this.errorSentAt = {};
    this.reconnectAttempts = 0;
    this.lastObservationTime = 0;

    const c = this.config;
    if (!c.token || !c.deviceId || !c.stationId) {
      this._sendError("CONFIG", "token, deviceId and stationId are required");
      return;
    }

    // A browser reload re-initialises the front end: hand it what is already known.
    if (this.forecast) {
      this.sendSocketNotification("TEMPEST_FORECAST", { forecast: this._forecastItems() });
    }
    this._emit();

    this._fetchForecast();
    const interval = Math.max(MINUTE, num(c.updateInterval) || 5 * MINUTE);
    this.forecastTimer = setInterval(() => this._fetchForecast(), interval);

    this._connect();
    const watchdog = Math.max(5000, num(c.watchdogInterval) || 30 * 1000);
    this.watchdogTimer = setInterval(() => this._checkConnection(), watchdog);
  },

  _stopAll() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.forecastTimer) clearInterval(this.forecastTimer);
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.forecastTimer = null;
    this._closeSocket();
  },

  _sendError(code, message) {
    const now = Date.now();
    if (now - (this.errorSentAt[code] || 0) < ERROR_THROTTLE_MS) return;
    this.errorSentAt[code] = now;
    Log.error(`[${this.name}] ${code}: ${message}`);
    this.sendSocketNotification("TEMPEST_ERROR", { code, message });
  },

  // ---- WebSocket ---------------------------------------------------------------------------

  _connect() {
    this._closeSocket();
    if (typeof WebSocket === "undefined") {
      this._sendError("CONNECT", "WebSocket is not available in this Node.js version (Node 22+ is required)");
      return;
    }
    this.connectionStarted = Date.now();
    Log.log(`[${this.name}] Connecting to the Tempest WebSocket...`);

    let socket;
    try {
      // The token is part of the URL; the URL is never logged.
      socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(this.config.token)}`);
    } catch (err) {
      Log.error(`[${this.name}] Unable to create WebSocket: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      Log.log(`[${this.name}] Tempest WebSocket connected.`);
      try {
        socket.send(
          JSON.stringify({
            type: "listen_start",
            device_id: Number(this.config.deviceId),
            id: "MMM-GlassTempest"
          })
        );
      } catch (err) {
        Log.error(`[${this.name}] Could not start the listener: ${err.message}`);
        this._closeSocket();
        this._scheduleReconnect();
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this._handleMessage(event.data);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      Log.error(`[${this.name}] WebSocket error.`);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      Log.warn(`[${this.name}] WebSocket closed (code ${event && event.code}).`);
      this._sendError("CONNECT", "Unable to connect to the Tempest realtime service");
      this._scheduleReconnect();
    };
  },

  _closeSocket() {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch (err) {
      Log.warn(`[${this.name}] Error closing WebSocket: ${err.message}`);
    }
  },

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const max = num(this.config && this.config.maxReconnectDelay) || 2 * MINUTE;
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), max);
    Log.warn(`[${this.name}] Reconnecting in ${Math.round(delay / 1000)} s.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  },

  _checkConnection() {
    const now = Date.now();
    const c = this.config || {};
    const observationTimeout = num(c.observationTimeout) || 3 * MINUTE;
    const initialTimeout = num(c.initialConnectionTimeout) || 3 * MINUTE;

    if (this.lastObservationTime && now - this.lastObservationTime > observationTimeout) {
      Log.warn(`[${this.name}] Observations are stale; reconnecting.`);
      this.lastObservationTime = 0;
      this._closeSocket();
      this._scheduleReconnect();
    } else if (!this.lastObservationTime && this.socket && this.connectionStarted &&
      now - this.connectionStarted > initialTimeout) {
      this._sendError("NO_DATA", `No observations received from Tempest device ${c.deviceId}. Check deviceId.`);
      this._closeSocket();
      this._scheduleReconnect();
    } else if (!this.socket && !this.reconnectTimer) {
      this._scheduleReconnect();
    }
  },

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!msg) return;
    if (msg.type === "obs_st" && Array.isArray(msg.obs) && msg.obs.length) {
      this._onObservation(msg.obs[msg.obs.length - 1]);
    } else if (msg.status && msg.status.status_code !== undefined && Number(msg.status.status_code) !== 0) {
      Log.warn(`[${this.name}] WeatherFlow status ${msg.status.status_code}: ${msg.status.status_message || ""}`);
    }
  },

  // obs_st fields: 0 time(s) 1 lull 2 avg 3 gust 4 dir 5 sample 6 pressure(mb, station) 7 temp(C)
  // 8 RH 9 lux 10 UV 11 solar 12 rain(mm, this interval) 13 precip type 14 strike distance(km)
  // 15 strike count 16 battery 17 report interval(min)
  _parseObservation(ob) {
    if (!Array.isArray(ob) || ob.length < 16) return null;
    const tempC = inRange(num(ob[7]), -60, 70);
    if (tempC === null) return null;
    const seconds = num(ob[0]);
    return {
      time: seconds ? seconds * 1000 : Date.now(),
      tempC,
      humidity: inRange(num(ob[8]), 0, 100),
      windMps: inRange(num(ob[2]), 0, 100),
      gustMps: inRange(num(ob[3]), 0, 100),
      windDir: inRange(num(ob[4]), 0, 360),
      pressureMb: inRange(num(ob[6]), 800, 1100),
      uv: inRange(num(ob[10]), 0, 20),
      solar: inRange(num(ob[11]), 0, 2000),
      rainMm: inRange(num(ob[12]), 0, 1000),
      strikeCount: inRange(num(ob[15]), 0, 10000) || 0,
      strikeKm: inRange(num(ob[14]), 0, 500)
    };
  },

  _onObservation(ob) {
    const o = this._parseObservation(ob);
    if (!o) return;
    this.lastObservationTime = Date.now();
    this.reconnectAttempts = 0;
    this.obs = o;

    // The API may replay the last observation after a reconnect; log each minute once.
    if (o.rainMm !== null && o.time > this.lastRainTime) {
      this.lastRainTime = o.time;
      this.rainLog.push({ t: o.time, mm: o.rainMm });
    }
    this.rainLog = this.rainLog.filter((r) => r.t > o.time - 60 * MINUTE);

    if (o.strikeCount > 0 && o.time > this.lastStrikeLogged) {
      this.lastStrikeLogged = o.time;
      this.strikeLog.push({ t: o.time, count: o.strikeCount });
      this.lastStrike = { t: o.time, mi: o.strikeKm !== null ? o.strikeKm * KM_TO_MI : null };
    }
    this.strikeLog = this.strikeLog.filter((s) => s.t > o.time - 24 * 60 * MINUTE);

    this._emit();
  },

  // ---- Better Forecast REST ----------------------------------------------------------------

  _fetchForecast() {
    const c = this.config;
    if (this.forecastInFlight || !c || !c.token || !c.stationId) return;
    this.forecastInFlight = true;
    const generation = this.generation;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORECAST_TIMEOUT_MS);
    const url =
      `${FORECAST_URL}?station_id=${encodeURIComponent(c.stationId)}` +
      `&token=${encodeURIComponent(c.token)}` +
      "&units_temp=f&units_wind=mph&units_pressure=mb&units_precip=in&units_distance=mi";

    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then((res) => {
        if (!res.ok) {
          const err = new Error(`WeatherFlow forecast returned HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .then((data) => {
        if (generation === this.generation) this._onForecast(data);
      })
      .catch((err) => {
        if (generation !== this.generation) return;
        if (err && (err.status === 401 || err.status === 403)) {
          this._sendError("AUTH", "WeatherFlow rejected the token or station ID. Check token/stationId.");
        } else if (err && err.name === "AbortError") {
          Log.error(`[${this.name}] Forecast request timed out.`);
        } else {
          Log.error(`[${this.name}] Forecast update failed: ${err && err.message}`);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        this.forecastInFlight = false;
      });
  },

  _onForecast(data) {
    const daily = data && data.forecast && data.forecast.daily;
    if (!Array.isArray(daily) || !daily.length) {
      Log.error(`[${this.name}] Forecast response incomplete.`);
      return;
    }
    this.forecast = daily
      .slice(0, MAX_FORECAST_DAYS)
      .map((d) => ({
        dayStart: num(d.day_start_local),
        high: num(d.air_temp_high),
        low: num(d.air_temp_low),
        conditions: typeof d.conditions === "string" ? d.conditions : "",
        icon: d.icon,
        precip: inRange(num(d.precip_probability), 0, 100)
      }))
      .filter((d) => d.dayStart !== null);

    const sunrise = num(daily[0].sunrise);
    const sunset = num(daily[0].sunset);
    this.sun = sunrise && sunset
      ? { sunrise: new Date(sunrise * 1000).toISOString(), sunset: new Date(sunset * 1000).toISOString() }
      : null;

    const rest = this._normalizeRest(data.current_conditions);
    if (rest) this._applyRest(rest);

    this.sendSocketNotification("TEMPEST_FORECAST", { forecast: this._forecastItems() });
    this._emit();
  },

  _normalizeRest(cc) {
    if (!cc) return null;
    const trend = ["rising", "falling", "steady"].includes(cc.pressure_trend) ? cc.pressure_trend : null;
    const strikeEpoch = num(cc.lightning_strike_last_epoch);
    return {
      tempF: inRange(num(cc.air_temperature), -76, 158),
      humidity: inRange(num(cc.relative_humidity), 0, 100),
      windMph: inRange(num(cc.wind_avg), 0, 224),
      windDir: inRange(num(cc.wind_direction), 0, 360),
      seaMb: inRange(num(cc.sea_level_pressure), 800, 1100),
      stationMb: inRange(num(cc.station_pressure), 800, 1100),
      trend,
      feelsF: inRange(num(cc.feels_like), -150, 200),
      uv: inRange(num(cc.uv), 0, 20),
      solar: inRange(num(cc.solar_radiation), 0, 2000),
      precipDayIn: inRange(num(cc.precip_accum_local_day), 0, 200),
      conditions: typeof cc.conditions === "string" ? cc.conditions : "",
      icon: cc.icon,
      strikeHour: inRange(num(cc.lightning_strike_count_last_1hr), 0, 100000),
      strikeLastMs: strikeEpoch ? strikeEpoch * 1000 : null,
      strikeLastMi: inRange(num(cc.lightning_strike_last_distance), 0, 500)
    };
  },

  _applyRest(rest) {
    this.rest = rest;
    if (rest.seaMb !== null && rest.stationMb !== null) {
      this.seaOffsetMb = rest.seaMb - rest.stationMb;
    }
    // After a restart the live log is empty: seed it from the REST count for the last hour so
    // the "today / last hr" row is not blank during a storm.
    if (!this.strikeSeeded) {
      this.strikeSeeded = true;
      if (!this.strikeLog.length && rest.strikeHour > 0 && rest.strikeLastMs) {
        this.strikeLog.push({ t: rest.strikeLastMs, count: rest.strikeHour });
      }
    }
    // Adopt REST's last-strike info only when it is clearly newer than what the live feed saw
    // (an observation's minute stamp can trail the strike itself by up to a minute).
    if (rest.strikeLastMs && (!this.lastStrike || rest.strikeLastMs > this.lastStrike.t + 2 * MINUTE)) {
      this.lastStrike = { t: rest.strikeLastMs, mi: rest.strikeLastMi };
    }
  },

  _forecastItems() {
    const c = this.config || {};
    const metric = c.units === "metric";
    const conv = (f) => (f === null ? null : metric ? ((f - 32) * 5) / 9 : f);
    // All days held (up to MAX_FORECAST_DAYS): the card shows `forecastDays` of them and the
    // tap-to-open popup shows the full week.
    return (this.forecast || []).map((d) => ({
      date: new Date(d.dayStart * 1000).toISOString(),
      high: conv(d.high),
      low: conv(d.low),
      phrase: d.conditions,
      cond: this._conditionFromIcon(d.icon),
      precip: d.precip,
      isDaytime: true
    }));
  },

  // Tempest icon names: clear-day, clear-night, cloudy, foggy, partly-cloudy-day/night,
  // possibly-rainy-*, possibly-sleet-*, possibly-snow-*, possibly-thunderstorm-*, rainy, sleet,
  // snow, thundershower, thunderstorm, windy.
  _conditionFromIcon(icon) {
    const i = `${icon || ""}`.toLowerCase();
    if (!i) return null;
    if (i.includes("thunder")) return "thunderstorm";
    if (i.includes("sleet")) return "sleet";
    if (i.includes("snow")) return "snow";
    if (i.includes("rain")) return "rain";
    if (i.includes("fog")) return "fog";
    if (i.includes("partly")) return "partly_cloudy";
    if (i.includes("cloud")) return "cloud";
    if (i.includes("clear")) return "clear";
    if (i.includes("wind")) return "partly_cloudy";
    return null;
  },

  _dewPointF(tempC, humidity) {
    if (tempC === null || humidity === null || humidity <= 0) return null;
    const a = 17.62;
    const b = 243.12;
    const gamma = Math.log(humidity / 100) + (a * tempC) / (b + tempC);
    return ((b * gamma) / (a - gamma)) * 9 / 5 + 32;
  },

  _strikesSince(since) {
    return this.strikeLog.filter((s) => s.t >= since).reduce((sum, s) => sum + s.count, 0);
  },

  // The payload mirrors the field names of an Ambient Weather realtime packet.
  _buildPayload() {
    const o = this.obs;
    const r = this.rest;
    if (!o && !r) return null;
    const now = Date.now();

    const tempF = o ? (o.tempC * 9) / 5 + 32 : r.tempF;
    if (tempF === null || tempF === undefined) return null;
    const p = { tempf: tempF, dateutc: o ? o.time : now };

    const humidity = o && o.humidity !== null ? o.humidity : r && r.humidity;
    if (humidity !== null && humidity !== undefined) p.humidity = humidity;

    if (o && o.windMps !== null) p.windspeedmph = o.windMps * MPS_TO_MPH;
    else if (r && r.windMph !== null) p.windspeedmph = r.windMph;
    if (o && o.gustMps !== null) p.windgustmph = o.gustMps * MPS_TO_MPH;
    if (o && o.windDir !== null) p.winddir = o.windDir;
    else if (r && r.windDir !== null) p.winddir = r.windDir;

    // The live feed reports station pressure; the card wants sea-level. REST gives both, so the
    // difference between them is applied to each live reading.
    let seaMb = null;
    if (o && o.pressureMb !== null && this.seaOffsetMb !== null) seaMb = o.pressureMb + this.seaOffsetMb;
    else if (r && r.seaMb !== null) seaMb = r.seaMb;
    if (seaMb !== null) p.baromrelin = seaMb * MB_TO_INHG;
    if (r && r.trend) p.pressureTrend = r.trend;

    const uv = o && o.uv !== null ? o.uv : r && r.uv;
    if (uv !== null && uv !== undefined) p.uv = uv;
    const solar = o && o.solar !== null ? o.solar : r && r.solar;
    if (solar !== null && solar !== undefined) p.solarradiation = solar;

    if (o) p.hourlyrainin = this.rainLog.reduce((sum, x) => sum + x.mm, 0) / 25.4;
    if (r && r.precipDayIn !== null) p.dailyrainin = r.precipDayIn;

    if (r && r.feelsF !== null) {
      // REST is a few minutes old; carry the live temperature change over to feels-like.
      p.feelsLike = r.tempF !== null ? r.feelsF + (tempF - r.tempF) : r.feelsF;
    }
    const tempC = o ? o.tempC : ((tempF - 32) * 5) / 9;
    const dew = this._dewPointF(tempC, humidity === undefined ? null : humidity);
    if (dew !== null) p.dewPoint = dew;

    if (this.sun) {
      p.sunrise = this.sun.sunrise;
      p.sunset = this.sun.sunset;
    }
    if (r) {
      if (r.conditions) p.conditions = r.conditions;
      const cond = this._conditionFromIcon(r.icon);
      if (cond) p.condition = cond;
    }

    // Lightning: always numeric so the card's lightning row has a sensor to show.
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const hour = this._strikesSince(now - 60 * MINUTE);
    p.lightning_hour = hour;
    p.lightning_day = Math.max(this._strikesSince(dayStart.getTime()), hour);
    if (this.lastStrike) {
      p.lightning_time = this.lastStrike.t;
      if (this.lastStrike.mi !== null) p.lightning_distance = this.lastStrike.mi;
    }
    return p;
  },

  _emit() {
    const payload = this._buildPayload();
    if (payload) this.sendSocketNotification("TEMPEST_DATA", { lastData: payload });
  }
});
