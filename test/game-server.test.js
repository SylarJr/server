const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { MAPS, buildScoringZones, startServer } = require('../game-server');

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async nextMessage(predicate = () => true) {
    const messageIndex = this.messages.findIndex(predicate);
    if (messageIndex >= 0) return this.messages.splice(messageIndex, 1)[0];
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error('Timed out waiting for a WebSocket message.'));
        }, 2000),
      };
      this.waiters.push(waiter);
    });
  }

  async request(type, payload = {}, requestId = `${type}-${Date.now()}-${Math.random()}`) {
    this.socket.send(JSON.stringify({ type, requestId, payload }));
    return this.nextMessage((message) => message.type === 'response' && message.requestId === requestId);
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await once(this.socket, 'close');
  }
}

async function connect(server) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(socket, 'open');
  return new TestClient(socket);
}

async function setupRoom({ mapId = 0, diceRoller = () => [1, 2] } = {}) {
  const server = await startServer({ host: '127.0.0.1', port: 0, diceRoller });
  const host = await connect(server);
  const created = await host.request('create_room', { mapId, playerName: 'Ana' });
  assert.equal(created.ok, true);
  const guest = await connect(server);
  const joined = await guest.request('join_room', {
    code: created.data.code,
    playerName: 'Luis',
  });
  assert.equal(joined.ok, true);
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  for (const player of [host, guest]) {
    const ready = await player.request('set_ready', { ready: true });
    assert.equal(ready.ok, true);
    await host.nextMessage((message) => message.type === 'room_state');
    await guest.nextMessage((message) => message.type === 'room_state');
  }
  await host.request('submit_initial_board', {
    assignments: mapZeroAssignments(),
    ready: true,
  });
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  await host.nextMessage((message) => message.type === 'board_state');
  await guest.request('submit_initial_board', {
    assignments: mapZeroAssignments(),
    ready: true,
  });
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  for (const player of [host, guest]) {
    await player.nextMessage((message) => message.type === 'board_state');
    await player.nextMessage((message) => message.type === 'board_state');
  }
  for (const player of [host, guest]) {
    await player.nextMessage((message) => message.type === 'score_update');
    await player.nextMessage((message) => message.type === 'game_started');
    await player.nextMessage((message) => message.type === 'dice_rolled');
  }
  return {
    server,
    host,
    guest,
    hostId: created.data.playerId,
    guestId: joined.data.playerId,
    room: created.data.code,
  };
}

function mapZeroAssignments() {
  return [[0, 2], [1, 5], [3, 1], [3, 4], [5, 2], [6, 4]]
    .map(([row, column], index) => ({ row, column, value: index + 1 }));
}

function mapThreeAssignments() {
  return [
    { row: 0, column: 4, value: 4 },
    { row: 2, column: 2, value: 2 },
    { row: 2, column: 5, value: 3 },
    { row: 3, column: 0, value: 5 },
    { row: 5, column: 4, value: 6 },
    { row: 6, column: 1, value: 1 },
  ];
}

