// ============================================================
// ventas-anteriores.js — Ventas de fechas pasadas (solo admin)
// ------------------------------------------------------------
// Modo A (detallada): como el punto de venta, pero con fecha y hora
//   elegidas (no futuras). Guarda en "ventas" con registroManual: true,
//   registradoEn, registradoPor y cierreId: null (no toca la caja).
//   Si es al crédito, crea el crédito pendiente con esa fecha: no cuenta
//   en reportes hasta que se pague (igual que los créditos normales).
// Modo B (resumida): totales del día por método de pago. Se guarda como
//   UN documento en "ventas" con tipo: "resumen", fecha = ese día 23:59
//   (hora de Lima), items: [] y costoTotal (o null).
// Lista: ventas manuales por rango de fechas; aquí solo se editan o anulan
//   ventas MANUALES, nunca las normales del sistema.
// ============================================================

import {
  db, collection, doc, getDoc, getDocs, query, where, orderBy, onSnapshot,
  serverTimestamp, Timestamp, runTransaction, updateDoc
} from "./firebase.js";
import {
  protegerPagina, soles, redondear, fechaHora, soloFecha, escaparHTML, aviso,
  confirmar, mensajeError, claveDiaLima, inicioDiaLima, sumarDias, NOMBRES_METODO,
  METODOS, dniValido, errorDni, prepararCampoDni, anularVentaCredito, mensajeAnulacion,
  tieneCosto
} from "./comun.js";

const MS_MINUTO = 60 * 1000;
const DESFASE_LIMA_MS = 5 * 60 * MS_MINUTO;   // Lima = UTC-5 todo el año

// Elementos generales
const modos = document.getElementById("modos");
const modoDetallada = document.getElementById("modoDetallada");
const modoResumen = document.getElementById("modoResumen");
const avisoEdicion = document.getElementById("avisoEdicion");
const textoEdicion = document.getElementById("textoEdicion");

// Modo A
const filtros = document.getElementById("filtros");
const inBuscar = document.getElementById("buscar");
const catalogo = document.getElementById("catalogo");
const formDetallada = document.getElementById("formDetallada");
const inFechaHora = document.getElementById("fechaHoraVenta");
const pedidoItems = document.getElementById("pedidoItems");
const totalPedido = document.getElementById("totalPedido");
const metodosCont = document.getElementById("metodos");
const btnMetodoCredito = document.getElementById("btnMetodoCredito");
const zonaCredito = document.getElementById("zonaCredito");
const inDni = document.getElementById("dniCliente");
const inNombreCliente = document.getElementById("nombreCliente");
const infoCliente = document.getElementById("infoCliente");
const errorDetallada = document.getElementById("errorDetallada");
const btnGuardarDetallada = document.getElementById("btnGuardarDetallada");

// Modo B
const formResumen = document.getElementById("formResumen");
const inResFecha = document.getElementById("resFecha");
const inResMontos = {
  efectivo: document.getElementById("resEfectivo"),
  yape: document.getElementById("resYape"),
  plin: document.getElementById("resPlin"),
  tarjeta: document.getElementById("resTarjeta")
};
const inResCosto = document.getElementById("resCosto");
const inResObs = document.getElementById("resObservacion");
const resTotal = document.getElementById("resTotal");
const errorResumen = document.getElementById("errorResumen");
const btnGuardarResumen = document.getElementById("btnGuardarResumen");

// Lista
const formLista = document.getElementById("formLista");
const inListaDesde = document.getElementById("listaDesde");
const inListaHasta = document.getElementById("listaHasta");
const tablaManuales = document.getElementById("tablaManuales");

// Estado
let usuario = null;
let productos = [];               // todos los productos (también inactivos: pudieron venderse antes)
let categoriaActiva = "Todas";
let metodoPago = "efectivo";
let dniConsultado = "";
let editando = null;              // venta manual en edición (detallada o resumen) o null
let manuales = [];                // ventas manuales del rango buscado
let listaCargada = false;
/** Pedido: Map productoId -> { productoId, nombre, precio, costo, cantidad } */
const pedido = new Map();

protegerPagina((u) => {
  usuario = u;
  escucharProductos();
  limpiarDetallada();
  limpiarResumen();
  const hoy = claveDiaLima();
  inListaDesde.value = sumarDias(hoy, -30);
  inListaHasta.value = hoy;
}, true);

