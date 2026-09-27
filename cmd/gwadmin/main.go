package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

var (
	base   string
	token  string
	client = &http.Client{Timeout: 5 * time.Minute}
)

func main() {
	flag.StringVar(&base, "base", defaultBase(), "gateway base URL")
	flag.StringVar(&token, "token", defaultToken(), "admin token")
	flag.Parse()
	args := flag.Args()
	if token == "" {
		fatal("admin token required: -token or ADMIN_TOKEN env")
	}
	if len(args) == 0 {
		usage()
	}
	var err error
	switch args[0] {
	case "config":
		err = run("GET", "/admin/config", nil)
	case "secrets":
		err = run("GET", "/admin/secrets", nil)
	case "changes":
		err = run("GET", "/admin/changes", nil)
	case "policies":
		err = policies(args[1:])
	case "jev":
		err = jev(args[1:])
	case "llm":
		err = llmCmd(args[1:])
	case "keys":
		err = keys(args[1:])
	case "script":
		err = scriptCmd(args[1:])
	case "games":
		err = gamesCmd(args[1:])
	case "brains":
		err = brainsCmd(args[1:])
	case "rules":
		err = rulesCmd(args[1:])
	case "reload":
		err = run("POST", "/admin/reload", nil)
	default:
		usage()
	}
	if err != nil {
		fatal(err.Error())
	}
}

var policyFields = map[string]string{
	"intent_human_below": "IntentHumanBelow", "intenthumanbelow": "IntentHumanBelow",
	"low_risk_allow_at": "LowRiskAllowAt", "lowriskallowat": "LowRiskAllowAt",
	"high_risk_allow_above": "HighRiskAllowAbove", "highriskallowabove": "HighRiskAllowAbove",
	"complexity_human_above": "ComplexityHumanAbove", "complexityhumanabove": "ComplexityHumanAbove",
	"complexity_human_conf_below": "ComplexityHumanConfBel", "complexityhumanconfbel": "ComplexityHumanConfBel",
	"complexity_human_confbel": "ComplexityHumanConfBel",
	"risk_block_below":         "RiskBlockBelow", "riskblockbelow": "RiskBlockBelow",
	"severity_block_above": "SeverityBlockAbove", "severityblockabove": "SeverityBlockAbove",
}

func policyField(k string) (string, error) {
	norm := strings.ReplaceAll(strings.ToLower(k), "-", "_")
	if f, ok := policyFields[norm]; ok {
		return f, nil
	}
	// accept Go field name directly (case-insensitive)
	for _, f := range policyFields {
		if strings.EqualFold(f, k) {
			return f, nil
		}
	}
	return "", fmt.Errorf("unknown policy field %q", k)
}

func policies(args []string) error {
	if len(args) == 0 || args[0] == "get" {
		return run("GET", "/admin/policies", nil)
	}
	if args[0] != "set" {
		return fmt.Errorf("usage: gwadmin policies [get|set k=v ...]")
	}
	cur := map[string]any{}
	var curAny any = &cur
	if err := call("GET", "/admin/policies", nil, &curAny); err != nil {
		return err
	}
	m := map[string]any{}
	maps.Copy(m, cur)
	for _, kv := range args[1:] {
		k, vs, ok := strings.Cut(kv, "=")
		if !ok {
			return fmt.Errorf("bad k=v: %q", kv)
		}
		field, err := policyField(k)
		if err != nil {
			return err
		}
		f, err := strconv.ParseFloat(vs, 64)
		if err != nil {
			return fmt.Errorf("bad number %q: %w", kv, err)
		}
		m[field] = f
	}
	return run("PUT", "/admin/policies", m)
}

