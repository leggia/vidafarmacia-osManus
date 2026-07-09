# 🏛️ Arquitectura VidaFarma — Estado actual y evolución

> Documento vivo de arquitectura. Describe cómo está construido el sistema hoy,
> qué decisiones de diseño se tomaron, y la hoja de ruta para escalar.

---

## 1. Stack tecnológico

| Capa | Tecnología | Por qué |
|------|-----------|---------|
| Frontend | React 18 + TypeScript + Vite | SPA rápida, tipado fuerte, HMR |
| UI | Tailwind CSS + shadcn/ui (Radix) | Componentes accesibles, sin CSS custom |
| Estado/datos | tRPC + React Query | Tipos end-to-end cliente↔servidor, caché automático |
| Routing | wouter | Router mínimo (1.5 KB) |
| Backend | Node 20 + Express + tRPC | API tipada, mismo lenguaje que el front |
| ORM | Drizzle ORM | Tipado, migraciones automáticas (push) |
| BD | MySQL (Railway) | Relacional, suficiente para el dominio |
| IA visión | Groq + Llama 4 Scout | Extracción de facturas rápida y barata |
| Integración | inventarios365.com (Laravel) | Sistema POS existente de la farmacia |
| Deploy | Railway + GitHub Actions | CI/CD automático al push a main |
| PWA | manifest + service worker | Instalable en Android, uso móvil |

---

## 2. Mapa del sistema (capas)

```
┌─────────────────────────────────────────────────────────┐
│  CLIENTE (client/src)                                     │
│  ├── pages/        → pantallas (Compras, Inventario...)   │
│  ├── components/   → UI reutilizable + shadcn/ui          │
│  ├── lib/trpc      → cliente tipado hacia el backend      │
│  └── hooks/        → lógica reutilizable de React         │
└───────────────────────────┬─────────────────────────────┘
                            │ tRPC (tipos compartidos)
┌───────────────────────────┴─────────────────────────────┐
│  SERVIDOR (server)                                        │
│  ├── _core/        → infra (trpc, llm, auth, vite, env)   │
│  ├── routers.ts    → endpoints tRPC  ⚠️ MONOLITO (1277 l) │
│  ├── inventarios365 → cliente del POS ⚠️ MONOLITO (1437 l)│
│  ├── db.ts         → acceso a datos                       │
│  ├── confirmaciones* → motores de emparejamiento          │
│  ├── historial-precios → análisis de costos               │
│  └── productos-cache → caché de búsqueda                  │
└───────────────────────────┬─────────────────────────────┘
                            │ Drizzle ORM
┌───────────────────────────┴─────────────────────────────┐
│  DATOS                                                    │
│  ├── MySQL (Railway)  → 20 tablas                         │
│  └── inventarios365.com (Laravel/MySQL) → POS externo     │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Dominios funcionales (módulos)

El sistema tiene 6 dominios bien definidos. Hoy están mezclados en archivos grandes;
la evolución es separarlos en módulos independientes.

1. **Compras** — extracción de facturas con IA, emparejamiento, registro en POS.
2. **Inventario** — conteo físico, ABC, ajuste de stock, conteo puntual.
3. **Proveedores** — listado, emparejamiento inteligente, descuentos por laboratorio.
4. **Precios** — historial, alertas de costo, precio mínimo de compra.
5. **Asistencia** — trabajadores, aperturas de caja, cálculo de sueldos.
6. **Transferencias** — movimientos entre sucursales.

---

## 4. Decisiones de diseño clave (y por qué)

- **Integración por captura de red, no API oficial**: inventarios365 no expone API documentada.
  Cada endpoint se descubrió inspeccionando el tráfico del navegador. Por eso el cliente
  `inventarios365.ts` replica exactamente las cabeceras, cookies y formatos del POS.
- **Migraciones automáticas (drizzle push)**: al desplegar, las tablas nuevas se crean solas.
  Trade-off: rápido para iterar, pero sin control de versiones de esquema fino. Aceptable
  en esta etapa; a futuro conviene migraciones versionadas.
- **Aprendizaje por confirmación**: en vez de IA perfecta, el sistema aprende de cada
  emparejamiento manual (productos y proveedores). Mejora con el uso, costo casi nulo.
- **Caché en memoria con TTL**: para listados pesados del POS (inventario, productos),
  se cachea 5 min en memoria del servidor. Escalable a Redis si crece el tráfico.
- **Descuentos en cascada**: los laboratorios aplican descuento comercial (por producto) +
  volumen (~2%) + efectivo (~3%). El sistema los modela en cascada y cuadra con el total.

---

## 5. Deuda técnica identificada (orden de prioridad)

| # | Problema | Impacto | Esfuerzo |
|---|----------|---------|----------|
| 1 | `routers.ts` monolítico (1277 l) | Difícil de mantener y testear | Medio |
| 2 | `inventarios365.ts` monolítico (1437 l) | Mezcla auth, compras, inventario, caja | Medio |
| 3 | `NuevaCompra.tsx` monolítico (1593 l) | Componente gigante, estado complejo | Alto |
| 4 | Token de integración en sesión de chat | Riesgo de seguridad | Bajo (rotar) |
| 5 | Sin tests de los flujos críticos | Regresiones silenciosas | Medio |
| 6 | Caché en memoria (se pierde al reiniciar) | No escala horizontalmente | Medio |
| 7 | Tipos `any` en respuestas del POS | Errores en runtime | Bajo-Medio |

---

## 6. Plan de reestructuración (incremental, sin romper)

### Fase 1 — Modularizar el backend (alta prioridad)
Separar `routers.ts` en routers por dominio, e `inventarios365.ts` en sub-clientes:

```
server/
├── routers/
│   ├── index.ts          → compone el appRouter
│   ├── compras.router.ts
│   ├── inventario.router.ts
│   ├── proveedores.router.ts
│   ├── precios.router.ts
│   ├── asistencia.router.ts
│   └── transferencias.router.ts
├── integrations/inventarios365/
│   ├── client.ts         → auth + http base
│   ├── compras.ts        → ingreso, precios
│   ├── inventario.ts     → ajuste, listados
│   ├── proveedores.ts    → listar, contar
│   └── caja.ts           → aperturas de caja
└── domain/               → lógica de negocio pura (sin IO)
    ├── descuentos.ts     → cálculo en cascada
    ├── abc.ts            → clasificación ABC
    └── sueldos.ts        → cálculo de retrasos y pago
