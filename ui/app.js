const state = {
  servers: [],
  activeServerId: null,
  activeSection: "add",
  mobileNavOpen: false,
  serverStatus: {},
  shellSessionId: null,
  shellServerId: null,
  shellSocket: null,
  terminal: null,
  fitAddon: null,
  resizeObserver: null,
  shellControlBuffer: "",
};

const leadDeleteSentinel = "__LEAD_DELETE_SERVER__";

const els = {
  form: document.querySelector("#server-form"),
  serverList: document.querySelector("#server-list"),
  navLinks: document.querySelectorAll("[data-section]"),
  navToggle: document.querySelector("#nav-toggle"),
  navToggleOpen: document.querySelector(".nav-toggle-open"),
  navToggleClose: document.querySelector(".nav-toggle-close"),
  navOverlay: document.querySelector("#nav-overlay"),
  navDrawer: document.querySelector("#nav-drawer"),
  sectionAdd: document.querySelector("#section-add"),
  sectionAccess: document.querySelector("#section-access"),
  sectionDocs: document.querySelector("#section-docs"),
  globalNote: document.querySelector("#global-note"),
  shellModal: document.querySelector("#shell-modal"),
  shellTerminal: document.querySelector("#shell-terminal"),
  shellServerName: document.querySelector("#shell-server-name"),
  shellServerMeta: document.querySelector("#shell-server-meta"),
  shellStatus: document.querySelector("#shell-status"),
  shellStatusText: document.querySelector("#shell-status-text"),
};

function setShellLoading(message = "", busy = false) {
  const loading = Boolean(message);
  els.shellStatus.classList.toggle("hidden", !loading);
  els.shellTerminal.classList.toggle("shell-terminal-loading", loading);
  els.shellStatus.classList.toggle("shell-status-busy", busy);
  els.shellStatusText.textContent = message;
}

function activeServer() {
  return state.servers.find((server) => server.id === state.activeServerId) || null;
}

function isMobileNav() {
  return window.innerWidth <= 720;
}

function closeMobileNav() {
  state.mobileNavOpen = false;
  els.navDrawer.classList.add("hidden");
  els.navOverlay.classList.add("hidden");
  els.navToggle.setAttribute("aria-expanded", "false");
  els.navToggleOpen.classList.remove("hidden");
  els.navToggleClose.classList.add("hidden");
}

function openMobileNav() {
  state.mobileNavOpen = true;
  els.navDrawer.classList.remove("hidden");
  els.navOverlay.classList.remove("hidden");
  els.navToggle.setAttribute("aria-expanded", "true");
  els.navToggleOpen.classList.add("hidden");
  els.navToggleClose.classList.remove("hidden");
}

