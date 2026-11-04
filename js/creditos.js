// ============================================================
// creditos.js — Ventas al crédito: pendientes, pagos e historial
// ------------------------------------------------------------
// - Pendientes: escucha en tiempo real where("estado","==","pendiente")
//   y ordena en el navegador (sin índices compuestos). Cuando un crédito
//   queda pagado o anulado, desaparece solo de la lista en todas las PCs.
// - Los créditos NUNCA se borran: pagados/anulados quedan en "Historial".
// - Registrar pago: transacción que verifica caja abierta y saldo actual,
//   actualiza el crédito y crea el documento en "cobros" (lo que leen
//   Caja y Reportes para contar el dinero en la fecha del pago).
// ============================================================

import {
  db, collection, doc, getDocs, query, where, orderBy, onSnapshot,
  serverTimestamp, Timestamp, runTransaction
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, fechaHora, soloFecha, escaparHTML, aviso,
  confirmar, mensajeError, abrirModal, cerrarModal, imprimirTicket, escucharCaja,
  refCajaActual, NOMBRES_METODO, encabezadoTicket, claveDiaLima, inicioDiaLima,
  sumarDias, anularVentaCredito, mensajeAnulacion
} from "./comun.js";

const MS_DIA = 24 * 60 * 60 * 1000;

// Elementos
const pestanas = document.getElementById("pestanas");
const vistaPendientes = document.getElementById("vistaPendientes");
const vistaHistorial = document.getElementById("vistaHistorial");
const avisoSinCaja = document.getElementById("avisoSinCaja");
const inBuscar = document.getElementById("buscar");
const tablaPendientes = document.getElementById("tablaPendientes");
const contador = document.getElementById("contador");
const kpiPorCobrar = document.getElementById("kpiPorCobrar");
const kpiPendientes = document.getElementById("kpiPendientes");
const kpiCliente = document.getElementById("kpiCliente");
const kpiClienteRotulo = document.getElementById("kpiClienteRotulo");
const kpiClienteValor = document.getElementById("kpiClienteValor");
const kpiClienteDetalle = document.getElementById("kpiClienteDetalle");
const formHistorial = document.getElementById("formHistorial");
const inHistDesde = document.getElementById("histDesde");
const inHistHasta = document.getElementById("histHasta");
const inBuscarHist = document.getElementById("buscarHist");
const tablaHistorial = document.getElementById("tablaHistorial");
const cuerpoDetalle = document.getElementById("cuerpoDetalle");
const formPago = document.getElementById("formPago");
const pagoCliente = document.getElementById("pagoCliente");
const pagoSaldo = document.getElementById("pagoSaldo");
const metodosPago = document.getElementById("metodosPago");
const inMontoPago = document.getElementById("montoPago");
const errorPago = document.getElementById("errorPago");
const btnConfirmarPago = document.getElementById("btnConfirmarPago");

// Estado
let usuario = null;
let cajaAbierta = null;
let pendientes = [];          // créditos pendientes (tiempo real)
let historial = [];           // créditos pagados/anulados del rango buscado
let historialCargado = false;
let creditoEnPago = null;     // crédito al que se le registra el pago
let metodoPago = "efectivo";
let ultimoComprobante = null; // datos para imprimir

protegerPagina((u) => {
  usuario = u;
  escucharCaja((cierre) => {
    cajaAbierta = cierre;
    avisoSinCaja.classList.toggle("oculto", !!cierre);
    if (!cierre) cerrarModal("modalPago");
  });
  escucharPendientes();
  // Rango por defecto del historial: últimos 30 días
  const hoy = claveDiaLima();
  inHistDesde.value = sumarDias(hoy, -30);
  inHistHasta.value = hoy;
});

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
/** Quita tildes y pasa a minúsculas para buscar sin importar acentos. */
function normalizar(texto) {
  return String(texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** ¿El crédito coincide con el texto buscado (DNI o nombre)? */
function coincide(c, texto) {
  if (!texto) return true;
  if (/^\d+$/.test(texto)) return String(c.dni || "").includes(texto);
  return normalizar(c.nombreCliente).includes(normalizar(texto));
}

/** Días completos (calendario de Lima) desde la fecha del crédito hasta hoy. */
function diasDesde(fecha) {
  if (!fecha) return 0;
  const hoy = inicioDiaLima(claveDiaLima());
  const dia = inicioDiaLima(claveDiaLima(fecha));
  return Math.max(0, Math.round((hoy - dia) / MS_DIA));
}

function etiquetaEstado(estado) {
  if (estado === "pagado") return '<span class="etiqueta-estado verde">Pagado</span>';
  if (estado === "anulado") return '<span class="etiqueta-estado rojo">Anulado</span>';
  return '<span class="etiqueta-estado rosa">Pendiente</span>';
}

function buscarCredito(id) {
  return pendientes.find((c) => c.id === id) || historial.find((c) => c.id === id);
}

// ------------------------------------------------------------
// Pestañas
// ------------------------------------------------------------
pestanas.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-vista]");
  if (!btn) return;
  const vista = btn.dataset.vista;
  pestanas.querySelectorAll(".chip").forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.vista === vista))
  );
  vistaPendientes.classList.toggle("oculto", vista !== "pendientes");
  vistaHistorial.classList.toggle("oculto", vista !== "historial");
  // El historial se carga solo al abrirlo (la primera vez)
  if (vista === "historial" && !historialCargado) cargarHistorial();
});

