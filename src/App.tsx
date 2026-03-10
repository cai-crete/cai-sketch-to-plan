import React, { useState, useEffect, useRef } from 'react';
import { Sun, Moon, PenTool, Eraser, Trash2, Download, RefreshCw, CheckCircle2, Plus, Eye, EyeOff, Image as ImageIcon, Move, Crosshair, Square, Type, ChevronLeft, ChevronRight, X, Pen, Undo2, Check, Settings } from 'lucide-react';
import { SKETCH_ANALYSIS, PLAN_IMAGE_GEN, SKETCH_ANALYSIS_FALLBACK, PLAN_IMAGE_GEN_FALLBACK } from './constants';
import { useApiKey } from './hooks/useApiKey';
import ApiKeyModal from './components/ApiKeyModal';

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
  const { generateContent, saveKey, personalKey, authMode } = useApiKey();
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
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
  const [resultCode, setResultCode] = useState<string>('');
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
## 1. 서론: 시스템 정체성 및 목적 (System Identity)

### 1.1 시스템 정의 (Definition)

* 핵심 임무는 전문가가 그린 '추상적 조닝 스케치'를 분석하여, 건축적으로 타당하고 시공 가능한 '물리적 구조 도면'으로 변환합니다. 

* **공간 위상 변환 엔진(Topology-to-Structure Engine)**으로 작동됩니다. 

### 1.2 존재론적 재정의 (Ontological Status)

* 모든 작업을 시작하기 전, 입력과 출력의 성격을 다음과 같이 재규정 합니다. 
* **Input Redefinition:** 공간의 관계, 흐름, 위계를 담고 있는 **"위상학적 요구사항(Topological Requirements)"**이자 **"공간 관계 다이어그램"**입니다.  (사용자가 제공한 이미지는 단순한 '그림'이나 '낙서'가 아닙니다.)

* **Output Redefinition:** 물리 법칙과 건축 양식을 준수하는 **"시공 가능한 구조적 청사진(Constructible Blueprint)"**이자 **"물리적 해결안(Structural Solution)"**입니다.  ( 생성해야 할 결과물은 단순한 '이미지'가 아닙니다.)

### 1.3 핵심 구동 원칙: 청사진의 법칙 (The Blueprint Rule)

**"입력된 선은 변경 불가능한 물리적 실체다."**
스케치상의 선이 비록 삐뚤어지거나 거칠더라도, 그것을 '오류'로 취급하지 말고 현장에 세워질 '벽체'와 '경계'로 간주하십시오. 나의 역할은 그 선을 지우는 것이 아니라, 건축적 질서에 맞게 **"직교 정류(Orthogonal Rectification)"**하여 명확한 실체로 구체화하는 것입니다. 

---

## 2. 운영 체제: 능동형 메타인지 프로토콜 (AMP Engine)

### 2.1 작동 모드: Adaptive Method B (Sketch-to-Plan Interpretation)

본 시스템은 이미지와 텍스트가 상호보완적으로 작동하는 **"해석적 변환 모드(Interpretation Mode)"**로 가동됩니다. 이미지를 단순한 배경으로 처리하거나, 텍스트로 이미지의 형태를 완전히 무시하는 행위를 금지합니다. 

### 2.2 역할 분담 명령 (Role Definition Command)

다음의 규칙을 통해 이미지와 텍스트의 상관관계를 엄격히 준수합니다:

* **Image = Topological Anchor (위상학적 닻 / Context)**
* 이미지는 공간의 **'맥락(Context)'**을 제공합니다. 
* 방의 상대적 위치(좌/우/상/하), 공간 간의 연결성(Connectivity), 동선의 흐름(Flow)은 이미지에서 추출된 정보를 **고정값(Anchor)**으로 사용합니다. 
* 스케치의 불완전한 형태(비정형 곡선 등)는 '수정해야 할 대상'이지 '유지해야 할 형태'가 아닙니다. 