func jev(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: gwadmin jev [set k=v ...|rotate-key KEY]")
	}
	if args[0] == "rotate-key" {
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin jev rotate-key NEW_KEY")
		}
		return run("POST", "/admin/jev/key", map[string]any{"api_key": args[1]})
	}
	if args[0] != "set" {
		return fmt.Errorf("usage: gwadmin jev [set k=v ...|rotate-key KEY]")
	}
	m := map[string]any{}
	retry := map[string]any{}
	for _, kv := range args[1:] {
		k, vs, ok := strings.Cut(kv, "=")
		if !ok {
			return fmt.Errorf("bad k=v: %q", kv)
		}
		k = snake(k)
		switch k {
		case "endpoint", "model_pin":
			m[k] = vs
		case "timeout_ms", "retry_max_attempts", "retry_base_backoff_ms":
			n, err := strconv.Atoi(vs)
			if err != nil {
				return fmt.Errorf("bad number %q", kv)
			}
			if after, ok0 := strings.CutPrefix(k, "retry_"); ok0 {
				retry[after] = n
			} else {
				m[k] = n
			}
		case "retry_honor_retry_after":
			b, err := strconv.ParseBool(vs)
			if err != nil {
				return fmt.Errorf("bad bool %q", kv)
			}
			retry["honor_retry_after"] = b
		default:
			return fmt.Errorf("unknown field %q (endpoint, model_pin, timeout_ms, retry_*)", k)
		}
	}
	if len(retry) > 0 {
		m["retry"] = retry
	}
	return run("PATCH", "/admin/jev", m)
}

func llmCmd(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: gwadmin llm [list|upsert ...|remove NAME|rotate-key NAME KEY]")
	}
	switch args[0] {
	case "list":
		return run("GET", "/admin/llm/providers", nil)
	case "upsert":
		m := map[string]any{}
		for _, kv := range args[1:] {
			k, vs, ok := strings.Cut(kv, "=")
			if !ok {
				return fmt.Errorf("bad k=v: %q", kv)
			}
			k = snake(k)
			switch k {
			case "name", "endpoint", "model", "api_key":
				m[k] = vs
			case "timeout_ms":
				n, err := strconv.Atoi(vs)
				if err != nil {
					return fmt.Errorf("bad number %q", kv)
				}
				m[k] = n
			case "default":
				b, err := strconv.ParseBool(vs)
				if err != nil {
					return fmt.Errorf("bad bool %q", kv)
				}
				m[k] = b
			default:
				return fmt.Errorf("unknown field %q", k)
			}
		}
		if m["name"] == nil || m["name"] == "" {
			// name omitted: target the default provider
			var llm struct {
				Default string `json:"default"`
			}
			var llmAny any = &llm
			if err := call("GET", "/admin/llm/providers", nil, &llmAny); err != nil {
				return err
			}
			if llm.Default == "" {
				return fmt.Errorf("name is required (no default provider set)")
			}
			m["name"] = llm.Default
		}
		return run("POST", "/admin/llm/providers", m)
	case "remove":
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin llm remove NAME")
		}
		return run("DELETE", "/admin/llm/providers?name="+args[1], nil)
	case "rotate-key":
		if len(args) != 3 {
			return fmt.Errorf("usage: gwadmin llm rotate-key NAME KEY")
		}
		return run("POST", "/admin/llm/keys", map[string]any{"name": args[1], "api_key": args[2]})
	default:
		return fmt.Errorf("unknown llm subcommand %q", args[0])
	}
}

func keys(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: gwadmin keys [list|add NAME [KEY]|revoke NAME]")
	}
	switch args[0] {
	case "list":
		return run("GET", "/admin/keys", nil)
	case "add":
		if len(args) < 2 || len(args) > 3 {
			return fmt.Errorf("usage: gwadmin keys add NAME [KEY]")
		}
		m := map[string]any{"name": args[1]}
		if len(args) == 3 {
			m["key"] = args[2]
		}
		return run("POST", "/admin/keys", m)
	case "revoke":
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin keys revoke NAME")
		}
		return run("DELETE", "/admin/keys?name="+args[1], nil)
	default:
		return fmt.Errorf("unknown keys subcommand %q", args[0])
	}
}

func scriptCmd(args []string) error {
	if len(args) == 0 || args[0] == "get" {
		return run("GET", "/admin/script", nil)
	}
	if args[0] != "set" {
		return fmt.Errorf("usage: gwadmin script [get|set FILE]")
	}
	if len(args) != 2 {
		return fmt.Errorf("usage: gwadmin script set FILE")
	}
	b, err := os.ReadFile(args[1])
	if err != nil {
		return err
	}
	return run("PUT", "/admin/script", map[string]any{"script": string(b)})
}

