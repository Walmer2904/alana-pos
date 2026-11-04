// ============================================================
// ventas.js — Punto de venta
// ------------------------------------------------------------
// Flujo: elegir productos -> armar pedido -> cobrar -> guardar venta
// en Firestore asociada a la caja abierta -> (opcional) imprimir ticket.
// ============================================================

import {
  db, collection, doc, updateDoc, onSnapshot, serverTimestamp, runTransaction
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, soloHora, fechaHora, escaparHTML, aviso,
  confirmar, mensajeError, abrirModal, cerrarModal, imprimirTicket,
  escucharCaja, escucharVentasDeCaja, refCajaActual, NOMBRES_METODO
} from "./comun.js";

const MAX_VENTAS_LISTA = 30; // cuántas ventas del turno mostrar

// Elementos
const avisoSinCaja = document.getElementById("avisoSinCaja");
const filtros = document.getElementById("filtros");
const inBuscar = document.getElementById("buscar");
const catalogo = document.getElementById("catalogo");
const pedidoItems = document.getElementById("pedidoItems");
const totalPedido = document.getElementById("totalPedido");
const btnCobrar = document.getElementById("btnCobrar");
const btnVaciar = document.getElementById("btnVaciar");
const tablaTurno = document.getElementById("tablaTurno");

const formCobro = document.getElementById("formCobro");
const cobroTotal = document.getElementById("cobroTotal");
const metodosCont = document.getElementById("metodos");
const zonaEfectivo = document.getElementById("zonaEfectivo");
const inRecibido = document.getElementById("montoRecibido");
const montosRapidos = document.getElementById("montosRapidos");
const vueltoCaja = document.getElementById("vueltoCaja");
const vueltoRotulo = document.getElementById("vueltoRotulo");
const vueltoMonto = document.getElementById("vueltoMonto");
const errorCobro = document.getElementById("errorCobro");
const btnConfirmar = document.getElementById("btnConfirmarCobro");

// Estado
let usuario = null;
let productos = [];               // productos activos
let categoriaActiva = "Todas";
let cajaAbierta = null;
let dejarDeEscucharVentas = null;
let ventasTurno = [];
let metodoPago = "efectivo";
let ultimaVenta = null;           // para imprimir el ticket
/** Pedido: Map productoId -> { productoId, nombre, precio, cantidad } */
const pedido = new Map();

protegerPagina((u) => {
  usuario = u;
  escucharProductos();
  escucharCaja(alCambiarCaja);
});

// ------------------------------------------------------------
// Caja
// ------------------------------------------------------------
function alCambiarCaja(cierre) {
  cajaAbierta = cierre;
  avisoSinCaja.classList.toggle("oculto", !!cierre);
  actualizarBotones();

  if (dejarDeEscucharVentas) { dejarDeEscucharVentas(); dejarDeEscucharVentas = null; }
  if (!cierre) {
    ventasTurno = [];
    dibujarVentasTurno();
    // Si se estaba cobrando y la otra PC cerró la caja, cerramos el modal
    cerrarModal("modalCobro");
    return;
  }
  dejarDeEscucharVentas = escucharVentasDeCaja(cierre.id, (ventas) => {
    ventasTurno = ventas;
    dibujarVentasTurno();
  });
}

// ------------------------------------------------------------
// Catálogo de productos (tiempo real)
// ------------------------------------------------------------
function escucharProductos() {
  onSnapshot(collection(db, "productos"), (snap) => {
    productos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.activo)
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    dibujarFiltros();
    dibujarCatalogo();
  }, (error) => {
    console.error(error);
    aviso(mensajeError(error), "error");
  });
}

function dibujarFiltros() {
  const categorias = ["Todas", ...new Set(productos.map((p) => p.categoria).filter(Boolean))].sort((a, b) =>
    a === "Todas" ? -1 : b === "Todas" ? 1 : a.localeCompare(b, "es")
  );
  if (!categorias.includes(categoriaActiva)) categoriaActiva = "Todas";
  filtros.innerHTML = categorias.map((c) =>
    `<button type="button" class="chip" data-categoria="${escaparHTML(c)}" aria-pressed="${c === categoriaActiva}">${escaparHTML(c)}</button>`
  ).join("");
}

filtros.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-categoria]");
  if (!btn) return;
  categoriaActiva = btn.dataset.categoria;
  filtros.querySelectorAll(".chip").forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.categoria === categoriaActiva))
  );
  dibujarCatalogo();
});

inBuscar.addEventListener("input", dibujarCatalogo);

