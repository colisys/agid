// Random brain: picks the first empty cell. Baseline for validation.
// Contract: decide(args) -> {commands, memory}, args={snapshot, memory}.

function decide(args) {
  var board = args.snapshot.board;
  var cell = -1;
  for (var i = 0; i < 9; i++) {
    if (board[i] === "") { cell = i; break; }
  }
  return { commands: { cell: cell }, memory: {} };
}
