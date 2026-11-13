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

## Publicar en Render

1. Sube este repositorio a GitHub.
2. En Render, crea un **New + → Web Service** y conecta el repositorio.
3. Si este repositorio contiene solo el servidor, deja **Root Directory** vacío.
   Si el servidor está dentro de una carpeta de un repositorio mayor, indica esa
   carpeta.
4. Configura **Runtime** como `Node`, **Build Command** como `npm ci` y
   **Start Command** como `npm start`. No hace falta configurar manualmente el
   puerto: el servidor usa la variable `PORT` que Render le asigna.
5. Crea el servicio y espera a que el despliegue termine. Render mostrará una
   dirección como `https://<nombre-del-servicio>.onrender.com`.
6. En la configuración del cliente Flutter, usa la misma dirección con el
   protocolo WebSocket seguro: `wss://<nombre-del-servicio>.onrender.com`.
   Sustituye la URL local `ws://...:3000` por esa URL para las conexiones
   publicadas.

El servicio mantiene las salas y las partidas en memoria. Usa una sola
instancia: las salas no se comparten entre varias instancias y se pierden cuando
el proceso se reinicia o se vuelve a desplegar.

## Protocolo

Cada acción usa `{ "type": "...", "requestId": "...", "payload": { ... } }`.
El servidor responde con `response` y el mismo `requestId`; los eventos no
solicitados tienen la forma `{ "type": "...", "data": { ... } }`.

Las coordenadas son índices de fila y columna de base cero. Los dados se generan
exclusivamente en el servidor. Cada jugador envía `submit_initial_board` con
exactamente las seis posiciones marcadas, los valores 1–6 sin repetir y
`ready: true`. Crear o unirse a una sala, o enviar una señal de listo del lobby,
no inicia la partida. Cuando hay al menos dos jugadores y todos usan
`set_ready: true`, `room_state.phase` avanza a `initial_board`. La partida
comienza solo cuando cada jugador envía un tablero válido y confirma con
`ready: true`; entonces el servidor reinicia el estado `ready` del lobby, envía
`game_started` y una única pareja `dice_rolled` compartida por todos. Tras cada
tirada, `place_number` (con `ready: true`) y `skip_turn` registran una acción
pendiente por jugador. La respuesta mantiene `ok: true` y `pending: true` si
faltan confirmaciones; la acción del último jugador también responde `ok: true`,
pero con `pending: false`, porque en esa misma operación se aplica la ronda.
El servidor envía el estado actualizado de cada tablero y genera inmediatamente
una pareja compartida. `dice_rolled` incluye
`values` y los `confirmedPlayerIds` de todos los jugadores activos de la ronda.
Los jugadores pueden colocar en cualquier casilla vacía, respetando la
adyacencia ortogonal al dado complementario y las reglas de la zona.
En el mapa 3, las casillas azules forman una zona de puntuación y las verdes
otra; cada una puntúa solo cuando el jugador ha ocupado todas sus casillas.

## Pruebas

```powershell
npm test
```
