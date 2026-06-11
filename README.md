# ¿Quién Soy? — Juego bíblico multijugador

Juego de pistas en tiempo real (Socket.IO): el presentador crea una sala,
los jugadores entran con un código desde su móvil, pulsan el buzzer para
responder y los puntos se suman a su equipo (o a cada persona en modo individual).

## Probar en local
```bash
npm install
npm start
# abre http://localhost:3000
```

## Desplegar en Railway
1. Sube esta carpeta a un repositorio de GitHub.
2. En https://railway.app → **New Project → Deploy from GitHub repo** → elige el repo.
3. Railway detecta Node automáticamente y ejecuta `npm start` (usa la variable `PORT` que Railway inyecta — ya está contemplado en `server.js`).
4. En **Settings → Networking → Generate Domain** para obtener tu URL pública.
5. Comparte la URL (o un QR de ella) con los jugadores.

Alternativa por CLI:
```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

## Notas
- Las salas viven en memoria del servidor y se limpian a las 4 horas. Si Railway
  reinicia el contenedor, las partidas en curso se pierden (suficiente para
  partidas de una reunión; si quisieras persistencia, añade Redis).
- Si el presentador recarga la pestaña, la sala se recupera sola (el código y la
  clave de host viajan en el fragmento `#h=...` de la URL).
- Un jugador que recargue puede volver a entrar con el mismo nombre y recupera
  sus puntos.