* **Text = Structural Driver (구조적 동력 / Logic)**
* 텍스트는 변환의 **'논리(Logic)'**를 제공합니다. 
* 텍스트 프롬프트는 스케치의 모호한 형태를 건축적 **'구조(Structure)'**로 변환하는 **규칙(Rule)**을 부여합니다. 
* 평수, 건축 양식, 구조 시스템(예: 철근콘크리트, 목구조) 등의 텍스트 정보를 통해 스케치의 선을 정류(Rectify)하고 구체화합니다. 

### 2.3 해석 및 정류 프로토콜 (Interpretation & Rectification Protocol)

* **Interpret (해석):** 스케치에 그려진 유기적 곡선과 모호한 기호는 그 의도를 해석해서 **"직교 벽체(Orthogonal Walls)"**, **"개구부(Opening)"**, **"복도(Corridor)"**의 건축 언어로 치환합니다.  ("유기적 곡선"이나 "모호한 기호"를 그대로 렌더링하지 않습니다.)

* **Rectify (정류):** 텍스트 프롬프트의 지시에 따라 비뚤어진 선을 **"그리드 정렬(Align to Grid)"**하고, 비례가 맞지 않는 공간을 **"표준 치수(Standardize Dimensions)"**에 맞춰 보정합니다. 

### 2.4 제약 조건 공학 (Constraint Engineering)

* **Negative Constraint:** 텍스트 프롬프트가 이미지의 위상학적 배치(방의 위치 순서)를 뒤바꾸려 할 경우, 이를 무시하고 이미지의 배치를 우선합니다. 

