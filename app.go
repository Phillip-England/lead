package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"
)

type App struct {
	store         *Store
	static        http.FileSystem
	sessionToken  string
	shellSessions map[string]*ShellSession
	mu            sync.RWMutex
}

type ShellSession struct {
	ID       string
	ServerID string
	Shell    *RemoteShell
}

func NewApp(store *Store, static http.FileSystem) *App {
	return &App{
		store:         store,
		static:        static,
		sessionToken:  newID(),
		shellSessions: map[string]*ShellSession{},
	}
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handleIndex)
	mux.Handle("/api/servers", a.requireSession(http.HandlerFunc(a.handleServers)))
	mux.Handle("/api/servers/", a.requireSession(http.HandlerFunc(a.handleServerActions)))
	mux.Handle("/app.css", http.FileServer(a.static))
	mux.Handle("/app.js", http.FileServer(a.static))
	mux.Handle("/xterm.css", http.FileServer(a.static))
	mux.Handle("/xterm.js", http.FileServer(a.static))
	mux.Handle("/xterm-addon-fit.js", http.FileServer(a.static))
	return withHeaders(mux)
}

func (a *App) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	file, err := a.static.Open("index.html")
	if err != nil {
		http.Error(w, "missing index", http.StatusInternalServerError)
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		http.Error(w, "stat index", http.StatusInternalServerError)
		return
	}

	indexBytes, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "read index", http.StatusInternalServerError)
		return
	}

	indexHTML := strings.ReplaceAll(string(indexBytes), "__LEAD_SESSION_TOKEN__", a.sessionToken)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "index.html", info.ModTime(), bytes.NewReader([]byte(indexHTML)))
}

func (a *App) handleServers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"servers": a.store.ListServers(),
		})
	case http.MethodPost:
		var input struct {
			Name     string `json:"name"`
			Host     string `json:"host"`
			Port     string `json:"port"`
			Username string `json:"username"`
			Password string `json:"password"`
		}

		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json body")
			return
		}

		if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.Host) == "" || strings.TrimSpace(input.Username) == "" {
			writeError(w, http.StatusBadRequest, "name, host, and username are required")
			return
		}
		if port := strings.TrimSpace(input.Port); port != "" {
			if _, err := parsePort(port); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
		}

		server, err := a.store.AddServer(ServerRecord{
			Name:     strings.TrimSpace(input.Name),
			Host:     strings.TrimSpace(input.Host),
			Port:     strings.TrimSpace(input.Port),
			Username: strings.TrimSpace(input.Username),
			Password: input.Password,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{"server": server})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (a *App) handleServerActions(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/servers/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) == 1 {
		if r.Method != http.MethodDelete {
			http.NotFound(w, r)
			return
		}

		if err := a.store.DeleteServer(parts[0]); err != nil {
			if err == os.ErrNotExist {
				writeError(w, http.StatusNotFound, "server not found")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	if len(parts) < 2 {
		http.NotFound(w, r)
		return
	}

	server, ok := a.store.GetServer(parts[0])
	if !ok {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}

	switch parts[1] {
	case "test":
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		a.handleTestServer(w, server)
	case "shell":
		a.handleShellRoutes(w, r, server, parts[2:])
	default:
		http.NotFound(w, r)
	}
}

func (a *App) handleTestServer(w http.ResponseWriter, server ServerRecord) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	output, err := runSSH(ctx, server, "printf 'connected'")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": strings.TrimSpace(output),
	})
}

