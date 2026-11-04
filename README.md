# Dashboard Stablecoins COP ↔ USDT/USDC vs Buda

App Node sin dependencias para seguir las tasas de compra y venta de stablecoins
en Colombia frente a Buda. Captura automáticamente desde el agregador público
**CriptoYa** cada N minutos y guarda el historial; además permite captura manual
de apps que no publican tasa (Plenti, Littio, Wenia, Global66, Vita).

## Desplegar en Railway (igual que tus otros proyectos)

1. Sube estos archivos a un **repositorio nuevo** de GitHub:
   `server.js`, `index.html`, `package.json`, `.gitignore`, `README.md`.
2. En Railway: **New Project → Deploy from GitHub repo** → elige el repo.
3. **Variables**: agrega `DATA_DIR` = `/data`.
4. **Volume** (disco permanente, para no perder el historial):
   - En el lienzo del proyecto, clic derecho (o `Ctrl/⌘ + K` → *Volume*) →
     conéctalo al servicio → **Mount path**: `/data`.
5. **Settings → Networking → Generate Domain** (puerto 8080 / el que asigne Railway;
   la app escucha en `process.env.PORT`).

Opcional: `APP_PASSWORD` = una clave, para exigir acceso. El front la pide una vez.

## Cómo funciona

- **Captura automática**: cada `captureMinutes` (por defecto 60) el servidor llama a
  `https://criptoya.com/api/USDT/COP/{volume}` y `.../USDC/COP/{volume}`, guarda
  `totalAsk` (compra) y `totalBid` (venta) de cada exchange en `data/history.json`.
- **Captura manual**: formulario en la página para apps sin API. Se guarda en
  `data/manual.json`. Editable, con respaldo (exportar) e importar.
- **Vistas**: Moneda (USDT/USDC) × Operación (Compra COP→cripto / Venta cripto→COP).
  - Compra: menor tasa = mejor. Venta: mayor tasa = mejor.
- **Insignia**: posición de Buda entre todas las apps de esa vista.
- **Ocultar apps**: oculta cualquier app en todas las vistas (compartido).
- **Servicios**: tabla comparativa (primer barrido; se completa con fuente).

## Endpoints

- `GET /api/data` — historial + manuales + config
- `POST /api/capture` — fuerza una captura ahora
- `POST /api/manual` · `/api/manual/update` · `/api/manual/delete` · `/api/manual/import`
- `POST /api/config` — `{ volume, captureMinutes, hidden[] }`
- `GET /health`

## Nota de datos

Las tasas automáticas provienen de CriptoYa (fuente pública de terceros). Las apps
Plenti, Littio, Wenia, Global66 y Vita no publican cotizador; sus tasas son las que
se carguen manualmente.
