/* =====================================================================
   NeuroAdapAI - script.js
   Esto sirve para: detectar cómo usa la página una persona (mouse y
   scroll), decidir con reglas matemáticas si hay un patrón, y adaptar
   la página. Todo corre en el navegador, sin servidor ni API externa.
   Tiene 3 módulos: TelemetryCollector, InferenceEngine y UIAdapter.
   ===================================================================== */

/* ---------------------------------------------------------------------
   CONFIGURACIÓN
   Esto sirve para tener TODOS los números en un solo lugar. Si en el
   piloto hay que calibrar un umbral, se cambia aquí y nada más.
   b = línea base (puntaje 0), t = saturación (puntaje 1), w = peso.
   --------------------------------------------------------------------- */
const CONFIG = {
  umbralDisparo: 0.70,        // Esto sirve para decidir cuándo un patrón empieza a sospecharse
  umbralLiberacion: 0.50,     // Esto sirve para evitar que el estado parpadee (histéresis)
  muestrasConfirmacion: 3,    // Cuánta evidencia NUEVA se necesita para confirmar un patrón
  timeoutPendienteMs: 60000,  // Si no se confirma en 60 s, se descarta la sospecha
  intervaloEvaluacionMs: 2000,
  separacionOfertasMs: 120000, // Mínimo 2 minutos entre un aviso y otro
  descartesParaSuspender: 2,
  caducidadMemoriaMs: 30 * 24 * 60 * 60 * 1000, // 30 días

  margenClicPx: 40,           // Un clic a menos de 40 px de un objetivo cuenta como "dirigido"
  umbralScrollPx: 30,         // Movimientos de scroll menores a esto se ignoran
  ventanaPunteroMs: 120000,
  ventanaLecturaMs: 60000,
  ventanaInversionesMs: 15000,
  bloqueMinVisible: 0.25,

  puntero: {
    retry:       { b: 0.10, t: 0.40, w: 0.60, minClics: 8 },
    tortuosidad: { b: 1.30, t: 2.00, w: 0.40, minSegmentos: 8 }
  },
  lectura: {   // EXPERIMENTAL: hipótesis propia, sin fuente académica directa
    inversiones: { b: 2,    t: 6,    w: 0.60 },
    proporcion:  { b: 0.15, t: 0.50, w: 0.40 },
    minBloques: 3
  }
};

/* ---------------------------------------------------------------------
   MODO PRUEBA
   Esto sirve para que la detección sea rápida mientras probamos.
   Solo acorta tiempos y mínimos de muestras. NO toca las fórmulas
   (b, t, w ni los umbrales 0.70 / 0.50), así que el motor decide igual.
   Para volver a los valores reales: poner MODO_PRUEBA en false.
   --------------------------------------------------------------------- */
const MODO_PRUEBA = true;

if (MODO_PRUEBA) {
  CONFIG.intervaloEvaluacionMs = 500;     // evalúa cada medio segundo (antes 2 s)
  CONFIG.muestrasConfirmacion = 2;        // confirma con 2 muestras nuevas (antes 3)
  CONFIG.separacionOfertasMs = 5000;      // 5 s entre avisos (antes 2 min)
  CONFIG.timeoutPendienteMs = 30000;      // la sospecha dura 30 s (antes 60 s)
  CONFIG.puntero.retry.minClics = 4;      // basta con 4 clics (antes 8)
  CONFIG.puntero.tortuosidad.minSegmentos = 4;  // basta con 4 trayectos (antes 8)
  CONFIG.lectura.minBloques = 2;          // basta con ver 2 bloques (antes 3)
}

const CLASES = {
  motor: 'adapt-clics-grandes',
  texto: 'adapt-texto-grande',
  contraste: 'adapt-contraste-alto'
};

/* =====================================================================
   MÓDULO 2: InferenceEngine (funciones puras)
   Esto sirve para decidir si hay un patrón. NO toca la página ni el
   mouse: recibe números y devuelve un estado nuevo. Por eso se puede
   probar con datos inventados.
   ===================================================================== */

// Esto sirve para convertir una métrica en un puntaje de 0 a 1.
// Si no hay dato (null) devuelve null, y ese null contribuye 0 más abajo.
function normalizar(x, b, t) {
  if (x === null || x === undefined || Number.isNaN(x)) return null;
  return Math.min(1, Math.max(0, (x - b) / (t - b)));
}

