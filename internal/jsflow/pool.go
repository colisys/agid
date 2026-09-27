// Package jsflow runs the orchestration layer in an embedded QuickJS engine.
// Jev only picks the intent; the JS script owns branching, tool calls, and
// result shaping. Each worker owns one QuickJS runtime on its own OS thread,
// since QuickJS is not thread-safe.
package jsflow

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"

	"github.com/buke/quickjs-go"
)

// Message is an LLM chat message passed to the host bridge.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Host is the set of capabilities a flow script may call. Each field may be
// nil; calling a nil capability from JS throws.
type Host struct {
	Intent func(state any) (any, error)
	// LLM 发起一次补全。provider/model 为空时由宿主侧裁决（网关默认模型
	// 优先；没配默认模型则转发脚本指定的 provider/model，再退到 provider 自身配置）。
	LLM  func(provider, model string, messages []Message) (string, error)
	Tool func(name string, args map[string]any) (any, error)
	// SVC calls a pack-declared backend service (see game.Manifest.Services):
	// blocking JSON POST, same risk class as LLM — keep calls off the hot path.
	SVC func(name, path string, body any) (any, error)
	Log func(msg string)
}

// Step is one recorded orchestration step.
type Step struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// Result is what a flow script returns: the chosen route, the steps it took,
// and the output payload.
type Result struct {
	Route  string `json:"route"`
	Steps  []Step `json:"steps"`
	Output any    `json:"output"`
}

type job struct {
	script  string
	entry   string
	host    Host
	input   any
	rawJSON bool
	out     chan jobResult
}

type jobResult struct {
	res Result
	err error
}

// Pool is a fixed set of QuickJS workers.
type Pool struct {
	jobs   chan *job
	quit   chan struct{}
	wg     sync.WaitGroup
	size   int
	closed sync.Once
}

// ErrPoolClosed is returned to a caller whose job raced with Pool.Close.
var ErrPoolClosed = errors.New("jsflow: pool closed")

// NewPool starts size workers (min 1).
func NewPool(size int) *Pool {
	if size < 1 {
		size = 1
	}
	p := &Pool{jobs: make(chan *job), quit: make(chan struct{}), size: size}
	for i := 0; i < size; i++ {
		p.wg.Add(1)
		go p.worker()
	}
	return p
}

// Size reports the worker count.
func (p *Pool) Size() int { return p.size }

// Close stops all workers and waits for them to finish. Workers are released
// through a quit channel rather than by closing the job queue: a playing
// match can be mid-call when the gateway shuts down, and closing a channel
// that a sender is parked on turns that send into a panic. Parked callers
// instead get ErrPoolClosed.
func (p *Pool) Close() {
	p.closed.Do(func() { close(p.quit) })
	p.wg.Wait()
}

