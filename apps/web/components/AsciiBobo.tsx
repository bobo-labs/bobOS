"use client";
import React, { useEffect, useRef } from "react";

const ASCII_ART = `                     @@@@@@@@@@@@                                                                                        
                  @@@%%%%%%%%%%%%@@                                                       @@@@@@@@@@@                    
                 @@%%%%%%%%#####%%%@@                                                  @@@%%%%%%%%%%%@@                  
                 @@%%%%%%##########%%@                                                @@%%%%#######%%%%@@                
                  @%%%%%###########%%%@@@@@@@                                     @@@@@%%%%##########%%%@                
                  @@%%%%########%%@@%%%%%%%%%%%%%%%@@@@@               @@@@%%%%%%%%%%%%%@@%%#########%%%@                
                   @@@%%%###%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%@@        @@@%%%%%%%%%%%%%%%%%%%%%@%%######%%@@                
                     @@%%%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@  @@@%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%##%%%@                 
                       @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%@@                  
                      @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@                    
                     @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@                    
                   @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@                  
                   @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@@@            
                  @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@          
                 @@%%%%%%%%%%%%%%%%%%@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@        
               @@@%%%%%%%%%%%@%%%%%%%%%%%%%%%@@@%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@       
            @@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@%@@     
          @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@    
         @@%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@    
         @%%%%%%%%%%%%%%%%%%@@%##%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@    
        @@%%%%%%%%%%%%%%%%%%%%%%%%##***#%%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%##%@   
        @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%#*#@@@@@@@@@@%%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%**+++#@   
       @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@@%*%@@@##@@@@#**#%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%#*+++++++#%@   
      @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@@@@@@@@@*++++++++****#%%@%%%%%%%%%%%%%%%%%%%@@@@%%@@*++++++*#%%%%%@@   
      @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%#********%@%%###***#@@@@@@@@@@@@@@@@@#*#%%%%%%%%%%@@    
     @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%#*#@@@@@@@@#*+@@@@@%%%%%%%%%%%%%%%@    
     @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@    
    @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%%%%%%%%@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@     
    @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%@@@@@@@@@@@@%%@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@       
    @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%%%@@@@@@@@@@@@%%%%%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@        
    @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%%%%%@@@@@@@@@@%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%@        
    @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%%%%%%%%@@@@@%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%%%%@@        
    @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%%%@@%%%%%%%%%%%%%%@@%%%%%%%%%%%%%%%%%%%%%%%%@          
    @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%%%%%%%%%%%@@@@%%%%%%%%%%%%%%%@%%%%%%%%%%%%%%%%%%%%%%%@@          
    @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%@@%%%%@@@@%@@%%%%%%%%@@@%%%@%%%%%%%%%%%%%%%%%%%%%%%@           
    @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%@@@@@@@@%%%%@@@@%%%%%@@@%%@@%%%%%%%%%%%%%%%%%%%%%%@@           
     @%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@%%%%%%%%%%%%%%%@@@@@@@@@%%@@%%%%%%%%%%%%%%%%%%%%%%%@@           
     @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@@%%%%%%%%%%%%%%%%%%%@@@%%%%%%%%%%%%%%%%%%%%%%%%%@@           
      @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@@@@@@@@@@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@            
       @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@            
         @@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@             
         @%#%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@              
      @%######@%%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@                
    @%##########@%%%%%%@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@                  
   @%##############%@%%%%%%%%%%%%@@@@@@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@#####%@@               
 @@####################%@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@@@@@@@@@@@%%@@@@@@@@@%%%%%%%%%##########%@             
@%###########################%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@%###############%@@          
#####################################%%@@%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%@@@%%%%##########################@@        
#####################################################%%%%%%%%@@%%%%##############################################@       
##################################################################################################################%@     
####################################################################################################################@    
#####################################################################################################################@   
######################################################################################################################@@ 
#######################################################################################################################@@`;

