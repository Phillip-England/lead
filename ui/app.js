const state = {
  servers: [],
  activeServerId: null,
  activeSection: "add",
  mobileNavOpen: false,
  connectMode: "single",
  selectedServerIds: [],
  serverStatus: {},
  shellMode: null,
  shellSessionId: null,
  shellServerId: null,
  shellSocket: null,
  multiServerIds: [],
  multiTargetIds: [],
  multiInputBuffer: "",
  multiCommandBusy: false,
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
  connectModeLinks: document.querySelectorAll("[data-connect-mode]"),
  multiConnectBar: document.querySelector("#multi-connect-bar"),
  connectAll: document.querySelector("#connect-all"),
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

function activeMultiServers() {
  return state.servers.filter((server) => state.multiServerIds.includes(server.id));
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

function renderConnectMode() {
  els.connectModeLinks.forEach((button) => {
    button.classList.toggle("active", button.dataset.connectMode === state.connectMode);
  });

  const selectedCount = state.selectedServerIds.length;
  const showMultiConnect = state.connectMode === "multi" && selectedCount >= 2;
  els.multiConnectBar.classList.toggle("hidden", !showMultiConnect);
  els.connectAll.textContent = showMultiConnect ? `Connect to All (${selectedCount})` : "Connect to All";
}

function setConnectMode(mode) {
  state.connectMode = mode;
  if (mode === "single") {
    state.selectedServerIds = [];
  }
  renderConnectMode();
  renderServers();
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
    if (state.shellMode === "multi") {
      handleMultiTerminalInput(data);
      return;
    }
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

  if (state.shellMode !== "single" || !state.shellSocket || state.shellSocket.readyState !== WebSocket.OPEN) {
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
    const isSelected = state.selectedServerIds.includes(server.id);
    const isActive = state.connectMode === "single" && server.id === state.activeServerId;
    const stateClass = isSelected ? "selected" : (isActive ? "active" : "");
    const accessible = state.serverStatus[server.id] === true;
    const indicatorClass = accessible ? "status-green" : "status-red";
    const indicatorLabel = accessible ? "Accessible" : "Inaccessible";
    const multiIndicator = state.connectMode === "multi"
      ? `<span class="server-select-indicator" aria-hidden="true">${isSelected ? "Selected" : ""}</span>`
      : "";

    return `
      <article class="server-item ${stateClass}" data-server="${server.id}">
        <div class="server-row">
          <div class="server-main">
            <h3>${escapeHTML(server.name)}</h3>
            <div class="server-meta">
              <span>${escapeHTML(server.username)}@${escapeHTML(server.host)}:${escapeHTML(server.port)}</span>
            </div>
          </div>
          ${multiIndicator}
          <span class="server-indicator ${indicatorClass}" title="${indicatorLabel}" aria-label="${indicatorLabel}"></span>
        </div>
      </article>
    `;
  }).join("");

  els.serverList.querySelectorAll("[data-server]").forEach((row) => {
    row.addEventListener("click", () => {
      if (state.connectMode === "multi") {
        toggleServerSelection(row.dataset.server);
        return;
      }
      accessServer(row.dataset.server);
    });
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

function writeMultiLine(line = "") {
  if (!state.terminal) {
    return;
  }
  state.terminal.write(`${line}\r\n`, () => {
    state.terminal.scrollToBottom();
  });
}

function writeMultiPrompt(newLine = true) {
  if (!state.terminal) {
    return;
  }

  const prefix = newLine ? "\r\n" : "";
  const activeCount = state.multiTargetIds.length;
  state.terminal.write(`${prefix}\x1b[38;5;141mlead:${activeCount}/${state.multiServerIds.length}> \x1b[0m`);
}

function findMultiServerIndex(serverId) {
  return state.multiServerIds.indexOf(serverId);
}

function isMultiTarget(serverId) {
  return state.multiTargetIds.includes(serverId);
}

function formatMultiServerLabel(server) {
  const index = findMultiServerIndex(server.id);
  const iconColor = isMultiTarget(server.id) ? "32" : "31";
  return `\x1b[${iconColor}m●\x1b[0m ${index} ${server.name} (${server.username}@${server.host}:${server.port})`;
}

function writeMultiTargets() {
  const servers = activeMultiServers();
  servers.forEach((server) => {
    writeMultiLine(`[${formatMultiServerLabel(server)}]`);
  });
}

function writeMultiDocs() {
  writeMultiLine(`\x1b[1;35mMulti shell native commands\x1b[0m`);
  writeMultiLine(`\x1b[38;5;246mGreen ● means active target. Red ● means inactive target.\x1b[0m`);
  writeMultiLine(`\x1b[38;5;246mEach server keeps its index for the whole multi-shell session.\x1b[0m`);
  writeMultiLine(`\x1b[38;5;141mdocs\x1b[0m  Show this help.`);
  writeMultiLine(`\x1b[38;5;141mall\x1b[0m  Activate every server.`);
  writeMultiLine(`\x1b[38;5;141mon <index>\x1b[0m  Activate one server target.`);
  writeMultiLine(`\x1b[38;5;141moff <index>\x1b[0m  Deactivate one server target.`);
  writeMultiLine(`\x1b[38;5;141monly <index>\x1b[0m  Deactivate all other servers and keep only one active.`);
  writeMultiLine(`\x1b[38;5;141mclear\x1b[0m  Clear the shared terminal.`);
  writeMultiLine(`\x1b[38;5;141mexit\x1b[0m  Close multi shell.`);
  writeMultiLine(`\x1b[38;5;246mTargets:\x1b[0m`);
  writeMultiTargets();
}

function renderMultiShellIntro() {
  writeMultiLine(`\x1b[1;35mMulti shell connected\x1b[0m`);
  writeMultiTargets();
  writeMultiPrompt();
}

function updateMultiShellMeta() {
  const activeCount = state.multiTargetIds.length;
  els.shellServerMeta.textContent = `${activeCount}/${state.multiServerIds.length} active targets`;
}

function parseMultiIndexCommand(command, keyword) {
  const match = command.match(new RegExp(`^${keyword}\\s+(\\d+)$`));
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function multiServerByIndex(index) {
  const serverId = state.multiServerIds[index];
  if (!serverId) {
    return null;
  }
  return state.servers.find((server) => server.id === serverId) || null;
}

function setMultiTargets(serverIds) {
  state.multiTargetIds = state.multiServerIds.filter((serverId) => serverIds.includes(serverId));
  updateMultiShellMeta();
}

function handleMultiNativeCommand(command) {
  if (command === "docs") {
    writeMultiDocs();
    writeMultiPrompt();
    return true;
  }

  if (command === "all") {
    setMultiTargets([...state.multiServerIds]);
    writeMultiLine(`\x1b[32mAll targets activated.\x1b[0m`);
    writeMultiTargets();
    writeMultiPrompt();
    return true;
  }

  const onlyIndex = parseMultiIndexCommand(command, "only");
  if (onlyIndex !== null) {
    const server = multiServerByIndex(onlyIndex);
    if (!server) {
      writeMultiLine(`\x1b[31mUnknown server index: ${onlyIndex}\x1b[0m`);
      writeMultiPrompt();
      return true;
    }
    setMultiTargets([server.id]);
    writeMultiLine(`\x1b[32mOnly target ${onlyIndex} remains active.\x1b[0m`);
    writeMultiTargets();
    writeMultiPrompt();
    return true;
  }

  const onIndex = parseMultiIndexCommand(command, "on");
  if (onIndex !== null) {
    const server = multiServerByIndex(onIndex);
    if (!server) {
      writeMultiLine(`\x1b[31mUnknown server index: ${onIndex}\x1b[0m`);
      writeMultiPrompt();
      return true;
    }
    setMultiTargets([...state.multiTargetIds, server.id]);
    writeMultiLine(`\x1b[32mTarget ${onIndex} activated.\x1b[0m`);
    writeMultiTargets();
    writeMultiPrompt();
    return true;
  }

  const offIndex = parseMultiIndexCommand(command, "off");
  if (offIndex !== null) {
    const server = multiServerByIndex(offIndex);
    if (!server) {
      writeMultiLine(`\x1b[31mUnknown server index: ${offIndex}\x1b[0m`);
      writeMultiPrompt();
      return true;
    }
    setMultiTargets(state.multiTargetIds.filter((serverId) => serverId !== server.id));
    writeMultiLine(`\x1b[31mTarget ${offIndex} deactivated.\x1b[0m`);
    writeMultiTargets();
    writeMultiPrompt();
    return true;
  }

  return false;
}

function toggleServerSelection(serverId) {
  if (state.selectedServerIds.includes(serverId)) {
    state.selectedServerIds = state.selectedServerIds.filter((id) => id !== serverId);
  } else {
    state.selectedServerIds = [...state.selectedServerIds, serverId];
  }
  renderConnectMode();
  renderServers();
}

async function loadServers() {
  const data = await api("/api/servers");
  state.servers = data.servers || [];
  state.selectedServerIds = state.selectedServerIds.filter((id) => state.servers.some((server) => server.id === id));

  if (state.activeServerId && !activeServer()) {
    state.activeServerId = null;
    closeShellView();
  }
  if (!state.activeServerId && state.servers.length) {
    state.activeServerId = state.servers[0].id;
  }

  renderConnectMode();
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
    if (state.activeServerId === serverId && state.shellMode === "single") {
      await closeShellSession();
    }
    await api(`/api/servers/${serverId}`, { method: "DELETE" });
    if (state.activeServerId === serverId) {
      state.activeServerId = null;
      closeShellView();
    }
    state.selectedServerIds = state.selectedServerIds.filter((id) => id !== serverId);
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
  state.shellMode = "single";
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

function openMultiShell() {
  if (state.selectedServerIds.length < 2) {
    return;
  }

  closeSocket();
  ensureTerminal();
  state.shellMode = "multi";
  state.multiServerIds = [...state.selectedServerIds];
  state.multiTargetIds = [...state.selectedServerIds];
  state.multiInputBuffer = "";
  state.multiCommandBusy = false;
  state.shellControlBuffer = "";
  state.terminal.clear();
  els.shellServerName.textContent = "Multi shell";
  updateMultiShellMeta();
  document.body.classList.add("shell-open");
  els.shellModal.classList.remove("hidden");
  els.shellModal.setAttribute("aria-hidden", "false");
  setShellLoading("");
  fitTerminal();
  renderMultiShellIntro();
  state.terminal.focus();
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
  state.shellMode = null;
  state.shellSessionId = null;
  state.shellServerId = null;
  state.multiServerIds = [];
  state.multiTargetIds = [];
  state.multiInputBuffer = "";
  state.multiCommandBusy = false;
  state.shellControlBuffer = "";
  document.body.classList.remove("shell-open");
  els.shellModal.classList.add("hidden");
  els.shellModal.setAttribute("aria-hidden", "true");
  setShellLoading("");
  if (state.terminal) {
    state.terminal.clear();
  }
}

async function runMultiCommand(command) {
  if (!command) {
    writeMultiPrompt();
    return;
  }

  if (command === "exit") {
    closeShellView();
    return;
  }

  if (command === "clear") {
    state.terminal.clear();
    renderMultiShellIntro();
    return;
  }

  if (handleMultiNativeCommand(command)) {
    return;
  }

  if (command === "delete") {
    writeMultiLine(`\x1b[31mdelete is only available in a single-server shell.\x1b[0m`);
    writeMultiPrompt();
    return;
  }

  if (!state.multiTargetIds.length) {
    writeMultiLine(`\x1b[31mNo active targets. Use 'all', 'on <index>', or 'only <index>'.\x1b[0m`);
    writeMultiPrompt();
    return;
  }

  state.multiCommandBusy = true;
  writeMultiLine(`\x1b[38;5;141mRunning:\x1b[0m ${command}`);

  const servers = activeMultiServers().filter((server) => isMultiTarget(server.id));
  const results = await Promise.all(servers.map(async (server) => {
    try {
      const response = await api(`/api/servers/${server.id}/exec`, {
        method: "POST",
        body: JSON.stringify({ command }),
      });
      return {
        server,
        ok: true,
        output: response.output || "",
      };
    } catch (error) {
      return {
        server,
        ok: false,
        output: error.message,
      };
    }
  }));

  results.forEach((result, index) => {
    const tone = result.ok ? "38;5;111" : "31";
    const header = formatMultiServerLabel(result.server);
    const output = normalizeTerminalOutput(result.output) || "\x1b[38;5;246m(no output)\x1b[0m";
    writeMultiLine(`\x1b[${tone}m[${header}]\x1b[0m`);
    writeMultiLine(output);
    if (index < results.length - 1) {
      writeMultiLine("\x1b[38;5;240m────────────────────────────────────────\x1b[0m");
    }
  });

  state.multiCommandBusy = false;
  writeMultiPrompt();
}

function handleMultiTerminalInput(data) {
  if (!state.terminal) {
    return;
  }

  for (const char of data) {
    if (char === "\u0003") {
      if (!state.multiCommandBusy) {
        state.multiInputBuffer = "";
        writeMultiLine("^C");
        writeMultiPrompt();
      }
      continue;
    }

    if (char === "\r") {
      if (state.multiCommandBusy) {
        continue;
      }
      const command = state.multiInputBuffer.trim();
      state.terminal.write("\r\n");
      state.multiInputBuffer = "";
      void runMultiCommand(command);
      continue;
    }

    if (char === "\u007F") {
      if (state.multiCommandBusy || !state.multiInputBuffer) {
        continue;
      }
      state.multiInputBuffer = state.multiInputBuffer.slice(0, -1);
      state.terminal.write("\b \b");
      continue;
    }

    if (char === "\u001b") {
      continue;
    }

    if (state.multiCommandBusy) {
      continue;
    }

    if (char >= " ") {
      state.multiInputBuffer += char;
      state.terminal.write(char);
    }
  }
}

function normalizeTerminalOutput(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => line || " ")
    .join("\r\n");
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

els.connectModeLinks.forEach((button) => {
  button.addEventListener("click", () => {
    setConnectMode(button.dataset.connectMode);
  });
});

els.connectAll.addEventListener("click", openMultiShell);

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

renderConnectMode();
loadServers().catch((error) => {
  els.globalNote.textContent = error.message;
});
