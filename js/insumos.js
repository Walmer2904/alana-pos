// ============================================================
// insumos.js — Inventario de insumos (solo admin)
// ------------------------------------------------------------
// - Lista en tiempo real (onSnapshot) con valor del stock y stock bajo.
// - Compra: suma stock y recalcula el costo unitario como promedio
//   ponderado. Si se paga con efectivo de caja, crea un egreso de caja.
// - Salida / ajuste: resta stock sin dejarlo negativo.
// - Stock y movimiento se guardan SIEMPRE en la misma transacción.
// - El descuento por ventas es MANUAL (no automático) por ahora.
// ============================================================

import {
  db, collection, doc, getDocs, query, where, orderBy, onSnapshot, serverTimestamp, runTransaction,
  deleteDoc, Timestamp
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, redondearA, cantidadConUnidad, fechaHora, escaparHTML,
  aviso, mensajeError, abrirModal, cerrarModal, escucharCaja, verificarCajaEnTx,
  crearEgresoEnTx, claveDiaLima, inicioDiaLima, sumarDias, confirmar
} from "./comun.js";

// Elementos
const kpiValor = document.getElementById("kpiValor");
const kpiBajo = document.getElementById("kpiBajo");
const kpiActivos = document.getElementById("kpiActivos");
const inBuscar = document.getElementById("buscar");
const chkInactivos = document.getElementById("verInactivos");
const tabla = document.getElementById("tablaInsumos");
const contador = document.getElementById("contador");

const formInsumo = document.getElementById("formInsumo");
const inNombre = document.getElementById("insNombre");
const inUnidad = document.getElementById("insUnidad");
const inMinimo = document.getElementById("insMinimo");
const inStock = document.getElementById("insStock");
const inCosto = document.getElementById("insCosto");
const inActivo = document.getElementById("insActivo");
const errorInsumo = document.getElementById("errorInsumo");

const formCompra = document.getElementById("formCompra");
const inCompraCantidad = document.getElementById("compraCantidad");
const inCompraTotal = document.getElementById("compraTotal");
const inCompraNota = document.getElementById("compraNota");
const chkCompraCaja = document.getElementById("compraCaja");
const compraCajaInfo = document.getElementById("compraCajaInfo");
const compraPrevia = document.getElementById("compraPrevia");
const errorCompra = document.getElementById("errorCompra");

const formSalida = document.getElementById("formSalida");
const inSalidaMotivo = document.getElementById("salidaMotivo");
const inSalidaCantidad = document.getElementById("salidaCantidad");
const inSalidaNota = document.getElementById("salidaNota");
const errorSalida = document.getElementById("errorSalida");

const formHistorial = document.getElementById("formHistorial");
const inHistDesde = document.getElementById("histDesde");
const inHistHasta = document.getElementById("histHasta");
const tablaHistorial = document.getElementById("tablaHistorial");

// Estado
let usuario = null;
let cajaAbierta = null;
let insumos = [];
let editandoId = null;     // insumo en edición (null = nuevo)
let insumoActual = null;   // insumo de la compra/salida/historial abierta

protegerPagina((u) => {
  usuario = u;
  escucharCaja((cierre) => { cajaAbierta = cierre; actualizarOpcionCaja(); });
  escucharInsumos();
}, true);

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
const stockBajo = (i) => i.activo !== false && (Number(i.stockActual) || 0) <= (Number(i.stockMinimo) || 0);
const valorStock = (i) => redondear((Number(i.stockActual) || 0) * (Number(i.costoUnitario) || 0));