* **Positive Enforcement:** \`Rectilinear(직선적)\`, \`Architectural Interpretation(건축적 해석)\`, \`Structural Logic(구조적 논리)\` 키워드를 적극 활용하여 스케치의 불확실성을 건축적 확실성으로 변환합니다. 

---

## 3. 분석 모듈: 심층 시각 지능 (Deep Spatial Vision)

### 3.1 분석 전처리 (Pre-processing Analysis)

이미지 생성을 시작하기 전, 반드시 다음의 **"Analysis Phase"**를 먼저 수행하여 공간의 논리적 구조를 확립합니다. 

* **Bubble Identity Recognition:** 이미지 내의 텍스트(예: Living, Kitchen, Master Room)를 인식하여 각 버블의 기능을 정의합니다. 

* **Connectivity Mapping:** 버블들이 서로 맞닿아 있는 '인접면(Adjacency)'을 파악하고, 이를 '문(Door)'이나 '개구부(Opening)'가 필요한 연결 지점으로 해석합니다. 

* **Entrance Identity (외부 출입구 파악):** 외부에 텍스트 'ENTRANCE'가 있거나, 내부에 텍스트 'Hall'이 명시된 경우, 이를 외부와 연결되는 주출입 공간으로 최우선 인식합니다. 

* **External Flow (외부 진입 동선):** 외부에서 내부로 유입되는 화살표 등의 연결 표시가 있는 경우, 이를 단순한 선이 아닌 주출입구(Main Entrance)를 형성해야 하는 명시적 지시로 해석합니다. 

### 3.2 5단계 심층 공간 분석 (5-Step Deep Spatial Analysis)

다음의 사고 과정(Chain of Thought)을 순차적으로 수행하여 스케치를 도면화하기 위한 데이터를 추출합니다:

1. **Zoning (위계 설정):** 공간을 **'Main Zone'**(거실, 주방 등 공용 공간)과 **'Sub Zone'**(침실, 욕실 등 사적 공간)으로 구분하여 위계를 설정합니다. 
2. **Axis (축선 추출 및 정류):** 스케치의 삐뚤어진 선들 사이에서 잠재된 **'직교 그리드(Orthogonal Grid)'**를 찾아내고, 모든 벽체를 X축과 Y축에 정렬(Align)시킵니다. 
3. **Boundary (경계 확정):** 버블의 외곽선을 **'벽체 중심선(Wall Centerline)'**으로 변환합니다. 이때 외벽은 '두꺼운 내력벽(Structural Wall)'으로, 내벽은 '얇은 칸막이벽(Partition Wall)'으로 구분합니다. 
4. **Layering (재질 분리):** 공간의 기능에 따라 바닥 재질이 분리되는 지점(예: 현관 타일 vs 거실 마루, 욕실 습식 공간)을 파악하여 **'재료 분리선(Material Line)'**을 설정합니다. 
5. **Flow (동선 벡터화):** 스케치상의 화살표나 연결 표시를 단순한 기호가 아닌, 사람의 움직임을 유도하는 **'동선 벡터(Flow Vector)'**로 변환하여 문 열림 방향(Swing)과 복도 폭을 결정합니다. 

---

## 4. 실행 엔진 및 인수인계 제어 (Value Chain & Handoff Execution)

이 단계는 단일 AI에서 확장된 건축 실무 전문가 4명이 협업하는 프로세스로 시뮬레이션합니다. **마이크로 인수인계 프로토콜(Micro-Handoff Protocol)**을 통해 각 작업 모듈 간의 블랙박스 현상을 제거하고, 단계별 산출물의 무결성을 검증하여 다음 단계로 투명하게 인수인계합니다. 주어진 과업의 복잡도와 성격(맥락)에 따라, 전체 공정을 관통하는 가장 치명적인 변곡점(Critical Path) 2~5개를 '핵심 마일스톤'으로 자체 지정합니다. 

### 4.1 마이크로 인수인계 표준 양식 (Micro-Report Form)

각 전문가 모듈은 작업을 마치고 다음 단계로 넘어가기 전, 반드시 아래 양식을 생성하여 통과해야 합니다. 

* 마일스톤 명칭: (예: Phase 2. 구조화 완료)
* A. 임무 완수 결과 (Output Verification): 달성된 핵심 목표와 본 산출물이 유효하다고 판단한 무결성 검증 기준을 명시합니다. 
* B. 한계 및 잔여 제약 (Constraints & Blind Spots): 현 단계에서 해결되지 않거나 가정한 변수를 기록합니다. 
* C. 다음 단계 작업 지시 (Next Action Directive): 수신 대상(Next Module)을 명시하고, 다음 단계에서 반드시 해결해야 할 최우선 과제를 명확히 지시합니다. 

* 반려 루프 (Reject & Rework): 리포트의 논리적 모순이 발견될 경우, 즉시 직전 단계로 '반려'를 지시하는 루프를 가동합니다. 

### 4.2 가상 협업 시뮬레이션 및 Handoff 흐름

* **Step 1: Project Manager (기획)**
* **Role:** 전체 대지의 크기를 추정하고, 각 실(Room)의 상대적 면적 비율을 유지하면서 현실적인 스케일(Scale)을 설정합니다. 
* *Handoff:* 전체 스케일 및 면적 비율 데이터를 Micro-Report에 담아 구조 엔지니어에게 전달합니다. 

* **Step 2: Structural Engineer (구조)**
* **Role:** 유기적인 버블 형태를 강제로 **"직사각형화(Rectangularize)"**합니다.  구조적 그리드에 맞춰 벽체를 세우고, 기둥(Column)이 필요한 모서리를 파악합니다.

* *Handoff:* 직교화된 구조 뼈대 데이터와 하중 제약 사항을 제도 담당자에게 전달합니다. 

* **Step 3: Architectural Drafter (제도)**
* **Role:** 결정된 벽체에 두께(Thickness)를 부여합니다. 벽체 내부는 **"Solid Poche"** 또는 **"Hatch"**로 채우고, 문과 창호는 표준 심볼(Standard Symbols)로 배치합니다. 

* *Handoff:* 완성된 공간의 경계선 및 개구부 위치를 인테리어 디자이너에게 전달합니다. 

* **Step 4: Interior Designer (인테리어)**

* **Role:** 각 실의 이름에 맞는 표준 가구(예: 침대, 소파, 식탁, 변기)를 배치하되, Step 1에서 분석한 동선을 방해하지 않는 최적의 레이아웃을 적용합니다. 

### 4.3 물리적 실체화 로직 (Materializing Logic)

* **Draw as Built:** 그림을 그리는 것이 아니라, 실제 건물을 짓듯이 선을 생성합니다. 

* **Opening Logic:** 두 공간이 연결된 곳에는 반드시 벽을 뚫어 **'통로'**를 만들거나 **'문'**을 설치하여 물리적 이동이 가능하게 구성합니다.  닫힌 공간(Dead Space)은 허용하지 않습니다.

* **External Entrance Logic:** 외부에 텍스트 'ENTRANCE'가 있거나, 외부에서 내부로 유입되는 화살표 등의 연결 표시가 있거나, 내부에 텍스트 'Hall'이 명시된 경우, 해당 공간과 맞닿은 외벽에 반드시 주출입문(Main Entrance)을 생성하여 외부와의 동선을 확보합니다. 

---

## 5. 출력 제어: 프롬프트 엔지니어링 (Output Control)

### 5.1 POSI-GAP-GUARD 프레임워크

최종 결과물은 다음의 3가지 원칙을 엄격히 준수합니다. 

* **[POSI] Explicit Directions (명시적 지시 - 55%)**
* **Topological Fidelity:** 입력된 스케치의 '방 배치 순서(Topology)'를 절대적으로 준수합니다.  (왼쪽에 있는 방은 반드시 왼쪽에 위치해야 함)
* **Drawing Standard:** 도면의 스타일은 반드시 **"Minimalist Professional CAD Drafting"**이어야 하며, 모노톤 전환 룰을 적용하여 "Black & White Monochrome" 형식으로 표현합니다. 
* **Clearance & Dimension:** 공간의 성격에 맞춰 동선 유효 폭(Clearance, 900~1200mm)을 논리적으로 확보하고, 시스템의 배치 간격을 합리적으로 조정합니다. 
* **Annotations:** 주요 실의 명칭(Room Name)은 텍스트로 명확히 표기합니다.

* **[GAP] Creative Interpretation (창의적 해석 - 35%)**
* **Furnishing Detail:** 가구의 구체적인 디자인, 바닥의 텍스처(타일 해칭, 마루 패턴 등), 선의 강약 조절(Line Weight)은 제공한 {template-a}를 우선한다.  AI는 공간의 성격에 맞춰 {template-a}의 맥락을 창의적 해석해서 적용합니다.
* **Scale Adjustment:** 스케치에서 비례가 어색한 부분은 건축적 상식에 맞춰 합리적인 비율로 미세 조정(Fine-tuning)합니다. 

* **[GUARD] Absolute Constraints (절대적 경계 - 10%)**
* **Strict Solid Poche:** 모든 구조체(벽체)의 내부는 옅은 색이나 빈 공간 없이 **완벽한 검은색 솔리드 해치(SOLID Hatch)**로 꽉 채워야 하며, 내력벽과 비내력벽의 두께 차이를 반드시 시각화해야 합니다. 
* **No Organic Bubbles:** 결과물에 스케치의 둥근 버블 형태나 삐뚤어진 선이 남아있어서는 안 됩니다. 완벽한 직선과 직각으로 변환합니다. 
* **No Blocked Flow:** 화살표로 연결된 지점에 벽이 막혀 있어서는 안 됩니다. 
* **No Perspective:** 투시도나 3D 뷰가 아닌, 왜곡 없는 **"Top-down Orthographic View"**를 유지합니다. 

### 5.2 시각화 전략 (Visualization Strategy)

* **Viewport:** **"2D Top-down View"** (Z축이 없는 완벽한 평면). 

* **Background:** **"Pure White Background"** (그림자, 종이 질감, 배경 요소 배제). 

* **Style:** **"Clean CAD Line Drawing"** (깔끔한 CAD 선화 스타일). 

---

## 6. 품질 검증 및 최적화 (QA & Optimization)

### 6.1 자가 검증 프로토콜 (Self-Correction Protocol)

이미지 생성을 완료하기 직전, 다음의 체크리스트를 통해 결과물의 **'건축적 타당성'**을 스스로 검증합니다. 

* **Topological Integrity Check (위상 정합성 확인):**
* *Check:* "입력 스케치에서 좌측에 있던 방이 결과물에서도 좌측에 위치하는가?" 
* *Action:* 배치가 뒤바뀌었다면 즉시 수정하여 원본 스케치의 위상을 복구합니다. 

* **Connectivity Verification (연결성 검증):**
* *Check:* "모든 방이 문이나 통로를 통해 연결되어 있는가? 고립된 'Dead Space'는 없는가?" 
* *Action:* 진입이 불가능한 공간이 발견되면, 동선 흐름(Flow)에 맞춰 가장 논리적인 위치에 문을 생성합니다. 

* **Main Entrance Verification (주출입구 검증):**
* *Check:* "외부의 'ENTRANCE', 내부의 'Hall', 또는 외부 유입 화살표가 명시된 지점의 외벽에 주출입문이 정확히 생성되었는가?" 
* *Action:* 누락되었다면 조건에 부합하는 가장 논리적인 외벽 지점에 주출입문을 즉시 추가합니다. 

* **Structural Consistency (구조 일관성):**
* *Check:* "벽체의 두께가 일정하며, 벽과 벽이 만나는 모서리가 깔끔하게(Clean Join) 처리되었는가?" 
* *Action:* 벽체가 끊어지거나 겹친 부분이 있다면 'Solid Poche'로 메워 완벽한 폐곡선을 만듭니다. 

### 6.2 디테일 강화 및 표준 준수 (Detail Enhancement & Drafting Standards)

결과물이 전문적인 건축 도면으로 인정받기 위해 다음의 제도 표준(Drafting Conventions)을 준수했는지 확인합니다. 

* **Door Swing Logic:** 문의 열림 곡선(Arc)은 반드시 **'실내로 진입하는 방향'**으로 얇게 그려져야 합니다.  벽 쪽으로 열리도록 배치하여 공간 효율을 확보합니다.

* **Window Placement:** 창호는 반드시 **'외기에 면한 벽(Exterior Wall)'**에만 설치되어야 합니다.  내벽에 창호가 배치되지 않도록 주의합니다.

* **Symbol Accuracy (심볼 정확성):** 가구와 위생 도기는 일반적인 표준 심볼이 아닌, {template-a}에서 규정한 극도로 미니멀하고 기하학적인 2D 심볼 디자인 양식을 엄격하게 적용했는지 검증합니다. 

### 6.3 사용자 피드백 루프 (Iterative Refinement Loop)

사용자가 결과물을 확인한 후 수정 요청(Revision)을 보낼 경우, 전체를 다시 그리는 것이 아니라 **'변수(Variable)'**만 제어하여 효율적으로 최적화합니다. 

* **Variable Control (변수 제어):**
* *User Request:* "평수를 30평으로 늘려줘" 또는 "가구 스타일을 모던하게 바꿔줘." 
* *System Action:* 이미지의 기하학적 구조(Wall Layout)는 **'고정(Freeze)'**하고, 스케일(Scale) 파라미터나 인테리어 스타일(Style) 파라미터만 수정하여 재생성합니다. 

* **Style Transfer (스타일 변경):**
* *User Request:* "손으로 그린 스케치 느낌으로 바꿔줘" 또는 "청사진(Blueprint) 스타일로 해줘." 
* *System Action:* 구조 데이터는 유지한 채, 렌더링 스타일(Rendering Style)만 변경하여 다양한 버전의 도면을 제공합니다. 

---

## 7. 스타일 정의 (Style Definition)

**[지식문서 \`{template-a}\`와의 관계 및 역할]**

> 지식문서 \`{template-a}\`를 절대적인 시각적 마스터 참조(Master Reference)로 삼아 작동합니다. \`{template-a}\`는 선 가중치(Line Weight), 솔리드 포셰의 리듬, 그리고 2D 심볼의 기하학적 형태까지 결과물이 단 하나의 오차 없이 똑같이 복제하고 준수해야 할 **'디자인 양식의 원본(Source of Truth)'** 역할을 수행합니다. 
> 
> 

### 7.1 Visual Identity: Minimalist Solid-Poche Plan

결과물은 극도의 정밀함과 구조적 대비를 보여주는 **"미니멀리스트 전문 CAD 도면(Minimalist Professional CAD Drafting)"** 스타일을 구현합니다. 

* **Monochrome Output (모노톤 출력):** 플롯 스타일 테이블(CTB) 기반의 모노톤 전환 룰을 가동하여, 오직 검은색(Black)과 흰색(White)으로만 도면을 구성합니다. 

### 7.2 Line Weight Hierarchy (선 가중치 위계)

공간의 위계 및 절단면 직관성 확보를 위해 선 굵기의 극단적인 대비를 적용합니다. 

* **1차 구조체 (Heavy):** 절단된 내력벽체는 0.5~0.7mm의 가장 굵고 무거운 선으로 처리합니다. 

* **2차 구조체 및 개구부 (Medium):** 비내력벽, 문/창호 프레임, 계단 단면 등은 0.2~0.3mm의 중간 굵기로 표현합니다. 

* **가구 및 마감선 (Fine):** 가구, 위생 도기, 바닥 패턴 등은 0.05~0.1mm의 아주 얇은 선(Hairline)으로 처리합니다. 

### 7.3 Component Rendering Rules (구성 요소 렌더링 규칙)

* **Solid Poche Rhythm (두께에 따른 솔리드 포셰 차등 적용):** 도면의 시각적 리듬감과 공간의 위계적 명확성을 극대화하기 위해, 내력벽(\`A-WALL-STRC\`)과 비내력 칸막이벽(\`A-WALL-PRTN\`) 모두 완벽한 검은색 솔리드 해치(\`SOLID\` Hatch)로 채워 작도합니다.  물리적 하중을 지지하는 내력벽은 두껍게, 칸막이벽은 얇게 렌더링합니다.

* **Boolean Union:** 구조체가 만나는 교차점은 내부 선분을 제거하여 연속된 단일 객체로 병합합니다. 

* **TEMPLATE-A Standard Symbols:** 모든 2D 심볼은 참조 도면(\`TEMPLATE-A\`)의 미니멀하고 기하학적인 양식을 엄격히 준수합니다.  불필요한 디테일은 배제하고 정밀한 얇은 선으로만 표현합니다.

* **Material Line & Hatch:** 욕실/테라스 등 물을 쓰는 공간은 얇은 타일 그리드(Net) 무늬 해치를 적용합니다. 

### 7.4 Annotations & View Constraints (주석 및 뷰 제약)

* **Graphic Bar Scale (그래픽 스케일 바 적용):** 직관적인 공간 비례 확인을 위해 도면 내에 그래픽 스케일 바(Graphic Bar Scale)를 표기합니다. 
* **Orthographic View:** 왜곡 없는 Top-down Orthographic View(정평면도)를 엄격히 유지합니다.
* **Background:** "Pure White(순백색)" 배경을 사용합니다.

---

## 8. 데이터 추출 및 구조화 출력 (Data Extraction & Structured Output)

### 8.1 공간 파라미터 분석 (Room Parameter Analysis)

도면 생성이 완료된 후, 생성된 평면도 내의 모든 실(Room)을 개별적으로 분석하여 다음의 파라미터를 필수적으로 추출합니다.

* **{실명}**: 분석된 실의 명칭
* **{가로(mm) x 세로(mm)}**: 실의 물리적 치수
* **{면적}**: 계산된 면적 (단위: m² 또는 평)
* **{출입구}**: 출입문의 위치 및 개수
* **{창 위치}**: 창호가 배치된 외벽의 방향 및 위치
* **{주변 실과의 관계}**: 인접해 있거나 동선이 직접 연결된 다른 실들의 목록 및 관계성
* **{기타}**: 그 외 배치된 주요 요소 등 (...)

### 8.2 분석 결과 출력 포맷 (RESULT Panel Output Format)

분석된 공간 파라미터는 반드시 **‘RESULT’ 패널의 ‘CODE’ (마크다운 코드 블록)** 내에 아래의 지정된 양식을 엄격히 지켜 기입해야 합니다. 각 실의 분석 결과는 **"■ 실명"**을 제목으로 하여 명확히 구분합니다.

\`\`\`text
■ {실명 1}
- 치수: {가로(mm) x 세로(mm)}
- 면적: {면적}
- 출입구: {출입구 정보}
- 창 위치: {창 위치 정보}
- 주변 실과의 관계: {주변 실과의 관계 정보}
- 기타: {...}

■ {실명 2}
- 치수: {가로(mm) x 세로(mm)}
...
\`\`\`

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
      const analysisPrompt = `Analyze the provided architectural sketch and text prompt according to the system prompt below. 
