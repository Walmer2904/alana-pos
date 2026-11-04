// ============================================================
// reportes.js — Reportes de ventas (solo admin)
// ------------------------------------------------------------
// Regla: solo se cuenta DINERO COBRADO.
//  - Ventas normales (efectivo, Yape, Plin, tarjeta) en su fecha.
//  - Ventas al crédito: NO cuentan en su fecha.
//  - Cobros de créditos (colección "cobros"): cuentan en la FECHA DEL
//    PAGO con el método con que pagaron. Los productos del crédito
//    cuentan en "más vendidos" cuando el crédito se paga completo.
//
// Las consultas filtran SOLO por el campo "fecha" (rango >= y <), así
// Firestore no necesita índices compuestos. Todo lo demás se calcula
// en el navegador. Usa Chart.js y SheetJS (globales Chart y XLSX).
// ============================================================

import { db, collection, getDocs, query, where, orderBy, Timestamp } from "./firebase.js";
import {
  protegerPagina, soles, redondear, fechaHora, soloFecha, escaparHTML, aviso,
  mensajeError, claveDiaLima, inicioDiaLima, sumarDias, diaSemana,
  calcularTotales, METODOS, NOMBRES_METODO
} from "./comun.js";

// Elementos
const textoRango = document.getElementById("textoRango");
const filtrosRapidos = document.getElementById("filtrosRapidos");
const formRango = document.getElementById("formRango");
const inDesde = document.getElementById("desde");
const inHasta = document.getElementById("hasta");
const btnExcel = document.getElementById("btnExcel");
const tablaTop = document.getElementById("tablaTop");
const tablaDetalle = document.getElementById("tablaDetalle");

// Estado
let rango = null;        // { desde: "AAAA-MM-DD", hasta: "AAAA-MM-DD" } (ambos incluidos)
let ventas = [];         // ventas del rango SIN las de crédito (incluye anuladas)
let cobros = [];         // cobros de créditos del rango
let totales = null;      // resultado de calcularTotales
let pendiente = { total: 0, cantidad: 0 }; // créditos pendientes actuales (informativo)
let topProductos = [];
let porDia = [];         // [{ clave, total, num }]
let movimientos = [];    // filas de la tabla detallada (ventas + cobros)
let grafico = null;

protegerPagina(() => {
  aplicarPeriodo("hoy");
}, true);

// ------------------------------------------------------------
// Periodos
// ------------------------------------------------------------
function calcularPeriodo(periodo) {
  const hoy = claveDiaLima();
  if (periodo === "semana") {
    // Lunes a domingo de la semana actual
    const dia = diaSemana(hoy);                // 0 = domingo
    const desdeLunes = dia === 0 ? 6 : dia - 1;
    const lunes = sumarDias(hoy, -desdeLunes);
    return { desde: lunes, hasta: sumarDias(lunes, 6) };
  }
  if (periodo === "mes") {
    const [a, m] = hoy.split("-").map(Number);
    const primero = `${a}-${String(m).padStart(2, "0")}-01`;
    const primeroSiguiente = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
    return { desde: primero, hasta: sumarDias(primeroSiguiente, -1) };
  }
  return { desde: hoy, hasta: hoy };
}

function aplicarPeriodo(periodo) {
  marcarChip(periodo);
  const r = calcularPeriodo(periodo);
  inDesde.value = r.desde;
  inHasta.value = r.hasta;
  cargar(r);
}

function marcarChip(periodo) {
  filtrosRapidos.querySelectorAll(".chip").forEach((c) =>
    c.setAttribute("aria-pressed", String(c.dataset.periodo === periodo))
  );
}

filtrosRapidos.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-periodo]");
  if (btn) aplicarPeriodo(btn.dataset.periodo);
});

formRango.addEventListener("submit", (e) => {
  e.preventDefault();
  const desde = inDesde.value;
  const hasta = inHasta.value;
  if (!desde || !hasta) return aviso("Elige las dos fechas del rango.", "error");
  if (desde > hasta) return aviso("La fecha \"Desde\" no puede ser mayor que \"Hasta\".", "error");
  marcarChip(null);
  cargar({ desde, hasta });
});