// ------------------------------------------------------------
// Pendientes (tiempo real)
// ------------------------------------------------------------
function escucharPendientes() {
  const q = query(collection(db, "creditos"), where("estado", "==", "pendiente"));
  onSnapshot(q, (snap) => {
    pendientes = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    // Del más antiguo al más reciente
    pendientes.sort((a, b) => (a.fecha?.toMillis?.() || 0) - (b.fecha?.toMillis?.() || 0));
    dibujarPendientes();
  }, (error) => {
    console.error(error);
    aviso(mensajeError(error), "error");
    tablaPendientes.innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(error))}</td></tr>`;
  });
}

inBuscar.addEventListener("input", dibujarPendientes);

function dibujarPendientes() {
  const texto = inBuscar.value.trim();
  const lista = pendientes.filter((c) => coincide(c, texto));

  // Resumen general
  const totalPorCobrar = redondear(pendientes.reduce((s, c) => s + (Number(c.saldoPendiente) || 0), 0));
  kpiPorCobrar.textContent = soles(totalPorCobrar);
  kpiPendientes.textContent = pendientes.length;
  contador.textContent = texto ? `(${lista.length} de ${pendientes.length})` : `(${pendientes.length})`;

  // Deuda del cliente filtrado
  if (texto && lista.length > 0) {
    const deuda = redondear(lista.reduce((s, c) => s + (Number(c.saldoPendiente) || 0), 0));
    const dnis = [...new Set(lista.map((c) => c.dni))];
    if (dnis.length === 1) {
      kpiClienteRotulo.textContent = `Debe ${lista[0].nombreCliente}`;
      kpiClienteDetalle.textContent = `DNI ${dnis[0]} · ${lista.length} crédito(s) pendiente(s)`;
    } else {
      kpiClienteRotulo.textContent = "Total de la búsqueda";
      kpiClienteDetalle.textContent = `${dnis.length} clientes · ${lista.length} crédito(s)`;
    }
    kpiClienteValor.textContent = soles(deuda);
    kpiCliente.classList.remove("oculto");
  } else {
    kpiCliente.classList.add("oculto");
  }

  if (lista.length === 0) {
    tablaPendientes.innerHTML = `<tr><td colspan="7" class="vacio">${pendientes.length ? "Ningún crédito coincide con la búsqueda." : "No hay créditos pendientes. 🎉"}</td></tr>`;
    return;
  }

  tablaPendientes.innerHTML = lista.map((c) => {
    const dias = diasDesde(c.fecha);
    return `
      <tr class="fila-clic" data-ver="${c.id}" tabindex="0" aria-label="Ver detalle del crédito de ${escaparHTML(c.nombreCliente)}">
        <td>${fechaHora(c.fecha)}</td>
        <td>${escaparHTML(c.dni)}</td>
        <td><strong>${escaparHTML(c.nombreCliente)}</strong></td>
        <td class="num">${soles(c.total)}</td>
        <td class="num"><strong>${soles(c.saldoPendiente)}</strong></td>
        <td class="num"><span class="dias ${dias >= 15 ? "dias-alerta" : ""}">${dias} ${dias === 1 ? "día" : "días"}</span></td>
        <td>
          <div class="acciones-fila">
            <button class="btn btn-claro btn-chico" data-ver="${c.id}">Ver</button>
            <button class="btn btn-primario btn-chico" data-pagar="${c.id}">Registrar pago</button>
          </div>
        </td>
      </tr>`;
  }).join("");
}

// Clic en la fila o en sus botones
tablaPendientes.addEventListener("click", (e) => {
  const pagar = e.target.closest("button[data-pagar]");
  if (pagar) { abrirPago(pagar.dataset.pagar); return; }
  const ver = e.target.closest("[data-ver]");
  if (ver) mostrarDetalle(ver.dataset.ver);
});
tablaPendientes.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("tr[data-ver]")) mostrarDetalle(e.target.dataset.ver);
});

// ------------------------------------------------------------
// Detalle
// ------------------------------------------------------------
function mostrarDetalle(id) {
  const c = buscarCredito(id);
  if (!c) return;
  const esAdmin = usuario?.rol === "admin";
  const pagos = c.pagos || [];

  const filasItems = (c.items || []).map((it) => `
    <tr>
      <td>${escaparHTML(it.nombre)}</td>
      <td class="num">${it.cantidad}</td>
      <td class="num">${soles(it.precio)}</td>
      <td class="num">${soles(it.subtotal)}</td>
    </tr>`).join("");

  // Saldo después de cada pago (para el historial y la reimpresión)
  let acumulado = 0;
  const filasPagos = pagos.map((p, i) => {
    acumulado += Number(p.monto) || 0;
    const saldo = redondear((Number(c.total) || 0) - acumulado);
    return `
      <tr>
        <td>${fechaHora(p.fecha)}</td>
        <td>${NOMBRES_METODO[p.metodo] || escaparHTML(p.metodo)}</td>
        <td class="num">${soles(p.monto)}</td>
        <td class="num">${soles(saldo)}</td>
        <td>${escaparHTML(p.usuarioNombre || "")}</td>
        <td><button class="btn btn-claro btn-chico" data-reimprimir="${i}">Imprimir</button></td>
      </tr>`;
  }).join("");

  cuerpoDetalle.innerHTML = `
    <dl class="resumen-cierre" style="margin-top:0">
      <dt>Cliente</dt><dd>${escaparHTML(c.nombreCliente)}</dd>
      <dt>DNI</dt><dd>${escaparHTML(c.dni)}</dd>
      <dt>Fecha del crédito</dt><dd>${fechaHora(c.fecha)}</dd>
      <dt>Atendió</dt><dd>${escaparHTML(c.usuarioNombre || "—")}</dd>
      <dt>Estado</dt><dd>${etiquetaEstado(c.estado)}</dd>
      <dt>Total</dt><dd>${soles(c.total)}</dd>
      <dt>Saldo pendiente</dt><dd style="color:var(--rosa);font-size:1.3rem">${soles(c.saldoPendiente)}</dd>
      ${c.fechaPago ? `<dt>Cancelado el</dt><dd>${fechaHora(c.fechaPago)}</dd>` : ""}
      ${c.estado === "anulado" ? `<dt>Anulado</dt><dd>${fechaHora(c.anuladoEn)} · ${escaparHTML(c.anuladoPor || "")}</dd>` : ""}
    </dl>
    <h3>Productos</h3>
    <div class="tabla-contenedor">
      <table class="tabla">
        <thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${filasItems || '<tr><td colspan="4" class="vacio">Sin productos.</td></tr>'}</tbody>
      </table>
    </div>
    <h3 style="margin-top:1rem">Historial de pagos</h3>
    <div class="tabla-contenedor">
      <table class="tabla">
        <thead><tr><th>Fecha</th><th>Método</th><th class="num">Monto</th><th class="num">Saldo</th><th>Registró</th><th></th></tr></thead>
        <tbody>${filasPagos || '<tr><td colspan="6" class="vacio">Aún no hay pagos.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="modal-acciones">
      ${c.estado === "pendiente" && esAdmin ? `<button class="btn btn-peligro" data-anular="${c.id}">Anular crédito</button>` : ""}
      ${c.estado === "pendiente" ? `<button class="btn btn-primario" data-pagar="${c.id}">Registrar pago</button>` : ""}
    </div>`;
  cuerpoDetalle.dataset.creditoId = c.id;
  abrirModal("modalDetalle");
}

cuerpoDetalle.addEventListener("click", async (e) => {
  const c = buscarCredito(cuerpoDetalle.dataset.creditoId);
  if (!c) return;

  if (e.target.closest("button[data-pagar]")) {
    cerrarModal("modalDetalle");
    abrirPago(c.id);
    return;
  }

  const reimp = e.target.closest("button[data-reimprimir]");
  if (reimp) {
    const i = Number(reimp.dataset.reimprimir);
    const pagos = c.pagos || [];
    const pagadoHasta = pagos.slice(0, i + 1).reduce((s, p) => s + (Number(p.monto) || 0), 0);
    const saldo = redondear((Number(c.total) || 0) - pagadoHasta);
    imprimirTicket(htmlComprobante({ credito: c, pago: pagos[i], saldo, numero: i + 1 }));
    return;
  }

  if (e.target.closest("button[data-anular]")) {
    if ((c.pagos || []).length > 0) {
      aviso("No se puede anular: este crédito ya tiene pagos registrados.", "error");
      return;
    }
    const ok = await confirmar(
      `¿Anular el crédito de ${c.nombreCliente} por ${soles(c.total)}? También se anula su venta. No se borra: queda en el Historial.`,
      "Anular crédito", true
    );
    if (!ok) return;
    try {
      await anularVentaCredito(c.ventaId, c.id, usuario.nombre);
      cerrarModal("modalDetalle");
      aviso("Crédito anulado.");
    } catch (error) {
      console.error(error);
      aviso(mensajeAnulacion(error), "error");
    }
  }
});

// Botones genéricos para cerrar modales
document.querySelectorAll("[data-cerrar]").forEach((b) =>
  b.addEventListener("click", () => cerrarModal(b.dataset.cerrar))
);

// ------------------------------------------------------------
// Registrar pago
// ------------------------------------------------------------
function abrirPago(id) {
  const c = pendientes.find((x) => x.id === id);
  if (!c) { aviso("Este crédito ya no está pendiente.", "info"); return; }
  if (!cajaAbierta) {
    aviso("No hay caja abierta. Abre la caja para registrar pagos.", "error");
    avisoSinCaja.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  creditoEnPago = c;
  pagoCliente.textContent = `${c.nombreCliente} · DNI ${c.dni}`;
  pagoSaldo.textContent = soles(c.saldoPendiente);
  inMontoPago.value = Number(c.saldoPendiente).toFixed(2); // por defecto: saldo completo
  inMontoPago.max = c.saldoPendiente;
  errorPago.classList.add("oculto");
  elegirMetodo("efectivo");
  abrirModal("modalPago");
  inMontoPago.select();
}

metodosPago.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metodo]");
  if (btn) elegirMetodo(btn.dataset.metodo);
});

function elegirMetodo(metodo) {
  metodoPago = metodo;
  metodosPago.querySelectorAll(".metodo-btn").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.metodo === metodo))
  );
}

document.getElementById("btnSaldoCompleto").addEventListener("click", () => {
  if (creditoEnPago) inMontoPago.value = Number(creditoEnPago.saldoPendiente).toFixed(2);
  inMontoPago.focus();
});

formPago.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!creditoEnPago) return;
  if (!cajaAbierta) return mostrarErrorPago("No hay caja abierta. Abre la caja para registrar pagos.");

  const monto = redondear(parseFloat(inMontoPago.value));
  const saldoVisible = Number(creditoEnPago.saldoPendiente) || 0;
  if (!Number.isFinite(monto) || monto <= 0) return mostrarErrorPago("Ingresa un monto mayor que 0.");
  if (monto > saldoVisible) return mostrarErrorPago(`El monto no puede ser mayor que el saldo (${soles(saldoVisible)}).`);

  const refCredito = doc(db, "creditos", creditoEnPago.id);
  const refCobro = doc(collection(db, "cobros"));
  const cierreId = cajaAbierta.id;

  btnConfirmarPago.disabled = true;
  btnConfirmarPago.textContent = "Guardando…";
  try {
    // Transacción: lee el saldo REAL del servidor. Si la otra PC registró
    // un pago al mismo tiempo, Firestore reintenta y aquí se detecta.
    const resultado = await runTransaction(db, async (tx) => {
      const cfg = await tx.get(refCajaActual());
      if (!cfg.exists() || cfg.data().cierreId !== cierreId) throw new Error("SIN_CAJA");

      const snap = await tx.get(refCredito);
      if (!snap.exists()) throw new Error("NO_EXISTE");
      const credito = snap.data();
      if (credito.estado !== "pendiente") throw new Error("YA_NO_PENDIENTE");

      const saldoActual = Number(credito.saldoPendiente) || 0;
      if (monto > saldoActual + 0.001) {
        const err = new Error("EXCEDE");
        err.saldoActual = saldoActual;
        throw err;
      }

      const nuevoSaldo = redondear(saldoActual - monto);
      const completa = nuevoSaldo <= 0;
      // Dentro de un arreglo no se puede usar serverTimestamp(): usamos la hora actual.
      const pago = {
        monto,
        metodo: metodoPago,
        fecha: Timestamp.now(),
        usuarioNombre: usuario.nombre,
        cierreId
      };

      const cambios = {
        pagos: [...(credito.pagos || []), pago],
        saldoPendiente: completa ? 0 : nuevoSaldo
      };
      if (completa) {
        cambios.estado = "pagado";
        cambios.fechaPago = serverTimestamp();
      }
      tx.update(refCredito, cambios);

      // Copia del pago en "cobros": Caja la busca por cierreId y Reportes por fecha.
      const cobro = {
        creditoId: refCredito.id,
        ventaId: credito.ventaId,
        dni: credito.dni,
        nombreCliente: credito.nombreCliente,
        monto,
        metodo: metodoPago,
        fecha: serverTimestamp(),
        cierreId,
        usuarioNombre: usuario.nombre,
        completaCredito: completa
      };
      // Al completar, guardamos los productos para "más vendidos" en Reportes.
      if (completa) cobro.items = credito.items || [];
      tx.set(refCobro, cobro);

      return { credito: { id: refCredito.id, ...credito, ...cambios }, pago, saldo: cambios.saldoPendiente, completa, numero: cambios.pagos.length };
    });

    cerrarModal("modalPago");
    ultimoComprobante = resultado;
    mostrarPagoOk(resultado);
    if (resultado.completa) aviso("Crédito cancelado.");
  } catch (error) {
    if (error.message === "SIN_CAJA") mostrarErrorPago("La caja fue cerrada. Abre una caja para registrar pagos.");
    else if (error.message === "YA_NO_PENDIENTE") mostrarErrorPago("Este crédito ya fue pagado o anulado desde otra PC.");
    else if (error.message === "NO_EXISTE") mostrarErrorPago("El crédito no existe.");
    else if (error.message === "EXCEDE") mostrarErrorPago(`El saldo cambió (otra PC registró un pago). Saldo actual: ${soles(error.saldoActual)}.`);
    else { console.error(error); mostrarErrorPago(mensajeError(error)); }
  } finally {
    btnConfirmarPago.disabled = false;
    btnConfirmarPago.textContent = "Registrar pago";
  }
});

function mostrarErrorPago(texto) {
  errorPago.textContent = texto;
  errorPago.classList.remove("oculto");
}

function mostrarPagoOk(r) {
  document.getElementById("tituloPagoOk").textContent = r.completa ? "¡Crédito cancelado!" : "Pago registrado";
  document.getElementById("resumenPagoOk").innerHTML = `
    <dt>Cliente</dt><dd>${escaparHTML(r.credito.nombreCliente)}</dd>
    <dt>Pagó</dt><dd>${soles(r.pago.monto)}</dd>
    <dt>Método</dt><dd>${NOMBRES_METODO[r.pago.metodo]}</dd>
    <dt>${r.completa ? "Estado" : "Saldo pendiente"}</dt>
    <dd style="font-size:1.4rem;color:${r.completa ? "var(--verde)" : "var(--rosa)"}">${r.completa ? "CANCELADO" : soles(r.saldo)}</dd>`;
  abrirModal("modalPagoOk");
}

document.getElementById("btnImprimirComprobante").addEventListener("click", () => {
  if (ultimoComprobante) imprimirTicket(htmlComprobante(ultimoComprobante));
});

// ------------------------------------------------------------
// Historial (pagados y anulados) — se carga solo al pedirlo
// ------------------------------------------------------------
formHistorial.addEventListener("submit", (e) => {
  e.preventDefault();
  cargarHistorial();
});
inBuscarHist.addEventListener("input", dibujarHistorial);

async function cargarHistorial() {
  const desde = inHistDesde.value;
  const hasta = inHistHasta.value;
  if (!desde || !hasta) return aviso("Elige las dos fechas.", "error");
  if (desde > hasta) return aviso("La fecha \"Desde\" no puede ser mayor que \"Hasta\".", "error");

  historialCargado = true;
  tablaHistorial.innerHTML = '<tr><td colspan="7" class="vacio">Cargando…</td></tr>';
  try {
    // Un solo campo (fecha) en el filtro: no requiere índice compuesto
    const q = query(
      collection(db, "creditos"),
      where("fecha", ">=", Timestamp.fromDate(inicioDiaLima(desde))),
      where("fecha", "<", Timestamp.fromDate(inicioDiaLima(sumarDias(hasta, 1)))),
      orderBy("fecha", "desc")
    );
    const snap = await getDocs(q);
    historial = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => c.estado === "pagado" || c.estado === "anulado");
    dibujarHistorial();
  } catch (error) {
    console.error(error);
    tablaHistorial.innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(error))}</td></tr>`;
  }
}

