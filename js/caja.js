// ============================================================
// caja.js — Apertura, seguimiento y cierre de caja
// ------------------------------------------------------------
// Regla de oro: solo UNA caja abierta a la vez para todas las PCs.
// Se logra con el documento "config/cajaActual" y transacciones:
// si dos PCs intentan abrir al mismo tiempo, Firestore reintenta la
// transacción y la segunda verá que ya hay una caja abierta.
// ============================================================

import {
  db, collection, doc, getDocs, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, runTransaction
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, fechaHora, escaparHTML, aviso, confirmar,
  mensajeError, abrirModal, cerrarModal, imprimirTicket, escucharCaja,
  escucharVentasDeCaja, escucharCobrosDeCaja, calcularTotales, refCajaActual,
  METODOS, NOMBRES_METODO, encabezadoTicket, escucharEgresosDeCaja, calcularEgresos
} from "./comun.js";

// Elementos
const estadoCaja = document.getElementById("estadoCaja");
const zonaApertura = document.getElementById("zonaApertura");
const zonaTurno = document.getElementById("zonaTurno");
const formApertura = document.getElementById("formApertura");
const inMontoInicial = document.getElementById("montoInicial");
const btnAbrir = document.getElementById("btnAbrir");
const infoApertura = document.getElementById("infoApertura");
const kpiTotal = document.getElementById("kpiTotal");
const kpiNum = document.getElementById("kpiNum");
const kpiInicial = document.getElementById("kpiInicial");
const kpiEsperado = document.getElementById("kpiEsperado");
const resumenMetodos = document.getElementById("resumenMetodos");
const resumenCreditos = document.getElementById("resumenCreditos");
const resumenEgresos = document.getElementById("resumenEgresos");
const tablaEgresos = document.getElementById("tablaEgresos");
const formCierre = document.getElementById("formCierre");
const inContado = document.getElementById("efectivoContado");
const inObservacion = document.getElementById("observacion");
const cajaDiferencia = document.getElementById("diferencia");
const textoDiferencia = document.getElementById("textoDiferencia");
const btnCerrar = document.getElementById("btnCerrar");
const tablaHistorial = document.getElementById("tablaHistorial");

// Estado
let usuario = null;
let cajaAbierta = null;          // {id, ...datos} o null
let totalesTurno = calcularTotales([]);
let dejarDeEscucharVentas = null;
let dejarDeEscucharCobros = null;
let ventasTurno = [];             // ventas de la caja abierta
let cobrosTurno = [];             // cobros de créditos en la caja abierta
let dejarDeEscucharEgresos = null;
let egresosTurno = [];            // compras de insumos / pagos a trabajadores con efectivo de caja
let totalesEgresos = calcularEgresos([]);
let historial = [];
let ultimoCierre = null;          // para imprimir desde el modal

// El admin ve todo. El cajero hace CIERRE CIEGO: no ve montos del turno ni
// el efectivo esperado hasta cerrar, y no ve el historial de cierres
// (las reglas de Firestore tampoco le dejan leer cierres ya cerrados).
const esAdmin = () => usuario?.rol === "admin";

protegerPagina((u) => {
  usuario = u;
  escucharCaja(alCambiarCaja);
  if (esAdmin()) escucharHistorial();
});