// ------------------------------------------------------------
// Fechas en hora de Lima
// ------------------------------------------------------------
/** "AAAA-MM-DDTHH:MM" (hora de Lima) -> Date. */
function fechaDesdeInputLima(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(valor || "");
  if (!m) return null;
  const [, a, mes, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(a, mes - 1, d, h, mi) + DESFASE_LIMA_MS);
}

/** Date -> "AAAA-MM-DDTHH:MM" en hora de Lima (para el campo datetime-local). */
function inputLimaDesdeFecha(fecha) {
  return new Date(fecha.getTime() - DESFASE_LIMA_MS).toISOString().slice(0, 16);
}

/** Fecha de una venta resumida: el día elegido a las 23:59 (hora de Lima). */
function finDelDiaLima(clave) {
  return new Date(inicioDiaLima(clave).getTime() + (23 * 60 + 59) * MS_MINUTO);
}

/** Pone el máximo permitido (ahora) en los campos de fecha. */
function actualizarMaximos() {
  inFechaHora.max = inputLimaDesdeFecha(new Date());
  inResFecha.max = claveDiaLima();
}

// ------------------------------------------------------------
// Modos y edición
// ------------------------------------------------------------
modos.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-modo]");
  if (!btn) return;
  if (editando) { aviso("Termina o cancela la edición antes de cambiar de modo.", "info"); return; }
  mostrarModo(btn.dataset.modo);
});

function mostrarModo(modo) {
  modos.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.modo === modo)));
  modoDetallada.classList.toggle("oculto", modo !== "detallada");
  modoResumen.classList.toggle("oculto", modo !== "resumen");
}

function mostrarAvisoEdicion(texto) {
  textoEdicion.textContent = texto;
  avisoEdicion.classList.remove("oculto");
  avisoEdicion.scrollIntoView({ behavior: "smooth", block: "start" });
}

function terminarEdicion() {
  editando = null;
  avisoEdicion.classList.add("oculto");
  btnMetodoCredito.classList.remove("oculto");
  btnGuardarDetallada.textContent = "Guardar venta";
  btnGuardarResumen.textContent = "Guardar venta resumida";
}

document.getElementById("btnCancelarEdicion").addEventListener("click", () => {
  terminarEdicion();
  limpiarDetallada();
  limpiarResumen();
});

// ------------------------------------------------------------
// Modo A: catálogo
// ------------------------------------------------------------
function escucharProductos() {
  onSnapshot(collection(db, "productos"), (snap) => {
    productos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.activo === false ? 0 : 1) - (a.activo === false ? 0 : 1)
        || (a.nombre || "").localeCompare(b.nombre || "", "es"));
    dibujarFiltros();
    dibujarCatalogo();
  }, (error) => { console.error(error); aviso(mensajeError(error), "error"); });
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
  dibujarFiltros();
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
    catalogo.innerHTML = `<p class="vacio">${productos.length ? "No hay productos que coincidan." : "No hay productos registrados."}</p>`;
    return;
  }
  catalogo.innerHTML = lista.map((p) => `
    <button type="button" class="producto-btn" data-id="${p.id}" aria-label="Agregar ${escaparHTML(p.nombre)}, ${soles(p.precio)}">
      ${p.imagen
        ? `<img class="producto-foto" src="${p.imagen}" alt="" loading="lazy">`
        : `<div class="producto-foto-vacia" aria-hidden="true">${escaparHTML((p.nombre || "?").charAt(0).toUpperCase())}</div>`}
      <div class="producto-info">
        <div class="producto-nombre">${escaparHTML(p.nombre)}${p.activo === false ? ' <small class="texto-gris">(inactivo)</small>' : ""}</div>
        <div class="producto-precio">${soles(p.precio)}</div>
      </div>
    </button>`).join("");
}

catalogo.addEventListener("click", (e) => {
  const btn = e.target.closest(".producto-btn");
  if (!btn) return;
  const p = productos.find((x) => x.id === btn.dataset.id);
  if (!p) return;
  const item = pedido.get(p.id);
  if (item) item.cantidad++;
  else pedido.set(p.id, {
    productoId: p.id,
    nombre: p.nombre,
    precio: Number(p.precio) || 0,
    costo: tieneCosto(p) ? p.costo : null,   // copia del costo (null = sin costo)
    cantidad: 1
  });
  dibujarPedido();
});

