// ============================================================
// trabajadores.js — Trabajadores y sus pagos (solo admin)
// ------------------------------------------------------------
// - Trabajadores en tiempo real; se DESACTIVAN, nunca se eliminan.
// - Pagos en "pagosTrabajadores" (historial, nunca se borra).
// - Si el pago sale del efectivo de la caja abierta, se crea además un
//   egreso de caja en la misma transacción.
// - Comprobante de pago en ticket de 80 mm con línea de firma.
// ============================================================

import {
  db, collection, doc, getDocs, query, where, onSnapshot, serverTimestamp,
  Timestamp, runTransaction
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, fechaHora, soloFecha, escaparHTML, aviso,
  mensajeError, abrirModal, cerrarModal, imprimirTicket, escucharCaja,
  verificarCajaEnTx, crearEgresoEnTx, encabezadoTicket, claveDiaLima,
  inicioDiaLima, sumarDias, diaSemana, dniValido, errorDni, prepararCampoDni
} from "./comun.js";

const TIPOS_PAGO = { diario: "Diario", semanal: "Semanal", quincenal: "Quincenal", mensual: "Mensual" };
const CONCEPTOS = { sueldo: "Sueldo", adelanto: "Adelanto", bono: "Bono", otro: "Otro" };
const METODOS_PAGO = { efectivo: "Efectivo", yape: "Yape", plin: "Plin", transferencia: "Transferencia" };
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre"];

// Elementos
const tabla = document.getElementById("tablaTrabajadores");
const chkInactivos = document.getElementById("verInactivos");
const kpiMes = document.getElementById("kpiMes");
const kpiActivos = document.getElementById("kpiActivos");

const formTrabajador = document.getElementById("formTrabajador");
const inNombre = document.getElementById("trNombre");
const inDni = document.getElementById("trDni");
const inCargo = document.getElementById("trCargo");
const inTipoPago = document.getElementById("trTipoPago");
const inMonto = document.getElementById("trMonto");
const inIngreso = document.getElementById("trIngreso");
const inActivo = document.getElementById("trActivo");
const errorTrabajador = document.getElementById("errorTrabajador");

const formPago = document.getElementById("formPago");
const inPgMonto = document.getElementById("pgMonto");
const inPgConcepto = document.getElementById("pgConcepto");
const inPgPeriodo = document.getElementById("pgPeriodo");
const inPgMetodo = document.getElementById("pgMetodo");
const inPgObservacion = document.getElementById("pgObservacion");
const chkPgCaja = document.getElementById("pgCaja");
const pgCajaInfo = document.getElementById("pgCajaInfo");
const errorPago = document.getElementById("errorPago");

const formHistorial = document.getElementById("formHistorial");
const inHistDesde = document.getElementById("histDesde");
const inHistHasta = document.getElementById("histHasta");
const tablaHistorial = document.getElementById("tablaHistorial");

// Estado
let usuario = null;
let cajaAbierta = null;
let trabajadores = [];
let pagosMes = [];           // pagos del mes actual (tiempo real)
let editandoId = null;
let trabajadorActual = null; // trabajador del pago/historial abierto
let ultimoPago = null;       // para imprimir
let pagosHistorial = [];

const refrescarDni = prepararCampoDni(inDni, document.getElementById("contadorDniTr"));

protegerPagina((u) => {
  usuario = u;
  escucharCaja((cierre) => { cajaAbierta = cierre; actualizarOpcionCaja(); });
  escucharTrabajadores();
  escucharPagosDelMes();
}, true);

document.querySelectorAll("[data-cerrar]").forEach((b) =>
  b.addEventListener("click", () => cerrarModal(b.dataset.cerrar))
);

