package admin

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gateway/internal/config"
	"gateway/internal/decision"
	"gateway/internal/game"
	"gateway/internal/llm"
	"gateway/internal/orchestrator"
	"gateway/internal/services"
)

type ChangeEntry struct {
	Time   time.Time `json:"time"`
	Action string    `json:"action"`
	Detail string    `json:"detail"`
}

type TenantKey struct {
	Name      string    `json:"name"`
	KeyMasked string    `json:"key"`
	CreatedAt time.Time `json:"created_at"`
}

type tenantKeyRecord struct {
	name      string
	key       string
	createdAt time.Time
}

type RetryInput struct {
	MaxAttempts     *int  `json:"max_attempts"`
	BaseBackoffMs   *int  `json:"base_backoff_ms"`
	HonorRetryAfter *bool `json:"honor_retry_after"`
}

type Store struct {
	mu        sync.RWMutex
	cfgPath   string
	adminTok  string
	tenants   []tenantKeyRecord
	jevKey    string
	jevKeyEnv bool
	llmKeys   map[string]string
	changes   []ChangeEntry

	// Runtime overrides persistence (gwadmin llm/jev changes survive restarts).
	// File lives next to gateway.yaml (0600, same trust domain as the env file —
	// it contains rotated API keys in plaintext).
	ovPath       string
	llmOv        map[string]llmOverride
	llmDefaultOv string
	jevOv        *jevOverride

	jev    *decision.Client
	engine *orchestrator.Engine
	llms   *llm.Registry
	games  *game.DiskStore
	// dataRoot is the resolved games.data_root — the base every pack
	// service's writable area is resolved against.
	dataRoot string
}

// llmOverride is the merged effective state of one LLM provider (yaml baseline
// merged with gwadmin upsert/rotate-key changes).
type llmOverride struct {
	Name      string `json:"name"`
	Endpoint  string `json:"endpoint,omitempty"`
	Model     string `json:"model,omitempty"`
	Key       string `json:"key,omitempty"`
	TimeoutMs int    `json:"timeout_ms,omitempty"`
}

type jevOverride struct {
	Endpoint string `json:"endpoint,omitempty"`
	ModelPin string `json:"model_pin,omitempty"`
	Key      string `json:"key,omitempty"`
}

type overridesFile struct {
	LLMDefault   string        `json:"llm_default,omitempty"`
	LLMProviders []llmOverride `json:"llm_providers,omitempty"`
	Jev          *jevOverride  `json:"jev,omitempty"`
}

// SetGameStore attaches the versioned game script store (optional).
func (s *Store) SetGameStore(g *game.DiskStore) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.games = g
}

func NewStore(cfg config.Config, cfgPath, adminToken string, jev *decision.Client, engine *orchestrator.Engine, llms *llm.Registry) *Store {
	s := &Store{
		cfgPath:  cfgPath,
		adminTok: adminToken,
		llmKeys:  map[string]string{},
		ovPath:   filepath.Join(filepath.Dir(cfgPath), "runtime-overrides.json"),
		llmOv:    map[string]llmOverride{},
		jev:      jev,
		engine:   engine,
		llms:     llms,
		dataRoot: cfg.GameDataRoot(),
	}
	for _, t := range cfg.Tenants {
		if t.Key == "" || t.Name == "" {
			continue
		}
		s.tenants = append(s.tenants, tenantKeyRecord{name: t.Name, key: t.Key})
	}
	for _, k := range cfg.APIKeys {
		if k == "" {
			continue
		}
		s.tenants = append(s.tenants, tenantKeyRecord{name: "legacy-" + MaskSecret(k), key: k})
	}
	// yaml 基线进 overrides 表（key 由 env 解析，不在 cfg 里，留空）——后续
	// gwadmin 的部分更新在此合并，落盘的总是合并后的完整值。
	for _, p := range cfg.LLMProviders.Providers {
		if p.Name == "" {
			continue
		}
		s.llmOv[p.Name] = llmOverride{
			Name:      p.Name,
			Endpoint:  p.Endpoint,
			Model:     p.Model,
			TimeoutMs: p.TimeoutMs,
		}
	}
	if cfg.LLMProviders.Default != "" {
		s.llmDefaultOv = cfg.LLMProviders.Default
	}
	s.loadOverrides()
	return s
}

