const { randomInt, randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { DEFAULT_MARKED_POSITIONS, MAPS, POINTS_BY_TYPE } = require('./maps');

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 24;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_CACHED_RESPONSES = 500;
const BOARD_SIZE = 7;

class RequestError extends Error {}

function randomDice() {
  return [randomInt(1, 7), randomInt(1, 7)];
}

function coordinateKey(row, column) {
  return `${row},${column}`;
}

function fromCoordinateKey(key) {
  return key.split(',').map(Number);
}

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

class BrillantServer {
  constructor({ host = '0.0.0.0', port = 3000, diceRoller = randomDice } = {}) {
    this.diceRoller = diceRoller;
    this.rooms = new Map();
    this.connections = new Map();
    this.wss = new WebSocket.Server({ host, port, maxPayload: MAX_MESSAGE_BYTES });
    this.ready = new Promise((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.wss.on('error', (error) => console.error('WebSocket server error:', error));
  }

  address() {
    return this.wss.address();
  }

  async close() {
    for (const socket of this.connections.keys()) {
      socket.close(1001, 'Server shutting down');
    }
    if (!this.wss.address()) return;
    await new Promise((resolve, reject) => {
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
  }

  onConnection(socket) {
    const state = { roomCode: null, playerId: null, responses: new Map() };
    this.connections.set(socket, state);
    socket.on('message', (message) => this.onMessage(socket, state, message));
    socket.on('close', () => this.onDisconnect(socket, state));
    socket.on('error', (error) => console.error('WebSocket client error:', error));
  }

  onMessage(socket, state, rawMessage) {
    const text = rawMessage.toString();
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'Message too large');
      return;
    }

    let request;
    try {
      request = JSON.parse(text);
    } catch {
      this.sendResponse(socket, '', false, undefined, 'El mensaje debe ser JSON válido.');
      return;
    }

    const requestId = typeof request?.requestId === 'string'
      ? request.requestId
      : '';
    if (!requestId || requestId.length > MAX_REQUEST_ID_LENGTH) {
      this.sendResponse(socket, requestId, false, undefined, 'requestId es obligatorio y no debe exceder 128 caracteres.');
      return;
    }

    if (state.responses.has(requestId)) {
      socket.send(state.responses.get(requestId));
      return;
    }

    let result;
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new RequestError('La solicitud debe ser un objeto JSON.');
      }
      if (typeof request.type !== 'string') {
        throw new RequestError('type es obligatorio.');
      }
      const payload = request.payload === undefined ? {} : request.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new RequestError('payload debe ser un objeto JSON.');
      }
      result = this.dispatch(socket, state, request.type, payload);
    } catch (error) {
      if (!(error instanceof RequestError)) {
        console.error('Unexpected request handling error:', error);
      }
      result = { error: error instanceof RequestError ? error.message : 'Error interno del servidor.' };
    }

    const response = result.error
      ? { type: 'response', requestId, ok: false, error: result.error }
      : { type: 'response', requestId, ok: true, data: result.data };
    const serialized = JSON.stringify(response);
    state.responses.set(requestId, serialized);
    if (state.responses.size > MAX_CACHED_RESPONSES) {
      state.responses.delete(state.responses.keys().next().value);
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(serialized);
    for (const event of result.events || []) {
      this.emit(event.sockets, event.type, event.data);
    }
  }

  dispatch(socket, state, type, payload) {
    switch (type) {
      case 'create_room':
        return this.createRoom(socket, state, payload);
      case 'join_room':
        return this.joinRoom(socket, state, payload);
      case 'set_ready':
        return this.setReady(socket, state, payload);
      case 'leave_room':
        return this.leaveRoom(socket, state);
      case 'submit_initial_board':
        return this.submitInitialBoard(socket, state, payload);
      case 'place_number':
        return this.placeNumber(socket, state, payload);
      case 'skip_turn':
        return this.skipTurn(socket, state);
      default:
        throw new RequestError(`Tipo de solicitud desconocido: ${type}.`);
    }
  }

  createRoom(socket, state, payload) {
    this.assertNotInRoom(state);
    if (!isIntegerInRange(payload.mapId, 0, MAPS.length - 1)) {
      throw new RequestError('mapId debe ser un índice entre 0 y 3.');
    }
    const name = this.validatePlayerName(payload.playerName);
    const code = this.generateRoomCode();
    const player = this.newPlayer(name, socket, payload.mapId);
    const room = {
      code,
      mapId: payload.mapId,
      gameStarted: false,
      gameOver: false,
      phase: 'lobby',
      dice: null,
      pendingMoves: new Map(),
      gamePlayerIds: new Set(),
      players: new Map([[player.id, player]]),
      scores: new Map([[player.id, { playerId: player.id, playerName: name, total: 0 }]]),
      zones: buildScoringZones(MAPS[payload.mapId]),
      zoneWinners: [],
    };
    this.rooms.set(code, room);
    state.roomCode = code;
    state.playerId = player.id;
    return { data: this.roomData(room, player) };
  }

  joinRoom(socket, state, payload) {
    this.assertNotInRoom(state);
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
    if (!code) throw new RequestError('code es obligatorio.');
    const room = this.rooms.get(code);
    if (!room) throw new RequestError('No existe una sala con ese código.');
    if (room.gameStarted) throw new RequestError('La partida ya comenzó; no se aceptan más jugadores.');
    if (room.phase !== 'lobby') throw new RequestError('La sala ya pasó a la preparación del tablero.');
    const name = this.validatePlayerName(payload.playerName);
    const player = this.newPlayer(name, socket, room.mapId);
    room.players.set(player.id, player);
    room.scores.set(player.id, { playerId: player.id, playerName: name, total: 0 });
    state.roomCode = code;
    state.playerId = player.id;
    return {
      data: this.roomData(room, player),
      events: this.roomStateEvents(room),
    };
  }

  setReady(socket, state, payload) {
    const { room, player } = this.requirePlayer(state);
    if (typeof payload.ready !== 'boolean') {
      throw new RequestError('ready debe ser un valor booleano.');
    }
    if (room.phase !== 'lobby') throw new RequestError('El lobby ya terminó.');
    player.ready = payload.ready;
    if (room.players.size >= 2 &&
        [...room.players.values()].every((roomPlayer) => roomPlayer.ready)) {
      room.phase = 'initial_board';
    }
    return {
      data: { ready: player.ready, gameStarted: room.gameStarted, phase: room.phase },
      events: this.roomStateEvents(room),
    };
  }

  leaveRoom(socket, state) {
    const { room, player } = this.requirePlayer(state);
    room.players.delete(player.id);
    room.gamePlayerIds.delete(player.id);
    room.pendingMoves.delete(player.id);
    state.roomCode = null;
    state.playerId = null;
    this.resetLobbyIfUnderpopulated(room);
    const events = [];
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
    } else {
      events.push(...this.roomStateEvents(room), this.scoreEvent(room));
      if (this.allPlayersConfirmed(room)) this.completeRound(room, events);
    }
    return { data: { left: true }, events };
  }

  submitInitialBoard(socket, state, payload) {
    const { room, player } = this.requirePlayer(state);
    if (room.gameStarted) throw new RequestError('La partida ya comenzó.');
    if (room.phase !== 'initial_board') {
      throw new RequestError('Todos los jugadores deben estar listos en el lobby antes de preparar el tablero.');
    }
    if (player.submitted) throw new RequestError('El tablero inicial ya fue enviado.');
    if (payload.ready !== true) throw new RequestError('ready debe ser true para confirmar el tablero inicial.');
    const assignments = this.validateInitialAssignments(MAPS[room.mapId], payload.assignments);
    player.board = assignments;
    player.submitted = true;

    let events;
    if (this.canStartGame(room)) {
      room.gameStarted = true;
      room.phase = 'game';
      room.gamePlayerIds = new Set([...room.players.keys()]);
      for (const readyPlayer of room.players.values()) readyPlayer.ready = false;
      for (const readyPlayer of room.players.values()) {
        this.awardCompletedZones(room, readyPlayer);
      }
      const recipients = [...room.players.values()].map((roomPlayer) => roomPlayer.socket);
      events = [
        ...this.roomStateEvents(room),
        ...[...room.players.values()].map((roomPlayer) => ({
          sockets: recipients,
          type: 'board_state',
          data: this.boardData(room, roomPlayer),
        })),
        this.scoreEvent(room),
      ];
      for (const readyPlayer of room.players.values()) {
        events.push({
          sockets: [readyPlayer.socket],
          type: 'game_started',
          data: this.roomData(room, readyPlayer),
        });
      }
      this.rollForRoom(room, events);
    } else {
      events = [
        ...this.roomStateEvents(room),
        {
          sockets: [player.socket],
          type: 'board_state',
          data: this.boardData(room, player),
        },
      ];
    }
    return { data: { assignments: this.serializeBoard(player.board) }, events };
  }

  placeNumber(socket, state, payload) {
    const { room, player } = this.requirePlayer(state);
    this.assertActivePlayer(room, player);
    if (player.finished) throw new RequestError('Tu tablero ya está completo.');
    if (!player.submitted) throw new RequestError('Envía primero el tablero inicial.');
    if (payload.ready !== true) throw new RequestError('ready debe ser true para confirmar la jugada.');
    if (room.pendingMoves.has(player.id)) {
      throw new RequestError('Ya confirmaste tu jugada para esta ronda.');
    }
    if (!room.dice) throw new RequestError('No hay una tirada vigente.');
    const { row, column, number } = payload;
    if (!isIntegerInRange(row, 0, BOARD_SIZE - 1) ||
        !isIntegerInRange(column, 0, BOARD_SIZE - 1)) {
      throw new RequestError('row y column deben estar entre 0 y 6.');
    }
    if (!isIntegerInRange(number, 1, 6)) {
      throw new RequestError('number debe ser un entero entre 1 y 6.');
    }
    if (!room.dice.includes(number)) {
      throw new RequestError(
        `number (${number}) no coincide con los dados vigentes [${room.dice.join(', ')}].`,
      );
    }

    const key = coordinateKey(row, column);
    if (player.board.has(key)) throw new RequestError('La casilla ya está ocupada.');
    if (!isAdjacentToComplement(player, room.dice, row, column, number)) {
      const requiredNeighbor = complementaryDiceValue(room.dice, number);
      const neighbors = [
        [row - 1, column],
        [row + 1, column],
        [row, column - 1],
        [row, column + 1],
      ]
        .filter(([neighborRow, neighborColumn]) =>
          neighborRow >= 0 && neighborRow < BOARD_SIZE &&
          neighborColumn >= 0 && neighborColumn < BOARD_SIZE)
        .map(([neighborRow, neighborColumn]) =>
          `${neighborRow},${neighborColumn}:${player.board.get(coordinateKey(neighborRow, neighborColumn)) ?? '-'}`);
      throw new RequestError(
        `La casilla (${row},${column}) con number ${number} requiere un vecino ortogonal con ${requiredNeighbor}; ` +
        `dados vigentes [${room.dice.join(', ')}], vecinos actuales [${neighbors.join(', ')}].`,
      );
    }
    const nextBoard = new Map(player.board);
    nextBoard.set(key, number);
    if (!validateBoardRules(MAPS[room.mapId], nextBoard)) {
      throw new RequestError('El número incumple las reglas de la zona.');
    }

    room.pendingMoves.set(player.id, { row, column, number });
    const events = this.roomStateEvents(room);
    const roundCompleted = this.allPlayersConfirmed(room);
    if (roundCompleted) this.completeRound(room, events);
    return {
      data: {
        placed: true,
        pending: !roundCompleted,
        assignments: this.serializeBoard(player.board),
      },
      events,
    };
  }

  skipTurn(socket, state) {
    const { room, player } = this.requirePlayer(state);
    this.assertActivePlayer(room, player);
    if (player.finished) throw new RequestError('Tu tablero ya está completo.');
    if (!player.submitted) throw new RequestError('Envía primero el tablero inicial.');
    if (room.pendingMoves.has(player.id)) {
      throw new RequestError('Ya confirmaste tu jugada para esta ronda.');
    }
    if (!room.dice) throw new RequestError('No hay una tirada vigente.');
    room.pendingMoves.set(player.id, { skip: true });
    const events = this.roomStateEvents(room);
    const roundCompleted = this.allPlayersConfirmed(room);
    if (roundCompleted) this.completeRound(room, events);
    return { data: { skipped: true, pending: !roundCompleted }, events };
  }

  onDisconnect(socket, state) {
    this.connections.delete(socket);
    if (!state.roomCode) return;
    const room = this.rooms.get(state.roomCode);
    if (!room) return;
    const player = room.players.get(state.playerId);
    if (!player) return;
    room.players.delete(player.id);
    room.gamePlayerIds.delete(player.id);
    room.pendingMoves.delete(player.id);
    this.resetLobbyIfUnderpopulated(room);
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
    } else {
      this.broadcastRoomState(room);
      this.broadcastScore(room);
      const events = [];
      if (this.allPlayersConfirmed(room)) this.completeRound(room, events);
      this.appendGameOverIfComplete(room, events);
      for (const event of events) this.emit(event.sockets, event.type, event.data);
    }
  }

  validateInitialAssignments(map, entries) {
    if (!Array.isArray(entries) || entries.length !== map.marked.length) {
      throw new RequestError('assignments debe contener exactamente las seis casillas marcadas.');
    }
    const marked = new Set(map.marked.map(([row, column]) => coordinateKey(row, column)));
    const assignments = new Map();
    const values = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !isIntegerInRange(entry.row, 0, BOARD_SIZE - 1) ||
          !isIntegerInRange(entry.column, 0, BOARD_SIZE - 1) ||
          !isIntegerInRange(entry.value, 1, 6)) {
        throw new RequestError('Cada asignación debe tener row, column entre 0 y 6 y value entre 1 y 6.');
      }
      const key = coordinateKey(entry.row, entry.column);
      if (!marked.has(key)) throw new RequestError('Solo se pueden preparar las seis casillas marcadas del tablero.');
      if (assignments.has(key)) throw new RequestError('No se permiten posiciones repetidas.');
      if (values.has(entry.value)) throw new RequestError('Los valores iniciales deben ser los números del 1 al 6 sin repetir.');
      assignments.set(key, entry.value);
      values.add(entry.value);
    }
    if ([1, 2, 3, 4, 5, 6].some((value) => !values.has(value)) ||
        !validateBoardRules(map, assignments)) {
      throw new RequestError('El tablero inicial incumple las reglas de sus zonas.');
    }
    return assignments;
  }

  validatePlayerName(value) {
    if (typeof value !== 'string') throw new RequestError('playerName es obligatorio.');
    const name = value.trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new RequestError(`El nombre debe tener entre 1 y ${MAX_NAME_LENGTH} caracteres.`);
    }
    return name;
  }

  newPlayer(name, socket, mapId) {
    return {
      id: randomUUID(),
      name,
      ready: false,
      socket,
      mapId,
      board: new Map(),
      submitted: false,
      finished: false,
    };
  }

  generateRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  assertNotInRoom(state) {
    if (state.roomCode) throw new RequestError('Esta conexión ya pertenece a una sala.');
  }

  requirePlayer(state) {
    const room = this.rooms.get(state.roomCode);
    const player = room?.players.get(state.playerId);
    if (!room || !player) throw new RequestError('Debes estar conectado a una sala para realizar esta acción.');
    return { room, player };
  }

  assertActivePlayer(room, player) {
    if (!room.gameStarted || room.gameOver || !room.gamePlayerIds.has(player.id)) {
      throw new RequestError('Debes estar listo en una partida iniciada.');
    }
  }

  allPlayersConfirmed(room) {
    const activePlayers = [...room.gamePlayerIds].filter((playerId) => {
      const player = room.players.get(playerId);
      return player && !player.finished;
    });
    return activePlayers.length > 0 &&
      activePlayers.every((playerId) => room.pendingMoves.has(playerId));
  }

  completeRound(room, events) {
    const confirmedPlayerIds = [...room.gamePlayerIds].filter((playerId) => {
      const player = room.players.get(playerId);
      return player && !player.finished;
    });
    const moves = confirmedPlayerIds
      .map((playerId) => [room.players.get(playerId), room.pendingMoves.get(playerId)])
      .filter(([player, move]) => player && move);
    room.dice = null;
    for (const [player, move] of moves) {
      if (move.skip) continue;
      player.board.set(coordinateKey(move.row, move.column), move.number);
      player.finished = player.board.size >= BOARD_SIZE * BOARD_SIZE;
    }
    room.pendingMoves.clear();
    for (const [player] of moves) this.awardCompletedZones(room, player);
    const recipients = [...room.players.values()].map((player) => player.socket);
    for (const [player] of moves) {
      events.push({
        sockets: recipients,
        type: 'board_state',
        data: this.boardData(room, player),
      });
    }
    events.push(this.scoreEvent(room));
    this.appendGameOverIfComplete(room, events);
    if (!room.gameOver) this.rollForRoom(room, events);
    events.push(...this.roomStateEvents(room));
  }

  canStartGame(room) {
    return room.players.size >= 2 &&
      [...room.players.values()].every((player) => player.submitted && player.ready);
  }

  resetLobbyIfUnderpopulated(room) {
    if (room.gameStarted || room.phase !== 'initial_board' || room.players.size >= 2) return;
    room.phase = 'lobby';
    for (const player of room.players.values()) {
      player.ready = false;
      player.submitted = false;
      player.board = new Map();
    }
  }

  roomData(room, recipient) {
    return {
      code: room.code,
      playerId: recipient.id,
      mapId: room.mapId,
      gameStarted: room.gameStarted,
      phase: room.phase,
      players: [...room.players.values()].map(({ id, name, ready }) => ({ id, name, ready })),
    };
  }

  roomStateEvents(room) {
    return [...room.players.values()].map((player) => ({
      sockets: [player.socket],
      type: 'room_state',
      data: this.roomData(room, player),
    }));
  }

  broadcastRoomState(room) {
    for (const player of room.players.values()) {
      this.emit([player.socket], 'room_state', this.roomData(room, player));
    }
  }

  boardData(room, player) {
    return {
      playerId: player.id,
      mapId: room.mapId,
      assignments: this.serializeBoard(player.board),
    };
  }

  serializeBoard(board) {
    return [...board.entries()].map(([key, value]) => {
      const [row, column] = fromCoordinateKey(key);
      return { row, column, value };
    });
  }

  awardCompletedZones(room, player) {
    for (const zone of room.zones) {
      if (room.zoneWinners.filter((winner) => winner.zoneId === zone.id).length >= 3) continue;
      if (room.zoneWinners.some((winner) =>
        winner.zoneId === zone.id && winner.playerId === player.id)) continue;
      if (!zone.cells.every(([row, column]) => player.board.has(coordinateKey(row, column)))) continue;
      const existing = room.zoneWinners.filter((winner) => winner.zoneId === zone.id);
      const place = existing.length + 1;
      room.zoneWinners.push({
        zoneId: zone.id,
        playerId: player.id,
        playerName: player.name,
        place,
        points: zone.points[place - 1],
      });
      const score = room.scores.get(player.id);
      score.total += zone.points[place - 1];
    }
  }

  scoreSnapshot(room) {
    return {
      scores: [...room.scores.values()].map(({ playerId, playerName, total }) => ({
        playerId,
        playerName,
        total,
      })),
      zoneWinners: room.zoneWinners.map((winner) => ({ ...winner })),
    };
  }

  scoreEvent(room) {
    return {
      sockets: [...room.players.values()].map((player) => player.socket),
      type: 'score_update',
      data: this.scoreSnapshot(room),
    };
  }

  broadcastScore(room) {
    this.emit([...room.players.values()].map((player) => player.socket), 'score_update', this.scoreSnapshot(room));
  }

  rollForRoom(room, events) {
    const values = this.diceRoller();
    if (!Array.isArray(values) || values.length !== 2 ||
        values.some((value) => !isIntegerInRange(value, 1, 6))) {
      throw new Error('Dice roller must return two integers between 1 and 6.');
    }
    room.dice = [...values];
    const confirmedPlayerIds = [...room.gamePlayerIds].filter((playerId) => {
      const player = room.players.get(playerId);
      return player && !player.finished;
    });
    events.push({
      sockets: [...room.players.values()].map((player) => player.socket),
      type: 'dice_rolled',
      data: { values: [...room.dice], confirmedPlayerIds },
    });
  }

  appendGameOverIfComplete(room, events) {
    if (room.gameOver) return;
    const activeGamePlayers = [...room.players.values()]
      .filter((player) => room.gamePlayerIds.has(player.id));
    if (activeGamePlayers.length === 0 || !activeGamePlayers.every((player) => player.finished)) return;
    room.gameOver = true;
    const snapshot = this.scoreSnapshot(room);
    events.push({
      sockets: [...room.players.values()].map((player) => player.socket),
      type: 'game_over',
      data: snapshot,
    });
  }

  emit(sockets, type, data) {
    const message = JSON.stringify({ type, data });
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  sendResponse(socket, requestId, ok, data, error) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const response = { type: 'response', requestId, ok };
    if (ok) response.data = data;
    else response.error = error;
    socket.send(JSON.stringify(response));
  }
}

