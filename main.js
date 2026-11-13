const { startServer } = require('./game-server');

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

startServer({ port })
  .then((server) => {
    const address = server.address();
    console.log(`Brillant multiplayer server listening on ${address.address}:${address.port}`);
  })
  .catch((error) => {
    console.error('Could not start the Brillant multiplayer server:', error);
    process.exitCode = 1;
  });