// loadOverrides replays the persisted runtime-overrides.json (written by every
// gwadmin llm/jev mutation) on top of the yaml-built registry. Missing file is
// fine; a corrupt file is reported via the change log and ignored.
func (s *Store) loadOverrides() {
	raw, err := os.ReadFile(s.ovPath)
	if err != nil {
		return
	}
	var f overridesFile
	if err := json.Unmarshal(raw, &f); err != nil {
		s.log("overrides.load", "corrupt file ignored: "+err.Error())
		return
	}
	for _, o := range f.LLMProviders {
		if o.Name == "" {
			continue
		}
		timeout := time.Duration(o.TimeoutMs) * time.Millisecond
		if timeout <= 0 {
			timeout = 60 * time.Second
		}
		s.llms.Register(llm.NewOpenAICompat(o.Name, o.Endpoint, o.Key, o.Model, timeout))
		if o.Key != "" {
			s.llmKeys[o.Name] = o.Key
			s.llmOv[o.Name] = o
		} else {
			// 无 key 覆盖：保留 yaml/env 解析出的 key，只覆盖 endpoint/model
			if cur, ok := s.llmOv[o.Name]; ok {
				cur.Endpoint, cur.Model, cur.TimeoutMs = o.Endpoint, o.Model, o.TimeoutMs
				s.llmOv[o.Name] = cur
			} else {
				s.llmOv[o.Name] = o
			}
		}
		s.log("overrides.load", "provider "+o.Name)
	}
	if f.LLMDefault != "" {
		if err := s.llms.SetDefault(f.LLMDefault); err == nil {
			s.log("overrides.load", "default "+f.LLMDefault)
		}
	}
	if f.Jev != nil {
		s.jev.Apply(f.Jev.Endpoint, f.Jev.Key, 0, s.jev.Snapshot().Retry)
		if f.Jev.Key != "" {
			s.jevKey = f.Jev.Key
			s.jevKeyEnv = false
		}
		if f.Jev.ModelPin != "" {
			s.engine.SetModel(f.Jev.ModelPin)
		}
		s.jevOv = f.Jev
		s.log("overrides.load", "jev")
	}
}

// persistLocked writes the merged overrides snapshot atomically. Callers hold
// s.mu (every mutating admin path does).
func (s *Store) persistLocked() {
	f := overridesFile{LLMDefault: s.llmDefaultOv, Jev: s.jevOv}
	for _, o := range s.llmOv {
		f.LLMProviders = append(f.LLMProviders, o)
	}
	sort.Slice(f.LLMProviders, func(i, j int) bool { return f.LLMProviders[i].Name < f.LLMProviders[j].Name })
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.ovPath), 0o700); err != nil {
		return
	}
	tmp := s.ovPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, s.ovPath)
}

func (s *Store) Enabled() bool { return s.adminTok != "" }

func (s *Store) CheckAdmin(token string) bool {
	if s.adminTok == "" {
		return false
	}
	return token == s.adminTok
}

func (s *Store) APIKeyOK(key string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.tenants) == 0 {
		return true
	}
	for _, t := range s.tenants {
		if t.key == key {
			return true
		}
	}
	return false
}

func (s *Store) TenantOf(key string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, t := range s.tenants {
		if t.key == key {
			return t.name
		}
	}
	return ""
}

func (s *Store) ListTenants() []TenantKey {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]TenantKey, 0, len(s.tenants))
	for _, t := range s.tenants {
		out = append(out, TenantKey{Name: t.name, KeyMasked: MaskSecret(t.key), CreatedAt: t.createdAt})
	}
	return out
}

