import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Home from "./pages/Home";
import Asistente from "./pages/Asistente";
import Compras from "./pages/Compras";
import NuevaCompra from "./pages/NuevaCompra";
import Transferencias from "./pages/Transferencias";
import NuevaTransferencia from "./pages/NuevaTransferencia";
import Tareas from "./pages/Tareas";
import Historial from "./pages/Historial";
import Inventario from "./pages/Inventario";
import Asistencia from "./pages/Asistencia";
import Reportes from "./pages/Reportes";
import Gastos from "./pages/Gastos";
import Fidelizacion from "./pages/Fidelizacion";
import Consulta from "./pages/Consulta";
import TiendaClientes from "./pages/TiendaClientes";
import FotosProductos from "./pages/FotosProductos";
import Reservas from "./pages/Reservas";
import Marketing from "./pages/Marketing";
import Privacidad from "./pages/Privacidad";
import Creditos from "./pages/Creditos";
import Personal from "./pages/Personal";
import FlujoCaja from "./pages/FlujoCaja";
import Contingencia from "./pages/Contingencia";
import Dispensacion from "./pages/Dispensacion";
import Psicotropicos from "./pages/Psicotropicos";
import Contactos from "./pages/Contactos";
import { useAuth } from "./_core/hooks/useAuth";
import { useLocation } from "wouter";
import { LogOut } from "lucide-react";
import { trpc } from "@/lib/trpc";

// Aviso fijo cuando el entorno corre en MODO STAGING (pruebas): ningún cambio
// (compras, ajustes de stock, transferencias) llega al inventario/ventas REAL
// de inventarios365 — las escrituras quedan simuladas. Visible SIEMPRE, incluso
// antes de iniciar sesión, para que nadie confunda este entorno con producción.
function BannerStaging() {
  const { data } = trpc.sistema.estado.useQuery();
  if (!data?.modoStaging) return null;
  return (
    <div className="sticky top-0 z-[100] bg-amber-500 text-black text-center text-xs font-black py-1.5 px-2">
      🧪 MODO STAGING — entorno de pruebas. Los cambios NO afectan el inventario ni las ventas reales.
    </div>
  );
}

// Botón simple de cerrar sesión, para vistas simplificadas que no usan
// DashboardLayout (donde normalmente vive el logout).
function BotonCerrarSesion() {
  const { logout } = useAuth();
  return (
    <button
      onClick={() => logout()}
      className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground"
      title="Cerrar sesión"
    >
      <LogOut className="w-4 h-4" /> Salir
    </button>
  );
}

function Router() {
  const { user } = useAuth();
  const [location] = useLocation();

  // TIENDA PÚBLICA para clientes: accesible SIN login, antes de cualquier control de rol.
  if (location.startsWith("/tienda")) {
    return <TiendaClientes />;
  }

  // Política de privacidad: pública (requisito legal y de Facebook/TikTok).
  if (location.startsWith("/privacidad")) {
    return <Privacidad />;
  }

  // Clientes logueados (rol "cliente") solo acceden a la tienda, no al sistema interno.
  if (user?.role === "cliente") {
    return <TiendaClientes />;
  }

  // Rol "regente": asistente + consulta + inventario + transferencias + asistencia + fotos.
  if (user?.role === "regente") {
    return (
      <DashboardLayout>
        <Switch>
          <Route path="/" component={Consulta} />
          <Route path="/asistente" component={Asistente} />
          <Route path="/inventario" component={Inventario} />
          <Route path="/transferencias" component={Transferencias} />
          <Route path="/transferencias/nueva" component={NuevaTransferencia} />
          <Route path="/contingencia" component={Contingencia} />
          <Route path="/dispensacion" component={Dispensacion} />
          <Route path="/psicotropicos" component={Psicotropicos} />
          <Route path="/contactos" component={Contactos} />
          <Route path="/fotos" component={FotosProductos} />
          <Route path="/asistencia" component={Asistencia} />
          <Route path="/reservas" component={Reservas} />
          <Route component={Consulta} />
        </Switch>
      </DashboardLayout>
    );
  }

  // Rol "viewer" (consulta): solo ve la página de consulta de precios/stock, en
  // una vista simplificada (sin el menú completo) — pero SÍ necesita poder cerrar
  // sesión, por ejemplo cuando le cambian el rol y debe reingresar para que se
  // aplique. Barra superior mínima con el botón de salir.
  // SEGURIDAD: cualquier rol desconocido también cae aquí (vista más restringida),
  // nunca al dashboard completo de administración. Sin sesión (user undefined) se
  // sigue de largo: DashboardLayout es quien muestra la pantalla de login.
  if (user && user.role !== "user" && user.role !== "admin") {
    return (
      <div className="min-h-screen">
        <div className="flex items-center justify-between px-4 h-12 border-b bg-background">
          <span className="text-sm font-bold">VidaFarma</span>
          <div className="flex items-center gap-4">
            <a href="/contingencia" className="text-xs font-bold text-red-600">Contingencia</a>
            <a href="/dispensacion" className="text-xs font-bold text-indigo-600">Controlados</a>
            <a href="/contactos" className="text-xs font-bold text-sky-600">Contactos</a>
            <BotonCerrarSesion />
          </div>
        </div>
        <Switch>
          <Route path="/" component={Consulta} />
          <Route path="/reservas" component={Reservas} />
          <Route path="/contingencia" component={Contingencia} />
          <Route path="/dispensacion" component={Dispensacion} />
          <Route path="/psicotropicos" component={Psicotropicos} />
          <Route path="/contactos" component={Contactos} />
          <Route component={Consulta} />
        </Switch>
      </div>
    );
  }

  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/compras" component={Compras} />
        <Route path="/compras/nueva" component={NuevaCompra} />
        <Route path="/transferencias" component={Transferencias} />
        <Route path="/transferencias/nueva" component={NuevaTransferencia} />
        <Route path="/tareas" component={Tareas} />
        <Route path="/historial" component={Historial} />
        <Route path="/inventario" component={Inventario} />
        <Route path="/fotos" component={FotosProductos} />
        <Route path="/reservas" component={Reservas} />
        <Route path="/asistencia" component={Asistencia} />
        <Route path="/reportes" component={Reportes} />
        <Route path="/gastos" component={Gastos} />
        <Route path="/fidelizacion" component={Fidelizacion} />
        <Route path="/marketing" component={Marketing} />
        <Route path="/creditos" component={Creditos} />
        <Route path="/personal" component={Personal} />
        <Route path="/flujo-caja" component={FlujoCaja} />
        <Route path="/contingencia" component={Contingencia} />
        <Route path="/dispensacion" component={Dispensacion} />
        <Route path="/psicotropicos" component={Psicotropicos} />
        <Route path="/contactos" component={Contactos} />
        <Route path="/consulta" component={Consulta} />
        <Route path="/asistente" component={Asistente} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <BannerStaging />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
