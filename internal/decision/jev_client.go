package decision

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"sync"
	"time"
)

var (
	ErrUnauthorized = errors.New("jev: unauthorized, check TYPESAFE_API_KEY")
	ErrInvalid      = errors.New("jev: request rejected")
	ErrOverloaded   = errors.New("jev: overloaded after retries")
)

type RetryPolicy struct {
	MaxAttempts     int
	BaseBackoff     time.Duration
	HonorRetryAfter bool
}

func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{MaxAttempts: 4, BaseBackoff: 300 * time.Millisecond, HonorRetryAfter: true}
}

type Client struct {
	mu         sync.RWMutex
	endpoint   string
	apiKey     string
	http       *http.Client
	retry      RetryPolicy
	jitterRand *rand.Rand
}

func NewClient(endpoint, apiKey string, timeout time.Duration, retry RetryPolicy) *Client {
	return &Client{
		endpoint:   endpoint,
		apiKey:     apiKey,
		http:       &http.Client{Timeout: timeout},
		retry:      retry,
		jitterRand: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

type invalidError struct {
	msg string
}

func (e *invalidError) Error() string { return "jev: invalid request: " + e.msg }

func (c *Client) Evaluate(ctx context.Context, req SystemOneRequest) (SystemOneResult, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return SystemOneResult{}, err
	}
	var lastErr error
	for attempt := 1; attempt <= c.retry.MaxAttempts; attempt++ {
		res, retryable, err := c.do(ctx, body)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if !retryable || attempt == c.retry.MaxAttempts {
			return SystemOneResult{}, err
		}
		select {
		case <-ctx.Done():
			return SystemOneResult{}, ctx.Err()
		case <-time.After(c.backoff(attempt, nil)):
		}
	}
	return SystemOneResult{}, lastErr
}

func (c *Client) do(ctx context.Context, body []byte) (SystemOneResult, bool, error) {
	c.mu.RLock()
	endpoint, apiKey := c.endpoint, c.apiKey
	c.mu.RUnlock()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return SystemOneResult{}, false, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return SystemOneResult{}, true, fmt.Errorf("jev: transport: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return SystemOneResult{}, true, fmt.Errorf("jev: read: %w", err)
	}
	switch resp.StatusCode {
	case http.StatusOK:
		var wire struct {
			Model   string  `json:"model"`
			Answers Answers `json:"answers"`
			Usage   Usage   `json:"usage"`
		}
		if err := json.Unmarshal(respBody, &wire); err != nil {
			return SystemOneResult{}, false, fmt.Errorf("jev: decode: %w", err)
		}
		return SystemOneResult{Model: wire.Model, Answers: wire.Answers, Usage: wire.Usage}, false, nil
	case http.StatusUnauthorized:
		return SystemOneResult{}, false, ErrUnauthorized
	case http.StatusUnprocessableEntity:
		return SystemOneResult{}, false, &invalidError{msg: string(respBody)}
	case http.StatusTooManyRequests, 529:
		return SystemOneResult{}, true, fmt.Errorf("%w: status %d", ErrOverloaded, resp.StatusCode)
	default:
		if resp.StatusCode >= 500 {
			return SystemOneResult{}, true, fmt.Errorf("jev: status %d: %s", resp.StatusCode, respBody)
		}
		return SystemOneResult{}, false, fmt.Errorf("jev: status %d: %s", resp.StatusCode, respBody)
	}
}

func (c *Client) backoff(attempt int, resp *http.Response) time.Duration {
	d := float64(c.retry.BaseBackoff) * math.Pow(2, float64(attempt-1))
	if c.retry.HonorRetryAfter && resp != nil {
		if v := resp.Header.Get("Retry-After"); v != "" {
			if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
				ra := time.Duration(secs) * time.Second
				if ra > time.Duration(d) {
					return ra
				}
			}
		}
	}
	jitter := d * 0.2 * c.jitterRand.Float64()
	return time.Duration(d + jitter)
}

type RuntimeSettings struct {
	Endpoint  string
	APIKeySet bool
	TimeoutMs int
	Retry     RetryPolicy
}

func (c *Client) Snapshot() RuntimeSettings {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return RuntimeSettings{
		Endpoint:  c.endpoint,
		APIKeySet: c.apiKey != "",
		TimeoutMs: int(c.http.Timeout / time.Millisecond),
		Retry:     c.retry,
	}
}

func (c *Client) Apply(endpoint, apiKey string, timeout time.Duration, retry RetryPolicy) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if endpoint != "" {
		c.endpoint = endpoint
	}
	if apiKey != "" {
		c.apiKey = apiKey
	}
	if timeout > 0 {
		c.http.Timeout = timeout
	}
	c.retry = retry
}