func (s *Store) log(action, detail string) {
	s.changes = append(s.changes, ChangeEntry{Time: time.Now(), Action: action, Detail: detail})
	if len(s.changes) > 500 {
		s.changes = s.changes[len(s.changes)-500:]
	}
}

func MaskSecret(v string) string {
	if v == "" {
		return "unset"
	}
	if len(v) <= 8 {
		return "set(***)"
	}
	return "set(" + v[:4] + "***" + v[len(v)-2:] + ")"
}

func genKey(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return prefix + hex.EncodeToString(b[:])
}

type Snapshot struct {
	Jev struct {
		Endpoint  string `json:"endpoint"`
		ModelPin  string `json:"model_pin"`
		TimeoutMs int    `json:"timeout_ms"`
		Retry     struct {
			MaxAttempts     int  `json:"max_attempts"`
			BaseBackoffMs   int  `json:"base_backoff_ms"`
			HonorRetryAfter bool `json:"honor_retry_after"`
		} `json:"retry"`
		APIKey string `json:"api_key"`
	} `json:"jev"`
	Thresholds   decision.Thresholds `json:"thresholds"`
	LLMProviders struct {
		Default   string `json:"default"`
		Providers []struct {
			Name      string `json:"name"`
			Endpoint  string `json:"endpoint"`
			Model     string `json:"model"`
			TimeoutMs int    `json:"timeout_ms"`
			APIKey    string `json:"api_key"`
		} `json:"providers"`
	} `json:"llm_providers"`
	GatewayKeys []TenantKey `json:"gateway_keys"`
}

func (s *Store) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var snap Snapshot
	js := s.jev.Snapshot()
	snap.Jev.Endpoint = js.Endpoint
	snap.Jev.ModelPin = s.engine.Model()
	snap.Jev.TimeoutMs = js.TimeoutMs
	snap.Jev.Retry.MaxAttempts = js.Retry.MaxAttempts
	snap.Jev.Retry.BaseBackoffMs = int(js.Retry.BaseBackoff / time.Millisecond)
	snap.Jev.Retry.HonorRetryAfter = js.Retry.HonorRetryAfter
	snap.Jev.APIKey = MaskSecret(s.jevKey)
	snap.Thresholds = s.engine.Thresholds()
	snap.LLMProviders.Default = s.llms.Default()
	for _, name := range s.llms.Names() {
		p, err := s.llms.Get(name)
		if err != nil {
			continue
		}
		entry := struct {
			Name      string `json:"name"`
			Endpoint  string `json:"endpoint"`
			Model     string `json:"model"`
			TimeoutMs int    `json:"timeout_ms"`
			APIKey    string `json:"api_key"`
		}{Name: name}
		if oc, ok := p.(*llm.OpenAICompat); ok {
			st := oc.Snapshot()
			entry.Endpoint = st.Endpoint
			entry.Model = st.Model
			entry.TimeoutMs = st.TimeoutMs
		}
		entry.APIKey = MaskSecret(s.llmKeys[name])
		snap.LLMProviders.Providers = append(snap.LLMProviders.Providers, entry)
	}
	for _, t := range s.tenants {
		snap.GatewayKeys = append(snap.GatewayKeys, TenantKey{Name: t.name, KeyMasked: MaskSecret(t.key), CreatedAt: t.createdAt})
	}
	return snap
}

func (s *Store) SecretsStatus() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]string{"jev": MaskSecret(s.jevKey)}
	for _, name := range s.llms.Names() {
		out["llm:"+name] = MaskSecret(s.llmKeys[name])
	}
	return out
}

func (s *Store) SetThresholds(th decision.Thresholds) error {
	if err := validateThresholds(th); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.engine.SetThresholds(th)
	s.log("thresholds.set", fmt.Sprintf("%+v", th))
	return nil
}