// ------------------------------------------------------------
// Estado de la caja
// ------------------------------------------------------------
function alCambiarCaja(cierre) {
  cajaAbierta = cierre;
  if (dejarDeEscucharVentas) { dejarDeEscucharVentas(); dejarDeEscucharVentas = null; }
  if (dejarDeEscucharCobros) { dejarDeEscucharCobros(); dejarDeEscucharCobros = null; }
  if (dejarDeEscucharEgresos) { dejarDeEscucharEgresos(); dejarDeEscucharEgresos = null; }
  ventasTurno = [];
  cobrosTurno = [];
  egresosTurno = [];

  if (!cierre) {
    estadoCaja.innerHTML = '<span class="etiqueta-estado rojo">Caja cerrada</span>';
    zonaApertura.classList.remove("oculto");
    zonaTurno.classList.add("oculto");
    return;
  }

  estadoCaja.innerHTML = '<span class="etiqueta-estado verde">Caja abierta</span>';
  zonaApertura.classList.add("oculto");
  zonaTurno.classList.remove("oculto");
  infoApertura.textContent =
    `Abierta el ${fechaHora(cierre.fechaApertura)} por ${cierre.usuarioApertura || "—"}.`;
  kpiInicial.textContent = soles(cierre.montoInicial);

  // Ventas y cobros de créditos de esta caja, en tiempo real
  dejarDeEscucharVentas = escucharVentasDeCaja(cierre.id, (ventas) => {
    ventasTurno = ventas;
    recalcular();
  });
  dejarDeEscucharCobros = escucharCobrosDeCaja(cierre.id, (cobros) => {
    cobrosTurno = cobros;
    recalcular();
  });
  dejarDeEscucharEgresos = escucharEgresosDeCaja(cierre.id, (egresos) => {
    egresosTurno = egresos.sort((a, b) => (a.fecha?.toMillis?.() || 0) - (b.fecha?.toMillis?.() || 0));
    recalcular();
  });
}

function recalcular() {
  totalesTurno = calcularTotales(ventasTurno, cobrosTurno);
  totalesEgresos = calcularEgresos(egresosTurno);
  dibujarResumen();
}

/**
 * Efectivo esperado = monto inicial + ventas en efectivo + cobros de créditos
 * en efectivo − egresos pagados con efectivo de la caja.
 * (porMetodo.efectivo ya incluye ventas y cobros en efectivo)
 */
function efectivoEsperado() {
  if (!cajaAbierta) return 0;
  return redondear((Number(cajaAbierta.montoInicial) || 0) + totalesTurno.porMetodo.efectivo - totalesEgresos.total);
}

function dibujarResumen() {
  kpiNum.textContent = totalesTurno.numVentas;
  // Cajero: los montos ni siquiera se escriben en la página (cierre ciego).
  if (!esAdmin()) return;
  kpiTotal.textContent = soles(totalesTurno.total);
  kpiEsperado.textContent = soles(efectivoEsperado());
  resumenMetodos.innerHTML = METODOS.map((m) => `
    <div class="indicador">
      <div class="rotulo">${NOMBRES_METODO[m]}</div>
      <div class="valor">${soles(totalesTurno.porMetodo[m])}</div>
    </div>`).join("");

  // Créditos: otorgados (solo informativo) y cobros (ya incluidos arriba)
  const co = totalesTurno.creditosOtorgados;
  const cb = totalesTurno.cobros;
  resumenCreditos.innerHTML = `
    <div class="indicador informativo">
      <div class="rotulo">Créditos otorgados en el turno</div>
      <div class="valor">${soles(co.monto)}</div>
      <small>${co.cantidad} crédito(s) · solo informativo, no suma</small>
    </div>
    <div class="indicador">
      <div class="rotulo">Cobros de créditos</div>
      <div class="valor">${soles(cb.total)}</div>
      <small>${cb.cantidad} pago(s) · ya incluidos en los totales</small>
    </div>
    ${METODOS.map((m) => `
      <div class="indicador">
        <div class="rotulo">Cobros · ${NOMBRES_METODO[m]}</div>
        <div class="valor">${soles(cb.porMetodo[m])}</div>
      </div>`).join("")}`;

  // Egresos: salen del efectivo de la caja
  const eg = totalesEgresos;
  resumenEgresos.innerHTML = `
    <div class="indicador ${eg.total > 0 ? "egreso" : ""}">
      <div class="rotulo">Total egresos (efectivo)</div>
      <div class="valor">− ${soles(eg.total)}</div>
      <small>${eg.cantidad} egreso(s) · se restan del efectivo esperado</small>
    </div>
    <div class="indicador"><div class="rotulo">Compras de insumos</div><div class="valor">${soles(eg.insumos)}</div></div>
    <div class="indicador"><div class="rotulo">Pagos a trabajadores</div><div class="valor">${soles(eg.trabajadores)}</div></div>`;
  tablaEgresos.innerHTML = egresosTurno.length
    ? egresosTurno.map((e) => `
        <tr>
          <td>${fechaHora(e.fecha)}</td>
          <td>${e.tipo === "insumo" ? "Insumo" : "Trabajador"}</td>
          <td>${escaparHTML(e.descripcion)}</td>
          <td class="num">${soles(e.monto)}</td>
          <td>${escaparHTML(e.usuarioNombre || "")}</td>
        </tr>`).join("")
    : '<tr><td colspan="5" class="vacio">Sin egresos en este turno.</td></tr>';
  actualizarDiferencia();
}

