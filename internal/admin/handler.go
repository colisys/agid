package admin

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"gateway/internal/decision"
	"gateway/internal/services"
)

type Handler struct {
	store *Store
}

func NewHandler(store *Store) *Handler { return &Handler{store: store} }

// Guard exposes the admin-token check for sibling routes (e.g. /v1/games/*).
func (h *Handler) Guard(next http.HandlerFunc) http.HandlerFunc { return h.guard(next) }

// CheckToken validates a credential the caller extracted itself. Sibling
// routes that accept more than one kind of credential (a match's player token
// alongside the operator token) need to ask about one of them specifically.
func (h *Handler) CheckToken(token string) bool {
	return h.store.Enabled() && h.store.CheckAdmin(token)
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/admin/config", h.guard(h.config))
	mux.HandleFunc("/admin/policies", h.guard(h.policies))
	mux.HandleFunc("/admin/jev", h.guard(h.jev))
	mux.HandleFunc("/admin/jev/key", h.guard(h.jevKey))
	mux.HandleFunc("/admin/llm/providers", h.guard(h.llmProviders))
	mux.HandleFunc("/admin/llm/keys", h.guard(h.llmKeys))
	mux.HandleFunc("/admin/keys", h.guard(h.gatewayKeys))
	mux.HandleFunc("/admin/script", h.guard(h.script))
	mux.HandleFunc("/admin/brains", h.guard(h.brains))
	mux.HandleFunc("/admin/brains/", h.guard(h.brains))
	mux.HandleFunc("/admin/rules", h.guard(h.rules))
	mux.HandleFunc("/admin/rules/", h.guard(h.rules))
	mux.HandleFunc("/admin/games/promote", h.guard(h.promote))
	mux.HandleFunc("/admin/compose", h.guard(h.compose))
	mux.HandleFunc("/admin/secrets", h.guard(h.secrets))
	mux.HandleFunc("/admin/changes", h.guard(h.changes))
	mux.HandleFunc("/admin/reload", h.guard(h.reload))
}

func (h *Handler) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.store.Enabled() {
			writeJSON(w, 404, map[string]any{"error": "admin disabled: set ADMIN_TOKEN"})
			return
		}
		token := r.Header.Get("X-Admin-Token")
		if token == "" {
			token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if !h.store.CheckAdmin(token) {
			writeJSON(w, 401, map[string]any{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

func (h *Handler) config(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	writeJSON(w, 200, h.store.Snapshot())
}

func (h *Handler) policies(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, h.store.Snapshot().Thresholds)
	case http.MethodPut:
		var th decision.Thresholds
		if err := decode(r, &th); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if err := h.store.SetThresholds(th); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "thresholds": th})
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (h *Handler) jev(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	var b struct {
		Endpoint  *string     `json:"endpoint"`
		ModelPin  *string     `json:"model_pin"`
		TimeoutMs *int        `json:"timeout_ms"`
		Retry     *RetryInput `json:"retry"`
	}
	if err := decode(r, &b); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if err := h.store.UpdateJev(JevUpdate{Endpoint: b.Endpoint, ModelPin: b.ModelPin, TimeoutMs: b.TimeoutMs, Retry: b.Retry}); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) jevKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	var b struct {
		APIKey string `json:"api_key"`
	}
	if err := decode(r, &b); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if err := h.store.RotateJevKey(b.APIKey); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "api_key": MaskSecret(b.APIKey)})
}

func (h *Handler) llmProviders(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, h.store.Snapshot().LLMProviders)
	case http.MethodPost, http.MethodPut:
		var b struct {
			Name      string  `json:"name"`
			Endpoint  *string `json:"endpoint"`
			Model     *string `json:"model"`
			APIKey    *string `json:"api_key"`
			TimeoutMs *int    `json:"timeout_ms"`
			Default   bool    `json:"default"`
		}
		if err := decode(r, &b); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if err := h.store.UpsertProvider(ProviderUpsert{
			Name: b.Name, Endpoint: b.Endpoint, Model: b.Model,
			APIKey: b.APIKey, TimeoutMs: b.TimeoutMs, Default: b.Default,
		}); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	case http.MethodDelete:
		name := r.URL.Query().Get("name")
		if name == "" {
			writeJSON(w, 400, map[string]any{"error": "query param name is required"})
			return
		}
		if err := h.store.RemoveProvider(name); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (h *Handler) llmKeys(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	var b struct {
		Name   string `json:"name"`
		APIKey string `json:"api_key"`
	}
	if err := decode(r, &b); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if err := h.store.SetProviderKey(b.Name, b.APIKey); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) gatewayKeys(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]any{"tenants": h.store.ListTenants()})
	case http.MethodPost:
		var b struct {
			Name string `json:"name"`
			Key  string `json:"key"`
		}
		_ = decode(r, &b)
		key, err := h.store.AddGatewayKey(b.Name, b.Key)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "name": b.Name, "key": key})
	case http.MethodDelete:
		ref := r.URL.Query().Get("name")
		if ref == "" {
			ref = r.URL.Query().Get("key")
		}
		if ref == "" {
			writeJSON(w, 400, map[string]any{"error": "query param name (or key) is required"})
			return
		}
		if err := h.store.RevokeGatewayKey(ref); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (h *Handler) secrets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	writeJSON(w, 200, h.store.SecretsStatus())
}