test('creates and joins rooms, rejects unknown codes, and deduplicates request IDs', async (t) => {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
  const host = await connect(server);
  const guest = await connect(server);
  t.after(async () => {
    await host.close();
    await guest.close();
    await server.close();
  });

  const invalid = await guest.request('join_room', { code: 'NOEXIST', playerName: 'Luis' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /No existe/);
  const longName = await guest.request('create_room', {
    mapId: 0,
    playerName: 'x'.repeat(25),
  });
  assert.equal(longName.ok, false);
  assert.match(longName.error, /24 caracteres/);

  const created = await host.request(
    'create_room',
    { mapId: 2, playerName: ' Ana ' },
    'create-once',
  );
  assert.equal(created.ok, true);
  assert.equal(created.data.mapId, 2);
  assert.equal(created.data.gameStarted, false);
  assert.equal(created.data.players[0].name, 'Ana');
  assert.match(created.data.code, /^[A-Z2-9]{6}$/);

  const replay = await host.request(
    'create_room',
    { mapId: 1, playerName: 'Different' },
    'create-once',
  );
  assert.deepEqual(replay, created);
  assert.equal(server.rooms.size, 1);

  const joined = await guest.request('join_room', {
    code: created.data.code.toLowerCase(),
    playerName: 'Luis',
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.data.mapId, 2);
  assert.equal(joined.data.players.length, 2);
  assert.deepEqual(joined.data.players.map(({ name }) => name), ['Ana', 'Luis']);
  assert.equal(joined.data.gameStarted, false);
  assert.deepEqual(Object.keys(joined.data.players[0]), ['id', 'name', 'ready']);
  const hostState = await host.nextMessage((message) => message.type === 'room_state');
  assert.equal(hostState.data.playerId, created.data.playerId);
  assert.equal(hostState.data.gameStarted, false);
  assert.deepEqual(hostState.data.players.map(({ name, ready }) => ({ name, ready })), [
    { name: 'Ana', ready: false },
    { name: 'Luis', ready: false },
  ]);
});

test('starts only after every player submits a valid board and is ready', async (t) => {
  let rollCount = 0;
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    diceRoller: () => {
      rollCount++;
      return [2, 5];
    },
  });
  const host = await connect(server);
  const guest = await connect(server);
  t.after(async () => {
    await host.close();
    await guest.close();
    await server.close();
  });

  const created = await host.request('create_room', { mapId: 0, playerName: 'Ana' });
  const joined = await guest.request('join_room', { code: created.data.code, playerName: 'Luis' });
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');

  const lobbyReady = await host.request('set_ready', { ready: true });
  assert.equal(lobbyReady.ok, true);
  assert.equal(lobbyReady.data.ready, true);
  assert.equal(server.rooms.get(created.data.code).gameStarted, false);
  const hostLobbyState = await host.nextMessage((message) => message.type === 'room_state');
  const guestLobbyState = await guest.nextMessage((message) => message.type === 'room_state');
  assert.deepEqual(hostLobbyState.data.players.map(({ name, ready }) => ({ name, ready })), [
    { name: 'Ana', ready: true },
    { name: 'Luis', ready: false },
  ]);
  assert.deepEqual(guestLobbyState.data.players.map(({ name, ready }) => ({ name, ready })), [
    { name: 'Ana', ready: true },
    { name: 'Luis', ready: false },
  ]);

  const prematureBoard = await host.request('submit_initial_board', {
    assignments: mapZeroAssignments(),
    ready: true,
  });
  assert.equal(prematureBoard.ok, false);
  assert.match(prematureBoard.error, /Todos los jugadores deben estar listos/);

  const guestLobbyReady = await guest.request('set_ready', { ready: true });
  assert.equal(guestLobbyReady.ok, true);
  assert.equal(guestLobbyReady.data.phase, 'initial_board');
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');

  const incomplete = await host.request('submit_initial_board', {
    assignments: mapZeroAssignments().slice(1),
    ready: true,
  });
  assert.equal(incomplete.ok, false);
  assert.equal(server.rooms.get(created.data.code).players.get(created.data.playerId).submitted, false);
  const unmarked = await host.request('submit_initial_board', {
    assignments: mapZeroAssignments().map((entry, index) =>
      index === 0 ? { ...entry, row: 2 } : entry),
    ready: true,
  });
  assert.equal(unmarked.ok, false);
  assert.equal(server.rooms.get(created.data.code).players.get(created.data.playerId).submitted, false);

  const notReady = await host.request('submit_initial_board', {
    assignments: mapZeroAssignments(),
    ready: false,
  });
  assert.equal(notReady.ok, false);

  const hostSubmission = await host.request('submit_initial_board', {
    assignments: mapZeroAssignments(),
    ready: true,
  });
  assert.equal(hostSubmission.ok, true);
  assert.equal(rollCount, 0);
  const hostRoomState = await host.nextMessage((message) => message.type === 'room_state');
  const guestRoomState = await guest.nextMessage((message) => message.type === 'room_state');
  await host.nextMessage((message) => message.type === 'board_state');
  assert.equal(server.rooms.get(created.data.code).gameStarted, false);
  assert.equal(hostRoomState.data.players.find((player) => player.id === created.data.playerId).ready, true);
  assert.equal(guestRoomState.data.players.find((player) => player.id === joined.data.playerId).ready, true);
  assert.equal(hostRoomState.data.phase, 'initial_board');

  const guestSubmission = await guest.request('submit_initial_board', {
    assignments: mapZeroAssignments(),
    ready: true,
  });
  assert.equal(guestSubmission.ok, true);
  assert.equal(rollCount, 1);
  const startEvents = [];
  for (const player of [host, guest]) {
    const state = await player.nextMessage((message) => message.type === 'room_state');
    assert.equal(state.data.gameStarted, true);
    assert.equal(state.data.phase, 'game');
    assert.ok(state.data.players.every((entry) => entry.ready === false));
    await player.nextMessage((message) => message.type === 'board_state');
    await player.nextMessage((message) => message.type === 'board_state');
    await player.nextMessage((message) => message.type === 'score_update');
    startEvents.push(await player.nextMessage((message) => message.type === 'game_started'));
  }
  assert.equal(server.rooms.get(created.data.code).gameStarted, true);
  assert.equal(startEvents[0].data.playerId, created.data.playerId);
  assert.equal(startEvents[1].data.playerId, joined.data.playerId);
  const firstDice = await host.nextMessage((message) => message.type === 'dice_rolled');
  const secondDice = await guest.nextMessage((message) => message.type === 'dice_rolled');
  assert.deepEqual(firstDice.data.values, secondDice.data.values);
  assert.deepEqual(firstDice.data.values, [2, 5]);
  assert.deepEqual(firstDice.data.confirmedPlayerIds, [created.data.playerId, joined.data.playerId]);
  assert.deepEqual(secondDice.data.confirmedPlayerIds, firstDice.data.confirmedPlayerIds);
});

