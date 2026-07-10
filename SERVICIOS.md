# 🏢 VidaFarma — Arquitectura de Servicios (Company of One)

> **Propósito de este documento.** Definir la estructura completa de VidaFarma como
> una *Company of One*: un negocio que mejora sin inflarse, donde una persona (Luis)
> más un equipo mínimo operan —con ayuda de agentes y automatización— lo que
> normalmente requeriría departamentos enteros.
>
> Este es el **mapa maestro**: cada área de negocio, qué hace, qué la automatiza hoy,
> qué falta, y con qué herramienta se opera. Es un documento vivo.

---

## 0. Filosofía Company of One aplicada a VidaFarma

El principio de Paul Jarvis: **cuestiona el crecimiento por el crecimiento.** En vez
de contratar un equipo de compras, un community manager, un analista y un
programador, VidaFarma usa:

- **Sistemas que acumulan datos** (backend puro, sin IA donde no hace falta).
- **Agentes que interpretan y ejecutan** bajo supervisión humana (el humano aprueba).
- **APIs de los mejores modelos** en vez de infraestructura propia (sin GPU, sin
  servidores 24/7 que mantener — se paga solo lo que se usa).

El resultado: **una farmacia de barrio que compite con cadenas gigantes** en lo que
le importa al cliente (cercanía, rapidez, atención personal), sin su sobrecarga.

Regla de oro transversal: **el agente sugiere, el humano aprueba.** Nada estructural
(precios, dinero, inventario, código en producción) se cambia sin confirmación.

---

## 1. Mapa de áreas de servicio

| # | Área | Qué cubre | Estado |
|---|------|-----------|--------|
| 1 | **Operaciones / Inventario** | Compras, stock, transferencias, vencimientos | 🟢 Operativo |
| 2 | **Ventas / Tienda** | Tienda online, reservas, catálogo, pagos | 🟢 Operativo |
| 3 | **Atención al cliente** | Consultas, reservas, WhatsApp, fidelización | 🟢 Operativo |
| 4 | **Finanzas** | Rentabilidad, gastos, sueldos, reportes, créditos, personal | 🟢 Operativo |
| 5 | **Desarrollo (Dev)** | Código, features, mantenimiento de la app | 🟢 Operativo |
| 6 | **Testing / QA** | Verificación pre-push, smoke tests, prevención de errores | 🟢 Operativo |
| 7 | **Marketing** | Promociones, contenido, calendario, segmentación (falta conectar redes) | 🟢 Operativo |
| 8 | **Inteligencia de negocio** | Análisis, decisiones, competencia | 🟢 Operativo |
| 9 | **Cumplimiento / Legal** | Controlados, recetas, normativa, privacidad | 🟡 Parcial |

Leyenda: 🟢 operativo · 🟡 parcial o en diseño · 🔴 pendiente.

---

## 2. Área: OPERACIONES / INVENTARIO 🟢

**Qué hace.** Todo lo que entra y se mueve: registrar compras desde facturas,
mantener el stock sincronizado, transferencias entre sucursales, alertas de
vencimiento y de reposición.

**Automatización actual:**
- **Lector de facturas por IA** (foto/PDF → productos, precios, vencimientos). Módulo
  de compras. Aprende de cada emparejamiento manual.
- **Sincronización de ventas** con inventarios365 (fuente de verdad del stock).
- **Asistente — herramientas de inventario:** `stockProducto`, `productosUrgentes`
  (reposición), `pedidoSucursal` (índice de cobertura), `vencimientosProximos`,
  `productosSinRotacion` (capital muerto), `historialCompraProducto`.

**Herramienta de operación:** app web (módulo Compras, Inventario, Transferencias) +
asistente conversacional.

**Responsable:** Luis + regente. **Agente:** asistente (rol admin/regente).

**Pendientes:** migrar lector de facturas de Groq a un modelo de visión vigente.

---

## 3. Área: VENTAS / TIENDA 🟢