function normalizar(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

document.querySelectorAll("[data-cerrar]").forEach((b) =>
  b.addEventListener("click", () => cerrarModal(b.dataset.cerrar))
);

// ------------------------------------------------------------
// Lista en tiempo real
// ------------------------------------------------------------
function escucharInsumos() {
  onSnapshot(collection(db, "insumos"), (snap) => {
    insumos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    dibujar();
  }, (error) => {
    console.error(error);
    aviso(mensajeError(error), "error");
  });
}

inBuscar.addEventListener("input", dibujar);
chkInactivos.addEventListener("change", dibujar);

function dibujar() {
  const activos = insumos.filter((i) => i.activo !== false);
  kpiValor.textContent = soles(activos.reduce((s, i) => s + valorStock(i), 0));
  kpiBajo.textContent = activos.filter(stockBajo).length;
  kpiActivos.textContent = activos.length;

  const texto = normalizar(inBuscar.value.trim());
  const lista = insumos.filter((i) =>
    (chkInactivos.checked || i.activo !== false) &&
    (!texto || normalizar(i.nombre).includes(texto))
  );
  contador.textContent = `(${lista.length})`;

  if (lista.length === 0) {
    tabla.innerHTML = `<tr><td colspan="6" class="vacio">${insumos.length ? "Ningún insumo coincide." : "Aún no hay insumos. Agrega el primero con \"+ Nuevo insumo\"."}</td></tr>`;
    return;
  }

  tabla.innerHTML = lista.map((i) => {
    let estado = '<span class="etiqueta-estado verde">OK</span>';
    if (i.activo === false) estado = '<span class="etiqueta-estado">Inactivo</span>';
    else if (stockBajo(i)) estado = '<span class="etiqueta-estado rojo">Stock bajo</span>';
    return `
      <tr class="${stockBajo(i) ? "fila-alerta" : ""}">
        <td><strong>${escaparHTML(i.nombre)}</strong><br><small class="texto-gris">Mínimo: ${cantidadConUnidad(i.stockMinimo, i.unidad)}</small></td>
        <td class="num"><strong>${cantidadConUnidad(i.stockActual, i.unidad)}</strong></td>
        <td class="num">${soles(i.costoUnitario)} / ${escaparHTML(i.unidad)}</td>
        <td class="num">${soles(valorStock(i))}</td>
        <td>${estado}</td>
        <td>
          <div class="acciones-fila">
            <button class="btn btn-primario btn-chico" data-accion="compra" data-id="${i.id}">Compra</button>
            <button class="btn btn-claro btn-chico" data-accion="salida" data-id="${i.id}">Salida / ajuste</button>
            <button class="btn btn-claro btn-chico" data-accion="historial" data-id="${i.id}">Historial</button>
            <button class="btn btn-claro btn-chico" data-accion="editar" data-id="${i.id}">Editar</button>
            <button class="btn btn-peligro btn-chico" data-accion="eliminar" data-id="${i.id}">Eliminar</button>
          </div>
        </td>
      </tr>`;
  }).join("");
}

tabla.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-accion]");
  if (!btn) return;
  const i = insumos.find((x) => x.id === btn.dataset.id);
  if (!i) return;
  if (btn.dataset.accion === "compra") abrirCompra(i);
  if (btn.dataset.accion === "salida") abrirSalida(i);
  if (btn.dataset.accion === "historial") abrirHistorial(i);
  if (btn.dataset.accion === "editar") abrirFormulario(i);
  if (btn.dataset.accion === "eliminar") eliminarInsumo(i);
});

// ------------------------------------------------------------
// Eliminar insumo (solo admin)
// ------------------------------------------------------------
// Se borra SOLO el documento del insumo. Sus movimientos en
// "movimientosInsumos" se conservan (guardan nombreInsumo), así las compras
// siguen en Reportes y en el "Historial general" con la etiqueta "(eliminado)".
async function eliminarInsumo(i) {
  const ok = await confirmar(
    `¿Eliminar el insumo ${i.nombre}? Su historial de compras y salidas se conservará en los reportes.`,
    "Eliminar", true
  );
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "insumos", i.id));
    aviso(`Insumo "${i.nombre}" eliminado. Su historial se conserva.`);
  } catch (err) {
    console.error(err);
    aviso(mensajeError(err), "error");
  }
}

// ------------------------------------------------------------
// Agregar / editar insumo
// ------------------------------------------------------------
document.getElementById("btnNuevo").addEventListener("click", () => abrirFormulario(null));

