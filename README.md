# ALANA POS

Sistema web de punto de venta para el restaurante de comida rápida **ALANA** (Perú).

- 100 % estático: HTML + CSS + JavaScript puro (ES modules). Sin npm, sin build, sin servidor propio.
- Datos y usuarios en **Firebase** (Authentication + Cloud Firestore, plan Spark gratis).
- Funciona en varias PCs a la vez: productos, ventas y caja se actualizan en tiempo real.
- Moneda en soles (S/), hora de Lima (America/Lima).

Publicado en: https://walmer2904.github.io/alana-pos/

## Páginas

| Página | Quién | Qué hace |
|---|---|---|
| `index.html` | Todos | Inicio de sesión con correo y contraseña |
| `ventas.html` | Todos | Punto de venta: catálogo, pedido, cobro (efectivo, Yape, Plin, tarjeta o **crédito**), ticket, ventas del turno (el admin puede anular) |
| `creditos.html` | Todos | Créditos pendientes en tiempo real, búsqueda por DNI/nombre, registrar pagos y abonos, comprobante, historial de pagados/anulados |
| `caja.html` | Todos | Apertura y cierre de caja (una sola caja abierta para todas las PCs), cobros de créditos, egresos, historial |
| `productos.html` | Admin | Productos con foto, precio, **costo de producción** y ganancia por unidad |
| `insumos.html` | Admin | Inventario de insumos: stock, compras (costo promedio), salidas/ajustes, historial, stock bajo |
| `trabajadores.html` | Admin | Trabajadores, pagos (sueldo, adelanto, bono), historial y comprobante con firma |
| `reportes.html` | Admin | Ventas cobradas, costo, ganancia bruta y neta, pagos a trabajadores, compras de insumos, productos más vendidos, gráfico, Excel |

## Estructura

```
alana-pos/
├── index.html, ventas.html, creditos.html, caja.html, productos.html,
│   insumos.html, trabajadores.html, reportes.html
├── manifest.webmanifest   Para instalar el sistema como app
├── css/estilos.css        Estilos compartidos (incluye impresión de ticket 80 mm)
├── img/                   Logo, íconos y patrón de dibujos de la pizarra
├── js/firebase.js         Configuración de Firebase (único lugar con la versión del SDK)
├── js/comun.js            protegerPagina(), menú, RUC, formatos, caja compartida, totales,
│                          validación de DNI, costos, egresos
├── js/login.js            Inicio de sesión
├── js/ventas.js, js/creditos.js, js/caja.js, js/productos.js,
│   js/insumos.js, js/trabajadores.js, js/reportes.js
└── firestore.rules        Reglas de seguridad (copiar a la consola de Firebase)
```

El **RUC** y el teléfono que salen en los tickets están en `js/comun.js` (constantes `RUC` y `TELEFONO`).

## DNI

En todo el sistema (créditos, buscadores y trabajadores) el DNI debe tener **exactamente 8 números** y no puede tener
todos los números iguales (00000000, 11111111…). Los campos borran letras al escribir y al pegar, y muestran un
contador "5/8". Las reglas de Firestore también lo exigen. En Créditos, el admin tiene el botón
**"Revisar DNIs inválidos"**, que lista (sin modificar nada) créditos y clientes guardados con DNI incorrecto.

## Costo de producción y ganancia

- Cada producto tiene **precio de venta** y **costo de producción**. Los productos antiguos sin costo muestran "Falta costo".
- Al vender, cada item guarda una copia de `costoUnitario` y `costoSubtotal`, así cambiar el costo después no altera reportes antiguos.
- **Ganancia bruta** = ventas cobradas − costo de producción. **Ganancia neta** = ganancia bruta − pagos a trabajadores.
- En los cobros de créditos, el costo cuenta en proporción a lo cobrado (costo del crédito × monto cobrado / total del crédito), en la fecha de cada cobro.
- Las **compras de insumos** se muestran solo como dato informativo: no se restan, porque su costo ya está incluido en el costo de producción de cada producto.

## Insumos, trabajadores y egresos de caja

- El descuento de insumos es **manual** (registrar salidas por uso, merma o ajuste). No se descuenta al vender.
- Una compra actualiza el costo unitario con **promedio ponderado**: (stock × costo + total pagado) / (stock + cantidad).
- Si una compra de insumos o un pago a un trabajador se marca **"Pagado con efectivo de caja"** (y hay caja abierta), se crea un
  documento en `egresos` en la misma transacción. Caja lo resta: **efectivo esperado = monto inicial + ventas en efectivo +
  cobros de créditos en efectivo − egresos en efectivo**. El cierre guarda el total y el detalle de egresos.
- `egresos` existe aparte porque `movimientosInsumos` y `pagosTrabajadores` son solo para admin, mientras que la Caja también la usa el cajero.
- Los trabajadores se **desactivan**, no se eliminan. Los movimientos de insumos y pagos a trabajadores nunca se borran.

## Ventas al crédito: cómo se cuentan

