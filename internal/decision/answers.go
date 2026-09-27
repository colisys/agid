package decision

import "encoding/json"

type Answers map[string]json.RawMessage

func (a Answers) choice(id string) (ChoiceAnswer, bool) {
	raw, ok := a[id]
	if !ok {
		return ChoiceAnswer{}, false
	}
	var ans ChoiceAnswer
	if err := json.Unmarshal(raw, &ans); err != nil || ans.Type != "choice" {
		return ChoiceAnswer{}, false
	}
	return ans, true
}

func (a Answers) score(id string) (ScoreAnswer, bool) {
	raw, ok := a[id]
	if !ok {
		return ScoreAnswer{}, false
	}
	var ans ScoreAnswer
	if err := json.Unmarshal(raw, &ans); err != nil || ans.Type != "score" {
		return ScoreAnswer{}, false
	}
	return ans, true
}

func (a Answers) noul(id string) (NoulAnswer, bool) {
	raw, ok := a[id]
	if !ok {
		return NoulAnswer{}, false
	}
	var ans NoulAnswer
	if err := json.Unmarshal(raw, &ans); err != nil || ans.Type != "noul" {
		return NoulAnswer{}, false
	}
	return ans, true
}

func (a Answers) Choice(id string) (ChoiceAnswer, bool) { return a.choice(id) }
func (a Answers) Score(id string) (ScoreAnswer, bool)   { return a.score(id) }
func (a Answers) Noul(id string) (NoulAnswer, bool)     { return a.noul(id) }

func mustRaw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
