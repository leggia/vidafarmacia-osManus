# Guía: instalar Claude Code en la PC de la Petrolera

Para hacer cuando estés frente a esa PC (con tiempo, conectada a internet y a la corriente).
Plan Pro es suficiente para Remote Control.

## Parte 1 — Instalar lo necesario (una sola vez)

### 1. Node.js
- Entra a https://nodejs.org y descarga la versión **LTS** (recomendada).
- Instálala (siguiente, siguiente, aceptar). Acepta que agregue Node al PATH.
- Para verificar: abre la terminal (busca "cmd" o "PowerShell" en el menú de Windows) y escribe:
  ```
  node --version
  ```
  Debe mostrar un número (ej. v20.x). Si lo muestra, Node está bien.

### 2. Claude Code
- En la misma terminal, escribe:
  ```
  npm install -g @anthropic-ai/claude-code
  ```
- Espera a que termine. Para verificar:
  ```
  claude --version
  ```
  Debe mostrar v2.1.52 o superior (necesario para Remote Control).

## Parte 2 — Conectar tu cuenta y el proyecto (una sola vez)

### 3. Clonar el proyecto
- Necesitas Git instalado (https://git-scm.com si no lo tienes).
- En la terminal, ve a donde quieras guardar el proyecto, por ejemplo:
  ```
  cd C:\
  git clone https://github.com/leggia/vidafarma-os.git vidafarma
  cd vidafarma
  ```
  (Te pedirá tu usuario y token de GitHub la primera vez.)

### 4. Iniciar Claude Code y hacer login
- Dentro de la carpeta del proyecto:
  ```
  claude
  ```
- La primera vez te pedirá iniciar sesión: usa `/login` y sigue el enlace para entrar con tu cuenta de Claude (la misma del plan Pro).
- Acepta el diálogo de confianza del workspace (workspace trust) cuando aparezca.
- Prueba pidiéndole algo simple, por ejemplo: "lee el archivo CLAUDE.md y dime qué entiendes del proyecto". Debería responder con el contexto.

## Parte 3 — Activar Remote Control (para controlar desde el celular)

### 5. Iniciar la sesión remota
- Dentro de Claude Code (o en la terminal del proyecto):
  ```
  claude remote-control
  ```
  (alias corto: `claude rc`)
- Mostrará una URL y un código QR (presiona la barra espaciadora para ver el QR).

### 6. Conectar el celular
- Abre la app de Claude en tu celular → pestaña **Código** → escanea el QR.
- O abre la URL en cualquier navegador.
- Listo: ya controlas la sesión de la PC desde el celular.

### 7. Dejarlo corriendo sin estorbar las ventas
- **Minimiza la ventana de la terminal** (no la cierres). Puede quedar en una esquina o en otro escritorio virtual de Windows.
- Mientras la terminal exista (aunque minimizada), la sesión sigue viva.
- Claude solo trabaja cuando le das una instrucción; el resto del tiempo está en espera, sin estorbar.

## Cosas que debes saber (límites reales)

- **La terminal debe quedar abierta** (minimizada está bien). Si la cierras, se corta la sesión.
- **Si se va internet más de ~10 minutos**, la sesión se cae; hay que volver a ejecutar `claude remote-control`.
- **Las actualizaciones de Windows o reiniciar la PC** cortan la sesión; hay que reiniciarla.
- **Te pedirá aprobar acciones** desde el celular (no es 100% automático; es por seguridad).
- Si algo falla con el plan/permisos, ejecuta `claude doctor` para ver qué revisar.

## Flujo de trabajo recomendado

- Antes de empezar a trabajar en una sesión: pídele "haz git pull" para traer cambios recientes.
- Al terminar un cambio: que verifique compilación (esbuild), suba versión en package.json, haga commit y push.
- Railway desplegará solo.

## Si trabajas también desde una laptop

- Instala Claude Code igual en la laptop.
- Regla de oro: **siempre `git pull` antes de empezar** en cada máquina, para no pisar cambios.