**Qué hace.** La farmacia digital de cara al cliente: catálogo, búsqueda, carrito,
reservas, ofertas, pagos.

**Automatización actual:**
- **Tienda pública** (`/tienda`): búsqueda dinámica **por principio activo**
  (usa el campo descripción de 365 + diccionario de respaldo), carrito multi-producto,
  reservas con código VF-XXXX, "lo más vendido", categorías.
- **Motor de promociones unificado:** ofertas por producto, cupones (% o Bs) y promos
  automáticas por monto. Todo calculado server-side.
- **Pagos QR enchufables:** arquitectura lista para BNB/OpenBCB (automático por
  webhook) o modo manual (comprobante). Se activa con credenciales.
- **Panel de reservas** para el staff (pendiente/lista/entregada + estado de pago).
- **Filtro de controlados** (nombre + principio activo + diccionario) — no se venden
  psicotrópicos ni estupefacientes online, igual que la competencia.

**Herramienta de operación:** app web (Tienda para clientes, Reservas para staff).

**Responsable:** Luis + vendedoras. **Agente:** asistente para gestionar ofertas.

**Pendientes:** tramitar cuenta empresarial + API de pago QR; PWA instalable completa.

---

## 4. Área: ATENCIÓN AL CLIENTE 🟢

**Qué hace.** La relación con el cliente: resolver consultas, gestionar reservas,
recordar recompras, premiar la fidelidad.

**Automatización actual:**
- **Cuentas de cliente** con Google (historial de reservas, "pedir de nuevo").
- **Programa de puntos** (estilo Chávez Plus+): 1 punto/Bs, vale al llegar a 1000.
  **Unificado por teléfono** — suma en mostrador (365) y online, en la misma cuenta.
- **Recordatorios de recompra** por WhatsApp, calculados por **tasa de consumo**
  (cantidad ÷ días), con registro de contacto para no repetir.
- **WhatsApp** como canal directo (tocable desde reservas y recordatorios).

**Herramienta de operación:** app web (Fidelización, Reservas) + WhatsApp.

**Responsable:** Luis + vendedoras. **Ventaja Company of One:** atención personal que
las cadenas grandes no pueden dar (recordar a doña María su losartán por su nombre).

**Pendientes:** que las vendedoras registren el teléfono del cliente en 365 al
facturar (habilita puntos de mostrador + recordatorios).

---

## 5. Área: FINANZAS 🟢

**Qué hace.** La salud económica: cuánto se gana de verdad, qué se gasta, sueldos,
rentabilidad por sucursal.

**Automatización actual:**
- **Módulo de rentabilidad** (`rentabilidad.ts`, compartido reporte + asistente):
  ganancia por sucursal con sueldos por asistencia, gastos, cobertura de costo.
- **Asistente — herramientas financieras (solo admin):** `gananciaPeriodo` (con
  confiabilidad del costo), `rentabilidadSucursales`, `estadoPagosGastos`,
  `margenProductos`, `compararPeriodos`, `resumenEjecutivo`.
- **Gastos** (módulo dedicado): registro, pago, ocasionales, por sucursal.
- **Acciones con auditoría:** cambiar precio, marcar gasto pagado, registrar gasto
  (con guardrails y confirmación).

**Herramienta de operación:** app web (Reportes, Gastos) + asistente (rol admin).

**Responsable:** Luis (exclusivo — datos sensibles). **Seguridad:** finanzas solo
para admin; jamás visibles a otros roles.

**Pendientes:** proyecciones de flujo de caja; alertas automáticas de margen bajo.

---

## 6. Área: DESARROLLO (Dev) 🟢

**Nota operativa — precios pico de DeepSeek (desde mediados de julio 2026).**
DeepSeek introduce precio "hora pico / hora valle": el costo se **duplica** en dos
ventanas diarias (hora de Beijing 9:00–12:00 y 14:00–18:00 = UTC 1:00–4:00 y
6:00–10:00). **Convertido a hora de Cochabamba (UTC-4): 9:00 PM–12:00 AM y
2:00 AM–6:00 AM.**

