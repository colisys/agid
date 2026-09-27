package game

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// DiskStore loads versioned script packs from one or more roots:
//
//	<root>/<game>/manifest.json        pack marker + self-description
//	<root>/<game>/rules.js             stable rules (base name from manifest)
//	<root>/<game>/rules.<ver>.js       candidate rules (ver = filename infix)
//	<root>/<game>/brains/<name>.js     stable brain
//	<root>/<game>/brains/<name>.<ver>.js
//
// A game is served from the first root that contains it. New uploads become
// pending versions; promote() flips the stable pointer. In-memory only.
type DiskStore struct {
	mu       sync.RWMutex
	dirs     []string
	stable   map[string]string            // "game/rules" -> version ("" = base file)
	brainSt  map[string]string            // "game/brain" -> version
	pending  map[string]map[string]string // key -> version -> script
	keepVers int
}

// NewDiskStore creates a store rooted at dirs (searched in order).
func NewDiskStore(dirs []string, keepVersions int) *DiskStore {
	if keepVersions <= 0 {
		keepVersions = 5
	}
	return &DiskStore{
		dirs:     dirs,
		stable:   map[string]string{},
		brainSt:  map[string]string{},
		pending:  map[string]map[string]string{},
		keepVers: keepVersions,
	}
}

// rootFor returns the root that serves game (its dir carries a manifest.json),
// or the first root when the game exists nowhere on disk yet (pending-only
// uploads).
func (s *DiskStore) rootFor(game string) string {
	for _, r := range s.dirs {
		if hasManifest(filepath.Join(r, game)) {
			return r
		}
	}
	if len(s.dirs) > 0 {
		return s.dirs[0]
	}
	return ""
}

func splitVer(base, file string) (name, ver string, ok bool) {
	if !strings.HasSuffix(file, ".js") {
		return "", "", false
	}
	stem := strings.TrimSuffix(file, ".js")
	if stem == base {
		return stem, "", true
	}
	if strings.HasPrefix(stem, base+".") {
		return base, strings.TrimPrefix(stem, base+"."), true
	}
	return "", "", false
}

func readFile(dir string, parts ...string) (string, error) {
	segs := append([]string{dir}, parts...)
	p := filepath.Join(segs...)
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func listVersions(dir string, base string) (map[string]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	out := map[string]string{}
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		if _, ver, ok := splitVer(base, e.Name()); ok {
			b, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			out[ver] = string(b)
		}
	}
	return out, nil
}

// Rules returns the script for game at version ("" = stable).
func (s *DiskStore) Rules(game, version string) (string, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	dir := filepath.Join(s.rootFor(game), game)
	man, err := s.Manifest(game)
	if err != nil {
		return "", "", fmt.Errorf("rules for game %q: %w", game, err)
	}
	vers, err := listVersions(dir, man.RulesBase)
	if err != nil {
		return "", "", fmt.Errorf("rules for game %q: %w", game, err)
	}
	if version == "" {
		version = s.stable[game+"/rules"]
	}
	if version == "" {
		if sc, ok := vers[""]; ok {
			return sc, "", nil
		}
		return "", "", fmt.Errorf("no stable rules for game %q", game)
	}
	if sc, ok := vers[version]; ok {
		return sc, version, nil
	}
	if pend, ok := s.pending[game+"/rules"]; ok {
		if sc, ok := pend[version]; ok {
			return sc, version, nil
		}
	}
	return "", "", fmt.Errorf("rules version %q not found for game %q", version, game)
}

// Brain returns the brain script ("" = stable).
func (s *DiskStore) Brain(game, name, version string) (string, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	man, err := s.Manifest(game)
	if err != nil {
		return "", "", fmt.Errorf("brain %q for game %q: %w", name, game, err)
	}
	dir := filepath.Join(s.rootFor(game), game, man.BrainsDir)
	vers, err := listVersions(dir, name)
	if err != nil {
		return "", "", fmt.Errorf("brain %q for game %q: %w", name, game, err)
	}
	key := game + "/" + name
	if version == "" {
		version = s.brainSt[key]
	}
	if version == "" {
		if sc, ok := vers[""]; ok {
			return sc, "", nil
		}
		return "", "", fmt.Errorf("no stable brain %q for game %q", name, game)
	}
	if sc, ok := vers[version]; ok {
		return sc, version, nil
	}
	if pend, ok := s.pending[key]; ok {
		if sc, ok := pend[version]; ok {
			return sc, version, nil
		}
	}
	return "", "", fmt.Errorf("brain %q version %q not found for game %q", name, version, game)
}

// UploadRules stores a new pending rules version.
func (s *DiskStore) UploadRules(game, version, script string) error {
	if version == "" {
		return fmt.Errorf("version is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := game + "/rules"
	if s.pending[key] == nil {
		s.pending[key] = map[string]string{}
	}
	s.pending[key][version] = script
	s.prune(key)
	return nil
}

// UploadBrain stores a new pending brain version.
func (s *DiskStore) UploadBrain(game, name, version, script string) error {
	if version == "" || name == "" {
		return fmt.Errorf("name and version are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := game + "/" + name
	if s.pending[key] == nil {
		s.pending[key] = map[string]string{}
	}
	s.pending[key][version] = script
	s.prune(key)
	return nil
}

// Promote flips the stable pointer to version (must exist on disk or pending).
func (s *DiskStore) Promote(kind, game, name, version string) error {
	// Validate first without holding the write lock.
	switch kind {
	case "rules":
		if _, _, err := s.Rules(game, version); err != nil {
			return err
		}
	case "brain":
		if _, _, err := s.Brain(game, name, version); err != nil {
			return err
		}
	default:
		return fmt.Errorf("kind must be rules|brain")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == "rules" {
		s.stable[game+"/rules"] = version
	} else {
		s.brainSt[game+"/"+name] = version
	}
	return nil
}

func (s *DiskStore) prune(key string) {
	pend := s.pending[key]
	for len(pend) > s.keepVers {
		// drop an arbitrary oldest: lexical first (versions are
		// timestamps or vN, good enough for a bound).
		keys := make([]string, 0, len(pend))
		for k := range pend {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		delete(pend, keys[0])
	}
}

// Games lists game dirs that carry a manifest.json (the only pack marker)
// across all roots. Directories without one are skipped entirely.
func (s *DiskStore) Games() []string {
	seen := map[string]bool{}
	var out []string
	for _, root := range s.dirs {
		ents, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range ents {
			if !e.IsDir() || seen[e.Name()] {
				continue
			}
			if hasManifest(filepath.Join(root, e.Name())) {
				seen[e.Name()] = true
				out = append(out, e.Name())
			}
		}
	}
	sort.Strings(out)
	return out
}

// Brains lists brain names for a game.
func (s *DiskStore) Brains(game string) []string {
	man, err := s.Manifest(game)
	if err != nil {
		return nil
	}
	dir := filepath.Join(s.rootFor(game), game, man.BrainsDir)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		stem := strings.TrimSuffix(e.Name(), ".js")
		dot := strings.Index(stem, ".")
		name := stem
		if dot >= 0 {
			name = stem[:dot]
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}
