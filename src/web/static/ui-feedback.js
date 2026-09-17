// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
(function () {
  "use strict";
  var active = null;

  function notice(message) {
    var target = document.getElementById("toast");
    if (!target) return;
    target.className = "toast show warn";
    target.textContent = message;
  }

  function confirmAction(message, action, label) {
    if (active) return;
    var previous = document.activeElement;
    var overlay = document.createElement("div");
    overlay.className = "confirmation-screen";
    var panel = document.createElement("section");
    panel.className = "confirmation-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "confirmation-heading");
    panel.setAttribute("aria-describedby", "confirmation-description");
    var heading = document.createElement("h2");
    heading.id = "confirmation-heading";
    heading.textContent = label || "Confirm action";
    var description = document.createElement("p");
    description.id = "confirmation-description";
    description.textContent = message;
    var status = document.createElement("p");
    status.className = "confirmation-status";
    status.setAttribute("role", "status");
    var actions = document.createElement("div");
    actions.className = "report-actions";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "button secondary";
    cancel.textContent = "Cancel";
    var approve = document.createElement("button");
    approve.type = "button";
    approve.className = "button primary";
    approve.textContent = label || "Confirm";
    actions.append(cancel, approve);
    panel.append(heading, description, status, actions);
    overlay.append(panel);
    var shell = document.querySelector(".shell");
    var wasInert = shell && shell.inert;
    if (shell) shell.inert = true;
    var busy = false;
    active = overlay;
    document.body.append(overlay);
    cancel.focus();

    function close() {
      overlay.remove();
      active = null;
      if (shell) shell.inert = wasInert;
      if (previous && previous.isConnected) previous.focus();
      else document.querySelector(".nav-link.active")?.focus();
    }
    cancel.addEventListener("click", function () { if (!busy) close(); });
    overlay.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); if (!busy) close(); }
      if (event.key === "Tab") {
        event.preventDefault();
        if (!busy) (approve.isConnected && document.activeElement === cancel ? approve : cancel).focus();
      }
    });
    approve.addEventListener("click", async function () {
      if (busy) return;
      busy = true;
      cancel.disabled = true;
      approve.disabled = true;
      approve.textContent = "Working…";
      status.textContent = "Please wait. Respond to any system permission request.";
      try { await action(); close(); }
      catch (_) {
        status.textContent = "The result could not be confirmed. Check the current state before trying again.";
        // Do not offer an immediate retry: a failed response does not prove the operation failed.
        approve.remove();
        busy = false;
        cancel.disabled = false;
        cancel.textContent = "Close";
        cancel.focus();
      }
    });
  }

  function copy(value, trigger) {
    var scope = trigger && trigger.parentElement;
    var feedback = scope && scope.querySelector(".clipboard-feedback");
    if (!feedback && scope) {
      feedback = document.createElement("span");
      feedback.className = "clipboard-feedback";
      feedback.setAttribute("role", "status");
      trigger.after(feedback);
    }
    function say(message) { if (feedback) feedback.textContent = message; else notice(message); }
    function failed() { say("Could not copy. Select and copy the text manually."); }
    if (!navigator.clipboard) { failed(); return; }
    navigator.clipboard.writeText(value).then(function () { say("Copied."); }, failed);
  }

  window.novamiraUi = Object.freeze({ confirmAction: confirmAction, copy: copy, notice: notice });

  document.addEventListener("datastar-fetch", function (event) {
    var detail = event.detail || {};
    if (detail.type === "error") {
      notice(detail.argsRaw && detail.argsRaw.status === "403"
        ? "This page can no longer submit changes. Novamira HQ may have restarted. Reload the page before trying again; unsaved form entries will be cleared."
        : "The request could not be completed. Check the current state before trying again.");
    } else if (detail.type === "retries-failed") {
      notice("Novamira HQ could not be reached. Check that it is running, then reload this page. Do not repeat an operation until you have checked its result.");
    }
  });
})();
