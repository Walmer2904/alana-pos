// ============================================================
// comun.js — Funciones compartidas por todas las páginas internas
// ------------------------------------------------------------
// - protegerPagina(): verifica sesión y rol, dibuja la barra superior.
// - Formato de soles y fechas en zona horaria America/Lima.
// - Utilidades pequeñas: escapar HTML, avisos (toast), modales.
// ============================================================

import {
  auth, db, onAuthStateChanged, signOut, doc, getDoc,
  collection, onSnapshot, query, where, runTransaction, serverTimestamp
} from "./firebase.js";

// ------------------------------------------------------------
// Datos del negocio (cambiar aquí si cambian)
// ------------------------------------------------------------
export const RUC = "15605130906";
export const TELEFONO = "930 822 405";

export const ZONA = "America/Lima";
// Perú no usa horario de verano: siempre es UTC-5.
const DESFASE_LIMA_HORAS = 5;

// Datos del usuario logueado (se completa en protegerPagina).
export let usuarioActual = null;

// ------------------------------------------------------------
// Protección de páginas
// ------------------------------------------------------------
/**
 * Verifica que haya sesión iniciada y lee el rol desde "usuarios/{uid}".
 * @param {(usuario: {uid, email, nombre, rol}) => void} callback  Se ejecuta cuando todo está OK.
 * @param {boolean} soloAdmin  Si es true y el usuario no es admin, lo manda a Ventas.
 */
export function protegerPagina(callback, soloAdmin = false) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Sin sesión: volver al login.
      window.location.replace("index.html");
      return;
    }

    try {
      const snap = await getDoc(doc(db, "usuarios", user.uid));
      if (!snap.exists()) {
        mostrarErrorFatal(
          "Tu usuario no tiene un perfil configurado. Pide al administrador que cree tu documento en la colección \"usuarios\"."
        );
        return;
      }
      const datos = snap.data();
      usuarioActual = {
        uid: user.uid,
        email: user.email,
        nombre: datos.nombre || user.email,
        rol: datos.rol === "admin" ? "admin" : "cajero"
      };
    } catch (error) {
      console.error("Error leyendo el perfil:", error);
      mostrarErrorFatal("No se pudo leer tu perfil. Revisa tu conexión a internet y recarga la página.");
      return;
    }

    if (soloAdmin && usuarioActual.rol !== "admin") {
      window.location.replace("ventas.html");
      return;
    }

    dibujarBarra(usuarioActual);
    document.body.classList.remove("cargando");
    callback(usuarioActual);
  });
}

/** Muestra un mensaje de error a pantalla completa con botón para salir. */
function mostrarErrorFatal(mensaje) {
  document.body.classList.remove("cargando");
  document.body.innerHTML = `
    <main class="error-fatal">
      <h1 class="marca">Alana</h1>
      <p>${escaparHTML(mensaje)}</p>
      <button class="btn btn-primario" id="btnSalirError">Cerrar sesión</button>
    </main>`;
  document.getElementById("btnSalirError").addEventListener("click", cerrarSesion);
}

export async function cerrarSesion() {
  await signOut(auth);
  window.location.replace("index.html");
}

// ------------------------------------------------------------
// Barra superior con menú
// ------------------------------------------------------------
const MENU = [
  { href: "ventas.html", texto: "Ventas", soloAdmin: false },
  { href: "creditos.html", texto: "Créditos", soloAdmin: false },
  { href: "productos.html", texto: "Productos", soloAdmin: true },
  { href: "reportes.html", texto: "Reportes", soloAdmin: true },
  { href: "caja.html", texto: "Caja", soloAdmin: false }
];

function dibujarBarra(usuario) {
  const barra = document.getElementById("barra");
  if (!barra) return;

  const paginaActual = location.pathname.split("/").pop() || "index.html";
  const enlaces = MENU
    .filter((m) => !m.soloAdmin || usuario.rol === "admin")
    .map((m) => {
      const activo = m.href === paginaActual ? ' aria-current="page"' : "";
      return `<a href="${m.href}"${activo}>${m.texto}</a>`;
    })
    .join("");

  barra.innerHTML = `
    <a class="barra-marca" href="ventas.html" aria-label="Alana - ir a Ventas">
      <img src="img/logo.png" alt=""><span>Alana</span>
    </a>
    <button class="barra-toggle" id="btnMenu" aria-expanded="false" aria-controls="barraMenu">Menú</button>
    <div class="barra-menu" id="barraMenu">
      <nav aria-label="Menú principal">${enlaces}</nav>
      <div class="barra-usuario">
        <span class="barra-nombre">${escaparHTML(usuario.nombre)}
          <small>${usuario.rol === "admin" ? "Administrador" : "Cajero"}</small></span>
        <button class="btn btn-claro btn-chico" id="btnCerrarSesion">Cerrar sesión</button>
      </div>
    </div>`;

  document.getElementById("btnCerrarSesion").addEventListener("click", cerrarSesion);

  // Menú desplegable en celular
  const btnMenu = document.getElementById("btnMenu");
  btnMenu.addEventListener("click", () => {
    const abierto = barra.classList.toggle("abierta");
    btnMenu.setAttribute("aria-expanded", String(abierto));
  });
}