// ------------------------------------------------------------
// Modo A: pedido (con precio editable por línea)
// ------------------------------------------------------------
function totalDelPedido() {
  let total = 0;
  for (const it of pedido.values()) total += it.precio * it.cantidad;
  return redondear(total);
}

function dibujarPedido() {
  pedidoItems.innerHTML = pedido.size === 0
    ? '<li class="vacio">Toca un producto para agregarlo.</li>'
    : [...pedido.values()].map((it) => `
      <li class="pedido-item">
        <div>
          <div class="pedido-item-nombre">${escaparHTML(it.nombre)}</div>
          <label class="precio-linea">S/
            <input type="number" min="0" step="0.10" inputmode="decimal" value="${it.precio}" data-precio="${it.productoId}" aria-label="Precio unitario de ${escaparHTML(it.nombre)}"> c/u
          </label>
        </div>
        <div class="pedido-item-sub" data-sub="${it.productoId}">${soles(it.precio * it.cantidad)}</div>
        <div class="cantidad">
          <button type="button" class="btn btn-claro btn-icono" data-accion="restar" data-id="${it.productoId}" aria-label="Restar uno de ${escaparHTML(it.nombre)}">−</button>
          <span aria-label="Cantidad">${it.cantidad}</span>
          <button type="button" class="btn btn-claro btn-icono" data-accion="sumar" data-id="${it.productoId}" aria-label="Sumar uno de ${escaparHTML(it.nombre)}">+</button>
        </div>
        <div class="texto-derecha">
          <button type="button" class="btn btn-peligro btn-chico" data-accion="quitar" data-id="${it.productoId}">Quitar</button>
        </div>
      </li>`).join("");
  totalPedido.textContent = soles(totalDelPedido());
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

// Cambiar el precio no redibuja la lista (para no perder el cursor)
pedidoItems.addEventListener("input", (e) => {
  const input = e.target.closest("input[data-precio]");
  if (!input) return;
  const item = pedido.get(input.dataset.precio);
  if (!item) return;
  const valor = parseFloat(input.value);
  item.precio = Number.isFinite(valor) && valor >= 0 ? redondear(valor) : NaN;
  const sub = pedidoItems.querySelector(`[data-sub="${CSS.escape(item.productoId)}"]`);
  if (sub) sub.textContent = Number.isFinite(item.precio) ? soles(item.precio * item.cantidad) : "—";
  totalPedido.textContent = soles([...pedido.values()].reduce((s, it) => s + (Number.isFinite(it.precio) ? it.precio * it.cantidad : 0), 0));
});

document.getElementById("btnVaciar").addEventListener("click", async () => {
  if (pedido.size === 0) return;
  if (await confirmar("¿Vaciar la venta actual?", "Vaciar", true)) { pedido.clear(); dibujarPedido(); }
});

// ------------------------------------------------------------
// Modo A: método de pago y datos del cliente (crédito)
// ------------------------------------------------------------
metodosCont.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metodo]");
  if (btn) elegirMetodo(btn.dataset.metodo);
});

function elegirMetodo(metodo) {
  metodoPago = metodo;
  metodosCont.querySelectorAll(".metodo-btn").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.metodo === metodo))
  );
  zonaCredito.classList.toggle("oculto", metodo !== "credito");
  errorDetallada.classList.add("oculto");
  if (metodo === "credito") inDni.focus();
}

const refrescarDni = prepararCampoDni(inDni, document.getElementById("contadorDni"), (valor) => {
  if (dniValido(valor)) buscarCliente(valor);
  else { dniConsultado = ""; infoCliente.classList.add("oculto"); }
});

