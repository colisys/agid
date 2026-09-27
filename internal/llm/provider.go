package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
	Temperature float64   `json:"temperature,omitempty"`
}

type ChatResponse struct {
	Content      string
	InputTokens  int
	OutputTokens int
	Model        string
}

type Provider interface {
	Name() string
	Chat(ctx context.Context, req ChatRequest) (ChatResponse, error)
}

type OpenAICompat struct {
	mu       sync.RWMutex
	name     string
	endpoint string
	apiKey   string
	model    string
	http     *http.Client
}

func NewOpenAICompat(name, endpoint, apiKey, model string, timeout time.Duration) *OpenAICompat {
	return &OpenAICompat{name: name, endpoint: endpoint, apiKey: apiKey, model: model, http: &http.Client{Timeout: timeout}}
}

func (p *OpenAICompat) Name() string { return p.name }

type ProviderSettings struct {
	Endpoint  string
	Model     string
	APIKeySet bool
	TimeoutMs int
}

func (p *OpenAICompat) Snapshot() ProviderSettings {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return ProviderSettings{
		Endpoint:  p.endpoint,
		Model:     p.model,
		APIKeySet: p.apiKey != "",
		TimeoutMs: int(p.http.Timeout / time.Millisecond),
	}
}

func (p *OpenAICompat) Apply(endpoint, apiKey, model string, timeout time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if endpoint != "" {
		p.endpoint = endpoint
	}
	if apiKey != "" {
		p.apiKey = apiKey
	}
	if model != "" {
		p.model = model
	}
	if timeout > 0 {
		p.http.Timeout = timeout
	}
}

func (p *OpenAICompat) ClearModel() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.model = ""
}

type Upstream struct {
	Endpoint string
	APIKey   string
	Model    string
	Timeout  time.Duration
}

func (p *OpenAICompat) Upstream() Upstream {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return Upstream{Endpoint: p.endpoint, APIKey: p.apiKey, Model: p.model, Timeout: p.http.Timeout}
}

func (p *OpenAICompat) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	p.mu.RLock()
	model := req.Model
	if model == "" {
		model = p.model
	}
	endpoint, apiKey := p.endpoint, p.apiKey
	p.mu.RUnlock()
	// 上游对空模型名的处理是崩溃（曾表现为 502），所以在这里就地失败：
	// 没配 model 就不发请求，错误信息直接指到配置项。
	if model == "" {
		return ChatResponse{}, fmt.Errorf("llm %s: no model configured (set `model:` for this provider in llm_providers)", p.name)
	}
	// max_tokens 为 0 时整个字段省略——部分上游（如 new_api）会校验
	// "Max tokens must be greater than 0"，带上 0 反而被 400 拒绝。
	payload := map[string]any{
		"model":       model,
		"messages":    req.Messages,
		"temperature": req.Temperature,
	}
	if req.MaxTokens > 0 {
		payload["max_tokens"] = req.MaxTokens
	}
	body, _ := json.Marshal(payload)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return ChatResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := p.http.Do(httpReq)
	if err != nil {
		return ChatResponse{}, fmt.Errorf("llm %s: %w", p.name, err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return ChatResponse{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return ChatResponse{}, fmt.Errorf("llm %s: status %d: %s", p.name, resp.StatusCode, respBody)
	}
	var wire struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(respBody, &wire); err != nil {
		return ChatResponse{}, fmt.Errorf("llm %s decode: %w", p.name, err)
	}
	if len(wire.Choices) == 0 {
		return ChatResponse{}, fmt.Errorf("llm %s: empty choices", p.name)
	}
	return ChatResponse{
		Content:      wire.Choices[0].Message.Content,
		InputTokens:  wire.Usage.PromptTokens,
		OutputTokens: wire.Usage.CompletionTokens,
		Model:        wire.Model,
	}, nil
}

type Registry struct {
	mu        sync.RWMutex
	providers map[string]Provider
	def       string
}

func NewRegistry(def string) *Registry {
	return &Registry{providers: map[string]Provider{}, def: def}
}

func (r *Registry) Register(p Provider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers[p.Name()] = p
}

func (r *Registry) Remove(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.providers[name]; !ok {
		return false
	}
	delete(r.providers, name)
	return true
}

func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.providers))
	for n := range r.providers {
		out = append(out, n)
	}
	return out
}

func (r *Registry) SetDefault(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.providers[name]; !ok {
		return fmt.Errorf("llm: unknown provider %q", name)
	}
	r.def = name
	return nil
}

func (r *Registry) Get(name string) (Provider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if name == "" {
		name = r.def
	}
	p, ok := r.providers[name]
	if !ok {
		return nil, fmt.Errorf("llm: unknown provider %q", name)
	}
	return p, nil
}

func (r *Registry) Default() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.def
}

// modeler is implemented by providers that carry a configured model name.
type modeler interface{ Model() string }

// Model returns the model configured on this provider ("" = none).
func (p *OpenAICompat) Model() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.model
}

// DefaultModel returns the model configured on the default provider, "" when
// no default provider is set or it carries no model. Gateway LLM callers use
// this for the override policy: a configured default model wins over whatever
// the script asked for; an empty result means "forward the script's choice".
func (r *Registry) DefaultModel() string {
	name := r.Default()
	if name == "" {
		return ""
	}
	r.mu.RLock()
	p := r.providers[name]
	r.mu.RUnlock()
	if m, ok := p.(modeler); ok {
		return m.Model()
	}
	return ""
}