// Esto sirve para sumar los puntajes con su peso. Un null suma 0 y los
// pesos NO se reparten de nuevo: la falta de datos nunca dispara nada.
function puntaje(items) {
  let p = 0;
  for (const it of items) {
    const s = normalizar(it.valor, it.b, it.t);
    if (s !== null) p += it.w * s;
  }
  return p;
}

function puntajePuntero(m) {
  const c = CONFIG.puntero;
  return puntaje([
    { valor: m.retryRate,          b: c.retry.b,       t: c.retry.t,       w: c.retry.w },
    { valor: m.tortuosidadMediana, b: c.tortuosidad.b, t: c.tortuosidad.t, w: c.tortuosidad.w }
  ]);
}

function puntajeLectura(m) {
  const c = CONFIG.lectura;
  return puntaje([
    { valor: m.inversiones,       b: c.inversiones.b, t: c.inversiones.t, w: c.inversiones.w },
    { valor: m.proporcionBloques, b: c.proporcion.b,  t: c.proporcion.t,  w: c.proporcion.w }
  ]);
}

// Esto sirve para crear el estado de arranque: todo en IDLE.
function estadoInicial() {
  const base = () => ({
    estado: 'IDLE', pendienteDesde: null, muestrasNuevas: 0,
    ultimaEvidencia: 0, puntaje: 0, suprimido: false
  });
  return { patrones: { lowPointerPrecision: base(), frequentReReading: base() } };
}

// Esto sirve para mover un patrón por la máquina de estados:
// IDLE -> PENDING -> TRIGGERED -> IDLE, con histéresis.
// "Evidencia nueva" evita contar dos veces los mismos clics.
function transicion(prev, puntajeActual, ahora, evidencia) {
  const ev = evidencia ?? 0;
  const sig = { ...prev, puntaje: puntajeActual };

  // Si el usuario ya descartó o resolvió este patrón, se queda quieto.
  if (prev.suprimido) {
    return { ...sig, estado: 'IDLE', pendienteDesde: null, muestrasNuevas: 0 };
  }

  if (prev.estado === 'IDLE') {
    if (puntajeActual >= CONFIG.umbralDisparo) {
      sig.estado = 'PENDING';
      sig.pendienteDesde = ahora;
      sig.muestrasNuevas = 0;
      sig.ultimaEvidencia = ev;
    }
  } else if (prev.estado === 'PENDING') {
    const caduco = ahora - prev.pendienteDesde > CONFIG.timeoutPendienteMs;
    if (puntajeActual <= CONFIG.umbralLiberacion || caduco) {
      sig.estado = 'IDLE';
      sig.pendienteDesde = null;
      sig.muestrasNuevas = 0;
    } else if (puntajeActual >= CONFIG.umbralDisparo && ev > prev.ultimaEvidencia) {
      sig.muestrasNuevas = prev.muestrasNuevas + 1;
      sig.ultimaEvidencia = ev;
      if (sig.muestrasNuevas >= CONFIG.muestrasConfirmacion) sig.estado = 'TRIGGERED';
    }
  } else if (prev.estado === 'TRIGGERED') {
    // Bajar de TRIGGERED solo cambia el reporte; nunca revierte una adaptación.
    if (puntajeActual <= CONFIG.umbralLiberacion) {
      sig.estado = 'IDLE';
      sig.pendienteDesde = null;
      sig.muestrasNuevas = 0;
    }
  }
  return sig;
}

// Esto sirve para evaluar UNA muestra de telemetría y devolver el estado nuevo.
function evaluar(estado, payload, ahora) {
  const pp = puntajePuntero(payload.puntero);
  const pl = puntajeLectura(payload.lectura);
  return {
    patrones: {
      lowPointerPrecision: transicion(estado.patrones.lowPointerPrecision, pp, ahora, payload.puntero.evidencia),
      frequentReReading:   transicion(estado.patrones.frequentReReading,   pl, ahora, payload.lectura.evidencia)
    }
  };
}

// Esto sirve para que el UIAdapter le cuente al motor qué decidió la persona.
// Cualquier respuesta suprime el patrón durante la sesión; RESET_ALL lo reinicia todo.
function retroalimentar(estado, patron, evento) {
  if (evento === 'RESET_ALL') return estadoInicial();
  const nuevo = { patrones: { ...estado.patrones } };
  if (nuevo.patrones[patron]) {
    nuevo.patrones[patron] = {
      ...nuevo.patrones[patron], estado: 'IDLE', suprimido: true,
      pendienteDesde: null, muestrasNuevas: 0
    };
  }
  return nuevo;
}