async function buscarCliente(dni) {
  if (dni === dniConsultado) return;
  dniConsultado = dni;
  infoCliente.className = "info-cliente";
  infoCliente.textContent = "Buscando cliente…";
  try {
    const snapCliente = await getDoc(doc(db, "clientes", dni));
    const snapCreditos = await getDocs(query(collection(db, "creditos"), where("dni", "==", dni)));
    if (dni !== inDni.value) return;
    const pendientes = snapCreditos.docs.map((d) => d.data()).filter((c) => c.estado === "pendiente");
    const deuda = redondear(pendientes.reduce((s, c) => s + (Number(c.saldoPendiente) || 0), 0));
    if (snapCliente.exists()) {
      inNombreCliente.value = snapCliente.data().nombre || "";
      infoCliente.className = `info-cliente ${deuda > 0 ? "debe" : "al-dia"}`;
      infoCliente.textContent = deuda > 0
        ? `Cliente registrado. Debe actualmente ${soles(deuda)} en ${pendientes.length} crédito(s).`
        : "Cliente registrado. No tiene deudas pendientes.";
    } else {
      infoCliente.textContent = "Cliente nuevo: escribe su nombre completo.";
      inNombreCliente.focus();
    }
  } catch (error) {
    console.error(error);
    infoCliente.textContent = "No se pudo consultar el cliente: " + mensajeError(error);
  }
}

function limpiarDetallada() {
  actualizarMaximos();
  pedido.clear();
  dibujarPedido();
  inFechaHora.value = "";
  inDni.value = "";
  refrescarDni();
  inNombreCliente.value = "";
  infoCliente.classList.add("oculto");
  dniConsultado = "";
  errorDetallada.classList.add("oculto");
  elegirMetodo("efectivo");
}

function errorA(texto, campo) {
  errorDetallada.textContent = texto;
  errorDetallada.classList.remove("oculto");
  campo?.focus();
}

// ------------------------------------------------------------
// Modo A: guardar (nueva o edición)
// ------------------------------------------------------------
formDetallada.addEventListener("submit", async (e) => {
  e.preventDefault();
  actualizarMaximos();
  if (pedido.size === 0) return errorA("Agrega al menos un producto.");

  const fecha = fechaDesdeInputLima(inFechaHora.value);
  if (!fecha) return errorA("Elige la fecha y la hora de la venta.", inFechaHora);
  if (fecha.getTime() > Date.now()) return errorA("La fecha y hora no pueden ser futuras.", inFechaHora);

  for (const it of pedido.values()) {
    if (!Number.isFinite(it.precio) || it.precio < 0) return errorA(`Revisa el precio de "${it.nombre}".`);
  }

  const esCredito = metodoPago === "credito";
  let dni = "", nombreCliente = "";
  if (esCredito) {
    if (editando) return errorA("Una venta ya registrada no puede pasarse a crédito. Anúlala y regístrala de nuevo.");
    dni = inDni.value.trim();
    nombreCliente = inNombreCliente.value.trim().replace(/\s+/g, " ");
    const problema = errorDni(dni);
    if (problema) return errorA(problema, inDni);
    if (nombreCliente.length < 3) return errorA("Escribe el nombre completo del cliente.", inNombreCliente);
  }

  const items = [...pedido.values()].map((it) => ({
    productoId: it.productoId,
    nombre: it.nombre,
    precio: it.precio,
    cantidad: it.cantidad,
    subtotal: redondear(it.precio * it.cantidad),
    costoUnitario: it.costo,
    costoSubtotal: it.costo === null ? null : redondear(it.costo * it.cantidad)
  }));
  const total = redondear(items.reduce((s, it) => s + it.subtotal, 0));
  const fechaTs = Timestamp.fromDate(fecha);

  btnGuardarDetallada.disabled = true;
  try {
    if (editando) {
      // Edición: solo ventas manuales que no son al crédito
      await updateDoc(doc(db, "ventas", editando.id), {
        fecha: fechaTs, items, total, metodoPago, montoRecibido: total, vuelto: 0,
        editadoEn: serverTimestamp(), editadoPor: usuario.nombre
      });
      aviso("Venta manual actualizada.");
      terminarEdicion();
    } else {
      const ventaRef = doc(collection(db, "ventas"));
      const creditoRef = esCredito ? doc(collection(db, "creditos")) : null;
      const venta = {
        fecha: fechaTs,
        items,
        total,
        metodoPago,
        montoRecibido: esCredito ? 0 : total,
        vuelto: 0,
        usuarioId: usuario.uid,
        usuarioNombre: usuario.nombre,
        cierreId: null,              // no pertenece a ninguna caja
        anulada: false,
        registroManual: true,
        registradoEn: serverTimestamp(),
        registradoPor: usuario.nombre
      };
      if (esCredito) {
        venta.dni = dni;
        venta.nombreCliente = nombreCliente;
        venta.creditoId = creditoRef.id;
      }
      // Venta + crédito + cliente juntos (o nada)
      await runTransaction(db, async (tx) => {
        tx.set(ventaRef, venta);
        if (esCredito) {
          tx.set(creditoRef, {
            ventaId: ventaRef.id,
            dni,
            nombreCliente,
            items,
            total,
            saldoPendiente: total,
            estado: "pendiente",
            fecha: fechaTs,          // fecha elegida
            usuarioNombre: usuario.nombre,
            cierreId: null,
            pagos: [],
            fechaPago: null,
            registroManual: true
          });
          tx.set(doc(db, "clientes", dni), { dni, nombre: nombreCliente, actualizadoEn: serverTimestamp() }, { merge: true });
        }
      });
      aviso(esCredito ? "Venta al crédito registrada (queda pendiente)." : "Venta registrada.");
    }
    limpiarDetallada();
    if (listaCargada) cargarLista();
  } catch (error) {
    console.error(error);
    errorA(mensajeError(error));
  } finally {
    btnGuardarDetallada.disabled = false;
  }
});