// ------------------------------------------------------------
// Carga de datos
// ------------------------------------------------------------
/** Consulta una colección por rango de "fecha" (un solo campo: sin índice compuesto). */
function consultaPorFecha(coleccion, inicio, fin) {
  return getDocs(query(
    collection(db, coleccion),
    where("fecha", ">=", inicio),
    where("fecha", "<", fin),
    orderBy("fecha", "asc")
  ));
}

async function cargar(r) {
  rango = r;
  textoRango.textContent = r.desde === r.hasta
    ? `Día ${soloFecha(inicioDiaLima(r.desde))}`
    : `Del ${soloFecha(inicioDiaLima(r.desde))} al ${soloFecha(inicioDiaLima(r.hasta))}`;
  tablaDetalle.innerHTML = '<tr><td colspan="7" class="vacio">Cargando…</td></tr>';
  btnExcel.disabled = true;

  // Inicio del día "desde" y del día siguiente a "hasta", en hora de Lima
  const inicio = Timestamp.fromDate(inicioDiaLima(r.desde));
  const fin = Timestamp.fromDate(inicioDiaLima(sumarDias(r.hasta, 1)));

  try {
    const [snapVentas, snapCobros, snapPendientes] = await Promise.all([
      consultaPorFecha("ventas", inicio, fin),
      consultaPorFecha("cobros", inicio, fin),
      getDocs(query(collection(db, "creditos"), where("estado", "==", "pendiente")))
    ]);
    // Las ventas al crédito NO cuentan en su fecha: se excluyen aquí.
    ventas = snapVentas.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((v) => v.metodoPago !== "credito");
    cobros = snapCobros.docs.map((d) => ({ id: d.id, ...d.data() }));
    pendiente = {
      total: redondear(snapPendientes.docs.reduce((s, d) => s + (Number(d.data().saldoPendiente) || 0), 0)),
      cantidad: snapPendientes.size
    };
    procesar();
  } catch (error) {
    console.error(error);
    aviso(mensajeError(error), "error");
    tablaDetalle.innerHTML = `<tr><td colspan="7" class="vacio">No se pudo cargar: ${escaparHTML(mensajeError(error))}</td></tr>`;
  }
}