function dibujarCatalogo() {
  const texto = inBuscar.value.trim().toLowerCase();
  const lista = productos.filter((p) =>
    (categoriaActiva === "Todas" || p.categoria === categoriaActiva) &&
    (!texto || (p.nombre || "").toLowerCase().includes(texto))
  );

  if (lista.length === 0) {
    catalogo.innerHTML = `<p class="vacio">${productos.length ? "No hay productos que coincidan." : "No hay productos activos. El administrador puede agregarlos en Productos."}</p>`;
    return;
  }

  catalogo.innerHTML = lista.map((p) => `
    <button type="button" class="producto-btn" data-id="${p.id}" aria-label="Agregar ${escaparHTML(p.nombre)}, ${soles(p.precio)}">
      ${p.imagen
        ? `<img class="producto-foto" src="${p.imagen}" alt="" loading="lazy">`
        : `<div class="producto-foto-vacia" aria-hidden="true">${escaparHTML((p.nombre || "?").charAt(0).toUpperCase())}</div>`}
      <div class="producto-info">
        <div class="producto-nombre">${escaparHTML(p.nombre)}</div>
        <div class="producto-precio">${soles(p.precio)}</div>
      </div>
    </button>`).join("");
}

catalogo.addEventListener("click", (e) => {
  const btn = e.target.closest(".producto-btn");
  if (!btn) return;
  const p = productos.find((x) => x.id === btn.dataset.id);
  if (p) agregarAlPedido(p);
});

// ------------------------------------------------------------
// Pedido
// ------------------------------------------------------------
function agregarAlPedido(p) {
  const item = pedido.get(p.id);
  if (item) {
    item.cantidad++;
  } else {
    // Copiamos nombre y precio: si luego cambian, esta venta no se altera
    pedido.set(p.id, { productoId: p.id, nombre: p.nombre, precio: Number(p.precio), cantidad: 1 });
  }
  dibujarPedido();
}

function totalDelPedido() {
  let total = 0;
  for (const it of pedido.values()) total += it.precio * it.cantidad;
  return redondear(total);
}

function dibujarPedido() {
  if (pedido.size === 0) {
    pedidoItems.innerHTML = '<li class="vacio">Toca un producto para agregarlo.</li>';
  } else {
    pedidoItems.innerHTML = [...pedido.values()].map((it) => `
      <li class="pedido-item">
        <div>
          <div class="pedido-item-nombre">${escaparHTML(it.nombre)}</div>
          <div class="texto-gris">${soles(it.precio)} c/u</div>
        </div>
        <div class="pedido-item-sub">${soles(it.precio * it.cantidad)}</div>
        <div class="cantidad">
          <button type="button" class="btn btn-claro btn-icono" data-accion="restar" data-id="${it.productoId}" aria-label="Restar uno de ${escaparHTML(it.nombre)}">−</button>
          <span aria-label="Cantidad">${it.cantidad}</span>
          <button type="button" class="btn btn-claro btn-icono" data-accion="sumar" data-id="${it.productoId}" aria-label="Sumar uno de ${escaparHTML(it.nombre)}">+</button>
        </div>
        <div class="texto-derecha">
          <button type="button" class="btn btn-peligro btn-chico" data-accion="quitar" data-id="${it.productoId}">Quitar</button>
        </div>
      </li>`).join("");
  }
  totalPedido.textContent = soles(totalDelPedido());
  actualizarBotones();
}

pedidoItems.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-accion]");
  if (!btn) return;
  const item = pedido.get(btn.dataset.id);
  if (!item) return;
  if (btn.dataset.accion === "sumar") item.cantidad++;
  if (btn.dataset.accion === "restar") item.cantidad--;
  if (btn.dataset.accion === "quitar" || item.cantidad <= 0) pedido.delete(item.productoId);
  dibujarPedido();
});

btnVaciar.addEventListener("click", async () => {
  if (pedido.size === 0) return;
  if (await confirmar("¿Vaciar el pedido actual?", "Vaciar", true)) {
    pedido.clear();
    dibujarPedido();
  }
});

function actualizarBotones() {
  btnVaciar.disabled = pedido.size === 0;
  btnCobrar.disabled = pedido.size === 0 || !cajaAbierta;
  btnCobrar.textContent = cajaAbierta ? "Cobrar" : "Caja cerrada";
}

// ------------------------------------------------------------
// Cobro
// ------------------------------------------------------------
btnCobrar.addEventListener("click", () => {
  if (!cajaAbierta) {
    aviso("No hay caja abierta.", "error");
    return;
  }
  if (pedido.size === 0) return;
  const total = totalDelPedido();
  cobroTotal.textContent = soles(total);
  elegirMetodo("efectivo");
  inRecibido.value = "";
  dibujarMontosRapidos(total);
  actualizarVuelto();
  errorCobro.classList.add("oculto");
  abrirModal("modalCobro");
  inRecibido.focus();
});

document.getElementById("btnCerrarCobro").addEventListener("click", () => cerrarModal("modalCobro"));

