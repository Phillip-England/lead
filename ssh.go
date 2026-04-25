package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

type RemoteShell struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
	done    chan struct{}
	closeMu sync.Mutex
	closed  bool
}

type hostKeyStore struct {
	mu    sync.Mutex
	path  string
	known map[string]string
}

func newHostKeyStore() (*hostKeyStore, error) {
	dir, err := appDataDir()
	if err != nil {
		return nil, err
	}

	store := &hostKeyStore{
		path:  filepath.Join(dir, "hostkeys.json"),
		known: map[string]string{},
	}

	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return store, nil
	}
	if err := json.Unmarshal(data, &store.known); err != nil {
		return nil, err
	}

	return store, nil
}

func (s *hostKeyStore) callback(hostport string, _ net.Addr, key ssh.PublicKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	serialized := base64.StdEncoding.EncodeToString(key.Marshal())
	existing, ok := s.known[hostport]
	if ok {
		if existing != serialized {
			return fmt.Errorf("host key mismatch for %s", hostport)
		}
		return nil
	}

	s.known[hostport] = serialized
	data, err := json.MarshalIndent(s.known, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o600)
}

func runSSH(ctx context.Context, server ServerRecord, remoteScript string) (string, error) {
	client, err := dialSSH(ctx, server)
	if err != nil {
		return "", err
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr

	done := make(chan error, 1)
	go func() {
		done <- session.Run("sh -lc " + shellQuote(remoteScript))
	}()

	select {
	case <-ctx.Done():
		_ = session.Close()
		return strings.TrimSpace(stdout.String()), ctx.Err()
	case err := <-done:
		output := strings.TrimSpace(stdout.String())
		errOutput := strings.TrimSpace(stderr.String())
		if err != nil {
			if errOutput != "" {
				return output, fmt.Errorf("%w: %s", err, errOutput)
			}
			return output, err
		}
		if output == "" {
			output = errOutput
		}
		return output, nil
	}
}

func dialSSH(ctx context.Context, server ServerRecord) (*ssh.Client, error) {
	authMethods, err := authMethodsForServer(server)
	if err != nil {
		return nil, err
	}
	if len(authMethods) == 0 {
		return nil, errors.New("no SSH auth methods available; add a password or configure SSH keys/agent locally")
	}

	hostKeyStore, err := newHostKeyStore()
	if err != nil {
		return nil, err
	}

	port := server.Port
	if strings.TrimSpace(port) == "" {
		port = "22"
	}

	config := &ssh.ClientConfig{
		User:            server.Username,
		Auth:            authMethods,
		HostKeyCallback: hostKeyStore.callback,
		Timeout:         8 * time.Second,
	}

	address := net.JoinHostPort(server.Host, port)
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}

	c, chans, reqs, err := ssh.NewClientConn(conn, address, config)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}

	return ssh.NewClient(c, chans, reqs), nil
}

func authMethodsForServer(server ServerRecord) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod

	if password := strings.TrimSpace(server.Password); password != "" {
		methods = append(methods, ssh.Password(password))
	}

	agentMethod, err := agentAuthMethod()
	if err != nil {
		return nil, err
	}
	if agentMethod != nil {
		methods = append(methods, agentMethod)
	}

	signers, err := defaultKeySigners()
	if err != nil {
		return nil, err
	}
	for _, signer := range signers {
		methods = append(methods, ssh.PublicKeys(signer))
	}

	return methods, nil
}

func agentAuthMethod() (ssh.AuthMethod, error) {
	socket := strings.TrimSpace(os.Getenv("SSH_AUTH_SOCK"))
	if socket == "" {
		return nil, nil
	}

	conn, err := net.Dial("unix", socket)
	if err != nil {
		return nil, nil
	}

	return ssh.PublicKeysCallback(agent.NewClient(conn).Signers), nil
}

func defaultKeySigners() ([]ssh.Signer, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, nil
	}

	candidates := []string{
		filepath.Join(home, ".ssh", "id_ed25519"),
		filepath.Join(home, ".ssh", "id_ecdsa"),
		filepath.Join(home, ".ssh", "id_rsa"),
		filepath.Join(home, ".ssh", "id_dsa"),
	}

	signers := make([]ssh.Signer, 0, len(candidates))
	for _, candidate := range candidates {
		signer, err := signerFromFile(candidate)
		if err != nil {
			var passphraseErr *ssh.PassphraseMissingError
			if errors.As(err, &passphraseErr) {
				continue
			}
			return nil, err
		}
		if signer != nil {
			signers = append(signers, signer)
		}
	}

	return signers, nil
}

func signerFromFile(path string) (ssh.Signer, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	signer, err := ssh.ParsePrivateKey(data)
	if err == nil {
		return signer, nil
	}

	var passphraseErr *ssh.PassphraseMissingError
	if errors.As(err, &passphraseErr) {
		return nil, err
	}

	block, _ := pem.Decode(data)
	if block == nil {
		return nil, err
	}

	if _, parseErr := x509.ParsePKCS8PrivateKey(block.Bytes); parseErr == nil {
		return nil, err
	}

	return nil, err
}

func openRemoteShell(ctx context.Context, server ServerRecord, cols int, rows int) (*RemoteShell, error) {
	client, err := dialSSH(ctx, server)
	if err != nil {
		return nil, err
	}

	session, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, err
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		client.Close()
		return nil, err
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		client.Close()
		return nil, err
	}

	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}

	if err := session.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14_400,
		ssh.TTY_OP_OSPEED: 14_400,
	}); err != nil {
		session.Close()
		client.Close()
		return nil, err
	}

	if err := session.Shell(); err != nil {
		session.Close()
		client.Close()
		return nil, err
	}

	shell := &RemoteShell{
		client:  client,
		session: session,
		stdin:   stdin,
		stdout:  stdout,
		done:    make(chan struct{}),
	}

	go func() {
		_ = session.Wait()
		close(shell.done)
	}()

	return shell, nil
}

func detectRemoteCwd(ctx context.Context, server ServerRecord) (string, error) {
	output, err := runSSH(ctx, server, "pwd")
	if err != nil {
		return "", err
	}

	cwd := strings.TrimSpace(output)
	if cwd == "" {
		return "", fmt.Errorf("remote shell did not report a working directory")
	}

	return cwd, nil
}

func execRemoteCommand(ctx context.Context, server ServerRecord, cwd string, command string) (string, error) {
	script := command
	if strings.TrimSpace(cwd) != "" {
		script = fmt.Sprintf("cd -- %s && %s", shellQuote(cwd), command)
	}
	return runSSH(ctx, server, script)
}

func (s *RemoteShell) Read(p []byte) (int, error) {
	return s.stdout.Read(p)
}

func (s *RemoteShell) Write(p []byte) (int, error) {
	return s.stdin.Write(p)
}

func (s *RemoteShell) Resize(cols int, rows int) error {
	if cols <= 0 || rows <= 0 {
		return nil
	}
	return s.session.WindowChange(rows, cols)
}

func (s *RemoteShell) Wait() <-chan struct{} {
	return s.done
}

func (s *RemoteShell) Close() error {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()

	if s.closed {
		return nil
	}
	s.closed = true

	var closeErr error
	if err := s.stdin.Close(); err != nil {
		closeErr = err
	}
	if err := s.session.Close(); err != nil && !errors.Is(err, io.EOF) {
		closeErr = err
	}
	if err := s.client.Close(); err != nil && !errors.Is(err, net.ErrClosed) && closeErr == nil {
		closeErr = err
	}

	return closeErr
}

func parsePort(raw string) (int, error) {
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("invalid port: %s", raw)
	}
	return port, nil
}
