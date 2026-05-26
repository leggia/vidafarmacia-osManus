import { useState, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  Loader2,
  Trash2,
  Plus,
  Save,
  ArrowLeft,
  Sparkles,
  Check,
  CheckCircle2,
  Calendar,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

interface ExtractedItem {
  productName: string;
  quantity: number;
  unitCost: number;
  subtotal: number;
  expiryDate?: string | null;
}

interface ProductoNoEncontrado {
  nombre: string;
  nombreLimpio?: string;
  cantidad: number;
  precio?: number;
  busqueda?: string;
}

// Convierte fecha MM/YYYY o DD/MM/YYYY a formato YYYY-MM-DD para input date
function convertExpiryDate(date: string | null | undefined): string | null {
  if (!date) return null;
  // Formato MM/YYYY → último día del mes YYYY-MM-DD
  const mmYYYY = date.match(/^(\d{2})\/(\d{4})$/);
  if (mmYYYY) {
    return `${mmYYYY[2]}-${mmYYYY[1]}-01`;
  }
  // Formato DD/MM/YYYY → YYYY-MM-DD
  const ddMMYYYY = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddMMYYYY) {
    return `${ddMMYYYY[3]}-${ddMMYYYY[2]}-${ddMMYYYY[1]}`;
  }
  return date;
}

