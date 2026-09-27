package decision

import (
	"encoding/json"
	"regexp"
	"strings"
)

type StateBudget struct {
	StatePlusLongestQuestion int
	TotalPerRequest          int
}

func DefaultStateBudget() StateBudget {
	return StateBudget{StatePlusLongestQuestion: 32768, TotalPerRequest: 65536}
}

var redactPatterns = []*regexp.Regexp{
	regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`),
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*`),
	regexp.MustCompile(`(?i)(api[_-]?key|token|secret)\s*[:=]\s*[^\s,}"]+`),
	regexp.MustCompile(`1[3-9]\d{9}`),
}

func RedactPII(s string) string {
	for _, re := range redactPatterns {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	return s
}

func BuildState(goal, userInput string, candidates []any, policies, history any, locale string) map[string]any {
	if locale == "" {
		locale = "en"
	}
	return map[string]any{
		"goal":       RedactPII(goal),
		"user_input": RedactPII(userInput),
		"candidates": candidates,
		"policies":   policies,
		"history":    history,
		"locale":     locale,
	}
}

func EstimateTokens(v any) int {
	b, _ := json.Marshal(v)
	return len(b) / 4
}

func FitBudget(state map[string]any, questions map[string]Question, budget StateBudget) (map[string]any, bool) {
	longest := 0
	total := EstimateTokens(state)
	for _, q := range questions {
		n := EstimateTokens(q)
		total += n
		if n > longest {
			longest = n
		}
	}
	stateTokens := EstimateTokens(state)
	if stateTokens+longest <= budget.StatePlusLongestQuestion && total <= budget.TotalPerRequest {
		return state, false
	}
	out := map[string]any{}
	for k, v := range state {
		out[k] = v
	}
	truncated := false
	for _, key := range []string{"history", "candidates", "policies"} {
		v, ok := out[key]
		if !ok {
			continue
		}
		b, _ := json.Marshal(v)
		if len(b) > 8000 {
			var arr []any
			if err := json.Unmarshal(b, &arr); err == nil && len(arr) > 1 {
				half := arr[len(arr)/2:]
				out[key] = half
			} else {
				s := string(b)
				out[key] = s[:8000] + "…[truncated]"
			}
			truncated = true
		}
		stateTokens = EstimateTokens(out)
		if stateTokens+longest <= budget.StatePlusLongestQuestion && EstimateTokens(out)+total-EstimateTokens(state) <= budget.TotalPerRequest {
			break
		}
	}
	out["_truncated"] = true
	return out, truncated || true
}

func RefPath(path string) string {
	if strings.HasPrefix(path, "`") {
		return path
	}
	return "`" + path + "`"
}
