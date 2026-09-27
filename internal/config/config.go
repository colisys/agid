package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Retry struct {
	MaxAttempts     int  `yaml:"max_attempts"`
	BaseBackoffMs   int  `yaml:"base_backoff_ms"`
	HonorRetryAfter bool `yaml:"honor_retry_after"`
}

type JevConfig struct {
	Endpoint       string `yaml:"endpoint"`
	ModelsEndpoint string `yaml:"models_endpoint"`
	ModelPin       string `yaml:"model_pin"`
	DevAlias       string `yaml:"dev_alias"`
	TimeoutMs      int    `yaml:"timeout_ms"`
	Retry          Retry  `yaml:"retry"`
	APIKeyEnv      string `yaml:"api_key_env"`
}

type LLMProviderConfig struct {
	Name      string `yaml:"name"`
	Kind      string `yaml:"kind"`
	Endpoint  string `yaml:"endpoint"`
	Model     string `yaml:"model"`
	APIKeyEnv string `yaml:"api_key_env"`
	TimeoutMs int    `yaml:"timeout_ms"`
}

type Config struct {
	Server struct {
		Listen string `yaml:"listen"`
	} `yaml:"server"`
	Jev struct {
		Endpoint       string `yaml:"endpoint"`
		ModelsEndpoint string `yaml:"models_endpoint"`
		ModelPin       string `yaml:"model_pin"`
		DevAlias       string `yaml:"dev_alias"`
		TimeoutMs      int    `yaml:"timeout_ms"`
		Retry          Retry  `yaml:"retry"`
	} `yaml:"jev"`
	LLMProviders struct {
		Default   string              `yaml:"default"`
		Providers []LLMProviderConfig `yaml:"providers"`
	} `yaml:"llm_providers"`
	Thresholds struct {
		IntentHumanBelow     float64 `yaml:"intent_human_below"`
		LowRiskAllowAt       float64 `yaml:"low_risk_allow_at"`
		HighRiskAllowAbove   float64 `yaml:"high_risk_allow_above"`
		ComplexityHumanAbove float64 `yaml:"complexity_human_above"`
		ComplexityHumanConfB float64 `yaml:"complexity_human_conf_below"`
	} `yaml:"thresholds"`
	APIKeys []string    `yaml:"api_keys"`
	Tenants []TenantRef `yaml:"tenants"`
	JSFlow  struct {
		PoolSize   int    `yaml:"pool_size"`
		ScriptFile string `yaml:"script_file"`
	} `yaml:"jsflow"`
	Games struct {
		Dir           string `yaml:"games_dir"`
		DefaultTickMs int    `yaml:"default_tick_ms"`
		MaxMatches    int    `yaml:"max_matches"`
		ReplayCap     int    `yaml:"replay_cap"`
		WebhookURL    string `yaml:"webhook_url"`
		WebhookSecret string `yaml:"webhook_secret"`
		// DataRoot is the host directory holding the writable areas of pack
		// services. Every service gets <data_root>/<its data_dir> as SVC_DATA,
		// so a pack never has to guess where to persist, and the dev layout and
		// the compose layout resolve to the same relative position. Empty means
		// "data" next to the gateway's working directory.
		DataRoot string `yaml:"data_root"`
	} `yaml:"games"`
}

type TenantRef struct {
	Name string `yaml:"name"`
	Key  string `yaml:"key"`
}

// GameRoots splits games_dir on commas so packs may live in more than one
// tree (e.g. "examples,scripts/games"). Empty entries are ignored.
func (c Config) GameRoots() []string {
	var out []string
	for _, p := range strings.Split(c.Games.Dir, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// GameDataRoot returns the absolute host directory that holds pack services'
// writable areas. Resolved once so SVC_DATA is a stable absolute path
// regardless of where a service's cwd ends up.
func (c Config) GameDataRoot() string {
	dir := strings.TrimSpace(c.Games.DataRoot)
	if dir == "" {
		dir = "data"
	}
	if abs, err := filepath.Abs(dir); err == nil {
		return abs
	}
	return filepath.Clean(dir)
}

func Load(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := yaml.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.Server.Listen == "" {
		c.Server.Listen = ":8080"
	}
	if c.Jev.Endpoint == "" {
		c.Jev.Endpoint = "https://api.typesafe.ai/v1/systemone"
	}
	if c.Jev.ModelPin == "" {
		c.Jev.ModelPin = "jev-1.13.0"
	}
	if c.Jev.TimeoutMs == 0 {
		c.Jev.TimeoutMs = 15000
	}
	if c.Jev.Retry.MaxAttempts == 0 {
		c.Jev.Retry.MaxAttempts = 4
		c.Jev.Retry.BaseBackoffMs = 300
		c.Jev.Retry.HonorRetryAfter = true
	}
	if c.JSFlow.PoolSize <= 0 {
		c.JSFlow.PoolSize = 4
	}
	if c.Games.DefaultTickMs <= 0 {
		c.Games.DefaultTickMs = 500
	}
	if c.Games.MaxMatches <= 0 {
		c.Games.MaxMatches = 100
	}
	if c.Games.ReplayCap <= 0 {
		c.Games.ReplayCap = 2000
	}
	return c, nil
}

// FlowScript reads the configured orchestration script, or "" to use the
// built-in default.
func (c Config) FlowScript() (string, error) {
	if c.JSFlow.ScriptFile == "" {
		return "", nil
	}
	b, err := os.ReadFile(c.JSFlow.ScriptFile)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (c Config) JevTimeout() time.Duration { return time.Duration(c.Jev.TimeoutMs) * time.Millisecond }

func (c Config) JevAPIKey() string {
	if v := os.Getenv("TYPESAFE_API_KEY"); v != "" {
		return v
	}
	return ""
}

func (c Config) APIKeyOK(key string) bool {
	if len(c.APIKeys) == 0 && len(c.Tenants) == 0 {
		return true
	}
	for _, k := range c.APIKeys {
		if k == key {
			return true
		}
	}
	for _, t := range c.Tenants {
		if t.Key == key {
			return true
		}
	}
	return false
}

func (c Config) TenantOf(key string) string {
	for _, t := range c.Tenants {
		if t.Key == key {
			return t.Name
		}
	}
	return ""
}

func (c Config) ProviderKey(p LLMProviderConfig) string {
	if p.APIKeyEnv != "" {
		if v := os.Getenv(p.APIKeyEnv); v != "" {
			return v
		}
	}
	return os.Getenv("LLM_API_KEY")
}

func Unset(v string) string { return fmt.Sprintf("unset(%s)", v) }
