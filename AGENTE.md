# 🤖 Plan de Arquitectura — Agente Inteligente VidaFarma

> Documento de diseño (sin implementar todavía). Define cómo construir un agente
> conversacional para la farmacia: modelos, caché en capas, inteligencia de negocio
> y bitácora de auto-mejora. Enfoque: escalable, seguro, costo casi nulo, tecnología actual.

---

## 0. Principios rectores

1. **El agente sugiere, el humano aprueba.** Nada estructural (tablas, código, precios) se cambia solo.
2. **No meter IA donde basta código.** Acumular datos es backend puro; la IA solo interpreta o conversa.
3. **El POS es la fuente de verdad.** La BD local es caché e inteligencia añadida, nunca reemplaza inventarios365.
4. **Costo por diseño, no por suerte.** Prompt fijo cacheable + datos cacheados + enrutamiento por dificultad.
5. **Seguridad primero.** Datos sensibles (sueldos, dinero) nunca salen al modelo sin necesidad real.
6. **Escalar por módulos.** Cada capacidad nueva es una herramienta del agente, no un monolito.

---

## 1. Visión general del agente

Un asistente conversacional para VidaFarma que responde en lenguaje natural usando
los datos reales del sistema. Ejemplos de lo que podría hacer:

- "¿Cuánto cuesta la amoxicilina 500 y hay stock?" → consulta precio + stock.
- "¿Qué productos se vendieron más este mes?" → lee la tabla de inteligencia de negocio.
- "¿Qué conviene reabastecer?" → razona sobre ventas + stock bajo.
- "Registra que se acabó el paracetamol jarabe" → anota una observación.

El agente NO es un modelo nuevo entrenado. Es un **modelo existente + tus herramientas + un buen prompt**.

---

## 2. Las tres capas de caché (cómo se combinan)

Son tres mecanismos distintos, en niveles distintos. Sus ahorros se SUMAN.

```
┌─────────────────────────────────────────────────────────────┐
│  CONSULTA DEL USUARIO: "¿precio y stock de amoxicilina?"     │
└───────────────────────────┬─────────────────────────────────┘
                            │
            ┌───────────────▼────────────────┐
            │  CAPA 1 — Caché de contexto     │  (en la API del modelo)
            │  El prompt de sistema FIJO de   │  Ahorra TOKENS (dinero de API)
            │  VidaFarma se cobra ~50x más    │  Cache hit: $0.0028/M
            │  barato al repetirse.           │  vs miss: $0.14/M
            └───────────────┬────────────────┘
                            │ el modelo pide datos vía herramienta
            ┌───────────────▼────────────────┐
            │  CAPA 2 — Caché de datos        │  (en tu servidor — YA EXISTE)
            │  productos-cache + inventario   │  Ahorra LLAMADAS al POS
            │  TTL 5 min. Si está fresco, no  │  (velocidad + no saturar
            │  golpea inventarios365.         │   inventarios365)
            └───────────────┬────────────────┘
                            │
            ┌───────────────▼────────────────┐
            │  CAPA 3 — Inteligencia local    │  (tablas derivadas — NUEVO)
            │  Más vendidos, rotación, etc.   │  Datos ya calculados, listos
            │  Pre-calculado, no se recalcula │  para responder al instante
            │  en cada consulta.              │
            └─────────────────────────────────┘
```

**Distinción clave:**
- Capa 1 abarata *texto repetido* (no recuerda ni aprende — es solo costo).
- Capa 2 evita *llamadas externas repetidas*.
- Capa 3 evita *recalcular estadísticas* en cada consulta.

### Cómo maximizar la Capa 1 (estructura del prompt)
El secreto es poner lo FIJO al inicio y lo VARIABLE al final:

```
[ PREFIJO FIJO — se cachea, casi gratis al repetirse ]
- Identidad: "Eres el asistente de VidaFarma, farmacia en Cochabamba..."
- Reglas: almacenes (1=Principal, 2=Petrolera, 3=Lanza, 4=Cobol), formato de respuesta
- Herramientas disponibles y cómo usarlas
- Políticas: qué NO puede hacer, qué datos son sensibles

[ SUFIJO VARIABLE — se paga normal, es pequeño ]
- La pregunta concreta del usuario
- Contexto puntual (resultados de la herramienta que acaba de llamar)
```