// Esto sirve para saber el perfil activo. Los perfiles NO son excluyentes.
function perfilesActivos(estado) {
  const activos = [];
  if (estado.patrones.lowPointerPrecision.estado === 'TRIGGERED') activos.push('ASSIST_MOTOR');
  if (estado.patrones.frequentReReading.estado === 'TRIGGERED') activos.push('ASSIST_READING');
  return activos.length ? activos : ['STANDARD'];
}

/* =====================================================================
   MÓDULO 1: TelemetryCollector
   Esto sirve para mirar qué hace la persona con el mouse y el scroll y
   convertirlo en números. No decide nada: solo mide y reporta.
   ===================================================================== */
class TelemetryCollector {
  constructor(alEmitir) {
    this.alEmitir = alEmitir;
    this.clics = [];          // clics dirigidos a un objetivo
    this.segmentos = [];      // trayectos de clic a clic
    this.ultimoPunto = null;
    this.rutaInicio = null;
    this.rutaLongitud = 0;
    this.evidenciaPuntero = 0;

    this.inversiones = [];    // cambios de dirección del scroll
    this.evidenciaLectura = 0;
    this.ultimoY = window.scrollY;
    this.ultimaDireccion = 0;
    this.bloquesVistos = new Set();
  }

  // Esto sirve para empezar a escuchar la página.
  iniciar() {
    document.addEventListener('mousemove', (e) => this.alMoverMouse(e), { passive: true });
    document.addEventListener('click', (e) => this.alHacerClic(e));
    window.addEventListener('scroll', () => this.alHacerScroll(), { passive: true });
    this.observarBloques();
    setInterval(() => this.emitir(), CONFIG.intervaloEvaluacionMs);
  }

  // Esto sirve para medir cuánto camino recorre el mouse (para la tortuosidad).
  alMoverMouse(e) {
    const p = { x: e.clientX, y: e.clientY };
    if (!this.ultimoPunto) { this.ultimoPunto = p; this.rutaInicio = p; return; }
    const d = Math.hypot(p.x - this.ultimoPunto.x, p.y - this.ultimoPunto.y);
    if (d < 2) return; // se ignora el temblor mínimo
    this.rutaLongitud += d;
    this.ultimoPunto = p;
  }