// ------------------------------------------------------------
// Formato de dinero (soles)
// ------------------------------------------------------------
const formatoNumero = new Intl.NumberFormat("es-PE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/** 12.5 -> "S/ 12.50" */
export function soles(monto) {
  return "S/ " + formatoNumero.format(Number(monto) || 0);
}

/** Redondea a 2 decimales evitando errores de coma flotante. */
export function redondear(monto) {
  return Math.round((Number(monto) + Number.EPSILON) * 100) / 100;
}

// ------------------------------------------------------------
// Fechas en zona horaria de Lima
// ------------------------------------------------------------
/** Convierte Timestamp de Firestore, Date o null a Date. */
export function aFecha(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor;
  if (typeof valor.toDate === "function") return valor.toDate();
  return new Date(valor);
}

const fmtFechaHora = new Intl.DateTimeFormat("es-PE", {
  timeZone: ZONA, day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: true
});
const fmtFecha = new Intl.DateTimeFormat("es-PE", {
  timeZone: ZONA, day: "2-digit", month: "2-digit", year: "numeric"
});
const fmtHora = new Intl.DateTimeFormat("es-PE", {
  timeZone: ZONA, hour: "2-digit", minute: "2-digit", hour12: true
});
// "en-CA" da el formato AAAA-MM-DD, útil como clave de día.
const fmtClaveDia = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit"
});

export function fechaHora(valor) {
  const f = aFecha(valor);
  return f ? fmtFechaHora.format(f) : "—";
}
export function soloFecha(valor) {
  const f = aFecha(valor);
  return f ? fmtFecha.format(f) : "—";
}
export function soloHora(valor) {
  const f = aFecha(valor);
  return f ? fmtHora.format(f) : "—";
}

/** Devuelve "AAAA-MM-DD" del día en Lima para una fecha dada (por defecto hoy). */
export function claveDiaLima(valor = new Date()) {
  return fmtClaveDia.format(aFecha(valor));
}

/** "AAAA-MM-DD" (día de Lima) -> Date del inicio de ese día (00:00 en Lima). */
export function inicioDiaLima(clave) {
  const [a, m, d] = clave.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d, DESFASE_LIMA_HORAS, 0, 0));
}

/** Suma días a una clave "AAAA-MM-DD" y devuelve otra clave. */
export function sumarDias(clave, dias) {
  const [a, m, d] = clave.split("-").map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + dias));
  return f.toISOString().slice(0, 10);
}