// ------------------------------------------------------------
// Datos en tiempo real
// ------------------------------------------------------------
function escucharTrabajadores() {
  onSnapshot(collection(db, "trabajadores"), (snap) => {
    trabajadores = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    dibujar();
  }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
}

/** Pagos desde el día 1 del mes actual (hora de Lima). Un solo campo: sin índice. */
function escucharPagosDelMes() {
  const hoy = claveDiaLima();
  const [a, m] = hoy.split("-").map(Number);
  document.getElementById("rotuloMes").textContent = `Pagado en ${MESES[m - 1]}`;
  const inicioMes = Timestamp.fromDate(inicioDiaLima(`${a}-${String(m).padStart(2, "0")}-01`));
  const q = query(collection(db, "pagosTrabajadores"), where("fecha", ">=", inicioMes));
  onSnapshot(q, (snap) => {
    pagosMes = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    dibujar();
  }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
}

chkInactivos.addEventListener("change", dibujar);

function pagadoEnMes(trabajadorId) {
  return redondear(pagosMes.filter((p) => p.trabajadorId === trabajadorId)
    .reduce((s, p) => s + (Number(p.monto) || 0), 0));
}

function dibujar() {
  const activos = trabajadores.filter((t) => t.activo !== false);
  kpiActivos.textContent = activos.length;
  kpiMes.textContent = soles(pagosMes.reduce((s, p) => s + (Number(p.monto) || 0), 0));

  const lista = trabajadores.filter((t) => chkInactivos.checked || t.activo !== false);
  if (lista.length === 0) {
    tabla.innerHTML = `<tr><td colspan="7" class="vacio">${trabajadores.length ? "No hay trabajadores activos." : "Aún no hay trabajadores. Agrega el primero con \"+ Nuevo trabajador\"."}</td></tr>`;
    return;
  }
  tabla.innerHTML = lista.map((t) => {
    const activo = t.activo !== false;
    return `
      <tr>
        <td><strong>${escaparHTML(t.nombre)}</strong><br><small class="texto-gris">${escaparHTML(t.cargo || "—")}${t.fechaIngreso ? ` · desde ${soloFecha(t.fechaIngreso)}` : ""}</small></td>
        <td>${escaparHTML(t.dni)}</td>
        <td>${TIPOS_PAGO[t.tipoPago] || "—"}</td>
        <td class="num">${soles(t.montoAcordado)}</td>
        <td class="num"><strong>${soles(pagadoEnMes(t.id))}</strong></td>
        <td>${activo ? '<span class="etiqueta-estado verde">Activo</span>' : '<span class="etiqueta-estado">Inactivo</span>'}</td>
        <td>
          <div class="acciones-fila">
            ${activo ? `<button class="btn btn-primario btn-chico" data-accion="pagar" data-id="${t.id}">Registrar pago</button>` : ""}
            <button class="btn btn-claro btn-chico" data-accion="historial" data-id="${t.id}">Historial</button>
            <button class="btn btn-claro btn-chico" data-accion="editar" data-id="${t.id}">Editar</button>
            <button class="btn ${activo ? "btn-peligro" : "btn-claro"} btn-chico" data-accion="estado" data-id="${t.id}">${activo ? "Desactivar" : "Activar"}</button>
          </div>
        </td>
      </tr>`;
  }).join("");
}

tabla.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-accion]");
  if (!btn) return;
  const t = trabajadores.find((x) => x.id === btn.dataset.id);
  if (!t) return;
  if (btn.dataset.accion === "pagar") abrirPago(t);
  if (btn.dataset.accion === "historial") abrirHistorial(t);
  if (btn.dataset.accion === "editar") abrirFormulario(t);
  if (btn.dataset.accion === "estado") {
    try {
      const ref = doc(db, "trabajadores", t.id);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("El trabajador no existe.");
        tx.update(ref, { activo: t.activo === false });
      });
      aviso(t.activo === false ? "Trabajador activado." : "Trabajador desactivado (sus pagos se conservan).");
    } catch (error) {
      console.error(error);
      aviso(mensajeError(error), "error");
    }
  }
});

// ------------------------------------------------------------
// Agregar / editar trabajador
// ------------------------------------------------------------
document.getElementById("btnNuevo").addEventListener("click", () => abrirFormulario(null));

