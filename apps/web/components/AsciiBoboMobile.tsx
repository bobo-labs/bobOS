"use client";
import React, { useEffect, useRef } from "react";

// Smaller 19-line art optimised for mobile viewport widths
const ASCII_ART_MOBILE = `      ADGGGFB                   ACDDA       
      CGHNNNMFAA               BGMNNJF      
       CGIGHHIIIIIIHHGA CGHIIIIIHHFLKF      
        GIIIIIIIIIIIIIHGHIIIIIIIIIIGC       
      AGIIIIIIIIIIIIIIIIGHIIIIIIIIIIHHHD    
     BFIIHGGHHHGHGFGHIIIIGHIIIIIIIIIIHHHGC  
   CHIIIIGGHHIIIIIIIIHHGGHGFFGHHGFGGHIIIIFA 
  AGIIIIIIIHHNPDCDDHFHHIIIHHIIIIIIIIIIHHPVK 
  EHIIIIIIIIIIIIHFEEEMORVVOGKOMDDCBBCQPOGGB 
 AGIIIIIIIIIIIIIIIIIIHFEEFGFGIIIIIIIIIIIHF  
 AHIIIIIIIIIIIIIIIIHEFFDAAAEFFGIIIIIIIIHEA  
 AHIIIIIIIIIIIIIIIIEFFFFEEFFFFEGIIIIIIIGA   
 AGIIIIIIIIIIIIIIIIFEEEEFEEEEDEHIIIIIIIF    
  EHIIIIIIIIIIIIIIIIHGEFFEEFEGHIIIIIIIIE    
   CFHHIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIHD     
 CFGGGFHGFEFHHHHHHHHHHHHHIHHHHHHHHHGEC      
EGGGGGGGGGFEFGHHHHHHHHIIHHHHHHHFEFGGGGGEB   
GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGE  
GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGFC`;

interface Cell {
  r: number;
  c: number;
  original: string;
  val: string;
  isSpace: boolean;
  fx1StartTime: number;
  fx1Duration: number;
  fx1ScrambleIter: number;
  fx1Done: boolean;
  fx2Active: boolean;
  fx2Iter: number;
  initialX: number;
  currentX: number;
}