  // Esto sirve para saber qué tan lejos cayó un clic del objetivo más cercano.
  // Devuelve 0 si cayó dentro del objetivo.
  distanciaAlObjetivo(x, y) {
    let mejor = Infinity;
    document.querySelectorAll('[data-nai-target]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      mejor = Math.min(mejor, Math.hypot(dx, dy));
    });
    return mejor;
  }

  // Esto sirve para registrar clics. Cuenta como REINTENTO si el clic
  // cayó fuera del objetivo, o si repite otro clic muy cerca y muy rápido.
  alHacerClic(e) {
    const x = e.clientX, y = e.clientY, t = Date.now();
    const dist = this.distanciaAlObjetivo(x, y);
    if (dist > CONFIG.margenClicPx) return; // no iba dirigido a nada
    const fallo = dist > 0;
    const previo = this.clics[this.clics.length - 1];
    const repeticion = previo && (t - previo.t) < 1500 && Math.hypot(x - previo.x, y - previo.y) < 50;
    this.clics.push({ t, x, y, reintento: fallo || !!repeticion });
    this.evidenciaPuntero++;
    this.cerrarSegmento(x, y, t);
  }

  // Esto sirve para calcular la tortuosidad del trayecto:
  // camino real recorrido / distancia en línea recta (1 = recto perfecto).
  cerrarSegmento(x, y, t) {
    if (this.rutaInicio) {
      const recta = Math.hypot(x - this.rutaInicio.x, y - this.rutaInicio.y);
      if (recta >= 50 && this.rutaLongitud > 0) {
        this.segmentos.push({ t, valor: Math.max(1, this.rutaLongitud / recta) });
        this.evidenciaPuntero++;
      }
    }
    this.rutaInicio = { x, y };
    this.ultimoPunto = { x, y };
    this.rutaLongitud = 0;
  }

  // Esto sirve para saber qué bloque de texto está en el centro de la pantalla.
  bloqueEnCentro() {
    const mitad = window.innerHeight / 2;
    for (const b of document.querySelectorAll('[data-nai-block]')) {
      const r = b.getBoundingClientRect();
      if (r.top <= mitad && r.bottom >= mitad) return b.dataset.naiBlock;
    }
    return null;
  }

  // Esto sirve para contar inversiones: cuando el scroll cambia de dirección.
  alHacerScroll() {
    const y = window.scrollY;
    const d = y - this.ultimoY;
    if (Math.abs(d) < CONFIG.umbralScrollPx) return;
    const dir = d > 0 ? 1 : -1;
    if (this.ultimaDireccion !== 0 && dir !== this.ultimaDireccion) {
      this.inversiones.push({ t: Date.now(), bloque: this.bloqueEnCentro() });
      this.evidenciaLectura++;
    }
    this.ultimaDireccion = dir;
    this.ultimoY = y;
  }

  // Esto sirve para saber cuántos bloques de texto ya vio la persona.
  observarBloques() {
    const obs = new IntersectionObserver((entradas) => {
      entradas.forEach((en) => {
        if (en.isIntersecting) this.bloquesVistos.add(en.target.dataset.naiBlock);
      });
    }, { threshold: CONFIG.bloqueMinVisible });
    document.querySelectorAll('[data-nai-block]').forEach((b) => obs.observe(b));
  }

  static mediana(valores) {
    const o = [...valores].sort((a, b) => a - b);
    const m = Math.floor(o.length / 2);
    return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
  }

  // Esto sirve para armar el paquete de números. Si no hay suficientes
  // muestras, la métrica va como null (así no puede disparar nada).
  emitir() {
    const ahora = Date.now();
    this.clics = this.clics.filter((c) => ahora - c.t <= CONFIG.ventanaPunteroMs);
    this.segmentos = this.segmentos.filter((s) => ahora - s.t <= CONFIG.ventanaPunteroMs);
    this.inversiones = this.inversiones.filter((i) => ahora - i.t <= CONFIG.ventanaLecturaMs);

    const cp = CONFIG.puntero;
    const retryRate = this.clics.length >= cp.retry.minClics
      ? this.clics.filter((c) => c.reintento).length / this.clics.length : null;
    const tortuosidadMediana = this.segmentos.length >= cp.tortuosidad.minSegmentos
      ? TelemetryCollector.mediana(this.segmentos.map((s) => s.valor)) : null;

    const lecturaValida = this.bloquesVistos.size >= CONFIG.lectura.minBloques;
    const inv15 = this.inversiones.filter((i) => ahora - i.t <= CONFIG.ventanaInversionesMs).length;
    const bloquesConInversion = new Set(this.inversiones.filter((i) => i.bloque).map((i) => i.bloque)).size;

    this.alEmitir({
      timestamp: ahora,
      puntero: { retryRate, tortuosidadMediana, evidencia: this.evidenciaPuntero },
      lectura: {
        inversiones: lecturaValida ? inv15 : null,
        proporcionBloques: lecturaValida ? bloquesConInversion / this.bloquesVistos.size : null,
        evidencia: this.evidenciaLectura
      }
    });
  }
}

/* =====================================================================
   MÓDULO 3: UIAdapter
   Esto sirve para cambiar la página. Aplica o propone adaptaciones y
   AVISA a la persona. Nunca roba el foco, y siempre se puede deshacer.
   ===================================================================== */
class UIAdapter {
  constructor(alResponder) {
    this.alResponder = alResponder; // canal de vuelta hacia el motor
    this.atendidos = new Set();
    this.avisoActual = null;
    this.ultimaOferta = 0;
    this.descartesSeguidos = 0;
    this.suspendido = false;
    this.inyectarEstilos();
    this.cargarPreferencias();
  }

