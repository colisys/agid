package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gateway/internal/config"
	"gateway/internal/llm"
	"gateway/internal/observability"
)

func proxyTestServer(t *testing.T, upstream http.Handler) (*Server, *llm.Registry) {
	t.Helper()
	llms := llm.NewRegistry("up")
	srv := httptest.NewServer(upstream)
	t.Cleanup(srv.Close)
	p := llm.NewOpenAICompat("up", srv.URL, "upstream-secret", "m", 10*time.Second)
	llms.Register(p)
	s := NewServer(config.Config{}, nil, llms, observability.NewMetrics(), nil, "jev")
	return s, llms
}

func TestProxyPassthroughBodyQueryHeaders(t *testing.T) {
	var gotMethod, gotQuery, gotCustom, gotAuth, gotBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotMethod, gotQuery, gotCustom, gotAuth, gotBody =
			r.Method, r.URL.RawQuery, r.Header.Get("X-Custom"), r.Header.Get("Authorization"), string(b)
		w.Header().Set("X-Upstream", "yes")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer up.Close()

	llms := llm.NewRegistry("up")
	llms.Register(llm.NewOpenAICompat("up", up.URL, "upstream-secret", "m", 10*time.Second))
	s := NewServer(config.Config{}, nil, llms, observability.NewMetrics(), nil, "jev")

	req := httptest.NewRequest(http.MethodPost, "/proxy/up/some/path?a=1&b=2", strings.NewReader(`{"hello":"world"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Custom", "cval")
	req.Header.Set("Authorization", "Bearer tenant-key-should-be-replaced")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	resp := rec.Result()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 201 || string(body) != `{"ok":true}` {
		t.Fatalf("want 201 passthrough, got %d %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Upstream") != "yes" {
		t.Fatal("upstream response header should pass through")
	}
	if gotMethod != "POST" || gotQuery != "a=1&b=2" || gotCustom != "cval" || gotBody != `{"hello":"world"}` {
		t.Fatalf("request not passed through: %s %s %s %s", gotMethod, gotQuery, gotCustom, gotBody)
	}
	if gotAuth != "Bearer upstream-secret" {
		t.Fatalf("downstream key leaked or upstream key missing: %q", gotAuth)
	}
}

func TestProxyUnknownProvider(t *testing.T) {
	s, _ := proxyTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/proxy/nope/x", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}

func TestProxyUpstreamErrorPassthrough(t *testing.T) {
	s, _ := proxyTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":"slow down"}`))
	}))
	req := httptest.NewRequest(http.MethodGet, "/proxy/up/models", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 429 {
		t.Fatalf("want upstream 429, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "slow down") {
		t.Fatalf("want upstream body, got %s", rec.Body.String())
	}
}

func TestProxySSEStream(t *testing.T) {
	s, _ := proxyTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"a\":1}\n\ndata: [DONE]\n\n"))
	}))
	req := httptest.NewRequest(http.MethodPost, "/proxy/up/chat/completions", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("want streamed body, got %s", rec.Body.String())
	}
}

func TestChatCompletionsPassthrough(t *testing.T) {
	var gotBody, gotAuth, gotQuery string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody, gotAuth, gotQuery = string(b), r.Header.Get("Authorization"), r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer up.Close()

	llms := llm.NewRegistry("up")
	llms.Register(llm.NewOpenAICompat("up", up.URL, "upstream-secret", "default-model", 10*time.Second))
	s := NewServer(config.Config{}, nil, llms, observability.NewMetrics(), nil, "jev")
	h := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"messages":[{"role":"user","content":"hi"}],"stream":true,"tools":[{"type":"function"}],"provider":"up"}`))
	req.Header.Set("Authorization", "Bearer tenant-k")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(gotBody), &sent); err != nil {
		t.Fatalf("upstream body not json: %s", gotBody)
	}
	if sent["model"] != "default-model" {
		t.Fatalf("want gateway model override, got %v", sent["model"])
	}
	if _, ok := sent["provider"]; ok {
		t.Fatal("provider selector must be stripped, not forwarded")
	}
	if _, ok := sent["tools"]; !ok {
		t.Fatal("tools must pass through untouched")
	}
	if gotAuth != "Bearer upstream-secret" {
		t.Fatalf("auth not replaced: %q", gotAuth)
	}
	if !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("want SSE passthrough, got %s", rec.Body.String())
	}

	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions?x=1",
		strings.NewReader(`{"model":"custom-m","messages":[]}`))
	req2.Header.Set("Authorization", "Bearer tenant-k")
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("want 200, got %d", rec2.Code)
	}
	var sent2 map[string]any
	_ = json.Unmarshal([]byte(gotBody), &sent2)
	if sent2["model"] != "default-model" {
		t.Fatalf("gateway model must override downstream, got %v", sent2["model"])
	}
	if gotQuery != "x=1" {
		t.Fatalf("query must pass through, got %q", gotQuery)
	}

	// 3. provider 没配 model -> 遵从下游，直通
	llms2 := llm.NewRegistry("bare")
	llms2.Register(llm.NewOpenAICompat("bare", up.URL, "upstream-secret", "", 10*time.Second))
	s2 := NewServer(config.Config{}, nil, llms2, observability.NewMetrics(), nil, "jev")
	req3 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"downstream-m","messages":[]}`))
	req3.Header.Set("Authorization", "Bearer tenant-k")
	rec3 := httptest.NewRecorder()
	s2.Handler().ServeHTTP(rec3, req3)
	if rec3.Code != 200 {
		t.Fatalf("want 200, got %d", rec3.Code)
	}
	var sent3 map[string]any
	_ = json.Unmarshal([]byte(gotBody), &sent3)
	if sent3["model"] != "downstream-m" {
		t.Fatalf("without gateway model, downstream must pass through, got %v", sent3["model"])
	}
}