// ------------------------------------------------------------
// Cálculos y dibujo
// ------------------------------------------------------------
function procesar() {
  const validas = ventas.filter((v) => !v.anulada);
  totales = calcularTotales(ventas, cobros);
  const anuladas = ventas.length - validas.length;

  // Indicadores principales (dinero cobrado)
  document.getElementById("kpiTotal").textContent = soles(totales.total);
  document.getElementById("kpiNum").textContent = totales.numVentas;
  document.getElementById("kpiPromedio").textContent =
    soles(totales.numVentas ? totales.total / totales.numVentas : 0);
  document.getElementById("kpiAnuladas").textContent = anuladas;
  document.getElementById("resumenMetodos").innerHTML = METODOS.map((m) => `
    <div class="indicador">
      <div class="rotulo">${NOMBRES_METODO[m]}</div>
      <div class="valor">${soles(totales.porMetodo[m])}</div>
    </div>`).join("");

  // Créditos
  document.getElementById("kpiCobros").textContent = soles(totales.cobros.total);
  document.getElementById("kpiCobrosDetalle").textContent =
    `${totales.cobros.cantidad} pago(s) · ya incluidos en el total vendido`;
  document.getElementById("kpiPendiente").textContent = soles(pendiente.total);
  document.getElementById("kpiPendienteDetalle").textContent =
    `${pendiente.cantidad} crédito(s) · informativo, no suma`;

  // Productos más vendidos: ventas normales + créditos completados en el rango
  const mapa = new Map();
  const sumarItems = (items) => {
    for (const it of items || []) {
      const clave = it.productoId || it.nombre;
      const acc = mapa.get(clave) || { nombre: it.nombre, cantidad: 0, importe: 0 };
      acc.cantidad += Number(it.cantidad) || 0;
      acc.importe += Number(it.subtotal) || 0;
      mapa.set(clave, acc);
    }
  };
  for (const v of validas) sumarItems(v.items);
  for (const c of cobros) if (c.completaCredito) sumarItems(c.items);
  topProductos = [...mapa.values()]
    .map((p) => ({ ...p, importe: redondear(p.importe) }))
    .sort((a, b) => b.cantidad - a.cantidad || b.importe - a.importe);

  tablaTop.innerHTML = topProductos.length
    ? topProductos.slice(0, 15).map((p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escaparHTML(p.nombre)}</td>
          <td class="num">${p.cantidad}</td>
          <td class="num">${soles(p.importe)}</td>
        </tr>`).join("")
    : '<tr><td colspan="4" class="vacio">Sin datos.</td></tr>';

  // Ventas por día (todos los días del rango, aunque tengan 0)
  const totalesDia = new Map();
  const acumularDia = (fecha, monto, cuentaVenta) => {
    const clave = claveDiaLima(fecha);
    const acc = totalesDia.get(clave) || { total: 0, num: 0 };
    acc.total += Number(monto) || 0;
    if (cuentaVenta) acc.num++;
    totalesDia.set(clave, acc);
  };
  for (const v of validas) acumularDia(v.fecha, v.total, true);
  for (const c of cobros) acumularDia(c.fecha, c.monto, !!c.completaCredito);
  porDia = [];
  for (let c = rango.desde; c <= rango.hasta; c = sumarDias(c, 1)) {
    const acc = totalesDia.get(c) || { total: 0, num: 0 };
    porDia.push({ clave: c, total: redondear(acc.total), num: acc.num });
  }
  dibujarGrafico();

  // Tabla detallada: ventas normales + cobros de créditos (más reciente primero)
  movimientos = [
    ...ventas.map((v) => ({
      fecha: v.fecha,
      tipo: "Venta",
      codigo: v.id.slice(-6).toUpperCase(),
      detalle: (v.items || []).map((it) => `${it.cantidad}× ${it.nombre}`).join(", "),
      metodo: v.metodoPago,
      monto: Number(v.total) || 0,
      recibido: Number(v.montoRecibido) || 0,
      vuelto: Number(v.vuelto) || 0,
      usuario: v.usuarioNombre || "",
      estado: v.anulada ? "Anulada" : "Válida"
    })),
    ...cobros.map((c) => ({
      fecha: c.fecha,
      tipo: "Cobro de crédito",
      codigo: String(c.ventaId || c.creditoId || "").slice(-6).toUpperCase(),
      detalle: `${c.nombreCliente} (DNI ${c.dni})${c.completaCredito ? " · crédito cancelado" : " · abono"}`,
      metodo: c.metodo,
      monto: Number(c.monto) || 0,
      recibido: Number(c.monto) || 0,
      vuelto: 0,
      usuario: c.usuarioNombre || "",
      estado: "Válida"
    }))
  ].sort((a, b) => (b.fecha?.toMillis?.() || 0) - (a.fecha?.toMillis?.() || 0));

  tablaDetalle.innerHTML = movimientos.length
    ? movimientos.map((m) => `
        <tr class="${m.estado === "Anulada" ? "anulada" : ""}">
          <td>${fechaHora(m.fecha)}</td>
          <td>${m.tipo === "Venta" ? m.codigo : `<span class="etiqueta-estado rosa">Cobro</span> ${m.codigo}`}</td>
          <td>${escaparHTML(m.detalle)}</td>
          <td>${NOMBRES_METODO[m.metodo] || escaparHTML(m.metodo)}</td>
          <td class="num">${soles(m.monto)}</td>
          <td>${escaparHTML(m.usuario || "—")}</td>
          <td>${m.estado === "Anulada" ? '<span class="etiqueta-estado rojo">Anulada</span>' : '<span class="etiqueta-estado verde">Válida</span>'}</td>
        </tr>`).join("")
    : '<tr><td colspan="7" class="vacio">No hay ventas ni cobros en este periodo.</td></tr>';

  btnExcel.disabled = movimientos.length === 0;
}

const NOMBRES_DIA = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function dibujarGrafico() {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js no se cargó (¿sin internet?).");
    return;
  }
  const etiquetas = porDia.map((d) => {
    const [, m, dd] = d.clave.split("-");
    return `${NOMBRES_DIA[diaSemana(d.clave)]} ${dd}/${m}`;
  });
  const datos = porDia.map((d) => d.total);

  if (grafico) grafico.destroy();
  grafico = new Chart(document.getElementById("grafico"), {
    type: "bar",
    data: {
      labels: etiquetas,
      datasets: [{
        label: "Total cobrado",
        data: datos,
        backgroundColor: "#FFD21F",
        borderColor: "#141414",
        borderWidth: 2,
        hoverBackgroundColor: "#F0288C",
        borderRadius: 6,
        maxBarThickness: 48
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${soles(ctx.parsed.y)} · ${porDia[ctx.dataIndex].num} ventas`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => "S/ " + v },
          grid: { color: "#EFECE8" }
        },
        x: { grid: { display: false } }
      }
    }
  });
}