Diagnóstico actual: **ninguna automatización llama a DeepSeek sola.** Todas las
llamadas (asistente conversacional, generar post de marketing) las dispara Luis con
un clic, en horario diurno boliviano — que es horario valle (precio normal). El
scheduler de marketing (cada 5 min) solo *publica* posts ya aprobados; no genera
contenido nuevo, así que no toca la API de DeepSeek.

**Regla para automatizaciones futuras que SÍ llamen a DeepSeek sin intervención
humana** (ej. un futuro "genera el post de la semana automáticamente" o análisis
nocturnos): evitar que se disparen entre **9:00 PM–12:00 AM** y **2:00 AM–6:00 AM**
hora Bolivia. Si una tarea de fondo necesita ese horario por otro motivo (poco
tráfico del servidor), usar un modelo distinto a DeepSeek para esa tarea puntual, o
programarla fuera de esas ventanas. El resto de integraciones (inventarios365, Groq,
Claude, servicios de imagen) no tienen este esquema de precio y no se ven afectadas.

**Qué hace.** Construir y mantener la app: nuevas funciones, correcciones, mejoras.

**Automatización actual:**
- **Claude Code** como agente de desarrollo (corre en el PC 24/7 de la Petrolera,
  accesible por Remote Control desde el celular). Ejecuta tareas de código completas.
- **CI/CD:** push a `main` → GitHub Actions → deploy automático a Railway.
- **Skill `vidafarma`** en `.claude/skills/`: da a Claude Code el contexto del proyecto
  (credenciales de recuperación, comandos de build, endpoints reales, lecciones).
- **Documentación viva:** `CLAUDE.md` (reglas de trabajo), `ARQUITECTURA.md`,
  `CONTINGENCIA.md`, `HISTORIAL_PROYECTO.md`, `CHANGELOG.md`.

**Herramienta de operación:** Claude Code (terminal/celular) + este repo.

**Responsable:** Luis dirige, Claude Code ejecuta. **Modelo:** por API (sin hardware
propio de IA — el camino Company of One).

**Flujo estándar:** describir tarea → Claude Code implementa → verifica compilación →
commit con versión → push → Railway despliega.

**Pendientes:** —

---

## 7. Área: TESTING / QA 🟡 → objetivo 🟢

**Qué hace.** Asegurar que lo que se despliega funciona y no rompe lo existente. En
un negocio donde el mismo sistema maneja dinero, inventario y clientes, un error en
producción cuesta ventas y confianza. El objetivo: **cero crashes en producción.**

### 7.1 Lo ya existente
- **Verificación de compilación** obligatoria antes de cada push (esbuild). Nota: el
  build de vite falla localmente (falta un plugin que solo existe en Railway) — eso
  NO es error real; se verifica con esbuild.
- **Heurístico de "usar variable antes de declararla"**: el patrón exacto que causó el
  crash de la tienda ("No se puede acceder a 'X' antes de la inicialización"). Escanea
  hooks (useEffect/useMemo/useCallback) que referencian variables declaradas después.
- **Balance de llaves/paréntesis** tras ediciones grandes de archivos.
- **Regla operativa:** tras cambios grandes de frontend, abrir la página una vez —los
  errores de inicialización solo aparecen en producción minificada, no al compilar.

### 7.2 Lecciones aprendidas (que definen las pruebas)
Errores reales que ya ocurrieron y que las pruebas deben prevenir:
- **Use-before-declaration** en React → crash total de la página en producción.
- **`drizzle-kit push --force`** borró ventas una vez → PROHIBIDO; columnas nuevas
  con ALTER idempotente (try/catch).
- **Llamadas a 365 al arrancar** → el servidor debe escuchar primero, cero llamadas a
  365 en el arranque.
- **Zona horaria** (servidor UTC, Bolivia UTC-4) → sin `ahoraBolivia()`, "hoy" consulta
  el día equivocado entre 20:00 y medianoche.
