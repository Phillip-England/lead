package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestHandleIndexInjectsSessionToken(t *testing.T) {
	app := &App{
		static:       http.FS(fstest.MapFS{"index.html": {Data: []byte(`<meta name="lead-session-token" content="__LEAD_SESSION_TOKEN__">`)}}),
		sessionToken: "test-token",
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	app.handleIndex(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `content="test-token"`) {
		t.Fatalf("expected session token in index html, got %q", rec.Body.String())
	}
}

func TestRequireSessionRejectsMissingToken(t *testing.T) {
	app := &App{sessionToken: "test-token"}

	handler := app.requireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/servers", nil)
	req.Host = "127.0.0.1:8080"
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", rec.Code)
	}
}

func TestRequireSessionAllowsHeaderTokenAndMatchingOrigin(t *testing.T) {
	app := &App{sessionToken: "test-token"}

	handler := app.requireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/servers", nil)
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Origin", "http://127.0.0.1:8080")
	req.Header.Set("X-Lead-Session", "test-token")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected status 204, got %d", rec.Code)
	}
}

func TestRequireSessionRejectsMismatchedOrigin(t *testing.T) {
	app := &App{sessionToken: "test-token"}

	handler := app.requireSession(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/servers/abc/shell/xyz/ws?token=test-token", nil)
	req.Host = "127.0.0.1:8080"
	req.Header.Set("Origin", "http://attacker.example")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", rec.Code)
	}
}