- Al vender al crédito se piden **DNI (8 dígitos)** y **nombre**. Si el DNI ya existe, se autocompleta el nombre y se muestra cuánto debe.
- Un crédito **no cuenta como venta** mientras no se pague: no suma en Caja ni en Reportes. Solo aparece en Créditos.
- Cada pago (total o abono) se guarda en `cobros` y cuenta **en la fecha del pago**, con el método con que pagaron, en la caja abierta en ese momento (si es efectivo, suma al efectivo esperado).
- Los productos del crédito cuentan en "más vendidos" cuando el crédito queda totalmente pagado. En ese momento también cuenta como 1 venta.
- Para registrar un pago debe haber una caja abierta.
- Los créditos pagados o anulados **nunca se borran**: pasan al Historial de la pestaña Créditos.
- El admin puede anular una venta al crédito **solo si no tiene pagos**. Al hacerlo también se anula el crédito.

## Datos en Firestore

- `usuarios/{uid}`: `{ nombre, rol: "admin" | "cajero" }`. Se crean a mano desde la consola.
- `productos`: `{ nombre, precio, costo, categoria, imagen (base64 JPEG ≤ ~200 KB), activo, creadoEn }`
- `ventas`: `{ fecha, items[{productoId, nombre, precio, cantidad, subtotal, costoUnitario, costoSubtotal}], total, metodoPago ("efectivo"|"yape"|"plin"|"tarjeta"|"credito"), montoRecibido, vuelto, usuarioId, usuarioNombre, cierreId, anulada }`. Las de crédito además llevan `dni`, `nombreCliente` y `creditoId`.
- `creditos`: `{ ventaId, dni, nombreCliente, items, total, saldoPendiente, estado ("pendiente"|"pagado"|"anulado"), fecha, usuarioNombre, cierreId, pagos[{monto, metodo, fecha, usuarioNombre, cierreId}], fechaPago }`
- `clientes/{dni}`: `{ dni, nombre, actualizadoEn }`
- `cobros`: `{ creditoId, ventaId, dni, nombreCliente, monto, metodo, fecha, cierreId, usuarioNombre, completaCredito, items (solo si completa el crédito), totalCredito, costoCredito, costoCompleto }`
- `insumos`: `{ nombre, unidad, stockActual, costoUnitario, stockMinimo, activo, actualizadoEn }`
- `movimientosInsumos`: `{ insumoId, nombreInsumo, tipo ("compra"|"salida"|"ajuste"), cantidad, costoTotal, motivo, stockAnterior, stockNuevo, pagadoConCaja, fecha, usuarioNombre, cierreId }`
- `trabajadores`: `{ nombre, dni, cargo, tipoPago, montoAcordado, activo, fechaIngreso }`
- `pagosTrabajadores`: `{ trabajadorId, nombreTrabajador, monto, concepto, periodo, metodo, fecha, observacion, usuarioNombre, cierreId, pagadoConCaja }`
- `egresos`: `{ tipo ("insumo"|"trabajador"), descripcion, monto, metodo: "efectivo", fecha, cierreId, referenciaId, usuarioNombre }`
- `cierres`: `{ estado, fechaApertura, fechaCierre, montoInicial, totalVentas, totalPorMetodo, efectivoEsperado, efectivoContado, diferencia, numVentas, creditosOtorgados {cantidad, monto}, cobrosCreditos {total, cantidad, efectivo, yape, plin, tarjeta}, egresos {total, cantidad, insumos, trabajadores, detalle[]}, usuarioApertura, usuarioCierre, observacion }`
- `config/cajaActual`: `{ cierreId }`, el id de la caja abierta (o `null`). Se cambia con transacciones para que nunca haya dos cajas abiertas.

Ninguna consulta necesita índices compuestos: todas filtran por un solo campo (`fecha`, `cierreId`, `estado`, `dni`, `insumoId` o `trabajadorId`) y el resto se ordena o filtra en el navegador.

## Crear un usuario nuevo (cajero)

1. Firebase > **Authentication** > Usuarios > *Agregar usuario* (correo y contraseña).
2. Copia su **UID**.
3. Firestore > colección `usuarios` > *Agregar documento* con ID = ese UID y campos:
   `nombre` (string) y `rol` (string: `cajero` o `admin`).

## Probar en local

Los ES modules no funcionan abriendo el archivo con doble clic (`file://`); se necesita un servidor local:

- **VS Code:** instala la extensión *Live Server*, clic derecho en `index.html` > *Open with Live Server*.
- **Python:** en la carpeta del proyecto ejecuta `python -m http.server 5500` y abre http://localhost:5500

Si el navegador abre `127.0.0.1` en lugar de `localhost`, agrégalo en
Firebase > Authentication > Configuración > **Dominios autorizados** (o abre la página con `localhost`).

## Publicar en GitHub Pages

1. Sube los cambios a la rama `main`.
2. En GitHub: **Settings > Pages > Build and deployment > Deploy from a branch > `main` / `(root)`** > Save.
3. En 1 o 2 minutos queda en https://walmer2904.github.io/alana-pos/
4. El dominio `walmer2904.github.io` debe estar en los dominios autorizados de Firebase Authentication.

## Reglas de Firestore

El archivo `firestore.rules` tiene las reglas completas. Cada vez que cambie, cópialo en
Firebase > Firestore Database > **Reglas** y presiona **Publicar**.

## Impresión de tickets

Los tickets y el reporte de cierre se imprimen con el diálogo del navegador, en formato de 80 mm.
En el diálogo elige la ticketera y desactiva "Encabezados y pies de página" para que salga limpio.
