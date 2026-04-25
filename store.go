package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

type ServerRecord struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Host        string    `json:"host"`
	Port        string    `json:"port"`
	Username    string    `json:"username"`
	HasPassword bool      `json:"has_password"`
	Password    string    `json:"-"`
	CreatedAt   time.Time `json:"created_at"`
}

type persistedServerRecord struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Host        string    `json:"host"`
	Port        string    `json:"port"`
	Username    string    `json:"username"`
	HasPassword bool      `json:"has_password"`
	Password    string    `json:"password,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type Store struct {
	mu          sync.RWMutex
	path        string
	servers     []ServerRecord
	secretStore SecretStore
}

func NewStore() (*Store, error) {
	dir, err := appDataDir()
	if err != nil {
		return nil, err
	}

	secretStore, err := NewSecretStore()
	if err != nil {
		return nil, err
	}

	store := &Store{
		path:        filepath.Join(dir, "servers.json"),
		secretStore: secretStore,
	}

	if err := store.load(); err != nil {
		return nil, err
	}

	return store, nil
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.servers = []ServerRecord{}
		return nil
	}
	if err != nil {
		return err
	}

	if len(data) == 0 {
		s.servers = []ServerRecord{}
		return nil
	}

	var persisted []persistedServerRecord
	if err := json.Unmarshal(data, &persisted); err != nil {
		return err
	}

	servers := make([]ServerRecord, 0, len(persisted))
	needsSave := false

	for _, record := range persisted {
		server := ServerRecord{
			ID:          record.ID,
			Name:        record.Name,
			Host:        record.Host,
			Port:        record.Port,
			Username:    record.Username,
			HasPassword: record.HasPassword,
			CreatedAt:   record.CreatedAt,
		}

		if record.Password != "" {
			if err := s.secretStore.SetPassword(record.ID, record.Password); err != nil {
				return err
			}
			server.HasPassword = true
			needsSave = true
		}

		servers = append(servers, server)
	}

	s.servers = servers

	if needsSave {
		return s.saveLocked()
	}

	return nil
}

func (s *Store) saveLocked() error {
	persisted := make([]persistedServerRecord, 0, len(s.servers))
	for _, server := range s.servers {
		persisted = append(persisted, persistedServerRecord{
			ID:          server.ID,
			Name:        server.Name,
			Host:        server.Host,
			Port:        server.Port,
			Username:    server.Username,
			HasPassword: server.HasPassword,
			CreatedAt:   server.CreatedAt,
		})
	}

	data, err := json.MarshalIndent(persisted, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(s.path, data, 0o600)
}

func (s *Store) ListServers() []ServerRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return slices.Clone(s.servers)
}

func (s *Store) AddServer(record ServerRecord) (ServerRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	record.ID = newID()
	record.CreatedAt = time.Now().UTC()
	if record.Port == "" {
		record.Port = "22"
	}

	password := record.Password
	record.Password = ""
	record.HasPassword = password != ""

	if password != "" {
		if err := s.secretStore.SetPassword(record.ID, password); err != nil {
			return ServerRecord{}, err
		}
	}

	s.servers = append(s.servers, record)
	if err := s.saveLocked(); err != nil {
		if password != "" {
			_ = s.secretStore.DeletePassword(record.ID)
		}
		return ServerRecord{}, err
	}

	return record, nil
}

func (s *Store) GetServer(id string) (ServerRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, server := range s.servers {
		if server.ID != id {
			continue
		}

		if server.HasPassword {
			password, err := s.secretStore.GetPassword(id)
			if err != nil {
				return ServerRecord{}, false
			}
			server.Password = password
		}

		return server, true
	}

	return ServerRecord{}, false
}

func (s *Store) DeleteServer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	index := -1
	var server ServerRecord
	for i, candidate := range s.servers {
		if candidate.ID != id {
			continue
		}
		index = i
		server = candidate
		break
	}

	if index == -1 {
		return os.ErrNotExist
	}

	s.servers = append(s.servers[:index], s.servers[index+1:]...)
	if err := s.saveLocked(); err != nil {
		s.servers = append(s.servers[:index], append([]ServerRecord{server}, s.servers[index:]...)...)
		return err
	}

	if server.HasPassword {
		if err := s.secretStore.DeletePassword(id); err != nil {
			return err
		}
	}

	return nil
}

func newID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(buf[:])
}