// ------------------------------------------------------------
// Exportar a Excel (misma lógica: solo dinero cobrado)
// ------------------------------------------------------------
btnExcel.addEventListener("click", () => {
  if (typeof XLSX === "undefined") {
    aviso("No se pudo cargar la librería de Excel. Revisa tu internet.", "error");
    return;
  }
  const libro = XLSX.utils.book_new();

  // Hoja 1: Resumen
  const resumen = [
    ["ALANA - Reporte de ventas (dinero cobrado)"],
    ["Desde", rango.desde, "Hasta", rango.hasta],
    [],
    ["Total vendido / cobrado (S/)", totales.total],
    ["  De ventas directas (S/)", totales.totalVentasDirectas],
    ["  Cobros de créditos en el periodo (S/)", totales.cobros.total],
    ["N.º de ventas", totales.numVentas],
    ["Ticket promedio (S/)", totales.numVentas ? redondear(totales.total / totales.numVentas) : 0],
    ["Ventas anuladas", ventas.filter((v) => v.anulada).length],
    [],
    ["Método de pago", "Total (S/)", "De ellos, cobros de créditos (S/)"],
    ...METODOS.map((m) => [NOMBRES_METODO[m], totales.porMetodo[m], totales.cobros.porMetodo[m]]),
    [],
    ["Informativo (no suma): total pendiente por cobrar hoy (S/)", pendiente.total],
    ["Informativo: créditos pendientes", pendiente.cantidad],
    [],
    ["Día", "N.º ventas", "Total cobrado (S/)"],
    ...porDia.map((d) => [d.clave, d.num, d.total])
  ];
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(resumen), "Resumen");

  // Hoja 2: Movimientos (ventas normales + cobros de créditos)
  const filas = movimientos.map((m) => ({
    "Fecha y hora": fechaHora(m.fecha),
    "Tipo": m.tipo,
    "Ticket": m.codigo,
    "Detalle": m.detalle,
    "Método": NOMBRES_METODO[m.metodo] || m.metodo,
    "Monto (S/)": m.monto,
    "Recibido (S/)": m.recibido,
    "Vuelto (S/)": m.vuelto,
    "Atendió": m.usuario,
    "Estado": m.estado
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), "Ventas y cobros");

  // Hoja 3: Productos vendidos
  const filasProductos = topProductos.map((p) => ({
    "Producto": p.nombre,
    "Cantidad": p.cantidad,
    "Importe (S/)": p.importe
  }));
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasProductos), "Productos");

  XLSX.writeFile(libro, `reporte-alana_${rango.desde}_a_${rango.hasta}.xlsx`);
});

document.getElementById("btnImprimir").addEventListener("click", () => window.print());
