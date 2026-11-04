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
| `ventas.html` | Todos | Punto de venta: catálogo, pedido, cobro, ticket, ventas del turno (el admin puede anular) |
| `caja.html` | Todos | Apertura y cierre de caja (una sola caja abierta para todas las PCs), historial |
| `productos.html` | Admin | Agregar, editar, activar/desactivar y eliminar productos con foto |
| `reportes.html` | Admin | Totales, métodos de pago, productos más vendidos, gráfico por día, exportar a Excel |

## Estructura

```
alana-pos/
├── index.html, ventas.html, productos.html, caja.html, reportes.html
├── css/estilos.css        Estilos compartidos (incluye impresión de ticket 80 mm)
├── js/firebase.js         Configuración de Firebase (único lugar con la versión del SDK)
├── js/comun.js            protegerPagina(), menú, formato de soles/fechas, caja compartida
├── js/login.js            Inicio de sesión
├── js/ventas.js, js/productos.js, js/caja.js, js/reportes.js
└── firestore.rules        Reglas de seguridad (copiar a la consola de Firebase)
```

## Datos en Firestore

- `usuarios/{uid}`: `{ nombre, rol: "admin" | "cajero" }`. Se crean a mano desde la consola.
- `productos`: `{ nombre, precio, categoria, imagen (base64 JPEG ≤ ~200 KB), activo, creadoEn }`
- `ventas`: `{ fecha, items[{productoId, nombre, precio, cantidad, subtotal}], total, metodoPago, montoRecibido, vuelto, usuarioId, usuarioNombre, cierreId, anulada }`
- `cierres`: `{ estado, fechaApertura, fechaCierre, montoInicial, totalVentas, totalPorMetodo, efectivoEsperado, efectivoContado, diferencia, numVentas, usuarioApertura, usuarioCierre, observacion }`
- `config/cajaActual`: `{ cierreId }`, el id de la caja abierta (o `null`). Se cambia con transacciones para que nunca haya dos cajas abiertas.

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
