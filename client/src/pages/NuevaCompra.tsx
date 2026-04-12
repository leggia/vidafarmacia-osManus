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
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

interface ExtractedItem {
  productName: string;
  quantity: number;
  unitCost: number;
  subtotal: number;
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

  const uploadAndExtract = trpc.purchases.uploadAndExtract.useMutation();
  const createPurchase = trpc.purchases.create.useMutation();

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (!selected) return;
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
        const base64 = (reader.result as string).split(",")[1];
        const result = await uploadAndExtract.mutateAsync({
          fileBase64: base64,
          fileName: file.name,
          mimeType: file.type,
        });
        if (result.items && result.items.length > 0) {
          setItems(result.items);
          if (result.supplier) setSupplier(result.supplier);
          if (result.receiptNumber) setReceiptNumber(result.receiptNumber);
          setExtracted(true);
          toast.success(
            `Se extrajeron ${result.items.length} productos de la imagen`
          );
        } else {
          toast.error("No se pudieron extraer productos de la imagen");
        }
        setIsExtracting(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      toast.error(err.message || "Error al procesar la imagen");
      setIsExtracting(false);
    }
  }, [file, uploadAndExtract]);

  const handleSubmit = useCallback(async () => {
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
      await createPurchase.mutateAsync({
        branchId: parseInt(branchId),
        receiptNumber,
        supplier,
        totalAmount,
        items,
        imageUrl: uploadAndExtract.data?.imageUrl || null,
        imageKey: uploadAndExtract.data?.imageKey || null,
      });
      toast.success("Compra registrada exitosamente");
      setLocation("/compras");
    } catch (err: any) {
      toast.error(err.message || "Error al registrar la compra");
    }
    setIsSubmitting(false);
  }, [branchId, items, receiptNumber, supplier, createPurchase, setLocation, uploadAndExtract.data]);

  const updateItem = (index: number, field: keyof ExtractedItem, value: any) => {
    setItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === "quantity" || field === "unitCost") {
        updated[index].subtotal =
          updated[index].quantity * updated[index].unitCost;
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
      { productName: "", quantity: 1, unitCost: 0, subtotal: 0 },
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
                      {isExtracting
                        ? "Extrayendo..."
                        : extracted
                          ? "Extraído"
                          : "Extraer con IA"}
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
                  <p className="text-sm font-medium">
                    Haga clic para subir
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    JPG, PNG o PDF
                  </p>
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
                <Label className="text-xs font-bold uppercase tracking-wider">
                  Sucursal
                </Label>
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
                <Label className="text-xs font-bold uppercase tracking-wider">
                  N° Comprobante
                </Label>
                <Input
                  value={receiptNumber}
                  onChange={(e) => setReceiptNumber(e.target.value)}
                  placeholder="Ej: 36324"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  Proveedor
                </Label>
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
            </CardHeader>
            <CardContent>
              {items.length > 0 ? (
                <div className="space-y-2">
                  {/* Table Header */}
                  <div className="grid grid-cols-12 gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground pb-2 border-b border-foreground/10">
                    <div className="col-span-5">Producto</div>
                    <div className="col-span-2">Cantidad</div>
                    <div className="col-span-2">Costo Unit.</div>
                    <div className="col-span-2 text-right">Subtotal</div>
                    <div className="col-span-1" />
                  </div>
                  {/* Items */}
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 items-center py-1"
                    >
                      <div className="col-span-5">
                        <Input
                          value={item.productName}
                          onChange={(e) =>
                            updateItem(idx, "productName", e.target.value)
                          }
                          className="text-sm h-9"
                          placeholder="Nombre del producto"
                        />
                      </div>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          value={item.quantity}
                          onChange={(e) =>
                            updateItem(
                              idx,
                              "quantity",
                              parseInt(e.target.value) || 0
                            )
                          }
                          className="text-sm h-9"
                          min={0}
                        />
                      </div>
                      <div className="col-span-2">
                        <Input
                          type="number"
                          value={item.unitCost}
                          onChange={(e) =>
                            updateItem(
                              idx,
                              "unitCost",
                              parseFloat(e.target.value) || 0
                            )
                          }
                          className="text-sm h-9"
                          min={0}
                          step="0.01"
                        />
                      </div>
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
                      <span className="text-sm font-bold uppercase tracking-wider">
                        Total
                      </span>
                      <span className="text-2xl font-black">
                        {totalAmount.toFixed(2)} BS
                      </span>
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

          {/* Submit */}
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
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="gap-2 uppercase tracking-wider text-xs font-semibold"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Registrar Compra
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
