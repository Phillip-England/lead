package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

//go:embed ui
var uiFiles embed.FS

func main() {
	logger := log.New(os.Stdout, "lead: ", log.LstdFlags)

	store, err := NewStore()
	if err != nil {
		logger.Fatalf("load store: %v", err)
	}

	appFS, err := fs.Sub(uiFiles, "ui")
	if err != nil {
		logger.Fatalf("load embedded ui: %v", err)
	}

	app := NewApp(store, http.FS(appFS))

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		logger.Fatalf("listen: %v", err)
	}

	baseURL := fmt.Sprintf("http://%s", listener.Addr().String())

	server := &http.Server{
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		time.Sleep(200 * time.Millisecond)
		if err := openBrowser(baseURL); err != nil {
			logger.Printf("open browser manually: %s", baseURL)
		}
	}()

	go func() {
		logger.Printf("listening on %s", baseURL)
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Printf("shutdown error: %v", err)
	}
}

func openBrowser(url string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}

	return cmd.Start()
}

func appDataDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	path := filepath.Join(dir, "lead")
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}

	return path, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
