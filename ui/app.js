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
  shellControlBuffer: new Uint8Array(0),
  shellOutputDecoder: new TextDecoder(),
};

const leadDeleteSentinel = "__LEAD_DELETE_SERVER__";
const leadDeleteCommand = "lead_delete_server";
const textEncoder = new TextEncoder();
const leadDeleteMarker = `\n${leadDeleteSentinel}\n`;
const leadDeleteMarkerBytes = textEncoder.encode(leadDeleteMarker);
const leadSessionToken = document
  .querySelector('meta[name="lead-session-token"]')
  ?.getAttribute("content") || "";

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

const sectionDefaultFocus = {
  add: () => els.form.elements.namedItem("name"),
  access: () => (
    els.serverList.querySelector("[data-server]")
    || getVisibleNavLinks().find((link) => link.dataset.section === "access")
    || null
  ),
  docs: () => getVisibleNavLinks()[0] || null,
};

function isElementVisible(element) {
  if (!element || element.closest(".hidden")) {
    return false;
  }
  return element.getClientRects().length > 0;
}

function getVisibleNavLinks() {
  return Array.from(els.navLinks).filter((link) => (
    isElementVisible(link) && link.closest(".topbar-nav, .nav-drawer-links")
  ));
}

function getSectionFocusables() {
  if (state.activeSection === "add") {
    return [
      ...Array.from(els.form.querySelectorAll("input, button")),
    ].filter(isElementVisible);
  }

  if (state.activeSection === "access") {
    return Array.from(els.serverList.querySelectorAll("[data-server]")).filter(isElementVisible);
  }

  return [];
}

function getFocusCycle() {
  return [...getVisibleNavLinks(), ...getSectionFocusables()];
}

function focusElement(element) {
  if (!element) {
    return;
  }
  element.focus();
  if (typeof element.select === "function" && element.matches("input")) {
    element.select();
  }
}

function focusDefaultForActiveSection() {
  const target = sectionDefaultFocus[state.activeSection]?.() || getFocusCycle()[0] || null;
  focusElement(target);
}

function focusRelative(direction) {
  const cycle = getFocusCycle();
  if (!cycle.length) {
    return;
  }

  const currentIndex = cycle.indexOf(document.activeElement);
  if (currentIndex === -1) {
    focusElement(direction > 0 ? cycle[0] : cycle[cycle.length - 1]);
    return;
  }

  const nextIndex = (currentIndex + direction + cycle.length) % cycle.length;
  focusElement(cycle[nextIndex]);
}

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
      "X-Lead-Session": leadSessionToken,
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    Object.assign(error, data);
    throw error;
  }
  return data;
}