metodosCont.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metodo]");
  if (btn) elegirMetodo(btn.dataset.metodo);
});

function elegirMetodo(metodo) {
  metodoPago = metodo;
  metodosCont.querySelectorAll(".metodo-btn").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.metodo === metodo))
  );
  zonaEfectivo.classList.toggle("oculto", metodo !== "efectivo");
  if (metodo === "efectivo") inRecibido.focus();
  errorCobro.classList.add("oculto");
}

/** Botones de billetes comunes mayores o iguales al total. */
function dibujarMontosRapidos(total) {
  const billetes = [10, 20, 50, 100, 200].filter((b) => b > total);
  const opciones = [{ texto: "Monto exacto", valor: total }, ...billetes.map((b) => ({ texto: soles(b), valor: b }))];
  montosRapidos.innerHTML = opciones.map((o) =>
    `<button type="button" class="btn btn-claro btn-chico" data-valor="${o.valor}">${o.texto}</button>`
  ).join("");
}

montosRapidos.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-valor]");
  if (!btn) return;
  inRecibido.value = btn.dataset.valor;
  actualizarVuelto();
  btnConfirmar.focus();
});

inRecibido.addEventListener("input", actualizarVuelto);

function actualizarVuelto() {
  const total = totalDelPedido();
  const recibido = parseFloat(inRecibido.value);
  vueltoCaja.classList.remove("falta");
  if (!Number.isFinite(recibido)) {
    vueltoRotulo.textContent = "Vuelto";
    vueltoMonto.textContent = soles(0);
    return;
  }
  const dif = redondear(recibido - total);
  if (dif < 0) {
    vueltoCaja.classList.add("falta");
    vueltoRotulo.textContent = "Falta";
    vueltoMonto.textContent = soles(-dif);
  } else {
    vueltoRotulo.textContent = "Vuelto";
    vueltoMonto.textContent = soles(dif);
  }
}

formCobro.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!cajaAbierta || pedido.size === 0) return;

  const total = totalDelPedido();
  let montoRecibido = total;
  let vuelto = 0;

  if (metodoPago === "efectivo") {
    const recibido = redondear(parseFloat(inRecibido.value));
    if (!Number.isFinite(recibido)) {
      return mostrarErrorCobro("Ingresa el monto recibido o elige \"Monto exacto\".");
    }
    if (recibido < total) {
      return mostrarErrorCobro(`El monto recibido es menor que el total. Faltan ${soles(total - recibido)}.`);
    }
    montoRecibido = recibido;
    vuelto = redondear(recibido - total);
  }

  const items = [...pedido.values()].map((it) => ({
    productoId: it.productoId,
    nombre: it.nombre,
    precio: it.precio,
    cantidad: it.cantidad,
    subtotal: redondear(it.precio * it.cantidad)
  }));

  const venta = {
    fecha: serverTimestamp(),
    items,
    total,
    metodoPago,
    montoRecibido,
    vuelto,
    usuarioId: usuario.uid,
    usuarioNombre: usuario.nombre,
    cierreId: cajaAbierta.id,
    anulada: false
  };

  btnConfirmar.disabled = true;
  btnConfirmar.textContent = "Guardando…";
  try {
    const ventaRef = doc(collection(db, "ventas"));
    // Transacción: confirma que la caja sigue abierta en el servidor
    // (por si la otra PC la cerró hace un momento).
    await runTransaction(db, async (tx) => {
      const cfg = await tx.get(refCajaActual());
      if (!cfg.exists() || cfg.data().cierreId !== venta.cierreId) throw new Error("SIN_CAJA");
      tx.set(ventaRef, venta);
    });

    ultimaVenta = { id: ventaRef.id, ...venta, fecha: new Date() };
    pedido.clear();
    dibujarPedido();
    cerrarModal("modalCobro");
    mostrarVentaOk(ultimaVenta);
  } catch (error) {
    if (error.message === "SIN_CAJA") {
      mostrarErrorCobro("La caja fue cerrada. Abre una caja nueva para continuar.");
    } else {
      console.error(error);
      mostrarErrorCobro(mensajeError(error));
    }
  } finally {
    btnConfirmar.disabled = false;
    btnConfirmar.textContent = "Confirmar venta";
  }
});

function mostrarErrorCobro(texto) {
  errorCobro.textContent = texto;
  errorCobro.classList.remove("oculto");
}

function mostrarVentaOk(v) {
  document.getElementById("resumenVentaOk").innerHTML = `
    <dt>Total</dt><dd>${soles(v.total)}</dd>
    <dt>Método</dt><dd>${NOMBRES_METODO[v.metodoPago]}</dd>
    ${v.metodoPago === "efectivo" ? `
      <dt>Recibido</dt><dd>${soles(v.montoRecibido)}</dd>
      <dt>Vuelto</dt><dd style="color:var(--verde);font-size:1.4rem">${soles(v.vuelto)}</dd>` : ""}`;
  abrirModal("modalVentaOk");
  document.getElementById("btnNuevaVenta").focus();
}

