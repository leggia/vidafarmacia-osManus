import { useState, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

interface ExtractedItem {
  productName: string;
  quantity: number;
}

export default function NuevaTransferencia() {
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: branchesData } = trpc.branches.list.useQuery();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fromBranchId, setFromBranchId] = useState<string>("");
  const [toBranchId, setToBranchId] = useState<string>("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ExtractedItem[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [extracted, setExtracted] = useState(false);

  const utils = trpc.useUtils();
  const uploadAndExtract = trpc.transfers.uploadAndExtract.useMutation();
  const createTransfer = trpc.transfers.create.useMutation();

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
      setPreviewUrl(URL.createObjectURL(selected));
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

  const handleSubmit = useCallback(async (confirmDirectly: boolean) => {
    if (!fromBranchId || !toBranchId) {
      toast.error("Seleccione sucursal origen y destino");
      return;
    }
    if (fromBranchId === toBranchId) {
      toast.error("La sucursal origen y destino deben ser diferentes");
      return;
    }
    if (items.length === 0) {
      toast.error("Agregue al menos un producto");
      return;
    }
    setIsSubmitting(true);
    try {
      await createTransfer.mutateAsync({
        fromBranchId: parseInt(fromBranchId),
        toBranchId: parseInt(toBranchId),
        referenceNumber,
        notes,
        items,
        imageUrl: uploadAndExtract.data?.imageUrl || null,
        imageKey: uploadAndExtract.data?.imageKey || null,
        confirmDirectly,
      });
      // Invalidate caches so the list page shows the new transfer immediately
      await utils.transfers.list.invalidate();
      await utils.dashboard.stats.invalidate();
      if (confirmDirectly) {
        toast.success("Transferencia confirmada y completada exitosamente");
      } else {
        toast.success("Transferencia guardada como borrador");
      }
      setLocation("/transferencias");
    } catch (err: any) {
      toast.error(err.message || "Error al registrar la transferencia");
    }
    setIsSubmitting(false);
  }, [fromBranchId, toBranchId, items, referenceNumber, notes, createTransfer, setLocation, uploadAndExtract.data]);

  const updateItem = (index: number, field: keyof ExtractedItem, value: any) => {
    setItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const addEmptyItem = () => {
    setItems((prev) => [...prev, { productName: "", quantity: 1 }]);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 border-b border-foreground pb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/transferencias")}
          className="gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">
            Nueva Transferencia
          </h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Suba una foto de los medicamentos para extracción automática
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Upload & Info */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Foto de Medicamentos
              </CardTitle>
            </CardHeader>
            <CardContent>
              {previewUrl ? (
                <div className="space-y-3">
                  <div className="border border-foreground/10 rounded overflow-hidden">
                    <img
                      src={previewUrl}
                      alt="Medicamentos"
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
                  <p className="text-sm font-medium">Haga clic para subir</p>
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

          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Datos de Transferencia
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  Sucursal Origen
                </Label>
                <Select value={fromBranchId} onValueChange={setFromBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar origen" />
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
                  Sucursal Destino
                </Label>
                <Select value={toBranchId} onValueChange={setToBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar destino" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchesData
                      ?.filter((b: any) => String(b.id) !== fromBranchId)
                      .map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  N° Referencia
                </Label>
                <Input
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="Opcional"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  Notas
                </Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Observaciones adicionales"
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Items */}
        <div className="lg:col-span-2">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-wider">
                  Medicamentos ({items.length})
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
                  <div className="grid grid-cols-12 gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground pb-2 border-b border-foreground/10">
                    <div className="col-span-8">Producto</div>
                    <div className="col-span-3">Cantidad</div>
                    <div className="col-span-1" />
                  </div>
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 items-center py-1"
                    >
                      <div className="col-span-8">
                        <Input
                          value={item.productName}
                          onChange={(e) =>
                            updateItem(idx, "productName", e.target.value)
                          }
                          className="text-sm h-9"
                          placeholder="Nombre del medicamento"
                        />
                      </div>
                      <div className="col-span-3">
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
                  <div className="border-t-2 border-foreground pt-3 mt-3">
                    <p className="text-sm font-bold uppercase tracking-wider">
                      Total: {items.reduce((s, i) => s + i.quantity, 0)} unidades
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 border border-dashed border-foreground/20 rounded">
                  <Sparkles className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Suba una foto y use la IA para extraer los medicamentos,
                    o agregue productos manualmente.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {items.length > 0 && (
            <div className="flex justify-end gap-3 mt-4">
              <Button
                variant="outline"
                onClick={() => setLocation("/transferencias")}
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
                Confirmar Transferencia
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