function abrirFormulario(t) {
  editandoId = t ? t.id : null;
  document.getElementById("tituloTrabajador").textContent = t ? "Editar trabajador" : "Nuevo trabajador";
  inNombre.value = t?.nombre || "";
  inDni.value = t?.dni || "";
  refrescarDni();
  inCargo.value = t?.cargo || "";
  inTipoPago.value = t?.tipoPago || "semanal";
  inMonto.value = t?.montoAcordado ?? "";
  inIngreso.value = t?.fechaIngreso ? claveDiaLima(t.fechaIngreso) : claveDiaLima();
  inActivo.checked = t ? t.activo !== false : true;
  errorTrabajador.classList.add("oculto");
  abrirModal("modalTrabajador");
  inNombre.focus();
}

formTrabajador.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombre = inNombre.value.trim().replace(/\s+/g, " ");
  const dni = inDni.value.trim();
  const monto = redondear(parseFloat(inMonto.value));
  const error = (t, campo) => { errorTrabajador.textContent = t; errorTrabajador.classList.remove("oculto"); campo?.focus(); };

  if (nombre.length < 3) return error("Escribe el nombre completo.", inNombre);
  const problemaDni = errorDni(dni);
  if (problemaDni) return error(problemaDni, inDni);
  if (!Number.isFinite(monto) || monto < 0) return error("Escribe el monto acordado (0 o más).", inMonto);
  if (!inIngreso.value) return error("Elige la fecha de ingreso.", inIngreso);
  const repetido = trabajadores.find((t) => t.id !== editandoId && t.dni === dni);
  if (repetido) return error(`Ya existe un trabajador con ese DNI (${repetido.nombre}).`, inDni);

  const datos = {
    nombre, dni,
    cargo: inCargo.value.trim(),
    tipoPago: inTipoPago.value,
    montoAcordado: monto,
    activo: inActivo.checked,
    fechaIngreso: Timestamp.fromDate(inicioDiaLima(inIngreso.value))
  };

  const btn = document.getElementById("btnGuardarTrabajador");
  btn.disabled = true;
  try {
    const ref = editandoId ? doc(db, "trabajadores", editandoId) : doc(collection(db, "trabajadores"));
    await runTransaction(db, async (tx) => {
      if (editandoId) {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("El trabajador no existe.");
        tx.update(ref, datos);
      } else {
        tx.set(ref, datos);
      }
    });
    cerrarModal("modalTrabajador");
    aviso(editandoId ? "Trabajador actualizado." : "Trabajador agregado.");
  } catch (err) {
    console.error(err);
    error(mensajeError(err));
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
// Registrar pago
// ------------------------------------------------------------
/** Texto sugerido para el periodo según el tipo de pago. */
function periodoSugerido(tipoPago) {
  const hoy = claveDiaLima();
  const [a, m, d] = hoy.split("-");
  const dm = (clave) => { const [, mm, dd] = clave.split("-"); return `${dd}/${mm}`; };
  if (tipoPago === "diario") return `Día ${d}/${m}/${a}`;
  if (tipoPago === "semanal") {
    const dia = diaSemana(hoy);
    const lunes = sumarDias(hoy, -(dia === 0 ? 6 : dia - 1));
    return `Semana ${dm(lunes)}–${dm(sumarDias(lunes, 6))}`;
  }
  if (tipoPago === "quincenal") return `${Number(d) <= 15 ? "1.ª" : "2.ª"} quincena de ${MESES[Number(m) - 1]} ${a}`;
  return `Mes de ${MESES[Number(m) - 1]} ${a}`;
}

function actualizarOpcionCaja() {
  const esEfectivo = inPgMetodo.value === "efectivo";
  chkPgCaja.disabled = !cajaAbierta || !esEfectivo;
  if (chkPgCaja.disabled) chkPgCaja.checked = false;
  pgCajaInfo.textContent = !esEfectivo
    ? "Solo los pagos en efectivo pueden salir de la caja."
    : cajaAbierta
      ? "Se registrará como egreso de la caja abierta (baja el efectivo esperado)."
      : "No hay caja abierta: el pago se registra sin afectar la caja.";
}
inPgMetodo.addEventListener("change", actualizarOpcionCaja);

function abrirPago(t) {
  trabajadorActual = t;
  document.getElementById("pagoInfo").textContent =
    `${t.nombre} · ${TIPOS_PAGO[t.tipoPago] || ""} · acordado ${soles(t.montoAcordado)} · pagado este mes ${soles(pagadoEnMes(t.id))}`;
  inPgMonto.value = Number(t.montoAcordado || 0).toFixed(2);   // monto sugerido
  inPgConcepto.value = "sueldo";
  inPgPeriodo.value = periodoSugerido(t.tipoPago);
  inPgMetodo.value = "efectivo";
  inPgObservacion.value = "";
  chkPgCaja.checked = false;
  errorPago.classList.add("oculto");
  actualizarOpcionCaja();
  abrirModal("modalPago");
  inPgMonto.select();
}

formPago.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!trabajadorActual) return;
  const monto = redondear(parseFloat(inPgMonto.value));
  const error = (t) => { errorPago.textContent = t; errorPago.classList.remove("oculto"); };
  if (!(monto > 0)) return error("Ingresa un monto mayor que 0.");
  const periodo = inPgPeriodo.value.trim();
  if (!periodo) return error("Escribe el periodo que se paga.");

  const conCaja = chkPgCaja.checked;
  if (conCaja && !cajaAbierta) return error("No hay caja abierta.");
  const cierreId = conCaja ? cajaAbierta.id : null;
  const t = trabajadorActual;
  const refPago = doc(collection(db, "pagosTrabajadores"));
  const pago = {
    trabajadorId: t.id,
    nombreTrabajador: t.nombre,
    monto,
    concepto: inPgConcepto.value,
    periodo,
    metodo: inPgMetodo.value,
    fecha: serverTimestamp(),
    observacion: inPgObservacion.value.trim(),
    usuarioNombre: usuario.nombre,
    cierreId,
    pagadoConCaja: conCaja
  };

  const btn = document.getElementById("btnGuardarPago");
  btn.disabled = true;
  try {
    await runTransaction(db, async (tx) => {
      if (conCaja) await verificarCajaEnTx(tx, cierreId);
      tx.set(refPago, pago);
      if (conCaja) {
        crearEgresoEnTx(tx, {
          tipo: "trabajador",
          descripcion: `${CONCEPTOS[pago.concepto]} a ${t.nombre} (${periodo})`,
          monto, cierreId, referenciaId: refPago.id, usuarioNombre: usuario.nombre
        });
      }
    });
    ultimoPago = { id: refPago.id, ...pago, fecha: new Date(), dni: t.dni, cargo: t.cargo };
    cerrarModal("modalPago");
    document.getElementById("resumenPagoOk").innerHTML = `
      <dt>Trabajador</dt><dd>${escaparHTML(t.nombre)}</dd>
      <dt>Concepto</dt><dd>${CONCEPTOS[pago.concepto]}</dd>
      <dt>Periodo</dt><dd>${escaparHTML(periodo)}</dd>
      <dt>Método</dt><dd>${METODOS_PAGO[pago.metodo]}${conCaja ? " (de caja)" : ""}</dd>
      <dt>Monto</dt><dd style="font-size:1.4rem">${soles(monto)}</dd>`;
    abrirModal("modalPagoOk");
  } catch (err) {
    if (err.message === "SIN_CAJA") error("La caja se cerró. Desmarca \"Pagado con efectivo de caja\" o abre una caja.");
    else { console.error(err); error(mensajeError(err)); }
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnImprimirPago").addEventListener("click", () => {
  if (ultimoPago) imprimirTicket(htmlComprobante(ultimoPago));
});