document.getElementById("btnNuevaVenta").addEventListener("click", () => {
  cerrarModal("modalVentaOk");
  inBuscar.focus();
});
document.getElementById("btnImprimirTicket").addEventListener("click", () => {
  if (ultimaVenta) imprimirTicket(htmlTicket(ultimaVenta));
});

// ------------------------------------------------------------
// Ventas del turno
// ------------------------------------------------------------
function dibujarVentasTurno() {
  const lista = ventasTurno.slice(0, MAX_VENTAS_LISTA);
  if (lista.length === 0) {
    tablaTurno.innerHTML = `<tr><td colspan="6" class="vacio">${cajaAbierta ? "Sin ventas todavía en este turno." : "No hay caja abierta."}</td></tr>`;
    return;
  }
  const esAdmin = usuario?.rol === "admin";
  tablaTurno.innerHTML = lista.map((v) => {
    const detalle = (v.items || []).map((it) => `${it.cantidad}× ${escaparHTML(it.nombre)}`).join(", ");
    return `
      <tr class="${v.anulada ? "anulada" : ""}">
        <td>${soloHora(v.fecha)}</td>
        <td>${detalle}</td>
        <td>${NOMBRES_METODO[v.metodoPago] || v.metodoPago}</td>
        <td class="num">${soles(v.total)}</td>
        <td>${escaparHTML(v.usuarioNombre || "—")}</td>
        <td>
          <div class="acciones-fila">
            ${v.anulada ? '<span class="etiqueta-estado rojo">Anulada</span>' : `
              <button class="btn btn-claro btn-chico" data-accion="ticket" data-id="${v.id}">Ticket</button>
              ${esAdmin ? `<button class="btn btn-peligro btn-chico" data-accion="anular" data-id="${v.id}">Anular</button>` : ""}`}
          </div>
        </td>
      </tr>`;
  }).join("");
}

tablaTurno.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-accion]");
  if (!btn) return;
  const v = ventasTurno.find((x) => x.id === btn.dataset.id);
  if (!v) return;

  if (btn.dataset.accion === "ticket") {
    imprimirTicket(htmlTicket(v));
  } else if (btn.dataset.accion === "anular") {
    const ok = await confirmar(`¿Anular la venta de ${soles(v.total)} (${soloHora(v.fecha)})? No se borra, pero deja de contar en caja y reportes.`, "Anular venta", true);
    if (!ok) return;
    try {
      await updateDoc(doc(db, "ventas", v.id), {
        anulada: true,
        anuladaPor: usuario.nombre,
        anuladaEn: serverTimestamp()
      });
      aviso("Venta anulada.");
    } catch (error) {
      console.error(error);
      aviso(mensajeError(error), "error");
    }
  }
});

// ------------------------------------------------------------
// Ticket de venta (80 mm)
// ------------------------------------------------------------
function htmlTicket(v) {
  const filas = (v.items || []).map((it) => `
    <tr><td colspan="2">${escaparHTML(it.nombre)}</td></tr>
    <tr><td>&nbsp;&nbsp;${it.cantidad} x ${soles(it.precio)}</td><td class="num">${soles(it.subtotal)}</td></tr>`).join("");
  return `
    <div class="ticket">
      <h1>ALANA</h1>
      <p class="centro">Comida rápida</p>
      <hr>
      <table>
        <tr><td>Fecha:</td><td class="num">${fechaHora(v.fecha)}</td></tr>
        <tr><td>Ticket:</td><td class="num">${v.id.slice(-6).toUpperCase()}</td></tr>
        <tr><td>Atendió:</td><td class="num">${escaparHTML(v.usuarioNombre || "")}</td></tr>
      </table>
      <hr>
      <table>${filas}</table>
      <hr>
      <table>
        <tr class="total"><td>TOTAL</td><td class="num">${soles(v.total)}</td></tr>
        <tr><td>Pago:</td><td class="num">${NOMBRES_METODO[v.metodoPago] || v.metodoPago}</td></tr>
        ${v.metodoPago === "efectivo" ? `
          <tr><td>Recibido:</td><td class="num">${soles(v.montoRecibido)}</td></tr>
          <tr><td>Vuelto:</td><td class="num">${soles(v.vuelto)}</td></tr>` : ""}
      </table>
      <hr>
      <p class="centro">¡Gracias por su preferencia!</p>
      <p class="centro" style="font-size:10px">Documento no válido como comprobante de pago</p>
    </div>`;
}

// Estado inicial del pedido
dibujarPedido();
