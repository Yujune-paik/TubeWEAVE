'use client';

import { useEffect, useRef, useState } from "react";

/**
 * TubeDropDisplay-MVP
 * Single-file React + Canvas scaffold for:
 *  - Spline (one-stroke) path editing on a 2D canvas
 *  - Image/Text import to define target picture
 *  - 1D sampling of the image along the path (arc-length parameterization)
 *  - Drop schedule synthesis (PWM / AM / 1-bit Dither)
 *  - 2D preview rendering of droplets along the path
 *  - 1D timeline view of target vs. synthesized signal
 *  - JSON/CSV export of the drop schedule
 *
 * Tailwind for styling. No external chart/UI libs.
 * Default export is a React component that should render in ChatGPT Canvas preview.
 */

// ---------- Utility ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Physical unit conversion functions
const mmToPx = (mm, mmPerPixel) => mm / mmPerPixel;
const pxToMm = (px, mmPerPixel) => px * mmPerPixel;

function catmullRom(p0, p1, p2, p3, t) {
  // Catmull-Rom with tension=0.5 (centripetal variant would need different parameterization)
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      ((2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      ((2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function sampleCatmullRom(points, samplesPerSegment = 20) {
  if (points.length < 2) return points.slice();
  const n = points.length;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? points[0] : points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i + 2 < n ? points[i + 2] : points[n - 1];
    for (let j = 0; j < samplesPerSegment; j++) {
      const t = j / samplesPerSegment;
      out.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

function resampleUniform(pts, stepPx = 2) {
  if (pts.length === 0) return [];
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    let t = stepPx - acc;
    while (t <= segLen) {
      const u = t / segLen;
      out.push({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) });
      t += stepPx;
    }
    acc = (segLen + acc) % stepPx;
  }
  return out;
}

function grayscaleAt(imageData, x, y) {
  const { width, data } = imageData;
  const xi = Math.floor(clamp(x, 0, width - 1));
  const yi = Math.floor(clamp(y, 0, imageData.height - 1));
  const idx = (yi * width + xi) * 4;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  // normalized [0,1], perceptual grayscale
  const gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return gray;
}

function drawCircle(ctx, x, y, r, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function toCSV(rows, header) {
  const esc = (s) => `"${String(s).replaceAll('"', '""')}"`;
  const lines = [];
  if (header) lines.push(header.map(esc).join(","));
  for (const row of rows) lines.push(row.map(esc).join(","));
  return lines.join("\n");
}

// Resize handle rendering function
function drawResizeHandles(ctx, obj) {
  const handleSize = 8;
  const handles = [
    { id: 'nw', x: obj.x - handleSize/2, y: obj.y - handleSize/2 },
    { id: 'ne', x: obj.x + obj.width - handleSize/2, y: obj.y - handleSize/2 },
    { id: 'sw', x: obj.x - handleSize/2, y: obj.y + obj.height - handleSize/2 },
    { id: 'se', x: obj.x + obj.width - handleSize/2, y: obj.y + obj.height - handleSize/2 },
    { id: 'n', x: obj.x + obj.width/2 - handleSize/2, y: obj.y - handleSize/2 },
    { id: 's', x: obj.x + obj.width/2 - handleSize/2, y: obj.y + obj.height - handleSize/2 },
    { id: 'e', x: obj.x + obj.width - handleSize/2, y: obj.y + obj.height/2 - handleSize/2 },
    { id: 'w', x: obj.x - handleSize/2, y: obj.y + obj.height/2 - handleSize/2 }
  ];

  handles.forEach(handle => {
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(handle.x, handle.y, handleSize, handleSize);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(handle.x, handle.y, handleSize, handleSize);
  });
}

// Content object rendering functions
function drawContentObject(ctx, obj, isSelected = false, editingTextId = null) {
  ctx.save();

  // Apply rotation if any
  if (obj.rotation) {
    ctx.translate(obj.x + obj.width / 2, obj.y + obj.height / 2);
    ctx.rotate((obj.rotation * Math.PI) / 180);
    ctx.translate(-(obj.x + obj.width / 2), -(obj.y + obj.height / 2));
  }

  switch (obj.type) {
    case 'text':
      ctx.fillStyle = obj.color || '#000000';
      ctx.font = `${obj.fontWeight || 'normal'} ${obj.fontSize || 24}px ${obj.fontFamily || 'Inter'}, ui-sans-serif, system-ui`;
      ctx.textAlign = obj.textAlign || 'center';
      ctx.textBaseline = 'middle';

      // Calculate text position based on alignment
      const textX = obj.x + obj.width / 2;
      const textY = obj.y + obj.height / 2;

      // Draw text with editing indicator
      if (obj.id === editingTextId) {
        // Draw editing background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fillRect(obj.x - 2, obj.y - 2, obj.width + 4, obj.height + 4);

        // Draw text with cursor
        ctx.fillStyle = obj.color || '#000000';
        ctx.fillText(obj.text || '', textX, textY);

        // Draw cursor
        const textWidth = ctx.measureText(obj.text || '').width;
        ctx.fillStyle = obj.color || '#000000';
        const cursorX = obj.textAlign === 'left' ? obj.x + textWidth :
                       obj.textAlign === 'right' ? obj.x + obj.width - textWidth :
                       textX + textWidth / 2;
        ctx.fillRect(cursorX, textY - (obj.fontSize || 24) / 2, 1, obj.fontSize || 24);
      } else {
        ctx.fillText(obj.text || '', textX, textY);
      }
      break;

    case 'rectangle':
      // Use grayscale value for both fill and stroke
      const rectGray = obj.grayscaleValue !== undefined ? obj.grayscaleValue : 0;
      const rectColor = `rgb(${Math.round(255 * rectGray)}, ${Math.round(255 * rectGray)}, ${Math.round(255 * rectGray)})`;

      ctx.fillStyle = rectColor;
      ctx.fillRect(obj.x, obj.y, obj.width, obj.height);

      ctx.strokeStyle = rectColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
      break;

    case 'circle':
      // Use grayscale value for both fill and stroke
      const circleGray = obj.grayscaleValue !== undefined ? obj.grayscaleValue : 0;
      const circleColor = `rgb(${Math.round(255 * circleGray)}, ${Math.round(255 * circleGray)}, ${Math.round(255 * circleGray)})`;

      ctx.fillStyle = circleColor;
      ctx.beginPath();
      ctx.arc(obj.x + obj.width / 2, obj.y + obj.height / 2, Math.min(obj.width, obj.height) / 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = circleColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(obj.x + obj.width / 2, obj.y + obj.height / 2, Math.min(obj.width, obj.height) / 2, 0, Math.PI * 2);
      ctx.stroke();
      break;

    case 'line':
      // Use black color for line
      const lineColor = '#000000';

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = obj.strokeWidth || 2;
      if (obj.lineDash) {
        ctx.setLineDash(obj.lineDash);
      }

      const startX = obj.startX !== undefined ? obj.startX : obj.x;
      const startY = obj.startY !== undefined ? obj.startY : obj.y;
      const endX = obj.endX !== undefined ? obj.endX : obj.x + obj.width;
      const endY = obj.endY !== undefined ? obj.endY : obj.y + obj.height;

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      // Lines don't have arrows - only draw the line

      ctx.setLineDash([]);
      break;

    case 'arrow':
      // Use black color for arrow
      const arrowColor = '#000000';

      ctx.strokeStyle = arrowColor;
      ctx.lineWidth = obj.strokeWidth || 2;
      if (obj.lineDash) {
        ctx.setLineDash(obj.lineDash);
      }

      const arrowStartX = obj.startX !== undefined ? obj.startX : obj.x;
      const arrowStartY = obj.startY !== undefined ? obj.startY : obj.y;
      const arrowEndX = obj.endX !== undefined ? obj.endX : obj.x + obj.width;
      const arrowEndY = obj.endY !== undefined ? obj.endY : obj.y + obj.height;

      // Draw arrow line
      ctx.beginPath();
      ctx.moveTo(arrowStartX, arrowStartY);
      ctx.lineTo(arrowEndX, arrowEndY);
      ctx.stroke();

      // Draw arrow head
      const angle = Math.atan2(arrowEndY - arrowStartY, arrowEndX - arrowStartX);
      const arrowLength = 10;
      const arrowAngle = Math.PI / 6; // 30 degrees

      ctx.fillStyle = arrowColor;
      ctx.beginPath();
      ctx.moveTo(arrowEndX, arrowEndY);
      ctx.lineTo(
        arrowEndX - arrowLength * Math.cos(angle - arrowAngle),
        arrowEndY - arrowLength * Math.sin(angle - arrowAngle)
      );
      ctx.lineTo(
        arrowEndX - arrowLength * Math.cos(angle + arrowAngle),
        arrowEndY - arrowLength * Math.sin(angle + arrowAngle)
      );
      ctx.closePath();
      ctx.fill();

      ctx.setLineDash([]);
      break;
  }

  // Draw selection outline
  if (isSelected) {
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(obj.x - 2, obj.y - 2, obj.width + 4, obj.height + 4);
    ctx.setLineDash([]);
  }

  ctx.restore();
}

// Pattern area rendering function
function drawPatternArea(ctx, area, isSelected = false) {
  ctx.save();

  // Draw area outline
  ctx.strokeStyle = isSelected ? '#3b82f6' : '#ffffff';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(area.x, area.y, area.width, area.height);
  ctx.setLineDash([]);

  // Draw area label
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${area.patternType}`, area.x + 5, area.y + 5);

  ctx.restore();
}

// Pattern generation functions
function generateZigzagPattern(startPoint, endPoint, params) {
  const { topFolds, bottomFolds, tubeWidth } = params;
  const points = [];

  const startX = startPoint.x;
  const startY = startPoint.y;
  const endX = endPoint.x;
  const endY = endPoint.y;
  const width = endX - startX;
  const height = endY - startY;

  // Calculate fold positions
  const topFoldPositions = [];
  const bottomFoldPositions = [];

  for (let i = 0; i <= topFolds; i++) {
    topFoldPositions.push(startX + (width * i) / topFolds);
  }

  for (let i = 0; i <= bottomFolds; i++) {
    bottomFoldPositions.push(startX + (width * i) / bottomFolds);
  }

  // Generate zigzag path: alternate between top and bottom fold positions
  let currentY = startY;
  let goingDown = true;
  let topIndex = 0;
  let bottomIndex = 0;
  let stepCount = 0;
  const maxSteps = 1000; // Safety limit

  while (currentY <= endY && stepCount < maxSteps) {
    if (goingDown) {
      // Going from top to bottom
      const x = topFoldPositions[topIndex % topFoldPositions.length];
      points.push({ x, y: currentY });

      // Move down by tube width
      currentY += tubeWidth;
      if (currentY >= endY) {
        points.push({ x, y: endY });
        break;
      }

      // Switch to going up
      goingDown = false;
      topIndex++;
    } else {
      // Going from bottom to top
      const x = bottomFoldPositions[bottomIndex % bottomFoldPositions.length];
      points.push({ x, y: currentY });

      // Move down by tube width
      currentY += tubeWidth;
      if (currentY >= endY) {
        points.push({ x, y: endY });
        break;
      }

      // Switch to going down
      goingDown = true;
      bottomIndex++;
    }
    stepCount++;
  }

  return points;
}

function generateParallelPattern(startPoint, endPoint, params) {
  const { topFolds, tubeWidth } = params; // Use topFolds as the fold count
  const points = [];

  const startX = startPoint.x;
  const startY = startPoint.y;
  const endX = endPoint.x;
  const endY = endPoint.y;
  const width = endX - startX;
  const height = endY - startY;

  // Calculate control points Z1-Z10 based on fold count
  const foldCount = topFolds; // Use topFolds as the number of folds
  const totalPoints = foldCount * 2; // Double the fold count for alternating points

  // Generate control points along X-axis
  for (let i = 0; i <= totalPoints; i++) {
    const x = startX + (width * i) / totalPoints;

    // Alternate between startY and endY
    const y = (i % 2 === 0) ? startY : endY;

    points.push({ x, y });
  }

  return points;
}

function generateWavePattern(startPoint, endPoint, params) {
  const { spacing, amplitude, frequency } = params;
  const points = [];

  const startX = startPoint.x;
  const startY = startPoint.y;
  const endX = endPoint.x;
  const endY = endPoint.y;
  const width = endX - startX;
  const height = endY - startY;
  const numLines = Math.floor(height / spacing);

  for (let i = 0; i < numLines; i++) {
    const lineY = startY + i * spacing;

    // Use adaptive step size for smoother curves
    const stepSize = Math.max(1, width / 100);
    for (let j = 0; j <= width; j += stepSize) {
      const waveX = startX + j;
      const waveY = lineY + Math.sin(j * frequency) * amplitude;
      if (waveY >= startY && waveY <= endY) {
        points.push({ x: waveX, y: waveY });
      }
    }
    // Ensure we always have the end point
    if (width > 0) {
      const endWaveY = lineY + Math.sin(width * frequency) * amplitude;
      if (endWaveY >= startY && endWaveY <= endY) {
        points.push({ x: endX, y: endWaveY });
      }
    }
  }

  return points;
}

function generatePatternPoints(patternType, startPoint, endPoint, params) {
  switch (patternType) {
    case 'zigzag':
      return generateZigzagPattern(startPoint, endPoint, params);
    case 'parallel':
      return generateParallelPattern(startPoint, endPoint, params);
    case 'wave':
      return generateWavePattern(startPoint, endPoint, params);
    default:
      return [];
  }
}

// ---------- Main Component ----------
export default function TubeDropDisplayMVP() {
  // Prevent hydration mismatch by only rendering on client
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  // Canvas & sizes
  const mainCanvasRef = useRef(null);
  const offscreenRef = useRef(null); // offscreen for image/text
  const tubeVisualizationRef = useRef(null); // for tube visualization

  const [canvasW, setCanvasW] = useState(900);
  const [canvasH, setCanvasH] = useState(600);

  // Path editing
  const [points, setPoints] = useState([]);
  const [dragIdx, setDragIdx] = useState(-1);
  const [hoverIdx, setHoverIdx] = useState(-1);

  // Image/Text target
  const [imgObj, setImgObj] = useState(null);
  const [imgData, setImgData] = useState(null); // ImageData for sampling
  const [useText, setUseText] = useState(true);
  const [textInput, setTextInput] = useState("");
  const [textSize, setTextSize] = useState(160);

  // View modes: 'content' (edit content), 'path' (edit path), 'display' (view only)
  const [viewMode, setViewMode] = useState('content');

  // Content editing parameters
  const [contentBrightness, setContentBrightness] = useState(1.0); // 0.0 (black) to 2.0 (white)
  const [contentContrast, setContentContrast] = useState(1.0); // 0.5 to 2.0
  const [contentPosition, setContentPosition] = useState({ x: 0, y: 0 }); // Offset from center

  // Content objects system (PowerPoint-like)
  const [contentObjects, setContentObjects] = useState([]);
  const [selectedObjectId, setSelectedObjectId] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [toolMode, setToolMode] = useState('select'); // 'select', 'text', 'rectangle', 'circle', 'line'
  const [resizeHandle, setResizeHandle] = useState(null); // 'nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [editingTextId, setEditingTextId] = useState(null); // ID of text object being edited inline
  const [lineDrawing, setLineDrawing] = useState(null); // { startX, startY, endX, endY } or null for line drawing
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 }); // Current mouse position for line preview

  // Pattern system
  const [patternMode, setPatternMode] = useState(false); // Enable pattern mode
  const [selectedPatternType, setSelectedPatternType] = useState('zigzag'); // 'zigzag', 'parallel', 'wave'
  const [patternStartPoint, setPatternStartPoint] = useState(null); // { x, y } or null
  const [patternEndPoint, setPatternEndPoint] = useState(null); // { x, y } or null
  const [patternParams, setPatternParams] = useState({
    topFolds: 5, // Number of folds at the top
    bottomFolds: 5, // Number of folds at the bottom
    tubeWidth: 4, // Smaller tube width for smoother curves
    spacing: 8, // Smaller spacing for more points
    amplitude: 20,
    frequency: 0.1
  });

  // Physical pattern parameters (in mm)
  const [physicalPatternParams, setPhysicalPatternParams] = useState({
    tubeSpacingMm: 2.0,    // Spacing between tube lines in mm
    amplitudeMm: 4.0,      // Wave amplitude in mm
    frequencyPerMm: 0.1,   // Wave frequency per mm
  });

  // Physical unit settings (Illustrator-like) - moved up to avoid initialization order issues
  const [physicalUnits, setPhysicalUnits] = useState({
    canvasWidthMm: 180,    // Canvas width in mm (900px * 0.2mm/px)
    canvasHeightMm: 120,   // Canvas height in mm (600px * 0.2mm/px)
    tubeDiameterMm: 0.5,   // Tube inner diameter in mm
    tubeWallThicknessMm: 0.1, // Tube wall thickness in mm
    contentScaleMm: 1.0,   // Content scale factor (1.0 = 100%)
  });

  // Rendering params
  const [mode, setMode] = useState("PWM"); // PWM | AM | DITHER
  const [mmPerPixel, setMmPerPixel] = useState(0.2); // physical scale
  const [feedSpeed, setFeedSpeed] = useState(80); // mm/s
  const [minSpacingMm, setMinSpacingMm] = useState(0.3);
  const [widthMinMm, setWidthMinMm] = useState(0.2);
  const [widthMaxMm, setWidthMaxMm] = useState(1.0);
  const [sigmaMm, setSigmaMm] = useState(0.25);
  const [sampleStepPx, setSampleStepPx] = useState(2);
  const [threshold, setThreshold] = useState(0.5); // for dithering/2bit
  const [tubeVisualizationScale, setTubeVisualizationScale] = useState(1); // scale for tube visualization

  // Update canvas size when physical units change
  useEffect(() => {
    const newCanvasW = Math.round(mmToPx(physicalUnits.canvasWidthMm, mmPerPixel));
    const newCanvasH = Math.round(mmToPx(physicalUnits.canvasHeightMm, mmPerPixel));
    setCanvasW(newCanvasW);
    setCanvasH(newCanvasH);
  }, [physicalUnits.canvasWidthMm, physicalUnits.canvasHeightMm, mmPerPixel]);

  // Derived
  const minSpacingPx = minSpacingMm / mmPerPixel;
  const widthMinPx = widthMinMm / mmPerPixel;
  const widthMaxPx = widthMaxMm / mmPerPixel;

  // Signals & drops
  const [fSignal, setFSignal] = useState([]); // target along s
  const [gSignal, setGSignal] = useState([]); // synthesized signal (normalized)
  const [dropSchedule, setDropSchedule] = useState([]); // array of {s_px, s_mm, t_ms, width_mm, amplitude}
  const [resampledPath, setResampledPath] = useState([]);

  // ----------------- Image/Text drawing to offscreen -----------------
  useEffect(() => {
    // Prepare an offscreen canvas to hold the target image/text
    const canvas = offscreenRef.current;
    if (!canvas) return;
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    // Clear white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw content objects (PowerPoint-like system)
    contentObjects.forEach(obj => {
      drawContentObject(ctx, obj, false, null);
    });

    // Legacy support for text/image (if no objects exist)
    if (contentObjects.length === 0) {
      if (useText) {
        // Draw text centered in black (will be converted to grayscale)
        ctx.fillStyle = "#000000";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `${textSize}px Inter, ui-sans-serif, system-ui`;

        // Apply position offset
        const centerX = canvas.width / 2 + contentPosition.x;
        const centerY = canvas.height / 2 + contentPosition.y;
        ctx.fillText(textInput, centerX, centerY);
      } else if (imgObj) {
        const { width, height } = imgObj;
        // Fit image into canvas keeping aspect
        const scale = Math.min(canvas.width / width, canvas.height / height);
        const w = width * scale;
        const h = height * scale;

        // Apply position offset
        const x = (canvas.width - w) / 2 + contentPosition.x;
        const y = (canvas.height - h) / 2 + contentPosition.y;
        ctx.drawImage(imgObj, x, y, w, h);
      }
    }

    // Convert to grayscale for droplet intensity calculation
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Convert to grayscale with brightness and contrast adjustment
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;

      // Apply contrast and brightness
      let adjustedGray = gray;
      adjustedGray = (adjustedGray - 128) * contentContrast + 128; // Apply contrast
      adjustedGray = adjustedGray * contentBrightness; // Apply brightness
      adjustedGray = Math.max(0, Math.min(255, adjustedGray)); // Clamp to valid range

      data[i] = adjustedGray;     // Red
      data[i + 1] = adjustedGray; // Green
      data[i + 2] = adjustedGray; // Blue
      // Alpha channel remains unchanged
    }

    ctx.putImageData(imageData, 0, 0);
    setImgData(imageData);

    // Debug logging
    console.log('imgData regenerated:', {
      contentObjectsLength: contentObjects.length,
      canvasW,
      canvasH,
      imageDataWidth: imageData.width,
      imageDataHeight: imageData.height
    });
  }, [useText, textInput, textSize, imgObj, canvasW, canvasH, contentPosition, contentBrightness, contentContrast, contentObjects]);

  // ----------------- Path sampling & signal synthesis -----------------
  const recompute = () => {
    console.log('recompute called:', {
      hasImgData: !!imgData,
      pointsLength: points.length,
      contentObjectsLength: contentObjects.length
    });

    if (!imgData || points.length < 2) {
      // Clear signals and drops when no content or path
      console.log('recompute: clearing signals - no imgData or points');
      setFSignal([]);
      setGSignal([]);
      setDropSchedule([]);
      setResampledPath([]);
      return;
    }

    // 1) Smooth sample along Catmull-Rom, then resample uniformly
    const smooth = sampleCatmullRom(points, 24);
    const uniform = resampleUniform(smooth, Math.max(1, sampleStepPx));
    setResampledPath(uniform);

    // 2) Sample image along path -> intensity in [0,1], where 1 means "ink"
    // Convert image grayscale: intensity = 1 - gray
    const f = uniform.map((p) => 1 - grayscaleAt(imgData, p.x, p.y));

    // 3) Synthesize droplets according to mode
    let drops = [];
    let g = new Array(f.length).fill(0);

    const stepPx = Math.max(minSpacingPx, sampleStepPx);
    const stepIdx = Math.max(1, Math.round(stepPx / sampleStepPx));

    if (mode === "PWM") {
      const widthRangePx = Math.max(0, widthMaxPx - widthMinPx);
      for (let i = 0; i < f.length; i += stepIdx) {
        const v = clamp(f[i], 0, 1);
        const wpx = widthMinPx + v * widthRangePx;
        const wmm = wpx * mmPerPixel;
        const s_px = i * sampleStepPx;
        const s_mm = s_px * mmPerPixel;
        const t_ms = (s_mm / feedSpeed) * 1000;
        drops.push({ s_px, s_mm, t_ms, width_mm: wmm, amplitude: 1.0 });
        g[i] = widthRangePx > 0 ? (wpx - widthMinPx) / widthRangePx : 0;
      }
    } else if (mode === "AM") {
      const w0mm = 0.5 * (widthMinMm + widthMaxMm);
      for (let i = 0; i < f.length; i += stepIdx) {
        const v = clamp(f[i], 0, 1);
        const s_px = i * sampleStepPx;
        const s_mm = s_px * mmPerPixel;
        const t_ms = (s_mm / feedSpeed) * 1000;
        drops.push({ s_px, s_mm, t_ms, width_mm: w0mm, amplitude: v });
        g[i] = v;
      }
    } else if (mode === "DITHER") {
      // 1D Floyd–Steinberg style error diffusion to next 4 samples
      const fCopy = f.slice();
      const weights = [7 / 16, 5 / 16, 3 / 16, 1 / 16];
      const w0mm = 0.5 * (widthMinMm + widthMaxMm);
      for (let i = 0; i < fCopy.length; i++) {
        const v = clamp(fCopy[i], 0, 1);
        const out = v >= threshold ? 1 : 0;
        const err = v - out;
        g[i] = out;
        for (let k = 1; k <= 4; k++) {
          if (i + k < fCopy.length) fCopy[i + k] += err * weights[k - 1];
        }
        // Place droplets sparsely by stepIdx
        if (i % stepIdx === 0 && out > 0) {
          const s_px = i * sampleStepPx;
          const s_mm = s_px * mmPerPixel;
          const t_ms = (s_mm / feedSpeed) * 1000;
          drops.push({ s_px, s_mm, t_ms, width_mm: w0mm, amplitude: 1.0 });
        }
      }
    }

    setFSignal(f);
    setGSignal(g);
    setDropSchedule(drops);

    console.log('recompute completed:', {
      fSignalLength: f.length,
      gSignalLength: g.length,
      dropScheduleLength: drops.length,
      resampledPathLength: uniform.length
    });
  };

  // ----------------- Drawing: main preview -----------------
  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Clear with background color
    ctx.fillStyle = "#1a1a1a"; // dark background
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Draw target image as grayscale background
    if (offscreenRef.current) {
      ctx.save();
      ctx.globalAlpha = 0.4; // More transparent background
      ctx.drawImage(offscreenRef.current, 0, 0, canvasW, canvasH);
      ctx.restore();
    }

    // Draw tube as hollow structure with blue fill only where it overlaps with content
    // Use the same points array that includes both manual and pattern points
    if (points.length >= 2) {
      // Use the same resolution as manual points
      const smooth = sampleCatmullRom(points, 24);
      const tubeWidth = mmToPx(physicalUnits.tubeDiameterMm, mmPerPixel); // Tube width in pixels

      if (smooth.length > 1) {
        // Calculate perpendicular vectors for tube edges
        const tubeEdges = [];
        for (let i = 0; i < smooth.length; i++) {
          let dx, dy;
          if (i === 0) {
            // First point: use direction to next point
            dx = smooth[i + 1].x - smooth[i].x;
            dy = smooth[i + 1].y - smooth[i].y;
          } else if (i === smooth.length - 1) {
            // Last point: use direction from previous point
            dx = smooth[i].x - smooth[i - 1].x;
            dy = smooth[i].y - smooth[i - 1].y;
          } else {
            // Middle points: use average direction
            dx = smooth[i + 1].x - smooth[i - 1].x;
            dy = smooth[i + 1].y - smooth[i - 1].y;
          }

          // Normalize and get perpendicular vector
          const length = Math.sqrt(dx * dx + dy * dy);
          if (length > 0) {
            const perpX = (-dy / length) * tubeWidth / 2;
            const perpY = (dx / length) * tubeWidth / 2;

            tubeEdges.push({
              top: { x: smooth[i].x + perpX, y: smooth[i].y + perpY },
              bottom: { x: smooth[i].x - perpX, y: smooth[i].y - perpY },
              center: { x: smooth[i].x, y: smooth[i].y }
            });
          }
        }

        // Draw tube outline (hollow)
        ctx.strokeStyle = "#ffffff"; // white tube outline
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tubeEdges[0].top.x, tubeEdges[0].top.y);
        for (let i = 1; i < tubeEdges.length; i++) {
          ctx.lineTo(tubeEdges[i].top.x, tubeEdges[i].top.y);
        }
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(tubeEdges[0].bottom.x, tubeEdges[0].bottom.y);
        for (let i = 1; i < tubeEdges.length; i++) {
          ctx.lineTo(tubeEdges[i].bottom.x, tubeEdges[i].bottom.y);
        }
        ctx.stroke();

        // Draw droplets where tube overlaps with content
        if (offscreenRef.current && imgData) {
          const imageData = imgData;
          const data = imageData.data;

          // Sample points along the tube centerline with higher density
          const samplePoints = [];
          for (let i = 0; i < tubeEdges.length; i++) {
            const center = tubeEdges[i].center;
            samplePoints.push(center);

            // Add intermediate points for higher droplet density
            if (i < tubeEdges.length - 1) {
              const nextCenter = tubeEdges[i + 1].center;
              const midX = (center.x + nextCenter.x) / 2;
              const midY = (center.y + nextCenter.y) / 2;
              samplePoints.push({ x: midX, y: midY });
            }
          }

          // Draw droplets at points where tube overlaps with content
          for (let i = 0; i < samplePoints.length; i++) {
            const point = samplePoints[i];
            const x = Math.floor(point.x);
            const y = Math.floor(point.y);

            // Check if point is within canvas bounds
            if (x >= 0 && x < canvasW && y >= 0 && y < canvasH) {
              const pixelIndex = (y * canvasW + x) * 4;
              const r = data[pixelIndex];
              const g = data[pixelIndex + 1];
              const b = data[pixelIndex + 2];
              const a = data[pixelIndex + 3];

              // Calculate intensity (grayscale value)
              const intensity = (r + g + b) / 3;

               // Only draw droplet if there's content (not white background)
               if (intensity < 240) { // Threshold to detect content vs background
                 // Calculate droplet density based on intensity (darker = more droplets)
                 const density = (255 - intensity) / 255; // 0 (white) to 1 (black)

                 // Skip some droplets based on density to create sparse/dense effect
                 const shouldDraw = Math.random() < density;

                 if (shouldDraw) {
                   const dropletSize = 4; // Fixed size for consistent appearance
                   const alpha = 0.8; // Fixed alpha for consistent appearance

                   ctx.save();

                   // Draw droplet with vibrant blue color
                   ctx.fillStyle = `rgba(0, 191, 255, ${alpha})`; // bright cyan blue
                   ctx.beginPath();
                   ctx.arc(point.x, point.y, dropletSize, 0, Math.PI * 2);
                   ctx.fill();

                   // Add inner highlight
                   ctx.fillStyle = `rgba(135, 206, 250, ${alpha * 0.7})`; // light blue highlight
                   ctx.beginPath();
                   ctx.arc(point.x, point.y, dropletSize * 0.6, 0, Math.PI * 2);
                   ctx.fill();

                   // Add subtle glow effect
                   ctx.shadowColor = `rgba(0, 191, 255, ${alpha * 0.4})`;
                   ctx.shadowBlur = dropletSize * 1.2;
                   ctx.fillStyle = `rgba(0, 191, 255, ${alpha * 0.3})`;
                   ctx.beginPath();
                   ctx.arc(point.x, point.y, dropletSize * 1.1, 0, Math.PI * 2);
                   ctx.fill();

                   ctx.restore();
                 }
               }
            }
          }
        }
      }
    }

    // Droplets are now represented by the blue fill in the tube where it overlaps with content

    // Draw content objects (only in content mode)
    if (viewMode === 'content') {
      contentObjects.forEach(obj => {
        drawContentObject(ctx, obj, obj.id === selectedObjectId, editingTextId);
      });

      // Draw line/arrow preview while drawing
      if (lineDrawing && (toolMode === 'line' || toolMode === 'arrow')) {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(lineDrawing.startX, lineDrawing.startY);
        ctx.lineTo(lineDrawing.endX, lineDrawing.endY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw arrow preview if arrow tool
        if (toolMode === 'arrow') {
          const angle = Math.atan2(lineDrawing.endY - lineDrawing.startY, lineDrawing.endX - lineDrawing.startX);
          const arrowLength = 10;
          const arrowAngle = Math.PI / 6; // 30 degrees

          ctx.fillStyle = '#3b82f6';
          ctx.beginPath();
          ctx.moveTo(lineDrawing.endX, lineDrawing.endY);
          ctx.lineTo(
            lineDrawing.endX - arrowLength * Math.cos(angle - arrowAngle),
            lineDrawing.endY - arrowLength * Math.sin(angle - arrowAngle)
          );
          ctx.lineTo(
            lineDrawing.endX - arrowLength * Math.cos(angle + arrowAngle),
            lineDrawing.endY - arrowLength * Math.sin(angle + arrowAngle)
          );
          ctx.closePath();
          ctx.fill();
        }
      }

      // Draw resize handles for selected object
      if (selectedObjectId) {
        const selectedObj = contentObjects.find(obj => obj.id === selectedObjectId);
        if (selectedObj) {
          drawResizeHandles(ctx, selectedObj);
        }
      }
    }

    // Draw pattern points and generated paths (only in path mode)
    if (viewMode === 'path') {
      // Draw pattern start/end points
      if (patternMode) {
        if (patternStartPoint) {
          ctx.fillStyle = "#10b981"; // emerald-500
          drawCircle(ctx, patternStartPoint.x, patternStartPoint.y, 8, 1);
          ctx.fillStyle = "#ffffff";
          ctx.font = "12px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("START", patternStartPoint.x, patternStartPoint.y - 15);
        }

        if (patternEndPoint) {
          ctx.fillStyle = "#ef4444"; // red-500
          drawCircle(ctx, patternEndPoint.x, patternEndPoint.y, 8, 1);
          ctx.fillStyle = "#ffffff";
          ctx.font = "12px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("END", patternEndPoint.x, patternEndPoint.y - 15);
        }

        // Draw connection line between start and end points
        if (patternStartPoint && patternEndPoint) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(patternStartPoint.x, patternStartPoint.y);
          ctx.lineTo(patternEndPoint.x, patternEndPoint.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Pattern control points are now handled as manual points
      }

      // Draw control points (both manual and pattern points)
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        ctx.fillStyle = i === hoverIdx ? "#ef4444" : "#0ea5e9"; // red-500 : sky-500
        drawCircle(ctx, p.x, p.y, 6, 1);

        // Draw point index for debugging
        if (points.length > 1) {
          ctx.fillStyle = "#ffffff";
          ctx.font = "12px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(i.toString(), p.x, p.y - 12);
        }
      }
    }
  }, [points, resampledPath, dropSchedule, sampleStepPx, mmPerPixel, hoverIdx, canvasW, canvasH, viewMode, contentObjects, selectedObjectId, patternMode, selectedPatternType, patternStartPoint, patternEndPoint, patternParams]);

  // ----------------- Drawing: tube visualization -----------------
  useEffect(() => {
    const canvas = tubeVisualizationRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect) return;

    // Add error handling and validation
    try {
      // Debug logging
      console.log('Tube Visualization render:', {
        pointsLength: points.length,
        resampledPathLength: resampledPath?.length,
        imgDataExists: !!imgData,
        fSignalLength: fSignal?.length,
        gSignalLength: gSignal?.length,
        dropScheduleLength: dropSchedule?.length,
        tubeVisualizationScale: tubeVisualizationScale,
        rectWidth: rect.width,
        rectHeight: rect.height,
        totalLength: points.length >= 2 && resampledPath ? (() => {
          let total = 0;
          for (let i = 1; i < resampledPath.length; i++) {
            const dx = resampledPath[i].x - resampledPath[i - 1].x;
            const dy = resampledPath[i].y - resampledPath[i - 1].y;
            total += Math.sqrt(dx * dx + dy * dy);
          }
          return total;
        })() : 0
      });

      if (points.length >= 2 && resampledPath && resampledPath.length > 0 && imgData && fSignal && gSignal && fSignal.length > 0 && gSignal.length > 0) {
      // Calculate total path length
      let totalLength = 0;
      for (let i = 1; i < resampledPath.length; i++) {
        const dx = resampledPath[i].x - resampledPath[i - 1].x;
        const dy = resampledPath[i].y - resampledPath[i - 1].y;
        totalLength += Math.sqrt(dx * dx + dy * dy);
      }

      // Calculate canvas width based on total length (with some padding)
      const scale = tubeVisualizationScale || 1; // user-adjustable scale with fallback
      const baseWidth = 800; // Fixed base width, independent of parent container
      const canvasWidth = Math.max(baseWidth, totalLength * scale + 100); // minimum width + padding
      const canvasHeight = 120; // fixed height

      // Ensure minimum canvas size
      const minWidth = 400;
      const finalWidth = Math.max(minWidth, canvasWidth);

      canvas.width = finalWidth * dpr;
      canvas.height = canvasHeight * dpr;
      ctx.scale(dpr, dpr);

      // Clear canvas
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, finalWidth, canvasHeight);

      // Draw tube as a straight line
      const tubeHeight = 40;
      const tubeY = canvasHeight / 2;
      const margin = 50;
      const tubeWidth = finalWidth - margin * 2;

      // Draw tube outline
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(margin, tubeY - tubeHeight / 2, tubeWidth, tubeHeight);

      // Draw tube fill
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(margin, tubeY - tubeHeight / 2, tubeWidth, tubeHeight);

      // Draw droplets along the tube synchronized with display result
      if (dropSchedule && dropSchedule.length > 0 && fSignal && gSignal && fSignal.length > 0 && gSignal.length > 0) {
        for (let i = 0; i < dropSchedule.length; i++) {
          const drop = dropSchedule[i];
          if (!drop || typeof drop.s_px !== 'number') continue;

          const x = margin + drop.s_px * scale; // straight mapping by arc-length

          // Find corresponding index on f/g signals with bounds checking
          const sampleIndex = Math.max(0, Math.min(fSignal.length - 1, Math.round(drop.s_px / sampleStepPx)));
          const fVal = (fSignal[sampleIndex] !== undefined) ? fSignal[sampleIndex] : 0; // target density [0,1]
          const gVal = (gSignal[sampleIndex] !== undefined) ? gSignal[sampleIndex] : 0; // synthesized [0,1]

          // Decide visibility by mode
          let visible = false;
          let alpha = 0;
          let size = 0;
          if (mode === "PWM") {
            // PWM: presence when width > min => gVal > 0
            visible = gVal > 0.001;
            alpha = Math.max(0.15, Math.min(1, gVal));
            size = 3 + 3 * gVal;
          } else if (mode === "AM") {
            // AM: amplitude encodes density
            visible = fVal > 0.001;
            alpha = Math.max(0.15, Math.min(1, gVal));
            size = 2 + 4 * gVal;
          } else if (mode === "DITHER") {
            // Dither: only show if quantized on (gVal ~ 1 at some samples)
            visible = gVal >= threshold;
            alpha = visible ? 0.8 : 0;
            size = visible ? 3.5 : 0;
          }

          if (!visible) continue;

          // Clamp sizes
          size = Math.max(1.5, Math.min(6, size));

          // Draw droplet (no glow to avoid filling look)
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "#00bfff";
          ctx.beginPath();
          ctx.arc(x, tubeY, size, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // Draw start and end markers
      ctx.fillStyle = "#10b981"; // green for start
      ctx.beginPath();
      ctx.arc(margin, tubeY, 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ef4444"; // red for end
      const endX = margin + totalLength * scale;
      ctx.beginPath();
      ctx.arc(endX, tubeY, 8, 0, Math.PI * 2);
      ctx.fill();

      // Draw labels
      ctx.fillStyle = "#ffffff";
      ctx.font = "12px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("START", margin, tubeY - 20);
      ctx.fillText("END", endX, tubeY - 20);

      // Draw length indicator
      ctx.fillStyle = "#666666";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(`Length: ${totalLength.toFixed(1)}px`, margin, 20);
      ctx.fillText(`Droplets: ${dropSchedule ? dropSchedule.length : 0}`, margin, 35);
      ctx.fillText(`Canvas: ${finalWidth.toFixed(0)}px wide`, margin, 50);

      // Debug info
      if (dropSchedule && dropSchedule.length > 0) {
        const firstDrop = dropSchedule[0];
        const lastDrop = dropSchedule[dropSchedule.length - 1];
        if (firstDrop && lastDrop && typeof firstDrop.s_px === 'number' && typeof lastDrop.s_px === 'number') {
          ctx.fillText(`First: s=${firstDrop.s_px.toFixed(1)}px, amp=${(firstDrop.amplitude || 0).toFixed(2)}`, margin, 65);
          ctx.fillText(`Last: s=${lastDrop.s_px.toFixed(1)}px, amp=${(lastDrop.amplitude || 0).toFixed(2)}`, margin, 80);
        }
      }
    } else {
      // Show message when no content or path
      const canvasWidth = 800; // Fixed width, independent of parent container
      const canvasHeight = 120;

      canvas.width = canvasWidth * dpr;
      canvas.height = canvasHeight * dpr;
      ctx.scale(dpr, dpr);

      // Clear canvas
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // Draw message
      ctx.fillStyle = "#666666";
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Debug: Log why visualization is not showing
      const reasons = [];
      if (points.length < 2) reasons.push("No path");
      if (!resampledPath || resampledPath.length === 0) reasons.push("No resampled path");
      if (!imgData) reasons.push("No content");
      if (!fSignal || fSignal.length === 0) reasons.push("No fSignal");
      if (!gSignal || gSignal.length === 0) reasons.push("No gSignal");

      console.log('Tube Visualization not showing:', reasons);

      if (!imgData) {
        ctx.fillText("Add content (text/image) to see droplet visualization", canvasWidth / 2, canvasHeight / 2);
      } else if (points.length < 2) {
        ctx.fillText("Add a path to see droplet visualization", canvasWidth / 2, canvasHeight / 2);
      } else if (!fSignal || fSignal.length === 0 || !gSignal || gSignal.length === 0) {
        ctx.fillText("Processing signals...", canvasWidth / 2, canvasHeight / 2);
      } else {
        ctx.fillText("Visualization error - check console", canvasWidth / 2, canvasHeight / 2);
      }
    }
    } catch (error) {
      console.error('Tube Visualization error:', error);
      // Clear canvas and show error message
      const canvasWidth = 800; // Fixed width, independent of parent container
      const canvasHeight = 120;

      canvas.width = canvasWidth * dpr;
      canvas.height = canvasHeight * dpr;
      ctx.scale(dpr, dpr);

      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      ctx.fillStyle = "#ff4444";
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Visualization Error - Please refresh", canvasWidth / 2, canvasHeight / 2);
    }
  }, [points, resampledPath, dropSchedule, tubeVisualizationScale, imgData, fSignal, gSignal, mode, threshold, sampleStepPx]);


  // ----------------- Pointer interactions -----------------
  const hitRadius = 12;

  // Get mouse coordinates relative to canvas (accounting for device pixel ratio)
  const getCanvasCoords = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = canvasW / rect.width;
    const scaleY = canvasH / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  // Helper function to get resize handle at position
  const getResizeHandleAt = (x, y, obj) => {
    const handleSize = 8;
    const handles = [
      { id: 'nw', x: obj.x - handleSize/2, y: obj.y - handleSize/2 },
      { id: 'ne', x: obj.x + obj.width - handleSize/2, y: obj.y - handleSize/2 },
      { id: 'sw', x: obj.x - handleSize/2, y: obj.y + obj.height - handleSize/2 },
      { id: 'se', x: obj.x + obj.width - handleSize/2, y: obj.y + obj.height - handleSize/2 },
      { id: 'n', x: obj.x + obj.width/2 - handleSize/2, y: obj.y - handleSize/2 },
      { id: 's', x: obj.x + obj.width/2 - handleSize/2, y: obj.y + obj.height - handleSize/2 },
      { id: 'e', x: obj.x + obj.width - handleSize/2, y: obj.y + obj.height/2 - handleSize/2 },
      { id: 'w', x: obj.x - handleSize/2, y: obj.y + obj.height/2 - handleSize/2 }
    ];

    for (const handle of handles) {
      if (x >= handle.x && x <= handle.x + handleSize && y >= handle.y && y <= handle.y + handleSize) {
        return handle.id;
      }
    }
    return null;
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);

    if (viewMode === 'content') {
      // Content mode: handle object selection and creation
      if (toolMode === 'select') {
        // SELECT MODE: Only select objects, don't create new ones
        // Check if clicking on resize handle first
        if (selectedObjectId) {
          const selectedObj = contentObjects.find(obj => obj.id === selectedObjectId);
          if (selectedObj) {
            const handle = getResizeHandleAt(x, y, selectedObj);
            if (handle) {
              setResizeHandle(handle);
              setResizeStart({ x: selectedObj.x, y: selectedObj.y, width: selectedObj.width, height: selectedObj.height });
              return;
            }
          }
        }

        // Find clicked object with expanded hit area for edges
        let clickedObject = null;
        const hitMargin = 8; // Extra pixels around objects for easier selection

        for (let i = contentObjects.length - 1; i >= 0; i--) {
          const obj = contentObjects[i];

          // Special handling for lines and arrows
          if (obj.type === 'line' || obj.type === 'arrow') {
            // For lines/arrows, check distance to line
            const startX = obj.startX !== undefined ? obj.startX : obj.x;
            const startY = obj.startY !== undefined ? obj.startY : obj.y;
            const endX = obj.endX !== undefined ? obj.endX : obj.x + obj.width;
            const endY = obj.endY !== undefined ? obj.endY : obj.y + obj.height;

            // Calculate distance from point to line
            const A = x - startX;
            const B = y - startY;
            const C = endX - startX;
            const D = endY - startY;

            const dot = A * C + B * D;
            const lenSq = C * C + D * D;
            let param = -1;
            if (lenSq !== 0) {
              param = dot / lenSq;
            }

            let xx, yy;
            if (param < 0) {
              xx = startX;
              yy = startY;
            } else if (param > 1) {
              xx = endX;
              yy = endY;
            } else {
              xx = startX + param * C;
              yy = startY + param * D;
            }

            const dx = x - xx;
            const dy = y - yy;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance <= hitMargin + 2) { // Extra margin for lines
              clickedObject = obj;
              break;
            }
          } else {
            // For other shapes, check if click is within expanded bounds
            if (x >= obj.x - hitMargin && x <= obj.x + obj.width + hitMargin &&
                y >= obj.y - hitMargin && y <= obj.y + obj.height + hitMargin) {
              clickedObject = obj;
              break;
            }
          }
        }

        if (clickedObject) {
          setSelectedObjectId(clickedObject.id);
          setIsDragging(true);
          setDragOffset({ x: x - clickedObject.x, y: y - clickedObject.y });
        } else {
          setSelectedObjectId(null);
        }
      } else {
        // INSERT MODE: Create new objects
        if (toolMode === 'line' || toolMode === 'arrow') {
          // Start line/arrow drawing with drag
          setLineDrawing({ startX: x, startY: y, endX: x, endY: y });
        } else {
          const newId = `${toolMode}-${Date.now()}`;
          const newObj = {
            id: newId,
            type: toolMode,
            x: x - 50,
            y: y - 25,
            width: 100,
            height: 50,
            text: toolMode === 'text' ? 'Text' : '',
            fontSize: 24,
            color: '#000000',
            fontWeight: 'normal',
            fontFamily: 'Inter',
            textAlign: toolMode === 'text' ? 'center' : 'left',
            fillColor: toolMode === 'text' ? 'transparent' : '#000000',
            fillOpacity: 1,
            grayscaleValue: 0, // 0 = black, 1 = white (default to black)
            lineDash: [],
            rotation: 0
          };

          setContentObjects(prev => [...prev, newObj]);
          setSelectedObjectId(newId); // Select the newly created object
          setToolMode('select'); // Switch back to select mode
        }
      }
    } else if (viewMode === 'path') {
      // Path mode: handle pattern point setting and manual point editing
      if (patternMode) {
        // Pattern point setting mode
        if (!patternStartPoint) {
          setPatternStartPoint({ x, y });
        } else if (!patternEndPoint) {
          setPatternEndPoint({ x, y });
          // Generate pattern points and add to manual points array
          const patternPoints = generatePatternPoints(selectedPatternType, { x, y }, patternStartPoint, patternParams);
          setPoints(prev => [...prev, ...patternPoints]);
        } else {
          // Reset and start over
          setPatternStartPoint({ x, y });
          setPatternEndPoint(null);
          // Clear pattern points from manual points array
          setPoints([]);
        }
      } else {
        // Manual path point editing (works in both manual and pattern mode)
        // find existing point to drag
        let idx = -1;
        for (let i = 0; i < points.length; i++) {
          if (dist({ x, y }, points[i]) <= hitRadius) {
            idx = i;
            break;
          }
        }

        if (idx !== -1) {
          setDragIdx(idx);
        } else {
          // add new point at end
          setPoints((ps) => [...ps, { x, y }]);
        }
      }
    }
  };

  const onPointerMove = (e) => {
    const { x, y } = getCanvasCoords(e);
    setMousePos({ x, y }); // Update mouse position for line preview

    if (viewMode === 'content') {
      // Handle line/arrow drawing
      if (lineDrawing && (toolMode === 'line' || toolMode === 'arrow')) {
        setLineDrawing(prev => ({ ...prev, endX: x, endY: y }));
        return;
      }

      // Content mode: handle object dragging and resizing
      if (resizeHandle && selectedObjectId) {
        // Handle resizing
        const selectedObj = contentObjects.find(obj => obj.id === selectedObjectId);
        if (selectedObj) {
          let newX = resizeStart.x;
          let newY = resizeStart.y;
          let newWidth = resizeStart.width;
          let newHeight = resizeStart.height;

          // Calculate deltas based on the resize handle
          let deltaX, deltaY;
          if (resizeHandle.includes('e')) {
            deltaX = x - (resizeStart.x + resizeStart.width);
          } else if (resizeHandle.includes('w')) {
            deltaX = x - resizeStart.x;
          } else {
            deltaX = 0;
          }

          if (resizeHandle.includes('s')) {
            deltaY = y - (resizeStart.y + resizeStart.height);
          } else if (resizeHandle.includes('n')) {
            deltaY = y - resizeStart.y;
          } else {
            deltaY = 0;
          }

          // Check if Shift key is pressed for maintaining aspect ratio
          const maintainAspectRatio = e.shiftKey;
          const aspectRatio = resizeStart.width / resizeStart.height;

          switch (resizeHandle) {
            case 'nw':
              newX = resizeStart.x + deltaX;
              newY = resizeStart.y + deltaY;
              newWidth = resizeStart.width - deltaX;
              newHeight = resizeStart.height - deltaY;
              if (maintainAspectRatio) {
                const maxDelta = Math.max(Math.abs(deltaX), Math.abs(deltaY));
                newWidth = resizeStart.width - maxDelta * Math.sign(deltaX);
                newHeight = newWidth / aspectRatio;
                newX = resizeStart.x + (resizeStart.width - newWidth);
                newY = resizeStart.y + (resizeStart.height - newHeight);
              }
              break;
            case 'ne':
              newY = resizeStart.y + deltaY;
              newWidth = resizeStart.width + deltaX;
              newHeight = resizeStart.height - deltaY;
              if (maintainAspectRatio) {
                const maxDelta = Math.max(Math.abs(deltaX), Math.abs(deltaY));
                newWidth = resizeStart.width + maxDelta * Math.sign(deltaX);
                newHeight = newWidth / aspectRatio;
                newY = resizeStart.y + (resizeStart.height - newHeight);
              }
              break;
            case 'sw':
              newX = resizeStart.x + deltaX;
              newWidth = resizeStart.width - deltaX;
              newHeight = resizeStart.height + deltaY;
              if (maintainAspectRatio) {
                const maxDelta = Math.max(Math.abs(deltaX), Math.abs(deltaY));
                newWidth = resizeStart.width - maxDelta * Math.sign(deltaX);
                newHeight = newWidth / aspectRatio;
                newX = resizeStart.x + (resizeStart.width - newWidth);
              }
              break;
            case 'se':
              newWidth = resizeStart.width + deltaX;
              newHeight = resizeStart.height + deltaY;
              if (maintainAspectRatio) {
                const maxDelta = Math.max(Math.abs(deltaX), Math.abs(deltaY));
                newWidth = resizeStart.width + maxDelta * Math.sign(deltaX);
                newHeight = newWidth / aspectRatio;
              }
              break;
            case 'n':
              newY = resizeStart.y + deltaY;
              newHeight = resizeStart.height - deltaY;
              if (maintainAspectRatio) {
                newHeight = resizeStart.height - deltaY;
                newWidth = newHeight * aspectRatio;
                newX = resizeStart.x + (resizeStart.width - newWidth) / 2;
              }
              break;
            case 's':
              newHeight = resizeStart.height + deltaY;
              if (maintainAspectRatio) {
                newHeight = resizeStart.height + deltaY;
                newWidth = newHeight * aspectRatio;
                newX = resizeStart.x + (resizeStart.width - newWidth) / 2;
              }
              break;
            case 'e':
              newWidth = resizeStart.width + deltaX;
              if (maintainAspectRatio) {
                newWidth = resizeStart.width + deltaX;
                newHeight = newWidth / aspectRatio;
                newY = resizeStart.y + (resizeStart.height - newHeight) / 2;
              }
              break;
            case 'w':
              newX = resizeStart.x + deltaX;
              newWidth = resizeStart.width - deltaX;
              if (maintainAspectRatio) {
                newWidth = resizeStart.width - deltaX;
                newHeight = newWidth / aspectRatio;
                newX = resizeStart.x + (resizeStart.width - newWidth);
                newY = resizeStart.y + (resizeStart.height - newHeight) / 2;
              }
              break;
          }

          // Ensure minimum size
          newWidth = Math.max(10, newWidth);
          newHeight = Math.max(10, newHeight);

          setContentObjects(prev => prev.map(obj =>
            obj.id === selectedObjectId
              ? { ...obj, x: newX, y: newY, width: newWidth, height: newHeight }
              : obj
          ));
        }
      } else if (isDragging && selectedObjectId) {
        // Handle dragging
        const selectedObj = contentObjects.find(obj => obj.id === selectedObjectId);
        if (selectedObj) {
          setContentObjects(prev => prev.map(obj =>
            obj.id === selectedObjectId
              ? { ...obj, x: x - dragOffset.x, y: y - dragOffset.y }
              : obj
          ));
        }
      }
    } else if (viewMode === 'path') {
      // Path mode: handle pattern area and path point editing
      if (patternMode) {
        // Handle pattern area dragging
        if (isDragging && selectedObjectId) {
          const selectedArea = patternAreas.find(area => area.id === selectedObjectId);
          if (selectedArea) {
            setPatternAreas(prev => prev.map(area =>
              area.id === selectedObjectId
                ? { ...area, x: x - dragOffset.x, y: y - dragOffset.y }
                : area
            ));
          }
        }
      } else {
        // Legacy path point editing
        // Update hover state
        let hidx = -1;
        for (let i = 0; i < points.length; i++) {
          if (dist({ x, y }, points[i]) <= hitRadius) {
            hidx = i;
            break;
          }
        }
        setHoverIdx(hidx);

        // Update drag position
        if (dragIdx !== -1) {
          setPoints((ps) => ps.map((p, i) => (i === dragIdx ? { x, y } : p)));
        }
      }
    }
  };

  const onPointerUp = (e) => {
    e.preventDefault();

    // Complete line/arrow drawing
    if (lineDrawing && (toolMode === 'line' || toolMode === 'arrow')) {
      const newId = `${toolMode}-${Date.now()}`;
      const newObj = {
        id: newId,
        type: toolMode,
        x: Math.min(lineDrawing.startX, lineDrawing.endX),
        y: Math.min(lineDrawing.startY, lineDrawing.endY),
        width: Math.abs(lineDrawing.endX - lineDrawing.startX),
        height: Math.abs(lineDrawing.endY - lineDrawing.startY),
        startX: lineDrawing.startX,
        startY: lineDrawing.startY,
        endX: lineDrawing.endX,
        endY: lineDrawing.endY,
        strokeWidth: 2, // Line width in pixels
        lineDash: []
      };

      setContentObjects(prev => [...prev, newObj]);
      setSelectedObjectId(newId); // Select the newly created line/arrow
      setLineDrawing(null);
      setToolMode('select'); // Switch back to select mode
    }

    setDragIdx(-1);
    setIsDragging(false);
    setResizeHandle(null);
  };

  const onPointerLeave = (e) => {
    setDragIdx(-1);
    setHoverIdx(-1);
    setIsDragging(false);
    setResizeHandle(null);
  };

  const onDoubleClick = (e) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);

    if (viewMode === 'content' && toolMode === 'select') {
      // Find double-clicked object with expanded hit area
      let clickedObject = null;
      const hitMargin = 8; // Extra pixels around objects for easier selection

      for (let i = contentObjects.length - 1; i >= 0; i--) {
        const obj = contentObjects[i];

        // Special handling for lines and arrows
        if (obj.type === 'line' || obj.type === 'arrow') {
          // For lines/arrows, check distance to line
          const startX = obj.startX !== undefined ? obj.startX : obj.x;
          const startY = obj.startY !== undefined ? obj.startY : obj.y;
          const endX = obj.endX !== undefined ? obj.endX : obj.x + obj.width;
          const endY = obj.endY !== undefined ? obj.endY : obj.y + obj.height;

          // Calculate distance from point to line
          const A = x - startX;
          const B = y - startY;
          const C = endX - startX;
          const D = endY - startY;

          const dot = A * C + B * D;
          const lenSq = C * C + D * D;
          let param = -1;
          if (lenSq !== 0) {
            param = dot / lenSq;
          }

          let xx, yy;
          if (param < 0) {
            xx = startX;
            yy = startY;
          } else if (param > 1) {
            xx = endX;
            yy = endY;
          } else {
            xx = startX + param * C;
            yy = startY + param * D;
          }

          const dx = x - xx;
          const dy = y - yy;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance <= hitMargin + 2) { // Extra margin for lines
            clickedObject = obj;
            break;
          }
        } else {
          // For other shapes, check if click is within expanded bounds
          if (x >= obj.x - hitMargin && x <= obj.x + obj.width + hitMargin &&
              y >= obj.y - hitMargin && y <= obj.y + obj.height + hitMargin) {
            clickedObject = obj;
            break;
          }
        }
      }

      // If it's a text object, start inline editing
      if (clickedObject && clickedObject.type === 'text') {
        setEditingTextId(clickedObject.id);
        setSelectedObjectId(clickedObject.id);
      }
    }
  };

  const onContextMenu = (e) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);

    if (viewMode === 'content') {
      // Content mode: delete selected object
      if (selectedObjectId) {
        setContentObjects(prev => prev.filter(obj => obj.id !== selectedObjectId));
        setSelectedObjectId(null);
      }
    } else if (viewMode === 'path') {
      // Path mode: delete pattern area or path point
      if (patternMode && selectedObjectId) {
        setPatternAreas(prev => prev.filter(area => area.id !== selectedObjectId));
        setSelectedObjectId(null);
      } else {
        // Legacy path point deletion
        let best = { i: -1, d: 1e9 };
        for (let i = 0; i < points.length; i++) {
          const di = dist({ x, y }, points[i]);
          if (di < best.d) best = { i, d: di };
        }

        if (best.d <= hitRadius && points.length > 2) {
          setPoints((ps) => ps.filter((_, i) => i !== best.i));
        }
      }
    }
  };

  // ----------------- Export -----------------
  const exportJSON = () => {
    const payload = {
      curve_length_mm: (resampledPath.length * sampleStepPx) * mmPerPixel,
      feed_speed_mm_per_s: feedSpeed,
      drops: dropSchedule.map((d) => ({
        s_mm: Number(d.s_mm.toFixed(3)),
        t_ms: Number(d.t_ms.toFixed(2)),
        width_mm: Number(d.width_mm.toFixed(3)),
        amplitude: Number(d.amplitude.toFixed(3)),
      })),
      constraints: {
        min_spacing_mm: minSpacingMm,
        width_range_mm: [widthMinMm, widthMaxMm],
        diffusion_sigma_mm: sigmaMm,
      },
      mode,
      mm_per_pixel: mmPerPixel,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "drop_schedule.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    const header = ["s_mm", "t_ms", "width_mm", "amplitude"];
    const rows = dropSchedule.map((d) => [
      d.s_mm.toFixed(3),
      d.t_ms.toFixed(2),
      d.width_mm.toFixed(3),
      d.amplitude.toFixed(3),
    ]);
    const csv = toCSV(rows, header);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "drop_schedule.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ----------------- Handlers -----------------
  const onImageLoad = (file) => {
    const img = new Image();
    img.onload = () => setImgObj(img);
    img.src = URL.createObjectURL(file);
  };

  // Keyboard event handler for delete functionality and text editing
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (editingTextId) {
        // Handle text editing
        const editingObj = contentObjects.find(obj => obj.id === editingTextId);
        if (editingObj) {
          if (e.key === 'Enter' || e.key === 'Escape') {
            // Finish editing
            setEditingTextId(null);
          } else if (e.key === 'Backspace') {
            // Delete character
            setContentObjects(prev => prev.map(obj =>
              obj.id === editingTextId
                ? { ...obj, text: obj.text.slice(0, -1) }
                : obj
            ));
          } else if (e.key.length === 1) {
            // Add character
            setContentObjects(prev => prev.map(obj =>
              obj.id === editingTextId
                ? { ...obj, text: obj.text + e.key }
                : obj
            ));
          }
        }
        e.preventDefault();
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (viewMode === 'content' && selectedObjectId) {
          // Delete selected content object
          setContentObjects(prev => prev.filter(obj => obj.id !== selectedObjectId));
          setSelectedObjectId(null);
        } else if (viewMode === 'path' && hoverIdx >= 0 && points.length > 2) {
          // Delete selected path point (works in both manual and pattern mode)
          setPoints(prev => prev.filter((_, i) => i !== hoverIdx));
          setHoverIdx(-1);
        } else if (viewMode === 'path' && patternMode && !hoverIdx) {
          // Reset pattern points when no point is selected
          setPatternStartPoint(null);
          setPatternEndPoint(null);
          setPoints([]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, selectedObjectId, hoverIdx, points.length, patternMode, editingTextId, contentObjects]);

  // Regenerate pattern points when parameters change
  useEffect(() => {
    if (patternMode && patternStartPoint && patternEndPoint) {
      const patternPoints = generatePatternPoints(selectedPatternType, patternStartPoint, patternEndPoint, patternParams);
      setPoints(patternPoints);
    }
  }, [patternMode, selectedPatternType, patternStartPoint, patternEndPoint, patternParams]);

  // Auto recompute when key params change
  useEffect(() => {
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, imgData, mode, mmPerPixel, feedSpeed, minSpacingMm, widthMinMm, widthMaxMm, sampleStepPx, threshold, contentObjects]);

  // Responsive sizing in canvas preview environment
  useEffect(() => {
    // ensure device pixel ratio crispness
    const dpr = window.devicePixelRatio || 1;
    const c = mainCanvasRef.current;
    if (!c) return;

    // Set canvas size
    c.width = Math.floor(canvasW * dpr);
    c.height = Math.floor(canvasH * dpr);
    c.style.width = `${canvasW}px`;
    c.style.height = `${canvasH}px`;

    // Set context transform
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear canvas to prevent artifacts
    ctx.clearRect(0, 0, canvasW, canvasH);
  }, [canvasW, canvasH]);

  // Prevent hydration mismatch by only rendering on client
  if (!isClient) {
    return (
      <div className="w-full min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-white/60">Loading...</div>
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen bg-black text-white relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-black via-gray-900/20 to-black pointer-events-none" />

      <div className="relative max-w-7xl mx-auto p-6 space-y-8">
         <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
           <div className="space-y-2">
             <h1 className="text-4xl lg:text-5xl font-bold tracking-tight bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">
               TubeDrop Display
             </h1>
             <p className="text-white/60 text-lg">Draw 2D with a single tube → Synthesize & visualize 1D droplet schedule</p>
           </div>
           <div className="flex items-center gap-6">
             <div className="flex items-center gap-3">
               <span className="text-white/60 text-sm font-medium">Canvas Size:</span>
               <div className="flex items-center gap-2">
                 <input
                   type="number"
                   className="input-field w-20 text-center"
                   value={physicalUnits.canvasWidthMm}
                   onChange={(e) => setPhysicalUnits(prev => ({
                     ...prev,
                     canvasWidthMm: clamp(parseFloat(e.target.value || "180"), 10, 1000)
                   }))}
                   title="Width (mm)"
                 />
                 <span className="text-white/40">×</span>
                 <input
                   type="number"
                   className="input-field w-20 text-center"
                   value={physicalUnits.canvasHeightMm}
                   onChange={(e) => setPhysicalUnits(prev => ({
                     ...prev,
                     canvasHeightMm: clamp(parseFloat(e.target.value || "120"), 10, 1000)
                   }))}
                   title="Height (mm)"
                 />
                 <span className="text-white/40 text-xs">mm</span>
               </div>
             </div>
             <div className="flex items-center gap-3">
               <span className="text-white/60 text-sm font-medium">Tube Diameter:</span>
               <div className="flex items-center gap-2">
                 <input
                   type="number"
                   step="0.1"
                   className="input-field w-16 text-center"
                   value={physicalUnits.tubeDiameterMm}
                   onChange={(e) => setPhysicalUnits(prev => ({
                     ...prev,
                     tubeDiameterMm: clamp(parseFloat(e.target.value || "0.5"), 0.1, 10)
                   }))}
                   title="Tube Diameter (mm)"
                 />
                 <span className="text-white/40 text-xs">mm</span>
               </div>
             </div>
           </div>
         </header>

        {/* Main Layout */}
        <div className="flex gap-6">
          {/* Left Sidebar - Controls */}
          <div className="w-64 flex-shrink-0 space-y-6">
            <section className="control-panel">
            <h2 className="section-title">
              <div className="w-2 h-2 bg-white/60 rounded-full" />
              Tools & Settings
            </h2>

            {/* Content Editing Controls */}
            {viewMode === 'content' && (
              <div className="space-y-6 mb-6">
                {/* Tool Selection */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-3">Tools</label>
                  <p className="text-xs text-white/50 mb-3">
                    {toolMode === 'select' ? 'Select mode: Click objects to select and edit' :
                     toolMode === 'line' || toolMode === 'arrow' ? 'Insert mode: Drag to draw line/arrow' :
                     'Insert mode: Click to create new object'}
                  </p>
                  <div className="grid grid-cols-6 gap-2">
                    {[
                      { id: 'select', label: 'Select', icon: '↖' },
                      { id: 'text', label: 'Text', icon: 'T' },
                      { id: 'rectangle', label: 'Rect', icon: '▭' },
                      { id: 'circle', label: 'Circle', icon: '○' },
                      { id: 'line', label: 'Line', icon: '—' },
                      { id: 'arrow', label: 'Arrow', icon: '→' }
                    ].map(tool => (
                      <button
                        key={tool.id}
                        onClick={() => {
                          setToolMode(tool.id);
                          if (tool.id === 'select') {
                            // Select mode: clear selection to allow clicking on any object
                            setSelectedObjectId(null);
                          } else {
                            // Insert mode: find and select the first object of this type
                            const firstObjectOfType = contentObjects.find(obj => obj.type === tool.id);
                            if (firstObjectOfType) {
                              setSelectedObjectId(firstObjectOfType.id);
                            } else {
                              // If no object of this type exists, clear selection
                              setSelectedObjectId(null);
                            }
                          }
                        }}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center ${
                          toolMode === tool.id || (tool.id === 'select' && selectedObjectId && contentObjects.find(obj => obj.id === selectedObjectId))
                            ? 'bg-white/20 text-white border border-white/30'
                            : 'bg-black/40 text-white/60 border border-white/10 hover:bg-black/60 hover:text-white/80'
                        }`}
                        title={tool.label}
                      >
                        {tool.icon}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Object Properties */}
                {selectedObjectId && contentObjects.find(obj => obj.id === selectedObjectId) && (
                  <div className="border-t border-white/10 pt-4">
                    <h4 className="text-sm font-medium text-white/80 mb-3">Object Properties</h4>
                    {(() => {
                      const selectedObj = contentObjects.find(obj => obj.id === selectedObjectId);
                      if (!selectedObj) return null;

                      const updateObject = (updates) => {
                        console.log('updateObject called:', updates);
                        setContentObjects(prev => prev.map(obj =>
                          obj.id === selectedObjectId ? { ...obj, ...updates } : obj
                        ));
                      };

                      return (
                        <div className="space-y-4">
                          {/* Text Properties */}
                          {selectedObj.type === 'text' && (
                            <>
                              <div>
                                <label className="block text-xs font-medium text-white/70 mb-1">Text Content</label>
                                <input
                                  type="text"
                                  className="input-field w-full text-sm"
                                  value={selectedObj.text}
                                  onChange={(e) => updateObject({ text: e.target.value })}
                                />
                              </div>
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <label className="block text-xs font-medium text-white/70 mb-1">Font Size</label>
                                  <input
                                    type="number"
                                    className="input-field w-full text-sm"
                                    value={selectedObj.fontSize}
                                    onChange={(e) => updateObject({ fontSize: parseInt(e.target.value) })}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-white/70 mb-1">Font Weight</label>
                                  <select
                                    className="input-field w-full text-sm"
                                    value={selectedObj.fontWeight}
                                    onChange={(e) => updateObject({ fontWeight: e.target.value })}
                                  >
                                    <option value="normal">Normal</option>
                                    <option value="bold">Bold</option>
                                    <option value="lighter">Light</option>
                                  </select>
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-white/70 mb-1">Text Alignment</label>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => updateObject({ textAlign: 'left' })}
                                    className={`px-3 py-1 rounded text-sm ${
                                      selectedObj.textAlign === 'left'
                                        ? 'bg-white/20 text-white'
                                        : 'bg-black/40 text-white/60 hover:bg-black/60'
                                    }`}
                                  >
                                    L
                                  </button>
                                  <button
                                    onClick={() => updateObject({ textAlign: 'center' })}
                                    className={`px-3 py-1 rounded text-sm ${
                                      selectedObj.textAlign === 'center'
                                        ? 'bg-white/20 text-white'
                                        : 'bg-black/40 text-white/60 hover:bg-black/60'
                                    }`}
                                  >
                                    C
                                  </button>
                                  <button
                                    onClick={() => updateObject({ textAlign: 'right' })}
                                    className={`px-3 py-1 rounded text-sm ${
                                      selectedObj.textAlign === 'right'
                                        ? 'bg-white/20 text-white'
                                        : 'bg-black/40 text-white/60 hover:bg-black/60'
                                    }`}
                                  >
                                    R
                                  </button>
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-white/70 mb-1">Text Color</label>
                                <input
                                  type="color"
                                  className="w-full h-8 rounded border border-white/20"
                                  value={selectedObj.color}
                                  onChange={(e) => updateObject({ color: e.target.value })}
                                />
                              </div>
                            </>
                          )}

                          {/* Shape Properties (Rectangle & Circle) */}
                          {(selectedObj.type === 'rectangle' || selectedObj.type === 'circle') && (
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                                Grayscale: {((selectedObj.grayscaleValue || 0) * 100).toFixed(0)}%
                              </label>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={selectedObj.grayscaleValue || 0}
                                onChange={(e) => updateObject({ grayscaleValue: parseFloat(e.target.value) })}
                                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                              />
                              <div className="flex justify-between text-xs text-white/40 mt-1">
                                <span>Black</span>
                                <span>White</span>
                              </div>
                            </div>
                          )}

                          {/* Line Properties */}
                          {selectedObj.type === 'line' && (
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                                Line Width: {selectedObj.strokeWidth || 2}px
                              </label>
                              <input
                                type="range"
                                min={1}
                                max={10}
                                step={1}
                                value={selectedObj.strokeWidth || 2}
                                onChange={(e) => updateObject({ strokeWidth: parseInt(e.target.value) })}
                                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                              />
                            </div>
                          )}

                          {/* Arrow Properties */}
                          {selectedObj.type === 'arrow' && (
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                                Line Width: {selectedObj.strokeWidth || 2}px
                              </label>
                              <input
                                type="range"
                                min={1}
                                max={10}
                                step={1}
                                value={selectedObj.strokeWidth || 2}
                                onChange={(e) => updateObject({ strokeWidth: parseInt(e.target.value) })}
                                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                              />
                            </div>
                          )}


                          {/* Size Properties */}
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                                Width: {pxToMm(selectedObj.width, mmPerPixel).toFixed(1)}mm
                              </label>
                              <input
                                type="number"
                                step="0.1"
                                className="input-field w-full text-sm"
                                value={pxToMm(selectedObj.width, mmPerPixel)}
                                onChange={(e) => updateObject({ width: Math.round(mmToPx(parseFloat(e.target.value), mmPerPixel)) })}
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                                Height: {pxToMm(selectedObj.height, mmPerPixel).toFixed(1)}mm
                              </label>
                              <input
                                type="number"
                                step="0.1"
                                className="input-field w-full text-sm"
                                value={pxToMm(selectedObj.height, mmPerPixel)}
                                onChange={(e) => updateObject({ height: Math.round(mmToPx(parseFloat(e.target.value), mmPerPixel)) })}
                              />
                            </div>
                          </div>

                          {/* Position Properties */}
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                                X Position: {pxToMm(selectedObj.x, mmPerPixel).toFixed(1)}mm
                              </label>
                              <input
                                type="number"
                                step="0.1"
                                className="input-field w-full text-sm"
                                value={pxToMm(selectedObj.x, mmPerPixel)}
                                onChange={(e) => updateObject({ x: Math.round(mmToPx(parseFloat(e.target.value), mmPerPixel)) })}
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                                Y Position: {pxToMm(selectedObj.y, mmPerPixel).toFixed(1)}mm
                              </label>
                              <input
                                type="number"
                                step="0.1"
                                className="input-field w-full text-sm"
                                value={pxToMm(selectedObj.y, mmPerPixel)}
                                onChange={(e) => updateObject({ y: Math.round(mmToPx(parseFloat(e.target.value), mmPerPixel)) })}
                              />
                            </div>
                          </div>

                          {/* Rotation */}
                          <div>
                            <label className="block text-xs font-medium text-white/70 mb-1">
                              Rotation: {selectedObj.rotation}°
                            </label>
                            <input
                              type="range"
                              min={-180}
                              max={180}
                              step={5}
                              value={selectedObj.rotation}
                              onChange={(e) => updateObject({ rotation: parseInt(e.target.value) })}
                              className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                            />
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Global Settings */}
                <div className="border-t border-white/10 pt-4">
                  <h4 className="text-sm font-medium text-white/80 mb-3">Global Settings</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-white/70 mb-1">
                        Brightness: {contentBrightness.toFixed(1)}
                      </label>
                      <input
                        type="range"
                        min={0.1}
                        max={2.0}
                        step={0.1}
                        value={contentBrightness}
                        onChange={(e) => setContentBrightness(parseFloat(e.target.value))}
                        className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-white/70 mb-1">
                        Contrast: {contentContrast.toFixed(1)}
                      </label>
                      <input
                        type="range"
                        min={0.5}
                        max={2.0}
                        step={0.1}
                        value={contentContrast}
                        onChange={(e) => setContentContrast(parseFloat(e.target.value))}
                        className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Path Pattern Controls */}
            {viewMode === 'path' && (
              <div className="space-y-6 mb-6">
                {/* Pattern Mode Toggle */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-3">Path Mode</label>
                  <div className="flex bg-black/40 rounded-xl p-1 border border-white/10">
                    <button
                      onClick={() => setPatternMode(false)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                        !patternMode
                          ? 'bg-white/20 text-white shadow-lg'
                          : 'text-white/60 hover:text-white/80'
                      }`}
                    >
                      Manual Points
                    </button>
                    <button
                      onClick={() => setPatternMode(true)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                        patternMode
                          ? 'bg-white/20 text-white shadow-lg'
                          : 'text-white/60 hover:text-white/80'
                      }`}
                    >
                      Pattern Areas
                    </button>
                  </div>
                </div>

                {/* Pattern Type Selection */}
                {patternMode && (
                  <div>
                    <label className="block text-sm font-medium text-white/80 mb-3">Pattern Type</label>
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: 'zigzag', label: 'Zigzag', icon: '⚡' },
                        { id: 'parallel', label: 'Parallel', icon: '||' },
                        { id: 'wave', label: 'Wave', icon: '~' }
                      ].map(pattern => (
                        <button
                          key={pattern.id}
                          onClick={() => setSelectedPatternType(pattern.id)}
                          className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                            selectedPatternType === pattern.id
                              ? 'bg-white/20 text-white border border-white/30'
                              : 'bg-black/40 text-white/60 border border-white/10 hover:bg-black/60 hover:text-white/80'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span>{pattern.icon}</span>
                            <span>{pattern.label}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pattern Parameters */}
                {patternMode && (
                  <div className="border-t border-white/10 pt-4">
                      <h4 className="text-sm font-medium text-white/80 mb-3">Pattern Parameters</h4>
                      <div className="space-y-4">
                        {/* Instructions */}
                        <div className="text-xs text-white/60 bg-black/20 p-3 rounded-lg">
                          <p>1. キャンバスをクリックして始点を設定</p>
                          <p>2. 再度クリックして終点を設定</p>
                          <p>3. パラメータを調整してパターンを生成</p>
                          <p>4. 黄色の点が制御点、白い線がチューブ</p>
                          {selectedPatternType === 'zigzag' && <p>5. Zigzag: 上下に折り返すパターン</p>}
                          {selectedPatternType === 'parallel' && <p>5. Parallel: 始点と終点の間を折り返し数で分割し、上下に交互に点を打つ</p>}
                          {selectedPatternType === 'wave' && <p>5. Wave: 波状パターン</p>}
                        </div>

                        {/* Fold Counts (for zigzag pattern) */}
                        {selectedPatternType === 'zigzag' && (
                          <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-white/70 mb-1">
                                 Top Folds: {patternParams.topFolds}
                                </label>
                              <input
                                type="range"
                                min={1}
                                max={20}
                                step={1}
                                value={patternParams.topFolds}
                                onChange={(e) => setPatternParams(prev => ({ ...prev, topFolds: parseInt(e.target.value) }))}
                                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                              />
                            </div>
                              <div>
                                <label className="block text-xs font-medium text-white/70 mb-1">
                                 Bottom Folds: {patternParams.bottomFolds}
                                </label>
                              <input
                                type="range"
                                min={1}
                                max={20}
                                step={1}
                                value={patternParams.bottomFolds}
                                onChange={(e) => setPatternParams(prev => ({ ...prev, bottomFolds: parseInt(e.target.value) }))}
                                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                              />
                            </div>
                          </div>
                        )}

                        {/* Fold Count (for parallel pattern) */}
                        {selectedPatternType === 'parallel' && (
                          <div>
                            <label className="block text-xs font-medium text-white/70 mb-1">
                             Folds: {patternParams.topFolds}
                            </label>
                            <input
                              type="range"
                              min={1}
                              max={20}
                              step={1}
                              value={patternParams.topFolds}
                              onChange={(e) => setPatternParams(prev => ({ ...prev, topFolds: parseInt(e.target.value) }))}
                              className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                            />
                          </div>
                        )}

                        {/* Tube Spacing (Physical) */}
                        <div>
                          <label className="block text-xs font-medium text-white/70 mb-1">
                           Tube Spacing: {physicalPatternParams.tubeSpacingMm.toFixed(1)}mm
                          </label>
                          <input
                            type="range"
                            min={0.5}
                            max={10}
                            step={0.1}
                            value={physicalPatternParams.tubeSpacingMm}
                            onChange={(e) => setPhysicalPatternParams(prev => ({ ...prev, tubeSpacingMm: parseFloat(e.target.value) }))}
                            className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                          />
                        </div>

                        {/* Wave Pattern Parameters (Physical) */}
                        {selectedPatternType === 'wave' && (
                          <>
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                               Amplitude: {physicalPatternParams.amplitudeMm.toFixed(1)}mm
                              </label>
                              <input
                                type="range"
                                min={0.5}
                                max={20}
                                step={0.1}
                                value={physicalPatternParams.amplitudeMm}
                                onChange={(e) => setPhysicalPatternParams(prev => ({ ...prev, amplitudeMm: parseFloat(e.target.value) }))}
                                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-white/70 mb-1">
                               Frequency: {physicalPatternParams.frequencyPerMm.toFixed(3)}/mm
                              </label>
                              <input
                                type="range"
                                min={0.01}
                                max={1.0}
                                step={0.01}
                                value={physicalPatternParams.frequencyPerMm}
                                onChange={(e) => setPhysicalPatternParams(prev => ({ ...prev, frequencyPerMm: parseFloat(e.target.value) }))}
                                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer slider"
                              />
                            </div>
                          </>
                        )}
                    </div>
                  </div>
                )}
              </div>
            )}

          </section>

          </div>

          {/* Right Side - Canvas */}
          <div className="flex-1 space-y-6">
            <section className="canvas-container">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-white/60 rounded-full" />
                <h3 className="text-lg font-semibold text-white/90">
                  {viewMode === 'content' ? 'Content Editor' : viewMode === 'path' ? 'Path Editor' : 'Display View'}
                </h3>
              </div>

              {/* Mode Switcher */}
              <div className="flex items-center gap-2">
                <span className="text-white/60 text-sm font-medium">Mode:</span>
                <div className="flex bg-black/40 rounded-xl p-1 border border-white/10">
                  <button
                    onClick={() => setViewMode('content')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                      viewMode === 'content'
                        ? 'bg-white/20 text-white shadow-lg'
                        : 'text-white/60 hover:text-white/80'
                    }`}
                  >
                    Content
                  </button>
                  <button
                    onClick={() => setViewMode('path')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                      viewMode === 'path'
                        ? 'bg-white/20 text-white shadow-lg'
                        : 'text-white/60 hover:text-white/80'
                    }`}
                  >
                    Path
                  </button>
                  <button
                    onClick={() => setViewMode('display')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                      viewMode === 'display'
                        ? 'bg-white/20 text-white shadow-lg'
                        : 'text-white/60 hover:text-white/80'
                    }`}
                  >
                    Display
                  </button>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="metric-display">
                Points: {points.length}
              </div>
              <div className="metric-display">
                Canvas: {physicalUnits.canvasWidthMm.toFixed(0)}×{physicalUnits.canvasHeightMm.toFixed(0)}mm
              </div>
              <div className="metric-display">
                Tube: Ø{physicalUnits.tubeDiameterMm.toFixed(1)}mm
              </div>
            </div>
          </div>
          <div className="text-sm text-white/60 mb-4">
            {viewMode === 'content' && 'Select tools to add objects • Click to select/drag • Double-click text to edit • Right-click to delete'}
            {viewMode === 'path' && (
              patternMode
                ? 'Click to create pattern area • Drag to move • Right-click to delete'
                : 'Click to add points • Drag to move • Right-click to delete'
            )}
            {viewMode === 'display' && 'View the final droplet rendering result'}
          </div>
           <canvas
             ref={mainCanvasRef}
             width={canvasW}
             height={canvasH}
             onPointerDown={viewMode === 'path' || viewMode === 'content' ? onPointerDown : undefined}
             onPointerMove={viewMode === 'path' || viewMode === 'content' ? onPointerMove : undefined}
             onPointerUp={viewMode === 'path' || viewMode === 'content' ? onPointerUp : undefined}
             onPointerLeave={viewMode === 'path' || viewMode === 'content' ? onPointerLeave : undefined}
             onContextMenu={viewMode === 'path' || viewMode === 'content' ? onContextMenu : undefined}
             onDoubleClick={viewMode === 'content' ? onDoubleClick : undefined}
             className={`w-full rounded-xl bg-black/40 border border-white/10 select-none shadow-2xl ${
               viewMode === 'path' ? 'cursor-crosshair' :
               viewMode === 'content' ? (toolMode === 'select' ? 'cursor-default' : 'cursor-crosshair') :
               'cursor-default'
             }`}
             style={{
               touchAction: 'none',
               cursor: resizeHandle ?
                 (resizeHandle.includes('nw') || resizeHandle.includes('se') ? 'nw-resize' :
                  resizeHandle.includes('ne') || resizeHandle.includes('sw') ? 'ne-resize' :
                  resizeHandle.includes('n') || resizeHandle.includes('s') ? 'ns-resize' :
                  'ew-resize') : undefined
             }}
           />

            </section>
          </div>
        </div>

        {/* Tube Visualization - Below main layout */}
        <section className="canvas-container mt-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 bg-white/60 rounded-full" />
              <h3 className="text-lg font-semibold text-white/90">Tube Visualization</h3>
            </div>
            <div className="flex items-center gap-4">
              <div className="metric-display">
                Straightened View
              </div>
              <div className="flex items-center gap-2">
                <span className="text-white/60 text-sm">Scale:</span>
                <input
                  type="range"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={tubeVisualizationScale}
                  onChange={(e) => setTubeVisualizationScale(parseFloat(e.target.value))}
                  className="w-20 h-2 bg-white/20 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-white/80 text-sm w-8">{tubeVisualizationScale.toFixed(1)}x</span>
              </div>
            </div>
          </div>
          <p className="text-sm text-white/60 mb-4">
            Straightened tube showing droplet flow from start to end (scroll horizontally to see full length)
          </p>
          <div className="relative overflow-x-auto border border-white/10 rounded-lg">
            <div className="inline-block">
              <canvas
                ref={tubeVisualizationRef}
                className="h-32 bg-black"
                style={{ touchAction: 'none', minWidth: '100%' }}
              />
            </div>
          </div>
        </section>

        {/* Offscreen */}
        <canvas ref={offscreenRef} style={{ display: "none" }} />

      </div>
    </div>
  );
}
