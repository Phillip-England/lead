package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	keyring "github.com/zalando/go-keyring"
)

const keyringService = "lead"

type SecretStore interface {
	SetPassword(serverID, password string) error
	GetPassword(serverID string) (string, error)
	DeletePassword(serverID string) error
}

type secretStore struct {
	keyring *osKeyringStore
	local   *encryptedFileStore
}

func NewSecretStore() (SecretStore, error) {
	local, err := newEncryptedFileStore()
	if err != nil {
		return nil, err
	}

	return &secretStore{
		keyring: &osKeyringStore{},
		local:   local,
	}, nil
}

func (s *secretStore) SetPassword(serverID, password string) error {
	if err := s.keyring.SetPassword(serverID, password); err == nil {
		_ = s.local.DeletePassword(serverID)
		return nil
	}
	return s.local.SetPassword(serverID, password)
}

func (s *secretStore) GetPassword(serverID string) (string, error) {
	password, err := s.keyring.GetPassword(serverID)
	switch {
	case err == nil:
		return password, nil
	case errors.Is(err, ErrSecretNotFound):
		return s.local.GetPassword(serverID)
	default:
		password, fallbackErr := s.local.GetPassword(serverID)
		if fallbackErr == nil {
			return password, nil
		}
		return "", err
	}
}

func (s *secretStore) DeletePassword(serverID string) error {
	_ = s.keyring.DeletePassword(serverID)
	_ = s.local.DeletePassword(serverID)
	return nil
}

var ErrSecretNotFound = errors.New("secret not found")

type osKeyringStore struct{}

func (s *osKeyringStore) SetPassword(serverID, password string) error {
	return keyring.Set(keyringService, serverID, password)
}

func (s *osKeyringStore) GetPassword(serverID string) (string, error) {
	password, err := keyring.Get(keyringService, serverID)
	if err != nil {
		if errors.Is(err, keyring.ErrNotFound) {
			return "", ErrSecretNotFound
		}
		return "", err
	}
	return password, nil
}

func (s *osKeyringStore) DeletePassword(serverID string) error {
	err := keyring.Delete(keyringService, serverID)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

type encryptedFileStore struct {
	mu      sync.Mutex
	path    string
	keyPath string
}

type encryptedSecretsFile struct {
	Entries map[string]string `json:"entries"`
}

func newEncryptedFileStore() (*encryptedFileStore, error) {
	dir, err := appDataDir()
	if err != nil {
		return nil, err
	}

	return &encryptedFileStore{
		path:    filepath.Join(dir, "secrets.json"),
		keyPath: filepath.Join(dir, "secrets.key"),
	}, nil
}

func (s *encryptedFileStore) SetPassword(serverID, password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.loadEntriesLocked()
	if err != nil {
		return err
	}

	encrypted, err := s.encryptLocked(password)
	if err != nil {
		return err
	}

	entries[serverID] = encrypted
	return s.saveEntriesLocked(entries)
}

func (s *encryptedFileStore) GetPassword(serverID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.loadEntriesLocked()
	if err != nil {
		return "", err
	}

	encrypted, ok := entries[serverID]
	if !ok {
		return "", ErrSecretNotFound
	}

	return s.decryptLocked(encrypted)
}

func (s *encryptedFileStore) DeletePassword(serverID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.loadEntriesLocked()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}

	delete(entries, serverID)
	return s.saveEntriesLocked(entries)
}

func (s *encryptedFileStore) loadEntriesLocked() (map[string]string, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return map[string]string{}, nil
	}

	var file encryptedSecretsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	if file.Entries == nil {
		file.Entries = map[string]string{}
	}
	return file.Entries, nil
}

func (s *encryptedFileStore) saveEntriesLocked(entries map[string]string) error {
	data, err := json.MarshalIndent(encryptedSecretsFile{Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o600)
}

func (s *encryptedFileStore) encryptLocked(value string) (string, error) {
	key, err := s.getOrCreateKeyLocked()
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nil, nonce, []byte(value), nil)
	payload := append(nonce, ciphertext...)
	return base64.StdEncoding.EncodeToString(payload), nil
}

func (s *encryptedFileStore) decryptLocked(encoded string) (string, error) {
	key, err := s.getOrCreateKeyLocked()
	if err != nil {
		return "", err
	}

	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", fmt.Errorf("encrypted secret payload is invalid")
	}

	nonce := payload[:gcm.NonceSize()]
	ciphertext := payload[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func (s *encryptedFileStore) getOrCreateKeyLocked() ([]byte, error) {
	data, err := os.ReadFile(s.keyPath)
	if err == nil {
		key, decodeErr := base64.StdEncoding.DecodeString(string(data))
		if decodeErr != nil {
			return nil, decodeErr
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(s.keyPath, []byte(base64.StdEncoding.EncodeToString(key)), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}
