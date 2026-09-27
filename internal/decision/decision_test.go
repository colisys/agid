package decision

import "testing"

func TestGateLowRiskAllow(t *testing.T) {
	answers := Answers{
		"intent":     mustRaw(ChoiceAnswer{Type: "choice", Choice: "auto", Confidence: 0.9}),
		"complexity": mustRaw(ScoreAnswer{Type: "score", Score: 0.2, Confidence: 0.9}),
		"is_safe":    mustRaw(NoulAnswer{Type: "noul", Noul: 0.95}),
	}
	v := Gate(GateInput{Route: "auto", Answers: answers}, DefaultThresholds())
	if v.Action != ActionAllow {
		t.Fatalf("want allow, got %s (%s)", v.Action, v.Reason)
	}
}

func TestGateUncertainIntentToHuman(t *testing.T) {
	answers := Answers{
		"intent": mustRaw(ChoiceAnswer{Type: "choice", Choice: "auto", Confidence: 0.4}),
	}
	v := Gate(GateInput{Route: "auto", Answers: answers}, DefaultThresholds())
	if v.Action != ActionHuman {
		t.Fatalf("want human, got %s", v.Action)
	}
}

func TestGateHighRiskNeedsConfirm(t *testing.T) {
	answers := Answers{
		"intent":     mustRaw(ChoiceAnswer{Type: "choice", Choice: "auto", Confidence: 0.7}),
		"complexity": mustRaw(ScoreAnswer{Type: "score", Score: 0.3, Confidence: 0.9}),
		"is_safe":    mustRaw(NoulAnswer{Type: "noul", Noul: 0.9}),
	}
	v := Gate(GateInput{Route: "auto", HighRisk: true, Answers: answers}, DefaultThresholds())
	if v.Action != ActionConfirm {
		t.Fatalf("want confirm, got %s", v.Action)
	}
}

func TestGateRiskBlockDeniesHighRisk(t *testing.T) {
	answers := Answers{
		"intent":  mustRaw(ChoiceAnswer{Type: "choice", Choice: "auto", Confidence: 0.9}),
		"is_safe": mustRaw(NoulAnswer{Type: "noul", Noul: 0.2}),
	}
	v := Gate(GateInput{Route: "auto", HighRisk: true, Answers: answers}, DefaultThresholds())
	if v.Action != ActionDeny {
		t.Fatalf("want deny, got %s", v.Action)
	}
}

func TestPacksHaveFallback(t *testing.T) {
	p := RoutingPack(map[string]string{"a": "route A"})
	if _, ok := p["intent"].Criteria.(map[string]any)["other"]; !ok {
		t.Fatal("routing pack must include other fallback")
	}
	sp := SelectionPack(2)
	if _, ok := sp["pick"].Criteria.(map[string]any)["no_match"]; !ok {
		t.Fatal("selection pack must include no_match fallback")
	}
}

func TestRedactPII(t *testing.T) {
	in := "contact me at foo@bar.com with token abc, Bearer secret123"
	out := RedactPII(in)
	if out == in {
		t.Fatal("expected redaction")
	}
}