function ensureTerminal() {
  if (state.terminal) {
    return;
  }

  state.terminal = new Terminal({
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

function nextAnimationFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function prepareTerminalLayout() {
  ensureTerminal();
  await nextAnimationFrame();
  fitTerminal();
  await nextAnimationFrame();
  fitTerminal();

  if (state.terminal && state.terminal.rows > 0) {
    state.terminal.refresh(0, state.terminal.rows - 1);
  }
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
    const isActive = server.id === state.activeServerId;
    const accessible = state.serverStatus[server.id] === true;
    const indicatorClass = accessible ? "status-green" : "status-red";
    const indicatorLabel = accessible ? "Accessible" : "Inaccessible";

    return `
      <article
        class="server-item ${isActive ? "active" : ""}"
        data-server="${server.id}"
        tabindex="0"
        role="button"
        aria-label="Connect to ${escapeHTML(server.name)}"
      >
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
    row.addEventListener("click", () => {
      void accessServer(row.dataset.server);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      void accessServer(row.dataset.server);
    });
  });
}

function decodeBase64ToBytes(value) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(left, right) {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function indexOfBytes(haystack, needle, fromIndex = 0) {
  if (needle.length === 0) {
    return fromIndex;
  }

  const maxStart = haystack.length - needle.length;
  for (let i = fromIndex; i <= maxStart; i += 1) {
    let matches = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return i;
    }
  }

  return -1;
}

function trailingPartialMarkerLength(bytes, marker) {
  const maxLength = Math.min(bytes.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    let matches = true;
    const start = bytes.length - length;
    for (let i = 0; i < length; i += 1) {
      if (bytes[start + i] !== marker[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return length;
    }
  }

  return 0;
}

function writeTerminalChunk(data) {
  if (!state.terminal || !data.length) {
    return;
  }

  const text = state.shellOutputDecoder.decode(data, { stream: true });
  if (!text) {
    return;
  }

  state.terminal.write(text, () => {
    state.terminal.scrollToBottom();
  });
}

function writeTerminalData(data) {
  if (!state.terminal) {
    return;
  }

  const combined = concatBytes(state.shellControlBuffer, data);
  let shouldDeleteServer = false;
  let searchStart = 0;
  let matchIndex = indexOfBytes(combined, leadDeleteMarkerBytes, searchStart);

  while (matchIndex !== -1) {
    writeTerminalChunk(combined.slice(searchStart, matchIndex));
    shouldDeleteServer = true;
    searchStart = matchIndex + leadDeleteMarkerBytes.length;
    matchIndex = indexOfBytes(combined, leadDeleteMarkerBytes, searchStart);
  }

  let remainder = combined.slice(searchStart);
  const pendingMarkerLength = trailingPartialMarkerLength(remainder, leadDeleteMarkerBytes);
  if (remainder.length > pendingMarkerLength) {
    const flushLength = remainder.length - pendingMarkerLength;
    writeTerminalChunk(remainder.slice(0, flushLength));
    remainder = remainder.slice(flushLength);
  }
  state.shellControlBuffer = remainder;

  if (shouldDeleteServer) {
    void deleteActiveServerFromShell();
  }
}

function flushShellControlBuffer() {
  if (!state.terminal) {
    state.shellControlBuffer = new Uint8Array(0);
    state.shellOutputDecoder = new TextDecoder();
    return;
  }

  if (state.shellControlBuffer.length) {
    writeTerminalChunk(state.shellControlBuffer);
  }
  const trailingText = state.shellOutputDecoder.decode();
  if (trailingText) {
    state.terminal.write(trailingText, () => {
      state.terminal.scrollToBottom();
    });
  }

  state.shellControlBuffer = new Uint8Array(0);
  state.shellOutputDecoder = new TextDecoder();
}

function resetShellOutputState() {
  if (!state.terminal) {
    state.shellControlBuffer = new Uint8Array(0);
    return;
  }

  state.shellControlBuffer = new Uint8Array(0);
  state.shellOutputDecoder = new TextDecoder();
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
  window.requestAnimationFrame(() => {
    if (!isElementVisible(document.activeElement) || document.activeElement === document.body) {
      focusDefaultForActiveSection();
    }
  });
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
  els.shellServerName.textContent = server.name;
  els.shellServerMeta.textContent = `${server.username}@${server.host}:${server.port}`;
  document.body.classList.add("shell-open");
  els.shellModal.classList.remove("hidden");
  els.shellModal.setAttribute("aria-hidden", "false");
  setShellLoading("Opening remote shell...", true);

  await prepareTerminalLayout();
  resetShellOutputState();
  state.terminal.clear();

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
    const socketURL = `${protocol}//${window.location.host}/api/servers/${server.id}/shell/${state.shellSessionId}/ws?token=${encodeURIComponent(leadSessionToken)}`;
    state.shellSocket = new WebSocket(socketURL);

    state.shellSocket.addEventListener("open", () => {
      fitTerminal();
      state.shellSocket.send(JSON.stringify({
        type: "input",
        data: `${leadDeleteCommand}(){ printf '\\n${leadDeleteSentinel}\\n'; }\r`,
      }));
      setShellLoading("");
      state.terminal.focus();
    });

    state.shellSocket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (message.type !== "output" || typeof message.data !== "string") {
        return;
      }

      writeTerminalData(decodeBase64ToBytes(message.data));
    });

    state.shellSocket.addEventListener("close", () => {
      flushShellControlBuffer();
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
  resetShellOutputState();
  document.body.classList.remove("shell-open");
  els.shellModal.classList.add("hidden");
  els.shellModal.setAttribute("aria-hidden", "true");
  setShellLoading("");
  if (state.terminal) {
    state.terminal.clear();
  }
  window.requestAnimationFrame(() => {
    focusDefaultForActiveSection();
  });
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
    window.requestAnimationFrame(() => {
      focusDefaultForActiveSection();
    });
  } catch (error) {
    els.globalNote.textContent = error.message;
  }
});

els.navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    state.activeSection = link.dataset.section;
    renderSections();
    closeMobileNav();
    window.requestAnimationFrame(() => {
      focusDefaultForActiveSection();
    });
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

document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    state.shellSessionId
  ) {
    return;
  }

  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }

  const active = document.activeElement;
  if (!active || !getFocusCycle().includes(active)) {
    return;
  }

  event.preventDefault();
  focusRelative(event.key === "ArrowDown" ? 1 : -1);
});

loadServers().catch((error) => {
  els.globalNote.textContent = error.message;
});

window.requestAnimationFrame(() => {
  focusDefaultForActiveSection();
});
