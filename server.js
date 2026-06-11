/* ¿Quién Soy? — servidor multijugador (Express + Socket.IO)
   Salas en memoria con persistencia a disco. */
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public"), { maxAge: 0, etag: false }));

const PUNTOS = [50, 40, 30, 20, 10];
const salas = new Map();          // code -> sala
const conexiones = new Map();     // socket.id -> { code, playerId, esHost }
const pantallasEsperando = new Set(); // socket.ids de pantallas sin sala

/* ================= PERSISTENCIA ================= */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ESTADO_FILE = path.join(DATA_DIR, "salas.json");

function guardarEstado(){
  try{
    if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const datos = [];
    for(const [code, sala] of salas){
      datos.push({ code, hostKey: sala.hostKey, est: sala.est, mazo: sala.mazo, creada: sala.creada });
    }
    fs.writeFileSync(ESTADO_FILE, JSON.stringify(datos), "utf8");
  }catch(e){ console.error("Error guardando estado:", e.message); }
}

function cargarEstado(){
  try{
    if(!fs.existsSync(ESTADO_FILE)) return;
    const datos = JSON.parse(fs.readFileSync(ESTADO_FILE, "utf8"));
    const ahora = Date.now();
    for(const d of datos){
      if(ahora - d.creada > 24 * 3600 * 1000) continue;
      if(d.est.fase === "final") continue;
      const sala = { code: d.code, hostKey: d.hostKey, hostSid: null, est: d.est, mazo: d.mazo, creada: d.creada };
      salas.set(d.code, sala);
    }
    if(salas.size > 0) console.log("Restauradas " + salas.size + " sala(s) activa(s).");
  }catch(e){ console.error("Error cargando estado:", e.message); }
}

cargarEstado();

