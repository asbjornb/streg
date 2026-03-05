// On-screen debug console for mobile development.
// Activate by adding ?debug to the URL, e.g. https://yoursite.com/?debug
// Or set localStorage.setItem("streg_debug", "1") from any JS console once.
//
// Once active, a small [D] button appears in the bottom-left corner.
// Tap it to toggle the log overlay. All console.log/warn/error output
// is captured and displayed with timestamps.

(function () {
  const enabled =
    new URLSearchParams(location.search).has("debug") ||
    localStorage.getItem("streg_debug") === "1";

  if (!enabled) return;

  // Persist so you don't need ?debug every reload
  localStorage.setItem("streg_debug", "1");

  // --- Build UI ---
  const toggle = document.createElement("button");
  toggle.textContent = "D";
  Object.assign(toggle.style, {
    position: "fixed",
    bottom: "8px",
    left: "8px",
    zIndex: "99999",
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    border: "2px solid #333",
    background: "#ffe066",
    color: "#333",
    fontWeight: "bold",
    fontSize: "14px",
    cursor: "pointer",
    opacity: "0.7",
    touchAction: "manipulation",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    bottom: "48px",
    left: "8px",
    right: "8px",
    maxHeight: "40vh",
    zIndex: "99998",
    background: "#1e1e1e",
    color: "#d4d4d4",
    fontFamily: "monospace",
    fontSize: "11px",
    borderRadius: "8px",
    border: "1px solid #555",
    overflowY: "auto",
    padding: "8px",
    display: "none",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    WebkitUserSelect: "text",
    userSelect: "text",
  });

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  let visible = false;
  toggle.addEventListener("click", () => {
    visible = !visible;
    panel.style.display = visible ? "block" : "none";
    toggle.style.opacity = visible ? "1" : "0.7";
    if (visible) panel.scrollTop = panel.scrollHeight;
  });

  // --- Intercept console methods ---
  const colors = { log: "#d4d4d4", info: "#6cb6ff", warn: "#ffe066", error: "#f44" };

  ["log", "info", "warn", "error"].forEach((method) => {
    const original = console[method].bind(console);
    console[method] = function (...args) {
      original(...args);
      appendEntry(method, args);
    };
  });

  // Also capture uncaught errors
  window.addEventListener("error", (e) => {
    appendEntry("error", [`Uncaught: ${e.message} (${e.filename}:${e.lineno})`]);
  });

  window.addEventListener("unhandledrejection", (e) => {
    appendEntry("error", [`Unhandled rejection: ${e.reason}`]);
  });

  function appendEntry(level, args) {
    const line = document.createElement("div");
    line.style.color = colors[level];
    line.style.borderBottom = "1px solid #333";
    line.style.padding = "3px 0";

    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const text = args
      .map((a) => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a, null, 1); }
        catch { return String(a); }
      })
      .join(" ");

    line.textContent = `[${time}] ${text}`;
    panel.appendChild(line);

    // Cap at 200 entries
    while (panel.children.length > 200) {
      panel.removeChild(panel.firstChild);
    }

    if (visible) panel.scrollTop = panel.scrollHeight;
  }

  // Log startup
  console.log("[debug] On-screen console active. Tap D to toggle.");
})();
