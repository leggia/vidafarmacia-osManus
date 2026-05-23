# VidaFarma-OS — Estado del Proyecto

## ✅ Completado

### Autenticación
- [x] Reemplazado OAuth de Manus por login simple propio (`/login`)
- [x] Usuario y contraseña configurables via `ADMIN_USER` / `ADMIN_PASS` en `.env`
- [x] Sin dependencia de servidores externos de Manus

### Storage
- [x] Reemplazado storage proxy de Manus por almacenamiento local en `/uploads`
- [x] Archivos servidos via `/api/storage/`
- [x] Sin dependencia de `BUILT_IN_FORGE_API_URL` ni `BUILT_IN_FORGE_API_KEY`

### IA — Extracción de Facturas
- [x] Reemplazado Manus Forge API por Groq (gratis, sin restricción geográfica Bolivia)
- [x] Modelo: `meta-llama/llama-4-scout-17b-16e-instruct` (soporta visión)
- [x] PDFs convertidos a imagen PNG via `pdf2pic` antes de enviar a Groq
- [x] Imágenes convertidas a base64 para compatibilidad con Groq
- [x] `response_format` cambiado de `json_schema` a `json_object` (compatible Groq)
- [x] Configurar via `BUILT_IN_FORGE_API_KEY=tu_groq_key` en `.env`

### Base de Datos
- [x] MySQL configurado y tablas creadas con drizzle-kit push
- [x] `DATABASE_URL` configurado en `.env`

### Cache de Productos
- [x] Nuevo servicio `productos-cache.ts` con cache local de 5000 productos
- [x] Actualización automática cada 24 horas
- [x] Matching fuzzy local para búsqueda instantánea sin llamadas a API
- [x] Fallback a API si producto no está en cache
- [x] Endpoints `/cache/estadisticas`, `/cache/actualizar`, `/cache/listar`

### Integración con inventarios365.com
- [x] Login en 2 pasos funcional (GET token → POST credenciales)
- [x] Endpoint `/almacen/selectAlmacen` funcionando
- [x] Endpoint `/inventarios/registrar` funcionando
- [x] Búsqueda de artículos integrada con cache local

## 🔧 Variables de entorno requeridas (.env)

```env
NODE_ENV=development
DATABASE_URL=mysql://vidafarma:vidafarma2026@localhost:3306/vidafarma
SESSION_SECRET=vidafarma-secret-2026
JWT_SECRET=vidafarma-jwt-secret-2026
PORT=3000
VITE_APP_ID=vidafarma
ADMIN_USER=admin
ADMIN_PASS=vidafarma2026
ADMIN_EMAIL=admin@vidafarma.com
BUILT_IN_FORGE_API_KEY=tu_groq_api_key_aqui
```

## 🚧 Pendiente

- [ ] Probar extracción completa de factura PDF con Groq
- [ ] Verificar sincronización completa de compra en inventarios365.com
- [ ] Implementar cache de productos (descarga inicial de 5000 productos)
- [ ] Despliegue en Oracle Free Tier o Railway para 24/7
- [ ] Soporte para facturas con múltiples páginas PDF
- [ ] Agregar más usuarios admin desde la interfaz

## 🚀 Cómo ejecutar localmente

```bash
# 1. Clonar repo
git clone https://github.com/leggia/vidafarmacia-osManus.git
cd vidafarmacia-osManus

# 2. Instalar dependencias
pnpm install
pnpm add pdf2pic

# 3. Instalar poppler (para PDF)
sudo apt-get install -y poppler-utils

# 4. Configurar .env (ver variables arriba)

# 5. Iniciar MySQL y crear base de datos
sudo service mysql start
sudo mysql -e "CREATE DATABASE IF NOT EXISTS vidafarma; ..."
DATABASE_URL=... npx drizzle-kit push

# 6. Ejecutar
pnpm dev
```

## 📋 Flujo de una compra

1. Usuario sube foto o PDF de factura
2. Sistema guarda archivo en `/uploads`
3. IA (Groq/Llama 4 Scout) extrae productos, proveedor, número de comprobante
4. Usuario revisa y corrige si es necesario
5. Sistema busca productos en cache local (fuzzy matching)
6. Sistema registra compra en inventarios365.com via API
7. Confirmación al usuario