test('removes disconnected players and deletes an empty room after leave', async (t) => {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
  const host = await connect(server);
  const guest = await connect(server);
  t.after(async () => {
    await host.close();
    await guest.close();
    await server.close();
  });

  const created = await host.request('create_room', { mapId: 0, playerName: 'Ana' });
  await guest.request('join_room', { code: created.data.code, playerName: 'Luis' });
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  await host.close();
  const state = await guest.nextMessage((message) => message.type === 'room_state');
  assert.equal(state.data.players.length, 1);
  assert.equal(state.data.players[0].name, 'Luis');

  const left = await guest.request('leave_room');
  assert.equal(left.ok, true);
  assert.equal(server.rooms.size, 0);
});

test('validates pending moves and applies both players together using shared dice', async (t) => {
  const diceByRound = [[1, 2], [5, 6]];
  let rollCount = 0;
  const { server, host, guest, room, hostId, guestId } = await setupRoom({
    diceRoller: () => diceByRound[rollCount++],
  });
  t.after(async () => {
    await host.close();
    await guest.close();
    await server.close();
  });

  const forgedDice = await host.request('place_number', {
    row: 6,
    column: 0,
    number: 6,
    ready: true,
    values: [6, 6],
  });
  assert.equal(forgedDice.ok, false);
  assert.match(forgedDice.error, /number \(6\).*dados vigentes \[1, 2\]/);
  assert.equal(rollCount, 1);
  assert.deepEqual(server.rooms.get(room).dice, [1, 2]);
  assert.equal(server.rooms.get(room).pendingMoves.size, 0);

  const noAdjacency = await host.request('place_number', {
    row: 6,
    column: 0,
    number: 2,
    ready: true,
  });
  assert.equal(noAdjacency.ok, false);
  assert.match(noAdjacency.error, /casilla \(6,0\).*number 2 requiere un vecino ortogonal con 1/);
  assert.match(noAdjacency.error, /dados vigentes \[1, 2\]/);

  const regionViolation = await host.request('place_number', {
    row: 1,
    column: 2,
    number: 2,
    ready: true,
  });
  assert.equal(regionViolation.ok, false);
  assert.match(regionViolation.error, /reglas de la zona/);

  const missingConfirmation = await host.request('place_number', {
    row: 0,
    column: 1,
    number: 2,
  });
  assert.equal(missingConfirmation.ok, false);
  assert.match(missingConfirmation.error, /ready debe ser true/);

  const validMove = await host.request('place_number', {
    row: 0,
    column: 1,
    number: 2,
    ready: true,
  });
  assert.equal(validMove.ok, true);
  assert.equal(validMove.data.pending, true);
  assert.equal(validMove.data.assignments.length, 6);
  assert.equal(rollCount, 1);
  assert.deepEqual(server.rooms.get(room).dice, [1, 2]);
  assert.equal(host.messages.some((message) => message.type === 'dice_rolled'), false);
  assert.equal(guest.messages.some((message) => message.type === 'dice_rolled'), false);
  const waitingState = await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  assert.ok(waitingState.data.players.every((player) => !player.ready));
  assert.equal(server.rooms.get(room).players.get(hostId).board.size, 6);

  const duplicate = await host.request('place_number', {
    row: 0,
    column: 1,
    number: 2,
    ready: true,
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /Ya confirmaste/);

  const invalidGuestMove = await guest.request('place_number', {
    row: 6,
    column: 0,
    number: 2,
    ready: true,
  });
  assert.equal(invalidGuestMove.ok, false);
  assert.match(invalidGuestMove.error, /casilla \(6,0\).*number 2 requiere un vecino ortogonal con 1/);
  assert.match(invalidGuestMove.error, /dados vigentes \[1, 2\]/);
  assert.equal(rollCount, 1);
  assert.deepEqual(server.rooms.get(room).dice, [1, 2]);
  assert.equal(server.rooms.get(room).pendingMoves.size, 1);
  assert.equal(host.messages.some((message) => message.type === 'dice_rolled'), false);
  assert.equal(guest.messages.some((message) => message.type === 'dice_rolled'), false);

  const guestMove = await guest.request('place_number', {
    row: 0,
    column: 1,
    number: 2,
    ready: true,
  });
  assert.equal(guestMove.ok, true);
  assert.equal(guestMove.data.pending, false);
  assert.equal(rollCount, 2);
  assert.deepEqual(server.rooms.get(room).dice, [5, 6]);
  assert.equal(server.rooms.get(room).players.get(hostId).board.size, 7);
  const updatedBoards = await Promise.all([host, guest].map(async (player) => {
    const first = await player.nextMessage((message) => message.type === 'board_state');
    const second = await player.nextMessage((message) => message.type === 'board_state');
    return [first.data.playerId, second.data.playerId].sort();
  }));
  assert.deepEqual(updatedBoards[0], updatedBoards[1]);
  assert.deepEqual(updatedBoards[0], [hostId, guestId].sort());
  await host.nextMessage((message) => message.type === 'score_update');
  const hostDice = await host.nextMessage((message) => message.type === 'dice_rolled');
  await guest.nextMessage((message) => message.type === 'score_update');
  const guestDice = await guest.nextMessage((message) => message.type === 'dice_rolled');
  assert.deepEqual(hostDice.data.values, [5, 6]);
  assert.deepEqual(guestDice.data.values, hostDice.data.values);
  assert.deepEqual(hostDice.data.confirmedPlayerIds, [hostId, guestId]);
  assert.deepEqual(guestDice.data.confirmedPlayerIds, [hostId, guestId]);
  assert.equal(hostDice.data.values.length, 2);
  assert.ok(hostDice.data.values.every((value) => Number.isInteger(value) && value >= 1 && value <= 6));
});

test('waits for both skip confirmations and rolls the next pair immediately', async (t) => {
  const rolls = [[2, 5], [1, 6]];
  let rollCount = 0;
  const { server, host, guest, hostId, guestId } = await setupRoom({
    diceRoller: () => rolls[rollCount++],
  });
  t.after(async () => {
    await host.close();
    await guest.close();
    await server.close();
  });

  assert.equal(rollCount, 1);
  const hostSkip = await host.request('skip_turn');
  assert.equal(hostSkip.ok, true);
  assert.equal(hostSkip.data.pending, true);
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  assert.equal(rollCount, 1);
  const submittedAt = Date.now();
  const guestSkip = await guest.request('skip_turn');
  assert.equal(guestSkip.ok, true);
  assert.equal(guestSkip.data.pending, false);
  assert.equal(rollCount, 2);
  for (const player of [host, guest]) {
    const firstBoard = await player.nextMessage((message) => message.type === 'board_state');
    const secondBoard = await player.nextMessage((message) => message.type === 'board_state');
    assert.equal(firstBoard.data.assignments.length, 6);
    assert.equal(secondBoard.data.assignments.length, 6);
  }
  await host.nextMessage((message) => message.type === 'score_update');
  const hostDice = await host.nextMessage((message) => message.type === 'dice_rolled');
  await guest.nextMessage((message) => message.type === 'score_update');
  const guestDice = await guest.nextMessage((message) => message.type === 'dice_rolled');
  assert.deepEqual(hostDice.data.values, [1, 6]);
  assert.deepEqual(guestDice.data.values, hostDice.data.values);
  assert.deepEqual(hostDice.data.confirmedPlayerIds, [hostId, guestId]);
  assert.deepEqual(guestDice.data.confirmedPlayerIds, [hostId, guestId]);
  assert.ok(Date.now() - submittedAt < 1000, 'next dice should not wait on an artificial delay');
  assert.equal(rollCount, 2);
});

test('awards orange-zone points in server acceptance order', async (t) => {
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    diceRoller: () => [4, 5],
  });
  const host = await connect(server);
  const guest = await connect(server);
  const third = await connect(server);
  t.after(async () => {
    await host.close();
    await guest.close();
    await third.close();
    await server.close();
  });

  const created = await host.request('create_room', { mapId: 3, playerName: 'Ana' });
  const joined = await guest.request('join_room', {
    code: created.data.code,
    playerName: 'Luis',
  });
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  const thirdJoin = await third.request('join_room', {
    code: created.data.code,
    playerName: 'Eva',
  });
  const players = [host, guest, third];
  for (const player of players) {
    await player.nextMessage((message) => message.type === 'room_state');
  }
  for (const [index, player] of players.entries()) {
    const ready = await player.request('set_ready', { ready: true });
    assert.equal(ready.ok, true);
    for (const recipient of players) {
      const state = await recipient.nextMessage((message) => message.type === 'room_state');
      assert.equal(state.data.players.filter((entry) => entry.ready).length, index + 1);
    }
  }
  for (const [index, player] of players.entries()) {
    const result = await player.request('submit_initial_board', {
      assignments: mapThreeAssignments(),
      ready: true,
    });
    assert.equal(result.ok, true);
    for (const recipient of players) {
      await recipient.nextMessage((message) => message.type === 'room_state');
    }
    if (index === players.length - 1) {
      for (const recipient of players) {
        for (let count = 0; count < players.length; count++) {
          await recipient.nextMessage((message) => message.type === 'board_state');
        }
        await recipient.nextMessage((message) => message.type === 'score_update');
        await recipient.nextMessage((message) => message.type === 'game_started');
        const dice = await recipient.nextMessage((message) => message.type === 'dice_rolled');
        assert.deepEqual(dice.data.confirmedPlayerIds, [created.data.playerId, joined.data.playerId, thirdJoin.data.playerId]);
      }
    } else {
      await player.nextMessage((message) => message.type === 'board_state');
    }
  }

  const fillOrangeUpper = async () => {
    let finalScore;
    for (const [column, number] of [[3, 5], [2, 4], [1, 5], [0, 4], [5, 5], [6, 4]]) {
      for (const [index, player] of players.entries()) {
        const result = await player.request('place_number', {
          row: 0,
          column,
          number,
          ready: true,
        });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.data.pending, index < players.length - 1);
      }
      for (const recipient of players) {
        for (let count = 0; count <= players.length; count++) {
          await recipient.nextMessage((message) => message.type === 'room_state');
        }
      }
      for (const recipient of players) {
        for (let count = 0; count < players.length; count++) {
          await recipient.nextMessage((message) => message.type === 'board_state');
        }
        finalScore = await recipient.nextMessage((message) => message.type === 'score_update');
        const dice = await recipient.nextMessage((message) => message.type === 'dice_rolled');
        assert.deepEqual(dice.data.values, [4, 5]);
      }
    }
    return finalScore;
  };

  const finalScore = await fillOrangeUpper();
  const roomState = server.rooms.get(created.data.code);
  assert.equal(
    roomState.zoneWinners.filter((winner) => winner.zoneId === 'orangeUpper-1').length,
    3,
  );
  const winners = finalScore.data.zoneWinners.filter((winner) => winner.zoneId === 'orangeUpper-1');
  assert.deepEqual(winners, [
    { zoneId: 'orangeUpper-1', playerId: created.data.playerId, playerName: 'Ana', place: 1, points: 6 },
    { zoneId: 'orangeUpper-1', playerId: joined.data.playerId, playerName: 'Luis', place: 2, points: 4 },
    { zoneId: 'orangeUpper-1', playerId: thirdJoin.data.playerId, playerName: 'Eva', place: 3, points: 3 },
  ]);
  const firstPlayerTotal = finalScore.data.scores
    .find((score) => score.playerId === created.data.playerId).total;
  assert.equal(
    firstPlayerTotal,
    finalScore.data.zoneWinners
      .filter((winner) => winner.playerId === created.data.playerId)
      .reduce((total, winner) => total + winner.points, 0),
  );
});

