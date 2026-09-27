package api

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// svcProxy reverse-proxies /svc/<game>/<service>/... to the Python backend
// service declared in the pack manifest (dev mode: localhost port spawned by
// services.Supervisor). Only declared services resolve (404 otherwise), and a
// down service yields 503.
//
// Access is the pack's own decision, but the gateway is what enforces it: a
// route is reachable without a credential only if the service's manifest
// lists it under http.public. Anything else needs the operator token. The
// service still sees the token and may apply its own checks on top.
func (s *Server) svcProxy(w http.ResponseWriter, r *http.Request) {
	if s.sup == nil {
		http.NotFound(w, r)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/svc/")
	segs := strings.Split(rest, "/")
	if len(segs) < 2 || !validIdent(segs[0]) || !validIdent(segs[1]) {
		http.NotFound(w, r)
		return
	}
	game, name := segs[0], segs[1]
	ref, ok := s.sup.Ref(game, name)
	if !ok {
		http.NotFound(w, r) // not declared in any manifest
		return
	}
	// The service sees its own path space; the prefix is stripped below.
	sub := "/" + strings.Join(segs[2:], "/")
	if sub == "/" {
		sub = "/"
	}
	if !ref.IsPublicRoute(r.Method, sub) {
		token := r.Header.Get("X-Admin-Token")
		if token == "" {
			token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		}
		if !s.checkAdmin(token) {
			writeJSON(w, 401, map[string]any{
				"error": "unauthorized: this service route is not public",
			})
			return
		}
	}
	target, ok := s.sup.Target(game, name)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if !s.sup.Up(game, name) {
		writeJSON(w, 503, map[string]any{"error": "service " + game + "/" + name + " is down"})
		return
	}
	u, err := url.Parse(target)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	proxy := &httputil.ReverseProxy{Director: func(req *http.Request) {
		req.URL.Scheme = u.Scheme
		req.URL.Host = u.Host
		// Strip /svc/<game>/<service>: the service sees its own path space.
		req.URL.Path = sub
		req.Host = u.Host
	}}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		writeJSON(w, 502, map[string]any{"error": "service " + game + "/" + name + ": " + err.Error()})
	}
	proxy.ServeHTTP(w, r)
}