  // Esto sirve para que el aviso se vea bien sin tocar styles.css.
  inyectarEstilos() {
    const s = document.createElement('style');
    s.textContent = `
      .nai-aviso { position: fixed; left: 16px; right: 16px; bottom: 16px; max-width: 420px;
        margin: 0 auto; padding: 14px 16px; border-radius: 10px; z-index: 100;
        background: #fff; color: #3b2a20; border: 2px solid #6f4e37;
        box-shadow: 0 4px 16px rgba(0,0,0,.25); font-size: 16px; }
      .nai-aviso p { margin: 0 0 10px; }
      .nai-aviso .nai-fila { display: flex; gap: 8px; flex-wrap: wrap; }
      .nai-aviso button { padding: 8px 16px; font-size: 15px; }
      .nai-panel { position: fixed; top: 70px; right: 8px; z-index: 100; padding: 8px 10px;
        background: rgba(0,0,0,.85); color: #9f9; font: 12px monospace; border-radius: 6px;
        white-space: pre; display: none; }`;
    document.head.appendChild(s);
  }

  // Esto sirve para recibir el estado del motor y decidir si hay algo que hacer.
  recibir(estado) {
    for (const [nombre, p] of Object.entries(estado.patrones)) {
      if (p.estado === 'TRIGGERED' && !this.atendidos.has(nombre)) this.intentar(nombre);
    }
  }

  // Esto sirve para aplicar las reglas de cortesía antes de mostrar algo.
  intentar(nombre) {
    if (this.suspendido || this.avisoActual) return;
    if (Date.now() - this.ultimaOferta < CONFIG.separacionOfertasMs) return;
    const foco = document.activeElement;
    if (foco && /^(INPUT|TEXTAREA|SELECT)$/.test(foco.tagName)) return; // no interrumpir al escribir

    // Prioridad cero: si el sistema operativo ya pidió más contraste, no ofrecemos nada.
    if (nombre === 'frequentReReading' && window.matchMedia('(prefers-contrast: more)').matches) {
      this.atendidos.add(nombre);
      return;
    }
    this.atendidos.add(nombre);
    this.ultimaOferta = Date.now();
    if (nombre === 'lowPointerPrecision') this.aplicarMotor(nombre);
    else this.ofrecerLectura(nombre);
  }

  // ADAPTACIÓN INOCUA: se aplica sola, con aviso y opción de deshacer.
  aplicarMotor(nombre) {
    document.body.classList.add(CLASES.motor);
    this.mostrarAviso(
      'Notamos que a veces cuesta acertar los botones y enlaces, así que los hicimos más grandes.',
      [
        { texto: 'Deshacer', accion: () => {
            document.body.classList.remove(CLASES.motor);
            this.alResponder(nombre, 'UNDONE');
        } },
        { texto: 'Mantener', accion: () => {
            this.guardarPreferencias([CLASES.motor]);
            this.alResponder(nombre, 'ACCEPTED');
        } }
      ]
    );
  }

  // ADAPTACIÓN ESTRUCTURAL: solo se OFRECE, no se aplica sin permiso.
  ofrecerLectura(nombre) {
    this.mostrarAviso(
      '¿Quieres que el texto sea más grande y con más contraste para leer con más comodidad?',
      [
        { texto: 'Aceptar', accion: () => {
            document.body.classList.add(CLASES.texto, CLASES.contraste);
            this.guardarPreferencias([CLASES.texto, CLASES.contraste]);
            this.descartesSeguidos = 0;
            this.alResponder(nombre, 'ACCEPTED');
        } },
        { texto: 'No, gracias', accion: () => {
            this.descartesSeguidos++;
            if (this.descartesSeguidos >= CONFIG.descartesParaSuspender) this.suspendido = true;
            this.alResponder(nombre, 'DISMISSED');
        } }
      ]
    );
  }