func (a *App) handleShellRoutes(w http.ResponseWriter, r *http.Request, server ServerRecord, rest []string) {
	if len(rest) == 0 {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		a.handleOpenShell(w, r, server)
		return
	}

	session, ok := a.getShellSession(rest[0], server.ID)
	if !ok {
		writeError(w, http.StatusNotFound, "shell session not found")
		return
	}

	if len(rest) == 1 && r.Method == http.MethodDelete {
		a.deleteShellSession(session.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}

	if len(rest) == 2 && rest[1] == "ws" && r.Method == http.MethodGet {
		websocket.Handler(func(ws *websocket.Conn) {
			a.handleShellSocket(ws, session)
		}).ServeHTTP(w, r)
		return
	}

	http.NotFound(w, r)
}

func (a *App) handleOpenShell(w http.ResponseWriter, r *http.Request, server ServerRecord) {
	var input struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}

	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&input)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	shell, err := openRemoteShell(ctx, server, input.Cols, input.Rows)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	session := &ShellSession{
		ID:       newID(),
		ServerID: server.ID,
		Shell:    shell,
	}

	a.mu.Lock()
	a.shellSessions[session.ID] = session
	a.mu.Unlock()

	go func(id string, remote *RemoteShell) {
		<-remote.Wait()
		a.deleteShellSession(id)
	}(session.ID, shell)

	writeJSON(w, http.StatusCreated, map[string]any{
		"session": map[string]any{
			"id": session.ID,
		},
	})
}

func (a *App) handleShellSocket(ws *websocket.Conn, session *ShellSession) {
	defer ws.Close()
	defer a.deleteShellSession(session.ID)

	inputMessages := make(chan shellMessage, 16)
	inputErr := make(chan error, 1)
	outputMessages := make(chan []byte, 16)
	outputErr := make(chan error, 1)

	go readShellMessages(ws, inputMessages, inputErr)
	go readShellOutput(session.Shell, outputMessages, outputErr)

	for {
		select {
		case msg := <-inputMessages:
			switch msg.Type {
			case "input":
				if _, err := session.Shell.Write([]byte(msg.Data)); err != nil {
					return
				}
			case "resize":
				if err := session.Shell.Resize(msg.Cols, msg.Rows); err != nil {
					return
				}
			}
		case output := <-outputMessages:
			if len(output) == 0 {
				continue
			}
			payload, err := json.Marshal(shellOutputMessage{
				Type: "output",
				Data: base64.StdEncoding.EncodeToString(output),
			})
			if err != nil {
				return
			}
			if err := websocket.Message.Send(ws, string(payload)); err != nil {
				return
			}
		case err := <-inputErr:
			if err != nil {
				return
			}
		case err := <-outputErr:
			if err != nil {
				return
			}
		case <-session.Shell.Wait():
			return
		}
	}
}

type shellMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type shellOutputMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

func readShellMessages(ws *websocket.Conn, messages chan<- shellMessage, readErr chan<- error) {
	for {
		var raw string
		if err := websocket.Message.Receive(ws, &raw); err != nil {
			readErr <- err
			return
		}

		var msg shellMessage
		if err := json.Unmarshal([]byte(raw), &msg); err != nil {
			continue
		}
		messages <- msg
	}
}

func readShellOutput(shell *RemoteShell, output chan<- []byte, outputErr chan<- error) {
	buf := make([]byte, 4096)
	for {
		n, err := shell.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			output <- chunk
		}
		if err != nil {
			outputErr <- err
			return
		}
	}
}

func (a *App) getShellSession(id string, serverID string) (*ShellSession, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()

	session, ok := a.shellSessions[id]
	if !ok || session.ServerID != serverID {
		return nil, false
	}

	return session, true
}

func (a *App) deleteShellSession(id string) {
	a.mu.Lock()
	session, ok := a.shellSessions[id]
	if ok {
		delete(a.shellSessions, id)
	}
	a.mu.Unlock()

	if ok {
		_ = session.Shell.Close()
	}
}

func withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

func (a *App) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requestOriginAllowed(r) {
			writeError(w, http.StatusForbidden, "origin not allowed")
			return
		}
		if !a.requestHasValidSessionToken(r) {
			writeError(w, http.StatusForbidden, "session token required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requestOriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}

	originURL, err := url.Parse(origin)
	if err != nil {
		return false
	}

	return strings.EqualFold(originURL.Host, r.Host)
}

func (a *App) requestHasValidSessionToken(r *http.Request) bool {
	token := strings.TrimSpace(r.Header.Get("X-Lead-Session"))
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("token"))
	}
	return token != "" && token == a.sessionToken
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": message,
	})
}
