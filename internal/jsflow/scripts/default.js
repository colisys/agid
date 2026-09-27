// Default orchestration flow.
//
// Contract: define orchestrate(input) and return { route, steps, output }.
// input = { goal, user_input, context, routes, candidates, high_risk }
// host  = { intent(state), llm(provider, messages), tool(name, args), log(msg) }
//
// Jev picks the route; this script owns the branching, tool calls, and output
// shaping. Keep all policy thresholds in Go, not here.

function orchestrate(input) {
  var steps = [];
  var routes = input.routes || {};

  // 1. Ask Jev which handler should own this request.
  var state = {
    goal: input.goal,
    user_input: input.user_input,
    context: input.context || {},
    routes: Object.keys(routes),
  };
  var picked = host.intent(state);
  steps.push({ kind: "intent", detail: picked.route + " (" + picked.confidence.toFixed(2) + ")" });

  var route = picked.route;

  // 2. Branch. A route named "tool:<name>" runs that tool; anything else asks
  //    the orchestrator LLM. Add your own routes here.
  var output;
  if (route.indexOf("tool:") === 0) {
    var toolName = route.slice(5);
    var args = (input.candidates && input.candidates[0] && input.candidates[0].args) || {};
    output = host.tool(toolName, args);
    steps.push({ kind: "tool", detail: toolName });
  } else {
    var prompt = "Goal: " + input.goal + "\nInput: " + (input.user_input || "");
    if (input.context) {
      prompt += "\nContext: " + JSON.stringify(input.context);
    }
    var text = host.llm("", [{ role: "user", content: prompt }]);
    output = { text: text };
    steps.push({ kind: "llm", detail: "orchestrator completion" });
  }

  return {
    route: route,
    steps: steps,
    output: output,
  };
}