  // Esto sirve para mostrar un aviso que se anuncia con lector de pantalla
  // (aria-live), sin robar el foco y sin cerrarse solo.
  mostrarAviso(texto, botones) {
    const caja = document.createElement('div');
    caja.className = 'nai-aviso';
    caja.setAttribute('role', 'status');
    caja.setAttribute('aria-live', 'polite');
    const p = document.createElement('p');
    p.textContent = texto;
    const fila = document.createElement('div');
    fila.className = 'nai-fila';
    botones.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.texto;
      btn.addEventListener('click', () => { b.accion(); this.cerrarAviso(); });
      fila.appendChild(btn);
    });
    caja.append(p, fila);
    document.body.appendChild(caja);
    this.avisoActual = caja;
  }

  cerrarAviso() {
    if (this.avisoActual) this.avisoActual.remove();
    this.avisoActual = null;
  }

  // Esto sirve para recordar lo que la persona eligió MANTENER.
  // Solo se guarda qué cambio se aplicó, NUNCA el patrón que lo causó.
  guardarPreferencias(clases) {
    try {
      const previo = this.leerPreferencias();
      const todas = Array.from(new Set([...(previo ? previo.clases : []), ...clases]));
      localStorage.setItem('nai.preferencias', JSON.stringify({ clases: todas, guardadoEn: Date.now() }));
    } catch (e) { /* si el navegador bloquea el almacenamiento, no pasa nada */ }
  }

  leerPreferencias() {
    try {
      const crudo = localStorage.getItem('nai.preferencias');
      if (!crudo) return null;
      const datos = JSON.parse(crudo);
      if (Date.now() - datos.guardadoEn > CONFIG.caducidadMemoriaMs) {
        localStorage.removeItem('nai.preferencias');
        return null;
      }
      return datos;
    } catch (e) { return null; }
  }

  // Esto sirve para volver a aplicar lo que la persona guardó en otra visita.
  cargarPreferencias() {
    const datos = this.leerPreferencias();
    if (datos) datos.clases.forEach((c) => document.body.classList.add(c));
  }

  // Esto sirve para dejar todo como al inicio (pruebas y botón de reinicio).
  reiniciar() {
    Object.values(CLASES).forEach((c) => document.body.classList.remove(c));
    try { localStorage.removeItem('nai.preferencias'); } catch (e) {}
    this.cerrarAviso();
    this.atendidos.clear();
    this.descartesSeguidos = 0;
    this.suspendido = false;
    this.ultimaOferta = 0;
  }
}

/* =====================================================================
   PRUEBAS: los 8 casos sintéticos del documento (+1 extra)
   Esto sirve para comprobar que el motor se equivoca poco ANTES de
   conectarlo al mouse. Se corre solo al abrir la página en modo prueba,
   o desde la consola con: NeuroAdap.probar()
   ===================================================================== */
function probar() {
  const base = estadoInicial();
  const pay = (r, t, ev = 0, ahora = 0) => ({
    timestamp: ahora,
    puntero: { retryRate: r, tortuosidadMediana: t, evidencia: ev },
    lectura: { inversiones: null, proporcionBloques: null, evidencia: 0 }
  });
  const conPuntero = (pat) => ({ patrones: { ...base.patrones, lowPointerPrecision: pat } });
  const triggered = conPuntero({ ...base.patrones.lowPointerPrecision, estado: 'TRIGGERED' });
  const filas = [];
  const reg = (caso, obtenido, esperado, r, t) => {
    filas.push({
      caso, P: puntajePuntero({ retryRate: r, tortuosidadMediana: t }).toFixed(2),
      obtenido, esperado, resultado: obtenido === esperado ? 'OK' : 'FALLA'
    });
  };
  const est = (s) => s.patrones.lowPointerPrecision.estado;

  reg('1. Sin señal',               est(evaluar(base, pay(0.08, 1.25))), 'IDLE', 0.08, 1.25);
  reg('2. Señal leve',              est(evaluar(base, pay(0.20, 1.50))), 'IDLE', 0.20, 1.50);
  reg('3. Zona de histéresis',      est(evaluar(base, pay(0.30, 1.70))), 'IDLE', 0.30, 1.70);
  reg('4. Primera confirmación',    est(evaluar(base, pay(0.40, 1.50, 10, 0))), 'PENDING', 0.40, 1.50);

  let s = evaluar(base, pay(0.40, 1.50, 10, 0), 0);
  s = evaluar(s, pay(0.40, 1.50, 11, 2000), 2000);
  s = evaluar(s, pay(0.40, 1.50, 12, 4000), 4000);
  s = evaluar(s, pay(0.40, 1.50, 13, 6000), 6000);
  reg('5. Muestras nuevas',         est(s), 'TRIGGERED', 0.40, 1.50);

  reg('6. Retry null no dispara',   est(evaluar(base, pay(null, 2.50))), 'IDLE', null, 2.50);
  reg('7. TRIGGERED con P=0.55',    est(evaluar(triggered, pay(0.25, 1.7375))), 'TRIGGERED', 0.25, 1.7375);
  reg('8. TRIGGERED baja a P=0.48', est(evaluar(triggered, pay(0.20, 1.79))), 'IDLE', 0.20, 1.79);

  // Extra: la MISMA evidencia repetida no debe confirmar el patrón.
  let r = evaluar(base, pay(0.40, 1.50, 10, 0), 0);
  for (let i = 1; i <= 4; i++) r = evaluar(r, pay(0.40, 1.50, 10, i * 2000), i * 2000);
  reg('9. Evidencia repetida',      est(r), 'PENDING', 0.40, 1.50);

  console.table(filas);
  const fallas = filas.filter((f) => f.resultado === 'FALLA').length;
  console.log(fallas === 0 ? 'Todos los casos pasan.' : fallas + ' caso(s) fallan.');
  return fallas === 0;
}