// ------------------------------------------------------------
// Modo B: venta resumida del día
// ------------------------------------------------------------
function montosResumen() {
  const montos = {};
  for (const m of METODOS) {
    const v = inResMontos[m].value.trim();
    montos[m] = v === "" ? 0 : redondear(parseFloat(v));
  }
  return montos;
}

function actualizarTotalResumen() {
  const montos = montosResumen();
  const total = METODOS.reduce((s, m) => s + (Number.isFinite(montos[m]) ? montos[m] : 0), 0);
  resTotal.textContent = soles(total);
}
METODOS.forEach((m) => inResMontos[m].addEventListener("input", actualizarTotalResumen));

function limpiarResumen() {
  actualizarMaximos();
  inResFecha.value = "";
  METODOS.forEach((m) => { inResMontos[m].value = ""; });
  inResCosto.value = "";
  inResObs.value = "";
  errorResumen.classList.add("oculto");
  actualizarTotalResumen();
}

function errorB(texto, campo) {
  errorResumen.textContent = texto;
  errorResumen.classList.remove("oculto");
  campo?.focus();
}

formResumen.addEventListener("submit", async (e) => {
  e.preventDefault();
  actualizarMaximos();
  const clave = inResFecha.value;
  if (!clave) return errorB("Elige la fecha.", inResFecha);
  if (clave > claveDiaLima()) return errorB("La fecha no puede ser futura.", inResFecha);

  const montos = montosResumen();
  for (const m of METODOS) {
    if (!Number.isFinite(montos[m]) || montos[m] < 0) return errorB(`Revisa el monto de ${NOMBRES_METODO[m]}.`, inResMontos[m]);
  }
  const total = redondear(METODOS.reduce((s, m) => s + montos[m], 0));
  if (total <= 0) return errorB("Ingresa al menos un monto mayor que 0.", inResMontos.efectivo);

  const textoCosto = inResCosto.value.trim();
  const costoTotal = textoCosto === "" ? null : redondear(parseFloat(textoCosto));
  if (costoTotal !== null && (!Number.isFinite(costoTotal) || costoTotal < 0)) return errorB("El costo debe ser 0 o más (o déjalo vacío).", inResCosto);

  btnGuardarResumen.disabled = true;
  try {
    // ¿Ya hay ventas de ese día? Avisar para evitar duplicados.
    const snapDia = await getDocs(query(
      collection(db, "ventas"),
      where("fecha", ">=", Timestamp.fromDate(inicioDiaLima(clave))),
      where("fecha", "<", Timestamp.fromDate(inicioDiaLima(sumarDias(clave, 1))))
    ));
    const delDia = snapDia.docs
      .filter((d) => d.id !== editando?.id)
      .map((d) => d.data())
      .filter((v) => !v.anulada);
    if (delDia.length > 0) {
      const resumenes = delDia.filter((v) => v.tipo === "resumen").length;
      const manualesDia = delDia.filter((v) => v.registroManual && v.tipo !== "resumen").length;
      const sistema = delDia.length - resumenes - manualesDia;
      const ok = await confirmar(
        `Ya hay ${delDia.length} registro(s) del ${soloFecha(inicioDiaLima(clave))}: ` +
        `${sistema} del sistema, ${manualesDia} manual(es) detallada(s) y ${resumenes} resumen(es). ` +
        `Si los vuelves a sumar aquí, ese día se contará doble. ¿Guardar de todos modos?`,
        "Guardar de todos modos"
      );
      if (!ok) return;
    }

    const datos = {
      tipo: "resumen",
      fecha: Timestamp.fromDate(finDelDiaLima(clave)),
      totalPorMetodo: montos,
      total,
      costoTotal,
      items: [],
      observacion: inResObs.value.trim()
    };
    if (editando) {
      await updateDoc(doc(db, "ventas", editando.id), {
        ...datos, editadoEn: serverTimestamp(), editadoPor: usuario.nombre
      });
      aviso("Venta resumida actualizada.");
      terminarEdicion();
    } else {
      await runTransaction(db, async (tx) => {
        tx.set(doc(collection(db, "ventas")), {
          ...datos,
          usuarioId: usuario.uid,
          usuarioNombre: usuario.nombre,
          cierreId: null,
          anulada: false,
          registroManual: true,
          registradoEn: serverTimestamp(),
          registradoPor: usuario.nombre
        });
      });
      aviso("Venta resumida registrada.");
    }
    limpiarResumen();
    if (listaCargada) cargarLista();
  } catch (error) {
    console.error(error);
    errorB(mensajeError(error));
  } finally {
    btnGuardarResumen.disabled = false;
  }
});

