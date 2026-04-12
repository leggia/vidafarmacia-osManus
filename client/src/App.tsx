import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Home from "./pages/Home";
import Compras from "./pages/Compras";
import NuevaCompra from "./pages/NuevaCompra";
import Transferencias from "./pages/Transferencias";
import NuevaTransferencia from "./pages/NuevaTransferencia";
import Tareas from "./pages/Tareas";
import Historial from "./pages/Historial";

function Router() {
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