func (h *Handler) script(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]any{"script": h.store.Script()})
	case http.MethodPut, http.MethodPost:
		var b struct {
			Script string `json:"script"`
		}
		if err := decode(r, &b); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if err := h.store.SetScript(b.Script); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "bytes": len(b.Script)})
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (h *Handler) changes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	writeJSON(w, 200, map[string]any{"changes": h.store.Changes()})
}

func (h *Handler) reload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	if err := h.store.ReloadFromDisk(); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// brains handles /admin/brains (list) and /admin/brains/{name} (get/set).
func (h *Handler) brains(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/admin/brains")
	name = strings.TrimPrefix(name, "/")
	switch r.Method {
	case http.MethodGet:
		gameName := r.URL.Query().Get("game")
		if gameName == "" {
			writeJSON(w, 400, map[string]any{"error": "query ?game= is required"})
			return
		}
		if name == "" {
			writeJSON(w, 200, map[string]any{"brains": h.store.GameBrains(gameName)})
			return
		}
		if strings.Contains(name, "/") {
			writeJSON(w, 400, map[string]any{"error": "bad brain name"})
			return
		}
		script, ver, err := h.store.GameBrain(gameName, name, r.URL.Query().Get("version"))
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"name": name, "version": ver, "script": script})
	case http.MethodPut, http.MethodPost:
		var b struct {
			Game    string `json:"game"`
			Name    string `json:"name"`
			Version string `json:"version"`
			Script  string `json:"script"`
		}
		if err := decode(r, &b); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if name != "" && b.Name == "" {
			b.Name = name
		}
		if b.Game == "" {
			b.Game = r.URL.Query().Get("game")
		}
		if err := h.store.UploadBrain(b.Game, b.Name, b.Version, b.Script); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

// rules handles /admin/rules (list) and /admin/rules/{game} (get/set).
func (h *Handler) rules(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/admin/rules")
	name = strings.TrimPrefix(name, "/")
	switch r.Method {
	case http.MethodGet:
		if name == "" {
			writeJSON(w, 200, map[string]any{"games": h.store.GameList()})
			return
		}
		script, ver, err := h.store.GameRules(name, r.URL.Query().Get("version"))
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"game": name, "version": ver, "script": script})
	case http.MethodPut, http.MethodPost:
		var b struct {
			Game    string `json:"game"`
			Version string `json:"version"`
			Script  string `json:"script"`
		}
		if err := decode(r, &b); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if name != "" && b.Game == "" {
			b.Game = name
		}
		if err := h.store.UploadRules(b.Game, b.Version, b.Script); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (h *Handler) promote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	var b struct {
		Kind    string `json:"kind"`
		Game    string `json:"game"`
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := decode(r, &b); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if err := h.store.Promote(b.Kind, b.Game, b.Name, b.Version); err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func decode(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

// compose generates a docker-compose.yml covering every pack-declared backend
// service. The gateway only renders the config; running docker is up to the
// operator (scripts/service.sh compose writes it next to the CWD).
func (h *Handler) compose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	refs := h.store.ServiceRefs()
	// The YAML itself never carries a credential: granted values go to
	// sibling env files the caller writes with 0600. Callers that ignore
	// env_files still get a working config, just without the pack's secrets.
	writeJSON(w, 200, map[string]any{
		"yaml":      services.EmitCompose(refs),
		"env_files": services.ComposeEnvFiles(refs),
		"services":  len(refs),
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