// Run evaluates script and calls its orchestrate(input) entry point.
func (p *Pool) Run(ctx context.Context, script string, host Host, input any) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	j := &job{script: script, entry: "orchestrate", host: host, input: input, out: make(chan jobResult, 1)}
	select {
	case p.jobs <- j:
	case <-p.quit:
		return Result{}, ErrPoolClosed
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
	select {
	case r := <-j.out:
		return r.res, r.err
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

// CallJSON evaluates script, calls entry(parsedArg), and returns the raw
// JSON-encoded return value. Used by the game server for rules and brains.
func (p *Pool) CallJSON(ctx context.Context, script, entry string, arg any, host Host) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	j := &job{script: script, entry: entry, host: host, input: arg, rawJSON: true, out: make(chan jobResult, 1)}
	select {
	case p.jobs <- j:
	case <-p.quit:
		return "", ErrPoolClosed
	case <-ctx.Done():
		return "", ctx.Err()
	}
	select {
	case r := <-j.out:
		if r.err != nil {
			return "", r.err
		}
		s, _ := r.res.Output.(string)
		return s, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (p *Pool) worker() {
	defer p.wg.Done()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// NOTE: no WithExecuteTimeout here. quickjs-go implements it as an
	// absolute deadline from runtime creation (start=time(NULL) once), so
	// on a long-lived pooled worker it would kill EVERY script 30s after
	// gateway start. Bounds come from callers (MaxTicks/replay caps,
	// request contexts).
	rt := quickjs.NewRuntime(
		quickjs.WithMemoryLimit(256*1024*1024),
		quickjs.WithMaxStackSize(1<<20),
	)
	defer rt.Close()
	ctx := rt.NewContext()
	defer ctx.Close()

	for {
		select {
		case <-p.quit:
			return
		case j := <-p.jobs:
			res, err := runJob(ctx, j)
			// Buffered: never blocks even if the caller has already gone away.
			j.out <- jobResult{res: res, err: err}
		}
	}
}

func runJob(ctx *quickjs.Context, j *job) (res Result, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("jsflow: panic: %v", r)
		}
	}()

	if err := bindHost(ctx, j.host); err != nil {
		return Result{}, err
	}

	if v := ctx.Eval(j.script); v.IsException() {
		e := ctx.Exception()
		v.Free()
		return Result{}, fmt.Errorf("jsflow: script error: %w", e)
	} else {
		v.Free()
	}

	fn := ctx.Globals().Get(j.entry)
	defer fn.Free()
	if fn.IsUndefined() || fn.IsNull() {
		return Result{}, fmt.Errorf("jsflow: script must define %s(input)", j.entry)
	}

	in, err := ctx.Marshal(j.input)
	if err != nil {
		return Result{}, fmt.Errorf("jsflow: marshal input: %w", err)
	}
	defer in.Free()

	ret := fn.Execute(ctx.Globals(), in)
	defer ret.Free()
	if ret.IsException() {
		return Result{}, fmt.Errorf("jsflow: %s failed: %w", j.entry, ctx.Exception())
	}

	if j.rawJSON {
		// Return the raw JSON encoding for generic entry points.
		return Result{Output: ret.JSONStringify()}, nil
	}

	var raw map[string]any
	if err := ctx.Unmarshal(ret, &raw); err != nil {
		return Result{}, fmt.Errorf("jsflow: unmarshal result: %w", err)
	}
	out := Result{}
	if v, ok := raw["route"].(string); ok {
		out.Route = v
	}
	out.Output = raw["output"]
	if steps, ok := raw["steps"].([]any); ok {
		for _, s := range steps {
			if m, ok := s.(map[string]any); ok {
				st := Step{}
				if k, ok := m["kind"].(string); ok {
					st.Kind = k
				}
				if d, ok := m["detail"].(string); ok {
					st.Detail = d
				}
				out.Steps = append(out.Steps, st)
			}
		}
	}
	return out, nil
}

func bindHost(ctx *quickjs.Context, h Host) error {
	// Value.Set consumes the value's reference, so the object and the function
	// values handed to it must NOT be freed afterwards.
	obj := ctx.NewObject()

	obj.Set("intent", ctx.NewFunction(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if h.Intent == nil {
			return c.ThrowError(fmt.Errorf("host.intent not available"))
		}
		var state any
		if len(args) > 0 {
			if err := c.Unmarshal(args[0], &state); err != nil {
				return c.ThrowError(fmt.Errorf("host.intent: bad state: %w", err))
			}
		}
		v, err := h.Intent(state)
		if err != nil {
			return c.ThrowError(err)
		}
		jv, err := c.Marshal(v)
		if err != nil {
			return c.ThrowError(fmt.Errorf("host.intent: marshal: %w", err))
		}
		return jv
	}))

	obj.Set("llm", ctx.NewFunction(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if h.LLM == nil {
			return c.ThrowError(fmt.Errorf("host.llm not available"))
		}
		provider := ""
		if len(args) > 0 {
			provider = args[0].ToString()
		}
		var msgs []Message
		if len(args) > 1 {
			if err := c.Unmarshal(args[1], &msgs); err != nil {
				return c.ThrowError(fmt.Errorf("host.llm: bad messages: %w", err))
			}
		}
		model := ""
		if len(args) > 2 {
			model = args[2].ToString()
		}
		out, err := h.LLM(provider, model, msgs)
		if err != nil {
			return c.ThrowError(err)
		}
		return c.NewString(out)
	}))

	obj.Set("tool", ctx.NewFunction(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if h.Tool == nil {
			return c.ThrowError(fmt.Errorf("host.tool not available"))
		}
		name := ""
		if len(args) > 0 {
			name = args[0].ToString()
		}
		params := map[string]any{}
		if len(args) > 1 {
			if err := c.Unmarshal(args[1], &params); err != nil {
				return c.ThrowError(fmt.Errorf("host.tool: bad args: %w", err))
			}
		}
		out, err := h.Tool(name, params)
		if err != nil {
			return c.ThrowError(err)
		}
		jv, err := c.Marshal(out)
		if err != nil {
			return c.ThrowError(fmt.Errorf("host.tool: marshal: %w", err))
		}
		return jv
	}))

	obj.Set("svc", ctx.NewFunction(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if h.SVC == nil {
			return c.ThrowError(fmt.Errorf("host.svc not available"))
		}
		name := ""
		if len(args) > 0 {
			name = args[0].ToString()
		}
		path := ""
		if len(args) > 1 {
			path = args[1].ToString()
		}
		var body any
		if len(args) > 2 {
			if err := c.Unmarshal(args[2], &body); err != nil {
				return c.ThrowError(fmt.Errorf("host.svc: bad body: %w", err))
			}
		}
		out, err := h.SVC(name, path, body)
		if err != nil {
			return c.ThrowError(err)
		}
		jv, err := c.Marshal(out)
		if err != nil {
			return c.ThrowError(fmt.Errorf("host.svc: marshal: %w", err))
		}
		return jv
	}))

	obj.Set("log", ctx.NewFunction(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if h.Log != nil && len(args) > 0 {
			h.Log(args[0].ToString())
		}
		return c.NewUndefined()
	}))

	ctx.Globals().Set("host", obj)
	return nil
}
