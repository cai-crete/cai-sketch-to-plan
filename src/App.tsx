import React, { useState, useEffect, useRef } from 'react';
import { Sun, Moon, PenTool, Eraser, Trash2, Download, RefreshCw, CheckCircle2, Plus, Eye, EyeOff, Image as ImageIcon, Move, Crosshair, Square, Type, ChevronLeft, ChevronRight, X, Pen, Undo2, Check } from 'lucide-react';
import { GoogleGenAI } from '@google/genai';
import { SKETCH_ANALYSIS, PLAN_IMAGE_GEN, SKETCH_ANALYSIS_FALLBACK, PLAN_IMAGE_GEN_FALLBACK } from './constants';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface Shape {
  id: string;
  type: 'rectangle';
  x: number;
  y: number;
  width: number;
  height: number;
  isSelected?: boolean;
  text?: string;
  fontSize?: number;
}

interface LayerTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  image: string | null;
  isGrid?: boolean;
  transform?: LayerTransform;
  shapes?: Shape[];
}

interface LibraryItem {
  id: string;
  image: string;
  timestamp: number;
}

const GENERATION_STEPS = [
  'Zoning Analysis',
  'Axis Alignment',
  'Boundary Extraction',
  'Material Layering',
  'Flow & Routing'
];

const removeExteriorWhite = async (dataUrl: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(dataUrl);

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      const isWhite = (i: number) => data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240;

      const stackX = [];
      const stackY = [];
      for (let x = 0; x < canvas.width; x++) {
        stackX.push(x); stackY.push(0);
        stackX.push(x); stackY.push(canvas.height - 1);
      }
      for (let y = 0; y < canvas.height; y++) {
        stackX.push(0); stackY.push(y);
        stackX.push(canvas.width - 1); stackY.push(y);
      }

      const visited = new Uint8Array(canvas.width * canvas.height);

      while (stackX.length > 0) {
        const x = stackX.pop()!;
        const y = stackY.pop()!;
        if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;

        const idx = y * canvas.width + x;
        if (visited[idx]) continue;
        visited[idx] = 1;

        const pixelIdx = idx * 4;
        if (isWhite(pixelIdx)) {
          data[pixelIdx + 3] = 0; // Make transparent
          stackX.push(x + 1); stackY.push(y);
          stackX.push(x - 1); stackY.push(y);
          stackX.push(x); stackY.push(y + 1);
          stackX.push(x); stackY.push(y - 1);
        }
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
};

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [textPrompt, setTextPrompt] = useState('');

  const [isGenerating, setIsGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [loadingSeconds, setLoadingSeconds] = useState(0);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isGenerating) {
      interval = setInterval(() => {
        setLoadingSeconds(prev => prev + 1);
      }, 1000);
    } else {
      setLoadingSeconds(0);
    }
    return () => clearInterval(interval);
  }, [isGenerating]);

  // --- New UI State ---
  const [activeTab, setActiveTab] = useState<'create' | 'result'>('create');
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);

  // Layer System State
  const [layers, setLayers] = useState<Layer[]>([
    { id: 'layer-1', name: 'SKETCH', visible: true, opacity: 100, image: null, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, shapes: [] },
    { id: 'layer-2', name: 'GRID (900mm x 900mm)', visible: true, opacity: 30, image: null, isGrid: true },
    { id: 'layer-3', name: 'BACKGROUND', visible: true, opacity: 100, image: null, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, shapes: [] },
  ]);
  const [selectedLayerId, setSelectedLayerId] = useState<string>('layer-1');
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);

  // Canvas state
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState<'pen' | 'eraser' | 'move' | 'origin' | 'rectangle' | 'text'>('pen');
  const [origins, setOrigins] = useState<{ x: number, y: number }[]>([]);
  const [textInput, setTextInput] = useState<{ x: number, y: number, value: string } | null>(null);
  const [eraserPos, setEraserPos] = useState<{ x: number, y: number } | null>(null);
  const [history, setHistory] = useState<any[]>([]);

  const rectStartRef = useRef<{ x: number, y: number } | null>(null);
  const rectEndRef = useRef<{ x: number, y: number } | null>(null);
  const snapshotRef = useRef<ImageData | null>(null);

  // Theme effect
  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  // Canvas drawing logic
  const addTextShape = (value: string, x: number, y: number) => {
    if (value.trim() !== '') {
      const newShape: Shape = {
        id: `text-${Date.now()}`,
        type: 'rectangle', // We'll extend ShapeRenderer to handle text
        x,
        y: y - 10, // approximate centering
        width: value.length * 10 + 20, // dynamic width
        height: 30,
        text: value,
        fontSize: 20
      };
      setLayers(layers.map(l => l.id === selectedLayerId ? { ...l, shapes: [...(l.shapes || []), newShape] } : l));
    }
    setTextInput(null);
  };

  // Undo Logic
  const saveToHistory = () => {
    const currentState = {
      layers: JSON.parse(JSON.stringify(layers)),
      origins: [...origins],
      canvasData: layers.map(layer => {
        if (layer.isGrid) return null;
        const canvas = document.getElementById(`canvas-${layer.id}`) as HTMLCanvasElement;
        return canvas ? canvas.toDataURL() : null;
      })
    };
    setHistory(prev => [currentState, ...prev].slice(0, 50)); // Keep last 50 steps
  };

  // Fixed size initialization for canvas
  const initCanvas = (canvas: HTMLCanvasElement) => {
    if (!canvas) return;
    const width = 3000; // Fixed large width to prevent clipping
    const height = 3000; // Fixed large height
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#000000';
      }
    }
  };

  useEffect(() => {
    layers.forEach(layer => {
      if (layer.isGrid) return;
      const canvas = document.getElementById(`canvas-${layer.id}`) as HTMLCanvasElement;
      if (canvas) initCanvas(canvas);
    });
  }, [layers.length]);

  const handleUndo = () => {
    if (history.length === 0) return;
    const prevState = history[0];
    setHistory(prev => prev.slice(1));

    setLayers(prevState.layers);
    setOrigins(prevState.origins);

    // Restore canvas contents
    prevState.layers.forEach((layer: Layer, index: number) => {
      if (layer.isGrid) return;
      const dataUrl = prevState.canvasData[index];
      if (dataUrl) {
        const canvas = document.getElementById(`canvas-${layer.id}`) as HTMLCanvasElement;
        const ctx = canvas?.getContext('2d');
        if (ctx) {
          const img = new Image();
          img.src = dataUrl;
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
          };
        }
      }
    });
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if ('cancelable' in e && e.cancelable) e.preventDefault();

    saveToHistory();
    const canvas = e.target as HTMLCanvasElement;
    if (canvas.width !== 3000) initCanvas(canvas);

    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    // Calculate unscaled coordinates accurately
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;

    if (drawMode === 'text') {
      return;
    }

    if (drawMode === 'origin') {
      saveToHistory(); // Added history save for origin
      const gridSize = 45;
      const snappedX = Math.round(x / gridSize) * gridSize;
      const snappedY = Math.round(y / gridSize) * gridSize;

      const existingIndex = origins.findIndex(o => Math.abs(o.x - snappedX) < 10 && Math.abs(o.y - snappedY) < 10);

      if (existingIndex !== -1) {
        setOrigins(prev => prev.filter((_, i) => i !== existingIndex));
      } else {
        setOrigins(prev => [...prev, { x: snappedX, y: snappedY }]);
      }
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (drawMode === 'rectangle') {
      const snapGrid = 150 / 20; // 7.5px = 150mm
      const snappedX = Math.round(x / snapGrid) * snapGrid;
      const snappedY = Math.round(y / snapGrid) * snapGrid;

      snapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      rectStartRef.current = { x: snappedX, y: snappedY };
      setIsDrawing(true);
      return;
    }

    ctx.beginPath();
    ctx.moveTo(x, y);
    // Remove individual stroke() here to avoid point-jumping artifacts
    setIsDrawing(true);
  };

  const preventDoubleTap = (e: any) => {
    if (e.detail > 1) e.preventDefault();
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drawMode === 'text') {
      const canvas = e.target as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      setTextInput({ x, y, value: '' });
    }
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (e.cancelable) e.preventDefault();
    const canvas = e.target as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;

    if (drawMode === 'eraser') {
      setEraserPos({ x: clientX - rect.left, y: clientY - rect.top });
    }

    if (!isDrawing) return;

    if (drawMode === 'rectangle') {
      if (!snapshotRef.current || !rectStartRef.current) return;

      const snapGrid = 150 / 20; // 7.5px = 150mm
      const snappedX = Math.round(x / snapGrid) * snapGrid;
      const snappedY = Math.round(y / snapGrid) * snapGrid;

      rectEndRef.current = { x: snappedX, y: snappedY };

      const startX = rectStartRef.current.x;
      const startY = rectStartRef.current.y;

      ctx.putImageData(snapshotRef.current, 0, 0);
      ctx.beginPath();
      // CSS 그리드(1px 두께, x~x+1)와 Canvas 선(2px 두께, 중심 x)의 시각적 오차(0.5px) 보정
      ctx.rect(startX + 0.5, startY + 0.5, snappedX - startX, snappedY - startY);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.stroke();
      return;
    }

    if (drawMode === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 20;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(x, y);

    if (drawMode === 'eraser') {
      // Efficiently delete shapes that the eraser touches
      const currentLayer = layers.find(l => l.id === selectedLayerId);
      if (currentLayer && currentLayer.shapes && currentLayer.shapes.length > 0) {
        const remainingShapes = currentLayer.shapes.filter(shape => {
          // simple collision check: if eraser point (x,y) is inside shape rectangle
          const isInside = (
            x >= shape.x &&
            x <= shape.x + shape.width &&
            y >= shape.y &&
            y <= shape.y + shape.height
          );
          return !isInside;
        });

        if (remainingShapes.length !== currentLayer.shapes.length) {
          setLayers(layers.map(l => l.id === selectedLayerId ? { ...l, shapes: remainingShapes } : l));
        }
      }
    }

    ctx.lineCap = 'round';
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (drawMode === 'rectangle' && rectStartRef.current && rectEndRef.current && snapshotRef.current) {
      const startX = rectStartRef.current.x;
      const startY = rectStartRef.current.y;
      const endX = rectEndRef.current.x;
      const endY = rectEndRef.current.y;

      const width = endX - startX;
      const height = endY - startY;

      if (width !== 0 && height !== 0) {
        // Restore canvas to remove raster preview
        const canvas = document.getElementById(`canvas-${selectedLayerId}`) as HTMLCanvasElement;
        const ctx = canvas?.getContext('2d');
        if (ctx) {
          ctx.putImageData(snapshotRef.current, 0, 0);
        }

        // Add shape to layer
        const newShape: Shape = {
          id: `shape-${Date.now()}`,
          type: 'rectangle',
          x: Math.min(startX, endX),
          y: Math.min(startY, endY),
          width: Math.abs(width),
          height: Math.abs(height),
        };

        setLayers(layers.map(l => l.id === selectedLayerId ? { ...l, shapes: [...(l.shapes || []), newShape] } : l));
      }
    }

    setIsDrawing(false);
    rectStartRef.current = null;
    rectEndRef.current = null;
    snapshotRef.current = null;
  };

  const clearCurrentLayer = () => {
    saveToHistory();
    const canvas = document.getElementById(`canvas-${selectedLayerId}`) as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Also clear shapes and uploaded image for this layer
    setLayers(layers.map(l => l.id === selectedLayerId ? { ...l, image: null, shapes: [] } : l));
    setEraserPos(null);
  };

  // Layer System Handlers
  const updateLayerTransform = (id: string, transform: LayerTransform) => {
    setLayers(layers.map(layer =>
      layer.id === id ? { ...layer, transform } : layer
    ));
  };

  const addLayer = () => {
    saveToHistory();
    const newLayer: Layer = {
      id: `layer-${Date.now()}`,
      name: `Layer ${layers.length + 1}`,
      visible: true,
      opacity: 100,
      image: null,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 }
    };
    setLayers([newLayer, ...layers]);
    setSelectedLayerId(newLayer.id);
  };

  const removeLayer = (id: string) => {
    saveToHistory();
    const newLayers = layers.filter(layer => layer.id !== id);
    setLayers(newLayers);
    if (selectedLayerId === id && newLayers.length > 0) {
      setSelectedLayerId(newLayers[0].id);
    }
  };

  const toggleLayerVisibility = (id: string) => {
    setLayers(layers.map(layer =>
      layer.id === id ? { ...layer, visible: !layer.visible } : layer
    ));
  };

  const updateLayerOpacity = (id: string, opacity: number) => {
    setLayers(layers.map(layer =>
      layer.id === id ? { ...layer, opacity } : layer
    ));
  };

  const renameLayer = (id: string, newName: string) => {
    if (!newName.trim()) return;
    setLayers(layers.map(layer =>
      layer.id === id ? { ...layer, name: newName } : layer
    ));
  };

  const moveLayer = (index: number, direction: 'up' | 'down') => {
    if (direction === 'up' && index > 0) {
      const newLayers = [...layers];
      [newLayers[index - 1], newLayers[index]] = [newLayers[index], newLayers[index - 1]];
      setLayers(newLayers);
    } else if (direction === 'down' && index < layers.length - 1) {
      const newLayers = [...layers];
      [newLayers[index + 1], newLayers[index]] = [newLayers[index], newLayers[index + 1]];
      setLayers(newLayers);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, layerId: string) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setLayers(layers.map(l => l.id === layerId ? { ...l, image: event.target?.result as string, transform: { x: 0, y: 0, scale: 1, rotation: 0 } } : l));
      };
      reader.readAsDataURL(file);
    }
  };

  const compositeLayersForExport = async (): Promise<string> => {
    const container = document.getElementById('canvas-container');
    if (!container) return '';

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = container.clientWidth;
    tempCanvas.height = container.clientHeight;
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) return '';

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    const reversedLayers = [...layers].reverse();

    for (const layer of reversedLayers) {
      if (!layer.visible) continue;
      if (layer.id !== 'layer-1') continue; // Only SKETCH layer affects generation

      ctx.globalAlpha = layer.opacity / 100;

      if (layer.isGrid) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        const gridSize = 45;
        for (let x = 0; x < tempCanvas.width; x += gridSize) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, tempCanvas.height); ctx.stroke();
        }
        for (let y = 0; y < tempCanvas.height; y += gridSize) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(tempCanvas.width, y); ctx.stroke();
        }
      } else {
        if (layer.image) {
          const img = new Image();
          img.src = layer.image;
          await new Promise(resolve => { img.onload = resolve; });

          const transform = layer.transform || { x: 0, y: 0, scale: 1, rotation: 0 };

          ctx.save();
          ctx.translate(tempCanvas.width / 2 + transform.x, tempCanvas.height / 2 + transform.y);
          ctx.rotate((transform.rotation * Math.PI) / 180);
          ctx.scale(transform.scale, transform.scale);

          const scale = Math.min(tempCanvas.width / img.width, tempCanvas.height / img.height);
          const w = img.width * scale;
          const h = img.height * scale;

          ctx.drawImage(img, -w / 2, -h / 2, w, h);
          ctx.restore();
        }

        if (layer.shapes) {
          ctx.save();
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 2;
          layer.shapes.forEach(shape => {
            if (shape.type === 'rectangle') {
              ctx.strokeRect(shape.x + 0.5, shape.y + 0.5, shape.width, shape.height);
            }
          });
          ctx.restore();
        }

        const layerCanvas = document.getElementById(`canvas-${layer.id}`) as HTMLCanvasElement;
        if (layerCanvas) {
          ctx.drawImage(layerCanvas, 0, 0);
        }
      }
    }

    return tempCanvas.toDataURL('image/jpeg').split(',')[1];
  };

  // Generate Plan
  const handleGenerate = async () => {
    setIsGenerating(true);
    setCurrentStep(0);

    const stepInterval = setInterval(() => {
      setCurrentStep(prev => {
        if (prev < GENERATION_STEPS.length - 1) return prev + 1;
        clearInterval(stepInterval);
        return prev;
      });
    }, 1500);

    try {
      const base64Image = await compositeLayersForExport();

      const finalPrompt = `
# System Prompt: Sketch-to-Plan Transformation System

## 1. ?쒕줎: ?쒖뒪???뺤껜??諛?紐⑹쟻 (System Identity)

### 1.1 ?쒖뒪???뺤쓽 (Definition)

* ?듭떖 ?꾨Т???꾨Ц媛媛 洹몃┛ '異붿긽??議곕떇 ?ㅼ?移?瑜?遺꾩꽍?섏뿬, 嫄댁텞?곸쑝濡???뱁븯怨??쒓났 媛?ν븳 '臾쇰━??援ъ“ ?꾨㈃'?쇰줈 蹂?섑빀?덈떎. 

* **怨듦컙 ?꾩긽 蹂???붿쭊(Topology-to-Structure Engine)**?쇰줈 ?묐룞?⑸땲?? 

### 1.2 議댁옱濡좎쟻 ?ъ젙??(Ontological Status)

* 紐⑤뱺 ?묒뾽???쒖옉?섍린 ?? ?낅젰怨?異쒕젰???깃꺽???ㅼ쓬怨?媛숈씠 ?ш퇋???⑸땲?? 
* **Input Redefinition:** 怨듦컙??愿怨? ?먮쫫, ?꾧퀎瑜??닿퀬 ?덈뒗 **"?꾩긽?숈쟻 ?붽뎄?ы빆(Topological Requirements)"**?댁옄 **"怨듦컙 愿怨??ㅼ씠?닿렇??**?낅땲??  (?ъ슜?먭? ?쒓났???대?吏???⑥닚??'洹몃┝'?대굹 '?숈꽌'媛 ?꾨떃?덈떎.)

* **Output Redefinition:** 臾쇰━ 踰뺤튃怨?嫄댁텞 ?묒떇??以?섑븯??**"?쒓났 媛?ν븳 援ъ“??泥?궗吏?Constructible Blueprint)"**?댁옄 **"臾쇰━???닿껐??Structural Solution)"**?낅땲??  ( ?앹꽦?댁빞 ??寃곌낵臾쇱? ?⑥닚??'?대?吏'媛 ?꾨떃?덈떎.)

### 1.3 ?듭떖 援щ룞 ?먯튃: 泥?궗吏꾩쓽 踰뺤튃 (The Blueprint Rule)

**"?낅젰???좎? 蹂寃?遺덇??ν븳 臾쇰━???ㅼ껜??"**
?ㅼ?移섏긽???좎씠 鍮꾨줉 ?먮슕?댁?嫄곕굹 嫄곗튌?붾씪?? 洹멸쾬??'?ㅻ쪟'濡?痍④툒?섏? 留먭퀬 ?꾩옣???몄썙吏?'踰쎌껜'? '寃쎄퀎'濡?媛꾩＜?섏떗?쒖삤. ?섏쓽 ??븷? 洹??좎쓣 吏?곕뒗 寃껋씠 ?꾨땲?? 嫄댁텞??吏덉꽌??留욊쾶 **"吏곴탳 ?뺣쪟(Orthogonal Rectification)"**?섏뿬 紐낇솗???ㅼ껜濡?援ъ껜?뷀븯??寃껋엯?덈떎. 

---

## 2. ?댁쁺 泥댁젣: ?λ룞??硫뷀??몄? ?꾨줈?좎퐳 (AMP Engine)

### 2.1 ?묐룞 紐⑤뱶: Adaptive Method B (Sketch-to-Plan Interpretation)

蹂??쒖뒪?쒖? ?대?吏? ?띿뒪?멸? ?곹샇蹂댁셿?곸쑝濡??묐룞?섎뒗 **"?댁꽍??蹂??紐⑤뱶(Interpretation Mode)"**濡?媛?숇맗?덈떎. ?대?吏瑜??⑥닚??諛곌꼍?쇰줈 泥섎━?섍굅?? ?띿뒪?몃줈 ?대?吏???뺥깭瑜??꾩쟾??臾댁떆?섎뒗 ?됱쐞瑜?湲덉??⑸땲?? 

### 2.2 ??븷 遺꾨떞 紐낅졊 (Role Definition Command)

?ㅼ쓬??洹쒖튃???듯빐 ?대?吏? ?띿뒪?몄쓽 ?곴?愿怨꾨? ?꾧꺽??以?섑빀?덈떎:

* **Image = Topological Anchor (?꾩긽?숈쟻 ??/ Context)**
* ?대?吏??怨듦컙??**'留λ씫(Context)'**???쒓났?⑸땲?? 
* 諛⑹쓽 ?곷????꾩튂(醫???????, 怨듦컙 媛꾩쓽 ?곌껐??Connectivity), ?숈꽑???먮쫫(Flow)? ?대?吏?먯꽌 異붿텧???뺣낫瑜?**怨좎젙媛?Anchor)**?쇰줈 ?ъ슜?⑸땲?? 
* ?ㅼ?移섏쓽 遺덉셿?꾪븳 ?뺥깭(鍮꾩젙??怨≪꽑 ????'?섏젙?댁빞 ??????댁? '?좎??댁빞 ???뺥깭'媛 ?꾨떃?덈떎. 

* **Text = Structural Driver (援ъ“???숇젰 / Logic)**
* ?띿뒪?몃뒗 蹂?섏쓽 **'?쇰━(Logic)'**瑜??쒓났?⑸땲?? 
* ?띿뒪???꾨＼?꾪듃???ㅼ?移섏쓽 紐⑦샇???뺥깭瑜?嫄댁텞??**'援ъ“(Structure)'**濡?蹂?섑븯??**洹쒖튃(Rule)**??遺?ы빀?덈떎. 
* ?됱닔, 嫄댁텞 ?묒떇, 援ъ“ ?쒖뒪???? 泥좉렐肄섑겕由ы듃, 紐⑷뎄議? ?깆쓽 ?띿뒪???뺣낫瑜??듯빐 ?ㅼ?移섏쓽 ?좎쓣 ?뺣쪟(Rectify)?섍퀬 援ъ껜?뷀빀?덈떎. 

### 2.3 ?댁꽍 諛??뺣쪟 ?꾨줈?좎퐳 (Interpretation & Rectification Protocol)

* **Interpret (?댁꽍):** ?ㅼ?移섏뿉 洹몃젮吏??좉린??怨≪꽑怨?紐⑦샇??湲고샇??洹??섎룄瑜??댁꽍?댁꽌 **"吏곴탳 踰쎌껜(Orthogonal Walls)"**, **"媛쒓뎄遺(Opening)"**, **"蹂듬룄(Corridor)"**??嫄댁텞 ?몄뼱濡?移섑솚?⑸땲??  ("?좉린??怨≪꽑"?대굹 "紐⑦샇??湲고샇"瑜?洹몃?濡??뚮뜑留곹븯吏 ?딆뒿?덈떎.)

* **Rectify (?뺣쪟):** ?띿뒪???꾨＼?꾪듃??吏?쒖뿉 ?곕씪 鍮꾨슕?댁쭊 ?좎쓣 **"洹몃━???뺣젹(Align to Grid)"**?섍퀬, 鍮꾨?媛 留욎? ?딅뒗 怨듦컙??**"?쒖? 移섏닔(Standardize Dimensions)"**??留욎떠 蹂댁젙?⑸땲?? 

### 2.4 ?쒖빟 議곌굔 怨듯븰 (Constraint Engineering)

* **Negative Constraint:** ?띿뒪???꾨＼?꾪듃媛 ?대?吏???꾩긽?숈쟻 諛곗튂(諛⑹쓽 ?꾩튂 ?쒖꽌)瑜??ㅻ컮袁몃젮 ??寃쎌슦, ?대? 臾댁떆?섍퀬 ?대?吏??諛곗튂瑜??곗꽑?⑸땲?? 

* **Positive Enforcement:** `Rectilinear(吏곸꽑??`, `Architectural Interpretation(嫄댁텞???댁꽍)`, `Structural Logic(援ъ“???쇰━)` ?ㅼ썙?쒕? ?곴레 ?쒖슜?섏뿬 ?ㅼ?移섏쓽 遺덊솗?ㅼ꽦??嫄댁텞???뺤떎?깆쑝濡?蹂?섑빀?덈떎. 

---

## 3. 遺꾩꽍 紐⑤뱢: ?ъ링 ?쒓컖 吏??(Deep Spatial Vision)

### 3.1 遺꾩꽍 ?꾩쿂由?(Pre-processing Analysis)

?대?吏 ?앹꽦???쒖옉?섍린 ?? 諛섎뱶???ㅼ쓬??**"Analysis Phase"**瑜?癒쇱? ?섑뻾?섏뿬 怨듦컙???쇰━??援ъ“瑜??뺣┰?⑸땲?? 

* **Bubble Identity Recognition:** ?대?吏 ?댁쓽 ?띿뒪???? Living, Kitchen, Master Room)瑜??몄떇?섏뿬 媛?踰꾨툝??湲곕뒫???뺤쓽?⑸땲?? 

* **Connectivity Mapping:** 踰꾨툝?ㅼ씠 ?쒕줈 留욌떯???덈뒗 '?몄젒硫?Adjacency)'???뚯븙?섍퀬, ?대? '臾?Door)'?대굹 '媛쒓뎄遺(Opening)'媛 ?꾩슂???곌껐 吏?먯쑝濡??댁꽍?⑸땲?? 

* **Entrance Identity (?몃? 異쒖엯援??뚯븙):** ?몃????띿뒪??'ENTRANCE'媛 ?덇굅?? ?대????띿뒪??'Hall'??紐낆떆??寃쎌슦, ?대? ?몃?? ?곌껐?섎뒗 二쇱텧??怨듦컙?쇰줈 理쒖슦???몄떇?⑸땲?? 

* **External Flow (?몃? 吏꾩엯 ?숈꽑):** ?몃??먯꽌 ?대?濡??좎엯?섎뒗 ?붿궡???깆쓽 ?곌껐 ?쒖떆媛 ?덈뒗 寃쎌슦, ?대? ?⑥닚???좎씠 ?꾨땶 二쇱텧?낃뎄(Main Entrance)瑜??뺤꽦?댁빞 ?섎뒗 紐낆떆??吏?쒕줈 ?댁꽍?⑸땲?? 

### 3.2 5?④퀎 ?ъ링 怨듦컙 遺꾩꽍 (5-Step Deep Spatial Analysis)

?ㅼ쓬???ш퀬 怨쇱젙(Chain of Thought)???쒖감?곸쑝濡??섑뻾?섏뿬 ?ㅼ?移섎? ?꾨㈃?뷀븯湲??꾪븳 ?곗씠?곕? 異붿텧?⑸땲??

1. **Zoning (?꾧퀎 ?ㅼ젙):** 怨듦컙??**'Main Zone'**(嫄곗떎, 二쇰갑 ??怨듭슜 怨듦컙)怨?**'Sub Zone'**(移⑥떎, ?뺤떎 ???ъ쟻 怨듦컙)?쇰줈 援щ텇?섏뿬 ?꾧퀎瑜??ㅼ젙?⑸땲?? 
2. **Axis (異뺤꽑 異붿텧 諛??뺣쪟):** ?ㅼ?移섏쓽 ?먮슕?댁쭊 ?좊뱾 ?ъ씠?먯꽌 ?좎옱??**'吏곴탳 洹몃━??Orthogonal Grid)'**瑜?李얠븘?닿퀬, 紐⑤뱺 踰쎌껜瑜?X異뺢낵 Y異뺤뿉 ?뺣젹(Align)?쒗궢?덈떎. 
3. **Boundary (寃쎄퀎 ?뺤젙):** 踰꾨툝???멸낸?좎쓣 **'踰쎌껜 以묒떖??Wall Centerline)'**?쇰줈 蹂?섑빀?덈떎. ?대븣 ?몃꼍? '?먭볼???대젰踰?Structural Wall)'?쇰줈, ?대꼍? '?뉗? 移몃쭑?대꼍(Partition Wall)'?쇰줈 援щ텇?⑸땲?? 
4. **Layering (?ъ쭏 遺꾨━):** 怨듦컙??湲곕뒫???곕씪 諛붾떏 ?ъ쭏??遺꾨━?섎뒗 吏???? ?꾧? ???vs 嫄곗떎 留덈（, ?뺤떎 ?듭떇 怨듦컙)???뚯븙?섏뿬 **'?щ즺 遺꾨━??Material Line)'**???ㅼ젙?⑸땲?? 
5. **Flow (?숈꽑 踰≫꽣??:** ?ㅼ?移섏긽???붿궡?쒕굹 ?곌껐 ?쒖떆瑜??⑥닚??湲고샇媛 ?꾨땶, ?щ엺???吏곸엫???좊룄?섎뒗 **'?숈꽑 踰≫꽣(Flow Vector)'**濡?蹂?섑븯??臾??대┝ 諛⑺뼢(Swing)怨?蹂듬룄 ??쓣 寃곗젙?⑸땲?? 
---

## 4. ?ㅽ뻾 ?붿쭊 諛??몄닔?멸퀎 ?쒖뼱 (Value Chain & Handoff Execution)

???④퀎???⑥씪 AI?먯꽌 ?뺤옣??嫄댁텞 ?ㅻТ ?꾨Ц媛 4紐낆씠 ?묒뾽?섎뒗 ?꾨줈?몄뒪濡??쒕??덉씠?섑빀?덈떎. **留덉씠?щ줈 ?몄닔?멸퀎 ?꾨줈?좎퐳(Micro-Handoff Protocol)**???듯빐 媛??묒뾽 紐⑤뱢 媛꾩쓽 釉붾옓諛뺤뒪 ?꾩긽???쒓굅?섍퀬, ?④퀎蹂??곗텧臾쇱쓽 臾닿껐?깆쓣 寃利앺븯???ㅼ쓬 ?④퀎濡??щ챸?섍쾶 ?몄닔?멸퀎?⑸땲?? 二쇱뼱吏?怨쇱뾽??蹂듭옟?꾩? ?깃꺽(留λ씫)???곕씪, ?꾩껜 怨듭젙??愿?듯븯??媛??移섎챸?곸씤 蹂怨≪젏(Critical Path) 2~5媛쒕? '?듭떖 留덉씪?ㅽ넠'?쇰줈 ?먯껜 吏?뺥빀?덈떎. 

### 4.1 留덉씠?щ줈 ?몄닔?멸퀎 ?쒖? ?묒떇 (Micro-Report Form)

媛??꾨Ц媛 紐⑤뱢? ?묒뾽??留덉튂怨??ㅼ쓬 ?④퀎濡??섏뼱媛湲??? 諛섎뱶???꾨옒 ?묒떇???앹꽦?섏뿬 ?듦낵?댁빞 ?⑸땲?? 

* 留덉씪?ㅽ넠 紐낆묶: (?? Phase 2. 援ъ“???꾨즺)
* A. ?꾨Т ?꾩닔 寃곌낵 (Output Verification): ?ъ꽦???듭떖 紐⑺몴? 蹂??곗텧臾쇱씠 ?좏슚?섎떎怨??먮떒??臾닿껐??寃利?湲곗???紐낆떆?⑸땲?? 
* B. ?쒓퀎 諛??붿뿬 ?쒖빟 (Constraints & Blind Spots): ???④퀎?먯꽌 ?닿껐?섏? ?딄굅??媛?뺥븳 蹂?섎? 湲곕줉?⑸땲?? 
* C. ?ㅼ쓬 ?④퀎 ?묒뾽 吏??(Next Action Directive): ?섏떊 ???Next Module)??紐낆떆?섍퀬, ?ㅼ쓬 ?④퀎?먯꽌 諛섎뱶???닿껐?댁빞 ??理쒖슦??怨쇱젣瑜?紐낇솗??吏?쒗빀?덈떎. 

* 諛섎젮 猷⑦봽 (Reject & Rework): 由ы룷?몄쓽 ?쇰━??紐⑥닚??諛쒓껄??寃쎌슦, 利됱떆 吏곸쟾 ?④퀎濡?'諛섎젮'瑜?吏?쒗븯??猷⑦봽瑜?媛?숉빀?덈떎. 

### 4.2 媛???묒뾽 ?쒕??덉씠??諛?Handoff ?먮쫫

* **Step 1: Project Manager (湲고쉷)**
* **Role:** ?꾩껜 ?吏???ш린瑜?異붿젙?섍퀬, 媛???Room)???곷???硫댁쟻 鍮꾩쑉???좎??섎㈃???꾩떎?곸씤 ?ㅼ???Scale)???ㅼ젙?⑸땲?? 
* *Handoff:* ?꾩껜 ?ㅼ???諛?硫댁쟻 鍮꾩쑉 ?곗씠?곕? Micro-Report???댁븘 援ъ“ ?붿??덉뼱?먭쾶 ?꾨떖?⑸땲?? 

* **Step 2: Structural Engineer (援ъ“)**
* **Role:** ?좉린?곸씤 踰꾨툝 ?뺥깭瑜?媛뺤젣濡?**"吏곸궗媛곹삎??Rectangularize)"**?⑸땲??  援ъ“??洹몃━?쒖뿉 留욎떠 踰쎌껜瑜??몄슦怨? 湲곕뫁(Column)???꾩슂??紐⑥꽌由щ? ?뚯븙?⑸땲??

* *Handoff:* 吏곴탳?붾맂 援ъ“ 堉덈? ?곗씠?곗? ?섏쨷 ?쒖빟 ?ы빆???쒕룄 ?대떦?먯뿉寃??꾨떖?⑸땲?? 

* **Step 3: Architectural Drafter (?쒕룄)**
* **Role:** 寃곗젙??踰쎌껜???먭퍡(Thickness)瑜?遺?ы빀?덈떎. 踰쎌껜 ?대???**"Solid Poche"** ?먮뒗 **"Hatch"**濡?梨꾩슦怨? 臾멸낵 李쏀샇???쒖? ?щ낵(Standard Symbols)濡?諛곗튂?⑸땲?? 

* *Handoff:* ?꾩꽦??怨듦컙??寃쎄퀎??諛?媛쒓뎄遺 ?꾩튂瑜??명뀒由ъ뼱 ?붿옄?대꼫?먭쾶 ?꾨떖?⑸땲?? 

* **Step 4: Interior Designer (?명뀒由ъ뼱)**

* **Role:** 媛??ㅼ쓽 ?대쫫??留욌뒗 ?쒖? 媛援??? 移⑤?, ?뚰뙆, ?앺긽, 蹂湲?瑜?諛곗튂?섎릺, Step 1?먯꽌 遺꾩꽍???숈꽑??諛⑺빐?섏? ?딅뒗 理쒖쟻???덉씠?꾩썐???곸슜?⑸땲?? 

### 4.3 臾쇰━???ㅼ껜??濡쒖쭅 (Materializing Logic)

* **Draw as Built:** 洹몃┝??洹몃━??寃껋씠 ?꾨땲?? ?ㅼ젣 嫄대Ъ??吏볥벏???좎쓣 ?앹꽦?⑸땲?? 

* **Opening Logic:** ??怨듦컙???곌껐??怨녹뿉??諛섎뱶??踰쎌쓣 ?レ뼱 **'?듬줈'**瑜?留뚮뱾嫄곕굹 **'臾?**???ㅼ튂?섏뿬 臾쇰━???대룞??媛?ν븯寃?援ъ꽦?⑸땲??  ?ロ엺 怨듦컙(Dead Space)? ?덉슜?섏? ?딆뒿?덈떎.

* **External Entrance Logic:** ?몃????띿뒪??'ENTRANCE'媛 ?덇굅?? ?몃??먯꽌 ?대?濡??좎엯?섎뒗 ?붿궡???깆쓽 ?곌껐 ?쒖떆媛 ?덇굅?? ?대????띿뒪??'Hall'??紐낆떆??寃쎌슦, ?대떦 怨듦컙怨?留욌떯? ?몃꼍??諛섎뱶??二쇱텧?낅Ц(Main Entrance)???앹꽦?섏뿬 ?몃?????숈꽑???뺣낫?⑸땲?? 

---

## 5. 異쒕젰 ?쒖뼱: ?꾨＼?꾪듃 ?붿??덉뼱留?(Output Control)

### 5.1 POSI-GAP-GUARD ?꾨젅?꾩썙??

理쒖쥌 寃곌낵臾쇱? ?ㅼ쓬??3媛吏 ?먯튃???꾧꺽??以?섑빀?덈떎. 

* **[POSI] Explicit Directions (紐낆떆??吏??- 55%)**
* **Topological Fidelity:** ?낅젰???ㅼ?移섏쓽 '諛?諛곗튂 ?쒖꽌(Topology)'瑜??덈??곸쑝濡?以?섑빀?덈떎.  (?쇱そ???덈뒗 諛⑹? 諛섎뱶???쇱そ???꾩튂?댁빞 ??
* **Drawing Standard:** ?꾨㈃???ㅽ??쇱? 諛섎뱶??**"Minimalist Professional CAD Drafting"**?댁뼱???섎ŉ, 紐⑤끂???꾪솚 猷곗쓣 ?곸슜?섏뿬 "Black & White Monochrome" ?뺤떇?쇰줈 ?쒗쁽?⑸땲?? 
* **Clearance & Dimension:** 怨듦컙???깃꺽??留욎떠 ?숈꽑 ?좏슚 ??Clearance, 900~1200mm)???쇰━?곸쑝濡??뺣낫?섍퀬, ?쒖뒪?쒖쓽 諛곗튂 媛꾧꺽???⑸━?곸쑝濡?議곗젙?⑸땲?? 
* **Annotations:** 二쇱슂 ?ㅼ쓽 紐낆묶(Room Name)? ?띿뒪?몃줈 紐낇솗???쒓린?⑸땲??

* **[GAP] Creative Interpretation (李쎌쓽???댁꽍 - 35%)**
* **Furnishing Detail:** 媛援ъ쓽 援ъ껜?곸씤 ?붿옄?? 諛붾떏???띿뒪泥?????댁묶, 留덈（ ?⑦꽩 ??, ?좎쓽 媛뺤빟 議곗젅(Line Weight)? ?쒓났??{template-a}瑜??곗꽑?쒕떎.  AI??怨듦컙???깃꺽??留욎떠 {template-a}??留λ씫??李쎌쓽???댁꽍?댁꽌 ?곸슜?⑸땲??
* **Scale Adjustment:** ?ㅼ?移섏뿉??鍮꾨?媛 ?댁깋??遺遺꾩? 嫄댁텞???곸떇??留욎떠 ?⑸━?곸씤 鍮꾩쑉濡?誘몄꽭 議곗젙(Fine-tuning)?⑸땲?? 

* **[GUARD] Absolute Constraints (?덈???寃쎄퀎 - 10%)**
* **Strict Solid Poche:** 紐⑤뱺 援ъ“泥?踰쎌껜)???대????낆? ?됱씠??鍮?怨듦컙 ?놁씠 **?꾨꼍??寃????붾━???댁튂(SOLID Hatch)**濡?苑?梨꾩썙???섎ŉ, ?대젰踰쎄낵 鍮꾨궡?λ꼍???먭퍡 李⑥씠瑜?諛섎뱶???쒓컖?뷀빐???⑸땲?? 
* **No Organic Bubbles:** 寃곌낵臾쇱뿉 ?ㅼ?移섏쓽 ?κ렐 踰꾨툝 ?뺥깭???먮슕?댁쭊 ?좎씠 ?⑥븘?덉뼱?쒕뒗 ???⑸땲?? ?꾨꼍??吏곸꽑怨?吏곴컖?쇰줈 蹂?섑빀?덈떎. 
* **No Blocked Flow:** ?붿궡?쒕줈 ?곌껐??吏?먯뿉 踰쎌씠 留됲? ?덉뼱?쒕뒗 ???⑸땲?? 
* **No Perspective:** ?ъ떆?꾨굹 3D 酉곌? ?꾨땶, ?쒓끝 ?녿뒗 **"Top-down Orthographic View"**瑜??좎??⑸땲?? 

### 5.2 ?쒓컖???꾨왂 (Visualization Strategy)

* **Viewport:** **"2D Top-down View"** (Z異뺤씠 ?녿뒗 ?꾨꼍???됰㈃). 

* **Background:** **"Pure White Background"** (洹몃┝?? 醫낆씠 吏덇컧, 諛곌꼍 ?붿냼 諛곗젣). 

* **Style:** **"Clean CAD Line Drawing"** (源붾걫??CAD ?좏솕 ?ㅽ???. 
---

## 6. ?덉쭏 寃利?諛?理쒖쟻??(QA & Optimization)

### 6.1 ?먭? 寃利??꾨줈?좎퐳 (Self-Correction Protocol)

?대?吏 ?앹꽦???꾨즺?섍린 吏곸쟾, ?ㅼ쓬??泥댄겕由ъ뒪?몃? ?듯빐 寃곌낵臾쇱쓽 **'嫄댁텞????뱀꽦'**???ㅼ뒪濡?寃利앺빀?덈떎. 

* **Topological Integrity Check (?꾩긽 ?뺥빀???뺤씤):**
* *Check:* "?낅젰 ?ㅼ?移섏뿉??醫뚯륫???덈뜕 諛⑹씠 寃곌낵臾쇱뿉?쒕룄 醫뚯륫???꾩튂?섎뒗媛?" 
* *Action:* 諛곗튂媛 ?ㅻ컮?뚯뿀?ㅻ㈃ 利됱떆 ?섏젙?섏뿬 ?먮낯 ?ㅼ?移섏쓽 ?꾩긽??蹂듦뎄?⑸땲?? 

* **Connectivity Verification (?곌껐??寃利?:**
* *Check:* "紐⑤뱺 諛⑹씠 臾몄씠???듬줈瑜??듯빐 ?곌껐?섏뼱 ?덈뒗媛? 怨좊┰??'Dead Space'???녿뒗媛?" 
* *Action:* 吏꾩엯??遺덇??ν븳 怨듦컙??諛쒓껄?섎㈃, ?숈꽑 ?먮쫫(Flow)??留욎떠 媛???쇰━?곸씤 ?꾩튂??臾몄쓣 ?앹꽦?⑸땲?? 

* **Main Entrance Verification (二쇱텧?낃뎄 寃利?:**
* *Check:* "?몃???'ENTRANCE', ?대???'Hall', ?먮뒗 ?몃? ?좎엯 ?붿궡?쒓? 紐낆떆??吏?먯쓽 ?몃꼍??二쇱텧?낅Ц???뺥솗???앹꽦?섏뿀?붽??" 
* *Action:* ?꾨씫?섏뿀?ㅻ㈃ 議곌굔??遺?⑺븯??媛???쇰━?곸씤 ?몃꼍 吏?먯뿉 二쇱텧?낅Ц??利됱떆 異붽??⑸땲?? 

* **Structural Consistency (援ъ“ ?쇨???:**
* *Check:* "踰쎌껜???먭퍡媛 ?쇱젙?섎ŉ, 踰쎄낵 踰쎌씠 留뚮굹??紐⑥꽌由ш? 源붾걫?섍쾶(Clean Join) 泥섎━?섏뿀?붽??" 
* *Action:* 踰쎌껜媛 ?딆뼱吏嫄곕굹 寃뱀튇 遺遺꾩씠 ?덈떎硫?'Solid Poche'濡?硫붿썙 ?꾨꼍???먭끝?좎쓣 留뚮벊?덈떎. 

### 6.2 ?뷀뀒??媛뺥솕 諛??쒖? 以??(Detail Enhancement & Drafting Standards)

寃곌낵臾쇱씠 ?꾨Ц?곸씤 嫄댁텞 ?꾨㈃?쇰줈 ?몄젙諛쏄린 ?꾪빐 ?ㅼ쓬???쒕룄 ?쒖?(Drafting Conventions)??以?섑뻽?붿? ?뺤씤?⑸땲?? 

* **Door Swing Logic:** 臾몄쓽 ?대┝ 怨≪꽑(Arc)? 諛섎뱶??**'?ㅻ궡濡?吏꾩엯?섎뒗 諛⑺뼢'**?쇰줈 ?뉕쾶 洹몃젮?몄빞 ?⑸땲??  踰?履쎌쑝濡??대━?꾨줉 諛곗튂?섏뿬 怨듦컙 ?⑥쑉???뺣낫?⑸땲??

* **Window Placement:** 李쏀샇??諛섎뱶??**'?멸린??硫댄븳 踰?Exterior Wall)'**?먮쭔 ?ㅼ튂?섏뼱???⑸땲??  ?대꼍??李쏀샇媛 諛곗튂?섏? ?딅룄濡?二쇱쓽?⑸땲??

* **Symbol Accuracy (?щ낵 ?뺥솗??:** 媛援ъ? ?꾩깮 ?꾧린???쇰컲?곸씤 ?쒖? ?щ낵???꾨땶, {template-a}?먯꽌 洹쒖젙??洹밸룄濡?誘몃땲硫?섍퀬 湲고븯?숈쟻??2D ?щ낵 ?붿옄???묒떇???꾧꺽?섍쾶 ?곸슜?덈뒗吏 寃利앺빀?덈떎. 

### 6.3 ?ъ슜???쇰뱶諛?猷⑦봽 (Iterative Refinement Loop)

?ъ슜?먭? 寃곌낵臾쇱쓣 ?뺤씤?????섏젙 ?붿껌(Revision)??蹂대궪 寃쎌슦, ?꾩껜瑜??ㅼ떆 洹몃━??寃껋씠 ?꾨땲??**'蹂??Variable)'**留??쒖뼱?섏뿬 ?⑥쑉?곸쑝濡?理쒖쟻?뷀빀?덈떎. 

* **Variable Control (蹂???쒖뼱):**
* *User Request:* "?됱닔瑜?30?됱쑝濡??섎젮以? ?먮뒗 "媛援??ㅽ??쇱쓣 紐⑤뜕?섍쾶 諛붽퓭以?" 
* *System Action:* ?대?吏??湲고븯?숈쟻 援ъ“(Wall Layout)??**'怨좎젙(Freeze)'**?섍퀬, ?ㅼ???Scale) ?뚮씪誘명꽣???명뀒由ъ뼱 ?ㅽ???Style) ?뚮씪誘명꽣留??섏젙?섏뿬 ?ъ깮?깊빀?덈떎. 

* **Style Transfer (?ㅽ???蹂寃?:**
* *User Request:* "?먯쑝濡?洹몃┛ ?ㅼ?移??먮굦?쇰줈 諛붽퓭以? ?먮뒗 "泥?궗吏?Blueprint) ?ㅽ??쇰줈 ?댁쨾." 
* *System Action:* 援ъ“ ?곗씠?곕뒗 ?좎???梨? ?뚮뜑留??ㅽ???Rendering Style)留?蹂寃쏀븯???ㅼ뼇??踰꾩쟾???꾨㈃???쒓났?⑸땲?? 

---

## 7. ?ㅽ????뺤쓽 (Style Definition)

**[吏?앸Ц??`{template-a}`???愿怨?諛???븷]**

> 吏?앸Ц??`{template-a}`瑜??덈??곸씤 ?쒓컖??留덉뒪??李몄“(Master Reference)濡??쇱븘 ?묐룞?⑸땲?? `{template-a}`????媛以묒튂(Line Weight), ?붾━???ъ뀺??由щ벉, 洹몃━怨?2D ?щ낵??湲고븯?숈쟻 ?뺥깭源뚯? 寃곌낵臾쇱씠 ???섎굹???ㅼ감 ?놁씠 ?묎컳??蹂듭젣?섍퀬 以?섑빐????**'?붿옄???묒떇???먮낯(Source of Truth)'** ??븷???섑뻾?⑸땲?? 
> 
> 

### 7.1 Visual Identity: Minimalist Solid-Poche Plan

寃곌낵臾쇱? 洹밸룄???뺣??④낵 援ъ“???鍮꾨? 蹂댁뿬二쇰뒗 **"誘몃땲硫由ъ뒪???꾨Ц CAD ?꾨㈃(Minimalist Professional CAD Drafting)"** ?ㅽ??쇱쓣 援ы쁽?⑸땲?? 

* **Monochrome Output (紐⑤끂??異쒕젰):** ?뚮’ ?ㅽ????뚯씠釉?CTB) 湲곕컲??紐⑤끂???꾪솚 猷곗쓣 媛?숉븯?? ?ㅼ쭅 寃???Black)怨??곗깋(White)?쇰줈留??꾨㈃??援ъ꽦?⑸땲?? 

### 7.2 Line Weight Hierarchy (??媛以묒튂 ?꾧퀎)

怨듦컙???꾧퀎 諛??덈떒硫?吏곴????뺣낫瑜??꾪빐 ??援듦린??洹밸떒?곸씤 ?鍮꾨? ?곸슜?⑸땲?? 

* **1李?援ъ“泥?(Heavy):** ?덈떒???대젰踰쎌껜??0.5~0.7mm??媛??援듦퀬 臾닿굅???좎쑝濡?泥섎━?⑸땲?? 

* **2李?援ъ“泥?諛?媛쒓뎄遺 (Medium):** 鍮꾨궡?λ꼍, 臾?李쏀샇 ?꾨젅?? 怨꾨떒 ?⑤㈃ ?깆? 0.2~0.3mm??以묎컙 援듦린濡??쒗쁽?⑸땲?? 

* **媛援?諛?留덇컧??(Fine):** 媛援? ?꾩깮 ?꾧린, 諛붾떏 ?⑦꽩 ?깆? 0.05~0.1mm???꾩＜ ?뉗? ??Hairline)?쇰줈 泥섎━?⑸땲?? 

### 7.3 Component Rendering Rules (援ъ꽦 ?붿냼 ?뚮뜑留?洹쒖튃)

* **Solid Poche Rhythm (?먭퍡???곕Ⅸ ?붾━???ъ뀺 李⑤벑 ?곸슜):** ?꾨㈃???쒓컖??由щ벉媛먭낵 怨듦컙???꾧퀎??紐낇솗?깆쓣 洹밸??뷀븯湲??꾪빐, ?대젰踰?`A-WALL-STRC`)怨?鍮꾨궡??移몃쭑?대꼍(`A-WALL-PRTN`) 紐⑤몢 ?꾨꼍??寃????붾━???댁튂(`SOLID` Hatch)濡?梨꾩썙 ?묐룄?⑸땲??  臾쇰━???섏쨷??吏吏?섎뒗 ?대젰踰쎌? ?먭퍖寃? 移몃쭑?대꼍? ?뉕쾶 ?뚮뜑留곹빀?덈떎.

* **Boolean Union:** 援ъ“泥닿? 留뚮굹??援먯감?먯? ?대? ?좊텇???쒓굅?섏뿬 ?곗냽???⑥씪 媛앹껜濡?蹂묓빀?⑸땲?? 

* **TEMPLATE-A Standard Symbols:** 紐⑤뱺 2D ?щ낵? 李몄“ ?꾨㈃(`TEMPLATE-A`)??誘몃땲硫?섍퀬 湲고븯?숈쟻???묒떇???꾧꺽??以?섑빀?덈떎.  遺덊븘?뷀븳 ?뷀뀒?쇱? 諛곗젣?섍퀬 ?뺣????뉗? ?좎쑝濡쒕쭔 ?쒗쁽?⑸땲??

* **Material Line & Hatch:** ?뺤떎/?뚮씪????臾쇱쓣 ?곕뒗 怨듦컙? ?뉗? ???洹몃━??Net) 臾대뒳 ?댁튂瑜??곸슜?⑸땲?? 

### 7.4 Annotations & View Constraints (二쇱꽍 諛?酉??쒖빟)

* **Graphic Bar Scale (洹몃옒???ㅼ???諛??곸슜):** 吏곴??곸씤 怨듦컙 鍮꾨? ?뺤씤???꾪빐 ?꾨㈃ ?댁뿉 洹몃옒???ㅼ???諛?Graphic Bar Scale)瑜??쒓린?⑸땲?? 
* **Orthographic View:** ?쒓끝 ?녿뒗 Top-down Orthographic View(?뺥룊硫대룄)瑜??꾧꺽???좎??⑸땲??
* **Background:** "Pure White(?쒕갚??" 諛곌꼍???ъ슜?⑸땲??

---

## 8. ?곗씠??異붿텧 諛?援ъ“??異쒕젰 (Data Extraction & Structured Output)

### 8.1 怨듦컙 ?뚮씪誘명꽣 遺꾩꽍 (Room Parameter Analysis)

?꾨㈃ ?앹꽦???꾨즺???? ?앹꽦???됰㈃???댁쓽 紐⑤뱺 ??Room)??媛쒕퀎?곸쑝濡?遺꾩꽍?섏뿬 ?ㅼ쓬???뚮씪誘명꽣瑜??꾩닔?곸쑝濡?異붿텧?⑸땲??

* **{?ㅻ챸}**: 遺꾩꽍???ㅼ쓽 紐낆묶
* **{媛濡?mm) x ?몃줈(mm)}**: ?ㅼ쓽 臾쇰━??移섏닔
* **{硫댁쟻}**: 怨꾩궛??硫댁쟻 (?⑥쐞: m짼 ?먮뒗 ??
* **{異쒖엯援?**: 異쒖엯臾몄쓽 ?꾩튂 諛?媛쒖닔
* **{李??꾩튂}**: 李쏀샇媛 諛곗튂???몃꼍??諛⑺뼢 諛??꾩튂
* **{二쇰? ?ㅺ낵??愿怨?**: ?몄젒???덇굅???숈꽑??吏곸젒 ?곌껐???ㅻⅨ ?ㅻ뱾??紐⑸줉 諛?愿怨꾩꽦
* **{湲고?}**: 洹???諛곗튂??二쇱슂 ?붿냼 ??(...)

### 8.2 遺꾩꽍 寃곌낵 異쒕젰 ?щ㎎ (RESULT Panel Output Format)

遺꾩꽍??怨듦컙 ?뚮씪誘명꽣??諛섎뱶??**?쁒ESULT???⑤꼸???쁂ODE??(留덊겕?ㅼ슫 肄붾뱶 釉붾줉)** ?댁뿉 ?꾨옒??吏?뺣맂 ?묒떇???꾧꺽??吏耳?湲곗엯?댁빞 ?⑸땲?? 媛??ㅼ쓽 遺꾩꽍 寃곌낵??**"???ㅻ챸"**???쒕ぉ?쇰줈 ?섏뿬 紐낇솗??援щ텇?⑸땲??

```text
??{?ㅻ챸 1}
- 移섏닔: {媛濡?mm) x ?몃줈(mm)}
- 硫댁쟻: {硫댁쟻}
- 異쒖엯援? {異쒖엯援??뺣낫}
- 李??꾩튂: {李??꾩튂 ?뺣낫}
- 二쇰? ?ㅺ낵??愿怨? {二쇰? ?ㅺ낵??愿怨??뺣낫}
- 湲고?: {...}

??{?ㅻ챸 2}
- 移섏닔: {媛濡?mm) x ?몃줈(mm)}
...
```

---

**[End of System Prompt]**

# template: Visual Output Guideline: Minimalist Solid-Poche Plan

# 1. 시각적 정체성 및 도면 체계 (Visual Identity & Hierarchy)
결과물은 극도의 정밀함과 구조적 대비를 보여주는 **"미니멀리스트 전문 CAD 도면(Minimalist Professional CAD Drafting)"** 스타일을 구현합니다.
* **Monochrome Output (모노톤 출력):** 플롯 스타일 테이블(CTB) 기반의 모노톤 전환 룰을 가동하여, 오직 검은색(Black)과 흰색(White)으로만 도면을 구성합니다.

* **Line Weight Hierarchy (선 가중치 위계):** 공간의 위계 및 절단면 직관성 확보를 위해 선 굵기의 극단적인 대비를 적용합니다.
* **1차 구조체 (Heavy):** 절단된 내력벽체는 0.5~0.7mm의 가장 굵고 무거운 선으로 처리하여 가장 뚜렷하게 인지되도록 합니다.
* **2차 구조체 및 개구부 (Medium):** 비내력벽, 문/창호 프레임, 계단 단면 등은 0.2~0.3mm의 중간 굵기로 표현합니다.
* **가구 및 마감선 (Fine):** 가구, 위생 도기, 바닥 패턴 등은 0.05~0.1mm의 아주 얇은 선(Hairline)으로 처리하여 시각적 간섭을 최소화합니다.

# 2. 구성 요소 렌더링 규칙 (Component Rendering Rules)
* **A. 구조체 (Structural Drafting)**
* **Solid Poche Rhythm (두께에 따른 솔리드 포셰 차등 적용):** 도면의 **시각적 리듬감**과 **공간의 위계적 명확성**을 극대화하기 위해, 내력벽(\`A-WALL-STRC\`)과 비내력 칸막이벽(\`A-WALL-PRTN\`) **모두 완벽한 검은색 솔리드 해치(\`SOLID\` Hatch)로 채워 작도**합니다. 단, 물리적 하중을 지지하는 내력벽(외벽, 기둥 등)은 매우 두껍게, 공간을 분할하는 비내력벽은 얇게 두께의 대비를 명확히 주어 렌더링합니다.
* **Boolean Union (접합부 정리):** 구조체가 만나는 교차점(T자, L자)은 내부 선분을 제거하여 연속된 단일 객체로 병합합니다.

* **B. 개구부 및 코어 (Openings & Core)**
* **Break & Clearance (개구부 타공):** 문과 창호가 위치할 벽체는 폭만큼 완벽히 절단하여 고립 공간(Dead Space) 생성을 방지합니다. 한 벽에 한 개 이상의 문이 생성되었는지 파악하여, 한 벽에는 오직 한 개의 문만 생성되도록 합니다.
* **Door Swing (문 열림 궤적):** 문짝이 회전하는 동선은 기하학적 호(\`ARC\`) 엔티티로 얇게 묘사합니다.
* **Stair & EV (계단 및 승강기):** 계단은 디딤판을 평행선으로 분할 작도하고 지그재그 절단선 및 방향 화살표를 표기합니다. 엘리베이터 및 설비 샤프트 내부는 X자 교차선으로 빈 공간임을 명시합니다.

* **C. 인테리어 및 가구 (Furnishing & Equipment)**
* **TEMPLATE-A Standard Symbols (제공 도면 양식 준수):** 가구를 포함한 위생 도기, 주방 설비 등의 모든 2D 심볼은 임의의 형태가 아닌, **제공된 참조 도면(\`TEMPLATE-A\`)의 극도로 미니멀하고 기하학적인 디자인 양식을 엄격하게 준수**하여 묘사합니다. 불필요한 감성적 디테일(주름, 쿠션 등)을 완벽히 배제하고 정밀한 얇은 선(Hairline)으로만 표현합니다.
* **Flow Clearance (유효 폭 확보):** 동선이 차단되지 않도록 복도 및 활동 반경 내에 최소 유효 폭(900mm~1200mm)을 강제 이격하여 레이아웃을 구성합니다.
* **Material Line & Hatch (재료 분리 및 해치):** 기능 분리 지점에 얇은 실선의 재료 분리선을 작도합니다. 욕실/테라스 등 물을 쓰는 공간은 얇은 타일 그리드(Net) 무늬 해치를 적용합니다.

* **D. 주석 및 치수 (Annotations & Dimensions)**
* **Graphic Bar Scale (그래픽 스케일 바 적용)**
* 치수와 스케일의 절대 기준은 배경의 그리드(Grid)입니다. 평면도 이미지와 스케일 바를 생성할 때 반드시 이 그리드를 기준으로 비례를 맞춥니다.
* 직관적인 공간 비례 확인을 위해 도면 내에 **그래픽 스케일 바(Graphic Bar Scale)**를 표기합니다.
* **배치 위치:** 도면의 하단 중앙 또는 우측 하단 여백에 배치하여 공간 및 동선 확인에 대한 시각적 간섭을 최소화합니다.
* **디자인 및 렌더링 규칙:** 도면의 'Minimalist Solid-Poche' 정체성을 유지하기 위해, 0.05~0.1mm의 아주 얇은 선(Hairline)과 흑백이 교차하는 완벽한 검은색 솔리드 블록(\`SOLID\` Hatch)으로만 구성합니다. 장식적 요소는 철저히 배제합니다.
* **치수 간격 및 단위:** 미터(m) 단위를 기준(예: 0, 1m, 2m, 5m)으로 분할하며, 기준점의 숫자는 명확하게 기입합니다.

* **Text Hierarchy (텍스트 위계)**
* 닫힌 공간 중심점에 실명(Room Name)을 기입합니다. 
* 폰트 크기는 [도면명 > 주요 실명 > 일반 주석 / 바 스케일 단위 주석] 순으로 위계를 설정합니다. 
* 모든 주석 및 텍스트에는 고딕 계열 폰트를 강제 적용합니다. 

# 3. 도면 뷰 및 환경 (View & Workspace)
* **Orthographic View:** 모든 Z축 고도 값을 0으로 평탄화하여 왜곡 없는 Top-down Orthographic View(정평면도)를 엄격히 유지합니다.
* **Background:** 솔리드 포셰의 리듬감과 선의 위계가 완벽히 대비되도록 질감이 없는 "Pure White(순백색)" 배경을 사용합니다.

User Architectural Logic (Structural Driver): ${textPrompt || 'Standard modern layout'}`;

      const parts: any[] = [{ text: finalPrompt }];
      if (base64Image) {
        parts.unshift({
          inlineData: {
            data: base64Image,
            mimeType: 'image/jpeg'
          }
        });
      }

      // --- Step 1: Sketch Analysis ---
      setCurrentStep(0); // Zoning Analysis & Axis Alignment
      const analysisPrompt = `Analyze the provided architectural sketch and text prompt. 
Extract structural logic, zoning, boundaries, and flow requirements as defined in the following system prompt:
${finalPrompt}
Return only the structural analysis and rectified logic for generation.`;

      let analysisResponse;
      try {
        analysisResponse = await ai.models.generateContent({
          model: SKETCH_ANALYSIS,
          contents: { parts: [{ text: analysisPrompt }, { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }] }
        });
      } catch (error) {
        console.warn('Sketch Analysis Primary model failed, trying fallback:', error);
        analysisResponse = await ai.models.generateContent({
          model: SKETCH_ANALYSIS_FALLBACK,
          contents: { parts: [{ text: analysisPrompt }, { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }] }
        });
      }

      const structuralDriverRes = analysisResponse.candidates?.[0]?.content?.parts?.[0]?.text || "Standard modern layout";
      console.log("Analysis Result:", structuralDriverRes);

      // --- Step 2: Plan Image Generation ---
      setCurrentStep(3); // Boundary Extraction, Material Layering, Flow & Routing
      const generationPrompt = `${finalPrompt}
Based on the following structural analysis:
${structuralDriverRes}
Generate a professional, minimalist, black and white 2D top-down CAD floor plan.`;

      const generationParts: any[] = [
        { text: generationPrompt },
        { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
      ];

      let response;
      try {
        response = await ai.models.generateContent({
          model: PLAN_IMAGE_GEN,
          contents: { parts: generationParts }
        });
      } catch (error) {
        console.warn('Plan Generation Primary model failed, trying fallback:', error);
        response = await ai.models.generateContent({
          model: PLAN_IMAGE_GEN_FALLBACK,
          contents: { parts: generationParts }
        });
      }

      let generatedImgUrl = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          generatedImgUrl = `data:image/png;base64,${part.inlineData.data}`;
          break;
        }
      }

      if (generatedImgUrl) {
        const processedImgUrl = await removeExteriorWhite(generatedImgUrl);
        setGeneratedImage(processedImgUrl);
        setActiveTab('result');

        // Save to library
        setLibraryItems(prev => [{
          id: `lib-${Date.now()}`,
          image: processedImgUrl,
          timestamp: Date.now()
        }, ...prev]);

        const newLayer: Layer = {
          id: `layer-${Date.now()}`,
          name: 'PLAN',
          visible: true,
          opacity: 100,
          image: processedImgUrl,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        };
        setLayers(prev => {
          const updatedLayers = prev.map(l => l.id === 'layer-1' ? { ...l, visible: false } : l);
          return [newLayer, ...updatedLayers];
        });
        setSelectedLayerId(newLayer.id);
      } else {
        alert("Failed to generate image. Please try again.");
      }

    } catch (error) {
      console.error("Generation error:", error);
      alert("An error occurred during generation. Check console for details.");
    } finally {
      clearInterval(stepInterval);
      setIsGenerating(false);
      setCurrentStep(GENERATION_STEPS.length);
    }
  };

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-bw-white text-bw-black dark:bg-bw-black dark:text-bw-white transition-colors duration-300">
      {/* ----------------- HEADER ----------------- */}
      <header className="h-16 short:h-12 flex items-center justify-between px-6 short:px-4 shrink-0 z-30 bg-bw-white dark:bg-bw-black">
        <div className="flex items-center gap-4">
          <span className="font-display text-3xl short:text-2xl pt-1">C</span>
          <h1 className="font-display text-[1.575rem] tracking-wide pt-1 cursor-pointer hover:opacity-60 transition-opacity">
            SKETCH TO PLAN
          </h1>
        </div>

        <div className="flex items-center gap-8">
          <button
            onClick={() => setShowLibrary(true)}
            disabled={isGenerating}
            className={`font-display text-lg tracking-wide hover:opacity-60 transition-opacity pt-1 ${isGenerating ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            LIBRARY
          </button>
          <button
            onClick={toggleTheme}
            disabled={isGenerating}
            className={`hover:opacity-60 transition-opacity ${isGenerating ? 'pointer-events-none opacity-50' : ''}`}
          >
            {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
          </button>
        </div>
      </header>

      {/* ----------------- MAIN LAYOUT ----------------- */}
      <main className="flex-1 flex flex-col landscape:flex-row overflow-hidden relative">

        {/* [라이브러리 오버레이 모드 z-60] */}
        {showLibrary && (
          <div className="absolute inset-0 z-[60] bg-bw-white dark:bg-bw-black flex flex-col">
            <div className="flex items-center justify-between px-6 pt-6 shrink-0">
              <h2 className="font-display text-xl tracking-wide">LIBRARY</h2>
              <button onClick={() => setShowLibrary(false)} className="hover:opacity-60 transition-opacity">
                <X size={24} strokeWidth={1.5} />
              </button>
            </div>
            <div className="flex-1 p-6 overflow-y-auto">
              {libraryItems.length === 0 ? (
                <div className="h-full flex items-center justify-center opacity-40">
                  <span className="font-display text-4xl">EMPTY</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                  {libraryItems.map((item) => (
                    <div key={item.id} className="group relative aspect-square border border-bw-black/10 dark:border-bw-white/10 overflow-hidden bg-bw-black/5 dark:bg-bw-white/5">
                      <img src={item.image} alt="Saved Plan" className="w-full h-full object-contain p-2" />
                      <div className="absolute inset-0 bg-bw-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-4">
                        <button
                          onClick={() => {
                            const link = document.createElement('a');
                            link.download = `plan-${item.id}.png`;
                            link.href = item.image;
                            link.click();
                          }}
                          className="p-2 bg-bw-white text-bw-black rounded-full hover:scale-110 transition-transform"
                          title="Download"
                        >
                          <Download size={20} />
                        </button>
                        <button
                          onClick={() => {
                            setLibraryItems(prev => prev.filter(i => i.id !== item.id));
                          }}
                          className="p-2 bg-red-500 text-white rounded-full hover:scale-110 transition-transform"
                          title="Delete"
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                      <div className="absolute bottom-2 left-2 text-[10px] font-mono opacity-50 bg-bw-white/80 dark:bg-bw-black/80 px-1">
                        {new Date(item.timestamp).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 좌측 메인 영역 (분할: 캔버스 / 결과 뷰어) */}
        <div className="relative bg-bw-white dark:bg-bw-black flex flex-col min-w-0 h-[30vh] landscape:h-auto landscape:flex-1">
          <div className={`w-full h-full relative ${isGenerating ? 'pointer-events-none opacity-80' : ''}`}>

            {/* 상단 도구 모음 (Floating Toolbar) */}
            <div className="absolute top-4 left-4 z-30 flex flex-col gap-0 border border-bw-black dark:border-bw-white shadow-sm bg-bw-white dark:bg-bw-black">
              <button onClick={() => setDrawMode('pen')} className={`p-2 w-full flex items-center justify-center h-[34px] hover:bg-bw-black/10 dark:hover:bg-bw-white/10 transition-colors ${drawMode === 'pen' ? 'bg-bw-black/10 dark:bg-bw-white/10' : ''}`} title="Pen">
                <Pen size={16} />
              </button>
              <button onClick={() => { setDrawMode('eraser'); setEraserPos(null); }} className={`p-2 w-full flex items-center justify-center h-[34px] hover:bg-bw-black/10 dark:hover:bg-bw-white/10 transition-colors border-t border-bw-black dark:border-bw-white ${drawMode === 'eraser' ? 'bg-bw-black/10 dark:bg-bw-white/10' : ''}`} title="Eraser">
                <Eraser size={16} />
              </button>
              <button onClick={() => setDrawMode('rectangle')} className={`p-2 w-full flex items-center justify-center h-[34px] hover:bg-bw-black/10 dark:hover:bg-bw-white/10 transition-colors border-t border-bw-black dark:border-bw-white ${drawMode === 'rectangle' ? 'bg-bw-black/10 dark:bg-bw-white/10' : ''}`} title="Rectangle">
                <Square size={16} />
              </button>
              <button onClick={() => setDrawMode('move')} className={`p-2 w-full flex items-center justify-center h-[34px] hover:bg-bw-black/10 dark:hover:bg-bw-white/10 transition-colors border-t border-bw-black dark:border-bw-white ${drawMode === 'move' ? 'bg-bw-black/10 dark:bg-bw-white/10' : ''}`} title="Move">
                <Move size={16} />
              </button>
              <button onClick={() => setDrawMode('text')} className={`p-2 w-full flex items-center justify-center h-[34px] hover:bg-bw-black/10 dark:hover:bg-bw-white/10 transition-colors border-t border-bw-black dark:border-bw-white ${drawMode === 'text' ? 'bg-bw-black/10 dark:bg-bw-white/10' : ''}`} title="Text">
                <Type size={16} />
              </button>
              <button onClick={() => setDrawMode('origin')} className={`p-2 w-full flex items-center justify-center h-[34px] hover:bg-bw-black/10 dark:hover:bg-bw-white/10 transition-colors border-t border-bw-black dark:border-bw-white ${drawMode === 'origin' ? 'bg-bw-black/10 dark:bg-bw-white/10' : ''}`} title="Set Origin">
                <Crosshair size={16} />
              </button>
              <button onClick={handleUndo} className={`p-2 w-full flex items-center justify-center h-[34px] hover:bg-bw-black/10 dark:hover:bg-bw-white/10 transition-colors border-t border-bw-black dark:border-bw-white`} title="Undo">
                <Undo2 size={16} />
              </button>
              <button onClick={clearCurrentLayer} className="p-2 w-full flex items-center justify-center h-[34px] hover:bg-red-500 hover:text-bw-white transition-colors border-t border-bw-black dark:border-bw-white text-red-500" title="Clear Layer">
                <Trash2 size={16} />
              </button>
            </div>

            {activeTab === 'create' ? (
              <div
                id="canvas-container"
                className="absolute inset-0 overflow-hidden bg-bw-white dark:bg-bw-black select-none touch-none"
                onPointerLeave={() => setEraserPos(null)}
                onContextMenu={(e) => e.preventDefault()}
                onSelectStart={(e) => e.preventDefault()}
              >
                <div className="w-full h-full relative dark:invert">
                  {[...layers].reverse().map((layer, idx) => {
                    return (
                      <div
                        key={layer.id}
                        className="absolute inset-0"
                        style={{
                          opacity: layer.visible ? layer.opacity / 100 : 0,
                          zIndex: idx,
                          pointerEvents: selectedLayerId === layer.id && layer.visible ? 'auto' : 'none'
                        }}
                      >
                        {layer.isGrid ? (
                          <div className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(#000000 1px, transparent 1px), linear-gradient(90deg, #000000 1px, transparent 1px)', backgroundSize: '45px 45px', backgroundPosition: '0 0' }}></div>
                        ) : (
                          <>
                            <TransformableImage
                              layer={layer}
                              updateTransform={updateLayerTransform}
                              isActive={selectedLayerId === layer.id && drawMode === 'move'}
                            />
                            <canvas
                              id={`canvas-${layer.id}`}
                              className={`absolute top-0 left-0 touch-none ${drawMode === 'move' ? 'pointer-events-none' : ''} ${drawMode === 'origin' ? 'cursor-crosshair' : ''} ${drawMode === 'text' ? 'cursor-text' : ''}`}
                              onMouseDown={startDrawing}
                              onMouseMove={draw}
                              onMouseUp={stopDrawing}
                              onMouseOut={stopDrawing}
                              onMouseDownCapture={preventDoubleTap}
                              onDoubleClick={(e) => e.preventDefault()}
                              onTouchStart={startDrawing}
                              onTouchMove={draw}
                              onTouchEnd={stopDrawing}
                              onClick={handleCanvasClick}
                            />
                            {layer.shapes?.map(shape => (
                              <ShapeRenderer
                                key={shape.id}
                                shape={shape}
                                isActive={selectedLayerId === layer.id && drawMode === 'move'}
                                updateShape={(id, newShape) => {
                                  setLayers(layers.map(l => l.id === layer.id ? { ...l, shapes: l.shapes?.map(s => s.id === id ? newShape : s) } : l));
                                }}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                {drawMode === 'eraser' && eraserPos && (
                  <div
                    className="absolute pointer-events-none rounded-full border-2 border-red-500 z-[999]"
                    style={{
                      left: eraserPos.x,
                      top: eraserPos.y,
                      width: 20,
                      height: 20,
                      transform: 'translate(-50%, -50%)',
                    }}
                  />
                )}

                {origins.map((origin, idx) => (
                  <div
                    key={idx}
                    className="absolute z-40 pointer-events-none"
                    style={{ left: origin.x, top: origin.y }}
                  >
                    <div className="absolute" style={{ transform: 'translate(-50%, -50%)' }}>
                      <div className="w-4 h-4 border-2 border-red-500 rounded-full flex items-center justify-center bg-bw-white/50 dark:bg-bw-black/50">
                        <div className="w-1 h-1 bg-red-500 rounded-full"></div>
                      </div>
                    </div>
                    <div className="absolute" style={{ transform: 'translate(-50%, 10px)' }}>
                      <span className="text-red-500 font-mono text-xs font-bold bg-bw-white/80 dark:bg-bw-black/80 px-1 rounded whitespace-nowrap">WP {idx + 1}</span>
                    </div>
                  </div>
                ))}

                {textInput && (
                  <input
                    autoFocus
                    type="text"
                    value={textInput.value}
                    onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
                    onBlur={(e) => addTextShape(e.target.value, textInput.x, textInput.y)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      }
                      if (e.key === 'Escape') {
                        setTextInput(null);
                      }
                    }}
                    className="absolute z-50 bg-bw-white dark:bg-bw-black border border-bw-black dark:border-bw-white outline-none px-2 py-1 text-bw-black dark:text-bw-white"
                    style={{
                      left: textInput.x,
                      top: textInput.y,
                      transform: 'translateY(-50%)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      fontSize: '20px',
                      minWidth: '150px'
                    }}
                    placeholder="텍스트 입력 후 Enter"
                  />
                )}
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-bw-white dark:bg-bw-black p-8">
                {generatedImage ? (
                  <img src={generatedImage} alt="Generated Result" className="max-w-full max-h-full object-contain border border-bw-black dark:border-bw-white shadow-lg dark:invert" />
                ) : (
                  <span className="font-mono text-sm opacity-50">NO RESULT YET</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 우측 옵션 패널 (Right Panel - w-320px 고정) */}
        {!showLibrary && (
          <div className={`
            w-full ${isRightPanelOpen ? 'landscape:w-[320px]' : 'landscape:w-0'} 
            bg-bw-white dark:bg-bw-black flex flex-col z-[200] border-t landscape:border-t-0 
            ${isRightPanelOpen ? 'landscape:border-l' : ''} border-bw-black/10 dark:border-bw-white/10 
            relative flex-1 landscape:flex-none landscape:h-full transition-all duration-300
          `}>

            {/* 반응형 접기/펼치기 버튼 (가운데 돌출) */}
            <button
              onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
              className={`absolute top-1/2 -translate-y-1/2 -left-8 w-8 h-16 bg-bw-white dark:bg-bw-black border border-bw-black/10 dark:border-bw-white/10 dark:border-l-bw-white/10 border-r-0 flex items-center justify-center z-[210] rounded-l-md hidden landscape:flex`}
            >
              {isRightPanelOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>

            {/* 패널 내부 컨텐츠 영역 */}
            <div className={`flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-5 custom-scrollbar ${isRightPanelOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'} transition-opacity duration-200 delay-100`}>

              {/* View Toggle */}
              <div className="flex border border-bw-black dark:border-bw-white shrink-0">
                <button onClick={() => setActiveTab('create')} className={`flex-1 py-2 font-display text-sm text-center ${activeTab === 'create' ? 'bg-bw-black text-bw-white dark:bg-bw-white dark:text-bw-black' : 'hover:bg-bw-black/5 dark:hover:bg-bw-white/5'}`}>CREATE</button>
                <button onClick={() => setActiveTab('result')} className={`flex-1 py-2 font-display text-sm text-center border-l border-bw-black dark:border-bw-white ${activeTab === 'result' ? 'bg-bw-black text-bw-white dark:bg-bw-white dark:text-bw-black' : 'hover:bg-bw-black/5 dark:hover:bg-bw-white/5'}`}>RESULT</button>
              </div>

              {/* 섹션 1: 텍스트 입력 (Prompt) */}
              <div className="space-y-3 flex flex-col flex-1 min-h-[30%]">
                <label className="font-display text-xl block">CODE</label>
                <textarea
                  value={textPrompt}
                  onChange={(e) => setTextPrompt(e.target.value)}
                  className="w-full flex-1 p-3 font-mono text-xs bg-transparent border border-bw-black dark:border-bw-white focus:outline-none resize-none placeholder-gray-400 rounded-none min-h-[100px]"
                  placeholder="Insert parameters here..."
                  disabled={isGenerating}
                />
              </div>

              {/* 섹션 2: 레이어 관리 (Layers) */}
              <div className="space-y-3 flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between">
                  <label className="font-display text-xl block">LAYERS</label>
                  <button
                    onClick={addLayer}
                    className="p-1 border border-bw-black dark:border-bw-white hover:bg-bw-black hover:text-bw-white dark:hover:bg-bw-white dark:hover:text-bw-black transition-colors"
                    title="Add Layer"
                  >
                    <Plus size={16} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto border border-bw-black dark:border-bw-white custom-scrollbar p-2 space-y-2">
                  {layers.map((layer, index) => (
                    <div
                      key={layer.id}
                      className={`p-2 border ${selectedLayerId === layer.id ? 'border-bw-black dark:border-bw-white bg-bw-black/5 dark:bg-bw-white/10' : 'border-bw-black/20 dark:border-bw-white/20 bg-transparent'} flex flex-col gap-2 ${!layer.visible ? 'opacity-50' : ''} cursor-pointer transition-colors`}
                      onClick={() => setSelectedLayerId(layer.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div className="flex flex-col gap-0.5">
                            <button onClick={(e) => { e.stopPropagation(); moveLayer(index, 'up'); }} disabled={index === 0} className="text-gray-400 hover:text-bw-black dark:hover:text-bw-white disabled:opacity-30">▲</button>
                            <button onClick={(e) => { e.stopPropagation(); moveLayer(index, 'down'); }} disabled={index === layers.length - 1} className="text-gray-400 hover:text-bw-black dark:hover:text-bw-white disabled:opacity-30">▼</button>
                          </div>
                          {editingLayerId === layer.id ? (
                            <input
                              autoFocus
                              className="font-mono text-xs flex-1 bg-bw-white dark:bg-bw-black border border-bw-black dark:border-bw-white px-1 py-0.5 outline-none"
                              defaultValue={layer.name}
                              onBlur={(e) => {
                                renameLayer(layer.id, e.target.value);
                                setEditingLayerId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  renameLayer(layer.id, e.currentTarget.value);
                                  setEditingLayerId(null);
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <span
                              className="font-mono text-xs truncate flex-1 hover:bg-bw-black/5 dark:hover:bg-bw-white/5 px-1 py-0.5 rounded cursor-text"
                              onClick={(e) => { e.stopPropagation(); setEditingLayerId(layer.id); }}
                              title="Click to rename"
                            >
                              {layer.name}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {!layer.isGrid && (
                            <label className="p-1 hover:bg-bw-black/10 dark:hover:bg-bw-white/10 rounded cursor-pointer" title="Upload Image to Layer" onClick={(e) => e.stopPropagation()}>
                              <ImageIcon size={14} />
                              <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, layer.id)} />
                            </label>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); toggleLayerVisibility(layer.id); }} className="p-1 hover:bg-bw-black/10 dark:hover:bg-bw-white/10 rounded">
                            {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                          </button>
                          {!layer.isGrid && (
                            <button onClick={(e) => { e.stopPropagation(); removeLayer(layer.id); }} className="p-1 hover:bg-red-500 hover:text-bw-white rounded text-red-500">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {!layer.isGrid && (
                          <>
                            <span className="font-mono text-[10px] w-8">OPC</span>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={layer.opacity}
                              onChange={(e) => updateLayerOpacity(layer.id, parseInt(e.target.value))}
                              className="flex-1 h-1 bg-bw-black/20 dark:bg-bw-white/20 appearance-none cursor-pointer"
                            />
                            <span className="font-mono text-[10px] w-8 text-right">{layer.opacity}%</span>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {layers.length === 0 && (
                    <div className="text-center p-4 font-mono text-xs opacity-50">No layers</div>
                  )}
                </div>
              </div>
            </div>

            {/* 하단 고정 영역: Generate 버튼 */}
            <div className={`shrink-0 pt-4 pb-8 px-6 bg-bw-white dark:bg-bw-black z-50 transform-gpu ${isRightPanelOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'} transition-opacity duration-200 delay-100`}>
              <div className="relative">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="w-full py-2 font-display text-lg tracking-widest flex items-center justify-center gap-3 transition-all relative border border-bw-black dark:border-bw-white hover:bg-bw-black hover:text-bw-white dark:hover:bg-bw-white dark:hover:text-bw-black disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span>{isGenerating ? 'GENERATING...' : 'GENERATE'}</span>
                </button>
              </div>
              <div className="mt-4 pt-2 border-t border-bw-black/10 dark:border-bw-white/10 text-center flex justify-center shrink-0">
                <p className="font-mono text-[9px] opacity-40 tracking-widest whitespace-nowrap">
                  © CRETE CO.,LTD. ALL RIGHTS RESERVED.
                </p>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}

const ShapeRenderer = ({
  shape,
  isActive,
  updateShape,
  onCancel,
  onConfirm
}: {
  shape: Shape;
  isActive: boolean;
  updateShape: (id: string, shape: Shape) => void;
  onCancel?: () => void;
  onConfirm?: () => void;
  key?: string | number;
}) => {
  const [isSelected, setIsSelected] = useState(false);
  const [tempShape, setTempShape] = useState<Shape | null>(null);
  const interactionRef = useRef({
    type: 'none',
    startX: 0, startY: 0,
    initX: 0, initY: 0,
    initWidth: 0, initHeight: 0
  });

  const displayShape = tempShape || shape;

  // Use a ref for updateShape to avoid closure issues in event listeners (if any)
  const updateShapeRef = useRef(updateShape);
  useEffect(() => {
    updateShapeRef.current = updateShape;
  }, [updateShape]);

  useEffect(() => {
    if (!isActive) {
      setIsSelected(false);
      setTempShape(null);
    }
  }, [isActive]);

  const handlePointerDown = (e: React.PointerEvent, type: string) => {
    if (!isActive) return;
    e.stopPropagation();

    // Prevent default scrolling on touch
    if (e.pointerType === 'touch') {
      (e.target as HTMLElement).style.touchAction = 'none';
    }

    if (type === 'body') {
      setIsSelected(true);
      if (!tempShape) setTempShape({ ...shape });
    }

    const currentInit = tempShape || shape;

    interactionRef.current = {
      type,
      startX: e.clientX,
      startY: e.clientY,
      initX: currentInit.x,
      initY: currentInit.y,
      initWidth: currentInit.width,
      initHeight: currentInit.height
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const container = document.getElementById('canvas-container');
      let scaleX = 1;
      let scaleY = 1;
      if (container) {
        const rect = container.getBoundingClientRect();
        scaleX = container.clientWidth / rect.width;
        scaleY = container.clientHeight / rect.height;
      }

      const dx = (moveEvent.clientX - interactionRef.current.startX) * scaleX;
      const dy = (moveEvent.clientY - interactionRef.current.startY) * scaleY;

      const snapGrid = 150 / 20; // 7.5px = 150mm

      let newX = interactionRef.current.initX;
      let newY = interactionRef.current.initY;
      let newWidth = interactionRef.current.initWidth;
      let newHeight = interactionRef.current.initHeight;

      if (type === 'body') {
        newX = Math.round((interactionRef.current.initX + dx) / snapGrid) * snapGrid;
        newY = Math.round((interactionRef.current.initY + dy) / snapGrid) * snapGrid;
      } else if (type === 'right') {
        newWidth = Math.round((interactionRef.current.initWidth + dx) / snapGrid) * snapGrid;
        if (newWidth < snapGrid) newWidth = snapGrid;
      } else if (type === 'bottom') {
        newHeight = Math.round((interactionRef.current.initHeight + dy) / snapGrid) * snapGrid;
        if (newHeight < snapGrid) newHeight = snapGrid;
      } else if (type === 'left') {
        const snappedDx = Math.round(dx / snapGrid) * snapGrid;
        newX = interactionRef.current.initX + snappedDx;
        newWidth = interactionRef.current.initWidth - snappedDx;
        if (newWidth < snapGrid) {
          newWidth = snapGrid;
          newX = interactionRef.current.initX + interactionRef.current.initWidth - snapGrid;
        }
      } else if (type === 'top') {
        const snappedDy = Math.round(dy / snapGrid) * snapGrid;
        newY = interactionRef.current.initY + snappedDy;
        newHeight = interactionRef.current.initHeight - snappedDy;
        if (newHeight < snapGrid) {
          newHeight = snapGrid;
          newY = interactionRef.current.initY + interactionRef.current.initHeight - snapGrid;
        }
      }

      setTempShape({
        ...shape,
        x: newX,
        y: newY,
        width: newWidth,
        height: newHeight
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const confirmChange = () => {
    if (tempShape) {
      updateShapeRef.current(shape.id, tempShape);
      setTempShape(null);
      setIsSelected(false); // Move functionality deactivation
      if (onConfirm) onConfirm();
    } else {
      setIsSelected(false);
    }
  };

  const cancelChange = () => {
    setTempShape(null);
    if (onCancel) onCancel();
  };

  // Click outside to deselect
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (isActive && isSelected && !target.closest('.shape-action-btn')) {
        // Only deselect if not clicking action buttons
        // setIsSelected(false); // Keep selected while editing?
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [isActive, isSelected]);

  return (
    <div
      className={`absolute ${isSelected ? 'border-2 border-blue-500 z-50' : (shape.text ? '' : 'border-2 border-black z-10')} ${isActive ? 'cursor-move' : 'pointer-events-none'}`}
      style={{
        left: displayShape.x,
        top: displayShape.y,
        width: displayShape.width,
        height: displayShape.height,
        boxSizing: 'border-box',
        pointerEvents: isActive ? 'auto' : 'none',
        touchAction: 'none',
        userSelect: 'none'
      }}
      onPointerDown={(e) => handlePointerDown(e, 'body')}
      onClick={(e) => e.stopPropagation()}
    >
      {shape.text ? (
        <div
          className="w-full h-full flex items-center justify-center font-sans text-bw-black"
          style={{ fontSize: shape.fontSize || 20 }}
        >
          {shape.text}
        </div>
      ) : null}

      {isSelected && isActive && (
        <>
          {!shape.text && (
            <>
              <div className="absolute top-0 left-0 w-full h-3 -mt-1.5 cursor-ns-resize" onPointerDown={(e) => handlePointerDown(e, 'top')} />
              <div className="absolute bottom-0 left-0 w-full h-3 -mb-1.5 cursor-ns-resize" onPointerDown={(e) => handlePointerDown(e, 'bottom')} />
              <div className="absolute top-0 left-0 w-3 h-full -ml-1.5 cursor-ew-resize" onPointerDown={(e) => handlePointerDown(e, 'left')} />
              <div className="absolute top-0 right-0 w-3 h-full -mr-1.5 cursor-ew-resize" onPointerDown={(e) => handlePointerDown(e, 'right')} />
            </>
          )}

          {/* Action Buttons: 2pt Padding below the bottom line */}
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-[calc(100%+2px)] flex z-[60] shape-action-btn">
            <button
              onClick={(e) => { e.stopPropagation(); confirmChange(); }}
              className="flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
              title="Confirm"
            >
              <Check size={24} className="text-blue-500 stroke-[3]" />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const TransformableImage = ({
  layer,
  updateTransform,
  isActive
}: {
  layer: Layer;
  updateTransform: (id: string, transform: LayerTransform) => void;
  isActive: boolean;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const transform = layer.transform || { x: 0, y: 0, scale: 1, rotation: 0 };

  const interactionRef = useRef({
    type: 'none',
    startX: 0, startY: 0,
    initX: 0, initY: 0,
    initScale: 1, initRotation: 0,
    initDistance: 0, initAngle: 0
  });

  const handlePointerDown = (e: React.PointerEvent, type: string) => {
    if (!isActive) return;
    e.stopPropagation();
    interactionRef.current = {
      ...interactionRef.current,
      type,
      startX: e.clientX,
      startY: e.clientY,
      initX: transform.x,
      initY: transform.y,
      initScale: transform.scale,
      initRotation: transform.rotation,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const { type, startX, startY, initX, initY, initScale, initRotation } = interactionRef.current;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (type === 'drag') {
        updateTransform(layer.id, { ...transform, x: initX + dx, y: initY + dy });
      } else if (type === 'resize') {
        const scaleDelta = (dx + dy) * 0.005;
        updateTransform(layer.id, { ...transform, scale: Math.max(0.1, initScale + scaleDelta) });
      } else if (type === 'rotate') {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const startAngle = Math.atan2(startY - centerY, startX - centerX);
          const currentAngle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
          const angleDelta = (currentAngle - startAngle) * (180 / Math.PI);
          updateTransform(layer.id, { ...transform, rotation: initRotation + angleDelta });
        }
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      interactionRef.current.type = 'none';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isActive) return;
    if (e.touches.length === 2) {
      e.stopPropagation();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dx = t2.clientX - t1.clientX;
      const dy = t2.clientY - t1.clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);

      interactionRef.current = {
        ...interactionRef.current,
        type: 'pinch',
        initX: transform.x, initY: transform.y,
        initScale: transform.scale, initRotation: transform.rotation,
        initDistance: distance, initAngle: angle,
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isActive) return;
    if (e.touches.length === 2 && interactionRef.current.type === 'pinch') {
      e.stopPropagation();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dx = t2.clientX - t1.clientX;
      const dy = t2.clientY - t1.clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);

      const { initScale, initRotation, initDistance, initAngle } = interactionRef.current;

      const scaleDelta = distance / initDistance;
      const angleDelta = angle - initAngle;

      updateTransform(layer.id, {
        ...transform,
        scale: Math.max(0.1, initScale * scaleDelta),
        rotation: initRotation + angleDelta
      });
    }
  };

  if (!layer.image) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden"
    >
      <div
        className={`relative ${isActive ? 'pointer-events-auto' : 'pointer-events-none'}`}
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
          touchAction: 'none'
        }}
        onPointerDown={(e) => handlePointerDown(e, 'drag')}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
      >
        <img src={layer.image} className="max-w-full max-h-full object-contain select-none" draggable={false} />

        {isActive && (
          <>
            <div className="absolute inset-0 border border-bw-black pointer-events-none"></div>

            <div className="absolute -top-2 -left-2 w-4 h-4 bg-bw-white border border-bw-black cursor-nwse-resize pointer-events-auto" onPointerDown={(e) => handlePointerDown(e, 'resize')}></div>
            <div className="absolute -top-2 -right-2 w-4 h-4 bg-bw-white border border-bw-black cursor-nesw-resize pointer-events-auto" onPointerDown={(e) => handlePointerDown(e, 'resize')}></div>
            <div className="absolute -bottom-2 -left-2 w-4 h-4 bg-bw-white border border-bw-black cursor-nesw-resize pointer-events-auto" onPointerDown={(e) => handlePointerDown(e, 'resize')}></div>
            <div className="absolute -bottom-2 -right-2 w-4 h-4 bg-bw-white border border-bw-black cursor-nwse-resize pointer-events-auto" onPointerDown={(e) => handlePointerDown(e, 'resize')}></div>

            <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-bw-white border border-bw-black flex items-center justify-center cursor-grab pointer-events-auto" onPointerDown={(e) => handlePointerDown(e, 'rotate')}>
              <RefreshCw size={12} className="text-bw-black" />
            </div>
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-px h-4 bg-bw-black pointer-events-none"></div>
          </>
        )}
      </div>
    </div>
  );
};