```

### Fase 2 — Modularizar el frontend
Extraer de `NuevaCompra.tsx` hooks y componentes:
- `useExtraccionFactura()` — subir, extraer, mapear items
- `useEmparejamiento()` — buscar, confirmar, aprender
- `useBorrador()` — autoguardado y protección de cierre
- `<ProductoCard />`, `<PanelEmparejamiento />`, `<ResumenTotales />`

### Fase 3 — Robustez
- Tipar las respuestas del POS con Zod (validación en runtime).
- Tests de los flujos críticos (extracción → registro, conteo → ajuste).
- Caché a Redis (Railway lo ofrece) para escalar horizontalmente.
- Migraciones versionadas en vez de push directo.

---

## 7. Futuras mejoras (roadmap de producto)

### Corto plazo
- **Aprendizaje de descuentos por laboratorio**: recordar %volumen y %efectivo de cada
  proveedor (tabla `descuentos_proveedor` ya creada) y sugerirlos al extraer.
- **Consulta de precio mínimo**: "¿cuál es el costo más bajo al que compré X?" (infra lista).
- **Dashboard de asistencia**: ver todos los trabajadores del mes de un vistazo.
- **Exportar resumen de sueldos a PDF/Excel** para el pago mensual.

### Mediano plazo
- **Agente conversacional** (WhatsApp Business API oficial, 1-a-1): el cliente pregunta
  precio/disponibilidad y un agente conectado al inventario responde. Requiere número
  aprobado y tiene costo por conversación. NO usar librerías no oficiales (riesgo de bloqueo).
- **Transferencias inteligentes**: sugerir reabastecimiento entre sucursales según stock.
- **Alertas de vencimiento**: avisar productos próximos a vencer (FEFO ya implementado).
- **Reportes**: márgenes por proveedor, productos más comprados, evolución de costos.

### Largo plazo
- **MCP server + agente central**: orquestar compras, inventario y reportes por lenguaje natural.
- **Interacción por voz** (estilo Alexa) para registrar o consultar.
- **Modelo de IA propio afinado** con las facturas históricas (más barato y preciso que Groq).
- **Predicción de demanda** para compras automáticas sugeridas.

---

## 8. Principios para seguir creciendo

1. **Un dominio, un módulo**: nuevas funciones van en su router/cliente, no en el monolito.
2. **Lógica de negocio pura y testeable**: cálculos (descuentos, sueldos, ABC) sin IO, fáciles de probar.
3. **Tipar las fronteras**: validar con Zod lo que entra del POS y del usuario.
4. **Caché con invalidación clara**: siempre saber cuándo y cómo se refresca.
5. **El POS es la fuente de verdad**: la BD local es caché y valor agregado, no duplica el POS.
6. **Aprender > codificar reglas**: preferir que el sistema aprenda (emparejamientos, descuentos)
   sobre codificar reglas rígidas que se rompen con cada variación.


## Módulos de la era Tienda + Marketing (v1.85+)

**Patrón de convención:** cada módulo de dominio vive en un archivo (`server/<dominio>.ts`), crea sus propias tablas con `CREATE TABLE IF NOT EXISTS` / `ALTER` idempotentes (try/catch) al primer uso, y expone funciones puras que `routers.ts` importa dinámicamente. Las integraciones externas (pagos, redes, imagen) son **enchufables**: la arquitectura existe siempre; el proveedor se activa por variables de entorno, con modo manual como respaldo.

| Módulo | Archivo | Tablas propias |
|---|---|---|
| Tienda pública | `server/tienda.ts` | reservas_tienda, ofertas_tienda |
| Promociones | `server/promociones.ts` | cupones, promos_monto |
| Puntos fidelidad | `server/puntos-fidelidad.ts` | clientes_puntos, puntos_movimientos, puntos_ventas_procesadas |
| Recordatorios | `server/fidelizacion.ts` | recordatorios_enviados |
| Pagos QR | `server/pagos.ts` | pagos_qr |
| Fotos productos | `server/fotos-productos.ts` | fotos_productos (MEDIUMBLOB) |
| Marketing | `server/marketing.ts` | marketing_posts (con imagen MEDIUMBLOB) |
| Imagen de posts | `server/marketing-imagen.ts` | (columnas en marketing_posts) |
| Publicación redes | `server/publicacion-redes.ts` | — (conector puro) |
| Diccionario | `server/diccionario-principios.ts` | — (estático) |

Rutas HTTP no-tRPC registradas en `server/_core/index.ts`: OAuth Google (staff y cliente), `/api/foto-producto/:id`, `/api/imagen-post/:id`, webhook `/api/pagos/webhook`, y el scheduler de publicaciones programadas (cada 5 min, nunca llama a 365).
