package decision

import "fmt"

func RoutingPack(routes map[string]string) map[string]Question {
	criteria := map[string]any{}
	for name, desc := range routes {
		criteria[name] = desc
	}
	criteria["other"] = "None of the above fits"
	return map[string]Question{
		"intent": {
			Type:         QuestionChoice,
			Instructions: "The primary intent of this request; pick the handler that should own it",
			Criteria:     criteria,
		},
		"complexity": {
			Type:         QuestionScore,
			Instructions: "How complex is this request to resolve",
			Criteria: []any{
				"Simple lookup or standard procedure",
				"Requires some judgment or multi-step process",
				"Unusual situation, edge case, or escalation needed",
			},
		},
	}
}

func RiskPack(candidateRef string) map[string]Question {
	return map[string]Question{
		"is_safe": {
			Type:         QuestionNoul,
			Instructions: fmt.Sprintf("Is it safe to auto-execute %s given `policies`?", RefPath(candidateRef)),
		},
		"is_reversible": {
			Type:         QuestionNoul,
			Instructions: fmt.Sprintf("Can the effect of %s be fully reversed?", RefPath(candidateRef)),
		},
		"is_compliant": {
			Type:         QuestionNoul,
			Instructions: fmt.Sprintf("Does %s comply with `policies`?", RefPath(candidateRef)),
		},
		"severity": {
			Type:         QuestionScore,
			Instructions: "If this action is wrong, how bad is the consequence",
			Criteria: []any{
				"Harmless or trivially fixable",
				"Costly or hard to reverse",
				"Severe, regulated, or externally visible harm",
			},
		},
	}
}

func SelectionPack(n int) map[string]Question {
	criteria := map[string]any{}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("cand_%d", i)
		criteria[id] = fmt.Sprintf("Candidate %d as described in `candidates[%d]`", i, i)
	}
	criteria["no_match"] = "No candidate is acceptable"
	qs := map[string]Question{
		"pick": {
			Type:         QuestionChoice,
			Instructions: "Which candidate in `candidates` best achieves `goal` under `policies`",
			Criteria:     criteria,
		},
	}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("quality_%d", i)
		qs[id] = Question{
			Type:         QuestionScore,
			Instructions: fmt.Sprintf("How good is `candidates[%d]` for achieving `goal`", i),
			Criteria: []any{
				"Unacceptable or irrelevant",
				"Acceptable with caveats",
				"Strong fit",
			},
		}
	}
	return qs
}

func VerificationPack() map[string]Question {
	return map[string]Question{
		"citation": {
			Type:         QuestionChoice,
			Instructions: "Does the evidence in `context` support the claim in `output`",
			Criteria: map[string]any{
				"supported":    "Quoted context supports the claim",
				"contradicted": "Context contradicts the claim",
				"unrelated":    "No usable evidence in context",
			},
		},
		"is_hazardous": {
			Type:         QuestionNoul,
			Instructions: "Does this content contain a hazard that must block or escalate?",
		},
	}
}

func MergePacks(packs ...map[string]Question) map[string]Question {
	out := map[string]Question{}
	for _, p := range packs {
		for k, v := range p {
			out[k] = v
		}
	}
	return out
}
