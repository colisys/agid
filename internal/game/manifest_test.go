package game

import (
	"os"
	"path/filepath"
	"testing"
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

func TestParseManifestDefaults(t *testing.T) {
	m, err := ParseManifest([]byte(`{"name":"地牢"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.RulesBase != "rules" || m.BrainsDir != "brains" || m.UIDir != "ui" || m.Name != "地牢" {
		t.Fatalf("defaults not applied: %+v", m)
	}
}

func TestParseManifestFull(t *testing.T) {
	src := `{
		"name": "dungeon",
		"rules": "game",
		"brains_dir": "ai",
		"ui_dir": "web",
		"capabilities": {"sage": ["jev", "svc:solver"], "narrator": ["llm"], "adventurer": []},
		"services": {"solver": {"runtime": "python", "entry": "services/solver.py", "port": 8901,
			"requirements": "services/requirements.txt"}}
	}`
	m, err := ParseManifest([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if m.RulesBase != "game" || m.BrainsDir != "ai" || m.UIDir != "web" {
		t.Fatalf("layout fields: %+v", m)
	}
	c := m.Capabilities["sage"]
	if len(c) != 2 || c[0] != "jev" || c[1] != "svc:solver" {
		t.Fatalf("sage caps: %v", c)
	}
	sd := m.Services["solver"]
	if sd.Port != 8901 || sd.Entry != "services/solver.py" {
		t.Fatalf("service def: %+v", sd)
	}
}

func TestParseManifestServiceSandbox(t *testing.T) {
	src := `{"name":"d","services":{"pm":{
		"runtime":"python","entry":"services/pm.py","port":8902,
		"env_allow":["LLM_UPSTREAM_URL","LLM_UPSTREAM_KEY"],
		"sandbox":{"profile":"strict","memory_mb":256,"cpu_s":300,"max_file_mb":64}}}}`
	m, err := ParseManifest([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	sd := m.Services["pm"]
	if len(sd.EnvAllow) != 2 {
		t.Fatalf("env_allow: %v", sd.EnvAllow)
	}
	if sd.Sandbox.Profile != "strict" || sd.Sandbox.MemoryMB != 256 ||
		sd.Sandbox.CPUSeconds != 300 || sd.Sandbox.MaxFileMB != 64 {
		t.Fatalf("sandbox: %+v", sd.Sandbox)
	}
	// The Ref projection is what both the dev spawn and the compose file use.
	r := sd.Ref("d", "pm", "/packs/d", "/srv/data", []string{"LLM_UPSTREAM_KEY=sk", "OTHER=no"})
	if r.Limits.MemoryMB != 256 || r.Limits.Profile != "strict" || r.Dir != "/packs/d" {
		t.Fatalf("ref: %+v", r)
	}
	if len(r.EnvAllow) != 2 || len(r.ExtraEnv) != 2 {
		t.Fatalf("ref env not carried: %+v", r)
	}
	// Declared workdir is joined onto the pack root; data_dir onto the data
	// root — never the other way round.
	if r.WorkDir != "/packs/d" {
		t.Errorf("undeclared workdir should fall back to the pack root, got %q", r.WorkDir)
	}
	if r.DataDir != "/srv/data/d/pm" {
		t.Errorf("default data_dir = %q, want /srv/data/d/pm", r.DataDir)
	}
	w := ServiceDef{DataDir: "dungeon", Workdir: "svc"}.Ref("d", "pm", "/packs/d", "/srv/data", nil)
	if w.DataDir != "/srv/data/dungeon" || w.WorkDir != "/packs/d/svc" {
		t.Errorf("declared workdir/data_dir: %q %q", w.WorkDir, w.DataDir)
	}
}

func TestParseManifestRejectsUnsafeServiceEnv(t *testing.T) {
	cases := map[string]string{
		// Asking for an operator credential is an authoring mistake and must
		// fail loudly rather than be silently dropped at spawn time.
		"env admin token": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"env_allow":["ADMIN_TOKEN"]}}}`,
		"env jev key": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"env_allow":["TYPESAFE_API_KEY"]}}}`,
		"env llm raw key": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"env_allow":["LLM_API_KEY"]}}}`,
		"env bad name": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"env_allow":["has space"]}}}`,
		"env assignment": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"env_allow":["A=1"]}}}`,
		"bad profile": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"sandbox":{"profile":"bwrap"}}}}`,
		// workdir/data_dir are joined onto a fixed base, so an escape or an
		// absolute path would write outside the area the operator granted.
		"workdir escape": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"workdir":"../outside"}}}`,
		"workdir abs": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"workdir":"/etc"}}}`,
		"data_dir escape": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"data_dir":"../../etc"}}}`,
		"data_dir abs": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"data_dir":"/etc"}}}`,
		"negative mem": `{"services":{"s":{"runtime":"python","entry":"x.py","port":80,
			"sandbox":{"memory_mb":-1}}}}`,
	}
	for label, src := range cases {
		if _, err := ParseManifest([]byte(src)); err == nil {
			t.Errorf("%s: expected error", label)
		}
	}
}

func TestParseManifestRejects(t *testing.T) {
	cases := map[string]string{
		"bad cap":        `{"capabilities":{"b":["tool"]}}`,
		"bad cap name":   `{"capabilities":{"b":["svc:Bad Name"]}}`,
		"rules escape":   `{"rules":"../x"}`,
		"rules slash":    `{"rules":"a/b"}`,
		"brains escape":  `{"brains_dir":".."}`,
		"ui escape":      `{"ui_dir":"..\\"}`,
		"svc runtime":    `{"services":{"s":{"runtime":"node","entry":"a.js","port":80}}}`,
		"svc entry abs":  `{"services":{"s":{"runtime":"python","entry":"/etc/x.py","port":80}}}`,
		"svc entry dots": `{"services":{"s":{"runtime":"python","entry":"../../x.py","port":80}}}`,
		"svc port zero":  `{"services":{"s":{"runtime":"python","entry":"x.py","port":0}}}`,
		"svc name":       `{"services":{"a/b":{"runtime":"python","entry":"x.py","port":80}}}`,
		"broken json":    `{`,
	}
	for label, src := range cases {
		if _, err := ParseManifest([]byte(src)); err == nil {
			t.Errorf("%s: expected error", label)
		}
	}
}

func TestDiskStoreManifestAndPackDir(t *testing.T) {
	root := t.TempDir()
	write(t, root+"/g1/manifest.json", `{"name":"G1","capabilities":{"b":["jev"]}}`)
	write(t, root+"/g1/rules.js", "rules")
	write(t, root+"/nomanifest/rules.js", "nope")
	s := NewDiskStore([]string{root}, 5)

	if got := s.Games(); len(got) != 1 || got[0] != "g1" {
		t.Fatalf("Games() = %v, want [g1] (manifest is the only marker)", got)
	}
	man, err := s.Manifest("g1")
	if err != nil || man.Name != "G1" {
		t.Fatalf("Manifest(g1) = %+v err=%v", man, err)
	}
	if c := man.Capabilities["b"]; len(c) != 1 || c[0] != "jev" {
		t.Fatalf("caps: %v", c)
	}
	if _, ok := s.PackDir("nomanifest"); ok {
		t.Fatal("PackDir must skip dirs without manifest")
	}
	if dir, ok := s.PackDir("g1"); !ok || dir != root+"/g1" {
		t.Fatalf("PackDir(g1) = %q %v", dir, ok)
	}
	// Missing manifest file -> default manifest (upload-only packs).
	dm, err := s.Manifest("uploaded")
	if err != nil || dm.RulesBase != "rules" || len(dm.Capabilities) != 0 {
		t.Fatalf("default manifest: %+v err=%v", dm, err)
	}
}
