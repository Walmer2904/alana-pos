// ============================================================
// pdf.js — Generación de PDF (Reportes y cierres de caja, solo admin)
// ------------------------------------------------------------
// Usa jsPDF + jspdf-autotable desde cdnjs (builds UMD, versión fija).
// Las librerías se cargan SOLO cuando se pide un PDF, así las páginas
// abren igual de rápido que antes.
//
// Hoja A4 vertical, medidas en milímetros. El encabezado (ALANA, RUC y
// título) y el pie ("Página X de Y" · "Generado por ALANA POS") se dibujan
// al final en TODAS las páginas. Colores de la marca solo en detalles,
// para que se lea bien también impreso en blanco y negro.
//
// Tildes y ñ: las fuentes estándar de jsPDF (Helvetica) usan la
// codificación WinAnsi, que incluye á é í ó ú ü ñ ¿ ¡. Los pocos símbolos
// que no incluye (por ejemplo "−" o "⚠") se reemplazan con texto().
// ============================================================

import { RUC, soles, claveDiaLima, diaSemana } from "./comun.js";

const URL_JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const URL_AUTOTABLE = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

// Colores (RGB)
export const COLOR = {
  mostaza: [242, 176, 30],
  mostazaClaro: [253, 243, 214],
  tomate: [200, 50, 30],
  negro: [20, 20, 20],
  gris: [95, 95, 95],
  grisLinea: [190, 190, 190],
  grisFila: [244, 244, 244],
  verde: [22, 128, 60]
};

// Medidas de la hoja (mm)
const ANCHO = 210;
const ALTO = 297;
const MARGEN = 15;
const TOPE_CONTENIDO = 32;    // debajo del encabezado
const PIE = 18;               // espacio reservado para el pie

// ------------------------------------------------------------
// Carga de librerías bajo demanda
// ------------------------------------------------------------
let cargaEnCurso = null;

function cargarScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar la librería de PDF. Revisa tu conexión a internet."));
    document.head.appendChild(s);
  });
}

/** Carga jsPDF y autotable (una sola vez). */
export function cargarJsPDF() {
  if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve();
  if (!cargaEnCurso) {
    cargaEnCurso = cargarScript(URL_JSPDF).then(() => cargarScript(URL_AUTOTABLE));
    cargaEnCurso.catch(() => { cargaEnCurso = null; });
  }
  return cargaEnCurso;
}

// ------------------------------------------------------------
// Texto y fechas
// ------------------------------------------------------------
/** Deja el texto apto para las fuentes estándar del PDF (WinAnsi). */
export function texto(valor) {
  return String(valor ?? "")
    .replace(/[−–]/g, "-")             // signo menos y guion medio
    .replace(/[   ]/g, " ")       // espacios especiales
    .replace(/[✓✔]/g, "Sí")
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ—‘’“”•…€]/g, "");
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "AAAA-MM-DD" -> "jueves 5 de noviembre de 2026". */
export function fechaLarga(clave) {
  const [a, m, d] = clave.split("-").map(Number);
  return `${DIAS[diaSemana(clave)]} ${d} de ${MESES[m - 1]} de ${a}`;
}

/**
 * Periodo en palabras:
 *  - "Hoy, jueves 5 de noviembre de 2026"
 *  - "Del 1 al 30 de noviembre de 2026"
 *  - "Del 28 de octubre al 3 de noviembre de 2026"
 */
export function periodoEnPalabras(desde, hasta) {
  if (desde === hasta) {
    const larga = fechaLarga(desde);
    return desde === claveDiaLima() ? `Hoy, ${larga}` : larga.charAt(0).toUpperCase() + larga.slice(1);
  }
  const [a1, m1, d1] = desde.split("-").map(Number);
  const [a2, m2, d2] = hasta.split("-").map(Number);
  if (a1 === a2 && m1 === m2) return `Del ${d1} al ${d2} de ${MESES[m2 - 1]} de ${a2}`;
  if (a1 === a2) return `Del ${d1} de ${MESES[m1 - 1]} al ${d2} de ${MESES[m2 - 1]} de ${a2}`;
  return `Del ${d1} de ${MESES[m1 - 1]} de ${a1} al ${d2} de ${MESES[m2 - 1]} de ${a2}`;
}

/** "S/ 1,234.50" listo para el PDF. */
export const dinero = (monto) => texto(soles(monto));