function abrirFormulario(i) {
  editandoId = i ? i.id : null;
  document.getElementById("tituloInsumo").textContent = i ? "Editar insumo" : "Nuevo insumo";
  inNombre.value = i?.nombre || "";
  inUnidad.value = i?.unidad || "kg";
  inMinimo.value = i?.stockMinimo ?? 0;
  inStock.value = 0;
  inCosto.value = 0;
  inActivo.checked = i ? i.activo !== false : true;
  // El stock y el costo solo se fijan al crear; luego cambian con movimientos
  document.getElementById("zonaInicial").classList.toggle("oculto", !!i);
  document.getElementById("notaEdicion").classList.toggle("oculto", !i);
  errorInsumo.classList.add("oculto");
  abrirModal("modalInsumo");
  inNombre.focus();
}

formInsumo.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombre = inNombre.value.trim().replace(/\s+/g, " ");
  const minimo = redondearA(parseFloat(inMinimo.value || "0"), 3);
  const stock = redondearA(parseFloat(inStock.value || "0"), 3);
  const costo = redondearA(parseFloat(inCosto.value || "0"), 4);

  const error = (t, campo) => { errorInsumo.textContent = t; errorInsumo.classList.remove("oculto"); campo?.focus(); };
  if (!nombre) return error("Escribe el nombre del insumo.", inNombre);
  if (!Number.isFinite(minimo) || minimo < 0) return error("El stock mínimo debe ser 0 o más.", inMinimo);
  if (!editandoId && (!Number.isFinite(stock) || stock < 0)) return error("El stock inicial debe ser 0 o más.", inStock);
  if (!editandoId && (!Number.isFinite(costo) || costo < 0)) return error("El costo unitario debe ser 0 o más.", inCosto);
  const repetido = insumos.find((x) => x.id !== editandoId && normalizar(x.nombre) === normalizar(nombre));
  if (repetido) return error(`Ya existe un insumo llamado "${repetido.nombre}".`, inNombre);

  const btn = document.getElementById("btnGuardarInsumo");
  btn.disabled = true;
  try {
    if (editandoId) {
      const ref = doc(db, "insumos", editandoId);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("El insumo no existe.");
        tx.update(ref, {
          nombre, unidad: inUnidad.value, stockMinimo: minimo,
          activo: inActivo.checked, actualizadoEn: serverTimestamp()
        });
      });
      aviso("Insumo actualizado.");
    } else {
      // Nuevo insumo + (si tiene stock inicial) su movimiento, en una transacción
      const ref = doc(collection(db, "insumos"));
      await runTransaction(db, async (tx) => {
        tx.set(ref, {
          nombre, unidad: inUnidad.value, stockActual: stock, costoUnitario: costo,
          stockMinimo: minimo, activo: inActivo.checked, actualizadoEn: serverTimestamp()
        });
        if (stock > 0) {
          tx.set(doc(collection(db, "movimientosInsumos")), {
            insumoId: ref.id, nombreInsumo: nombre, tipo: "ajuste", cantidad: stock,
            costoTotal: redondear(stock * costo), motivo: "stock inicial",
            stockAnterior: 0, stockNuevo: stock,
            fecha: serverTimestamp(), usuarioNombre: usuario.nombre, cierreId: null
          });
        }
      });
      aviso("Insumo agregado.");
    }
    cerrarModal("modalInsumo");
  } catch (err) {
    console.error(err);
    error(mensajeError(err));
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
// Compra (entrada) con costo promedio ponderado
// ------------------------------------------------------------
function actualizarOpcionCaja() {
  chkCompraCaja.disabled = !cajaAbierta;
  if (!cajaAbierta) chkCompraCaja.checked = false;
  compraCajaInfo.textContent = cajaAbierta
    ? "Se registrará como egreso de la caja abierta (baja el efectivo esperado)."
    : "No hay caja abierta: la compra se registra sin afectar la caja.";
}

function abrirCompra(i) {
  insumoActual = i;
  document.getElementById("compraInfo").textContent =
    `${i.nombre} · stock actual ${cantidadConUnidad(i.stockActual, i.unidad)} · costo ${soles(i.costoUnitario)} / ${i.unidad}`;
  document.getElementById("compraUnidad").textContent = `(${i.unidad})`;
  inCompraCantidad.value = "";
  inCompraTotal.value = "";
  inCompraNota.value = "";
  chkCompraCaja.checked = false;
  compraPrevia.classList.add("oculto");
  errorCompra.classList.add("oculto");
  actualizarOpcionCaja();
  abrirModal("modalCompra");
  inCompraCantidad.focus();
}

/** Costo promedio ponderado: (stock×costo + total pagado) / (stock + cantidad). */
function costoPromedio(stock, costo, cantidad, totalPagado) {
  const s = Math.max(0, Number(stock) || 0);
  const nuevoStock = s + cantidad;
  if (nuevoStock <= 0) return 0;
  return redondearA((s * (Number(costo) || 0) + totalPagado) / nuevoStock, 4);
}

function vistaPreviaCompra() {
  const cant = parseFloat(inCompraCantidad.value);
  const total = parseFloat(inCompraTotal.value);
  if (!insumoActual || !(cant > 0) || !(total >= 0)) { compraPrevia.classList.add("oculto"); return; }
  const nuevo = costoPromedio(insumoActual.stockActual, insumoActual.costoUnitario, cant, total);
  compraPrevia.classList.remove("oculto");
  compraPrevia.textContent =
    `Precio de esta compra: ${soles(total / cant)} / ${insumoActual.unidad}. ` +
    `Nuevo stock: ${cantidadConUnidad((Number(insumoActual.stockActual) || 0) + cant, insumoActual.unidad)} · ` +
    `nuevo costo promedio: ${soles(nuevo)} / ${insumoActual.unidad}.`;
}
inCompraCantidad.addEventListener("input", vistaPreviaCompra);
inCompraTotal.addEventListener("input", vistaPreviaCompra);

formCompra.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!insumoActual) return;
  const cantidad = redondearA(parseFloat(inCompraCantidad.value), 3);
  const total = redondear(parseFloat(inCompraTotal.value));
  const error = (t) => { errorCompra.textContent = t; errorCompra.classList.remove("oculto"); };
  if (!(cantidad > 0)) return error("Ingresa una cantidad mayor que 0.");
  if (!Number.isFinite(total) || total < 0) return error("Ingresa el costo total pagado (0 o más).");

  const conCaja = chkCompraCaja.checked;
  if (conCaja && !cajaAbierta) return error("No hay caja abierta.");
  const cierreId = conCaja ? cajaAbierta.id : null;
  const ref = doc(db, "insumos", insumoActual.id);
  const refMov = doc(collection(db, "movimientosInsumos"));
  const nota = inCompraNota.value.trim();

  const btn = document.getElementById("btnGuardarCompra");
  btn.disabled = true;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("El insumo no existe.");
      if (conCaja) await verificarCajaEnTx(tx, cierreId);
      const ins = snap.data();
      const stockAnterior = Number(ins.stockActual) || 0;
      const stockNuevo = redondearA(stockAnterior + cantidad, 3);
      tx.update(ref, {
        stockActual: stockNuevo,
        costoUnitario: costoPromedio(stockAnterior, ins.costoUnitario, cantidad, total),
        actualizadoEn: serverTimestamp()
      });
      tx.set(refMov, {
        insumoId: ref.id, nombreInsumo: ins.nombre, tipo: "compra", cantidad,
        costoTotal: total, motivo: nota || "compra",
        stockAnterior, stockNuevo, pagadoConCaja: conCaja,
        fecha: serverTimestamp(), usuarioNombre: usuario.nombre, cierreId
      });
      if (conCaja) {
        crearEgresoEnTx(tx, {
          tipo: "insumo",
          descripcion: `Compra de ${cantidadConUnidad(cantidad, ins.unidad)} de ${ins.nombre}`,
          monto: total, cierreId, referenciaId: refMov.id, usuarioNombre: usuario.nombre
        });
      }
    });
    cerrarModal("modalCompra");
    aviso(conCaja ? "Compra registrada y descontada de la caja." : "Compra registrada.");
  } catch (err) {
    if (err.message === "SIN_CAJA") error("La caja se cerró. Desmarca \"Pagado con efectivo de caja\" o abre una caja.");
    else { console.error(err); error(mensajeError(err)); }
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
// Salida o ajuste (resta stock, nunca negativo)
// ------------------------------------------------------------
function abrirSalida(i) {
  insumoActual = i;
  document.getElementById("salidaInfo").textContent = `${i.nombre} · stock actual ${cantidadConUnidad(i.stockActual, i.unidad)}`;
  document.getElementById("salidaUnidad").textContent = `(${i.unidad})`;
  inSalidaMotivo.value = "uso";
  inSalidaCantidad.value = "";
  inSalidaNota.value = "";
  errorSalida.classList.add("oculto");
  abrirModal("modalSalida");
  inSalidaCantidad.focus();
}

formSalida.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!insumoActual) return;
  const cantidad = redondearA(parseFloat(inSalidaCantidad.value), 3);
  const motivo = inSalidaMotivo.value;
  const tipo = motivo === "ajuste de inventario" ? "ajuste" : "salida";
  const nota = inSalidaNota.value.trim();
  const error = (t) => { errorSalida.textContent = t; errorSalida.classList.remove("oculto"); };
  if (!(cantidad > 0)) return error("Ingresa una cantidad mayor que 0.");

  const ref = doc(db, "insumos", insumoActual.id);
  const btn = document.getElementById("btnGuardarSalida");
  btn.disabled = true;
  try {
    const resultado = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("El insumo no existe.");
      const ins = snap.data();
      const stockAnterior = Number(ins.stockActual) || 0;
      if (cantidad > stockAnterior + 0.0005) {
        const err = new Error("SIN_STOCK");
        err.stock = stockAnterior;
        err.unidad = ins.unidad;
        throw err;
      }
      const stockNuevo = Math.max(0, redondearA(stockAnterior - cantidad, 3));
      tx.update(ref, { stockActual: stockNuevo, actualizadoEn: serverTimestamp() });
      tx.set(doc(collection(db, "movimientosInsumos")), {
        insumoId: ref.id, nombreInsumo: ins.nombre, tipo, cantidad,
        costoTotal: redondear(cantidad * (Number(ins.costoUnitario) || 0)),
        motivo: nota ? `${motivo}: ${nota}` : motivo,
        stockAnterior, stockNuevo,
        fecha: serverTimestamp(), usuarioNombre: usuario.nombre, cierreId: null
      });
      return { stockNuevo, bajo: stockNuevo <= (Number(ins.stockMinimo) || 0), nombre: ins.nombre };
    });
    cerrarModal("modalSalida");
    aviso(resultado.bajo ? `Salida registrada. ⚠ ${resultado.nombre} quedó con stock bajo.` : "Salida registrada.",
      resultado.bajo ? "info" : "ok");
  } catch (err) {
    if (err.message === "SIN_STOCK") error(`No hay suficiente stock. Disponible: ${cantidadConUnidad(err.stock, err.unidad)}.`);
    else { console.error(err); error(mensajeError(err)); }
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
// Historial de movimientos de un insumo
// ------------------------------------------------------------
// Dos modos con el mismo modal:
//  - De un insumo: se cargan todos sus movimientos y se filtran por fecha aquí.
//  - General (insumoActual = null): movimientos de TODOS los insumos del rango,
//    incluidos los de insumos eliminados (marcados "(eliminado)"). Se consulta
//    por fecha al presionar "Filtrar" para leer solo lo necesario.
let movimientosInsumo = [];
let historialGeneral = false;

function prepararHistorial(titulo) {
  document.getElementById("tituloHistorial").textContent = titulo;
  const hoy = claveDiaLima();
  inHistDesde.value = sumarDias(hoy, -30);
  inHistHasta.value = hoy;
  tablaHistorial.innerHTML = '<tr><td colspan="8" class="vacio">Cargando…</td></tr>';
  abrirModal("modalHistorial");
}

async function abrirHistorial(i) {
  insumoActual = i;
  historialGeneral = false;
  prepararHistorial(`Historial · ${i.nombre}`);
  try {
    // Un solo campo en el filtro (insumoId): no requiere índice compuesto
    const snap = await getDocs(query(collection(db, "movimientosInsumos"), where("insumoId", "==", i.id)));
    movimientosInsumo = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.fecha?.toMillis?.() || 0) - (a.fecha?.toMillis?.() || 0));
    dibujarHistorial();
  } catch (err) {
    console.error(err);
    tablaHistorial.innerHTML = `<tr><td colspan="8" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(err))}</td></tr>`;
  }
}