Como el prefijo es el 80-90% del prompt y casi no se paga, el costo por consulta se desploma.

---

## 3. Selección de modelos (enrutamiento por dificultad)

No se elige UN modelo. Se enruta según la dificultad de la tarea. Tecnología actual (jun 2026):

| Tipo de tarea | Modelo sugerido | Por qué |
|---------------|-----------------|---------|
| Visión de facturas (ya en uso) | Groq + Llama 4 Scout | Rápido y barato, ya integrado |
| Consultas simples (precio, stock) | DeepSeek V4 Flash | El más barato de clase frontier, con caché automático |
| Razonamiento (qué comprar, análisis) | DeepSeek V4 (modo thinking) | Razona bien, sigue barato |
| Casos críticos puntuales | Modelo premium (Claude/GPT) | Solo cuando lo amerite, no por defecto |

**Ventaja decisiva de DeepSeek para migrar:** habla formato OpenAI y formato Anthropic.
Cambiar de proveedor es casi solo cambiar la URL base y la clave de API.

**Riesgos a vigilar (ya conocidos por experiencia):**
- Disponibilidad regional: Gemini estuvo bloqueado en Bolivia (tier gratuito). Verificar DeepSeek directo;
  si falla, usar vía OpenRouter/Together/Fireworks (aunque OpenRouter ya dio problemas antes).
- Privacidad de datos: los modelos chinos procesan datos en sus servidores. NUNCA enviar sueldos,
  datos personales del personal, ni información financiera sensible al modelo. Solo lo necesario
  para la consulta (precio, stock, nombre de producto).

---

## 4. El agente como conjunto de herramientas (tools)

El agente no "sabe" nada de la farmacia. Pide datos llamando herramientas que TÚ controlas.
Esto es seguro: el agente solo puede hacer lo que las herramientas permiten.

### Herramientas de SOLO LECTURA (seguras, primera fase)
- `buscar_producto(texto)` → precio + stock (ya existe: consultarProductos)
- `mas_vendidos(mes)` → top productos del mes (Capa 3)
- `stock_bajo()` → productos por debajo del mínimo
- `historial_precio(producto)` → evolución de costo (ya existe infra)

### Herramientas de ESCRITURA (con cuidado, fases posteriores)
- `registrar_observacion(texto)` → anota en la bitácora de sugerencias (seguro: solo escribe notas)
- Cualquier otra que modifique inventario/precios → requiere confirmación humana explícita

**Regla de oro:** ninguna herramienta de escritura que toque dinero, inventario real o sueldos
se ejecuta sin que un humano lo apruebe en el momento.

---

## 5. Inteligencia de negocio (datos derivados del uso)

Tablas nuevas que el BACKEND llena automáticamente (sin IA) a partir de lo que ocurre.
La IA solo las LEE cuando alguien pregunta. Esto es la Capa 3.

### Tabla propuesta: `ventas_mensuales` (o estadísticas de rotación)
Acumula por producto y mes: unidades vendidas, veces consultado, veces sin stock.
- Fuente: idealmente las ventas de inventarios365 (a confirmar si la API las expone),
  o derivado de las salidas de inventario.
- Uso: "¿qué se vendió más?", "¿qué reabastezco?", predicción de demanda.

### Ya tienes a medio camino (reutilizar):
- `historialPrecios` → evolución de costos (ya existe).
- Clasificación ABC del inventario (ya existe en domain/abc.ts).
- `descuentosProveedor` → aprendizaje de % por laboratorio (tabla lista, sin conectar aún).

**Importante:** acumular estos datos NO requiere IA. Es guardar registros cuando ocurren operaciones.
La IA entra solo para INTERPRETAR ("¿qué me recomiendas?") o CONVERSAR sobre ellos.

---

## 6. Bitácora de auto-mejora (el agente sugiere, tú apruebas)

Una tabla `sugerencias_sistema` donde se acumulan observaciones para que TÚ revises.