export default function NuevaCompra() {
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: branchesData } = trpc.branches.list.useQuery();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string>("");
  const [receiptNumber, setReceiptNumber] = useState("");
  const [supplier, setSupplier] = useState("");
  const [items, setItems] = useState<ExtractedItem[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [extracted, setExtracted] = useState(false);
  const [showExpiry, setShowExpiry] = useState(false);
  const [receiptType, setReceiptType] = useState<"BOLETA" | "FACTURA">("FACTURA");
  const [almacenNombre, setAlmacenNombre] = useState("ALMACEN PRINCIPAL");
  const [productosNoEncontrados, setProductosNoEncontrados] = useState<ProductoNoEncontrado[]>([]);
  const [busquedaProducto, setBusquedaProducto] = useState<Record<number, string>>({});
  const [resultadosBusqueda, setResultadosBusqueda] = useState<Record<number, any[]>>({});
  const [buscando, setBuscando] = useState<Record<number, boolean>>({});

  const utils = trpc.useUtils();
  const uploadAndExtract = trpc.purchases.uploadAndExtract.useMutation();
  const createPurchase = trpc.purchases.create.useMutation();
  const confirmarEmparejamiento = trpc.confirmaciones.confirmar.useMutation();
  const buscarArticuloQuery = trpc.confirmaciones.buscarArticulo.useQuery;

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (!selected) return;
      
      const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      if (!validTypes.includes(selected.type)) {
        toast.error('Solo JPG, PNG, WebP o PDF');
        return;
      }
      
      const maxSize = 10 * 1024 * 1024;
      if (selected.size > maxSize) {
        toast.error('Archivo muy grande (máx 10MB)');
        return;
      }
      
      setFile(selected);
      setExtracted(false);
      setItems([]);
      const url = URL.createObjectURL(selected);
      setPreviewUrl(url);
    },
    []
  );

  const handleExtract = useCallback(async () => {
    if (!file) return;
    setIsExtracting(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(",")[1];
          const result = await uploadAndExtract.mutateAsync({
            fileBase64: base64,
            fileName: file.name,
            mimeType: file.type,
          });
          if (result.items && result.items.length > 0) {
            const mappedItems = result.items.map((i: any) => ({ ...i, expiryDate: convertExpiryDate(i.expiryDate) || null }));
        setItems(mappedItems);
        // Auto-mostrar columna de vencimiento si hay fechas extraídas
        if (mappedItems.some((i: any) => i.expiryDate)) {
          setShowExpiry(true);
        }
            if (result.supplier) setSupplier(result.supplier);
            if (result.receiptNumber) setReceiptNumber(result.receiptNumber);
            setExtracted(true);
            toast.success(
              `Se extrajeron ${result.items.length} productos de la imagen`
            );
          } else {
            toast.error("No se pudieron extraer productos de la imagen");
          }
        } catch (err: any) {
          toast.error(err.message || "Error al procesar la imagen");
        }
        setIsExtracting(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      toast.error(err.message || "Error al procesar la imagen");
      setIsExtracting(false);
    }
  }, [file, uploadAndExtract]);

  const handleSubmit = useCallback(
    async (confirmDirectly: boolean) => {
      if (!branchId) {
        toast.error("Seleccione una sucursal");
        return;
      }
      if (items.length === 0) {
        toast.error("Agregue al menos un producto");
        return;
      }
      setIsSubmitting(true);
      try {
        const totalAmount = items.reduce((sum, i) => sum + i.subtotal, 0);
        const result = await createPurchase.mutateAsync({
          branchId: parseInt(branchId),
          receiptNumber,
          receiptType,
          supplier,
          almacenNombre,
          totalAmount,
          items: items.map(i => ({
            productName: i.productName,
            quantity: i.quantity,
            unitCost: i.unitCost,
            subtotal: i.subtotal,
            expiryDate: i.expiryDate || null,
          })),
          imageUrl: uploadAndExtract.data?.imageUrl || null,
          imageKey: uploadAndExtract.data?.imageKey || null,
          confirmDirectly,
        });
        await utils.purchases.list.invalidate();
        await utils.dashboard.stats.invalidate();
        if (confirmDirectly) {
          const r = result as any;
          if (r?.syncSuccess) {
            toast.success(
              `✓ Compra registrada en inventarios365.com` +
              (r.syncIngresoId ? ` (Ingreso ID: ${r.syncIngresoId})` : ""),
              { duration: 7000 }
            );
            if (r.productosNoEncontrados?.length > 0) {
              setProductosNoEncontrados(r.productosNoEncontrados);
              toast.warning(`${r.productosNoEncontrados.length} producto(s) no encontrados — revisa el panel`, { duration: 8000 });
              return; // No redirigir, mostrar panel
            }
          } else if (r?.syncMessage?.includes("No se encontró ningún artículo")) {
            // Todos los productos fallaron — mostrar panel
            setProductosNoEncontrados(items.map(i => ({ nombre: i.productName, cantidad: i.quantity, precio: i.unitCost })));
            toast.warning("Ningún producto encontrado en el sistema. Búscalos o créalos manualmente.", { duration: 8000 });
            return;
          } else if (r?.syncMessage) {
            toast.warning(
              `Compra confirmada, pero sin sincronizar: ${r.syncMessage}`,
              { duration: 8000 }
            );
          } else {
            toast.success("Compra confirmada exitosamente");
          }
        } else {
          toast.success("Compra guardada como borrador");
        }
        setLocation("/compras");
      } catch (err: any) {
        toast.error(err.message || "Error al registrar la compra");
      }
      setIsSubmitting(false);
    },
    [branchId, items, receiptNumber, receiptType, supplier, almacenNombre, createPurchase, setLocation, uploadAndExtract.data, utils]
  );

  const updateItem = (index: number, field: keyof ExtractedItem, value: any) => {
    setItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === "quantity" || field === "unitCost") {
        updated[index].subtotal = updated[index].quantity * updated[index].unitCost;
      }
      return updated;
    });
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const addEmptyItem = () => {
    setItems((prev) => [
      ...prev,
      { productName: "", quantity: 1, unitCost: 0, subtotal: 0, expiryDate: null },
    ]);
  };

  const totalAmount = items.reduce((sum, i) => sum + i.subtotal, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-foreground pb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/compras")}
          className="gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">
            Nueva Compra
          </h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Suba una foto o PDF de la factura para extracción automática
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Upload & Preview */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Imagen de Factura
              </CardTitle>
            </CardHeader>
            <CardContent>
              {previewUrl ? (
                <div className="space-y-3">
                  <div className="border border-foreground/10 rounded overflow-hidden">
                    <img
                      src={previewUrl}
                      alt="Factura"
                      className="w-full h-auto max-h-80 object-contain bg-muted"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleExtract}
                      disabled={isExtracting || extracted}
                      className="flex-1 gap-2 font-semibold uppercase tracking-wider text-xs"
                    >
                      {isExtracting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : extracted ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      {isExtracting ? "Extrayendo..." : extracted ? "Extraído" : "Extraer con IA"}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        setFile(null);
                        setPreviewUrl(null);
                        setExtracted(false);
                        setItems([]);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-foreground/20 rounded p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
                >
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">Haga clic para subir</p>
                  <p className="text-xs text-muted-foreground mt-1">JPG, PNG o PDF</p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                onChange={handleFileSelect}
                className="hidden"
              />
            </CardContent>
          </Card>

          {/* Purchase Info */}
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Datos de Compra
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Sucursal</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar sucursal" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchesData?.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Tipo de Comprobante</Label>
                <Select value={receiptType} onValueChange={(v: any) => setReceiptType(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FACTURA">FACTURA</SelectItem>
                    <SelectItem value="BOLETA">BOLETA</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Almacén</Label>
                <Select value={almacenNombre} onValueChange={setAlmacenNombre}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALMACEN PRINCIPAL">ALMACEN PRINCIPAL</SelectItem>
                    <SelectItem value="Almacen Lanza">Almacen Lanza</SelectItem>
                    <SelectItem value="Almacen Petrolera">Almacen Petrolera</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">N° Comprobante</Label>
                <Input
                  value={receiptNumber}
                  onChange={(e) => setReceiptNumber(e.target.value)}
                  placeholder="Ej: 36324"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">Proveedor</Label>
                <Input
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  placeholder="Ej: Bago"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Items Table */}
        <div className="lg:col-span-2">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-wider">
                  Productos ({items.length})
                </CardTitle>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowExpiry(!showExpiry)}
                    className={`gap-1 text-xs uppercase tracking-wider font-semibold ${showExpiry ? "bg-primary text-primary-foreground" : ""}`}
                  >
                    <Calendar className="h-3 w-3" />
                    {showExpiry ? "Ocultar Venc." : "Fecha Venc."}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addEmptyItem}
                    className="gap-1 text-xs uppercase tracking-wider font-semibold"
                  >
                    <Plus className="h-3 w-3" />
                    Agregar
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {items.length > 0 ? (
                <div className="space-y-2">
                  {/* Table Header */}
                  <div className={`grid gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground pb-2 border-b border-foreground/10 ${showExpiry ? "grid-cols-13" : "grid-cols-12"}`}>
                    <div className={showExpiry ? "col-span-4" : "col-span-5"}>Producto</div>
                    <div className="col-span-2">Cantidad</div>
                    <div className="col-span-2">Costo Unit.</div>
                    {showExpiry && <div className="col-span-3">Vencimiento</div>}
                    <div className="col-span-2 text-right">Subtotal</div>
                    <div className="col-span-1" />
                  </div>
                  {/* Items */}
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className={`grid gap-2 items-center py-1 ${showExpiry ? "grid-cols-13" : "grid-cols-12"}`}
                    >
                      <div className={showExpiry ? "col-span-4" : "col-span-5"}>
                        <Input
                          value={item.productName}
                          onChange={(e) => updateItem(idx, "productName", e.target.value)}
                          className="text-sm h-9"
                          placeholder="Nombre del producto"
                        />
                      </div>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, "quantity", parseInt(e.target.value) || 0)}
                          className="text-sm h-9"
                          min={0}
                        />
                      </div>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          value={item.unitCost}
                          onChange={(e) => updateItem(idx, "unitCost", parseFloat(e.target.value) || 0)}
                          className="text-sm h-9"
                          min={0}
                          step="0.01"
                        />
                      </div>
                      {showExpiry && (
                        <div className="col-span-3">
                          <Input
                            type="date"
                            value={item.expiryDate || ""}
                            onChange={(e) => updateItem(idx, "expiryDate", e.target.value || null)}
                            className="text-sm h-9"
                          />
                        </div>
                      )}
                      <div className="col-span-2 text-right text-sm font-semibold">
                        {item.subtotal.toFixed(2)} BS
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => removeItem(idx)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  {/* Total */}
                  <div className="border-t-2 border-foreground pt-3 mt-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-bold uppercase tracking-wider">Total</span>
                      <span className="text-2xl font-black">{totalAmount.toFixed(2)} BS</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 border border-dashed border-foreground/20 rounded">
                  <Sparkles className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Suba una imagen y use la IA para extraer los productos
                    automáticamente, o agregue productos manualmente.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Submit Buttons */}
          {items.length > 0 && (
            <div className="flex justify-end gap-3 mt-4">
              <Button
                variant="outline"
                onClick={() => setLocation("/compras")}
                className="uppercase tracking-wider text-xs font-semibold"
              >
                Cancelar
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSubmit(false)}
                disabled={isSubmitting}
                className="gap-2 uppercase tracking-wider text-xs font-semibold"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Guardar Borrador
              </Button>
              <Button
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting}
                className="gap-2 uppercase tracking-wider text-xs font-semibold bg-green-700 hover:bg-green-800 text-white"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Confirmar y Sincronizar
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Panel de Productos No Encontrados */}
      {productosNoEncontrados.length > 0 && (
        <div className="border border-yellow-400 rounded-lg bg-yellow-50 dark:bg-yellow-950 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-yellow-800 dark:text-yellow-200 text-sm uppercase tracking-wider">
              ⚠️ {productosNoEncontrados.length} Producto(s) No Encontrados en el Sistema
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setProductosNoEncontrados([])} className="text-yellow-700 hover:text-yellow-900 text-xs">
              Cerrar
            </Button>
          </div>
          <p className="text-xs text-yellow-700 dark:text-yellow-300">
            Búscalos para emparejar con el sistema (se recordará para siempre) o créalos como nuevos productos.
          </p>
          <div className="space-y-4">
            {productosNoEncontrados.map((p, idx) => (
              <div key={idx} className="bg-white dark:bg-gray-900 rounded-lg p-3 border border-yellow-200 space-y-3">
                {/* Datos del producto en la factura */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm">📄 {p.nombreLimpio || p.nombre.replace(/^\d+\s+/, "")}</p>
                    {p.nombreLimpio && p.nombreLimpio !== p.nombre && (
                      <p className="text-xs text-muted-foreground">Código factura: {p.nombre.match(/^\d+/)?.[0]}</p>
                    )}
                    <p className="text-xs text-muted-foreground">Cant: {p.cantidad}{p.precio ? ` | Precio unit: Bs. ${p.precio}` : ""}</p>
                  </div>
                  <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">No encontrado</span>
                </div>

                {/* Búsqueda */}
                <div className="flex gap-2">
                  <Input
                    placeholder="Buscar término alternativo..."
                    className="h-8 text-xs"
                    value={busquedaProducto[idx] ?? (p.nombreLimpio || p.nombre.replace(/^\d+\s+/, ""))}
                    onChange={(e) => setBusquedaProducto(prev => ({ ...prev, [idx]: e.target.value }))}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter") {
                        const term = busquedaProducto[idx] || p.nombre;
                        if (!term || term.length < 2) return;
                        setBuscando(prev => ({ ...prev, [idx]: true }));
                        try {
                          const res = await fetch(`/api/trpc/confirmaciones.buscarArticulo?input=${encodeURIComponent(JSON.stringify({ termino: term }))}`);
                          const data = await res.json();
                          setResultadosBusqueda(prev => ({ ...prev, [idx]: data?.result?.data || [] }));
                        } catch {}
                        setBuscando(prev => ({ ...prev, [idx]: false }));
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs whitespace-nowrap"
                    disabled={buscando[idx]}
                    onClick={async () => {
                      const term = busquedaProducto[idx] || p.nombre;
                      if (!term || term.length < 2) return;
                      setBuscando(prev => ({ ...prev, [idx]: true }));
                      try {
                        const res = await fetch(`/api/trpc/confirmaciones.buscarArticulo?input=${encodeURIComponent(JSON.stringify({ termino: term }))}`);
                        const data = await res.json();
                        setResultadosBusqueda(prev => ({ ...prev, [idx]: data?.result?.data || [] }));
                      } catch {}
                      setBuscando(prev => ({ ...prev, [idx]: false }));
                    }}
                  >
                    {buscando[idx] ? <Loader2 className="h-3 w-3 animate-spin" /> : "🔍 Buscar"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 text-xs whitespace-nowrap bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={() => window.open("https://vidafarmacia.inventarios365.com/main", "_blank")}
                  >
                    ➕ Crear nuevo
                  </Button>
                </div>

                {/* Resultados de búsqueda */}
                {resultadosBusqueda[idx]?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground font-medium">Selecciona el producto correcto:</p>
                    {resultadosBusqueda[idx].map((art: any) => (
                      <div key={art.id} className="flex items-center justify-between bg-green-50 dark:bg-green-950 border border-green-200 rounded px-3 py-2">
                        <div>
                          <p className="text-xs font-medium">{art.nombre}</p>
                          <p className="text-xs text-muted-foreground">Código: {art.codigo} | ID: {art.id}</p>
                        </div>
                        <Button
                          size="sm"
                          className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
                          onClick={async () => {
                            await confirmarEmparejamiento.mutateAsync({
                              proveedor: supplier || "Desconocido",
                              nombreFactura: p.nombre,
                              articuloId: art.id,
                              articuloNombre: art.nombre,
                              articuloCodigo: art.codigo,
                            });
                            toast.success(`✅ Emparejado: "${p.nombre}" → "${art.nombre}". Se recordará siempre.`, { duration: 6000 });
                            setProductosNoEncontrados(prev => prev.filter((_, i) => i !== idx));
                            setResultadosBusqueda(prev => { const n = {...prev}; delete n[idx]; return n; });
                          }}
                        >
                          ✅ Confirmar
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {resultadosBusqueda[idx]?.length === 0 && busquedaProducto[idx] && !buscando[idx] && (
                  <p className="text-xs text-red-500">No se encontraron resultados. Intenta otro término o crea el producto.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