document.getElementById("btnHistorialGeneral").addEventListener("click", () => {
  insumoActual = null;
  historialGeneral = true;
  prepararHistorial("Historial general de insumos");
  cargarHistorialGeneral();
});

async function cargarHistorialGeneral() {
  if (!inHistDesde.value || !inHistHasta.value) return aviso("Elige las dos fechas.", "error");
  if (inHistDesde.value > inHistHasta.value) return aviso("La fecha \"Desde\" no puede ser mayor que \"Hasta\".", "error");
  tablaHistorial.innerHTML = '<tr><td colspan="8" class="vacio">Cargando…</td></tr>';
  try {
    // Un solo campo (fecha) en el filtro: no requiere índice compuesto
    const snap = await getDocs(query(
      collection(db, "movimientosInsumos"),
      where("fecha", ">=", Timestamp.fromDate(inicioDiaLima(inHistDesde.value))),
      where("fecha", "<", Timestamp.fromDate(inicioDiaLima(sumarDias(inHistHasta.value, 1)))),
      orderBy("fecha", "desc")
    ));
    movimientosInsumo = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dibujarHistorial();
  } catch (err) {
    console.error(err);
    tablaHistorial.innerHTML = `<tr><td colspan="8" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(err))}</td></tr>`;
  }
}