// ------------------------------------------------------------
// Documento
// ------------------------------------------------------------
export class DocumentoPDF {
  /**
   * @param {string} titulo     Título del encabezado (ej. "Reporte de ventas").
   */
  constructor(titulo) {
    const { jsPDF } = window.jspdf;
    this.doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    this.titulo = titulo;
    this.y = TOPE_CONTENIDO;
    this.anchoUtil = ANCHO - 2 * MARGEN;
    this.doc.setFont("helvetica", "normal");
    this.doc.setTextColor(...COLOR.negro);
  }

  /** Si no entra un bloque de alto h, pasa a una página nueva. */
  espacio(h) {
    if (this.y + h > ALTO - PIE) {
      this.doc.addPage();
      this.y = TOPE_CONTENIDO;
    }
  }

  /** Título de sección con una marca mostaza a la izquierda. */
  seccion(titulo) {
    this.espacio(18);
    if (this.y > TOPE_CONTENIDO + 1) this.y += 5;   // aire antes del título (no al inicio de página)
    else this.y += 3;
    this.doc.setFillColor(...COLOR.mostaza);
    this.doc.rect(MARGEN, this.y - 4.2, 2.2, 5.6, "F");
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(12.5);
    this.doc.setTextColor(...COLOR.negro);
    this.doc.text(texto(titulo), MARGEN + 4.5, this.y);
    this.y += 5;
  }

  /** Párrafo con ajuste de línea automático. */
  parrafo(contenido, { tam = 10, negrita = false, color = COLOR.negro } = {}) {
    this.doc.setFont("helvetica", negrita ? "bold" : "normal");
    this.doc.setFontSize(tam);
    this.doc.setTextColor(...color);
    const lineas = this.doc.splitTextToSize(texto(contenido), this.anchoUtil);
    const alto = lineas.length * tam * 0.42;
    this.espacio(alto + 1);
    this.doc.text(lineas, MARGEN, this.y + tam * 0.3);
    this.y += alto + 1.5;
    this.doc.setTextColor(...COLOR.negro);
  }

  /** Pares "Rótulo: valor" en dos columnas. */
  pares(filas, { tam = 10 } = {}) {
    const alto = tam * 0.5;
    for (const [rotulo, valor] of filas) {
      this.espacio(alto);
      this.doc.setFontSize(tam);
      this.doc.setFont("helvetica", "normal");
      this.doc.setTextColor(...COLOR.gris);
      this.doc.text(texto(rotulo), MARGEN, this.y + 3);
      this.doc.setFont("helvetica", "bold");
      this.doc.setTextColor(...COLOR.negro);
      const lineas = this.doc.splitTextToSize(texto(valor), this.anchoUtil - 55);
      this.doc.text(lineas, MARGEN + 55, this.y + 3);
      this.y += Math.max(alto, lineas.length * tam * 0.42 + 1);
    }
    this.y += 1.5;
  }

  /**
   * Recuadros grandes tipo tarjeta.
   * @param {Array<{rotulo, valor, detalle?, destacado?, colorValor?}>} items
   */
  tarjetas(items, columnas = 3) {
    const sep = 4;
    const ancho = (this.anchoUtil - sep * (columnas - 1)) / columnas;
    const alto = 23;
    for (let i = 0; i < items.length; i += columnas) {
      this.espacio(alto + sep);
      items.slice(i, i + columnas).forEach((t, j) => {
        const x = MARGEN + j * (ancho + sep);
        const d = this.doc;
        if (t.destacado) {
          d.setFillColor(...COLOR.mostazaClaro);
          d.setDrawColor(...COLOR.mostaza);
          d.setLineWidth(0.8);
          d.roundedRect(x, this.y, ancho, alto, 2, 2, "FD");
        } else {
          d.setDrawColor(...COLOR.grisLinea);
          d.setLineWidth(0.3);
          d.roundedRect(x, this.y, ancho, alto, 2, 2, "S");
        }
        d.setFont("helvetica", "normal");
        d.setFontSize(9);
        d.setTextColor(...COLOR.gris);
        d.text(texto(t.rotulo).toUpperCase(), x + 3.5, this.y + 6);
        d.setFont("helvetica", "bold");
        d.setFontSize(t.destacado ? 16 : 15);
        d.setTextColor(...(t.colorValor || COLOR.negro));
        d.text(texto(t.valor), x + 3.5, this.y + 14.5);
        if (t.detalle) {
          d.setFont("helvetica", "normal");
          d.setFontSize(9);
          d.setTextColor(...COLOR.gris);
          d.text(d.splitTextToSize(texto(t.detalle), ancho - 7)[0], x + 3.5, this.y + 20);
        }
      });
      this.y += alto + sep;
    }
    this.doc.setTextColor(...COLOR.negro);
    this.y += 1;
  }

