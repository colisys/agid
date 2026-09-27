package api

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"gateway/internal/llm"
)

var proxyHopHeaders = map[string]bool{
	"Connection":          true,
	"Proxy-Connection":    true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

func isHopHeader(h string) bool {
	if proxyHopHeaders[h] {
		return true
	}
	return strings.HasPrefix(strings.ToLower(h), "proxy-")
}

func (s *Server) proxyHandler(w http.ResponseWriter, r *http.Request) {
	// /proxy/{provider}/... -> {upstream}/{...}
	rest := strings.TrimPrefix(r.URL.Path, "/proxy/")
	provider, sub, _ := strings.Cut(rest, "/")
	if provider == "" || sub == "" {
		writeJSON(w, 400, map[string]any{"error": "usage: /proxy/{provider}/{upstream-path...}"})
		return
	}
	p, err := s.llms.Get(provider)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": err.Error()})
		return
	}
	oc, ok := p.(*llm.OpenAICompat)
	if !ok {
		writeJSON(w, 501, map[string]any{"error": fmt.Sprintf("provider %q does not support passthrough", provider)})
		return
	}
	up := oc.Upstream()
	if up.Endpoint == "" {
		writeJSON(w, 502, map[string]any{"error": fmt.Sprintf("provider %q has no endpoint", provider)})
		return
	}

	target := strings.TrimSuffix(up.Endpoint, "/") + "/" + sub
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}

	timeout := up.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	// Buffer the body: known ContentLength avoids chunked encoding,
	// which some minimal upstreams cannot parse.
	var bodyReader io.Reader
	var bodyLen int64 = -1
	if r.Body != nil {
		b, err := io.ReadAll(io.LimitReader(r.Body, 256<<20))
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": "read body: " + err.Error()})
			return
		}
		if len(b) > 0 {
			bodyReader = bytes.NewReader(b)
			bodyLen = int64(len(b))
		}
	}
	client := &http.Client{Timeout: timeout}
	upReq, err := http.NewRequestWithContext(r.Context(), r.Method, target, bodyReader)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	if bodyLen >= 0 {
		upReq.ContentLength = bodyLen
	}
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
	}

	upResp, err := client.Do(upReq)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": fmt.Sprintf("upstream %s: %v", provider, err)})
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
	s.metrics.RecordProxy(s.checker.TenantOf(key), provider, r.Method, "/"+sub, upResp.StatusCode, n)
}