// ------------------------------------------------------------
// Apertura
// ------------------------------------------------------------
formApertura.addEventListener("submit", async (e) => {
  e.preventDefault();
  const montoInicial = redondear(parseFloat(inMontoInicial.value || "0"));
  if (!Number.isFinite(montoInicial) || montoInicial < 0) {
    aviso("Ingresa un monto inicial válido (0 o más).", "error");
    inMontoInicial.focus();
    return;
  }

  btnAbrir.disabled = true;
  try {
    await runTransaction(db, async (tx) => {
      const cfg = await tx.get(refCajaActual());
      const idPrevio = cfg.exists() ? cfg.data().cierreId : null;
      if (idPrevio) {
        const previo = await tx.get(doc(db, "cierres", idPrevio));
        if (previo.exists() && previo.data().estado === "abierta") {
          throw new Error("YA_ABIERTA");
        }
      }
      const nuevo = doc(collection(db, "cierres"));
      tx.set(nuevo, {
        estado: "abierta",
        fechaApertura: serverTimestamp(),
        fechaCierre: null,
        montoInicial,
        usuarioApertura: usuario.nombre,
        usuarioAperturaId: usuario.uid
      });
      tx.set(refCajaActual(), { cierreId: nuevo.id, actualizadoEn: serverTimestamp() });
    });
    aviso("Caja abierta. ¡Buen turno!");
    inMontoInicial.value = "0";
  } catch (error) {
    if (error.message === "YA_ABIERTA") {
      aviso("Ya hay una caja abierta (posiblemente desde la otra PC).", "info");
    } else {
      console.error(error);
      aviso(mensajeError(error), "error");
    }
  } finally {
    btnAbrir.disabled = false;
  }
});

// ------------------------------------------------------------
// Cierre
// ------------------------------------------------------------
inContado.addEventListener("input", actualizarDiferencia);

function actualizarDiferencia() {
  if (!esAdmin()) return;   // cierre ciego: el cajero no ve la diferencia antes de cerrar
  const valor = inContado.value.trim();
  cajaDiferencia.className = "diferencia";
  if (valor === "") {
    cajaDiferencia.textContent = "—";
    textoDiferencia.textContent = "Ingresa el efectivo contado para ver la diferencia.";
    return;
  }
  const dif = redondear(parseFloat(valor) - efectivoEsperado());
  const info = describirDiferencia(dif);
  cajaDiferencia.textContent = info.texto;
  cajaDiferencia.classList.add(info.clase);
  textoDiferencia.textContent = `Esperado: ${soles(efectivoEsperado())} (monto inicial + ventas y cobros en efectivo − egresos).`;
}

function describirDiferencia(dif) {
  if (dif === 0) return { clase: "cero", texto: "Cuadra exacto · S/ 0.00", corto: "Cuadra" };
  if (dif > 0) return { clase: "sobrante", texto: `Sobrante · ${soles(dif)}`, corto: `+${soles(dif)}` };
  return { clase: "faltante", texto: `Faltante · ${soles(-dif)}`, corto: `−${soles(-dif)}` };
}