function dibujarHistorial() {
  if (!historialCargado) return;
  const texto = inBuscarHist.value.trim();
  const lista = historial.filter((c) => coincide(c, texto));
  if (lista.length === 0) {
    tablaHistorial.innerHTML = `<tr><td colspan="7" class="vacio">${historial.length ? "Ningún crédito coincide con la búsqueda." : "No hay créditos pagados ni anulados en ese rango."}</td></tr>`;
    return;
  }
  tablaHistorial.innerHTML = lista.map((c) => `
    <tr class="fila-clic" data-ver="${c.id}" tabindex="0">
      <td>${fechaHora(c.fecha)}</td>
      <td>${escaparHTML(c.dni)}</td>
      <td>${escaparHTML(c.nombreCliente)}</td>
      <td class="num">${soles(c.total)}</td>
      <td>${etiquetaEstado(c.estado)}</td>
      <td>${c.estado === "pagado" ? fechaHora(c.fechaPago) : fechaHora(c.anuladoEn)}</td>
      <td><button class="btn btn-claro btn-chico" data-ver="${c.id}">Ver</button></td>
    </tr>`).join("");
}

tablaHistorial.addEventListener("click", (e) => {
  const ver = e.target.closest("[data-ver]");
  if (ver) mostrarDetalle(ver.dataset.ver);
});
tablaHistorial.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("tr[data-ver]")) mostrarDetalle(e.target.dataset.ver);
});

