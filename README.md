# Servidor multijugador Brillant

Servidor Node.js independiente para el cliente Flutter. Escucha WebSocket en
`0.0.0.0:3000`, por lo que acepta conexiones de otros dispositivos de la red
local. El proyecto Flutter no forma parte de este directorio y no se modifica.

## Iniciar

Requiere Node.js 18 o posterior.

```powershell
npm install
npm start
```

En Windows, permite conexiones entrantes TCP al puerto 3000 en el Firewall de
Windows para redes privadas. Los clientes pueden conectarse con:

- Escritorio/web local: `ws://localhost:3000`
- Android Emulator: `ws://10.0.2.2:3000`
- Teléfono real: `ws://<IP-local-del-equipo-servidor>:3000`

Para descubrir la IP local del equipo en Windows, ejecuta `ipconfig` y usa la
dirección IPv4 de la interfaz conectada a la misma red Wi-Fi.

## Protocolo

Cada acción usa `{ "type": "...", "requestId": "...", "payload": { ... } }`.
El servidor responde con `response` y el mismo `requestId`; los eventos no
solicitados tienen la forma `{ "type": "...", "data": { ... } }`.

Las coordenadas son índices de fila y columna de base cero. Los dados se generan
exclusivamente en el servidor. Cada jugador prepara una vez las seis posiciones
marcadas con los valores 1–6; después puede colocar en cualquier casilla vacía,
respetando la adyacencia ortogonal al dado complementario y las reglas de la
zona. Las salas comienzan al tener al menos dos jugadores listos.

## Pruebas

```powershell
npm test
```
