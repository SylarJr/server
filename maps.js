const DEFAULT_MARKED_POSITIONS = [
  [0, 2],
  [1, 5],
  [3, 1],
  [3, 4],
  [5, 2],
  [6, 4],
];

const MAPS = [
  {
    name: 'Mapa inicial',
    marked: DEFAULT_MARKED_POSITIONS,
    cells: [
      ['yellow', 'green', 'blue', 'purple', 'purple', 'purple', 'yellow'],
      ['green', 'green', 'blue', 'blue', 'purple', 'purple', 'green'],
      ['green', 'red', 'red', 'blue', 'purple', 'green', 'green'],
      ['green', 'red', 'purple', 'yellow', 'green', 'green', 'green'],
      ['green', 'red', 'purple', 'purple', 'red', 'red', 'blue'],
      ['red', 'red', 'purple', 'red', 'red', 'blue', 'blue'],
      ['yellow', 'purple', 'purple', 'red', 'red', 'blue', 'yellow'],
    ],
  },
  {
    name: 'Mapa 1',
    marked: [[0, 4], [2, 0], [3, 2], [4, 5], [5, 1], [6, 4]],
    cells: [
      ['purple', 'purple', 'purple', 'white', 'green', 'green', 'green'],
      ['purple', 'yellow', 'blue', 'blue', 'blue', 'yellow', 'green'],
      ['purple', 'red', 'red', 'blue', 'blue', 'red', 'green'],
      ['red', 'red', 'red', 'yellow', 'red', 'red', 'red'],
      ['green', 'red', 'blue', 'blue', 'red', 'red', 'purple'],
      ['green', 'yellow', 'blue', 'blue', 'blue', 'yellow', 'purple'],
      ['green', 'green', 'green', 'white', 'purple', 'purple', 'purple'],
    ],
  },
  {
    name: 'Mapa 2',
    marked: [[1, 2], [1, 5], [3, 3], [4, 1], [4, 6], [6, 2]],
    cells: [
      ['yellow', 'yellow', 'purple', 'white', 'purple', 'yellow', 'yellow'],
      ['white', 'yellow', 'purple', 'purple', 'purple', 'yellow', 'white'],
      ['red', 'red', 'red', 'purple', 'red', 'red', 'red'],
      ['red', 'red', 'red', 'white', 'red', 'red', 'red'],
      ['green', 'blue', 'blue', 'blue', 'blue', 'blue', 'green'],
      ['green', 'green', 'green', 'green', 'green', 'green', 'green'],
      ['purple', 'purple', 'purple', 'white', 'purple', 'purple', 'purple'],
    ],
  },
  {
    name: 'Mapa 3',
    marked: [[0, 4], [2, 2], [2, 5], [3, 0], [5, 4], [6, 1]],
    cells: [
      ['orangeUpper', 'orangeUpper', 'orangeUpper', 'orangeUpper', 'orangeUpper', 'orangeUpper', 'orangeUpper'],
      ['yellow', 'red', 'blue', 'green', 'blue', 'red', 'yellow'],
      ['red', 'red', 'purple', 'purple', 'purple', 'red', 'red'],
      ['yellow', 'green', 'blue', 'purple', 'blue', 'green', 'yellow'],
      ['red', 'red', 'purple', 'purple', 'purple', 'red', 'red'],
      ['yellow', 'red', 'blue', 'green', 'blue', 'red', 'yellow'],
      ['orangeLower', 'orangeLower', 'orangeLower', 'orangeLower', 'orangeLower', 'orangeLower', 'orangeLower'],
    ],
  },
];

const POINTS_BY_TYPE = {
  blue: [7, 5, 3],
  red: [6, 4, 2],
  purple: [6, 4, 2],
  yellow: [8, 6, 4],
  green: [4, 3, 2],
  white: [8, 6, 4],
  orangeUpper: [6, 4, 3],
  orangeLower: [6, 4, 3],
};

module.exports = { DEFAULT_MARKED_POSITIONS, MAPS, POINTS_BY_TYPE };
