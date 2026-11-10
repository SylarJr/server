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
  await host.request('set_ready', { ready: true });
  await guest.request('set_ready', { ready: true });
  await host.nextMessage((message) => message.type === 'game_started');
  await guest.nextMessage((message) => message.type === 'game_started');
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
  const hostState = await host.nextMessage((message) => message.type === 'room_state');
  assert.equal(hostState.data.playerId, created.data.playerId);
});

test('starts only after two players are ready and sends individualized room state', async (t) => {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
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

  const firstReady = await host.request('set_ready', { ready: true });
  assert.equal(firstReady.data.gameStarted, false);
  await host.nextMessage((message) => message.type === 'room_state');
  await guest.nextMessage((message) => message.type === 'room_state');
  const secondReady = await guest.request('set_ready', { ready: true });
  assert.equal(secondReady.data.gameStarted, true);
  const hostState = await host.nextMessage((message) => message.type === 'room_state');
  const guestState = await guest.nextMessage((message) => message.type === 'room_state');
  assert.equal(hostState.data.playerId, created.data.playerId);
  assert.equal(guestState.data.playerId, joined.data.playerId);
  assert.equal(hostState.data.gameStarted, true, JSON.stringify(hostState));
  assert.equal(guestState.data.gameStarted, true, JSON.stringify(guestState));
  await host.nextMessage((message) => message.type === 'game_started');
  await guest.nextMessage((message) => message.type === 'game_started');
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

test('validates initial boards, rolls server-side dice, and checks adjacency and region rules', async (t) => {
  const { server, host, guest } = await setupRoom();
  t.after(async () => {
    await host.close();
    await guest.close();
    await server.close();
  });

  const invalid = await host.request('submit_initial_board', {
    assignments: mapZeroAssignments().map((entry, index) =>
      index === 0 ? { ...entry, row: 2 } : entry),
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /marcadas/);

  const submitted = await host.request('submit_initial_board', {
    assignments: mapZeroAssignments(),
    values: [6, 6],
  });
  assert.equal(submitted.ok, true);
  const boardState = await host.nextMessage((message) => message.type === 'board_state');
  assert.equal(boardState.data.assignments.length, 6);
  const dice = await host.nextMessage((message) => message.type === 'dice_rolled');
  assert.deepEqual(dice.data.values, [1, 2]);

  const forgedDice = await host.request('place_number', {
    row: 6,
    column: 0,
    number: 6,
    values: [6, 6],
  });
  assert.equal(forgedDice.ok, false);
  assert.match(forgedDice.error, /dados vigentes/);

  const noAdjacency = await host.request('place_number', {
    row: 6,
    column: 0,
    number: 2,
  });
  assert.equal(noAdjacency.ok, false);
  assert.match(noAdjacency.error, /adyacente/);

  const regionViolation = await host.request('place_number', {
    row: 1,
    column: 2,
    number: 2,
  });
  assert.equal(regionViolation.ok, false);
  assert.match(regionViolation.error, /reglas de la zona/);

  const validMove = await host.request('place_number', {
    row: 0,
    column: 1,
    number: 2,
  });
  assert.equal(validMove.ok, true);
  assert.equal(validMove.data.assignments.length, 7);
  const nextDice = await host.nextMessage((message) => message.type === 'dice_rolled');
  assert.deepEqual(nextDice.data.values, [1, 2]);
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
  const thirdJoin = await third.request('join_room', {
    code: created.data.code,
    playerName: 'Eva',
  });
  const players = [host, guest, third];
  for (const player of players) {
    await player.request('set_ready', { ready: true });
  }
  for (const player of players) {
    for (let count = 0; count < 3; count++) {
      await player.nextMessage((message) => message.type === 'room_state');
    }
    await player.nextMessage((message) => message.type === 'game_started');
  }

  for (const player of players) {
    const result = await player.request('submit_initial_board', {
      assignments: mapThreeAssignments(),
    });
    assert.equal(result.ok, true);
    await player.nextMessage((message) => message.type === 'board_state');
    await player.nextMessage((message) => message.type === 'score_update');
    await player.nextMessage((message) => message.type === 'dice_rolled');
  }
  for (const player of players) {
    for (let count = 0; count < 2; count++) {
      await player.nextMessage((message) => message.type === 'score_update');
    }
  }

  const fillOrangeUpper = async (player) => {
    let finalScore;
    for (const [column, number] of [[3, 5], [2, 4], [1, 5], [0, 4], [5, 5], [6, 4]]) {
      const result = await player.request('place_number', {
        row: 0,
        column,
        number,
      });
      assert.equal(result.ok, true, result.error);
      await player.nextMessage((message) => message.type === 'board_state');
      const score = await player.nextMessage((message) => message.type === 'score_update');
      if (column !== 6) await player.nextMessage((message) => message.type === 'dice_rolled');
      for (const other of players) {
        if (other !== player) {
          const otherScore = await other.nextMessage((message) => message.type === 'score_update');
          if (column === 6) finalScore = otherScore;
        }
      }
      if (column === 6) finalScore = score;
    }
    return finalScore;
  };

  const firstScore = await fillOrangeUpper(host);
  const roomState = server.rooms.get(created.data.code);
  server.awardCompletedZones(roomState, roomState.players.get(created.data.playerId));
  assert.equal(
    roomState.zoneWinners.filter((winner) => winner.zoneId === 'orangeUpper-1').length,
    1,
  );
  const secondScore = await fillOrangeUpper(guest);
  const thirdScore = await fillOrangeUpper(third);
  const winners = thirdScore.data.zoneWinners.filter((winner) => winner.zoneId === 'orangeUpper-1');
  assert.deepEqual(winners, [
    { zoneId: 'orangeUpper-1', playerId: created.data.playerId, playerName: 'Ana', place: 1, points: 6 },
    { zoneId: 'orangeUpper-1', playerId: joined.data.playerId, playerName: 'Luis', place: 2, points: 4 },
    { zoneId: 'orangeUpper-1', playerId: thirdJoin.data.playerId, playerName: 'Eva', place: 3, points: 3 },
  ]);
  assert.equal(
    firstScore.data.zoneWinners.find((winner) => winner.zoneId === 'orangeUpper-1').place,
    1,
  );
  assert.equal(
    secondScore.data.zoneWinners.find((winner) =>
      winner.zoneId === 'orangeUpper-1' && winner.playerId === joined.data.playerId).place,
    2,
  );
  const firstPlayerTotal = thirdScore.data.scores
    .find((score) => score.playerId === created.data.playerId).total;
  assert.equal(
    firstPlayerTotal,
    thirdScore.data.zoneWinners
      .filter((winner) => winner.playerId === created.data.playerId)
      .reduce((total, winner) => total + winner.points, 0),
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
});
