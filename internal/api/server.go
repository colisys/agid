package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"gateway/internal/admin"
	"gateway/internal/config"
	"gateway/internal/decision"
	"gateway/internal/llm"
	"gateway/internal/observability"
	"gateway/internal/orchestrator"
	"gateway/internal/services"
)

type keyChecker interface {
	APIKeyOK(key string) bool
	TenantOf(key string) string
}

type Server struct {
	cfg     config.Config
	checker keyChecker
	engine  *orchestrator.Engine
	llms    *llm.Registry
	metrics *observability.Metrics
	decide  func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error)
	model   string
	adm     *admin.Handler
	games   *Games
	sup     *services.Supervisor // managed pack services (/svc proxy)
	adminOn bool
}

func NewServer(cfg config.Config, engine *orchestrator.Engine, llms *llm.Registry, metrics *observability.Metrics, decide func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error), model string) *Server {
	return &Server{cfg: cfg, checker: cfg, engine: engine, llms: llms, metrics: metrics, decide: decide, model: model}
}

func NewServerWithAdmin(cfg config.Config, checker keyChecker, store *admin.Store, engine *orchestrator.Engine, llms *llm.Registry, metrics *observability.Metrics, decide func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error), model string) *Server {
	on := store != nil && store.Enabled()
	return &Server{cfg: cfg, checker: checker, engine: engine, llms: llms, metrics: metrics, decide: decide, model: model, adm: admin.NewHandler(store), adminOn: on}
}

// WithGames attaches the game server routes (admin-token guarded).
func (s *Server) WithGames(g *Games) *Server {
	s.games = g
	return s
}

// WithServices attaches the managed pack services for the /svc proxy.
func (s *Server) WithServices(sup *services.Supervisor) *Server {
	s.sup = sup
	return s
}

// AdminGuard exposes the admin-token check for attached routes.
func (s *Server) AdminGuard(next http.HandlerFunc) http.HandlerFunc {
	if s.adm == nil {
		return func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, 404, map[string]any{"error": "admin disabled: set ADMIN_TOKEN"})
		}
	}
	return s.adm.Guard(next)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.health)
	mux.HandleFunc("/v1/execute", s.auth(s.execute))
	mux.HandleFunc("/v1/decide", s.auth(s.decideHandler))
	mux.HandleFunc("/v1/chat/completions", s.auth(s.chatCompletions))
	mux.HandleFunc("/proxy/", s.auth(s.proxyHandler))
	mux.HandleFunc("/v1/models", s.auth(s.models))
	mux.HandleFunc("/metrics", s.auth(s.metricsHandler))
	mux.HandleFunc("/play/", s.playPage)
	mux.HandleFunc("/svc/", s.svcProxy)
	if s.adminOn {
		s.adm.Register(mux)
		if s.games != nil {
			s.games.Register(mux)
		}
	} else {
		mux.HandleFunc("/admin/packs", s.auth(s.packs))
		mux.HandleFunc("/admin/policies", s.auth(s.legacyPolicies))
	}
	return mux
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true})
}

// CheckAdminToken exposes the operator-token check to sibling routes that
// accept more than one kind of credential.
func (s *Server) CheckAdminToken(token string) bool { return s.checkAdmin(token) }