test('map 3 blue and green scoring requires every cell of each color', async (t) => {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
  const host = await connect(server);
  const guest = await connect(server);
  t.after(async () => {
    await host.close();
    await guest.close();
    await server.close();
  });

  const created = await host.request('create_room', { mapId: 3, playerName: 'Ana' });
  await guest.request('join_room', { code: created.data.code, playerName: 'Luis' });
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  for (const player of [host, guest]) {
    await player.request('set_ready', { ready: true });
    await host.nextMessage((message) => message.type === 'room_state');
    await guest.nextMessage((message) => message.type === 'room_state');
  }
  await host.request('submit_initial_board', {
    assignments: mapThreeAssignments(),
    ready: true,
  });
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  await host.nextMessage((message) => message.type === 'board_state');
  await guest.request('submit_initial_board', {
    assignments: mapThreeAssignments(),
    ready: true,
  });

  const room = server.rooms.get(created.data.code);
  const player = room.players.get(created.data.playerId);
  const blueZone = room.zones.find((zone) => zone.id === 'blue');
  const greenZone = room.zones.find((zone) => zone.id === 'green');
  assert.equal(blueZone.cells.length, 6);
  assert.equal(greenZone.cells.length, 4);
  assert.equal(player.board.size, 6);
  assert.equal(
    room.zoneWinners.some((winner) => winner.zoneId === blueZone.id || winner.zoneId === greenZone.id),
    false,
  );

  for (const zone of [blueZone, greenZone]) {
    for (const [row, column] of zone.cells) {
      player.board.delete(`${row},${column}`);
    }
    for (const [row, column] of zone.cells.slice(0, -1)) {
      player.board.set(`${row},${column}`, 1);
    }
  }
  server.awardCompletedZones(room, player);
  assert.equal(
    room.zoneWinners.some((winner) => winner.zoneId === blueZone.id || winner.zoneId === greenZone.id),
    false,
  );

  for (const zone of [blueZone, greenZone]) {
    const [row, column] = zone.cells.at(-1);
    player.board.set(`${row},${column}`, 1);
  }
  server.awardCompletedZones(room, player);
  assert.equal(
    room.zoneWinners.filter((winner) => winner.zoneId === blueZone.id).length,
    1,
  );
  assert.equal(
    room.zoneWinners.filter((winner) => winner.zoneId === greenZone.id).length,
    1,
  );
});

test('ports four 7x7 maps with the marked positions and a single yellow scoring zone', () => {
  assert.equal(MAPS.length, 4);
  for (const map of MAPS) {
    assert.equal(map.cells.length, 7);
    assert.ok(map.cells.every((row) => row.length === 7));
    assert.equal(map.marked.length, 6);
  }
  for (const map of MAPS) {
    assert.equal(buildScoringZones(map).filter((zone) => zone.type === 'yellow').length, 1);
  }
  const mapThreeZones = buildScoringZones(MAPS[3]);
  assert.equal(mapThreeZones.filter((zone) => zone.type === 'blue').length, 1);
  assert.equal(mapThreeZones.find((zone) => zone.type === 'blue').cells.length, 6);
  assert.equal(mapThreeZones.filter((zone) => zone.type === 'green').length, 1);
  assert.equal(mapThreeZones.find((zone) => zone.type === 'green').cells.length, 4);
});
