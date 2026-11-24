# Changelog

## [0.2.0]

- Full day (light glass) look: card, text, forecast tiles, temperatures, badges, lightning row and
  the page-wide lightning banner.
- `dayMode`: `"auto"` switches at the station's sunrise and sunset (falling back to
  `dayStart`/`dayEnd`); `"day"` and `"night"` fix the look. The live card flips without a re-render.
- The light look also follows `body.mm-day` from a theme or MMM-GlassMonthlyCalendar.

## [0.1.0]

- First release: the MMM-AmbientWeather glass card fed by a WeatherFlow Tempest station.
- Live observations from the Tempest WebSocket, forecast and current conditions from Better Forecast.
- Lightning row, badge and page-wide strike banner driven by the Tempest strike counters.