formHistorial.addEventListener("submit", (e) => {
  e.preventDefault();
  if (historialGeneral) cargarHistorialGeneral();
  else dibujarHistorial();
});

function dibujarHistorial() {
  const desde = inicioDiaLima(inHistDesde.value);
  const hasta = inicioDiaLima(sumarDias(inHistHasta.value, 1));
  const lista = movimientosInsumo.filter((m) => {
    const f = m.fecha?.toDate?.();
    return f && f >= desde && f < hasta;
  });
  const nombres = { compra: "Compra", salida: "Salida", ajuste: "Ajuste" };
  tablaHistorial.innerHTML = lista.length ? lista.map((m) => {
    // Unidad e insumo actual; si ya no existe, el movimiento conserva el nombre
    const ins = insumos.find((x) => x.id === m.insumoId);
    const unidad = ins?.unidad || "";
    const nombre = `${escaparHTML(m.nombreInsumo || ins?.nombre || "—")}${ins ? "" : ' <small class="texto-gris">(eliminado)</small>'}`;
    return `
    <tr>
      <td>${fechaHora(m.fecha)}</td>
      <td>${nombre}</td>
      <td><span class="etiqueta-estado ${m.tipo === "compra" ? "verde" : m.tipo === "salida" ? "rojo" : "amarillo"}">${nombres[m.tipo] || m.tipo}</span>${m.pagadoConCaja ? '<br><small>Pagado con caja</small>' : ""}</td>
      <td class="num">${m.tipo === "compra" || m.motivo === "stock inicial" ? "+" : "−"}${cantidadConUnidad(m.cantidad, unidad)}</td>
      <td class="num">${soles(m.costoTotal)}</td>
      <td>${cantidadConUnidad(m.stockAnterior)} → ${cantidadConUnidad(m.stockNuevo, unidad)}</td>
      <td>${escaparHTML(m.motivo || "")}</td>
      <td>${escaparHTML(m.usuarioNombre || "")}</td>
    </tr>`;
  }).join("")
    : '<tr><td colspan="8" class="vacio">Sin movimientos en ese rango.</td></tr>';
}
