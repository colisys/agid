package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"gateway/internal/game"
)

// playPage serves game UIs from disk (no auth: static HTML/JS only).
//
// Three-level layout, per the pack manifest (<game>/manifest.json):
//
//	/play/<game>/                     -> variant list (302 to the only one)
//	/play/<game>/<variant>/...        -> <game_root>/<game>/<ui_dir>/<variant>/...
//
// Only files under <ui_dir>/<variant>/ are served — rules.js and brains/*.js
// are never reachable. A pack without ui variants (pure backend game) 404s.
func (s *Server) playPage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/play/")
	segs := strings.Split(rest, "/")
	gname := segs[0]
	if !validIdent(gname) {
		http.NotFound(w, r)
		return
	}
	packDir, man := s.packFor(gname)
	if packDir == "" {
		http.NotFound(w, r)
		return
	}
	tail := segs[1:]
	if len(tail) == 0 || (len(tail) == 1 && tail[0] == "") {
		s.playIndex(w, r, gname, packDir, man)
		return
	}
	variant := tail[0]
	if !validIdent(variant) {
		http.NotFound(w, r)
		return
	}
	base := filepath.Join(packDir, man.UIDir, variant)
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		http.NotFound(w, r)
		return
	}
	name := strings.Join(tail[1:], "/")
	if name == "" {
		// Directory-style URL: force a trailing slash so relative asset URLs
		// (./assets/x.js) resolve under the variant, not the game root.
		if !strings.HasSuffix(r.URL.Path, "/") {
			http.Redirect(w, r, r.URL.Path+"/", http.StatusFound)
			return
		}
		serveFileExact(w, r, filepath.Join(base, "index.html"))
		return
	}
	if !validRelPath(name) {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(base, filepath.FromSlash(name))
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		// SPA fallback: extensionless deep links hit the app entry; real
		// missing assets (with extension) stay 404.
		if !strings.Contains(filepath.Base(name), ".") {
			serveFileExact(w, r, filepath.Join(base, "index.html"))
			return
		}
		http.NotFound(w, r)
		return
	}
	serveFileExact(w, r, p)
}

// serveFileExact sends a file without http.ServeFile's path canonicalization
// redirects (which would leak the on-disk layout via 301 Location headers).
func serveFileExact(w http.ResponseWriter, r *http.Request, p string) {
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
}

// playIndex serves the variant chooser for a pack with ui variants.
func (s *Server) playIndex(w http.ResponseWriter, r *http.Request, gname, packDir string, man *game.Manifest) {
	variants := listVariants(filepath.Join(packDir, man.UIDir))
	switch len(variants) {
	case 0:
		http.NotFound(w, r) // pure backend game: no UI to serve
	case 1:
		http.Redirect(w, r, "/play/"+gname+"/"+variants[0]+"/", http.StatusFound)
	default:
		title := man.Name
		if title == "" {
			title = gname
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(200)
		var b strings.Builder
		b.WriteString("<!doctype html><meta charset=utf-8><title>")
		b.WriteString(esc(title))
		b.WriteString("</title>")
		b.WriteString("<h1>")
		b.WriteString(esc(title))
		b.WriteString("</h1><ul>")
		for _, v := range variants {
			b.WriteString(`<li><a href="/play/`)
			b.WriteString(gname)
			b.WriteString(`/`)
			b.WriteString(v)
			b.WriteString(`/">`)
			b.WriteString(esc(v))
			b.WriteString(`</a></li>`)
		}
		b.WriteString("</ul>")
		_, _ = w.Write([]byte(b.String()))
	}
}

// packFor locates the first game root carrying a manifest for gname.
func (s *Server) packFor(gname string) (string, *game.Manifest) {
	for _, root := range s.cfg.GameRoots() {
		dir := filepath.Join(root, gname)
		b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if err != nil {
			continue
		}
		man, err := game.ParseManifest(b)
		if err != nil {
			continue // corrupt manifest: skip like the store does
		}
		return dir, man
	}
	return "", nil
}

func listVariants(dir string) []string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() && validIdent(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out // ReadDir order is already sorted
}

// validIdent accepts a single game/variant name: no dots (blocks ".." and
// file-like names), no separators, never empty.
func validIdent(s string) bool {
	return s != "" && !strings.Contains(s, ".") && !strings.ContainsAny(s, `/\`)
}

// validRelPath checks a slash-separated tail under a variant dir.
func validRelPath(p string) bool {
	if strings.Contains(p, `\`) {
		return false // backslash is a separator on some platforms
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

func esc(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&#34;")
	return r.Replace(s)
}
