// Updates elements carrying a data-checked-at (unix milliseconds) attribute
// with a human relative label ("just now", "2m ago", "3h ago", "10d ago").
// Local dashboard, so browser and server clocks match.
(function () {
  function rel(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function tick() {
    var els = document.querySelectorAll("[data-checked-at]");
    for (var i = 0; i < els.length; i++) {
      var ms = parseInt(els[i].getAttribute("data-checked-at"), 10);
      if (ms) els[i].textContent = rel(ms);
    }
  }
  setInterval(tick, 30000);
  tick();
})();