function genCodigo(){
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c;
  do { c = Array.from({length:4}, () => L[Math.floor(Math.random()*L.length)]).join(""); }
  while (salas.has(c));
  return c;
}
function genId(pre){ return pre + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function esDoble(sala){
  return sala.est.config.doble && sala.est.config.total > 1 &&
         sala.est.ronda && sala.est.ronda.i === sala.est.config.total - 1;
}
function publicar(sala){
  sala.est.v++;
  io.to(sala.code).emit("estado", sala.est);
}
function nuevaRonda(sala, i){
  const t = sala.mazo[i];
  sala.est.ronda = {
    i, total: sala.est.config.total, c: t.c, d: t.d,
    pistas: [], valor: 0,
    doble: sala.est.config.doble && sala.est.config.total > 1 && i === sala.est.config.total - 1,
    resuelto: false, buzz: null, bloq: [], rev: null, ganador: null
  };
  mostrarPista(sala); // la primera pista sale sola (ya publica)
}
function mostrarPista(sala){
  const r = sala.est.ronda;
  const t = sala.mazo[r.i];
  if(!r || r.resuelto || r.pistas.length >= 5) return;
  const n = r.pistas.length;
  r.pistas.push(t.pistas[n]);
  r.valor = PUNTOS[n] * (r.doble ? 2 : 1);
  r.buzz = null;
  publicar(sala);
}
function cerrarRonda(sala, ganador){
  const r = sala.est.ronda;
  const t = sala.mazo[r.i];
  r.resuelto = true;
  r.buzz = null;
  r.ganador = ganador;
  r.rev = {
    nombre: t.nombre, verso: t.verso, catRev: t.catRev,
    pistas: t.pistas.slice(0, r.pistas.length),
    refs: (t.refs || []).slice(0, r.pistas.length)
  };
  publicar(sala);
}
function calcularRanking(sala){
  const e = sala.est;
  if(e.modo === "equipos"){
    return e.equipos.map(eq => ({ n: eq, p: e.puntosEquipo[eq] })).sort((a,b) => b.p - a.p);
  }
  return Object.values(e.jugadores).map(j => ({ n: j.n, p: j.p })).sort((a,b) => b.p - a.p);
}

io.on("connection", socket => {

  socket.on("crear", (datos, ack) => {
    try{
      const { config, mazo } = datos || {};
      if(!config || !Array.isArray(mazo) || mazo.length === 0){
        return ack && ack({ error: "Configuración inválida." });
      }
      const code = genCodigo();
      const hostKey = genId("k");
      const est = {
        v: 1, fase: "lobby",
        modo: config.modo === "individual" ? "individual" : "equipos",
        equipos: config.modo === "equipos" ? (config.equipos || []).slice(0, 4) : [],
        config: {
          pen: Math.max(0, parseInt(config.pen, 10) || 0),
          doble: !!config.doble,
          total: mazo.length
        },
        jugadores: {}, puntosEquipo: {}, ronda: null, ranking: null
      };
      est.equipos.forEach(eq => est.puntosEquipo[eq] = 0);
      const sala = { code, hostKey, hostSid: socket.id, est, mazo, creada: Date.now() };
      salas.set(code, sala);
      conexiones.set(socket.id, { code, esHost: true });
      socket.join(code);
      ack && ack({ code, hostKey });
      publicar(sala);
      guardarEstado();
    }catch(e){ ack && ack({ error: "Error al crear la sala." }); }
  });

  socket.on("reclamar_host", ({ code, key }, ack) => {
    const sala = salas.get((code || "").toUpperCase());
    if(!sala || sala.hostKey !== key) return ack && ack({ error: "No se pudo recuperar la sala." });
    sala.hostSid = socket.id;
    conexiones.set(socket.id, { code: sala.code, esHost: true });
    socket.join(sala.code);
    ack && ack({ ok: true, estado: sala.est });
  });

  socket.on("pantalla_esperar", (_, ack) => {
    pantallasEsperando.add(socket.id);
    ack && ack({ ok: true });
  });

  socket.on("transmitir", (_, ack) => {
    const con = conexiones.get(socket.id);
    if(!con || !con.esHost) return ack && ack({ error: "No eres host." });
    const sala = salas.get(con.code);
    if(!sala) return ack && ack({ error: "Sala no encontrada." });
    let enviadas = 0;
    for(const sid of pantallasEsperando){
      const s = io.sockets.sockets.get(sid);
      if(s){
        s.emit("transmitir_sala", { code: sala.code });
        enviadas++;
      }
    }
    if(enviadas === 0) return ack && ack({ error: "No hay pantallas esperando. Abre /pantalla.html en la TV primero." });
    ack && ack({ ok: true, pantallas: enviadas });
  });

  socket.on("pantalla", ({ code }, ack) => {
    const sala = salas.get((code || "").toUpperCase());
    if(!sala) return ack && ack({ error: "No existe una sala con ese código." });
    pantallasEsperando.delete(socket.id);
    conexiones.set(socket.id, { code: sala.code, esHost: false, esPantalla: true });
    socket.join(sala.code);
    ack && ack({ ok: true, estado: sala.est });
  });

  socket.on("comprobar", ({ code }, ack) => {
    const sala = salas.get((code || "").toUpperCase());
    if(!sala) return ack && ack({ error: "No existe una sala con ese código." });
    ack && ack({ modo: sala.est.modo, equipos: sala.est.equipos });
  });

  socket.on("unirse", ({ code, nombre, equipo }, ack) => {
    const sala = salas.get((code || "").toUpperCase());
    if(!sala) return ack && ack({ error: "La sala ya no existe." });
    nombre = String(nombre || "").trim().slice(0, 20);
    if(!nombre) return ack && ack({ error: "Falta el nombre." });
    if(sala.est.modo === "equipos" && !sala.est.equipos.includes(equipo)){
      return ack && ack({ error: "Elige un equipo válido." });
    }
    // reconexión: mismo nombre recupera sus puntos
    let jugador = Object.values(sala.est.jugadores).find(j => j.n.toLowerCase() === nombre.toLowerCase());
    if(jugador){
      if(sala.est.modo === "equipos" && equipo) jugador.e = equipo;
    } else {
      jugador = { id: genId("j"), n: nombre, e: sala.est.modo === "equipos" ? equipo : null, p: 0 };
      sala.est.jugadores[jugador.id] = jugador;
    }
    conexiones.set(socket.id, { code: sala.code, playerId: jugador.id, esHost: false });
    socket.join(sala.code);
    ack && ack({ id: jugador.id, estado: sala.est });
    publicar(sala);
    guardarEstado();
  });

  socket.on("buzz", () => {
    const con = conexiones.get(socket.id);
    if(!con || con.esHost) return;
    const sala = salas.get(con.code);
    if(!sala) return;
    const r = sala.est.ronda;
    if(!r || r.resuelto || r.buzz || sala.est.fase !== "jugando") return;
    const jug = sala.est.jugadores[con.playerId];
    if(!jug) return;
    const bloqueado = sala.est.modo === "equipos" ? r.bloq.includes(jug.e) : r.bloq.includes(jug.id);
    if(bloqueado) return;
    r.buzz = { id: jug.id, n: jug.n, e: jug.e };   // primero en llegar, gana — atómico en el servidor
    publicar(sala);
  });

  socket.on("cmd", ({ a }) => {
    const con = conexiones.get(socket.id);
    if(!con || !con.esHost) return;
    const sala = salas.get(con.code);
    if(!sala || sala.hostSid !== socket.id) return;
    const e = sala.est, r = e.ronda;

    if(a === "empezar" && e.fase === "lobby" && Object.keys(e.jugadores).length > 0){
      e.fase = "jugando";
      nuevaRonda(sala, 0);
      guardarEstado();
      return;
    }
    if(e.fase !== "jugando" || !r) return;

    if(a === "pista" && !r.resuelto && !r.buzz) mostrarPista(sala);

    if(a === "correcto" && r.buzz && !r.resuelto){
      const b = r.buzz, pts = r.valor;
      if(e.modo === "equipos") e.puntosEquipo[b.e] += pts;
      else e.jugadores[b.id].p += pts;
      cerrarRonda(sala, { n: b.n, e: b.e, pts });
      guardarEstado();
    }
    if(a === "incorrecto" && r.buzz && !r.resuelto){
      const b = r.buzz;
      const castigo = e.config.pen * (r.doble ? 2 : 1);
      if(e.modo === "equipos"){ e.puntosEquipo[b.e] -= castigo; r.bloq.push(b.e); }
      else { e.jugadores[b.id].p -= castigo; r.bloq.push(b.id); }
      r.buzz = null;
      publicar(sala);
      guardarEstado();
    }
    if(a === "revelar" && !r.resuelto && !r.buzz) cerrarRonda(sala, null);

    if(a === "siguiente" && r.resuelto){
      if(r.i + 1 < e.config.total) nuevaRonda(sala, r.i + 1);
      else {
        e.fase = "final";
        e.ranking = calcularRanking(sala);
        e.ronda = null;
        publicar(sala);
      }
      guardarEstado();
    }
    if(a === "terminar"){
      e.fase = "final";
      e.ranking = calcularRanking(sala);
      e.ronda = null;
      publicar(sala);
      guardarEstado();
    }
    if(a === "cerrar"){
      io.to(sala.code).emit("sala_cerrada");
      salas.delete(sala.code);
      guardarEstado();
    }
  });

  socket.on("disconnect", () => { conexiones.delete(socket.id); pantallasEsperando.delete(socket.id); });
});

// limpieza de salas de más de 24 horas
setInterval(() => {
  const ahora = Date.now();
  let borradas = 0;
  for(const [code, sala] of salas){
    if(ahora - sala.creada > 24 * 3600 * 1000){ salas.delete(code); borradas++; }
  }
  if(borradas) guardarEstado();
}, 30 * 60 * 1000);

// auto-guardado cada 60 segundos
setInterval(guardarEstado, 60 * 1000);

// guardar antes de apagar (Railway envía SIGTERM al redeploy)
function apagar(){
  console.log("Guardando estado antes de cerrar...");
  guardarEstado();
  process.exit(0);
}
process.on("SIGTERM", apagar);
process.on("SIGINT", apagar);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("¿Quién Soy? escuchando en puerto " + PORT));