function renderSections() {
  els.sectionAdd.classList.toggle("hidden", state.activeSection !== "add");
  els.sectionAccess.classList.toggle("hidden", state.activeSection !== "access");
  els.sectionDocs.classList.toggle("hidden", state.activeSection !== "docs");

  els.navLinks.forEach((link) => {
    link.classList.toggle("active", link.dataset.section === state.activeSection);
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function ensureTerminal() {
  if (state.terminal) {
    return;
  }

  state.terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: 14,
    scrollback: 4000,
    theme: {
      background: "#05060d",
      foreground: "#efe6ff",
      cursor: "#b98cff",
      selectionBackground: "rgba(151, 92, 255, 0.28)",
    },
  });
  state.fitAddon = new FitAddon.FitAddon();
  state.terminal.loadAddon(state.fitAddon);
  state.terminal.open(els.shellTerminal);
  state.terminal.onData((data) => {
    if (!state.shellSocket || state.shellSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    state.shellSocket.send(JSON.stringify({ type: "input", data }));
  });

  state.resizeObserver = new ResizeObserver(() => {
    fitTerminal();
  });
  state.resizeObserver.observe(els.shellTerminal);
}

function fitTerminal() {
  if (!state.terminal || !state.fitAddon) {
    return;
  }

  state.fitAddon.fit();

  if (!state.shellSocket || state.shellSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.shellSocket.send(JSON.stringify({
    type: "resize",
    cols: state.terminal.cols,
    rows: state.terminal.rows,
  }));
}

function renderServers() {
  if (!state.servers.length) {
    els.serverList.innerHTML = `<p class="muted">No servers saved yet.</p>`;
    return;
  }

  els.serverList.innerHTML = state.servers.map((server) => {
    const active = server.id === state.activeServerId ? "active" : "";
    const accessible = state.serverStatus[server.id] === true;
    const indicatorClass = accessible ? "status-green" : "status-red";
    const indicatorLabel = accessible ? "Accessible" : "Inaccessible";
    return `
      <article class="server-item ${active}" data-server="${server.id}">
        <div class="server-row">
          <div class="server-main">
            <h3>${escapeHTML(server.name)}</h3>
            <div class="server-meta">
              <span>${escapeHTML(server.username)}@${escapeHTML(server.host)}:${escapeHTML(server.port)}</span>
            </div>
          </div>
          <span class="server-indicator ${indicatorClass}" title="${indicatorLabel}" aria-label="${indicatorLabel}"></span>
        </div>
      </article>
    `;
  }).join("");

  els.serverList.querySelectorAll("[data-server]").forEach((row) => {
    row.addEventListener("click", () => accessServer(row.dataset.server));
  });
}

function writeTerminalData(data) {
  if (!state.terminal) {
    return;
  }

  const combined = state.shellControlBuffer + data;
  if (combined.includes(leadDeleteSentinel)) {
    state.shellControlBuffer = "";
    const filtered = combined.replaceAll(leadDeleteSentinel, "");
    if (filtered) {
      state.terminal.write(filtered, () => {
        state.terminal.scrollToBottom();
      });
    }
    void deleteActiveServerFromShell();
    return;
  }

  let bufferLength = 0;
  const maxPrefixLength = Math.min(leadDeleteSentinel.length - 1, combined.length);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    if (leadDeleteSentinel.startsWith(combined.slice(-length))) {
      bufferLength = length;
      break;
    }
  }

  state.shellControlBuffer = combined.slice(-bufferLength);
  const visibleOutput = combined.slice(0, combined.length - bufferLength);
  if (!visibleOutput) {
    return;
  }

  state.terminal.write(visibleOutput, () => {
    state.terminal.scrollToBottom();
  });
}

async function loadServers() {
  const data = await api("/api/servers");
  state.servers = data.servers || [];

  if (state.activeServerId && !activeServer()) {
    state.activeServerId = null;
    closeShellView();
  }
  if (!state.activeServerId && state.servers.length) {
    state.activeServerId = state.servers[0].id;
  }

  renderServers();
  renderSections();
  refreshServerStatuses();
}

async function accessServer(serverId) {
  state.activeServerId = serverId;
  state.activeSection = "access";
  renderServers();
  renderSections();
  await openShell();
}

async function deleteServer(serverId) {
  try {
    if (state.activeServerId === serverId) {
      await closeShellSession();
    }
    await api(`/api/servers/${serverId}`, { method: "DELETE" });
    if (state.activeServerId === serverId) {
      state.activeServerId = null;
      closeShellView();
    }
    delete state.serverStatus[serverId];
    els.globalNote.textContent = "";
    await loadServers();
  } catch (error) {
    els.globalNote.textContent = error.message;
  }
}

async function deleteActiveServerFromShell() {
  const serverId = state.activeServerId;
  if (!serverId) {
    return;
  }

  setShellLoading("Deleting server...", true);
  await deleteServer(serverId);
}

async function refreshServerStatuses() {
  const servers = [...state.servers];
  await Promise.allSettled(servers.map(async (server) => {
    try {
      await api(`/api/servers/${server.id}/test`, { method: "POST" });
      state.serverStatus[server.id] = true;
    } catch (_) {
      state.serverStatus[server.id] = false;
    }
    renderServers();
  }));
}

function closeSocket() {
  if (state.shellSocket) {
    state.shellSocket.onclose = null;
    state.shellSocket.close();
    state.shellSocket = null;
  }
}

async function openShell() {
  const server = activeServer();
  if (!server) {
    return;
  }

  await closeShellSession();
  ensureTerminal();
  state.shellControlBuffer = "";
  state.terminal.clear();
  els.shellServerName.textContent = server.name;
  els.shellServerMeta.textContent = `${server.username}@${server.host}:${server.port}`;
  document.body.classList.add("shell-open");
  els.shellModal.classList.remove("hidden");
  els.shellModal.setAttribute("aria-hidden", "false");
  setShellLoading("Opening remote shell...", true);

  try {
    const session = await api(`/api/servers/${server.id}/shell`, {
      method: "POST",
      body: JSON.stringify({
        cols: state.terminal.cols || 120,
        rows: state.terminal.rows || 32,
      }),
    });

    state.shellSessionId = session.session.id;
    state.shellServerId = server.id;
    state.serverStatus[server.id] = true;
    els.globalNote.textContent = "";
    setShellLoading("Connecting terminal...", true);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketURL = `${protocol}//${window.location.host}/api/servers/${server.id}/shell/${state.shellSessionId}/ws`;
    state.shellSocket = new WebSocket(socketURL);

    state.shellSocket.addEventListener("open", () => {
      state.shellSocket.send(JSON.stringify({
        type: "input",
        data: `delete(){ printf '${leadDeleteSentinel}'; }\r`,
      }));
      setShellLoading("");
      fitTerminal();
      state.terminal.focus();
    });

    state.shellSocket.addEventListener("message", (event) => {
      writeTerminalData(event.data);
    });

    state.shellSocket.addEventListener("close", () => {
      state.shellSocket = null;
      state.shellSessionId = null;
      state.shellServerId = null;
      setShellLoading("");
      closeShellView();
    });

    state.shellSocket.addEventListener("error", () => {
      setShellLoading("Terminal connection failed.");
    });
  } catch (error) {
    state.shellSessionId = null;
    state.shellServerId = null;
    setShellLoading(error.message);
    els.globalNote.textContent = error.message;
  }
}

async function closeShellSession() {
  const sessionId = state.shellSessionId;
  const serverId = state.shellServerId;

  closeSocket();
  state.shellSessionId = null;
  state.shellServerId = null;

  if (!sessionId || !serverId) {
    return;
  }

  try {
    await api(`/api/servers/${serverId}/shell/${sessionId}`, { method: "DELETE" });
  } catch (_) {
    // Best-effort cleanup.
  }
}

function closeShellView() {
  closeSocket();
  state.shellSessionId = null;
  state.shellServerId = null;
  state.shellControlBuffer = "";
  document.body.classList.remove("shell-open");
  els.shellModal.classList.add("hidden");
  els.shellModal.setAttribute("aria-hidden", "true");
  setShellLoading("");
  if (state.terminal) {
    state.terminal.clear();
  }
}

function escapeHTML(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(els.form);
  const payload = Object.fromEntries(formData.entries());

  try {
    await api("/api/servers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.form.reset();
    state.activeSection = "access";
    await loadServers();
  } catch (error) {
    els.globalNote.textContent = error.message;
  }
});

els.navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    state.activeSection = link.dataset.section;
    renderSections();
    closeMobileNav();
  });
});
els.navToggle.addEventListener("click", () => {
  if (state.mobileNavOpen) {
    closeMobileNav();
    return;
  }
  openMobileNav();
});
els.navOverlay.addEventListener("click", closeMobileNav);

window.addEventListener("resize", () => {
  fitTerminal();
  if (!isMobileNav()) {
    closeMobileNav();
  }
});

loadServers().catch((error) => {
  els.globalNote.textContent = error.message;
});
