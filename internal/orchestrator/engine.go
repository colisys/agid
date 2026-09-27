package orchestrator

import (
	"context"
	"fmt"
	"sync"

	"gateway/internal/decision"
	"gateway/internal/intent"
	"gateway/internal/jsflow"
	"gateway/internal/llm"
	"gateway/internal/tools"
)

type Budget struct {
	MaxJevTokens int
	MaxLLMCost   float64
}

type ExecuteRequest struct {
	Goal        string
	Context     map[string]any
	Candidates  []Candidate
	PolicySet   string
	HighRisk    bool
	Routes      map[string]string
	ToolName    string
	Budget      Budget
	LLMProvider string
}

// Candidate is a pre-computed plan the caller may supply.
type Candidate struct {
	ID            string         `json:"id"`
	Plan          string         `json:"plan"`
	Args          map[string]any `json:"args,omitempty"`
	PredictedCost float64        `json:"predicted_cost,omitempty"`
}

type StepRecord = jsflow.Step

type ExecuteResult struct {
	Verdict    decision.Verdict `json:"verdict"`
	Steps      []StepRecord     `json:"steps"`
	Output     any              `json:"output,omitempty"`
	TraceID    string           `json:"trace_id"`
	JevModel   string           `json:"jev_model"`
	JevTokens  int              `json:"jev_input_tokens"`
	LLMTokens  int              `json:"llm_tokens"`
	NeedsInput string           `json:"needs_input,omitempty"`
}

// Engine runs Jev-as-intent-selector plus a QuickJS orchestration script.
// Jev picks the route; the JS script owns branching, tool calls, and output
// shaping; Go owns the safety gate.
type Engine struct {
	mu         sync.RWMutex
	pool       *jsflow.Pool
	script     string
	decide     intent.Decider
	model      string
	thresholds decision.Thresholds
	llms       *llm.Registry
	tools      *tools.Registry
}

func NewEngine(
	pool *jsflow.Pool,
	script string,
	decide intent.Decider,
	model string,
	th decision.Thresholds,
	llms *llm.Registry,
	toolsReg *tools.Registry,
) *Engine {
	if script == "" {
		script = jsflow.DefaultScript()
	}
	return &Engine{
		pool: pool, script: script, decide: decide, model: model,
		thresholds: th, llms: llms, tools: toolsReg,
	}
}

func (e *Engine) Thresholds() decision.Thresholds {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.thresholds
}

func (e *Engine) Model() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.model
}

func (e *Engine) SetThresholds(th decision.Thresholds) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.thresholds = th
}

func (e *Engine) SetModel(model string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if model != "" {
		e.model = model
	}
}

// Script returns the active orchestration flow.
func (e *Engine) Script() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.script
}

// SetScript hot-swaps the orchestration flow.
func (e *Engine) SetScript(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if s != "" {
		e.script = s
	}
}