interface Cell {
  r: number;
  c: number;
  original: string;
  val: string;
  isSpace: boolean;
  // FX1: unified time-based fly-in + scramble
  fx1StartTime: number;   // absolute ms when this cell begins
  fx1Duration: number;    // ms for the full slide to complete
  fx1ScrambleIter: number;
  fx1Done: boolean;
  // FX2: hover glitch
  fx2Active: boolean;
  fx2Iter: number;
  // spatial
  initialX: number;       // starting offset (off-screen left, px)
  currentX: number;       // live interpolated x offset
}

export default function AsciiBobo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const lettersAndSymbols = [
      "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
      "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
      "!", "@", "#", "$", "&", "*", "(", ")", "-", "_", "+", "=", "/",
      "[", "]", "{", "}", ";", ":", "<", ">", ",", "0", "1", "2", "3",
      "4", "5", "6", "7", "8", "9"
    ];

    const getRandomChar = () => lettersAndSymbols[Math.floor(Math.random() * lettersAndSymbols.length)];

    const lines = ASCII_ART.split("\n");
    const grid: Cell[][] = [];

    // Size state — mutated by updateSize()
    let charWidth = 6;
    let charHeight = 10;
    let logicalWidth = 0;
    let logicalHeight = 0;
    let artXOffset = 0; // px from canvas left where the art begins (right-aligned)

    const updateSize = () => {
      const ww = window.innerWidth;
      // Match clamp(5px, 0.6vw, 10px)
      let fontSizePx = (ww * 0.6) / 100;
      if (fontSizePx < 5) fontSizePx = 5;
      if (fontSizePx > 10) fontSizePx = 10;

      ctx.font = `${fontSizePx}px monospace`;
      const metrics = ctx.measureText("M");
      charWidth = metrics.width || (fontSizePx * 0.6);
      charHeight = fontSizePx * 1.2;

      const maxCols = Math.max(...lines.map(l => l.length));
      const artWidth = maxCols * charWidth;

      // Canvas spans the FULL viewport width so fly-in chars are visible in transit.
      // Art is right-aligned within that space via artXOffset.
      logicalWidth = ww;
      logicalHeight = lines.length * charHeight;
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

    // ─── Event listeners (safe to attach immediately) ────────────────────────
    let resizeTimer: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { updateSize(); }, 100);
    };
    window.addEventListener('resize', handleResize);

    const SCRAMBLE_EARLY = ["*", "-", "'", '"', "_", "/", "\\"];

    const handleMouseMove = (e: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      // Subtract artXOffset so column index maps into the art grid, not the full canvas
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
    canvas.addEventListener('mousemove', handleMouseMove);

    let frameId: number;
    let currentFrame = 0;

    const COLOR_SETTLED = "#261c1a";
    const COLOR_TRANSIT = "#be0129";
    // Pre-split into channels so we can lerp without string-parsing every frame
    const TR = 0xbe, TG = 0x01, TB = 0x29; // transit RGB
    const SR = 0x26, SG = 0x1c, SB = 0x1a; // settled RGB
    const FADE_START = 0.65;               // tail cross-fade begins at 65% progress

    const renderLoop = (time: number) => {
      currentFrame++;
      ctx.clearRect(0, 0, logicalWidth, logicalHeight);

      // Track fillStyle to avoid redundant string assignments (perf)
      let _fs = "";

      for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (cell.isSpace) continue;

          // ── FX1: time-based fly-in + scramble ─────────────────────────────
          if (!cell.fx1Done) {
            const elapsed = time - cell.fx1StartTime;
            if (elapsed <= 0) continue; // not started — invisible

            const progress = Math.min(elapsed / cell.fx1Duration, 1);
            const easeOut = 1 - Math.pow(1 - progress, 4); // quartic ease-out
            cell.currentX = cell.initialX * (1 - easeOut);

            // Scramble: simple symbols early, full chaos later
            if (currentFrame % 2 === 0) {
              cell.val = (cell.fx1ScrambleIter < 8)
                ? SCRAMBLE_EARLY[Math.floor(Math.random() * SCRAMBLE_EARLY.length)]
                : getRandomChar();
              cell.fx1ScrambleIter++;
            }

            if (progress >= 1) {
              cell.currentX = 0;
              cell.val = cell.original;
              cell.fx1Done = true;
              // Land: snap to settled color + full opacity
              ctx.globalAlpha = 1;
              if (_fs !== COLOR_SETTLED) { ctx.fillStyle = COLOR_SETTLED; _fs = COLOR_SETTLED; }
            } else {
              // Always fully opaque in transit — bold and clearly visible
              ctx.globalAlpha = 1;

              if (progress >= FADE_START) {
                // ── Tail cross-fade: red bleeds into settled dark ─────────────
                // t runs 0→1 over the last (1-FADE_START) fraction of travel
                const t = (progress - FADE_START) / (1 - FADE_START);
                const r = (TR + (SR - TR) * t + 0.5) | 0;
                const g = (TG + (SG - TG) * t + 0.5) | 0;
                const b = (TB + (SB - TB) * t + 0.5) | 0;
                // Computed per-char — bypass cache
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                _fs = "";
              } else {
                // Pure transit color for the majority of the journey
                if (_fs !== COLOR_TRANSIT) { ctx.fillStyle = COLOR_TRANSIT; _fs = COLOR_TRANSIT; }
              }
            }
          } else {
            // Settled char — always full opacity, dark color
            ctx.globalAlpha = 1;
            if (_fs !== COLOR_SETTLED) { ctx.fillStyle = COLOR_SETTLED; _fs = COLOR_SETTLED; }
          }

          // ── FX2: hover glitch (settled chars only) ────────────────────────
          if (cell.fx2Active) {
            if (cell.fx2Iter >= 14) {
              cell.val = cell.original;
              cell.fx2Active = false;
            } else if (currentFrame % 4 === 0) {
              cell.val = getRandomChar();
              cell.fx2Iter++;
            }
          }

          // ── Draw ──────────────────────────────────────────────────────────
          if (cell.val) {
            ctx.fillText(cell.val, artXOffset + cell.c * charWidth + cell.currentX, cell.r * charHeight);
          }
        }
      }

      // Restore context state for next frame
      ctx.globalAlpha = 1;
      if (_fs !== COLOR_SETTLED) ctx.fillStyle = COLOR_SETTLED;

      frameId = requestAnimationFrame(renderLoop);
    };

    // ─── Defer grid build to next frame so getBoundingClientRect is valid ───
    // (canvas must be committed to layout before we can read its screen position)
    frameId = requestAnimationFrame(() => {
      // Canvas is full viewport width (canvas.left = 0), so no canvasLeft offset needed.
      // artXOffset accounts for the right-alignment of the art within the canvas.
      // initialX brings each char to canvas x=0, which equals viewport left edge.
      //   final draw x = artXOffset + c*charWidth + 0
      //   start draw x = artXOffset + c*charWidth + initialX = 0
      //   → initialX   = -(artXOffset + c*charWidth)
      const now = performance.now();
      const maxCols = Math.max(...lines.map(l => l.length));
      const WAVE_SPAN_MS = 3500; // slow deliberate cascade so you can track the wave
      const FLY_DURATION_MS = 3500; // each character travels for this long

      for (let r = 0; r < lines.length; r++) {
        const line = lines[r];
        const row: Cell[] = [];
        for (let c = 0; c < line.length; c++) {
          const ch = line[c];
          const isSpace = ch === " " || ch === "\u00A0";

          // Diagonal stagger: 85% column, 15% row  →  left-to-right cascade
          const staggerT = ((c / maxCols) * 0.85 + (r / lines.length) * 0.15) * WAVE_SPAN_MS;
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

      // Start the render loop only after the grid is fully populated
      frameId = requestAnimationFrame(renderLoop);
    });

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
      canvas.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  return (
    // Canvas is absolute bottom-left, spans full viewport width.
    // Characters animate from the left edge, art sits flush on the right.
    <div
      className="hidden sm:block absolute left-0 right-0 pointer-events-auto opacity-90 z-0 overflow-hidden"
      style={{ bottom: '-40px' }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', pointerEvents: 'auto' }}
      />
    </div>
  );
}