### Quién escribe en ella:
- El agente, cuando detecta patrones ("muchos buscan producto X que no está en catálogo").
- El propio sistema, automáticamente ("esta búsqueda falló 10 veces", "este proveedor siempre
  tiene 2% volumen + 3% efectivo").

### Qué NO hace:
- NO crea tablas solo. NO cambia código. NO altera la BD por su cuenta.
- Solo ANOTA. La implementación de cada sugerencia la decides tú (y la construimos juntos).

### Estructura conceptual:
- fecha, origen (agente/sistema), categoría (catálogo/precio/rendimiento/UX), descripción,
  estado (nueva/revisada/implementada/descartada), datos de respaldo.

### Flujo sano:
```
Uso del sistema → genera observaciones → bitácora → tú revisas periódicamente
  → las buenas las implementamos → el sistema mejora → repite
```

Lo mejor de ambos mundos: el sistema aprende de su uso y propone, pero el control de
qué cambia sigue siendo tuyo.

---

## 7. Seguridad (no negociable)

- **Aislamiento de datos sensibles:** sueldos, datos del personal y finanzas NUNCA van al modelo.
  El agente de farmacia y el módulo de asistencia están separados.
- **Herramientas como límite:** el agente solo puede lo que las herramientas exponen. Sin herramienta
  de borrado = no puede borrar.
- **Confirmación humana** para toda escritura que afecte inventario, precios o dinero.
- **Sin secretos al modelo:** tokens, contraseñas y claves jamás en el prompt.
- **Registro de acciones:** toda acción del agente queda logueada (auditable).
- **Rol mínimo:** si el agente atiende público (contingencias), usa el rol viewer (solo precio+stock),
  nunca el admin.

---

## 8. Plan por fases (incremental, sin romper lo que funciona)

### Fase 0 — Preparación (sin IA conversacional aún)
- Definir y crear las tablas de inteligencia (ventas/rotación) que el backend llena solo.
- Empezar a acumular datos desde ya, para que cuando llegue el agente tenga historia que leer.

### Fase 1 — Agente de consulta (solo lectura)
- Integrar DeepSeek V4 Flash (o Groq) con prompt de sistema fijo cacheable.
- Herramientas de solo lectura: buscar_producto, mas_vendidos, stock_bajo.
- Probar disponibilidad desde Bolivia. Medir costo real (debería ser centavos).

### Fase 2 — Inteligencia y sugerencias
- Conectar la bitácora de auto-mejora.
- Conectar el aprendizaje de descuentos por proveedor (tabla ya existe).
- Respuestas tipo "¿qué conviene comprar?".

### Fase 3 — Canales y voz (futuro)
- WhatsApp Business API oficial (1-a-1) para clientes. NUNCA librerías no oficiales.
- Interacción por voz para registrar/consultar.

### Fase 4 — MCP (estandarizar)
- Exponer las herramientas vía MCP (Model Context Protocol), el estándar para dar
  herramientas a modelos. Permite conectar el inventario a cualquier agente compatible.

---

## 9. Estimación de costo (orden de magnitud)

A volumen de farmacia (no miles de usuarios), con DeepSeek V4 Flash + caché de contexto:
- Prompt fijo de ~2,000 tokens cacheado → casi gratis al repetirse.
- Consultas variables pequeñas.
- **Resultado esperado: centavos a pocos dólares al mes**, no cientos.

La regla: la llamada de API más barata es la que no haces. Caché en las tres capas + prompts
eficientes + modelo barato = costo casi nulo.

---

## 10. Decisiones abiertas (a resolver antes de implementar)

1. ¿La API de inventarios365 expone las VENTAS? (clave para "más vendidos"). Si no,
   derivarlo de salidas de inventario.
2. ¿DeepSeek directo funciona desde Bolivia, o hay que usar un proveedor intermediario?
3. ¿El agente será solo interno (para ti) o también de cara al cliente (contingencias)?
4. ¿Qué tareas justifican un modelo premium ocasional y cuáles se quedan en el barato?

---

## Resumen ejecutivo

- **Modelo:** existente y barato (DeepSeek V4 Flash base), enrutado por dificultad. NO fine-tuning.
- **Caché en 3 capas:** contexto del modelo (tokens) + datos de inventario (llamadas) + inteligencia (cálculos). Se suman.
- **Agente = modelo + herramientas controladas + prompt fijo cacheable.**
- **Inteligencia de negocio:** tablas que el backend llena solo; la IA las interpreta.
- **Auto-mejora:** el agente anota sugerencias; tú apruebas e implementas. Nunca se auto-modifica.
- **Seguridad:** datos sensibles aislados, herramientas como límite, confirmación humana para escrituras.
- **Escalable por fases:** consulta → inteligencia → canales/voz → MCP.
