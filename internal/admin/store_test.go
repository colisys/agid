package admin

import (
	"context"
	"testing"
	"time"

	"gateway/internal/config"
	"gateway/internal/decision"
	"gateway/internal/jsflow"
	"gateway/internal/llm"
	"gateway/internal/orchestrator"
	"gateway/internal/tools"
)

func testEngine(llms *llm.Registry) *orchestrator.Engine {
	decide := func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error) {
		return decision.SystemOneResult{Model: "jev-1.13.0"}, nil
	}
	return orchestrator.NewEngine(jsflow.NewPool(1), "", decide, "jev-1.13.0", decision.DefaultThresholds(), llms, tools.NewRegistry())
}

func testStore(t *testing.T) *Store {
	return testStoreAt(t.TempDir())
}

func testStoreAt(dir string) *Store {
	cfg := config.Config{}
	jev := decision.NewClient("https://api.typesafe.ai/v1/systemone", "k", 5*time.Second, decision.DefaultRetryPolicy())
	llms := llm.NewRegistry("openai")
	llms.Register(llm.NewOpenAICompat("openai", "https://api.openai.com/v1", "k", "gpt-4o-mini", 5*time.Second))
	engine := testEngine(llms)
	return NewStore(cfg, dir+"/gateway.yaml", "adm", jev, engine, llms)
}

func TestThresholdValidation(t *testing.T) {
	s := testStore(t)
	bad := decision.DefaultThresholds()
	bad.HighRiskAllowAbove = 0.1
	bad.LowRiskAllowAt = 0.9
	if err := s.SetThresholds(bad); err == nil {
		t.Fatal("want validation error for inverted thresholds")
	}
	good := decision.DefaultThresholds()
	good.HighRiskAllowAbove = 0.9
	if err := s.SetThresholds(good); err != nil {
		t.Fatal(err)
	}
}

func TestKeyRotationMasked(t *testing.T) {
	s := testStore(t)
	if err := s.RotateJevKey("sk-typesafe-abcdef123456"); err != nil {
		t.Fatal(err)
	}
	snap := s.Snapshot()
	if snap.Jev.APIKey == "sk-typesafe-abcdef123456" {
		t.Fatal("secret leaked in snapshot")
	}
	if snap.Jev.APIKey == "unset" {
		t.Fatal("key should be marked set")
	}
	if err := s.RotateJevKey(""); err == nil {
		t.Fatal("want error for empty key")
	}
}

func TestGatewayKeyLifecycle(t *testing.T) {
	s := testStore(t)
	if !s.APIKeyOK("anything") {
		t.Fatal("empty key list means open access (legacy behavior)")
	}
	if _, err := s.AddGatewayKey("seed", "seed-key-1"); err != nil {
		t.Fatal(err)
	}
	if s.TenantOf("seed-key-1") != "seed" {
		t.Fatal("TenantOf should resolve tenant name")
	}
	k, err := s.AddGatewayKey("auto", "")
	if err != nil || k == "" {
		t.Fatalf("add generated key: %v", k)
	}
	if !s.APIKeyOK(k) {
		t.Fatal("new key should pass auth")
	}
	if got := s.ListTenants(); len(got) != 2 {
		t.Fatalf("want 2 tenants, got %d", len(got))
	}
	if err := s.RevokeGatewayKey("auto"); err != nil {
		t.Fatal(err)
	}
	if s.APIKeyOK(k) {
		t.Fatal("revoked key should fail auth")
	}
	if !s.APIKeyOK("seed-key-1") {
		t.Fatal("remaining key should still pass auth")
	}
	if err := s.RevokeGatewayKey("nope"); err == nil {
		t.Fatal("want error revoking unknown tenant")
	}
	if _, err := s.AddGatewayKey("", "x"); err == nil {
		t.Fatal("want error for empty tenant name")
	}
	if _, err := s.AddGatewayKey("seed", "other"); err == nil {
		t.Fatal("want error for duplicate tenant name")
	}
}

func strp(s string) *string { return &s }

func TestTenantConfigSeed(t *testing.T) {
	cfg := config.Config{}
	cfg.Tenants = []config.TenantRef{{Name: "acme", Key: "k-acme"}}
	cfg.APIKeys = []string{"legacy-key"}
	jev := decision.NewClient("https://x", "k", 5*time.Second, decision.DefaultRetryPolicy())
	llms := llm.NewRegistry("openai")
	engine := testEngine(llms)
	s := NewStore(cfg, "x", "adm", jev, engine, llms)
	if s.TenantOf("k-acme") != "acme" {
		t.Fatal("yaml tenants should seed TenantOf")
	}
	if !s.APIKeyOK("legacy-key") {
		t.Fatal("legacy api_keys should keep working")
	}
	if got := len(s.ListTenants()); got != 2 {
		t.Fatalf("want 2 seeded tenants, got %d", got)
	}
}

func TestProviderUpsertAndDefaultGuard(t *testing.T) {
	s := testStore(t)
	if err := s.UpsertProvider(ProviderUpsert{Name: "x", Endpoint: strp("https://x/v1")}); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveProvider("openai"); err == nil {
		t.Fatal("must not remove default provider")
	}
	if err := s.UpsertProvider(ProviderUpsert{Name: "x", Default: true}); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveProvider("openai"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetProviderKey("x", "sk-x"); err != nil {
		t.Fatal(err)
	}
	if got := s.SecretsStatus()["llm:x"]; got == "unset" || got == "sk-x" {
		t.Fatalf("secret must be masked, got %q", got)
	}
}

// Runtime overrides (gwadmin llm/jev mutations) must survive a gateway restart:
// persisted to runtime-overrides.json next to the config, replayed on NewStore.
func TestOverridesPersistence(t *testing.T) {
	dir := t.TempDir()
	s := testStoreAt(dir)
	if err := s.UpsertProvider(ProviderUpsert{
		Name: "openai", Endpoint: strp("https://gw.example.com/v1"),
		Model: strp("gpt-5.4-mini"), APIKey: strp("sk-live-key"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetProviderKey("openai", "sk-rotated"); err != nil {
		t.Fatal(err)
	}
	if err := s.RotateJevKey("sk-jev-new"); err != nil {
		t.Fatal(err)
	}

	// 模拟重启：同一目录新建 Store，overrides 应被重放
	s2 := testStoreAt(dir)
	snap := s2.Snapshot()
	var prov *struct {
		Name      string `json:"name"`
		Endpoint  string `json:"endpoint"`
		Model     string `json:"model"`
		TimeoutMs int    `json:"timeout_ms"`
		APIKey    string `json:"api_key"`
	}
	for i := range snap.LLMProviders.Providers {
		if snap.LLMProviders.Providers[i].Name == "openai" {
			prov = &snap.LLMProviders.Providers[i]
		}
	}
	if prov == nil {
		t.Fatal("provider openai missing after reload")
	}
	if prov.Endpoint != "https://gw.example.com/v1" || prov.Model != "gpt-5.4-mini" {
		t.Fatalf("endpoint/model not persisted: %+v", prov)
	}
	if prov.APIKey == "unset" || prov.APIKey == "sk-rotated" {
		t.Fatalf("rotated key not persisted (or leaked): %q", prov.APIKey)
	}
	if snap.Jev.APIKey == "unset" {
		t.Fatal("rotated jev key not persisted")
	}
}
