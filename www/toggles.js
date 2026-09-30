/*
    PAYTRACK — HIDE / SHOW TOGGLES

    Any button with data-toggle-target="someId" hides or shows the element
    with that id. The choice is remembered on this device.

    Optional attributes on the button:
      data-hide-label   text while the section is visible (e.g. "Hide")
      data-show-label   text while the section is hidden  (e.g. "Show")
*/

(function () {
    "use strict";

    var PREFIX = "paytrack_hidden_";

    function readHidden(id) {
        try { return localStorage.getItem(PREFIX + id) === "1"; }
        catch (e) { return false; }
    }

    function saveHidden(id, hidden) {
        try {
            if (hidden) localStorage.setItem(PREFIX + id, "1");
            else localStorage.removeItem(PREFIX + id);
        } catch (e) {}
    }

    function apply(button, hidden) {
        var target = document.getElementById(button.getAttribute("data-toggle-target"));
        if (!target) return;

        target.classList.toggle("is-hidden", hidden);

        var label = hidden
            ? button.getAttribute("data-show-label")
            : button.getAttribute("data-hide-label");

        if (label) button.textContent = label;

        button.setAttribute("aria-expanded", hidden ? "false" : "true");
    }

    function init() {

        var buttons = document.querySelectorAll("[data-toggle-target]");

        Array.prototype.forEach.call(buttons, function (button) {

            var id = button.getAttribute("data-toggle-target");

            apply(button, readHidden(id));

            button.addEventListener("click", function () {
                var target = document.getElementById(id);
                if (!target) return;

                var hidden = !target.classList.contains("is-hidden");
                saveHidden(id, hidden);
                apply(button, hidden);
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();