- **365 rechaza peticiones muy rápidas** → reintentos + pausa.

### 7.3 Diseño de la suite (para llegar a 🟢)

1. **Chequeo pre-push automatizado** (`scripts/verificar.sh` o skill de Claude Code)
   - Corre en orden: (a) heurístico use-before-declaration sobre archivos tocados,
     (b) compilación esbuild de cada archivo modificado, (c) balance de llaves.
   - Si algo falla, **bloquea el commit**. Es el filtro estándar antes de cada push.

2. **Pruebas de humo (smoke tests) de endpoints críticos**
   - Los flujos que no pueden romperse: crear reserva, calcular total con cupón,
     otorgar puntos, buscar producto, filtro de controlados (que un controlado NUNCA
     aparezca en la tienda).
   - Ejecutables contra una BD de prueba, sin tocar producción ni 365.

3. **Entorno de staging**
   - Una rama/deploy de prueba (Railway permite entornos). Probar ahí antes de
     mandar a producción. Especialmente para cambios de tienda (cara al cliente).

4. **Checklist de release** (en `CHANGELOG.md` o `todo.md`)
   - Antes de cada versión importante: compila / heurístico / abrir páginas tocadas /
     probar el flujo afectado / subir versión en package.json.

5. **Casos de prueba de seguridad** (críticos por rubro farmacia)
   - Un medicamento controlado no aparece en la tienda ni por nombre ni por principio
     activo ni por marca del diccionario.
   - Un rol no-admin no accede a finanzas.
   - El cálculo de total nunca confía en precios que manda el cliente.

**Herramienta de operación:** scripts de verificación + Claude Code + revisión visual
de Luis.

**Responsable:** Claude Code (automático) + Luis (prueba visual y de negocio).

**Pendientes (orden):** (1) chequeo pre-push como filtro estándar, (2) smoke tests de
los 5 flujos críticos, (3) staging, (4) checklist de release documentado.

---

## 8. Área: MARKETING 🟡 → objetivo 🟢

**Qué hace.** Atraer y retener clientes: promociones, difusión, contenido y
publicación automática en redes (Facebook y TikTok principalmente), recompra.

Marketing es el área de mayor potencial Company of One: donde una cadena contrata un
equipo de community managers, VidaFarma usa **un agente + un API de publicación**.

### 8.1 Lo ya construido (base)
- **Motor de promociones** (cupones, ofertas, promos por monto), operable por el
  asistente ("crea un cupón VERANO de 15%").
- **Recordatorios de recompra** por WhatsApp (retención automática).
- **Programa de puntos** (fidelización).
- **"Lo más vendido"** en la tienda (prueba social).

### 8.2 Módulo de PUBLICACIÓN AUTOMÁTICA en redes (nuevo, el gran salto)

**Objetivo:** que VidaFarma publique sola en **Facebook y TikTok** contenido de valor
(ofertas de la semana, consejos de salud, recordatorios de temporada), con el agente
redactando y generando la pieza, y Luis aprobando antes de publicar.

**Realidad técnica (investigada):**
- **Facebook** (Graph API de páginas de negocio): publicar es relativamente directo
  con un token de página de larga duración. Texto + imagen + enlace a la tienda.
- **TikTok** (Content Posting API): requiere **auditoría de la app** (2-4 semanas) para
  publicar en modo público; sin auditar, los posts quedan privados. Tokens de 24h.
  Límite ~15 posts/día. UX obligatoria (mostrar avatar del creador, disclosure de
  contenido comercial).
- **Decisión Company of One:** NO integrar cada red por separado (semanas de trámite
  por cada una, mantenimiento eterno). Usar un **API unificado de publicación** ya
  auditado (ej. Ayrshare, Postpeer, Zernio, Postproxy) que publica a Facebook +
  TikTok + Instagram con **una sola llamada** y maneja tokens/auditorías/UX por
  nosotros. Costo ~$24-50/mes. Es el "alquilar en vez de construir" del enfoque.

