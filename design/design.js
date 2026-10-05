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
     3. Toast demo.
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
