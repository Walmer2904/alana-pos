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
  escucharVentasDeCaja, calcularTotales, refCajaActual, METODOS, NOMBRES_METODO
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
let historial = [];
let ultimoCierre = null;          // para imprimir desde el modal

protegerPagina((u) => {
  usuario = u;
  escucharCaja(alCambiarCaja);
  escucharHistorial();
});

// ------------------------------------------------------------
// Estado de la caja
// ------------------------------------------------------------
function alCambiarCaja(cierre) {
  cajaAbierta = cierre;
  if (dejarDeEscucharVentas) { dejarDeEscucharVentas(); dejarDeEscucharVentas = null; }

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

  dejarDeEscucharVentas = escucharVentasDeCaja(cierre.id, (ventas) => {
    totalesTurno = calcularTotales(ventas);
    dibujarResumen();
  });
}

function efectivoEsperado() {
  if (!cajaAbierta) return 0;
  return redondear((Number(cajaAbierta.montoInicial) || 0) + totalesTurno.porMetodo.efectivo);
}

function dibujarResumen() {
  kpiTotal.textContent = soles(totalesTurno.total);
  kpiNum.textContent = totalesTurno.numVentas;
  kpiEsperado.textContent = soles(efectivoEsperado());
  resumenMetodos.innerHTML = METODOS.map((m) => `
    <div class="indicador">
      <div class="rotulo">${NOMBRES_METODO[m]}</div>
      <div class="valor">${soles(totalesTurno.porMetodo[m])}</div>
    </div>`).join("");
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
  textoDiferencia.textContent = `Esperado: ${soles(efectivoEsperado())} (monto inicial + ventas en efectivo).`;
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

  const ok = await confirmar("¿Cerrar la caja? Después ya no se podrá vender hasta abrir una nueva.", "Cerrar caja");
  if (!ok) return;

  const cierreId = cajaAbierta.id;
  const montoInicial = Number(cajaAbierta.montoInicial) || 0;
  btnCerrar.disabled = true;
  try {
    // Recalcular con datos frescos del servidor (no solo los de pantalla)
    const snap = await getDocs(query(collection(db, "ventas"), where("cierreId", "==", cierreId)));
    const totales = calcularTotales(snap.docs.map((d) => d.data()));
    const esperado = redondear(montoInicial + totales.porMetodo.efectivo);
    const datosCierre = {
      estado: "cerrada",
      fechaCierre: serverTimestamp(),
      totalVentas: totales.total,
      totalPorMetodo: totales.porMetodo,
      numVentas: totales.numVentas,
      efectivoEsperado: esperado,
      efectivoContado: contado,
      diferencia: redondear(contado - esperado),
      usuarioCierre: usuario.nombre,
      usuarioCierreId: usuario.uid,
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
        <td>${escaparHTML(c.usuarioCierre || "—")}</td>
        <td class="num">${c.numVentas ?? 0}</td>
        <td class="num">${soles(c.totalVentas)}</td>
        <td class="num">${soles(c.efectivoEsperado)}</td>
        <td class="num">${soles(c.efectivoContado)}</td>
        <td class="num"><span class="etiqueta-estado ${info.clase === "cero" ? "verde" : info.clase === "sobrante" ? "mostaza" : "rojo"}">${info.corto}</span></td>
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
  const info = describirDiferencia(Number(c.diferencia) || 0);
  return `
    <div class="ticket">
      <h1>ALANA</h1>
      <p class="centro"><strong>REPORTE DE CIERRE DE CAJA</strong></p>
      <hr>
      <table>
        <tr><td>Apertura:</td><td class="num">${fechaHora(c.fechaApertura)}</td></tr>
        <tr><td>Abrió:</td><td class="num">${escaparHTML(c.usuarioApertura || "—")}</td></tr>
        <tr><td>Cierre:</td><td class="num">${fechaHora(c.fechaCierre)}</td></tr>
        <tr><td>Cerró:</td><td class="num">${escaparHTML(c.usuarioCierre || "—")}</td></tr>
      </table>
      <hr>
      <table>
        <tr><td>N.º de ventas</td><td class="num">${c.numVentas ?? 0}</td></tr>
        ${METODOS.map((m) => `<tr><td>${NOMBRES_METODO[m]}</td><td class="num">${soles(pm[m])}</td></tr>`).join("")}
        <tr class="total"><td>TOTAL VENDIDO</td><td class="num">${soles(c.totalVentas)}</td></tr>
      </table>
      <hr>
      <table>
        <tr><td>Monto inicial</td><td class="num">${soles(c.montoInicial)}</td></tr>
        <tr><td>+ Ventas efectivo</td><td class="num">${soles(pm.efectivo)}</td></tr>
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