func validateThresholds(th decision.Thresholds) error {
	for name, v := range map[string]float64{
		"intent_human_below": th.IntentHumanBelow, "low_risk_allow_at": th.LowRiskAllowAt,
		"high_risk_allow_above": th.HighRiskAllowAbove,
	} {
		if v < 0 || v > 1 {
			return fmt.Errorf("threshold %s must be in [0,1], got %v", name, v)
		}
	}
	if th.HighRiskAllowAbove < th.LowRiskAllowAt {
		return fmt.Errorf("high_risk_allow_above must be >= low_risk_allow_at")
	}
	return nil
}

type JevUpdate struct {
	Endpoint  *string
	ModelPin  *string
	TimeoutMs *int
	Retry     *RetryInput
}

func (s *Store) UpdateJev(u JevUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.jev.Snapshot()
	endpoint := cur.Endpoint
	timeout := time.Duration(cur.TimeoutMs) * time.Millisecond
	retry := cur.Retry
	if u.Endpoint != nil {
		if *u.Endpoint == "" {
			return fmt.Errorf("endpoint must not be empty")
		}
		endpoint = *u.Endpoint
	}
	if u.TimeoutMs != nil {
		if *u.TimeoutMs <= 0 {
			return fmt.Errorf("timeout_ms must be positive")
		}
		timeout = time.Duration(*u.TimeoutMs) * time.Millisecond
	}
	if u.Retry != nil {
		if u.Retry.MaxAttempts != nil {
			if *u.Retry.MaxAttempts < 1 || *u.Retry.MaxAttempts > 10 {
				return fmt.Errorf("max_attempts must be in [1,10]")
			}
			retry.MaxAttempts = *u.Retry.MaxAttempts
		}
		if u.Retry.BaseBackoffMs != nil {
			if *u.Retry.BaseBackoffMs < 0 {
				return fmt.Errorf("base_backoff_ms must be >= 0")
			}
			retry.BaseBackoff = time.Duration(*u.Retry.BaseBackoffMs) * time.Millisecond
		}
		if u.Retry.HonorRetryAfter != nil {
			retry.HonorRetryAfter = *u.Retry.HonorRetryAfter
		}
	}
	s.jev.Apply(endpoint, "", timeout, retry)
	if u.ModelPin != nil {
		if *u.ModelPin == "" {
			return fmt.Errorf("model_pin must not be empty")
		}
		s.engine.SetModel(*u.ModelPin)
	}
	if s.jevOv == nil {
		s.jevOv = &jevOverride{}
	}
	if u.Endpoint != nil {
		s.jevOv.Endpoint = endpoint
	}
	if u.ModelPin != nil {
		s.jevOv.ModelPin = *u.ModelPin
	}
	s.persistLocked()
	s.log("jev.update", fmt.Sprintf("endpoint=%s model=%s timeout=%s retry=%+v", endpoint, s.engine.Model(), timeout, retry))
	return nil
}