// ------------------------------------------------------------
// Lista de ventas manuales (se carga al presionar "Buscar")
// ------------------------------------------------------------
formLista.addEventListener("submit", (e) => { e.preventDefault(); cargarLista(); });

async function cargarLista() {
  const desde = inListaDesde.value;
  const hasta = inListaHasta.value;
  if (!desde || !hasta) return aviso("Elige las dos fechas.", "error");
  if (desde > hasta) return aviso("La fecha \"Desde\" no puede ser mayor que \"Hasta\".", "error");
  listaCargada = true;
  tablaManuales.innerHTML = '<tr><td colspan="9" class="vacio">Cargando…</td></tr>';
  try {
    // Un solo campo (fecha) en el filtro: no requiere índice compuesto.
    // Las ventas normales del rango se descartan aquí.
    const snap = await getDocs(query(
      collection(db, "ventas"),
      where("fecha", ">=", Timestamp.fromDate(inicioDiaLima(desde))),
      where("fecha", "<", Timestamp.fromDate(inicioDiaLima(sumarDias(hasta, 1)))),
      orderBy("fecha", "desc")
    ));
    manuales = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((v) => v.registroManual === true);
    dibujarLista();
  } catch (error) {
    console.error(error);
    tablaManuales.innerHTML = `<tr><td colspan="9" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(error))}</td></tr>`;
  }
}

function textoTipo(v) {
  if (v.tipo === "resumen") return '<span class="etiqueta-estado amarillo">Resumen del día</span>';
  if (v.metodoPago === "credito") return '<span class="etiqueta-estado rosa">Detallada · crédito</span>';
  return '<span class="etiqueta-estado">Detallada</span>';
}

function textoMetodo(v) {
  if (v.tipo === "resumen") {
    const partes = METODOS.filter((m) => Number(v.totalPorMetodo?.[m]) > 0)
      .map((m) => `${NOMBRES_METODO[m]} ${soles(v.totalPorMetodo[m])}`);
    return partes.join("<br>") || "—";
  }
  return NOMBRES_METODO[v.metodoPago] || escaparHTML(v.metodoPago || "—");
}

function textoDetalle(v) {
  if (v.tipo === "resumen") {
    const costo = typeof v.costoTotal === "number" ? `Costo ${soles(v.costoTotal)}` : "Sin costo";
    return `${costo}${v.observacion ? ` · ${escaparHTML(v.observacion)}` : ""}`;
  }
  const detalle = (v.items || []).map((it) => `${it.cantidad}× ${escaparHTML(it.nombre)}`).join(", ");
  return v.metodoPago === "credito" ? `${detalle}<br><small>${escaparHTML(v.nombreCliente || "")} · DNI ${escaparHTML(v.dni || "")}</small>` : detalle;
}