// ------------------------------------------------------------
// Historial de pagos de un trabajador
// ------------------------------------------------------------
async function abrirHistorial(t) {
  trabajadorActual = t;
  document.getElementById("tituloHistorial").textContent = `Pagos · ${t.nombre}`;
  const hoy = claveDiaLima();
  const [a, m] = hoy.split("-");
  inHistDesde.value = sumarDias(`${a}-${m}-01`, -62);  // últimos ~3 meses
  inHistHasta.value = hoy;
  tablaHistorial.innerHTML = '<tr><td colspan="7" class="vacio">Cargando…</td></tr>';
  abrirModal("modalHistorial");
  try {
    // Un solo campo en el filtro (trabajadorId): no requiere índice compuesto
    const snap = await getDocs(query(collection(db, "pagosTrabajadores"), where("trabajadorId", "==", t.id)));
    pagosHistorial = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((x, y) => (y.fecha?.toMillis?.() || 0) - (x.fecha?.toMillis?.() || 0));
    dibujarHistorial();
  } catch (err) {
    console.error(err);
    tablaHistorial.innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(err))}</td></tr>`;
  }
}

formHistorial.addEventListener("submit", (e) => { e.preventDefault(); dibujarHistorial(); });

function pagosFiltrados() {
  const desde = inicioDiaLima(inHistDesde.value);
  const hasta = inicioDiaLima(sumarDias(inHistHasta.value, 1));
  return pagosHistorial.filter((p) => {
    const f = p.fecha?.toDate?.();
    return f && f >= desde && f < hasta;
  });
}

function dibujarHistorial() {
  const lista = pagosFiltrados();
  const total = lista.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  document.getElementById("totalHistorial").textContent = `Total pagado en el rango: ${soles(total)} (${lista.length} pago(s))`;
  tablaHistorial.innerHTML = lista.length ? lista.map((p) => `
    <tr>
      <td>${fechaHora(p.fecha)}</td>
      <td>${CONCEPTOS[p.concepto] || escaparHTML(p.concepto)}</td>
      <td>${escaparHTML(p.periodo)}</td>
      <td>${METODOS_PAGO[p.metodo] || escaparHTML(p.metodo)}${p.pagadoConCaja ? '<br><small>De caja</small>' : ""}</td>
      <td class="num"><strong>${soles(p.monto)}</strong></td>
      <td>${escaparHTML(p.usuarioNombre || "")}</td>
      <td><button class="btn btn-claro btn-chico" data-imprimir="${p.id}">Imprimir</button></td>
    </tr>`).join("")
    : '<tr><td colspan="7" class="vacio">Sin pagos en ese rango.</td></tr>';
}

tablaHistorial.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-imprimir]");
  if (!btn) return;
  const p = pagosHistorial.find((x) => x.id === btn.dataset.imprimir);
  if (p) imprimirTicket(htmlComprobante({ ...p, dni: trabajadorActual?.dni, cargo: trabajadorActual?.cargo }));
});

// ------------------------------------------------------------
// Comprobante de pago al trabajador (ticket 80 mm)
// ------------------------------------------------------------
function htmlComprobante(p) {
  return `
    <div class="ticket">
      ${encabezadoTicket("COMPROBANTE DE PAGO AL TRABAJADOR")}
      <hr>
      <table>
        <tr><td>Fecha:</td><td class="num">${fechaHora(p.fecha)}</td></tr>
        <tr><td>N.º:</td><td class="num">${p.id.slice(-6).toUpperCase()}</td></tr>
        <tr><td colspan="2">Trabajador: ${escaparHTML(p.nombreTrabajador)}</td></tr>
        <tr><td>DNI:</td><td class="num">${escaparHTML(p.dni || "")}</td></tr>
        ${p.cargo ? `<tr><td>Cargo:</td><td class="num">${escaparHTML(p.cargo)}</td></tr>` : ""}
      </table>
      <hr>
      <table>
        <tr><td>Concepto:</td><td class="num">${CONCEPTOS[p.concepto] || p.concepto}</td></tr>
        <tr><td colspan="2">Periodo: ${escaparHTML(p.periodo)}</td></tr>
        <tr><td>Método:</td><td class="num">${METODOS_PAGO[p.metodo] || p.metodo}</td></tr>
        <tr class="total"><td>MONTO</td><td class="num">${soles(p.monto)}</td></tr>
      </table>
      ${p.observacion ? `<hr><p>Obs.: ${escaparHTML(p.observacion)}</p>` : ""}
      <hr>
      <p>Registró: ${escaparHTML(p.usuarioNombre || "")}</p>
      <br><br><br>
      <p class="centro">______________________<br>Firma del trabajador<br>${escaparHTML(p.nombreTrabajador)}<br>DNI ${escaparHTML(p.dni || "")}</p>
    </div>`;
}