func (s *Store) RotateJevKey(key string) error {
	if key == "" {
		return fmt.Errorf("api_key must not be empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.jev.Snapshot()
	s.jev.Apply("", key, 0, cur.Retry)
	s.jevKey = key
	s.jevKeyEnv = false
	if s.jevOv == nil {
		s.jevOv = &jevOverride{}
	}
	s.jevOv.Key = key
	s.persistLocked()
	s.log("jev.rotate_key", "key="+MaskSecret(key))
	return nil
}

type ProviderUpsert struct {
	Name      string
	Endpoint  *string
	Model     *string
	APIKey    *string
	TimeoutMs *int
	Default   bool
}

func (s *Store) UpsertProvider(u ProviderUpsert) error {
	if u.Name == "" {
		return fmt.Errorf("name is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.llms.Get(u.Name)
	if err != nil {
		endpoint := ""
		if u.Endpoint != nil {
			endpoint = *u.Endpoint
		}
		if endpoint == "" {
			return fmt.Errorf("endpoint is required for a new provider")
		}
		timeout := 60 * time.Second
		if u.TimeoutMs != nil {
			timeout = time.Duration(*u.TimeoutMs) * time.Millisecond
		}
		key := ""
		if u.APIKey != nil {
			key = *u.APIKey
		}
		model := ""
		if u.Model != nil {
			model = *u.Model
		}
		s.llms.Register(llm.NewOpenAICompat(u.Name, endpoint, key, model, timeout))
		if key != "" {
			s.llmKeys[u.Name] = key
		}
		s.llmOv[u.Name] = llmOverride{Name: u.Name, Endpoint: endpoint, Model: model, Key: key, TimeoutMs: int(timeout / time.Millisecond)}
		s.log("llm.add", fmt.Sprintf("name=%s endpoint=%s model=%s", u.Name, endpoint, model))
	} else {
		oc, ok := p.(*llm.OpenAICompat)
		if !ok {
			return fmt.Errorf("provider %q does not support runtime update", u.Name)
		}
		var endpoint, key, model string
		var timeout time.Duration
		clearModel := false
		if u.Endpoint != nil {
			endpoint = *u.Endpoint
		}
		if u.APIKey != nil {
			key = *u.APIKey
		}
		if u.Model != nil {
			model = *u.Model
			clearModel = *u.Model == "" || *u.Model == "-"
		}
		if u.TimeoutMs != nil {
			if *u.TimeoutMs <= 0 {
				return fmt.Errorf("timeout_ms must be positive")
			}
			timeout = time.Duration(*u.TimeoutMs) * time.Millisecond
		}
		oc.Apply(endpoint, key, model, timeout)
		if clearModel {
			oc.ClearModel()
		}
		if key != "" {
			s.llmKeys[u.Name] = key
		}
		// 合并进 overrides 表：部分更新只覆盖显式给出的字段
		ov := s.llmOv[u.Name]
		ov.Name = u.Name
		if u.Endpoint != nil {
			ov.Endpoint = endpoint
		}
		if u.Model != nil {
			ov.Model = model
			if clearModel {
				ov.Model = ""
			}
		}
		if u.APIKey != nil && key != "" {
			ov.Key = key
		}
		if u.TimeoutMs != nil {
			ov.TimeoutMs = int(timeout / time.Millisecond)
		}
		s.llmOv[u.Name] = ov
		s.log("llm.update", "name="+u.Name)
	}
	if u.Default {
		if err := s.llms.SetDefault(u.Name); err != nil {
			return err
		}
		s.llmDefaultOv = u.Name
		s.log("llm.set_default", "name="+u.Name)
	}
	s.persistLocked()
	return nil
}

func (s *Store) RemoveProvider(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == s.llms.Default() {
		return fmt.Errorf("cannot remove the default provider %q; set another default first", name)
	}
	if !s.llms.Remove(name) {
		return fmt.Errorf("unknown provider %q", name)
	}
	delete(s.llmKeys, name)
	delete(s.llmOv, name)
	s.persistLocked()
	s.log("llm.remove", "name="+name)
	return nil
}

func (s *Store) SetProviderKey(name, key string) error {
	if key == "" {
		return fmt.Errorf("api_key must not be empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := s.llms.Get(name)
	if err != nil {
		return err
	}
	oc, ok := p.(*llm.OpenAICompat)
	if !ok {
		return fmt.Errorf("provider %q does not support runtime update", name)
	}
	oc.Apply("", key, "", 0)
	s.llmKeys[name] = key
	ov := s.llmOv[name]
	ov.Name = name
	ov.Key = key
	s.llmOv[name] = ov
	s.persistLocked()
	s.log("llm.rotate_key", "name="+name+" key="+MaskSecret(key))
	return nil
}

func (s *Store) AddGatewayKey(name, key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == "" {
		return "", fmt.Errorf("tenant name is required")
	}
	if key == "" {
		key = genKey("gw_")
	}
	for _, t := range s.tenants {
		if t.key == key {
			return "", fmt.Errorf("key already exists")
		}
		if t.name == name {
			return "", fmt.Errorf("tenant %q already exists", name)
		}
	}
	s.tenants = append(s.tenants, tenantKeyRecord{name: name, key: key, createdAt: time.Now()})
	s.log("keys.add", "tenant="+name+" key="+MaskSecret(key))
	return key, nil
}

func (s *Store) RevokeGatewayKey(ref string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, t := range s.tenants {
		if t.key == ref || t.name == ref {
			s.tenants = append(s.tenants[:i], s.tenants[i+1:]...)
			s.log("keys.revoke", "tenant="+t.name+" key="+MaskSecret(t.key))
			return nil
		}
	}
	return fmt.Errorf("tenant not found")
}

func (s *Store) ReloadFromDisk() error {
	cfg, err := config.Load(s.cfgPath)
	if err != nil {
		return err
	}
	th := decision.DefaultThresholds()
	if cfg.Thresholds.IntentHumanBelow > 0 {
		th.IntentHumanBelow = cfg.Thresholds.IntentHumanBelow
	}
	if cfg.Thresholds.HighRiskAllowAbove > 0 {
		th.HighRiskAllowAbove = cfg.Thresholds.HighRiskAllowAbove
	}
	if cfg.Thresholds.ComplexityHumanAbove > 0 {
		th.ComplexityHumanAbove = cfg.Thresholds.ComplexityHumanAbove
	}
	if cfg.Thresholds.ComplexityHumanConfB > 0 {
		th.ComplexityHumanConfBel = cfg.Thresholds.ComplexityHumanConfB
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.engine.SetThresholds(th)
	s.engine.SetModel(cfg.Jev.ModelPin)
	s.jev.Apply(cfg.Jev.Endpoint, "", cfg.JevTimeout(), decision.RetryPolicy{
		MaxAttempts:     cfg.Jev.Retry.MaxAttempts,
		BaseBackoff:     time.Duration(cfg.Jev.Retry.BaseBackoffMs) * time.Millisecond,
		HonorRetryAfter: cfg.Jev.Retry.HonorRetryAfter,
	})
	s.tenants = nil
	for _, t := range cfg.Tenants {
		if t.Key == "" || t.Name == "" {
			continue
		}
		s.tenants = append(s.tenants, tenantKeyRecord{name: t.Name, key: t.Key})
	}
	for _, k := range cfg.APIKeys {
		if k == "" {
			continue
		}
		s.tenants = append(s.tenants, tenantKeyRecord{name: "legacy-" + MaskSecret(k), key: k})
	}
	s.log("config.reload", "path="+s.cfgPath)
	return nil
}

func (s *Store) Changes() []ChangeEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ChangeEntry, len(s.changes))
	copy(out, s.changes)
	return out
}

// Script returns the active QuickJS orchestration flow.
func (s *Store) Script() string { return s.engine.Script() }

// SetScript hot-swaps the orchestration flow.
func (s *Store) SetScript(script string) error {
	if strings.TrimSpace(script) == "" {
		return fmt.Errorf("script must not be empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.engine.SetScript(script)
	s.log("script.set", fmt.Sprintf("bytes=%d", len(script)))
	return nil
}

func (s *Store) gameStore() (*game.DiskStore, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.games == nil {
		return nil, fmt.Errorf("games not configured (games_dir)")
	}
	return s.games, nil
}

// GameList lists games with a rules pack.
func (s *Store) GameList() []string {
	g, err := s.gameStore()
	if err != nil {
		return nil
	}
	return g.Games()
}

// GameBrains lists brains for a game.
func (s *Store) GameBrains(gameName string) []string {
	g, err := s.gameStore()
	if err != nil {
		return nil
	}
	return g.Brains(gameName)
}

// GameBrain returns a brain script.
func (s *Store) GameBrain(gameName, name, version string) (string, string, error) {
	g, err := s.gameStore()
	if err != nil {
		return "", "", err
	}
	return g.Brain(gameName, name, version)
}

// GameRules returns a rules script.
func (s *Store) GameRules(gameName, version string) (string, string, error) {
	g, err := s.gameStore()
	if err != nil {
		return "", "", err
	}
	return g.Rules(gameName, version)
}

// UploadBrain stores a pending brain version.
func (s *Store) UploadBrain(gameName, name, version, script string) error {
	g, err := s.gameStore()
	if err != nil {
		return err
	}
	if strings.TrimSpace(script) == "" {
		return fmt.Errorf("script must not be empty")
	}
	if err := g.UploadBrain(gameName, name, version, script); err != nil {
		return err
	}
	s.mu.Lock()
	s.log("brains.upload", fmt.Sprintf("game=%s name=%s version=%s bytes=%d", gameName, name, version, len(script)))
	s.mu.Unlock()
	return nil
}

// UploadRules stores a pending rules version.
func (s *Store) UploadRules(gameName, version, script string) error {
	g, err := s.gameStore()
	if err != nil {
		return err
	}
	if strings.TrimSpace(script) == "" {
		return fmt.Errorf("script must not be empty")
	}
	if err := g.UploadRules(gameName, version, script); err != nil {
		return err
	}
	s.mu.Lock()
	s.log("rules.upload", fmt.Sprintf("game=%s version=%s bytes=%d", gameName, version, len(script)))
	s.mu.Unlock()
	return nil
}

// Promote flips a rules/brain stable pointer.
func (s *Store) Promote(kind, gameName, name, version string) error {
	g, err := s.gameStore()
	if err != nil {
		return err
	}
	if err := g.Promote(kind, gameName, name, version); err != nil {
		return err
	}
	s.mu.Lock()
	s.log("games.promote", fmt.Sprintf("kind=%s game=%s name=%s version=%s", kind, gameName, name, version))
	s.mu.Unlock()
	return nil
}

// ServiceRefs collects the managed backend services declared across all disk
// pack manifests (for POST /admin/compose). The gateway uses the same list to
// spawn the dev processes, so the two deployments cannot drift.
func (s *Store) ServiceRefs() []services.Ref {
	g, err := s.gameStore()
	if err != nil {
		return nil
	}
	pool := s.llmEnvPool()
	var refs []services.Ref
	for _, gname := range g.Games() {
		man, err := g.Manifest(gname)
		if err != nil {
			// Surface it: a pack with a rejected manifest (e.g. one asking
			// for an operator credential in env_allow) would otherwise vanish
			// without a word, and its services simply never start.
			s.log("games.services", fmt.Sprintf("game=%s manifest rejected, services NOT started: %v", gname, err))
			continue
		}
		if len(man.Services) == 0 {
			continue
		}
		dir, ok := g.PackDir(gname)
		if !ok {
			continue
		}
		for name, sd := range man.Services {
			refs = append(refs, sd.Ref(gname, name, dir, s.dataRoot, pool))
		}
	}
	return refs
}

// llmEnvPool is the candidate environment a pack service may opt into through
// manifest env_allow. Nothing here reaches a service process unless the pack
// asks for it by name; the gateway operator credentials are never in the pool.
func (s *Store) llmEnvPool() []string {
	if s.llms == nil {
		return nil
	}
	p, err := s.llms.Get("") // the configured default provider
	if err != nil {
		return nil
	}
	oc, ok := p.(*llm.OpenAICompat)
	if !ok {
		return nil
	}
	up := oc.Upstream()
	if up.Endpoint == "" {
		return nil
	}
	return []string{
		"LLM_UPSTREAM_URL=" + up.Endpoint,
		"LLM_UPSTREAM_KEY=" + up.APIKey,
		"LLM_UPSTREAM_MODEL=" + up.Model,
	}
}
