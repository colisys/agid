package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"gateway/internal/admin"
	"gateway/internal/api"
	"gateway/internal/config"
	"gateway/internal/decision"
	"gateway/internal/game"
	"gateway/internal/intent"
	"gateway/internal/jsflow"
	"gateway/internal/llm"
	"gateway/internal/observability"
	"gateway/internal/orchestrator"
	"gateway/internal/services"
	"gateway/internal/tools"
)

func main() {
	cfgPath := flag.String("config", "configs/gateway.yaml", "path to gateway config")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	jevClient := decision.NewClient(
		cfg.Jev.Endpoint,
		cfg.JevAPIKey(),
		cfg.JevTimeout(),
		decision.RetryPolicy{
			MaxAttempts:     cfg.Jev.Retry.MaxAttempts,
			BaseBackoff:     time.Duration(cfg.Jev.Retry.BaseBackoffMs) * time.Millisecond,
			HonorRetryAfter: cfg.Jev.Retry.HonorRetryAfter,
		},
	)
	decide := func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error) {
		if req.Model == "" {
			req.Model = cfg.Jev.ModelPin
		}
		return jevClient.Evaluate(ctx, req)
	}

	llms := llm.NewRegistry(cfg.LLMProviders.Default)
	for _, p := range cfg.LLMProviders.Providers {
		timeout := 60 * time.Second
		if p.TimeoutMs > 0 {
			timeout = time.Duration(p.TimeoutMs) * time.Millisecond
		}
		llms.Register(llm.NewOpenAICompat(p.Name, p.Endpoint, cfg.ProviderKey(p), p.Model, timeout))
	}

	toolsReg := tools.NewRegistry()
	toolsReg.Register(tools.NewFuncTool("echo", "Echo back the input text", []tools.Param{
		{Name: "text", Shape: tools.ShapeFree, Description: "Text to echo back"},
	}, func(ctx context.Context, args map[string]any) (any, error) {
		return map[string]any{"echo": args["text"]}, nil
	}))

	th := decision.DefaultThresholds()
	if cfg.Thresholds.IntentHumanBelow > 0 {
		th.IntentHumanBelow = cfg.Thresholds.IntentHumanBelow
	}
	if cfg.Thresholds.HighRiskAllowAbove > 0 {
		th.HighRiskAllowAbove = cfg.Thresholds.HighRiskAllowAbove
	}
	if cfg.Thresholds.ComplexityHumanAbove > 0 {
		th.ComplexityHumanAbove = cfg.Thresholds.ComplexityHumanAbove
	}
	if cfg.Thresholds.ComplexityHumanConfB > 0 {
		th.ComplexityHumanConfBel = cfg.Thresholds.ComplexityHumanConfB
	}

	script, err := cfg.FlowScript()
	if err != nil {
		log.Fatalf("load flow script: %v", err)
	}
	pool := jsflow.NewPool(cfg.JSFlow.PoolSize)
	defer pool.Close()

	engine := orchestrator.NewEngine(pool, script, decide, cfg.Jev.ModelPin, th, llms, toolsReg)
	metrics := observability.NewMetrics()

	store := admin.NewStore(cfg, *cfgPath, os.Getenv("ADMIN_TOKEN"), jevClient, engine, llms)
	if key := cfg.JevAPIKey(); key != "" {
		if err := store.RotateJevKey(key); err != nil {
			log.Fatalf("seed jev key: %v", err)
		}
	}
	for _, p := range cfg.LLMProviders.Providers {
		if key := cfg.ProviderKey(p); key != "" {
			_ = store.SetProviderKey(p.Name, key)
		}
	}
	srv := api.NewServerWithAdmin(cfg, store, store, engine, llms, metrics, decide, cfg.Jev.ModelPin)

	// Authoritative game server wiring (plan 4.1-4.3).
	listenAddr := cfg.Server.Listen
	if v := os.Getenv("PORT"); v != "" {
		// Override the port only; keep the configured host so a
		// loopback-only bind (127.0.0.1) is never widened to all
		// interfaces by the PORT env var.
		host, _, err := net.SplitHostPort(cfg.Server.Listen)
		if err != nil {
			host = ""
		}
		listenAddr = net.JoinHostPort(host, v)
	}
	var gameStore *game.DiskStore
	if roots := cfg.GameRoots(); len(roots) > 0 {
		gameStore = game.NewDiskStore(roots, 5)
		store.SetGameStore(gameStore)

		// Managed pack services (manifest "services"): spawn + supervise.
		// The ref list is the same one POST /admin/compose renders, so the
		// local processes and the generated container config cannot drift.
		sup := services.New(log.Printf)
		refs := store.ServiceRefs()
		// Tell each service where the gateway is, so the match bridge needs
		// no per-pack configuration to post commands back.
		gwURL := gatewayBaseURL(listenAddr)
		for i := range refs {
			refs[i].GatewayURL = gwURL
		}
		// Mint the per-service gateway token for packs that declared
		// gateway_access (e.g. create a match on a player's behalf). This is
		// what lets a browser start a game without an operator credential:
		// the browser asks the service, the service calls the gateway.
		svcTokens := api.NewServiceTokens(refs)
		for i := range refs {
			refs[i].GatewayToken = svcTokens.TokenFor(refs[i].Game, refs[i].Name)
		}
		if len(refs) > 0 {
			sup.StartAll(refs)
			srv.WithServices(sup)
			defer sup.StopAll()
		}
		hosts := func(matchID, gname, player string) jsflow.Host {
			return jsflow.Host{
				Intent: func(state any) (any, error) {
					// Brain scripts pass {goal, user_input, context, routes}.
					// Routes may be a list of names or a name->desc map.
					routes := map[string]string{}
					if st, ok := state.(map[string]any); ok {
						switch r := st["routes"].(type) {
						case []any:
							for _, n := range r {
								if s, ok := n.(string); ok {
									routes[s] = s
								}
							}
						case map[string]any:
							for k, v := range r {
								if s, ok := v.(string); ok {
									routes[k] = s
								} else {
									routes[k] = k
								}
							}
						}
					}
					if len(routes) == 0 {
						routes = map[string]string{"noop": "noop"}
					}
					res, err := intent.Select(context.Background(), decide, cfg.Jev.ModelPin, state, routes)
					if err != nil {
						return nil, err
					}
					return map[string]any{
						"route": res.Route, "confidence": res.Confidence,
						"probabilities": res.Probabilities,
					}, nil
				},
				LLM: func(provider, model string, messages []jsflow.Message) (string, error) {
					// 模型裁决：网关配了默认模型 → 一切以网关为准（覆盖脑席
					// 指定的 provider/model）；没配 → 转发脚本指定的 provider/model，
					// 都为空时由 provider 自身配置兜底。
					if dm := llms.DefaultModel(); dm != "" {
						provider, model = "", dm
					}
					p, err := llms.Get(provider)
					if err != nil {
						return "", err
					}
					msgs := make([]llm.Message, 0, len(messages))
					for _, m := range messages {
						msgs = append(msgs, llm.Message{Role: m.Role, Content: m.Content})
					}
					resp, err := p.Chat(context.Background(), llm.ChatRequest{Model: model, Messages: msgs})
					if err != nil {
						return "", err
					}
					return resp.Content, nil
				},
				SVC: func(name, path string, body any) (any, error) {
					return sup.Call(gname, name, path, body)
				},
				Log: func(msg string) { log.Printf("game %s [%s] %s", matchID, player, msg) },
			}
		}
		webhook := func(url string, event map[string]any) {
			body, _ := json.Marshal(event)
			req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			if cfg.Games.WebhookSecret != "" {
				mac := hmac.New(sha256.New, []byte(cfg.Games.WebhookSecret))
				mac.Write(body)
				req.Header.Set("X-Game-Signature", hex.EncodeToString(mac.Sum(nil)))
			}
			client := &http.Client{Timeout: 5 * time.Second}
			for i := range 3 {
				resp, err := client.Do(req)
				if err == nil {
					resp.Body.Close()
					if resp.StatusCode < 500 {
						return
					}
				}
				time.Sleep(time.Duration(100*(1<<i)) * time.Millisecond)
			}
			log.Printf("game webhook failed: %s", url)
		}
		mgr := game.NewManager(gameStore, pool, hosts, webhook, cfg.Games.MaxMatches, cfg.Games.ReplayCap)
		// Match bridge: after every real tick the gateway pushes the state to
		// the services whose manifest asked to observe, and hands them a
		// per-match token they post back on. This is what lets a backend act
		// on a live game directly instead of relaying through a brain seat.
		mgr.SetBridge(game.BridgeConfig{GatewayURL: gatewayBaseURL(listenAddr)})
		if len(refs) > 0 {
			mgr.SetObserver(func(gname, service, matchID, token string, payload map[string]any) {
				if err := sup.Push(gname, service, game.ObservePath, payload, 0); err != nil {
					log.Printf("game %s: observe -> %s/%s: %v", matchID, gname, service, err)
				}
			})
		}
		srv.WithGames(api.NewGames(mgr, srv.AdminGuard).
			WithTokenCheck(srv.CheckAdminToken).
			WithServiceTokens(svcTokens))
	}

	log.Printf("gateway listening on %s (jev model %s)", listenAddr, cfg.Jev.ModelPin)
	if err := http.ListenAndServe(listenAddr, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}

// gatewayBaseURL is how a managed service reaches this gateway. Services are
// spawned on the same host, so the listen address is the address to use; a
// wildcard bind is rewritten to loopback, which is the only host a
// same-host child can rely on.
func gatewayBaseURL(listenAddr string) string {
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return "http://" + listenAddr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}