formCierre.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!cajaAbierta) return;

  const contado = redondear(parseFloat(inContado.value));
  if (inContado.value.trim() === "" || !Number.isFinite(contado) || contado < 0) {
    aviso("Ingresa el efectivo contado.", "error");
    inContado.focus();
    return;
  }

  const ok = await confirmar(
    esAdmin()
      ? "¿Cerrar la caja? Después ya no se podrá vender hasta abrir una nueva."
      : `Vas a declarar ${soles(contado)} de efectivo contado. Revisa bien: después de cerrar no se puede cambiar. ¿Cerrar la caja?`,
    "Cerrar caja");
  if (!ok) return;

  const cierreId = cajaAbierta.id;
  const montoInicial = Number(cajaAbierta.montoInicial) || 0;
  btnCerrar.disabled = true;
  try {
    // Recalcular con datos frescos del servidor (no solo los de pantalla)
    const [snapVentas, snapCobros, snapEgresos] = await Promise.all([
      getDocs(query(collection(db, "ventas"), where("cierreId", "==", cierreId))),
      getDocs(query(collection(db, "cobros"), where("cierreId", "==", cierreId))),
      getDocs(query(collection(db, "egresos"), where("cierreId", "==", cierreId)))
    ]);
    const totales = calcularTotales(
      snapVentas.docs.map((d) => d.data()),
      snapCobros.docs.map((d) => d.data())
    );
    const listaEgresos = snapEgresos.docs.map((d) => d.data())
      .sort((a, b) => (a.fecha?.toMillis?.() || 0) - (b.fecha?.toMillis?.() || 0));
    const egresos = calcularEgresos(listaEgresos);
    // Efectivo esperado: inicial + ventas y cobros en efectivo − egresos en efectivo
    const esperado = redondear(montoInicial + totales.porMetodo.efectivo - egresos.total);
    const datosCierre = {
      estado: "cerrada",
      fechaCierre: serverTimestamp(),
      totalVentas: totales.total,              // dinero cobrado (ventas + cobros de créditos)
      totalPorMetodo: totales.porMetodo,
      numVentas: totales.numVentas,
      creditosOtorgados: totales.creditosOtorgados,   // informativo: { cantidad, monto }
      cobrosCreditos: {                               // ya incluidos en totalVentas
        total: totales.cobros.total,
        cantidad: totales.cobros.cantidad,
        ...totales.cobros.porMetodo
      },
      egresos: {                                      // salieron del efectivo de la caja
        total: egresos.total,
        cantidad: egresos.cantidad,
        insumos: egresos.insumos,
        trabajadores: egresos.trabajadores,
        detalle: listaEgresos.map((e) => ({
          tipo: e.tipo,
          descripcion: e.descripcion,
          monto: Number(e.monto) || 0,
          usuarioNombre: e.usuarioNombre || ""
        }))
      },
      efectivoEsperado: esperado,
      efectivoContado: contado,
      diferencia: redondear(contado - esperado),
      usuarioCierre: usuario.nombre,
      usuarioCierreId: usuario.uid,
      rolCierre: usuario.rol,                         // "admin" o "cajero" (cierre ciego)
      observacion: inObservacion.value.trim()
    };

    await runTransaction(db, async (tx) => {
      const cfg = await tx.get(refCajaActual());
      const ref = doc(db, "cierres", cierreId);
      const actual = await tx.get(ref);
      if (!actual.exists() || actual.data().estado !== "abierta") throw new Error("YA_CERRADA");
      tx.update(ref, datosCierre);
      if (cfg.exists() && cfg.data().cierreId === cierreId) {
        tx.set(refCajaActual(), { cierreId: null, actualizadoEn: serverTimestamp() });
      }
    });

    ultimoCierre = { ...cajaAbierta, ...datosCierre, fechaCierre: new Date() };
    inContado.value = "";
    inObservacion.value = "";
    mostrarModalCerrada(ultimoCierre);
  } catch (error) {
    if (error.message === "YA_CERRADA") {
      aviso("Esta caja ya fue cerrada desde otra PC.", "info");
    } else {
      console.error(error);
      aviso(mensajeError(error), "error");
    }
  } finally {
    btnCerrar.disabled = false;
  }
});