**Arquitectura propuesta (enchufable, como los pagos QR):**

```
  Agente de contenido (API Claude/DeepSeek)
        │  redacta post + sugiere pieza visual
        ▼
  Cola de aprobación (tabla marketing_posts: borrador → aprobado → publicado)
        │  Luis revisa y aprueba desde la app
        ▼
  Conector de publicación ENCHUFABLE
        ├── Facebook (Graph API directo, gratis)
        └── API unificado (TikTok + IG + FB) ← se activa con credenciales
        │
        ▼
  Redes sociales  +  registro de qué se publicó y cuándo
```

**Componentes a construir:**

1. **Generador de contenido** (`server/marketing.ts`)
   - Un agente que, por API, redacta posts según plantillas: "oferta de la semana",
     "consejo de salud de temporada", "producto destacado", "recordatorio (época de
     gripe, alergias, etc.)". Genera título, texto con hashtags y sugerencia de imagen.
   - Alimentado por datos reales: las ofertas activas, lo más vendido, productos por
     vencer (para promocionar y reducir merma).

2. **Cola de aprobación** (tabla `marketing_posts`)
   - Estados: `borrador` → `aprobado` → `publicado` / `descartado`.
   - Panel en la app (`/marketing`, solo admin): ver borradores, editar el texto,
     aprobar o descartar. **El humano siempre aprueba antes de publicar** (regla de oro).

3. **Conector de publicación enchufable** (`server/publicacion-redes.ts`)
   - Sin credenciales → modo manual (genera el texto + imagen para copiar/pegar).
   - Con credenciales de Facebook → publica directo en la página.
   - Con credenciales del API unificado → publica a TikTok + Instagram + Facebook.
   - Igual que los pagos QR: la arquitectura se construye ya, se activa con las llaves.

4. **Calendario y automatización**
   - Programar publicaciones (ej. "oferta de la semana cada lunes 9am").
   - Sugerencias proactivas: el agente propone contenido según el momento (temporada,
     stock por vencer, producto que subió en ventas).

### 8.3 Otras funciones de marketing
- **Sugerencias de oferta por rotación/vencimiento:** el asistente propone qué poner
  en oferta para mover stock por vencer (menos merma + más venta).
- **Segmentación de clientes** (usa el historial por teléfono): crónicos, inactivos,
  alto valor → campañas dirigidas por WhatsApp.
- **Difusión de la tienda:** QR físico en mostrador → `/tienda`; mensaje post-venta.

**Herramienta de operación:** app web (`/marketing`) + asistente + API de publicación.

**Responsable:** Luis aprueba; el agente redacta, genera y (tras aprobación) publica.

**Pendientes (orden sugerido):**
1. Tabla `marketing_posts` + panel de aprobación (`/marketing`).
2. Generador de contenido por API (posts de ofertas y consejos).
3. Conector de Facebook (Graph API — el más accesible, empezar por aquí).
4. Conector unificado para TikTok + Instagram (tras elegir proveedor).
5. Calendario/programación + sugerencias proactivas.
6. Segmentación de clientes.

**Trámite de Luis (en paralelo):** crear página de Facebook de negocio (si no existe)
y cuenta de TikTok de la farmacia; decidir el API unificado (comparar Ayrshare vs
Postpeer vs Zernio por costo y redes cubiertas).

---

## 9. Área: INTELIGENCIA DE NEGOCIO 🟢

**Qué hace.** Convertir datos en decisiones: qué se vende, qué conviene, cómo va todo.

**Automatización actual:**
- **Asistente conversacional (Jarvis)** con ~25 herramientas de consulta: ventas,
  ganancias, mejores vendedores, rentabilidad, comparaciones, resumen ejecutivo.
- **Análisis de competencia** documentado (Farmacorp, Chávez, Farma Elías): sus
  fortalezas (escala) y debilidades (experiencia) → la estrategia de VidaFarma.
- **`resumenEjecutivo`:** ventas del día, ritmo del mes vs anterior, pagos,
  vencimientos, cajas — la foto del negocio en un mensaje.