  /**
   * Tabla con filas alternadas y encabezado que se repite en cada página.
   * @param {object} o  { cabecera: [...], filas: [[...]], pie?: [...], alinearDerecha?: [índices], anchos?: {índice: mm} }
   */
  tabla({ cabecera, filas, pie = null, alinearDerecha = [], anchos = {} }) {
    const columnStyles = {};
    alinearDerecha.forEach((i) => { columnStyles[i] = { ...(columnStyles[i] || {}), halign: "right" }; });
    Object.entries(anchos).forEach(([i, w]) => { columnStyles[i] = { ...(columnStyles[i] || {}), cellWidth: w }; });
    this.espacio(18);
    this.doc.autoTable({
      startY: this.y,
      head: [cabecera.map(texto)],
      body: filas.map((f) => f.map(texto)),
      foot: pie ? [pie.map(texto)] : undefined,
      margin: { top: TOPE_CONTENIDO, left: MARGEN, right: MARGEN, bottom: PIE },
      theme: "grid",
      showHead: "everyPage",
      showFoot: "lastPage",
      styles: { font: "helvetica", fontSize: 9.5, cellPadding: 1.8, textColor: COLOR.negro, lineColor: COLOR.grisLinea, lineWidth: 0.15, overflow: "linebreak" },
      headStyles: { fillColor: COLOR.mostaza, textColor: COLOR.negro, fontStyle: "bold" },
      footStyles: { fillColor: [230, 230, 230], textColor: COLOR.negro, fontStyle: "bold" },
      alternateRowStyles: { fillColor: COLOR.grisFila },
      columnStyles,
      didParseCell: (data) => {
        // También alinear a la derecha los encabezados y pies de columnas numéricas
        if ((data.section === "head" || data.section === "foot") && alinearDerecha.includes(data.column.index)) {
          data.cell.styles.halign = "right";
        }
      }
    });
    this.y = this.doc.lastAutoTable.finalY + 6;
  }

  /**
   * Inserta un <canvas> (por ejemplo el gráfico de Chart.js) a todo el ancho
   * útil. Se copia sobre fondo blanco y se guarda como JPEG: pesa mucho
   * menos que PNG y el fondo transparente no sale negro.
   */
  imagenDeCanvas(canvas, altoMax = 95) {
    const copia = document.createElement("canvas");
    copia.width = canvas.width;
    copia.height = canvas.height;
    const ctx = copia.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, copia.width, copia.height);
    ctx.drawImage(canvas, 0, 0);
    const proporcion = canvas.height / canvas.width;
    let ancho = this.anchoUtil;
    let alto = ancho * proporcion;
    if (alto > altoMax) { alto = altoMax; ancho = alto / proporcion; }
    this.espacio(alto + 2);
    this.doc.addImage(copia.toDataURL("image/jpeg", 0.88), "JPEG", MARGEN + (this.anchoUtil - ancho) / 2, this.y, ancho, alto);
    this.y += alto + 4;
  }

  /** Dibuja encabezado y pie en todas las páginas y descarga el archivo. */
  guardar(nombreArchivo) {
    const d = this.doc;
    const total = d.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      d.setPage(i);
      // Encabezado
      d.setFillColor(...COLOR.mostaza);
      d.rect(0, 0, ANCHO, 3, "F");
      d.setFont("helvetica", "bold");
      d.setFontSize(20);
      d.setTextColor(...COLOR.tomate);
      d.text("ALANA", MARGEN, 15);
      d.setFont("helvetica", "normal");
      d.setFontSize(9);
      d.setTextColor(...COLOR.gris);
      d.text(texto(`RUC: ${RUC} · Comida rápida`), MARGEN, 20.5);
      d.setFont("helvetica", "bold");
      d.setFontSize(13);
      d.setTextColor(...COLOR.negro);
      d.text(texto(this.titulo), ANCHO - MARGEN, 15, { align: "right" });
      d.setDrawColor(...COLOR.mostaza);
      d.setLineWidth(0.7);
      d.line(MARGEN, 24, ANCHO - MARGEN, 24);
      // Pie
      d.setDrawColor(...COLOR.grisLinea);
      d.setLineWidth(0.2);
      d.line(MARGEN, ALTO - 12, ANCHO - MARGEN, ALTO - 12);
      d.setFont("helvetica", "normal");
      d.setFontSize(8.5);
      d.setTextColor(...COLOR.gris);
      d.text("Generado por ALANA POS", MARGEN, ALTO - 7);
      d.text(texto(`Página ${i} de ${total}`), ANCHO - MARGEN, ALTO - 7, { align: "right" });
    }
    d.save(nombreArchivo);
  }
}