function mostrarModalCerrada(c) {
  const info = describirDiferencia(c.diferencia);
  document.getElementById("resumenCerrada").innerHTML = `
    <dt>Total vendido</dt><dd>${soles(c.totalVentas)}</dd>
    <dt>N.º de ventas</dt><dd>${c.numVentas}</dd>
    <dt>Cobros de créditos (incluidos)</dt><dd>${soles(c.cobrosCreditos?.total)}</dd>
    <dt>Créditos otorgados (informativo)</dt><dd>${c.creditosOtorgados?.cantidad ?? 0} · ${soles(c.creditosOtorgados?.monto)}</dd>
    <dt>Egresos en efectivo</dt><dd>− ${soles(c.egresos?.total)}</dd>
    <dt>Efectivo esperado</dt><dd>${soles(c.efectivoEsperado)}</dd>
    <dt>Efectivo contado</dt><dd>${soles(c.efectivoContado)}</dd>
    <dt>Diferencia</dt><dd><span class="diferencia ${info.clase}" style="font-size:1rem;padding:.2em .6em">${info.texto}</span></dd>`;
  abrirModal("modalCerrada");
}

document.getElementById("btnCerrarModal").addEventListener("click", () => cerrarModal("modalCerrada"));
document.getElementById("btnImprimirCierre").addEventListener("click", () => {
  if (ultimoCierre) imprimirTicket(htmlReporteCierre(ultimoCierre));
});

// ------------------------------------------------------------
// Historial (últimos 50 cierres)
// ------------------------------------------------------------
function escucharHistorial() {
  const q = query(collection(db, "cierres"), orderBy("fechaApertura", "desc"), limit(50));
  onSnapshot(q, (snap) => {
    historial = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.estado === "cerrada");
    dibujarHistorial();
  }, (error) => {
    console.error(error);
    aviso(mensajeError(error), "error");
  });
}

function dibujarHistorial() {
  if (historial.length === 0) {
    tablaHistorial.innerHTML = '<tr><td colspan="9" class="vacio">Todavía no hay cierres registrados.</td></tr>';
    return;
  }
  tablaHistorial.innerHTML = historial.map((c) => {
    const info = describirDiferencia(Number(c.diferencia) || 0);
    return `
      <tr>
        <td>${fechaHora(c.fechaApertura)}</td>
        <td>${fechaHora(c.fechaCierre)}</td>
        <td>${escaparHTML(c.usuarioCierre || "—")}${c.rolCierre ? `<br><small class="texto-gris">${c.rolCierre === "admin" ? "Administrador" : "Cajero"}</small>` : ""}</td>
        <td class="num">${c.numVentas ?? 0}</td>
        <td class="num">${soles(c.totalVentas)}</td>
        <td class="num">${soles(c.efectivoEsperado)}</td>
        <td class="num">${soles(c.efectivoContado)}</td>
        <td class="num"><span class="etiqueta-estado ${info.clase === "cero" ? "verde" : info.clase === "sobrante" ? "amarillo" : "rojo"}">${info.corto}</span></td>
        <td><button class="btn btn-claro btn-chico" data-imprimir="${c.id}">Imprimir</button></td>
      </tr>`;
  }).join("");
}

tablaHistorial.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-imprimir]");
  if (!btn) return;
  const c = historial.find((h) => h.id === btn.dataset.imprimir);
  if (c) imprimirTicket(htmlReporteCierre(c));
});

