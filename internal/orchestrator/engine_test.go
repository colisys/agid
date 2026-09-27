package orchestrator

import (
	"context"
	"testing"

	"gateway/internal/decision"
	"gateway/internal/intent"
	"gateway/internal/jsflow"
	"gateway/internal/llm"
	"gateway/internal/tools"
)

type fakeLLM struct{}

func (fakeLLM) Name() string { return "fake" }

func (fakeLLM) Chat(ctx context.Context, req llm.ChatRequest) (llm.ChatResponse, error) {
	return llm.ChatResponse{Content: "ok", InputTokens: 5, OutputTokens: 3, Model: "fake"}, nil
}

func fakeLLMs() *llm.Registry {
	r := llm.NewRegistry("fake")
	r.Register(fakeLLM{})
	return r
}

// fakeDecide answers the intent selector with a fixed route/complexity.
func fakeDecide(route string, conf float64, complexity float64, cxConf float64) intent.Decider {
	return func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error) {
		return decision.SystemOneResult{
			Model: "jev-1.13.0",
			Answers: decision.Answers{
				"intent":     decision.MustRawForTest(decision.ChoiceAnswer{Type: "choice", Choice: route, Confidence: conf}),
				"complexity": decision.MustRawForTest(decision.ScoreAnswer{Type: "score", Score: complexity, Confidence: cxConf}),
			},
			Usage: decision.Usage{InputTokens: 100},
		}, nil
	}
}

func echoRegistry() *tools.Registry {
	reg := tools.NewRegistry()
	reg.Register(tools.NewFuncTool("echo", "echo", []tools.Param{
		{Name: "text", Shape: tools.ShapeFree, Description: "text"},
	}, func(ctx context.Context, args map[string]any) (any, error) {
		return map[string]any{"echo": args["text"]}, nil
	}))
	return reg
}

func TestExecuteIntentSelectsToolRoute(t *testing.T) {
	pool := jsflow.NewPool(1)
	defer pool.Close()
	e := NewEngine(pool, "", fakeDecide("tool:echo", 0.9, 0.2, 0.9),
		"jev-1.13.0", decision.DefaultThresholds(), nil, echoRegistry())

	res, err := e.Execute(context.Background(), ExecuteRequest{
		Goal:       "echo hi",
		Candidates: []Candidate{{ID: "c0", Args: map[string]any{"text": "hi"}}},
		Routes:     map[string]string{"tool:echo": "run the echo tool"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict.Action != decision.ActionAllow {
		t.Fatalf("want allow, got %s (%s)", res.Verdict.Action, res.Verdict.Reason)
	}
	if res.Verdict.Route != "tool:echo" {
		t.Fatalf("want route tool:echo, got %q", res.Verdict.Route)
	}
	m, ok := res.Output.(map[string]any)
	if !ok || m["echo"] != "hi" {
		t.Fatalf("want tool output echo=hi, got %#v", res.Output)
	}
	if res.TraceID == "" || res.JevModel != "jev-1.13.0" || res.JevTokens != 100 {
		t.Fatalf("missing trace/jev metadata: %+v", res)
	}
}

func TestGateUncertainIntentEscalates(t *testing.T) {
	pool := jsflow.NewPool(1)
	defer pool.Close()
	e := NewEngine(pool, "", fakeDecide("auto", 0.4, 0.1, 0.9),
		"jev-1.13.0", decision.DefaultThresholds(), fakeLLMs(), tools.NewRegistry())

	res, err := e.Execute(context.Background(), ExecuteRequest{
		Goal:   "something ambiguous",
		Routes: map[string]string{"auto": "standard handling"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict.Action != decision.ActionHuman {
		t.Fatalf("want human for low-confidence intent, got %s", res.Verdict.Action)
	}
}

func TestGateHighRiskNeedsConfirm(t *testing.T) {
	pool := jsflow.NewPool(1)
	defer pool.Close()
	e := NewEngine(pool, "", fakeDecide("auto", 0.7, 0.1, 0.9),
		"jev-1.13.0", decision.DefaultThresholds(), fakeLLMs(), tools.NewRegistry())

	res, err := e.Execute(context.Background(), ExecuteRequest{
		Goal:     "wire money",
		HighRisk: true,
		Routes:   map[string]string{"auto": "standard handling"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Verdict.Action != decision.ActionConfirm {
		t.Fatalf("want confirm for high-risk, got %s", res.Verdict.Action)
	}
}

func TestCustomScriptOwnsOrchestration(t *testing.T) {
	pool := jsflow.NewPool(1)
	defer pool.Close()
	script := `
function orchestrate(input) {
  var steps = [];
  var picked = host.intent({ user_input: input.user_input });
  steps.push({ kind: "intent", detail: picked.route });
  host.log("custom flow");
  return { route: picked.route, steps: steps, output: { custom: true } };
}`
	e := NewEngine(pool, script, fakeDecide("auto", 0.9, 0.1, 0.9),
		"jev-1.13.0", decision.DefaultThresholds(), nil, tools.NewRegistry())

	res, err := e.Execute(context.Background(), ExecuteRequest{
		Goal:   "x",
		Routes: map[string]string{"auto": "standard"},
	})
	if err != nil {
		t.Fatal(err)
	}
	m, _ := res.Output.(map[string]any)
	if m["custom"] != true {
		t.Fatalf("custom script output not honored: %#v", res.Output)
	}
	if len(res.Steps) == 0 || res.Steps[0].Kind != "intent" {
		t.Fatalf("want intent step from script, got %#v", res.Steps)
	}
}