function dibujarLista() {
  if (manuales.length === 0) {
    tablaManuales.innerHTML = '<tr><td colspan="9" class="vacio">No hay ventas manuales en ese rango.</td></tr>';
    return;
  }
  tablaManuales.innerHTML = manuales.map((v) => `
    <tr class="${v.anulada ? "anulada" : ""}">
      <td>${v.tipo === "resumen" ? soloFecha(v.fecha) : fechaHora(v.fecha)}</td>
      <td>${textoTipo(v)}</td>
      <td>${textoDetalle(v)}</td>
      <td>${textoMetodo(v)}</td>
      <td class="num">${soles(v.total)}</td>
      <td>${escaparHTML(v.registradoPor || v.usuarioNombre || "—")}${v.editadoPor ? `<br><small class="texto-gris">Editó: ${escaparHTML(v.editadoPor)}</small>` : ""}</td>
      <td>${fechaHora(v.registradoEn)}</td>
      <td>${v.anulada ? '<span class="etiqueta-estado rojo">Anulada</span>' : '<span class="etiqueta-estado verde">Válida</span>'}</td>
      <td>
        <div class="acciones-fila">
          ${v.anulada ? "" : `
            ${v.metodoPago === "credito" ? "" : `<button class="btn btn-claro btn-chico" data-editar="${v.id}">Editar</button>`}
            <button class="btn btn-peligro btn-chico" data-anular="${v.id}">Anular</button>`}
        </div>
      </td>
    </tr>`).join("");
}

tablaManuales.addEventListener("click", async (e) => {
  const btnEditar = e.target.closest("button[data-editar]");
  const btnAnular = e.target.closest("button[data-anular]");
  const id = btnEditar?.dataset.editar || btnAnular?.dataset.anular;
  const v = manuales.find((x) => x.id === id);
  if (!v || v.registroManual !== true) return;   // nunca ventas normales desde aquí
  if (btnEditar) empezarEdicion(v);
  if (btnAnular) anular(v);
});

function empezarEdicion(v) {
  terminarEdicion();
  editando = v;
  if (v.tipo === "resumen") {
    mostrarModo("resumen");
    limpiarResumen();
    inResFecha.value = claveDiaLima(v.fecha);
    METODOS.forEach((m) => { inResMontos[m].value = Number(v.totalPorMetodo?.[m]) || ""; });
    inResCosto.value = typeof v.costoTotal === "number" ? v.costoTotal : "";
    inResObs.value = v.observacion || "";
    actualizarTotalResumen();
    btnGuardarResumen.textContent = "Guardar cambios";
    mostrarAvisoEdicion(`Editando la venta resumida del ${soloFecha(v.fecha)}.`);
  } else {
    mostrarModo("detallada");
    limpiarDetallada();
    inFechaHora.value = inputLimaDesdeFecha(v.fecha.toDate());
    for (const it of v.items || []) {
      const clave = it.productoId || it.nombre;
      pedido.set(clave, {
        productoId: clave,
        nombre: it.nombre,
        precio: Number(it.precio) || 0,
        costo: typeof it.costoUnitario === "number" ? it.costoUnitario : null,
        cantidad: Number(it.cantidad) || 1
      });
    }
    dibujarPedido();
    elegirMetodo(v.metodoPago);
    btnMetodoCredito.classList.add("oculto");   // una venta registrada no pasa a crédito
    btnGuardarDetallada.textContent = "Guardar cambios";
    mostrarAvisoEdicion(`Editando la venta manual del ${fechaHora(v.fecha)} (${soles(v.total)}).`);
  }
}

async function anular(v) {
  const esCredito = v.metodoPago === "credito";
  const ok = await confirmar(
    `¿Anular esta venta manual de ${soles(v.total)} (${soloFecha(v.fecha)})? No se borra, pero deja de contar en reportes` +
    `${esCredito ? " y su crédito se anula" : ""}.`,
    "Anular venta", true
  );
  if (!ok) return;
  try {
    if (esCredito && v.creditoId) {
      await anularVentaCredito(v.id, v.creditoId, usuario.nombre);
    } else {
      await updateDoc(doc(db, "ventas", v.id), {
        anulada: true, anuladaPor: usuario.nombre, anuladaEn: serverTimestamp()
      });
    }
    if (editando?.id === v.id) { terminarEdicion(); limpiarDetallada(); limpiarResumen(); }
    aviso("Venta manual anulada.");
    cargarLista();
  } catch (error) {
    console.error(error);
    aviso(mensajeAnulacion(error), "error");
  }
}
