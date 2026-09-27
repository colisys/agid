package decision

import "encoding/json"

func MustRawForTest(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
