// Eos's page runtime: the only script a page frame runs. The frame has no
// network and no same origin; this script talks to the dashboard by
// postMessage alone, and reads messages only from the window that framed it.
// It never builds markup from data: a swapped part is HTML the core drew.
(function () {
  "use strict";
  var parentWindow = window.parent;
  var mode = "read";
  var seen = {};
  var readParts = [];
  var readLinks = [];
  var readTimer = null;

  function post(type, body) {
    var message = { type: type };
    for (var key in body) message[key] = body[key];
    parentWindow.postMessage(message, "*");
  }

  function partOf(node) {
    while (node && node.nodeType === 1) {
      if (node.hasAttribute("data-part")) return node;
      node = node.parentNode;
    }
    return null;
  }

  function indexOf(el) {
    var index = el && el.getAttribute("data-index");
    return index === null || index === undefined ? null : Number(index);
  }

  function flushReads() {
    readTimer = null;
    if (!readParts.length && !readLinks.length) return;
    post("eos-page/read", { parts: readParts, links: readLinks });
    readParts = [];
    readLinks = [];
  }

  function noteRead(part, index, link) {
    var key = part + "#" + index + "#" + (link || "");
    if (seen[key]) return;
    seen[key] = true;
    if (link) readLinks.push({ part: part, index: index, link: link });
    else readParts.push({ part: part, index: index });
    if (!readTimer) readTimer = setTimeout(flushReads, 1500);
  }

  function filter(chip) {
    var bar = chip.parentNode;
    var of = bar.getAttribute("data-filters");
    var value = chip.getAttribute("data-filter");
    var chips = bar.querySelectorAll("button[data-filter]");
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute("aria-pressed", chips[i] === chip ? "true" : "false");
    var items = document.querySelectorAll("[data-filter-of]");
    for (var j = 0; j < items.length; j++) {
      if (items[j].getAttribute("data-filter-of") !== of) continue;
      var shown = value === "" || items[j].getAttribute("data-filter-value") === value;
      if (shown) items[j].removeAttribute("data-filter-hidden");
      else items[j].setAttribute("data-filter-hidden", "");
    }
  }

  function point(target) {
    var part = partOf(target);
    if (!part) return;
    var marked = document.querySelectorAll(".eos-pointed");
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove("eos-pointed");
    part.classList.add("eos-pointed");
    var r = part.getBoundingClientRect();
    post("eos-page/part", {
      part: part.getAttribute("data-part"),
      index: indexOf(part),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (mode === "point") {
      event.preventDefault();
      event.stopPropagation();
      point(target);
      return;
    }
    var chip = target.closest && target.closest("button[data-filter]");
    if (chip) {
      filter(chip);
      return;
    }
    var button = target.closest && target.closest("button[data-button],button[data-ask]");
    if (button) {
      post("eos-page/act", {
        button: button.getAttribute("data-button") || button.getAttribute("data-ask"),
        ask: button.hasAttribute("data-ask"),
        index: indexOf(partOf(button))
      });
      return;
    }
    var link = target.closest && target.closest("a[href]");
    if (link) {
      event.preventDefault();
      var href = link.getAttribute("href");
      var part = partOf(link);
      if (part) noteRead(part.getAttribute("data-part"), indexOf(part), href);
      post("eos-page/open", { href: href });
    }
  }, true);

  document.addEventListener("toggle", function (event) {
    var part = partOf(event.target);
    if (part && event.target.open) noteRead(part.getAttribute("data-part"), indexOf(part), null);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (mode === "point" && event.key === "Escape") post("eos-page/mode", { mode: "read" });
  });

  if (window.IntersectionObserver) {
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        var el = entries[i].target;
        noteRead(el.getAttribute("data-part"), indexOf(el), null);
        observer.unobserve(el);
      }
    }, { threshold: 0.6 });
    var parts = document.querySelectorAll("[data-part]");
    for (var k = 0; k < parts.length; k++) observer.observe(parts[k]);
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data || {};
    if (data.type === "eos-page/mode" && (data.mode === "read" || data.mode === "point" || data.mode === "edit")) {
      mode = data.mode;
      document.documentElement.classList.toggle("eos-pointing", mode === "point");
      if (mode !== "point") {
        var marked = document.querySelectorAll(".eos-pointed");
        for (var i = 0; i < marked.length; i++) marked[i].classList.remove("eos-pointed");
      }
    } else if (data.type === "eos-page/swap" && typeof data.part === "string" && typeof data.html === "string") {
      var old = document.querySelector('[data-live][data-part="' + data.part.replace(/[^a-z0-9-]/g, "") + '"]');
      if (!old) return;
      var holder = document.createElement("template");
      holder.innerHTML = data.html;
      var next = holder.content.firstElementChild;
      if (next && next.getAttribute("data-part") === old.getAttribute("data-part")) old.replaceWith(next);
    }
  });

  function size() {
    post("eos-page/size", { height: document.documentElement.scrollHeight });
  }
  if (window.ResizeObserver) new ResizeObserver(size).observe(document.documentElement);
  window.addEventListener("load", size);
  // The Live parts the dashboard fills and keeps current: their names only.
  var live = [];
  var liveParts = document.querySelectorAll("[data-live][data-part]");
  for (var l = 0; l < liveParts.length; l++) live.push(liveParts[l].getAttribute("data-part"));
  post("eos-page/ready", { live: live });
})();