**Herramienta de operación:** asistente (rol admin).

**Responsable:** Luis. **Ventaja:** decisiones con datos reales, no intuición.

**Pendientes:** panel de tendencias visual; alertas proactivas ("las ventas de esta
semana bajaron X% vs la pasada").

---

## 10. Área: CUMPLIMIENTO / LEGAL 🟡 → objetivo 🟢

**Qué hace.** Operar dentro de la norma boliviana: medicamentos controlados, recetas,
protección de datos del cliente, facturación, y responsabilidad sanitaria. En una
farmacia esto no es opcional — es licencia para operar.

### 10.1 Lo ya construido
- **Filtro de controlados** en la tienda (revisa nombre + principio activo +
  diccionario de marcas): psicotrópicos, estupefacientes y precursores según normativa
  NO se ofertan online; se atienden en mostrador con receta. Igual que la competencia
  (Farmacorp, Chávez tampoco los venden online).
- **Roles y permisos** (deny by default): finanzas solo admin, cliente solo tienda.
- **Auditoría** de acciones sensibles (quién cambió qué precio, qué gasto, cuándo).
- **Seguridad técnica:** anti-CSRF en logins (state por BD), rate limiting, cookies
  seguras, validación de datos server-side.

### 10.2 Marco normativo aplicable (Bolivia) — a verificar con asesoría
Áreas que la operación debe respetar (consultar con contador/abogado local para el
detalle vigente):
- **Medicamentos controlados:** Ley 1008 y normativa de sustancias controladas.
  Venta bajo receta retenida, registro de dispensación. Solo mostrador.
- **Registro sanitario:** los productos deben tener registro sanitario vigente
  (AGEMED). No promocionar productos sin registro.
- **Publicidad de medicamentos:** hay restricciones sobre publicitar ciertos
  medicamentos (especialmente los de venta con receta). **Importante para el módulo de
  marketing/redes:** el agente NO debe generar publicidad de medicamentos de venta
  controlada; enfocar el contenido en venta libre, cuidado personal, y consejos de
  salud generales.
- **Facturación:** cumplir con la normativa de facturación electrónica del SIN
  (Servicio de Impuestos Nacionales) vigente. inventarios365 maneja la facturación.
- **Protección de datos personales:** el cliente entrega teléfono, nombre, historial
  de compras. Debe haber transparencia sobre qué se guarda y para qué.

### 10.3 Diseño (para llegar a 🟢)

1. **Política de privacidad y datos** (visible en la tienda)
   - Página `/privacidad`: qué datos se guardan (nombre, teléfono, historial), para
     qué (reservas, puntos, recordatorios), por cuánto tiempo, y cómo pedir borrado.
   - Casilla de consentimiento al crear cuenta o reservar.
   - **Requisito directo:** TikTok y Facebook EXIGEN una URL de política de privacidad
     para aprobar apps de publicación → esta página también habilita el marketing.

2. **Registro de dispensación de controlados** (mostrador)
   - Para los controlados que SÍ se venden en mostrador con receta: registro de a
     quién, qué, cuándo, y receta asociada. Cumplimiento y trazabilidad.

3. **Salvaguardas en el agente de marketing**
   - Regla dura: el generador de contenido no publicita medicamentos de venta con
     receta ni hace afirmaciones médicas (curar/tratar). Solo venta libre, cuidado,
     consejos generales con descargo ("consulta a tu médico/farmacéutico").

4. **Descargo sanitario en la tienda**
   - La tienda ya aclara que los productos con receta se atienden en mostrador y que
     los precios se confirman en farmacia. Reforzar con: "La información no reemplaza
     la consulta con un profesional de salud."

5. **Responsabilidad de la regente**
   - Toda decisión farmacéutica (qué se dispensa, sustituciones, consultas de salud)
     pasa por criterio de la regente. El sistema asiste, no reemplaza el criterio
     profesional.

**Herramienta de operación:** backend (reglas automáticas) + criterio de Luis y la
regente + asesoría legal/contable externa para lo normativo.

**Responsable:** Luis + regente (criterio farmacéutico) + asesor legal para validar.

**Pendientes (orden):** (1) página de privacidad + consentimiento (habilita también
el marketing en redes), (2) salvaguardas legales en el agente de contenido, (3)
registro de dispensación de controlados, (4) revisar con asesor la normativa de
publicidad de medicamentos antes de lanzar redes.

---

## 11. Cómo se conectan las áreas (flujo Company of One)

```
                    ┌─────────────────────────────┐
                    │   LUIS (decide y aprueba)   │
                    └──────────────┬──────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                         │
   ┌──────▼──────┐        ┌────────▼────────┐       ┌────────▼────────┐
   │  ASISTENTE  │        │   CLAUDE CODE   │       │   VENDEDORAS/   │
   │  (Jarvis)   │        │   (desarrollo)  │       │    REGENTE      │
   │ operación + │        │  código + test  │       │  atención +     │
   │ inteligencia│        │  + deploy       │       │  mostrador      │
   └──────┬──────┘        └────────┬────────┘       └────────┬────────┘
          │                        │                         │
   ┌──────▼────────────────────────▼─────────────────────────▼──────┐
   │                    APP VIDAFARMA (Railway)                      │
   │  Tienda · Reservas · Asistente · Compras · Reportes · Fidelidad │
   └──────────────────────────────┬─────────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   INVENTARIOS365 (verdad)    │
                    │   ventas · stock · clientes  │
                    └─────────────────────────────┘
```

Los **modelos de IA se consumen por API** (DeepSeek para el asistente, Claude para
desarrollo, Groq/visión para facturas). Sin hardware propio de IA: el camino
Company of One — siempre el mejor modelo, se paga solo lo usado, cero mantenimiento.

---

## 12. Prioridades sugeridas (hoja de ruta)

**✅ Completado** (desde la última revisión de esta hoja de ruta):
1. Testing — chequeo pre-push automatizado + smoke tests (16/16).
2. Legal — página de privacidad + consentimiento (`/privacidad`).
3. Marketing — sugerencias de oferta por rotación/vencimiento (`sugerirOfertas`).
4. Marketing — cola de aprobación + generador de contenido + imagen IA/foto propia
   (`/marketing`).
5. Marketing — segmentación de clientes (`segmentarClientes`) y calendario de
   publicaciones programadas (scheduler).
6. Transferencias con listas manuscritas (emparejado difuso) + carga de inventario
   por foto (con número de fila como ancla de precisión).
7. Créditos de la farmacia (registro, pagos, edición, análisis de conveniencia) y
   apartado personal privado.
8. Asistente: acción `aumentarStock`, alias de sucursales (Honduras/Central/Cobol),
   flujo de confirmación robustecido (una sola confirmación, respuestas breves, sin
   código de producto salvo pedido explícito).

**🔲 Pendiente — requiere trámite/decisión de Luis** (no es código):
- Conector de Facebook (Graph API) y/o API unificado (Ayrshare) para TikTok/Instagram
  — falta crear la página de Facebook de negocio y/o elegir proveedor + credenciales.
- Cuenta empresarial + API de pago QR (BNB/OpenBCB) — trámite bancario.
- Hábito de las vendedoras: registrar el teléfono del cliente en 365 al facturar.

**🔲 Pendiente — construible ahora:**
- Finanzas — proyecciones de flujo de caja y alertas automáticas de margen bajo.
- Inteligencia de negocio — panel de tendencias visual y alertas proactivas ("las
  ventas de esta semana bajaron X% vs la pasada").
- Legal — registro de dispensación de controlados en mostrador.
- Testing — entorno de staging antes de producción.
- Migrar el lector de facturas de compras de Groq a un modelo de visión vigente.

---

*Documento vivo. Actualizar conforme evolucionen las áreas. Última revisión: creación
de la estructura de servicios Company of One.*
