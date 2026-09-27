package tools

import (
	"context"
	"fmt"
	"sort"
	"sync"
)

type ParamShape string

const (
	ShapeChoice ParamShape = "choice"
	ShapeSet    ParamShape = "set"
	ShapeFlag   ParamShape = "flag"
	ShapeFree   ParamShape = "free"
)

type Param struct {
	Name        string
	Shape       ParamShape
	Options     []string
	Description string
	Default     any
}

type Tool interface {
	Name() string
	Description() string
	Params() []Param
	Run(ctx context.Context, args map[string]any) (any, error)
}

type Registry struct {
	mu    sync.RWMutex
	tools map[string]Tool
}

func NewRegistry() *Registry { return &Registry{tools: map[string]Tool{}} }

func (r *Registry) Register(t Tool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tools[t.Name()] = t
}

func (r *Registry) Get(name string) (Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.tools))
	for n := range r.tools {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func ToolChoiceCriteria(r *Registry, descs map[string]string) map[string]any {
	criteria := map[string]any{}
	for _, name := range r.Names() {
		d := descs[name]
		if t, ok := r.Get(name); ok && d == "" {
			d = t.Description()
		}
		criteria[name] = d
	}
	return criteria
}

func FillDefaults(t Tool, args map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range args {
		out[k] = v
	}
	for _, p := range t.Params() {
		if _, ok := out[p.Name]; !ok && p.Default != nil {
			out[p.Name] = p.Default
		}
	}
	return out
}

type FuncTool struct {
	name   string
	desc   string
	params []Param
	fn     func(ctx context.Context, args map[string]any) (any, error)
}

func NewFuncTool(name, desc string, params []Param, fn func(ctx context.Context, args map[string]any) (any, error)) *FuncTool {
	return &FuncTool{name: name, desc: desc, params: params, fn: fn}
}

func (t *FuncTool) Name() string        { return t.name }
func (t *FuncTool) Description() string { return t.desc }
func (t *FuncTool) Params() []Param     { return t.params }

func (t *FuncTool) Run(ctx context.Context, args map[string]any) (any, error) {
	for _, p := range t.params {
		v, ok := args[p.Name]
		if !ok {
			continue
		}
		switch p.Shape {
		case ShapeChoice:
			s, ok := v.(string)
			if !ok {
				return nil, fmt.Errorf("tool %s: param %s must be string", t.name, p.Name)
			}
			valid := false
			for _, o := range p.Options {
				if o == s {
					valid = true
					break
				}
			}
			if !valid {
				return nil, fmt.Errorf("tool %s: param %s=%q not in %v", t.name, p.Name, s, p.Options)
			}
		case ShapeSet:
			arr, ok := v.([]any)
			if !ok {
				return nil, fmt.Errorf("tool %s: param %s must be array", t.name, p.Name)
			}
			for _, item := range arr {
				s, ok := item.(string)
				if !ok {
					return nil, fmt.Errorf("tool %s: param %s items must be strings", t.name, p.Name)
				}
				valid := false
				for _, o := range p.Options {
					if o == s {
						valid = true
						break
					}
				}
				if !valid {
					return nil, fmt.Errorf("tool %s: param %s item %q not in %v", t.name, p.Name, s, p.Options)
				}
			}
		}
	}
	return t.fn(ctx, FillDefaults(t, args))
}