// brainSeat builds a brain player seat. "name@version" pins a brain version;
// plain "name" uses the stable version.
func brainSeat(spec string) map[string]any {
	name, ver, _ := strings.Cut(spec, "@")
	seat := map[string]any{"brain": name}
	if ver != "" {
		seat["version"] = ver
	}
	return map[string]any{"brain": seat}
}

func gamesCmd(args []string) error {
	if len(args) == 0 || args[0] == "list" {
		return run("GET", "/v1/games", nil)
	}
	switch args[0] {
	case "show":
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin games show MATCH_ID")
		}
		return run("GET", "/v1/games/"+args[1], nil)
	case "stop":
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin games stop MATCH_ID")
		}
		return run("POST", "/v1/games/"+args[1]+"/stop", nil)
	case "replay":
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin games replay MATCH_ID")
		}
		return run("GET", "/v1/games/"+args[1]+"/replay", nil)
	case "create":
		// gwadmin games create GAME BRAIN_X [BRAIN_O|human] [--headless] [k=v ...]
		// BRAIN_X: brain for seat p0. Optional second positional sets seat p1:
		// a brain name, or "human" for a human seat. Omit it for a single-brain
		// match. Pure-brain matches default to headless.
		if len(args) < 3 {
			return fmt.Errorf("usage: gwadmin games create GAME BRAIN_X [BRAIN_O|human] [--headless] [k=v ...]")
		}
		players := []any{brainSeat(args[2])}
		rest := args[3:]
		if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") && !strings.Contains(rest[0], "=") {
			seat := rest[0]
			rest = rest[1:]
			if seat == "human" {
				players = append(players, map[string]any{"human": true})
			} else {
				players = append(players, brainSeat(seat))
			}
		}
		headless := true
		for _, p := range players {
			if m, ok := p.(map[string]any); ok {
				if _, isHuman := m["human"]; isHuman {
					headless = false
					break
				}
			}
		}
		body := map[string]any{
			"game":    args[1],
			"players": players,
		}
		if headless {
			body["headless"] = true
		}
		for _, kv := range rest {
			if kv == "--headless" {
				body["headless"] = true
				continue
			}
			k, vs, ok := strings.Cut(kv, "=")
			if !ok {
				return fmt.Errorf("bad k=v: %q", kv)
			}
			switch k {
			case "tick_ms", "max_ticks", "seed":
				n, err := strconv.Atoi(vs)
				if err != nil {
					return fmt.Errorf("bad number %q", kv)
				}
				body[k] = n
			case "rules", "rules_version":
				body[k] = vs
			default:
				return fmt.Errorf("unknown field %q (tick_ms, max_ticks, seed, rules, rules_version)", k)
			}
		}
		return run("POST", "/v1/games", body)
	default:
		return fmt.Errorf("usage: gwadmin games [list|show|stop|replay|create ...]")
	}
}

func brainsCmd(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: gwadmin brains [list GAME|get GAME NAME|set GAME NAME FILE]")
	}
	switch args[0] {
	case "list":
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin brains list GAME")
		}
		return run("GET", "/admin/brains?game="+args[1], nil)
	case "get":
		if len(args) != 3 {
			return fmt.Errorf("usage: gwadmin brains get GAME NAME")
		}
		return run("GET", "/admin/brains/"+args[2]+"?game="+args[1], nil)
	case "set":
		if len(args) != 5 {
			return fmt.Errorf("usage: gwadmin brains set GAME NAME VERSION FILE")
		}
		b, err := os.ReadFile(args[4])
		if err != nil {
			return err
		}
		return run("PUT", "/admin/brains/"+args[2],
			map[string]any{"game": args[1], "name": args[2], "version": args[3], "script": string(b)})
	case "promote":
		if len(args) != 4 {
			return fmt.Errorf("usage: gwadmin brains promote GAME NAME VERSION")
		}
		return run("POST", "/admin/games/promote",
			map[string]any{"kind": "brain", "game": args[1], "name": args[2], "version": args[3]})
	default:
		return fmt.Errorf("unknown brains subcommand %q", args[0])
	}
}