function buildScoringZones(map) {
  const zones = [];
  const allPositions = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let column = 0; column < BOARD_SIZE; column++) {
      allPositions.push([row, column]);
    }
  }

  const globalScoringTypes = new Set(['yellow', 'white', ...(map.scoringGroups || [])]);
  for (const type of globalScoringTypes) {
    const cells = allPositions.filter(([row, column]) => map.cells[row][column] === type);
    if (cells.length) zones.push({ id: type, type, cells, points: POINTS_BY_TYPE[type] });
  }

  const visited = new Set();
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let column = 0; column < BOARD_SIZE; column++) {
      const type = map.cells[row][column];
      if (globalScoringTypes.has(type)) continue;
      const startKey = coordinateKey(row, column);
      if (visited.has(startKey)) continue;
      const stack = [[row, column]];
      const cells = [];
      visited.add(startKey);
      while (stack.length) {
        const [currentRow, currentColumn] = stack.pop();
        cells.push([currentRow, currentColumn]);
        for (const [nextRow, nextColumn] of [
          [currentRow - 1, currentColumn],
          [currentRow + 1, currentColumn],
          [currentRow, currentColumn - 1],
          [currentRow, currentColumn + 1],
        ]) {
          if (nextRow < 0 || nextRow >= BOARD_SIZE || nextColumn < 0 || nextColumn >= BOARD_SIZE) continue;
          if (map.cells[nextRow][nextColumn] !== type) continue;
          const nextKey = coordinateKey(nextRow, nextColumn);
          if (visited.has(nextKey)) continue;
          visited.add(nextKey);
          stack.push([nextRow, nextColumn]);
        }
      }
      const index = zones.filter((zone) => zone.type === type).length + 1;
      zones.push({
        id: `${type}-${index}`,
        type,
        cells,
        points: POINTS_BY_TYPE[type],
      });
    }
  }
  return zones;
}