/* =====================================================================
   ARRANQUE: conecta los tres módulos
   Esto sirve para que todo funcione en cadena:
   mouse/scroll -> Collector -> Engine -> UIAdapter -> página
   ===================================================================== */
(function arrancar() {
  let estado = estadoInicial();

  const adaptador = new UIAdapter((patron, evento) => {
    estado = retroalimentar(estado, patron, evento);
  });

  // Panel de depuración (Ctrl+Shift+D). Sirve para ver los puntajes en vivo.
  const panel = document.createElement('div');
  panel.className = 'nai-panel';
  document.body.appendChild(panel);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    }
  });

  const colector = new TelemetryCollector((payload) => {
    estado = evaluar(estado, payload, payload.timestamp);
    adaptador.recibir(estado);
    const f = (v) => (v === null ? 'null' : Number(v).toFixed(2));
    const pp = estado.patrones.lowPointerPrecision, pl = estado.patrones.frequentReReading;
    panel.textContent =
      'PUNTERO  P=' + pp.puntaje.toFixed(2) + ' ' + pp.estado + '\n' +
      '  retry=' + f(payload.puntero.retryRate) + ' tort=' + f(payload.puntero.tortuosidadMediana) + '\n' +
      'LECTURA  P=' + pl.puntaje.toFixed(2) + ' ' + pl.estado + '\n' +
      '  inv=' + f(payload.lectura.inversiones) + ' prop=' + f(payload.lectura.proporcionBloques) + '\n' +
      'PERFIL: ' + perfilesActivos(estado).join(', ');
  });
  colector.iniciar();

  // Esto sirve para usar las pruebas y el reinicio desde la consola del navegador.
  window.NeuroAdap = {
    probar,
    estado: () => estado,
    reiniciar: () => { adaptador.reiniciar(); estado = retroalimentar(estado, null, 'RESET_ALL'); }
  };

  // MODO PRUEBA SIN CONSOLA
  // Esto sirve para ver todo directo en la página: el panel de puntajes
  // aparece solo, las pruebas del motor corren al cargar y hay un botón
  // para reiniciar entre una demostración y otra.
  if (MODO_PRUEBA) {
    console.log('NeuroAdapAI en MODO PRUEBA: detección acelerada');

    // El panel se muestra desde el inicio y no estorba a los clics
    panel.style.display = 'block';
    panel.style.pointerEvents = 'none';

    // Esto sirve para correr los 9 casos de prueba al abrir la página
    // y mostrar el resultado en una etiqueta visible
    const etiqueta = document.createElement('div');
    etiqueta.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:100;padding:6px 10px;' +
      'font:12px monospace;border-radius:6px;color:#fff;pointer-events:none;';
    let pasan = false;
    try { pasan = probar(); } catch (e) { pasan = false; }
    etiqueta.textContent = pasan ? 'Pruebas del motor: 9/9 OK' : 'Pruebas del motor: HAY FALLAS (ver consola)';
    etiqueta.style.background = pasan ? '#2e7d32' : '#c62828';
    document.body.appendChild(etiqueta);

    // Esto sirve para dejar todo como al inicio con un clic:
    // quita adaptaciones, borra lo guardado y limpia los clics y scrolls acumulados
    const reinicio = document.createElement('button');
    reinicio.type = 'button';
    reinicio.textContent = 'Reiniciar prueba';
    reinicio.style.cssText = 'position:fixed;left:8px;bottom:44px;z-index:100;padding:6px 12px;' +
      'font-size:13px;background:#444;color:#fff;border:none;border-radius:6px;cursor:pointer;';
    reinicio.addEventListener('click', () => {
      window.NeuroAdap.reiniciar();
      colector.clics = [];
      colector.segmentos = [];
      colector.inversiones = [];
    });
    document.body.appendChild(reinicio);
  }
})();
