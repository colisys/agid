// Blocker brain: win if possible, else block the opponent's winning line,
// else take center, else corner, else first empty.
// Shows Jev-free tactical play; a Jev variant can pick among these postures.

var LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

function decide(args) {
  var board = args.snapshot.board;
  var me = args.snapshot.turn;
  var foe = me === "X" ? "O" : "X";

  function winning(mark) {
    for (var i = 0; i < LINES.length; i++) {
      var l = LINES[i];
      var marks = [board[l[0]], board[l[1]], board[l[2]]];
      var mine = marks.filter(function (m) { return m === mark; }).length;
      var empty = marks.filter(function (m) { return m === ""; }).length;
      if (mine === 2 && empty === 1) {
        for (var j = 0; j < 3; j++) {
          if (board[l[j]] === "") return l[j];
        }
      }
    }
    return -1;
  }

  var cell = winning(me);
  if (cell === -1) cell = winning(foe);
  if (cell === -1 && board[4] === "") cell = 4;
  if (cell === -1) {
    var corners = [0, 2, 6, 8];
    for (var k = 0; k < corners.length; k++) {
      if (board[corners[k]] === "") { cell = corners[k]; break; }
    }
  }
  if (cell === -1) {
    for (var i = 0; i < 9; i++) {
      if (board[i] === "") { cell = i; break; }
    }
  }
  return { commands: { cell: cell }, memory: { last: cell } };
}