// ------------------------------------------------------------
// Comprobante de pago (ticket 80 mm)
// ------------------------------------------------------------
function htmlComprobante({ credito, pago, saldo, numero }) {
  const cancelado = saldo <= 0;
  return `
    <div class="ticket">
      ${encabezadoTicket("COMPROBANTE DE PAGO DE CRÉDITO")}
      <hr>
      <table>
        <tr><td>Fecha:</td><td class="num">${fechaHora(pago.fecha)}</td></tr>
        <tr><td>Pago N.º:</td><td class="num">${numero}</td></tr>
        <tr><td>Crédito:</td><td class="num">${String(credito.ventaId || credito.id).slice(-6).toUpperCase()}</td></tr>
        <tr><td>Fecha crédito:</td><td class="num">${soloFecha(credito.fecha)}</td></tr>
        <tr><td>DNI:</td><td class="num">${escaparHTML(credito.dni)}</td></tr>
        <tr><td colspan="2">Cliente: ${escaparHTML(credito.nombreCliente)}</td></tr>
        <tr><td>Atendió:</td><td class="num">${escaparHTML(pago.usuarioNombre || "")}</td></tr>
      </table>
      <hr>
      <table>
        <tr><td>Total del crédito</td><td class="num">${soles(credito.total)}</td></tr>
        <tr class="total"><td>PAGO</td><td class="num">${soles(pago.monto)}</td></tr>
        <tr><td>Método:</td><td class="num">${NOMBRES_METODO[pago.metodo] || pago.metodo}</td></tr>
      </table>
      <hr>
      ${cancelado
        ? '<p class="centro total">*** CRÉDITO CANCELADO ***</p>'
        : `<table><tr class="total"><td>Saldo pendiente</td><td class="num">${soles(saldo)}</td></tr></table>`}
      <hr>
      <p class="centro">¡Gracias por su preferencia!</p>
      <p class="centro" style="font-size:10px">Documento no válido como comprobante de pago</p>
    </div>`;
}
