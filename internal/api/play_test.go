package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gateway/internal/config"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func playServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	cfg := config.Config{}
	cfg.Games.Dir = root
	return NewServer(cfg, nil, nil, nil, nil, ""), root
}

func get(t *testing.T, h http.Handler, url string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPlayVariantServing(t *testing.T) {
	s, root := playServer(t)
	h := s.Handler()
	write(t, root+"/dungeon/manifest.json", `{"name":"地牢","ui_dir":"ui"}`)
	write(t, root+"/dungeon/rules.js", "SCRIPTS-MUST-NOT-LEAK")
	write(t, root+"/dungeon/ui/wap/index.html", "wap-home")
	write(t, root+"/dungeon/ui/wap/app.js", "console.log(1)")
	write(t, root+"/dungeon/ui/pro/index.html", "pro-home")

	// Two variants -> built-in list page with both links.
	rec := get(t, h, "/play/dungeon/")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "/play/dungeon/wap/") ||
		!strings.Contains(rec.Body.String(), "地牢") {
		t.Fatalf("list page: %d %s", rec.Code, rec.Body.String())
	}

	// Variant files serve.
	if rec := get(t, h, "/play/dungeon/wap/"); rec.Code != 200 || rec.Body.String() != "wap-home" {
		t.Fatalf("wap index: %d", rec.Code)
	}
	if rec := get(t, h, "/play/dungeon/wap/"); rec.Header().Get("Content-Type") == "" {
		t.Fatal("content type missing")
	}
	if rec := get(t, h, "/play/dungeon/wap/app.js"); rec.Code != 200 {
		t.Fatalf("asset: %d", rec.Code)
	}
	if rec := get(t, h, "/play/dungeon/pro/index.html"); rec.Code != 200 || rec.Body.String() != "pro-home" {
		t.Fatalf("pro: %d", rec.Code)
	}

	// SPA fallback: extensionless deep link -> variant index; assets stay 404.
	if rec := get(t, h, "/play/dungeon/wap/room/7"); rec.Code != 200 || rec.Body.String() != "wap-home" {
		t.Fatalf("spa fallback: %d", rec.Code)
	}
	if rec := get(t, h, "/play/dungeon/wap/missing.js"); rec.Code != 404 {
		t.Fatalf("missing asset must 404: %d", rec.Code)
	}

	// Scripts are unreachable at any level.
	for _, u := range []string{"/play/dungeon/rules.js", "/play/dungeon/wap/rules.js",
		"/play/dungeon/brains/x.js", "/play/dungeon/ui/wap/index.html"} {
		if rec := get(t, h, u); rec.Code != 404 {
			t.Fatalf("%s must 404, got %d", u, rec.Code)
		}
	}

	// Traversal and bad idents. ServeMux cleans dotted paths with a 307 to the
	// normalized URL — assert the final destination is a 404.
	for _, u := range []string{"/play/dungeon/wap/../../rules.js", "/play/dungeon/../manifest.json",
		"/play/dungeon/wap/..%5c..%5crules.js", "/play/dungeon/wap/%2e%2e/x",
		"/play/dungeon/w..ap/x", "/play/manifest.json"} {
		mustEnd404(t, h, u)
	}
}

func mustEnd404(t *testing.T, h http.Handler, u string) {
	t.Helper()
	rec := get(t, h, u)
	for hop := 0; rec.Code/100 == 3 && hop < 3; hop++ {
		loc := rec.Header().Get("Location")
		if loc == "" {
			t.Fatalf("%s: %d redirect without Location", u, rec.Code)
		}
		rec = get(t, h, loc)
	}
	if rec.Code != 404 {
		t.Fatalf("%s must end 404, got %d", u, rec.Code)
	}
}

func TestPlaySingleVariantRedirectAndSlash(t *testing.T) {
	s, root := playServer(t)
	h := s.Handler()
	write(t, root+"/tictactoe/manifest.json", `{"name":"井字棋"}`)
	write(t, root+"/tictactoe/ui/board/index.html", "board-home")

	rec := get(t, h, "/play/tictactoe/")
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/play/tictactoe/board/" {
		t.Fatalf("redirect: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	// Missing trailing slash -> redirect that keeps relative assets working.
	if rec := get(t, h, "/play/tictactoe/board"); rec.Code != http.StatusFound ||
		rec.Header().Get("Location") != "/play/tictactoe/board/" {
		t.Fatalf("slash redirect: %d %s", rec.Code, rec.Header().Get("Location"))
	}
}

func TestPlayPureBackendAndNoManifest(t *testing.T) {
	s, root := playServer(t)
	h := s.Handler()
	write(t, root+"/rts/manifest.json", `{"name":"rts"}`)
	write(t, root+"/rts/rules.js", "rules")
	write(t, root+"/legacy/index.html", "old") // no manifest: skipped entirely

	if rec := get(t, h, "/play/rts/"); rec.Code != 404 {
		t.Fatalf("pure backend game must 404, got %d", rec.Code)
	}
	if rec := get(t, h, "/play/legacy/"); rec.Code != 404 {
		t.Fatalf("pack without manifest must be invisible, got %d", rec.Code)
	}
}

func TestPlayMultiRootPriority(t *testing.T) {
	rootA, rootB := t.TempDir(), t.TempDir()
	cfg := config.Config{}
	cfg.Games.Dir = rootA + "," + rootB
	s := NewServer(cfg, nil, nil, nil, nil, "")
	h := s.Handler()
	write(t, rootB+"/g/manifest.json", `{}`)
	write(t, rootB+"/g/ui/wap/index.html", "from-b")
	if rec := get(t, h, "/play/g/wap/"); rec.Code != 200 || rec.Body.String() != "from-b" {
		t.Fatalf("second root: %d", rec.Code)
	}
}

func TestPlayMethodNotAllowed(t *testing.T) {
	s, _ := playServer(t)
	req := httptest.NewRequest(http.MethodPost, "/play/g/", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /play: %d", rec.Code)
	}
}
