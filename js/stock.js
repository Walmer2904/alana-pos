// ============================================================
// stock.js — Inventario de bebidas y productos con stock (solo admin)
// ------------------------------------------------------------
// Pestaña "Bebidas y productos con stock" de la página Inventario
// (insumos.html). Lo inicia insumos.js después de protegerPagina().
//
// - Lista en tiempo real de los productos con manejaStock: true.
// - Registrar ingreso (compra al proveedor): suma stock y actualiza el
//   costo de producción con promedio ponderado. Si se paga con efectivo de
//   caja, crea un egreso (tipo "producto") en la caja abierta.
// - Ajuste: cantidad + o − con motivo obligatorio; nunca deja stock negativo.
// - Cada cambio crea un documento en "movimientosStock" en la MISMA transacción.
// ============================================================

import {
  db, collection, doc, getDocs, query, where, onSnapshot, serverTimestamp, runTransaction
} from "./firebase.js";
import {
  soles, redondear, redondearA, cantidadConUnidad, fechaHora, escaparHTML, aviso,
  mensajeError, abrirModal, cerrarModal, escucharCaja, verificarCajaEnTx, crearEgresoEnTx,
  claveDiaLima, inicioDiaLima, sumarDias, manejaStock, stockDe, estadoStock, etiquetaStock,
  tieneCosto
} from "./comun.js";

// Elementos
const pestanas = document.getElementById("pestanasInventario");
const vistaInsumos = document.getElementById("vistaInsumos");
const vistaBebidas = document.getElementById("vistaBebidas");
const accionesInsumos = document.getElementById("accionesInsumos");
const inBuscar = document.getElementById("buscarStock");
const tabla = document.getElementById("tablaStock");
const contador = document.getElementById("contadorStock");

const formIngreso = document.getElementById("formIngresoStock");
const inIngCantidad = document.getElementById("ingresoCantidad");
const inIngTotal = document.getElementById("ingresoTotal");
const inIngNota = document.getElementById("ingresoNota");
const chkIngCaja = document.getElementById("ingresoCaja");
const ingCajaInfo = document.getElementById("ingresoCajaInfo");
const ingPrevia = document.getElementById("ingresoPrevia");
const errorIngreso = document.getElementById("errorIngresoStock");

const formAjuste = document.getElementById("formAjusteStock");
const inAjCantidad = document.getElementById("ajusteCantidad");
const inAjMotivo = document.getElementById("ajusteMotivo");
const inAjNota = document.getElementById("ajusteNota");
const ajPrevia = document.getElementById("ajustePrevia");
const errorAjuste = document.getElementById("errorAjusteStock");

const formHist = document.getElementById("formHistorialStock");
const inHistDesde = document.getElementById("histStockDesde");
const inHistHasta = document.getElementById("histStockHasta");
const tablaHist = document.getElementById("tablaHistorialStock");

// Estado
let usuario = null;
let cajaAbierta = null;
let productosStock = [];      // productos con manejaStock: true
let actual = null;            // producto del modal abierto
let movimientos = [];         // historial del producto abierto

const unidadDe = (p) => p?.unidadStock || "unidad";
const costoDe = (p) => (tieneCosto(p) ? p.costo : 0);
const valorDe = (p) => redondear(stockDe(p) * costoDe(p));

/** Lo llama insumos.js cuando el admin ya fue verificado. */
export function iniciarStock(u) {
  usuario = u;
  escucharCaja((cierre) => { cajaAbierta = cierre; actualizarOpcionCaja(); });
  escucharProductosStock();
  // insumos.html#bebidas abre directamente esta pestaña (enlace desde Ventas)
  if (location.hash === "#bebidas") mostrarPestana("bebidas");
}

// ------------------------------------------------------------
// Pestañas Insumos / Bebidas
// ------------------------------------------------------------
pestanas.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-pestana]");
  if (btn) mostrarPestana(btn.dataset.pestana);
});

function mostrarPestana(nombre) {
  pestanas.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.pestana === nombre)));
  vistaInsumos.classList.toggle("oculto", nombre !== "insumos");
  accionesInsumos.classList.toggle("oculto", nombre !== "insumos");
  vistaBebidas.classList.toggle("oculto", nombre !== "bebidas");
  history.replaceState(null, "", nombre === "bebidas" ? "#bebidas" : location.pathname);
}