/** Día de la semana de una clave (0 = domingo ... 6 = sábado). */
export function diaSemana(clave) {
  const [a, m, d] = clave.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

// ------------------------------------------------------------
// Utilidades de interfaz
// ------------------------------------------------------------
/** Evita que textos ingresados por usuarios rompan el HTML. */
export function escaparHTML(texto) {
  return String(texto ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Aviso flotante breve. tipo: "ok" | "error" | "info" */
export function aviso(mensaje, tipo = "ok") {
  let contenedor = document.getElementById("avisos");
  if (!contenedor) {
    contenedor = document.createElement("div");
    contenedor.id = "avisos";
    contenedor.className = "avisos";
    contenedor.setAttribute("role", "status");
    contenedor.setAttribute("aria-live", "polite");
    document.body.appendChild(contenedor);
  }
  const el = document.createElement("div");
  el.className = `aviso aviso-${tipo}`;
  el.textContent = mensaje;
  contenedor.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/** Traduce errores de Firestore a mensajes entendibles. */
export function mensajeError(error) {
  const codigo = error?.code || "";
  if (codigo.includes("permission-denied")) return "No tienes permiso para realizar esta acción.";
  if (codigo.includes("unavailable")) return "Sin conexión con el servidor. Revisa tu internet.";
  if (codigo.includes("failed-precondition")) return "Falta un índice en Firestore. Revisa la consola del navegador (F12) para el enlace de creación.";
  return error?.message || "Ocurrió un error inesperado.";
}

// ------------------------------------------------------------
// Modales (usa el elemento nativo <dialog>)
// ------------------------------------------------------------
export function abrirModal(id) {
  const dlg = document.getElementById(id);
  if (dlg && !dlg.open) dlg.showModal();
}
export function cerrarModal(id) {
  const dlg = document.getElementById(id);
  if (dlg && dlg.open) dlg.close();
}

/** Confirmación con modal propio (más legible que confirm()). Devuelve Promise<boolean>. */
export function confirmar(mensaje, textoAceptar = "Aceptar", peligro = false) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal modal-chico";
    dlg.innerHTML = `
      <form method="dialog" class="modal-cuerpo">
        <p class="confirmar-texto">${escaparHTML(mensaje)}</p>
        <div class="modal-acciones">
          <button value="no" class="btn btn-claro">Cancelar</button>
          <button value="si" class="btn ${peligro ? "btn-peligro" : "btn-primario"}">${escaparHTML(textoAceptar)}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => {
      resolve(dlg.returnValue === "si");
      dlg.remove();
    });
    dlg.showModal();
  });
}

// ------------------------------------------------------------
// Impresión en ticketera (80 mm)
// ------------------------------------------------------------
/**
 * Imprime un HTML en formato ticket. Usa el contenedor #areaImpresion
 * y la clase "imprimir-ticket" en <body> (ver @media print en estilos.css).
 */
export function imprimirTicket(html) {
  let area = document.getElementById("areaImpresion");
  if (!area) {
    area = document.createElement("div");
    area.id = "areaImpresion";
    area.className = "area-impresion";
    document.body.appendChild(area);
  }
  area.innerHTML = html;
  document.body.classList.add("imprimir-ticket");
  const limpiar = () => {
    document.body.classList.remove("imprimir-ticket");
    window.removeEventListener("afterprint", limpiar);
  };
  window.addEventListener("afterprint", limpiar);
  window.print();
}

/**
 * Encabezado común de todos los tickets: marca, RUC y teléfono.
 * @param {string} subtitulo  Texto opcional en negrita debajo (ej. "VENTA AL CRÉDITO").
 */
export function encabezadoTicket(subtitulo = "") {
  return `
    <h1>Alana</h1>
    <p class="centro">RUC: ${RUC}</p>
    <p class="centro">Comida rápida · Cel. ${TELEFONO}</p>
    ${subtitulo ? `<hr><p class="centro"><strong>${subtitulo}</strong></p>` : ""}`;
}

export const NOMBRES_METODO = {
  efectivo: "Efectivo",
  yape: "Yape",
  plin: "Plin",
  tarjeta: "Tarjeta",
  credito: "Crédito"
};
// Métodos con los que ENTRA dinero (los que suman en caja y reportes).
// "credito" no está aquí a propósito: un crédito no es dinero cobrado.
export const METODOS = ["efectivo", "yape", "plin", "tarjeta"];

// ------------------------------------------------------------
// Caja abierta (compartida entre todas las PCs)
// ------------------------------------------------------------
// El documento "config/cajaActual" guarda { cierreId } de la caja
// abierta (o null). Se modifica SOLO dentro de transacciones al abrir
// o cerrar caja, lo que garantiza que haya una sola caja abierta.
export const refCajaActual = () => doc(db, "config", "cajaActual");

/**
 * Escucha en tiempo real la caja abierta.
 * @param {(cierre: object|null) => void} callback  Recibe {id, ...datos} o null si no hay caja abierta.
 */
export function escucharCaja(callback) {
  let dejarDeEscucharCierre = null;
  let idActual = undefined;

  onSnapshot(refCajaActual(), (snap) => {
    const cierreId = snap.exists() ? snap.data().cierreId || null : null;
    if (cierreId === idActual) return;
    idActual = cierreId;

    if (dejarDeEscucharCierre) { dejarDeEscucharCierre(); dejarDeEscucharCierre = null; }
    if (!cierreId) { callback(null); return; }

    dejarDeEscucharCierre = onSnapshot(doc(db, "cierres", cierreId), (s) => {
      const datos = s.exists() ? { id: s.id, ...s.data() } : null;
      callback(datos && datos.estado === "abierta" ? datos : null);
    }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
  }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
}

/**
 * Escucha en tiempo real las ventas de una caja (cierre), de la más
 * reciente a la más antigua. Consulta por un solo campo: no requiere índice.
 * Devuelve la función para dejar de escuchar.
 */
export function escucharVentasDeCaja(cierreId, callback) {
  const q = query(collection(db, "ventas"), where("cierreId", "==", cierreId));
  return onSnapshot(q, (snap) => {
    // "estimate": mientras el servidor confirma la hora, usa la hora local
    const ventas = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    ventas.sort((a, b) => (aFecha(b.fecha)?.getTime() || 0) - (aFecha(a.fecha)?.getTime() || 0));
    callback(ventas);
  }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
}

/**
 * Escucha en tiempo real los cobros de créditos registrados en una caja.
 * Consulta por un solo campo (cierreId): no requiere índice.
 */
export function escucharCobrosDeCaja(cierreId, callback) {
  const q = query(collection(db, "cobros"), where("cierreId", "==", cierreId));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })));
  }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
}

const metodosEnCero = () => ({ efectivo: 0, yape: 0, plin: 0, tarjeta: 0 });

/**
 * Calcula los totales de DINERO COBRADO (lo usan Caja y Reportes).
 * Regla: una venta al crédito NO cuenta como venta mientras no se pague.
 *  - Ventas normales no anuladas: suman al total y a su método.
 *  - Ventas al crédito: NO suman; solo se informan en "creditosOtorgados".
 *  - Cobros de créditos: suman al total y al método con que pagaron.
 *    Un crédito cuenta como 1 venta recién cuando se paga completo.
 * @param {Array} ventas  Documentos de "ventas".
 * @param {Array} cobros  Documentos de "cobros" (opcional).
 */
export function calcularTotales(ventas, cobros = []) {
  const porMetodo = metodosEnCero();          // ventas normales + cobros
  const cobrosPorMetodo = metodosEnCero();    // solo cobros de créditos
  let totalVentasDirectas = 0;
  let numVentas = 0;
  let creditosCantidad = 0;
  let creditosMonto = 0;

  for (const v of ventas) {
    if (v.anulada) continue;
    const monto = Number(v.total) || 0;
    if (v.metodoPago === "credito") {
      creditosCantidad++;
      creditosMonto += monto;
      continue;
    }
    totalVentasDirectas += monto;
    numVentas++;
    if (v.metodoPago in porMetodo) porMetodo[v.metodoPago] += monto;
  }

  let totalCobros = 0;
  let creditosCompletados = 0;
  for (const c of cobros) {
    const monto = Number(c.monto) || 0;
    totalCobros += monto;
    if (c.metodo in porMetodo) {
      porMetodo[c.metodo] += monto;
      cobrosPorMetodo[c.metodo] += monto;
    }
    if (c.completaCredito) creditosCompletados++;
  }

  for (const m of METODOS) {
    porMetodo[m] = redondear(porMetodo[m]);
    cobrosPorMetodo[m] = redondear(cobrosPorMetodo[m]);
  }
  return {
    total: redondear(totalVentasDirectas + totalCobros),
    numVentas: numVentas + creditosCompletados,
    porMetodo,
    totalVentasDirectas: redondear(totalVentasDirectas),
    cobros: { total: redondear(totalCobros), cantidad: cobros.length, porMetodo: cobrosPorMetodo },
    creditosOtorgados: { cantidad: creditosCantidad, monto: redondear(creditosMonto) }
  };
}

/**
 * Anula una venta al crédito y su crédito, en una sola transacción.
 * No se permite si el crédito ya tiene pagos registrados.
 * Lanza Error("TIENE_PAGOS") o Error("YA_NO_PENDIENTE") según el caso.
 */
export async function anularVentaCredito(ventaId, creditoId, nombreUsuario) {
  const refVenta = doc(db, "ventas", ventaId);
  const refCredito = doc(db, "creditos", creditoId);
  await runTransaction(db, async (tx) => {
    const credito = await tx.get(refCredito);
    if (credito.exists()) {
      const datos = credito.data();
      if ((datos.pagos || []).length > 0) throw new Error("TIENE_PAGOS");
      if (datos.estado !== "pendiente") throw new Error("YA_NO_PENDIENTE");
    }
    tx.update(refVenta, { anulada: true, anuladaPor: nombreUsuario, anuladaEn: serverTimestamp() });
    if (credito.exists()) {
      tx.update(refCredito, { estado: "anulado", saldoPendiente: 0, anuladoPor: nombreUsuario, anuladoEn: serverTimestamp() });
    }
  });
}

/** Mensaje claro para los errores de anularVentaCredito. */
export function mensajeAnulacion(error) {
  if (error.message === "TIENE_PAGOS") return "No se puede anular: este crédito ya tiene pagos registrados.";
  if (error.message === "YA_NO_PENDIENTE") return "Este crédito ya no está pendiente (fue pagado o anulado).";
  return mensajeError(error);
}

/** Valida DNI peruano: exactamente 8 dígitos. */
export function dniValido(dni) {
  return /^\d{8}$/.test(String(dni || ""));
}
