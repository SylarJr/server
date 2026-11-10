const { startServer } = require('./game-server');

startServer()
  .then((server) => {
    const address = server.address();
    console.log(`Brillant multiplayer server listening on ${address.address}:${address.port}`);
  })
  .catch((error) => {
    console.error('Could not start the Brillant multiplayer server:', error);
    process.exitCode = 1;
  });