function constraintRegion(map, row, column) {
  const type = map.cells[row][column];
  if (type === 'white') {
    const cells = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (map.cells[r][c] === 'white') cells.push([r, c]);
      }
    }
    return cells;
  }
  const stack = [[row, column]];
  const visited = new Set([coordinateKey(row, column)]);
  const cells = [];
  while (stack.length) {
    const [currentRow, currentColumn] = stack.pop();
    cells.push([currentRow, currentColumn]);
    for (const [nextRow, nextColumn] of [
      [currentRow - 1, currentColumn],
      [currentRow + 1, currentColumn],
      [currentRow, currentColumn - 1],
      [currentRow, currentColumn + 1],
    ]) {
      if (nextRow < 0 || nextRow >= BOARD_SIZE || nextColumn < 0 || nextColumn >= BOARD_SIZE) continue;
      if (map.cells[nextRow][nextColumn] !== type) continue;
      const key = coordinateKey(nextRow, nextColumn);
      if (visited.has(key)) continue;
      visited.add(key);
      stack.push([nextRow, nextColumn]);
    }
  }
  return cells;
}

function validateBoardRules(map, board) {
  for (const [key, value] of board) {
    if (!isIntegerInRange(value, 1, 6)) return false;
    const [row, column] = fromCoordinateKey(key);
    const type = map.cells[row]?.[column];
    if (!type) return false;
    if (type === 'orangeUpper' && value < 4) return false;
    if (type === 'orangeLower' && value > 3) return false;
  }

  const checked = new Set();
  for (const [key] of board) {
    const [row, column] = fromCoordinateKey(key);
    const region = constraintRegion(map, row, column);
    const signature = region.map(([r, c]) => coordinateKey(r, c)).sort().join('|');
    if (checked.has(signature)) continue;
    checked.add(signature);
    const values = region
      .map(([r, c]) => board.get(coordinateKey(r, c)))
      .filter((value) => value !== undefined);
    const type = map.cells[row][column];
    if ((type === 'blue' || type === 'white') && new Set(values).size > 1) return false;
    if ((type === 'red' || type === 'yellow') && new Set(values).size !== values.length) return false;
    if (type === 'purple' && new Set(values).size > 2) return false;
  }
  return true;
}

function isAdjacentToComplement(player, dice, row, column, number) {
  const requiredNeighbor = complementaryDiceValue(dice, number);
  return [
    [row - 1, column],
    [row + 1, column],
    [row, column - 1],
    [row, column + 1],
  ].some(([r, c]) => player.board.get(coordinateKey(r, c)) === requiredNeighbor);
}

function complementaryDiceValue(dice, number) {
  const [first, second] = dice;
  return number === first ? second : first;
}

async function startServer(options = {}) {
  const server = new BrillantServer(options);
  try {
    await server.ready;
    return server;
  } catch (error) {
    try {
      await server.close();
    } catch (closeError) {
      console.error('Could not close the WebSocket server after startup failed:', closeError);
    }
    throw error;
  }
}

module.exports = {
  BrillantServer,
  DEFAULT_MARKED_POSITIONS,
  MAPS,
  buildScoringZones,
  startServer,
  validateBoardRules,
};
