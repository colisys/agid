package decision

func ToAnyMap(in map[string]any) map[string]any { return in }

func StrMapToAny(in map[string]string) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
