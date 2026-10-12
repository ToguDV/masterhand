/* MasterHand design preview — theme, scene switcher, small demos.
   No framework, no build step: open DESIGN.html directly. */

(function () {
  "use strict";

  /* ---------------------------------------------------------------
     1. Theme: stored choice, else system; live-follow the system
        while the user has not made an explicit choice.
     --------------------------------------------------------------- */
  var root = document.documentElement;
  var themeToggle = document.getElementById("theme-toggle");

  function currentTheme() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    if (themeToggle) {
      themeToggle.setAttribute(
        "aria-label",
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      );
    }
  }

  function storedTheme() {
    try {
      var value = localStorage.getItem("mh-theme");
      return value === "light" || value === "dark" ? value : null;
    } catch (error) {
      return null;
    }
  }

  applyTheme(currentTheme());

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem("mh-theme", next);
      } catch (error) {
        /* storage unavailable: the choice just does not persist */
      }
    });
  }

  var systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  function onSystemThemeChange(event) {
    if (storedTheme()) return;
    applyTheme(event.matches ? "dark" : "light");
  }
  if (typeof systemTheme.addEventListener === "function") {
    systemTheme.addEventListener("change", onSystemThemeChange);
  } else if (typeof systemTheme.addListener === "function") {
    systemTheme.addListener(onSystemThemeChange);
  }

  /* ---------------------------------------------------------------
     2. Scene switcher: one control drives both frames.
     --------------------------------------------------------------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-screen-target]"));
  var screens = Array.prototype.slice.call(document.querySelectorAll("[data-screen]"));

  function selectScene(name) {
    tabs.forEach(function (tab) {
      var active = tab.getAttribute("data-screen-target") === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    screens.forEach(function (screen) {
      screen.classList.toggle("is-active", screen.getAttribute("data-screen") === name);
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      selectScene(tab.getAttribute("data-screen-target"));
    });
  });

  var initialTab = tabs.filter(function (tab) {
    return tab.classList.contains("is-active");
  })[0];
  selectScene(initialTab ? initialTab.getAttribute("data-screen-target") : "chat");

  /* ---------------------------------------------------------------
     4. Palette preview: buttons with [data-palette-target] repaint the
        whole page through data-palette (paper = the default, unset).
     --------------------------------------------------------------- */
  var paletteButtons = Array.prototype.slice.call(document.querySelectorAll("[data-palette-target]"));

  function storedPalette() {
    try {
      return localStorage.getItem("mh-palette") || "paper";
    } catch (error) {
      return "paper";
    }
  }

  function applyPalette(id) {
    var next = id || "paper";
    if (next === "paper") {
      root.removeAttribute("data-palette");
    } else {
      root.setAttribute("data-palette", next);
    }
    paletteButtons.forEach(function (button) {
      var active = (button.getAttribute("data-palette-target") || "paper") === next;
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  paletteButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var id = button.getAttribute("data-palette-target") || "paper";
      applyPalette(id);
      try {
        localStorage.setItem("mh-palette", id);
      } catch (error) {
        /* storage unavailable: the choice just does not persist */
      }
    });
  });

  applyPalette(storedPalette());

  /* ---------------------------------------------------------------
     5. Run & preview tabs: click plus arrow-key roving tabindex,
        mirroring the app panel.
     --------------------------------------------------------------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-rp-tabs]"), function (tablist) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(
      tablist.parentElement.querySelectorAll("[data-rp-panel]"),
    );

    function select(tab) {
      tabs.forEach(function (other) {
        var active = other === tab;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-selected", active ? "true" : "false");
        other.tabIndex = active ? 0 : -1;
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.getAttribute("data-rp-panel") !== tab.getAttribute("data-rp-tab");
      });
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener("click", function () {
        select(tab);
      });
      tab.addEventListener("keydown", function (event) {
        var next = null;
        if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
        if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
        if (next) {
          event.preventDefault();
          select(next);
          next.focus();
        }
      });
    });
  });

  /* ---------------------------------------------------------------
     6. Settings demo: the section nav marks the current item; on small
        screens it flips the master-detail view like the app does.
     --------------------------------------------------------------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-settings-demo]"), function (demo) {
    var items = Array.prototype.slice.call(demo.querySelectorAll("[data-settings-nav]"));
    var back = demo.querySelector("[data-settings-back]");
    items.forEach(function (item) {
      item.addEventListener("click", function () {
        items.forEach(function (other) {
          if (other === item) {
            other.setAttribute("aria-current", "page");
          } else {
            other.removeAttribute("aria-current");
          }
        });
        demo.setAttribute("data-mobile-view", "detail");
      });
    });
    if (back) {
      back.addEventListener("click", function () {
        demo.setAttribute("data-mobile-view", "list");
      });
    }
  });

  /* ---------------------------------------------------------------
     7. Goal rounds: collapsed rounds expand on demand.
     --------------------------------------------------------------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-goal-round]"), function (header) {
    header.addEventListener("click", function () {
      var body = header.nextElementSibling;
      var chevron = header.querySelector(".mh-goal__chevron");
      if (!body) return;
      var open = body.hasAttribute("hidden");
      if (open) {
        body.removeAttribute("hidden");
      } else {
        body.setAttribute("hidden", "");
      }
      header.setAttribute("aria-expanded", open ? "true" : "false");
      if (chevron) chevron.classList.toggle("is-open", open);
    });
  });

  /* ---------------------------------------------------------------
     8. Composer fields grow with their content (one to five lines).
     --------------------------------------------------------------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-autoresize]"), function (field) {
    function fit() {
      field.style.height = "auto";
      field.style.height = Math.min(field.scrollHeight, 160) + "px";
    }
    field.addEventListener("input", fit);
    fit();
  });

  /* ---------------------------------------------------------------
     9. Toast demo.
     --------------------------------------------------------------- */
  var toastButton = document.getElementById("toast-demo");
  var toastHost = document.getElementById("toast-host");
  var toastTimer = null;

  if (toastButton && toastHost) {
    toastButton.addEventListener("click", function () {
      var live = toastHost.querySelector(".mh-toast[data-live]");
      if (live) live.remove();
      if (toastTimer) window.clearTimeout(toastTimer);

      var toast = document.createElement("span");
      toast.className = "mh-toast";
      toast.setAttribute("data-live", "");
      toast.setAttribute("role", "status");
      toast.textContent = "✓ Session created";
      toastHost.appendChild(toast);

      toastTimer = window.setTimeout(function () {
        toast.remove();
      }, 2600);
    });
  }
})();
