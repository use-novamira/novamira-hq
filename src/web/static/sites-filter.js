(function () {
  "use strict";
  var CAP = 12;
  var obsTarget = null;
  var observer = null;
  var status = "all"; // all | with | without
  var HIDDEN_KEY = "novamira-hq.hidden-hosting-sites.v1";
  var hiddenSites = new Set();
  var COLLAPSED_KEY = "novamira-hq.collapsed-site-groups.v1";
  var collapsedGroups = new Set();
  var expandedGroups = new Set();
  try {
    var storedCollapsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    if (Array.isArray(storedCollapsed)) collapsedGroups = new Set(storedCollapsed.filter(function (v) { return typeof v === "string"; }).slice(0, 10000));
  } catch (_) { /* Keep native disclosure controls usable without storage. */ }

  function restoreGroups() {
    document.querySelectorAll("details.inventory-group[id]").forEach(function (group) {
      group.open = !collapsedGroups.has(group.id);
    });
  }

  document.addEventListener("click", function (event) {
    var summary = event.target && event.target.closest ? event.target.closest("details.inventory-group > summary") : null;
    if (!summary) return;
    var group = summary.parentElement;
    if (!group || !group.id) return;
    event.preventDefault();
    if (group.open) collapsedGroups.add(group.id); else collapsedGroups.delete(group.id);
    group.open = !collapsedGroups.has(group.id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(collapsedGroups).slice(-10000))); }
    catch (_) { /* The preference still survives patches in this page. */ }
  });
  try {
    var storedHidden = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]");
    if (Array.isArray(storedHidden)) hiddenSites = new Set(storedHidden.filter(function (v) { return typeof v === "string"; }).slice(0, 10000));
  } catch (_) { /* A blocked or invalid preference must never hide the inventory. */ }

  function isHidden(row) {
    return hiddenSites.has(row.getAttribute("data-hosting-site-key"));
  }

  function showHidden() {
    var toggle = document.querySelector(".show-hidden-sites");
    return toggle && toggle.checked;
  }

  function rows(group) {
    return Array.prototype.slice.call(group.querySelectorAll(".site-row"));
  }

  function currentQuery() {
    var box = document.querySelector('input[data-bind="sites.search"]');
    return box ? box.value : "";
  }

  function pauseObserver(fn) {
    if (observer) observer.disconnect();
    try {
      fn();
    } finally {
      if (observer && obsTarget) {
        observer.observe(obsTarget, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
      }
    }
  }

  function matchesStatus(row) {
    if (status === "all") return true;
    var st = row.getAttribute("data-nm-state");
    if (status === "with") return st === "installed";
    return st === "install"; // without
  }

  function applyFilters(q) {
    var query = (q || "").trim().toLowerCase();
    document.querySelectorAll("#sites-result .site-group, #sites-result .provider-sites").forEach(function (group) {
      var any = false;
      rows(group).forEach(function (row) {
        var textHit = query === "" || row.textContent.toLowerCase().indexOf(query) !== -1;
        var hidden = isHidden(row);
        row.querySelectorAll(".hosting-visibility").forEach(function (visibilityButton) {
          visibilityButton.textContent = hidden ? "Restore to list" : "Hide from list";
          visibilityButton.setAttribute("aria-label", visibilityButton.textContent);
        });
        var hit = textHit && matchesStatus(row) && (!hidden || showHidden());
        row.classList.toggle("sf-hidden", !hit);
        if (hit) any = true;
      });
      group.classList.toggle("sf-hidden", !any);
    });
    if (query !== "" || status !== "all") expandAll();
    else paginate();
  }

  function updateCounts() {
    var withN = 0, withoutN = 0;
    document.querySelectorAll("#sites-result .site-row[data-nm-state]").forEach(function (row) {
      if (isHidden(row) && !showHidden()) return;
      if (row.getAttribute("data-nm-state") === "installed") withN++;
      else withoutN++;
    });
    var w = document.querySelector('[data-sf-count="with"]');
    var o = document.querySelector('[data-sf-count="without"]');
    if (w) w.textContent = String(withN);
    if (o) o.textContent = String(withoutN);
  }

  function expandAll() {
    document.querySelectorAll(".sf-more").forEach(function (btn) { btn.remove(); });
    document.querySelectorAll(".site-row.sf-capped").forEach(function (row) { row.classList.remove("sf-capped"); });
  }

  function paginate() {
    expandAll();
    document.querySelectorAll("#sites-result .site-grid").forEach(function (grid) {
      var group = grid.closest("details.inventory-group[id]");
      var key = group ? group.id : grid;
      if (expandedGroups.has(key)) return;
      var all = Array.prototype.slice.call(grid.children).filter(function (c) {
        return c.classList && c.classList.contains("site-row") && !c.classList.contains("sf-hidden");
      });
      if (all.length <= CAP) return;
      if (grid.querySelector(".sf-more")) return;
      all.forEach(function (row, i) { if (i >= CAP) row.classList.add("sf-capped"); });
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sf-more";
      btn.textContent = "Show " + (all.length - CAP) + " more";
      btn.addEventListener("click", function () {
        pauseObserver(function () {
          expandedGroups.add(key);
          all.forEach(function (row) { row.classList.remove("sf-capped"); });
          btn.remove();
        });
      });
      grid.appendChild(btn);
    });
  }

  function refilter() {
    pauseObserver(function () {
      restoreGroups();
      updateCounts();
      applyFilters(currentQuery());
    });
  }

  function saveVisibility(key, hidden) {
    var next = new Set(hiddenSites);
    if (hidden) next.add(key); else next.delete(key);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(next)));
    hiddenSites = next;
    refilter();
  }

  window.novamiraSites = Object.freeze({ hideSite: function (key, label, names, token) {
    if (hiddenSites.has(key)) {
      try { saveVisibility(key, false); }
      catch (_) { window.novamiraUi.notice("Could not save the visibility preference."); }
      return;
    }
    var message = 'Hide “' + label + '” and all its environments from this list? This does not delete the website. Use “Show hidden sites” to show it again.';
    if (names.length) message += " Access is kept unless you select a connection below. Disconnecting removes this device’s authorization; you will need to authorize access again. Other saved connections to this site are affected too.";
    window.novamiraUi.confirmAction(message, async function (selected) {
      // Check storage before removing any authorization; never hide after a failed request.
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(hiddenSites)));
      for (var name of selected) {
        var response = await fetch("/_dashboard/site-profiles/logout?response=json&name=" + encodeURIComponent(name), {
          method: "POST", headers: { "X-Novamira-Dashboard-Token": token, "Content-Type": "application/json" }, body: "{}"
        });
        var result = await response.json();
        if (!response.ok || !result.ok || !result.data || result.data.disconnected !== true) throw new Error("Disconnect not confirmed");
      }
      saveVisibility(key, true);
      if (selected.length) window.location.reload();
    }, "Hide site", names.map(function (name) {
      return { value: name, label: names.length === 1 ? "Also disconnect this site (" + name + ")" : "Also disconnect: " + name };
    }));
  } });

  // User typing: delegated so it survives toolbar re-renders.
  document.addEventListener("input", function (e) {
    if (e.target && e.target.matches && e.target.matches('input[data-bind="sites.search"]')) {
      refilter();
    }
  });

  // Segmented status buttons: delegated click.
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".seg-btn[data-sf-status]") : null;
    if (!btn) return;
    status = btn.getAttribute("data-sf-status");
    document.querySelectorAll(".seg-btn[data-sf-status]").forEach(function (b) {
      b.classList.toggle("on", b === btn);
    });
    refilter();
  });

  document.addEventListener("change", function (e) {
    if (e.target && e.target.matches && e.target.matches(".show-hidden-sites")) refilter();
  });

  // Datastar patches #sites-result on load/refresh/filter — re-apply our state.
  obsTarget = document.body;
  observer = new MutationObserver(refilter);
  observer.observe(obsTarget, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });

  function init() { refilter(); }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
