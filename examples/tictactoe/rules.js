// Tic-tac-toe rules pack.
//
// Required exports: newmatch(args), tick(args), snapshot(args), over(args).
// All functions take a single args object; see docs/game-server.md.
//
// State: { board: [0..8] ("" | "X" | "O"), turn: "X"|"O", tick: n, winner }
// Commands: { p0: {cell: 0..8}, p1: {cell: 0..8} } — only the side whose
// turn it is may move; the other side's command is ignored.

var LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

function newmatch(args) {
  return { state: { board: ["", "", "", "", "", "", "", "", ""], turn: "X", tick: 0, winner: null } };
}

function winnerOf(board) {
  for (var i = 0; i < LINES.length; i++) {
    var l = LINES[i];
    if (board[l[0]] !== "" && board[l[0]] === board[l[1]] && board[l[1]] === board[l[2]]) {
      return board[l[0]];
    }
  }
  return null;
}

function tick(args) {
  var state = JSON.parse(JSON.stringify(args.state));
  var commands = args.commands || {};
  var events = [];

  var mark = state.turn;
  var slot = mark === "X" ? "p0" : "p1";
  var move = commands[slot] || {};
  var cell = move.cell;

  // Seat has not acted yet: ask the engine to wait instead of ticking away.
  // (A human thinking for seconds would otherwise burn illegal ticks until
  // max_ticks.) Brains always send a command, so this only pauses humans.
  if (typeof cell !== "number") {
    return { wait: true, state: state, events: [] };
  }

  state.tick = (state.tick || 0) + 1;

  if (cell < 0 || cell > 8 || state.board[cell] !== "") {
    events.push({ type: "illegal", player: slot, cell: cell });
    return { state: state, events: events };
  }
  state.board[cell] = mark;
  events.push({ type: "move", player: slot, mark: mark, cell: cell });

  var w = winnerOf(state.board);
  if (w) {
    state.winner = w;
    events.push({ type: "win", winner: w });
  } else if (state.board.indexOf("") === -1) {
    state.winner = "draw";
    events.push({ type: "draw" });
  } else {
    state.turn = mark === "X" ? "O" : "X";
  }
  return { state: state, events: events };
}

function snapshot(args) {
  // v1: full information (no fog).
  return JSON.parse(JSON.stringify(args.state));
}

function over(args) {
  if (args.state.winner) {
    return { over: true, result: { winner: args.state.winner === "draw" ? "" : args.state.winner, reason: args.state.winner } };
  }
  return { over: null };
}