// ------------------------------------------------------------
// Reporte de cierre para ticketera 80 mm
// ------------------------------------------------------------
function htmlReporteCierre(c) {
  const pm = c.totalPorMetodo || {};
  const cb = c.cobrosCreditos || {};
  const co = c.creditosOtorgados || {};
  const eg = c.egresos || {};   // cierres antiguos no tienen egresos
  const info = describirDiferencia(Number(c.diferencia) || 0);
  return `
    <div class="ticket">
      ${encabezadoTicket("REPORTE DE CIERRE DE CAJA")}
      <hr>
      <table>
        <tr><td>Apertura:</td><td class="num">${fechaHora(c.fechaApertura)}</td></tr>
        <tr><td>Abrió:</td><td class="num">${escaparHTML(c.usuarioApertura || "—")}</td></tr>
        <tr><td>Cierre:</td><td class="num">${fechaHora(c.fechaCierre)}</td></tr>
        <tr><td>Cerró:</td><td class="num">${escaparHTML(c.usuarioCierre || "—")}${c.rolCierre === "cajero" ? " (cajero, cierre ciego)" : ""}</td></tr>
      </table>
      <hr>
      <table>
        <tr><td>N.º de ventas</td><td class="num">${c.numVentas ?? 0}</td></tr>
        ${METODOS.map((m) => `<tr><td>${NOMBRES_METODO[m]}</td><td class="num">${soles(pm[m])}</td></tr>`).join("")}
        <tr class="total"><td>TOTAL VENDIDO</td><td class="num">${soles(c.totalVentas)}</td></tr>
      </table>
      <hr>
      <p><strong>COBROS DE CRÉDITOS</strong> (incluidos arriba)</p>
      <table>
        ${METODOS.map((m) => `<tr><td>${NOMBRES_METODO[m]}</td><td class="num">${soles(cb[m])}</td></tr>`).join("")}
        <tr><td>Total cobros (${cb.cantidad ?? 0})</td><td class="num">${soles(cb.total)}</td></tr>
      </table>
      <hr>
      <p><strong>CRÉDITOS OTORGADOS</strong> (no suman)</p>
      <table>
        <tr><td>Cantidad</td><td class="num">${co.cantidad ?? 0}</td></tr>
        <tr><td>Monto fiado</td><td class="num">${soles(co.monto)}</td></tr>
      </table>
      <hr>
      <p><strong>EGRESOS</strong> (pagados con efectivo de caja)</p>
      <table>
        ${(eg.detalle || []).map((e) => `
          <tr><td>${escaparHTML(e.descripcion)}</td><td class="num">${soles(e.monto)}</td></tr>`).join("")
          || '<tr><td colspan="2">Sin egresos</td></tr>'}
        <tr><td>Insumos</td><td class="num">${soles(eg.insumos)}</td></tr>
        <tr><td>Trabajadores</td><td class="num">${soles(eg.trabajadores)}</td></tr>
        <tr class="total"><td>Total egresos</td><td class="num">${soles(eg.total)}</td></tr>
      </table>
      <hr>
      <table>
        <tr><td>Monto inicial</td><td class="num">${soles(c.montoInicial)}</td></tr>
        <tr><td>+ Efectivo cobrado</td><td class="num">${soles(pm.efectivo)}</td></tr>
        <tr><td>− Egresos</td><td class="num">${soles(eg.total)}</td></tr>
        <tr><td>Efectivo esperado</td><td class="num">${soles(c.efectivoEsperado)}</td></tr>
        <tr><td>Efectivo contado</td><td class="num">${soles(c.efectivoContado)}</td></tr>
        <tr class="total"><td>Diferencia</td><td class="num">${info.corto}</td></tr>
      </table>
      ${c.observacion ? `<hr><p>Obs.: ${escaparHTML(c.observacion)}</p>` : ""}
      <hr>
      <p class="centro">Impreso: ${fechaHora(new Date())}</p>
      <br><br>
      <p class="centro">______________________<br>Firma</p>
    </div>`;
}