func (e *Engine) Execute(ctx context.Context, req ExecuteRequest) (ExecuteResult, error) {
	traceID := newTraceID()

	e.mu.RLock()
	th, model, script := e.thresholds, e.model, e.script
	e.mu.RUnlock()

	routes := req.Routes
	if len(routes) == 0 {
		routes = map[string]string{"auto": "Standard handling, deterministic code can execute"}
	}

	var (
		picked  *intent.Result
		llmToks int
		lastMdl string
	)

	host := jsflow.Host{
		Intent: func(state any) (any, error) {
			res, err := intent.Select(ctx, e.decide, model, state, routes)
			if err != nil {
				return nil, err
			}
			picked = &res
			lastMdl = res.Model
			return map[string]any{
				"route":                 res.Route,
				"confidence":            res.Confidence,
				"probabilities":         res.Probabilities,
				"complexity":            res.Complexity,
				"complexity_confidence": res.ComplexityConf,
			}, nil
		},
		LLM: func(provider, model string, messages []jsflow.Message) (string, error) {
			if e.llms == nil {
				return "", fmt.Errorf("no llm providers configured")
			}
			// 模型裁决与游戏脑席一致：网关默认模型优先，否则转发脚本指定。
			if dm := e.llms.DefaultModel(); dm != "" {
				provider, model = "", dm
			}
			if provider == "" {
				provider = req.LLMProvider
			}
			p, err := e.llms.Get(provider)
			if err != nil {
				return "", err
			}
			msgs := make([]llm.Message, 0, len(messages))
			for _, m := range messages {
				msgs = append(msgs, llm.Message{Role: m.Role, Content: m.Content})
			}
			resp, err := p.Chat(ctx, llm.ChatRequest{Model: model, Messages: msgs})
			if err != nil {
				return "", err
			}
			llmToks += resp.InputTokens + resp.OutputTokens
			return resp.Content, nil
		},
		Tool: func(name string, args map[string]any) (any, error) {
			if e.tools == nil {
				return nil, fmt.Errorf("no tools registered")
			}
			t, ok := e.tools.Get(name)
			if !ok {
				return nil, fmt.Errorf("unknown tool %q", name)
			}
			return t.Run(ctx, args)
		},
	}

	// Pass candidates as plain maps so JS sees the json field names
	// (quickjs Marshal otherwise falls back to Go field names).
	candAny := make([]any, 0, len(req.Candidates))
	for _, c := range req.Candidates {
		candAny = append(candAny, map[string]any{"id": c.ID, "plan": c.Plan, "args": c.Args})
	}

	input := map[string]any{
		"goal":         req.Goal,
		"user_input":   firstString(req.Context),
		"context":      req.Context,
		"routes":       routes,
		"candidates":   candAny,
		"high_risk":    req.HighRisk,
		"tool":         req.ToolName,
		"llm_provider": req.LLMProvider,
		"policy_set":   req.PolicySet,
	}

	flow, err := e.pool.Run(ctx, script, host, input)
	if err != nil {
		return ExecuteResult{}, err
	}

	out := ExecuteResult{
		TraceID:   traceID,
		Steps:     flow.Steps,
		Output:    flow.Output,
		LLMTokens: llmToks,
		JevModel:  lastMdl,
	}
	if picked != nil {
		out.JevTokens = picked.InputTokens
	}

	route := flow.Route
	if route == "" && picked != nil {
		route = picked.Route
	}

	if picked == nil {
		// The script never consulted Jev; refuse to act without an intent.
		out.Verdict = decision.Verdict{Action: decision.ActionHuman, Route: route, Reason: "no intent selected"}
		return out, nil
	}

	out.Verdict = gateIntent(*picked, route, req.HighRisk, th)
	switch out.Verdict.Action {
	case decision.ActionDeny:
		out.Steps = append(out.Steps, StepRecord{Kind: "deny", Detail: out.Verdict.Reason})
	case decision.ActionHuman:
		out.Steps = append(out.Steps, StepRecord{Kind: "escalate", Detail: out.Verdict.Reason})
	case decision.ActionConfirm:
		out.NeedsInput = "confirmation required: " + out.Verdict.Reason
		out.Steps = append(out.Steps, StepRecord{Kind: "await_confirm", Detail: out.Verdict.Reason})
	}
	return out, nil
}

// gateIntent is the code-owned safety gate over Jev's intent answer. The flow
// script decides what to do; this decides whether it is allowed to stand.
func gateIntent(res intent.Result, route string, highRisk bool, th decision.Thresholds) decision.Verdict {
	if res.Confidence < th.IntentHumanBelow {
		return decision.Verdict{Action: decision.ActionHuman, Route: route, Confidence: res.Confidence, Reason: "intent confidence below floor"}
	}
	if res.Complexity > th.ComplexityHumanAbove || res.ComplexityConf < th.ComplexityHumanConfBel {
		return decision.Verdict{Action: decision.ActionHuman, Route: route, Confidence: res.ComplexityConf, Reason: "complexity too high or uncertain"}
	}
	if route == "other" {
		return decision.Verdict{Action: decision.ActionHuman, Route: route, Confidence: res.Confidence, Reason: "no matching route"}
	}
	if highRisk {
		if res.Confidence > th.HighRiskAllowAbove {
			return decision.Verdict{Action: decision.ActionAllow, Route: route, Confidence: res.Confidence, Reason: "high-risk with high confidence"}
		}
		return decision.Verdict{Action: decision.ActionConfirm, Route: route, Confidence: res.Confidence, Reason: "high-risk needs confirmation"}
	}
	return decision.Verdict{Action: decision.ActionAllow, Route: route, Confidence: res.Confidence, Reason: "low-risk above floor"}
}

func firstString(m map[string]any) string {
	if m == nil {
		return ""
	}
	if v, ok := m["user_input"].(string); ok {
		return v
	}
	return ""
}