export default function AsciiBoboMobile() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const lettersAndSymbols = [
      "A","B","C","D","E","F","G","H","I","J","K","L","M",
      "N","O","P","Q","R","S","T","U","V","W","X","Y","Z",
      "!","@","#","$","&","*","(",")","_","+","=","/",
      "[","]","{","}",";",":",",","0","1","2","3",
      "4","5","6","7","8","9",
    ];

    const getRandomChar = () =>
      lettersAndSymbols[Math.floor(Math.random() * lettersAndSymbols.length)];

    const lines = ASCII_ART_MOBILE.split("\n");
    const grid: Cell[][] = [];

    let charWidth = 6;
    let charHeight = 10;
    let logicalWidth = 0;
    let logicalHeight = 0;
    let artXOffset = 0;

    const updateSize = () => {
      const ww = window.innerWidth;
      // Downsized font on mobile to fit better
      let fontSizePx = (ww * 0.55) / 100;
      if (fontSizePx < 4) fontSizePx = 4;
      if (fontSizePx > 7) fontSizePx = 7;

      ctx.font = `${fontSizePx}px monospace`;
      const metrics = ctx.measureText("M");
      charWidth = metrics.width || fontSizePx * 0.6;
      charHeight = fontSizePx * 1.2;

      const maxCols = Math.max(...lines.map((l) => l.length));
      const artWidth = maxCols * charWidth;

      logicalWidth = ww;
      logicalHeight = lines.length * charHeight;
      // Right-align art within the full-width canvas
      artXOffset = logicalWidth - artWidth;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = logicalWidth * dpr;
      canvas.height = logicalHeight * dpr;
      canvas.style.width = `${logicalWidth}px`;
      canvas.style.height = `${logicalHeight}px`;

      ctx.scale(dpr, dpr);
      ctx.font = `${fontSizePx}px monospace`;
      ctx.textBaseline = "top";
      ctx.fillStyle = "#261c1a";
    };

    updateSize();

    let resizeTimer: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { updateSize(); }, 100);
    };
    window.addEventListener("resize", handleResize);

    const SCRAMBLE_EARLY = ["*", "-", "'", '"', "_", "/", "\\"];

    // Hover glitch — identical behaviour to desktop version
    const handleMouseMove = (e: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const c = Math.floor((e.clientX - bounds.left - artXOffset) / charWidth);
      const r = Math.floor((e.clientY - bounds.top) / charHeight);
      if (r >= 0 && r < grid.length && c >= 0 && c < grid[r].length) {
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -4; dc <= 4; dc++) {
            if (Math.abs(dr) + Math.abs(dc / 2) <= 2.5) {
              const nr = r + dr;
              const nc = c + dc;
              if (nr >= 0 && nr < grid.length && nc >= 0 && nc < grid[nr].length) {
                const ncell = grid[nr][nc];
                if (ncell && !ncell.isSpace && ncell.fx1Done && !ncell.fx2Active) {
                  if (Math.random() > 0.1) { ncell.fx2Active = true; ncell.fx2Iter = 0; }
                }
              }
            }
          }
        }
      }
    };
    canvas.addEventListener("mousemove", handleMouseMove);

    let frameId: number;
    let currentFrame = 0;

    const COLOR_SETTLED = "#261c1a";
    const COLOR_TRANSIT = "#be0129";
    const TR = 0xbe, TG = 0x01, TB = 0x29;
    const SR = 0x26, SG = 0x1c, SB = 0x1a;
    const FADE_START = 0.65;

    const renderLoop = (time: number) => {
      currentFrame++;
      ctx.clearRect(0, 0, logicalWidth, logicalHeight);

      let _fs = "";

      for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (cell.isSpace) continue;

          if (!cell.fx1Done) {
            const elapsed = time - cell.fx1StartTime;
            if (elapsed <= 0) continue;

            const progress = Math.min(elapsed / cell.fx1Duration, 1);
            const easeOut = 1 - Math.pow(1 - progress, 4);
            cell.currentX = cell.initialX * (1 - easeOut);

            if (currentFrame % 2 === 0) {
              cell.val =
                cell.fx1ScrambleIter < 8
                  ? SCRAMBLE_EARLY[Math.floor(Math.random() * SCRAMBLE_EARLY.length)]
                  : getRandomChar();
              cell.fx1ScrambleIter++;
            }

            if (progress >= 1) {
              cell.currentX = 0;
              cell.val = cell.original;
              cell.fx1Done = true;
              ctx.globalAlpha = 1;
              if (_fs !== COLOR_SETTLED) { ctx.fillStyle = COLOR_SETTLED; _fs = COLOR_SETTLED; }
            } else {
              ctx.globalAlpha = 1;
              if (progress >= FADE_START) {
                const t = (progress - FADE_START) / (1 - FADE_START);
                const rr = (TR + (SR - TR) * t + 0.5) | 0;
                const gg = (TG + (SG - TG) * t + 0.5) | 0;
                const bb = (TB + (SB - TB) * t + 0.5) | 0;
                ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
                _fs = "";
              } else {
                if (_fs !== COLOR_TRANSIT) { ctx.fillStyle = COLOR_TRANSIT; _fs = COLOR_TRANSIT; }
              }
            }
          } else {
            ctx.globalAlpha = 1;
            if (_fs !== COLOR_SETTLED) { ctx.fillStyle = COLOR_SETTLED; _fs = COLOR_SETTLED; }
          }

          if (cell.fx2Active) {
            if (cell.fx2Iter >= 14) {
              cell.val = cell.original;
              cell.fx2Active = false;
            } else if (currentFrame % 4 === 0) {
              cell.val = getRandomChar();
              cell.fx2Iter++;
            }
          }

          if (cell.val) {
            ctx.fillText(
              cell.val,
              artXOffset + cell.c * charWidth + cell.currentX,
              cell.r * charHeight
            );
          }
        }
      }

      ctx.globalAlpha = 1;
      if (_fs !== COLOR_SETTLED) ctx.fillStyle = COLOR_SETTLED;

      frameId = requestAnimationFrame(renderLoop);
    };

    frameId = requestAnimationFrame(() => {
      const now = performance.now();
      const maxCols = Math.max(...lines.map((l) => l.length));
      const WAVE_SPAN_MS = 3500;
      const FLY_DURATION_MS = 3500;

      for (let r = 0; r < lines.length; r++) {
        const line = lines[r];
        const row: Cell[] = [];
        for (let c = 0; c < line.length; c++) {
          const ch = line[c];
          const isSpace = ch === " " || ch === "\u00A0";

          const staggerT =
            ((c / maxCols) * 0.85 + (r / lines.length) * 0.15) * WAVE_SPAN_MS;
          const fx1StartTime = now + staggerT;
          const initialX = -(artXOffset + c * charWidth);

          row.push({
            r, c,
            original: ch,
            val: isSpace ? "" : ch,
            isSpace,
            fx1StartTime,
            fx1Duration: FLY_DURATION_MS,
            fx1ScrambleIter: 0,
            fx1Done: isSpace,
            fx2Active: false,
            fx2Iter: 0,
            initialX,
            currentX: isSpace ? 0 : initialX,
          });
        }
        grid.push(row);
      }

      frameId = requestAnimationFrame(renderLoop);
    });

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  return (
    // Top-right corner, mobile-only (hidden on sm and above)
    <div
      className="sm:hidden absolute left-0 right-0 pointer-events-auto opacity-90 z-0 overflow-hidden"
      style={{ top: "0px" }}
    >
      <canvas ref={canvasRef} style={{ display: "block", pointerEvents: "auto" }} />
    </div>
  );
}
