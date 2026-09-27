// Scripted opponent brain: replays the demo arc (rush -> expand -> all-in)
// without calling Jev. Used for AI-vs-scripted validation games.

function decide(args) {
  var snapshot = args.snapshot, memory = args.memory;
  memory = memory || {};
  var t = snapshot.tick || 0;
  var route = t <= 6 ? "rush" : (t <= 15 ? "expand" : "rush");
  memory.last = route;
  return {
    commands: { strategy: route, build: route === "rush" ? ["marine", "marine"] : ["scv", "scv"] },
    memory: memory
  };
}
