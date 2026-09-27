package observability

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

type AuditEntry struct {
	Time       time.Time `json:"time"`
	TraceID    string    `json:"trace_id"`
	Tenant     string    `json:"tenant,omitempty"`
	Action     string    `json:"action"`
	Route      string    `json:"route"`
	Confidence float64   `json:"confidence"`
	JevModel   string    `json:"jev_model"`
	JevTokens  int       `json:"jev_tokens"`
	LLMTokens  int       `json:"llm_tokens"`
	Reason     string    `json:"reason"`
}

type Metrics struct {
	mu         sync.Mutex
	decisions  int
	byAction   map[string]int
	proxied    int
	byProvider map[string]int
	jevTokens  int
	llmTokens  int
	confSum    float64
	confN      int
	audit      []AuditEntry
}

func NewMetrics() *Metrics {
	return &Metrics{byAction: map[string]int{}, byProvider: map[string]int{}}
}

func (m *Metrics) Record(e AuditEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.decisions++
	m.byAction[e.Action]++
	m.jevTokens += e.JevTokens
	m.llmTokens += e.LLMTokens
	m.confSum += e.Confidence
	m.confN++
	m.audit = append(m.audit, e)
	if len(m.audit) > 1000 {
		m.audit = m.audit[len(m.audit)-1000:]
	}
	log.Printf("audit trace=%s tenant=%s action=%s route=%s conf=%.2f jev=%s jev_tok=%d llm_tok=%d reason=%s",
		e.TraceID, e.Tenant, e.Action, e.Route, e.Confidence, e.JevModel, e.JevTokens, e.LLMTokens, e.Reason)
}

func (m *Metrics) RecordProxy(tenant, provider, method, path string, status int, bytes int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.proxied++
	m.byProvider[provider]++
	m.audit = append(m.audit, AuditEntry{
		Time:    time.Now(),
		TraceID: "px_" + strings.ReplaceAll(newID(), "-", ""),
		Tenant:  tenant,
		Action:  "proxy",
		Route:   provider + " " + method + " " + path,
		Reason:  fmt.Sprintf("status=%d bytes=%d", status, bytes),
	})
	if len(m.audit) > 1000 {
		m.audit = m.audit[len(m.audit)-1000:]
	}
	log.Printf("proxy tenant=%s provider=%s %s %s status=%d bytes=%d",
		tenant, provider, method, path, status, bytes)
}

func newID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func (m *Metrics) Snapshot() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	avg := 0.0
	if m.confN > 0 {
		avg = m.confSum / float64(m.confN)
	}
	return map[string]any{
		"decisions":      m.decisions,
		"by_action":      m.byAction,
		"proxied":        m.proxied,
		"by_provider":    m.byProvider,
		"jev_tokens":     m.jevTokens,
		"llm_tokens":     m.llmTokens,
		"avg_confidence": avg,
	}
}

func (m *Metrics) RecentAudit(n int) []AuditEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n > len(m.audit) {
		n = len(m.audit)
	}
	out := make([]AuditEntry, n)
	copy(out, m.audit[len(m.audit)-n:])
	return out
}
