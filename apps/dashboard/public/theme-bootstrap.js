(function () {
  "use strict";
  var defaults = {
    mode: "default",
    decorativeCopy: true,
    ambientMotion: true,
  };
  var colors = {
    default: "#05070b",
    "forskin-subtle": "#0b0b09",
    "forskin-hella": "#070705",
  };
  var preferences = defaults;
  try {
    var parsed = JSON.parse(localStorage.getItem("fgp.ui.theme.v1"));
    var valid =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 3 &&
      Object.prototype.hasOwnProperty.call(parsed, "mode") &&
      Object.prototype.hasOwnProperty.call(parsed, "decorativeCopy") &&
      Object.prototype.hasOwnProperty.call(parsed, "ambientMotion") &&
      Object.prototype.hasOwnProperty.call(colors, parsed.mode) &&
      typeof parsed.decorativeCopy === "boolean" &&
      typeof parsed.ambientMotion === "boolean";
    if (valid) preferences = parsed;
  } catch {}

  var reducedMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  var root = document.documentElement;
  root.dataset.theme = preferences.mode;
  root.dataset.forskinCopy = preferences.decorativeCopy ? "on" : "off";
  root.dataset.forskinMotion =
    preferences.ambientMotion && !reducedMotion ? "on" : "off";
  var themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = colors[preferences.mode];
})();