func rulesCmd(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: gwadmin rules [list|get GAME|set GAME FILE|promote GAME VERSION]")
	}
	switch args[0] {
	case "list":
		return run("GET", "/admin/rules", nil)
	case "get":
		if len(args) != 2 {
			return fmt.Errorf("usage: gwadmin rules get GAME")
		}
		return run("GET", "/admin/rules/"+args[1], nil)
	case "set":
		if len(args) != 4 {
			return fmt.Errorf("usage: gwadmin rules set GAME VERSION FILE")
		}
		b, err := os.ReadFile(args[3])
		if err != nil {
			return err
		}
		return run("PUT", "/admin/rules/"+args[1],
			map[string]any{"game": args[1], "version": args[2], "script": string(b)})
	case "promote":
		if len(args) != 3 {
			return fmt.Errorf("usage: gwadmin rules promote GAME VERSION")
		}
		return run("POST", "/admin/games/promote",
			map[string]any{"kind": "rules", "game": args[1], "version": args[2]})
	default:
		return fmt.Errorf("unknown rules subcommand %q", args[0])
	}
}

func run(method, path string, body any) error {
	var out any
	if err := call(method, path, body, &out); err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func call(method, path string, body any, out *any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, strings.TrimSuffix(base, "/")+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("X-Admin-Token", token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("admin %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(b, out)
}

func snake(s string) string {
	s = strings.ReplaceAll(s, "-", "_")
	return strings.ToLower(s)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// defaultBase: GATEWAY_URL > -base > service env PORT > 8080
func defaultBase() string {
	if v := os.Getenv("GATEWAY_URL"); v != "" {
		return v
	}
	if port := serviceEnvValue("PORT"); port != "" {
		return "http://localhost:" + port
	}
	return "http://localhost:8080"
}

// defaultToken: ADMIN_TOKEN > -token > service env ADMIN_TOKEN
func defaultToken() string {
	if v := os.Getenv("ADMIN_TOKEN"); v != "" {
		return v
	}
	return serviceEnvValue("ADMIN_TOKEN")
}

func serviceEnvValue(key string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	b, err := os.ReadFile(home + "/.config/gateway/env")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == key {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func usage() {
	fmt.Fprintln(os.Stderr, `gwadmin - gateway admin CLI

  gwadmin config                          # full snapshot (secrets masked)
  gwadmin secrets                         # secret set/unset status
  gwadmin changes                         # audit log of admin changes
  gwadmin policies [get|set k=v ...]      # thresholds
  gwadmin jev set k=v ...                 # endpoint, model_pin, timeout_ms, retry_*
  gwadmin jev rotate-key NEW_KEY          # rotate Jev API key (live)
  gwadmin llm list                        # list providers
  gwadmin llm upsert [name=...] k=v ...   # name omitted = default provider
  gwadmin llm remove NAME
  gwadmin llm rotate-key NAME KEY
  gwadmin keys list                       # tenants (names + masked keys)
  gwadmin keys add NAME [KEY]             # add tenant (generates KEY if omitted, prints once)
  gwadmin keys revoke NAME
  gwadmin script get                      # active QuickJS orchestration flow
  gwadmin script set FILE                 # hot-swap the flow
  gwadmin games list|show|stop|replay     # matches (admin token)
  gwadmin games create GAME BRAIN [--headless] [tick_ms=.. max_ticks=.. seed=..]
  gwadmin brains list|get GAME ...        # brain scripts
  gwadmin brains set GAME NAME VERSION FILE
  gwadmin brains promote GAME NAME VERSION
  gwadmin rules list|get GAME ...         # rules packs
  gwadmin rules set GAME VERSION FILE
  gwadmin rules promote GAME VERSION
  gwadmin reload                          # reload config file from disk

Env: -base / GATEWAY_URL, -token / ADMIN_TOKEN (unset values fall back to
     ~/.config/gateway/env written by service.sh install)`)
	os.Exit(2)
}

func fatal(s string) {
	fmt.Fprintln(os.Stderr, "error:", s)
	os.Exit(1)
}