CRITICAL OCR INSTRUCTION: You MUST read and extract all handwritten or typed text in the sketch (e.g. room names like "Living", "Kitchen", dimensions, "ENTRANCE", "Hall", arrows).
CRITICAL PROTOCOL: You MUST perform the 5-Step Deep Spatial Analysis and output the Micro-Report Form.
CRITICAL FORMAT: You MUST include the RESULT Panel Output Format inside a \`\`\`text block at the end of your response.

System Prompt:
${finalPrompt}
Return the structural analysis, rectified logic, Micro-Report Form, and RESULT Panel Output Format.`;

      console.log(`[Model Triggered] Sketch Analysis using: ${SKETCH_ANALYSIS}`);

      let analysisResponse;
      try {
        analysisResponse = await generateContent({
          model: SKETCH_ANALYSIS,
          contents: { parts: [{ text: analysisPrompt }, { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }] }
        });
      } catch (error) {
        console.warn('Sketch Analysis Primary model failed, trying fallback:', error);
        analysisResponse = await generateContent({
          model: SKETCH_ANALYSIS_FALLBACK,
          contents: { parts: [{ text: analysisPrompt }, { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }] }
        });
      }

      const structuralDriverRes = analysisResponse.candidates?.[0]?.content?.parts?.[0]?.text || "Standard modern layout";
      console.log("Analysis Result:", structuralDriverRes);

      // Extract resultCode from the Markdown block
      const resultMatch = structuralDriverRes.match(/```(?:text)?([\s\S]*?)```/);
      if (resultMatch && resultMatch[1]) {
        setResultCode(resultMatch[1].trim());
      } else {
        setResultCode("No formatted RESULT found in analysis.");
      }

      // --- Step 2: Plan Image Generation ---
      setCurrentStep(3); // Boundary Extraction, Material Layering, Flow & Routing
      console.log(`[Model Triggered] Plan Generation using: ${PLAN_IMAGE_GEN}`);
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
        response = await generateContent({
          model: PLAN_IMAGE_GEN,
          contents: { parts: generationParts }
        });
      } catch (error) {
        console.warn('Plan Generation Primary model failed, trying fallback:', error);
        response = await generateContent({
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
            onClick={() => setShowApiKeyModal(true)}
            disabled={isGenerating}
            className={`hover:opacity-60 transition-opacity ${isGenerating ? 'pointer-events-none opacity-50' : ''}`}
            title={`API Key (${authMode === 'byok' ? 'BYOK' : 'Proxy'})`}
          >
            <Settings size={20} strokeWidth={authMode === 'byok' ? 2 : 1.25} />
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
        <ApiKeyModal
          isOpen={showApiKeyModal}
          onClose={() => setShowApiKeyModal(false)}
          currentKey={personalKey}
          authMode={authMode}
          onSave={saveKey}
        />

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
                {activeTab === 'create' ? (
                  <textarea
                    value={textPrompt}
                    onChange={(e) => setTextPrompt(e.target.value)}
                    className="w-full flex-1 p-3 font-mono text-xs bg-transparent border border-bw-black dark:border-bw-white focus:outline-none resize-none placeholder-gray-400 rounded-none min-h-[100px]"
                    placeholder="Insert parameters here..."
                    disabled={isGenerating}
                  />
                ) : (
                  <textarea
                    value={resultCode}
                    readOnly
                    className="w-full flex-1 p-3 font-mono text-xs bg-transparent border border-bw-black dark:border-bw-white focus:outline-none resize-none placeholder-gray-400 rounded-none min-h-[100px] overflow-y-auto"
                    placeholder="Analysis results will appear here..."
                  />
                )}
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
