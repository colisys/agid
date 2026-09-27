// Package intent narrows Jev to a single job: picking which handler should
// own an incoming request. Everything else (branching, tool calls, verification)
// is orchestration and lives in the JS flow layer.
package intent

import (
	"context"

	"gateway/internal/decision"
)

// Result is one intent decision.
type Result struct {
	Route          string             `json:"route"`
	Confidence     float64            `json:"confidence"`
	Probabilities  map[string]float64 `json:"probabilities"`
	Complexity     float64            `json:"complexity"`
	ComplexityConf float64            `json:"complexity_confidence"`
	Model          string             `json:"model"`
	InputTokens    int                `json:"input_tokens"`
}

// Decider is the Jev call surface the selector depends on.
type Decider func(ctx context.Context, req decision.SystemOneRequest) (decision.SystemOneResult, error)

// Pack builds the intent-selection questions: one Choice over routes (with an
// `other` fallback) plus one complexity Score. Nothing else — the selector
// must not become a general decision pack again.
func Pack(routes map[string]string) map[string]decision.Question {
	criteria := map[string]any{}
	for name, desc := range routes {
		criteria[name] = desc
	}
	criteria["other"] = "None of the above fits"
	return map[string]decision.Question{
		"intent": {
			Type:         decision.QuestionChoice,
			Instructions: "Which handler should own this request? Pick the single best route for `user_input` given `context`.",
			Criteria:     criteria,
		},
		"complexity": {
			Type:         decision.QuestionScore,
			Instructions: "How complex is this request to resolve",
			Criteria: []any{
				"Simple lookup or standard procedure",
				"Requires some judgment or multi-step process",
				"Unusual situation, edge case, or escalation needed",
			},
		},
	}
}

// Select asks Jev for the route. It is a pure selector: no gating, no side
// effects, no second request. Callers decide what to do with the answer.
func Select(ctx context.Context, decide Decider, model string, state any, routes map[string]string) (Result, error) {
	res, err := decide(ctx, decision.SystemOneRequest{
		State:     state,
		Model:     model,
		Questions: Pack(routes),
	})
	if err != nil {
		return Result{}, err
	}
	out := Result{Model: res.Model, InputTokens: res.Usage.InputTokens}
	if c, ok := res.Answers.Choice("intent"); ok {
		out.Route = c.Choice
		out.Confidence = c.Confidence
		out.Probabilities = c.Probabilities
	}
	if s, ok := res.Answers.Score("complexity"); ok {
		out.Complexity = s.Score
		out.ComplexityConf = s.Confidence
	}
	return out, nil
}
