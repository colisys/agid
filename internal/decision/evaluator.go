package decision

type Action string

const (
	ActionAllow   Action = "allow"
	ActionConfirm Action = "confirm"
	ActionHuman   Action = "human"
	ActionDeny    Action = "deny"
)

type Thresholds struct {
	IntentHumanBelow       float64
	LowRiskAllowAt         float64
	HighRiskAllowAbove     float64
	ComplexityHumanAbove   float64
	ComplexityHumanConfBel float64
	RiskBlockBelow         float64
	SeverityBlockAbove     float64
}

func DefaultThresholds() Thresholds {
	return Thresholds{
		IntentHumanBelow:       0.6,
		LowRiskAllowAt:         0.6,
		HighRiskAllowAbove:     0.85,
		ComplexityHumanAbove:   1.0,
		ComplexityHumanConfBel: 0.5,
		RiskBlockBelow:         0.5,
		SeverityBlockAbove:     1.5,
	}
}

type Verdict struct {
	Action     Action
	Route      string
	Confidence float64
	Reason     string
}

type GateInput struct {
	Route    string
	HighRisk bool
	Answers  Answers
}

func Gate(in GateInput, th Thresholds) Verdict {
	if intent, ok := in.Answers.Choice("intent"); ok {
		if intent.Confidence < th.IntentHumanBelow {
			return Verdict{Action: ActionHuman, Route: in.Route, Confidence: intent.Confidence, Reason: "intent confidence below floor"}
		}
		if c, ok := in.Answers.Score("complexity"); ok {
			if c.Score > th.ComplexityHumanAbove || c.Confidence < th.ComplexityHumanConfBel {
				return Verdict{Action: ActionHuman, Route: in.Route, Confidence: c.Confidence, Reason: "complexity too high or uncertain"}
			}
		}
	}
	for _, id := range []string{"is_safe", "is_compliant"} {
		if n, ok := in.Answers.Noul(id); ok && n.Noul < th.RiskBlockBelow {
			action := ActionHuman
			if in.HighRisk {
				action = ActionDeny
			}
			return Verdict{Action: action, Route: in.Route, Confidence: n.Noul, Reason: id + " failed"}
		}
	}
	if s, ok := in.Answers.Score("severity"); ok && s.Score > th.SeverityBlockAbove {
		action := ActionHuman
		if in.HighRisk {
			action = ActionDeny
		}
		return Verdict{Action: action, Route: in.Route, Confidence: s.Confidence, Reason: "severity too high"}
	}
	conf := 1.0
	route := in.Route
	if pick, ok := in.Answers.Choice("pick"); ok {
		conf = pick.Confidence
		if pick.Choice == "no_match" {
			return Verdict{Action: ActionHuman, Route: route, Confidence: conf, Reason: "no acceptable candidate"}
		}
		route = pick.Choice
	} else if intent, ok := in.Answers.Choice("intent"); ok {
		conf = intent.Confidence
		route = intent.Choice
		if route == "other" {
			return Verdict{Action: ActionHuman, Route: route, Confidence: conf, Reason: "no matching route"}
		}
	}
	if in.HighRisk {
		if conf > th.HighRiskAllowAbove {
			return Verdict{Action: ActionAllow, Route: route, Confidence: conf, Reason: "high-risk with high confidence"}
		}
		return Verdict{Action: ActionConfirm, Route: route, Confidence: conf, Reason: "high-risk needs confirmation"}
	}
	return Verdict{Action: ActionAllow, Route: route, Confidence: conf, Reason: "low-risk above floor"}
}

func CallConfidence(probs map[string]float64) float64 {
	min := 1.0
	for _, p := range probs {
		if p < min {
			min = p
		}
	}
	return min
}
