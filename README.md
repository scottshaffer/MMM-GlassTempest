# MMM-GlassTempest

A MagicMirror² weather card for **WeatherFlow Tempest** owners. It combines the liquid-glass look and
animated Lottie icons of [MMM-AmbientWeather](https://github.com/scottshaffer/MMM-AmbientWeather)
with the Tempest data connection of [MMM-TempestWeather](https://github.com/scottshaffer/MMM-TempestWeather).

## Features

- Live temperature, humidity, wind speed and direction (about once a minute, from the Tempest WebSocket)
- Feels-like, sea-level pressure with trend, UV index, rain detection
- Tempest's own current condition drives the animated icon (the station's rain gauge overrides it while it is raining)
- Multi-day forecast with chance of precipitation (WeatherFlow Better Forecast)
- Sunrise and sunset
- Light day look and dark night look, switched at the station's own sunrise and sunset with
  `dayMode: "auto"` (see [Day and night](#day-and-night))
- Lightning row on the card, a "LIGHTNING NEARBY" badge and a page-wide strike banner
- Imperial or metric units
- Automatic reconnection, stale-data watchdog, visible error messages
- Static icon fallback for low-power devices (Raspberry Pi)
- No npm packages except `lottie-web` (only needed for animated icons)

## Requirements

- MagicMirror²
- **Node.js 22 or newer** (the helper uses the built-in `WebSocket` and `fetch`)
- A WeatherFlow Tempest station, a personal access token, the **device ID** and the **station ID**

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/YOUR_GITHUB_USER/MMM-GlassTempest.git
cd MMM-GlassTempest
npm install --omit=dev
```

### Animations

The animated icons are Lottie JSON files in an `animations/` folder inside this module. Copy that
folder (and the `uv-index-*.json` files) from your MMM-AmbientWeather install:

```bash
cp -r ../MMM-AmbientWeather/animations ./animations
```

Without them, set `animateIcons: false` (static Font Awesome icons are used instead).

## Configuration

```js
{
  module: "MMM-GlassTempest",
  position: "top_right",
  config: {
    token: "YOUR_WEATHERFLOW_TOKEN",
    deviceId: "YOUR_TEMPEST_DEVICE_ID",
    stationId: "YOUR_TEMPEST_STATION_ID",
    units: "imperial",   // or "metric"
    forecastDays: 3
  }
},
```

Do not publish your token. Restart MagicMirror after editing `config.js`.

### Finding your token, station ID and device ID

- **Token:** in the Tempest web app (tempestwx.com), open Settings, then Data Authorizations, then
  Create Token.
- **Station ID:** the number in your station's web address, for example
  `tempestwx.com/station/229916/` means the station ID is `229916`.
- **Device ID:** this is a number, **not** the serial number printed on the device (`ST-00...`). Look it
  up with your token and station ID:

  ```bash
  curl -s "https://swd.weatherflow.com/swd/rest/stations/YOUR_STATION_ID?token=YOUR_TOKEN"
  ```

  In the response, find the entry under `devices` with `"device_type":"ST"` (the Tempest sensor, not
  the `HB` hub) and copy its `device_id`, for example `"device_id":1247299`. You can also open the
  same address in a web browser.

If the card shows "No observations received from Tempest device", the `deviceId` is usually wrong.

### Options

| Option | Default | Description |
| :-- | :-- | :-- |
| `token` | required | WeatherFlow personal access token |
| `deviceId` | required | Tempest device ID (live observations) |
| `stationId` | required | Station ID (forecast and current conditions) |
| `title` | `"Home Weather"` | Card title; `""` hides it |
| `units` | `"imperial"` | `"imperial"` (°F, mph, inHg) or `"metric"` (°C, km/h, hPa) |
| `forecastDays` | `3` | Forecast days shown (1-5) |
| `showForecast` | `true` | Show the forecast panel |
| `showForecastPrecip` | `true` | Chance of precipitation under each forecast day |
| `showSunTimes` / `showUV` / `showBarometer` | `true` | Toggle those rows |
| `updateInterval` | `300000` | Forecast and current-conditions refresh (ms, minimum 60000) |
| `offlineThreshold` | `300000` | Fade the card when no observation arrives for this long (ms) |
| `observationTimeout` | `180000` | No observation for this long: reconnect |
| `initialConnectionTimeout` | `180000` | No first observation after connecting: error and reconnect |
| `watchdogInterval` | `30000` | How often the connection is checked |
| `maxReconnectDelay` | `120000` | Cap on the reconnect back-off |
| `animateIcons` | `true` | Lottie icons (`false` = static icons) |
| `performanceProfile` | `"auto"` | `"auto"`, `"pi"` (no animation) or `"full"` |
| `reduceMotion` | `false` | Disable animation and motion |
| `minWidth` / `maxHeight` | `260` / `null` | Card sizing (px) |
| `showLightning` | `"always"` | `"always"`, `"auto"` (only on days with strikes) or `"never"` |
| `lightningAlert` | `true` | Page-wide banner on a new strike |
| `lightningAlertDuration` | `60` | Seconds the banner stays up |
| `lightningAlertCooldown` | `10` | Minutes before the banner can reopen |
| `lightningActiveMinutes` | `30` | How long after a strike lightning counts as active |
| `lightningDangerDistance` | `6` | Strikes this close (mi, or km when metric) use the urgent banner; `0` disables |
| `lightningAlertPosition` | `"bottom"` | `"bottom"` or `"top"` |
| `weatherNotification` | `"AMBIENT_WEATHER_DATA"` | Notification name for current conditions |
| `lightningNotification` | `"AMBIENT_LIGHTNING"` | Notification name for each strike |
| `debug` | `false` | Log every data payload to the console |
| `dayMode` | `"none"` | `"auto"` (light from sunrise to sunset), `"day"` (always light), `"night"` (always dark), or `"none"` (light only if a theme or MMM-GlassMonthlyCalendar sets `body.mm-day`) |
| `dayStart` / `dayEnd` | `"07:00"` / `"19:00"` | Light hours for `dayMode: "auto"` until the station's sunrise and sunset are known |

### Day and night

```js
config: { dayMode: "auto" }
```

With `"auto"` the card turns to light glass at your station's sunrise and back to dark at sunset,
using the times from WeatherFlow's forecast. The lightning banner follows the card. The same times go
out with every weather update (`weatherNotification`), so
[MMM-GlassClock](https://github.com/scottshaffer/MMM-GlassClock) and
[MMM-GlassMonthlyCalendar](https://github.com/scottshaffer/MMM-GlassMonthlyCalendar) with
`dayMode: "auto"` switch at the same moment.

The card also turns light whenever something sets `body.mm-day` on the page.

## How it works

`node_helper.js` keeps two WeatherFlow connections and merges them into one payload shaped like an
Ambient Weather realtime packet, so the Ambient card code runs unchanged:

| Card field | Source |
| :-- | :-- |
| temperature, humidity, wind, UV, solar | WebSocket `obs_st` (live) |
| sea-level pressure | live station pressure plus the sea-level offset from REST |
| pressure trend, feels-like, current condition, rain today | Better Forecast `current_conditions` |
| sunrise, sunset, forecast, chance of precipitation | Better Forecast `forecast.daily` |
| rain in the last hour | summed from live observations |
| strikes today / last hour, last strike time and distance | live observations, seeded from REST after a restart |

Notes:

- The Tempest sends an observation about once a minute, so lightning is reported with that
  granularity.
- Lightning "today" counts strikes seen since the helper started (plus the last hour from REST after
  a restart); it resets at local midnight.
- A MagicMirror restart re-baselines lightning counters, so an old strike is never re-announced.

## Credits

- This module was mostly written by Claude Opus 
- UI, lightning logic and Lottie handling: [MMM-AmbientWeather](https://github.com/hearter20176/MMM-AmbientWeather) by Harry Arter (MIT)
- WeatherFlow connection design: [MMM-TempestWeather](https://github.com/dwburger/MMM-TempestWeather) by D.W. Burger (MIT)
- Weather data: WeatherFlow Tempest. Use of their data is subject to WeatherFlow's terms.

## License

MIT, see `LICENSE`.