// checkAdmin validates the operator token. The /svc proxy needs it directly:
// it is not an /admin route, but most service routes are not declared public.
func (s *Server) checkAdmin(token string) bool {
	if s.adm == nil {
		return false
	}
	return s.adm.CheckToken(token)
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Authorization")
		key = strings.TrimPrefix(key, "Bearer ")
		if !s.checker.APIKeyOK(key) {
			writeJSON(w, 401, map[string]any{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

type executeBody struct {
	Goal        string                   `json:"goal"`
	Context     map[string]any           `json:"context"`
	Candidates  []orchestrator.Candidate `json:"candidates_hint"`
	PolicySet   string                   `json:"policy_set"`
	HighRisk    bool                     `json:"high_risk"`
	Routes      map[string]string        `json:"routes"`
	ToolName    string                   `json:"tool"`
	LLMProvider string                   `json:"llm_provider"`
	Budget      orchestrator.Budget      `json:"budget"`
}

func (s *Server) execute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	var b executeBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&b); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad request: " + err.Error()})
		return
	}
	if b.Goal == "" {
		writeJSON(w, 400, map[string]any{"error": "goal is required"})
		return
	}
	if b.PolicySet == "" {
		b.PolicySet = "default-v1"
	}
	res, err := s.engine.Execute(r.Context(), orchestrator.ExecuteRequest{
		Goal: b.Goal, Context: b.Context, Candidates: b.Candidates,
		PolicySet: b.PolicySet, HighRisk: b.HighRisk, Routes: b.Routes,
		ToolName: b.ToolName, Budget: b.Budget, LLMProvider: b.LLMProvider,
	})
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.metrics.Record(observability.AuditEntry{
		Time: time.Now(), TraceID: res.TraceID, Tenant: s.checker.TenantOf(key),
		Action: string(res.Verdict.Action),
		Route:  res.Verdict.Route, Confidence: res.Verdict.Confidence,
		JevModel: res.JevModel, JevTokens: res.JevTokens, LLMTokens: res.LLMTokens,
		Reason: res.Verdict.Reason,
	})
	writeJSON(w, 200, res)
}

type decideBody struct {
	State     any                          `json:"state"`
	Model     string                       `json:"model"`
	Questions map[string]decision.Question `json:"questions"`
}

func (s *Server) decideHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	var b decideBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&b); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad request: " + err.Error()})
		return
	}
	if len(b.Questions) == 0 {
		writeJSON(w, 400, map[string]any{"error": "questions is required"})
		return
	}
	model := b.Model
	if model == "" {
		model = s.model
	}
	res, err := s.decide(r.Context(), decision.SystemOneRequest{State: b.State, Model: model, Questions: b.Questions})
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, res)
}

func (s *Server) chatCompletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "read body: " + err.Error()})
		return
	}
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad request: invalid json"})
		return
	}
	providerName, _ := envelope["provider"].(string)
	delete(envelope, "provider")
	p, err := s.llms.Get(providerName)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	oc, ok := p.(*llm.OpenAICompat)
	if !ok {
		writeJSON(w, 501, map[string]any{"error": fmt.Sprintf("provider %q does not support chat completions", p.Name())})
		return
	}
	up := oc.Upstream()
	if up.Endpoint == "" {
		writeJSON(w, 502, map[string]any{"error": fmt.Sprintf("provider %q has no endpoint", p.Name())})
		return
	}
	// 条件映射：网关配了 model 就覆盖下游的 model；没配则遵从下游，直通上游。
	if up.Model != "" {
		envelope["model"] = up.Model
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "encode body: " + err.Error()})
		return
	}
	target := strings.TrimSuffix(up.Endpoint, "/") + "/chat/completions"
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	timeout := up.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	upReq.ContentLength = int64(len(body))
	for name, values := range r.Header {
		if isHopHeader(name) || strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "Content-Length") {
			continue
		}
		for _, v := range values {
			upReq.Header.Add(name, v)
		}
	}
	if up.APIKey != "" {
		upReq.Header.Set("Authorization", "Bearer "+up.APIKey)
	}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		upReq.Header.Set("Content-Type", ct)
	} else {
		upReq.Header.Set("Content-Type", "application/json")
	}
	upResp, err := (&http.Client{Timeout: timeout}).Do(upReq)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": fmt.Sprintf("upstream %s: %v", p.Name(), err)})
		return
	}
	defer upResp.Body.Close()
	for name, values := range upResp.Header {
		if isHopHeader(name) || strings.EqualFold(name, "Content-Length") {
			continue
		}
		for _, v := range values {
			w.Header().Add(name, v)
		}
	}
	w.WriteHeader(upResp.StatusCode)
	n, _ := io.Copy(w, io.LimitReader(upResp.Body, 256<<20))
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.metrics.RecordProxy(s.checker.TenantOf(key), p.Name(), r.Method, "/v1/chat/completions", upResp.StatusCode, n)
}

func (s *Server) models(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"data": []any{
		map[string]any{"id": s.model, "owned_by": "typesafe"},
		map[string]any{"id": s.llms.Default(), "owned_by": "llm"},
	}})
}

func (s *Server) metricsHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"metrics": s.metrics.Snapshot(),
		"recent":  s.metrics.RecentAudit(20),
	})
}

func (s *Server) packs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"packs": []string{"routing", "risk", "selection", "verification"}})
}

func (s *Server) legacyPolicies(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"error": "admin disabled: set ADMIN_TOKEN to enable dynamic admin"})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