// ------------------------------------------------------------
// Lista en tiempo real
// ------------------------------------------------------------
function escucharProductosStock() {
  // Consulta por un solo campo: no requiere índice
  onSnapshot(query(collection(db, "productos"), where("manejaStock", "==", true)), (snap) => {
    productosStock = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    dibujar();
  }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
}

inBuscar.addEventListener("input", dibujar);

function normalizar(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function dibujar() {
  document.getElementById("kpiValorStock").textContent = soles(productosStock.reduce((s, p) => s + valorDe(p), 0));
  document.getElementById("kpiStockBajo").textContent = productosStock.filter((p) => estadoStock(p) === "bajo").length;
  document.getElementById("kpiAgotados").textContent = productosStock.filter((p) => estadoStock(p) === "agotado").length;

  const texto = normalizar(inBuscar.value.trim());
  const lista = productosStock.filter((p) => !texto || normalizar(p.nombre).includes(texto));
  contador.textContent = `(${lista.length})`;

  if (lista.length === 0) {
    tabla.innerHTML = `<tr><td colspan="8" class="vacio">${productosStock.length
      ? "Ningún producto coincide."
      : "Aún no hay productos con stock. Activa \"Controlar stock\" en Productos (por ejemplo, en las bebidas)."}</td></tr>`;
    return;
  }

  tabla.innerHTML = lista.map((p) => `
    <tr class="${estadoStock(p) !== "normal" ? "fila-alerta" : ""}">
      <td>${p.imagen ? `<img class="miniatura" src="${p.imagen}" alt="">` : '<div class="miniatura"></div>'}</td>
      <td><strong>${escaparHTML(p.nombre)}</strong>${p.activo === false ? '<br><small class="texto-gris">Inactivo en Ventas</small>' : ""}</td>
      <td class="num"><strong>${cantidadConUnidad(stockDe(p), unidadDe(p))}</strong></td>
      <td class="num">${cantidadConUnidad(p.stockMinimo || 0)}</td>
      <td class="num">${tieneCosto(p) ? soles(p.costo) : '<span class="etiqueta-estado amarillo">Falta costo</span>'}</td>
      <td class="num">${soles(valorDe(p))}</td>
      <td>${etiquetaStock(p)}</td>
      <td>
        <div class="acciones-fila">
          <button class="btn btn-primario btn-chico" data-accion="ingreso" data-id="${p.id}">Registrar ingreso</button>
          <button class="btn btn-claro btn-chico" data-accion="ajuste" data-id="${p.id}">Ajuste</button>
          <button class="btn btn-claro btn-chico" data-accion="historial" data-id="${p.id}">Historial</button>
        </div>
      </td>
    </tr>`).join("");
}

tabla.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-accion]");
  if (!btn) return;
  const p = productosStock.find((x) => x.id === btn.dataset.id);
  if (!p) return;
  if (btn.dataset.accion === "ingreso") abrirIngreso(p);
  if (btn.dataset.accion === "ajuste") abrirAjuste(p);
  if (btn.dataset.accion === "historial") abrirHistorial(p);
});

// ------------------------------------------------------------
// Ingreso (compra al proveedor) con costo promedio ponderado
// ------------------------------------------------------------
/**
 * Nuevo costo = (stock × costo actual + total pagado) / (stock + cantidad).
 * Si el producto no tenía costo, se usa el precio de esta compra.
 */
function costoPromedio(p, cantidad, totalPagado) {
  const s = stockDe(p);
  if (!tieneCosto(p) || s + cantidad <= 0) return redondearA(totalPagado / cantidad, 4);
  return redondearA((s * p.costo + totalPagado) / (s + cantidad), 4);
}

function actualizarOpcionCaja() {
  chkIngCaja.disabled = !cajaAbierta;
  if (!cajaAbierta) chkIngCaja.checked = false;
  ingCajaInfo.textContent = cajaAbierta
    ? "Se registrará como egreso de la caja abierta (baja el efectivo esperado)."
    : "No hay caja abierta: el ingreso se registra sin afectar la caja.";
}

function abrirIngreso(p) {
  actual = p;
  document.getElementById("ingresoInfo").textContent =
    `${p.nombre} · stock ${cantidadConUnidad(stockDe(p), unidadDe(p))} · costo ${tieneCosto(p) ? soles(p.costo) : "sin costo"}`;
  document.getElementById("ingresoUnidad").textContent = `(${unidadDe(p)})`;
  inIngCantidad.value = "";
  inIngTotal.value = "";
  inIngNota.value = "";
  chkIngCaja.checked = false;
  ingPrevia.classList.add("oculto");
  errorIngreso.classList.add("oculto");
  actualizarOpcionCaja();
  abrirModal("modalIngresoStock");
  inIngCantidad.focus();
}

