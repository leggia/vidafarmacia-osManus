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
import { useAuth } from "./_core/hooks/useAuth";
import { useLocation } from "wouter";

function Router() {
  const { user } = useAuth();
  const [location] = useLocation();

  // TIENDA PÚBLICA para clientes: accesible SIN login, antes de cualquier control de rol.
  if (location.startsWith("/tienda")) {
    return <TiendaClientes />;
  }

  // Rol "regente": asistente + consulta + inventario + asistencia + fotos.
  if (user?.role === "regente") {
    return (
      <DashboardLayout>
        <Switch>
          <Route path="/" component={Consulta} />
          <Route path="/asistente" component={Asistente} />
          <Route path="/inventario" component={Inventario} />
        <Route path="/fotos" component={FotosProductos} />
          <Route path="/asistencia" component={Asistencia} />
          <Route path="/fotos" component={FotosProductos} />
          <Route component={Consulta} />
        </Switch>
      </DashboardLayout>
    );
  }

  // Rol "viewer" (consulta): solo ve la página de consulta de precios/stock.
  if (user?.role === "viewer") {
    return (
      <Switch>
        <Route path="/" component={Consulta} />
        <Route component={Consulta} />
      </Switch>
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
        <Route path="/asistencia" component={Asistencia} />
        <Route path="/reportes" component={Reportes} />
        <Route path="/gastos" component={Gastos} />
        <Route path="/fidelizacion" component={Fidelizacion} />
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
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