/** Muestra el costo anterior y el nuevo ANTES de confirmar. */
function vistaPreviaIngreso() {
  const cant = Number(inIngCantidad.value);
  const total = parseFloat(inIngTotal.value);
  if (!actual || !Number.isInteger(cant) || cant <= 0 || !(total >= 0)) { ingPrevia.classList.add("oculto"); return; }
  const nuevo = costoPromedio(actual, cant, total);
  ingPrevia.classList.remove("oculto");
  ingPrevia.innerHTML =
    `Precio de esta compra: <strong>${soles(total / cant)}</strong> c/u.<br>` +
    `Stock: ${stockDe(actual)} → <strong>${stockDe(actual) + cant}</strong> ${escaparHTML(unidadDe(actual))}.<br>` +
    `Costo de producción: ${tieneCosto(actual) ? soles(actual.costo) : "sin costo"} → <strong>${soles(nuevo)}</strong> (promedio ponderado).`;
}
inIngCantidad.addEventListener("input", vistaPreviaIngreso);
inIngTotal.addEventListener("input", vistaPreviaIngreso);

formIngreso.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!actual) return;
  const cantidad = Number(inIngCantidad.value);
  const total = redondear(parseFloat(inIngTotal.value));
  const error = (t) => { errorIngreso.textContent = t; errorIngreso.classList.remove("oculto"); };
  if (!Number.isInteger(cantidad) || cantidad <= 0) return error("Ingresa una cantidad entera mayor que 0.");
  if (!Number.isFinite(total) || total < 0) return error("Ingresa el costo total pagado (0 o más).");

  const conCaja = chkIngCaja.checked;
  if (conCaja && !cajaAbierta) return error("No hay caja abierta.");
  const cierreId = conCaja ? cajaAbierta.id : null;
  const ref = doc(db, "productos", actual.id);
  const refMov = doc(collection(db, "movimientosStock"));
  const nota = inIngNota.value.trim();

  const btn = document.getElementById("btnGuardarIngresoStock");
  btn.disabled = true;
  try {
    const r = await runTransaction(db, async (tx) => {
      // Lecturas: producto actual (stock y costo reales) y caja si corresponde
      const snap = await tx.get(ref);
      if (!snap.exists() || snap.data().manejaStock !== true) throw new Error("El producto ya no controla stock.");
      if (conCaja) await verificarCajaEnTx(tx, cierreId);
      const p = snap.data();
      const stockAntes = Number(p.stock) || 0;
      const stockDespues = stockAntes + cantidad;
      const costoNuevo = costoPromedio(p, cantidad, total);
      // Escrituras
      tx.update(ref, { stock: stockDespues, costo: costoNuevo, actualizadoEn: serverTimestamp() });
      tx.set(refMov, {
        productoId: ref.id, nombreProducto: p.nombre, tipo: "ingreso", cantidad,
        stockAntes, stockDespues, costoTotal: total, motivo: nota || "compra al proveedor",
        ventaId: null, pagadoConCaja: conCaja,
        fecha: serverTimestamp(), usuarioNombre: usuario.nombre, cierreId
      });
      if (conCaja) {
        crearEgresoEnTx(tx, {
          tipo: "producto",
          descripcion: `Ingreso de ${cantidadConUnidad(cantidad, p.unidadStock || "unidad")} de ${p.nombre}`,
          monto: total, cierreId, referenciaId: refMov.id, usuarioNombre: usuario.nombre
        });
      }
      return { costoNuevo, stockDespues };
    });
    cerrarModal("modalIngresoStock");
    aviso(`Ingreso registrado. Stock: ${r.stockDespues} · nuevo costo ${soles(r.costoNuevo)}${conCaja ? " · descontado de la caja" : ""}.`);
  } catch (err) {
    if (err.message === "SIN_CAJA") error("La caja se cerró. Desmarca \"Pagado con efectivo de caja\" o abre una caja.");
    else { console.error(err); error(mensajeError(err)); }
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
// Ajuste (+ o −) con motivo obligatorio
// ------------------------------------------------------------
function abrirAjuste(p) {
  actual = p;
  document.getElementById("ajusteInfo").textContent = `${p.nombre} · stock ${cantidadConUnidad(stockDe(p), unidadDe(p))}`;
  inAjCantidad.value = "";
  inAjMotivo.value = "";
  inAjNota.value = "";
  ajPrevia.classList.add("oculto");
  errorAjuste.classList.add("oculto");
  abrirModal("modalAjusteStock");
  inAjCantidad.focus();
}

inAjCantidad.addEventListener("input", () => {
  const c = Number(inAjCantidad.value);
  if (!actual || !Number.isInteger(c) || c === 0) { ajPrevia.classList.add("oculto"); return; }
  const despues = stockDe(actual) + c;
  ajPrevia.classList.remove("oculto");
  ajPrevia.textContent = despues < 0
    ? `No se puede: el stock quedaría en ${despues}.`
    : `Stock: ${stockDe(actual)} → ${despues} ${unidadDe(actual)}.`;
});

formAjuste.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!actual) return;
  const cantidad = Number(inAjCantidad.value);
  const motivo = inAjMotivo.value;
  const nota = inAjNota.value.trim();
  const error = (t, campo) => { errorAjuste.textContent = t; errorAjuste.classList.remove("oculto"); campo?.focus(); };
  if (!Number.isInteger(cantidad) || cantidad === 0) return error("Ingresa una cantidad entera distinta de 0 (negativa para restar).", inAjCantidad);
  if (!motivo) return error("Elige el motivo del ajuste.", inAjMotivo);
  if (motivo === "otro" && !nota) return error("Escribe el detalle del motivo.", inAjNota);

  const ref = doc(db, "productos", actual.id);
  const btn = document.getElementById("btnGuardarAjusteStock");
  btn.disabled = true;
  try {
    const r = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists() || snap.data().manejaStock !== true) throw new Error("El producto ya no controla stock.");
      const p = snap.data();
      const stockAntes = Number(p.stock) || 0;
      const stockDespues = stockAntes + cantidad;
      if (stockDespues < 0) {
        const err = new Error("NEGATIVO");
        err.stock = stockAntes;
        throw err;
      }
      tx.update(ref, { stock: stockDespues, actualizadoEn: serverTimestamp() });
      tx.set(doc(collection(db, "movimientosStock")), {
        productoId: ref.id, nombreProducto: p.nombre, tipo: "ajuste", cantidad,
        stockAntes, stockDespues, costoTotal: redondear(Math.abs(cantidad) * costoDe(p)),
        motivo: nota ? `${motivo}: ${nota}` : motivo, ventaId: null,
        fecha: serverTimestamp(), usuarioNombre: usuario.nombre, cierreId: null
      });
      return { stockDespues, bajo: estadoStock({ ...p, stock: stockDespues }) !== "normal" };
    });
    cerrarModal("modalAjusteStock");
    aviso(`Ajuste registrado. Stock: ${r.stockDespues}.${r.bajo ? " ⚠ Quedó con stock bajo." : ""}`, r.bajo ? "info" : "ok");
  } catch (err) {
    if (err.message === "NEGATIVO") error(`No se puede dejar el stock negativo. Stock actual: ${err.stock}.`, inAjCantidad);
    else { console.error(err); error(mensajeError(err)); }
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------
// Historial de movimientos de un producto
// ------------------------------------------------------------
const NOMBRES_TIPO = { ingreso: "Ingreso", venta: "Venta", anulacion: "Anulación", ajuste: "Ajuste" };
const COLOR_TIPO = { ingreso: "verde", venta: "rosa", anulacion: "amarillo", ajuste: "" };

async function abrirHistorial(p) {
  actual = p;
  document.getElementById("tituloHistorialStock").textContent = `Historial · ${p.nombre}`;
  const hoy = claveDiaLima();
  inHistDesde.value = sumarDias(hoy, -30);
  inHistHasta.value = hoy;
  tablaHist.innerHTML = '<tr><td colspan="7" class="vacio">Cargando…</td></tr>';
  abrirModal("modalHistorialStock");
  try {
    // Un solo campo en el filtro (productoId): no requiere índice compuesto
    const snap = await getDocs(query(collection(db, "movimientosStock"), where("productoId", "==", p.id)));
    movimientos = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.fecha?.toMillis?.() || 0) - (a.fecha?.toMillis?.() || 0));
    dibujarHistorial();
  } catch (err) {
    console.error(err);
    tablaHist.innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(err))}</td></tr>`;
  }
}

formHist.addEventListener("submit", (e) => { e.preventDefault(); dibujarHistorial(); });

function dibujarHistorial() {
  if (!inHistDesde.value || !inHistHasta.value) return;
  const desde = inicioDiaLima(inHistDesde.value);
  const hasta = inicioDiaLima(sumarDias(inHistHasta.value, 1));
  const lista = movimientos.filter((m) => {
    const f = m.fecha?.toDate?.();
    return f && f >= desde && f < hasta;
  });
  tablaHist.innerHTML = lista.length ? lista.map((m) => `
    <tr>
      <td>${fechaHora(m.fecha)}</td>
      <td><span class="etiqueta-estado ${COLOR_TIPO[m.tipo] ?? ""}">${NOMBRES_TIPO[m.tipo] || escaparHTML(m.tipo)}</span>${m.pagadoConCaja ? "<br><small>Pagado con caja</small>" : ""}</td>
      <td class="num">${m.cantidad > 0 ? "+" : ""}${m.cantidad}</td>
      <td>${m.stockAntes} → ${m.stockDespues}</td>
      <td class="num">${soles(m.costoTotal)}</td>
      <td>${escaparHTML(m.motivo || "")}${m.ventaId ? `<br><small class="texto-gris">Venta ${escaparHTML(String(m.ventaId).slice(-6).toUpperCase())}</small>` : ""}</td>
      <td>${escaparHTML(m.usuarioNombre || "")}</td>
    </tr>`).join("")
    : '<tr><td colspan="7" class="vacio">Sin movimientos en ese rango.</td></tr>';
}
